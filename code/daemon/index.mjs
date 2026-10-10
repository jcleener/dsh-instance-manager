import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSystemAdapter, discoverTargets } from './runtime.mjs';
import { readPlan, consumePlan, removeClaimed } from './plan.mjs';
import { isWindows, ipcPath, ipcHasFileEntity, ipcAfterListen, ipcBeforeClose,
  assertOwnedDirectory, assertOwnedFile, hardenPath, sameOwner } from '../platform.mjs';

export function defaultPaths(home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const dataDir = path.join(home, 'instance-manager');
  return { dataDir, socketPath: ipcPath(home),
    statusPath: path.join(dataDir, 'status.json'), logPath: path.join(dataDir, 'daemon.log'), planPath: path.join(dataDir, 'restart-plan.json') };
}

const PROTOCOL_VERSION = 2;
const iso = ms => new Date(ms).toISOString();
const codeError = (code, message) => Object.assign(new Error(message), { code });
const immutableResponse = (ok, status, error) => ok ? { ok, status } :
  { ok, error: { code: error.code || 'INTERNAL', message: error.message } };

async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  try { assertOwnedDirectory(stat, 'Daemon data directory is not owned by this user'); }
  catch { throw codeError('UNSAFE_DIRECTORY', 'Daemon data directory is not owned by this user'); }
  await hardenPath(dir, 0o700);
}

async function privateFile(file, text) {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

async function ensureSocketVacant(file) {
  if (!ipcHasFileEntity) {
    // 命名管道没有文件实体：lstat 会"成功"但 isSocket()=false / uid=0 / mode=0o666，
    // 用 stat 判断必然误判。唯一可靠的判据是"能否连上"。
    try { const active = await connectSocket(file, 500); active.destroy(); }
    catch { return; }   // ENOENT/ECONNREFUSED 都表示空闲（真占用时 listen 会报 EADDRINUSE）
    throw codeError('ALREADY_RUNNING', 'Daemon socket is already active');
  }
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isSocket() || !sameOwner(stat)) {
    throw codeError('UNSAFE_SOCKET', 'Existing socket path is not an owned socket');
  }
  try {
    const active = await connectSocket(file, 500);
    active.destroy();
  } catch (error) {
    if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') throw error;
    await fs.unlink(file);
    return;
  }
  throw codeError('ALREADY_RUNNING', 'Daemon socket is already active');
}

function connectSocket(file, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.setTimeout(timeout, () => socket.destroy(codeError('TIMEOUT', 'Daemon request timed out')));
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function readRequest(socket, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let input = '';
    socket.setTimeout(timeout, () => socket.destroy(codeError('TIMEOUT', 'Daemon request timed out')));
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 4096) return socket.destroy(codeError('TOO_LARGE', 'Request too large'));
      if (input.includes('\n')) {
        socket.removeAllListeners('data');
        resolve(input);
      }
    });
    socket.once('error', reject);
    socket.once('end', () => reject(codeError('INCOMPLETE', 'Incomplete request')));
  });
}

export async function requestStatus({ home, timeout = 5000 } = {}) {
  return request('status', { home, timeout });
}
export async function requestRestart({ home, timeout = 5000, requestId } = {}) {
  return request('restart', { home, timeout, ...(requestId ? { requestId } : {}) });
}
export async function acknowledgeRecovery({ home, timeout = 5000, requestId } = {}) {
  return request('ackRecovery', { home, timeout, requestId });
}
async function request(op, { home, timeout, requestId }) {
  const socket = await connectSocket(defaultPaths(home).socketPath, timeout);
  try {
    const reply = readRequest(socket, timeout);
    socket.write(`${JSON.stringify({ op, ...(requestId ? { requestId } : {}) })}\n`);
    const response = JSON.parse((await reply).split('\n')[0]);
    if (!response.ok) throw codeError(response.error?.code || 'DAEMON_ERROR',
      response.error?.message || 'Daemon rejected request');
    return response.status;
  } finally { socket.destroy(); }
}

// Tests supply adapter methods now/sleep/listProcesses/signal/launch/health.
// The production adapter is the only place that calls ps, kill, open or HTTP.
// `platform` 可注入：生产用真实平台，macOS 形状的回归 fixture 显式声明 'darwin'。
export function createDaemon({ home, adapter, platform = process.platform,
  delayMs = 5000, appGraceMs = 5000, hostGraceMs = 3000,
  pollMs = 250, startupTimeoutMs = 30000 } = {}) {
  const paths = defaultPaths(home);
  adapter ??= createSystemAdapter({ home: path.dirname(paths.dataDir) });
  let server;
  let busy = false;
  let closed = false;
  let attempt = 0;
  let status = { protocolVersion: PROTOCOL_VERSION, phase: 'idle', updatedAt: iso(adapter.now()), attempt };
  let pending = Promise.resolve();
  let activePlan = null;
  let recoveryReport = null;

  async function persist(next) {
    status = { protocolVersion: PROTOCOL_VERSION, ...next, updatedAt: iso(adapter.now()) };
    await privateFile(paths.statusPath, `${JSON.stringify(status, null, 2)}\n`);
  }
  async function log(event, details = {}) {
    const line = `${JSON.stringify({ at: iso(adapter.now()), event, ...details, requestId: details.requestId || activePlan?.plan?.requestId || status.details?.requestId || (busy ? `manual-${attempt}` : null) })}\n`;
    // Reject hostile pre-existing links and maintain 0600 on existing logs.
    try {
      const stat = await fs.lstat(paths.logPath);
      try { assertOwnedFile(stat, { message: 'Log is not an owned regular file' }); }
      catch { throw codeError('UNSAFE_LOG', 'Log is not an owned regular file'); }
      if (stat.size > 1024 * 1024) await fs.rename(paths.logPath, `${paths.logPath}.1`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await fs.open(paths.logPath, 'a', 0o600);
    try { if (!isWindows) await handle.chmod(0o600); await handle.writeFile(line); }
    finally { await handle.close(); }
  }
  const scan = async (previousHosts = []) => {
    const rows = await adapter.listProcesses();
    // 必须显式传平台：discoverTargets 的缺省是 darwin（为兼容既有 macOS 断言），
    // 漏传会让 Windows 上永远认出 0 个 App/Host → preflight 直接拒绝重启。
    const found = discoverTargets(rows, { home: path.dirname(paths.dataDir), platform });
    // A verified host may become orphaned after the app exits: retain its exact
    // original PID+argv fingerprint, but never trust an arbitrary matching name.
    for (const old of previousHosts) {
      const current = rows.find(row => row.pid === old.pid && row.command === old.command);
      if (current && !found.host.some(row => row.pid === current.pid)) found.host.push(current);
    }
    return found;
  };
  const timeExceeded = deadline => adapter.now() >= deadline;
  async function waitUntil(predicate, deadline) {
    while (!timeExceeded(deadline)) {
      if (await predicate()) return true;
      await adapter.sleep(Math.min(pollMs, Math.max(1, deadline - adapter.now())));
    }
    return predicate();
  }
  async function signalKnown(original, type, signal, previousHosts = []) {
    const current = await scan(previousHosts);
    if (type === 'host' && current.app.length)
      throw codeError('OLD_INSTANCE_REMAINS', 'App still running; host left untouched');
    for (const row of current[type]) {
      // PID alone is not identity: reject changed argv and unrelated PID reuse.
      if (!original.some(old => old.pid === row.pid && old.command === row.command)) continue;
      await log('process-signal', { pid: row.pid, type, signal });
      try { await adapter.signal(row.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
    }
  }
  async function runRestart() {
    const old = await scan();
    if (old.app.length > 1 || old.host.length > 1)
      throw codeError('AMBIGUOUS_INSTANCE', 'Multiple DSH app or desktop host processes; refusing restart');
    const scanOld = () => scan(old.host);
    const appIds = new Set(old.app.map(p => p.pid));
    const hostIds = new Set(old.host.map(p => p.pid));
    await persist({ phase: 'stopping', attempt, details: { appCount: appIds.size, hostCount: hostIds.size } });
    await log('stopping', { appPids: [...appIds], hostPids: [...hostIds] });
    await log('app-stop-requested', { appPids: [...appIds] });
    await signalKnown(old.app, 'app', 'SIGTERM');
    const appGone = () => scanOld().then(found => found.app.length === 0);
    if (!await waitUntil(appGone, adapter.now() + appGraceMs)) {
      await signalKnown(old.app, 'app', 'SIGKILL');
      if (!await waitUntil(appGone, adapter.now() + 3000))
        throw codeError('OLD_INSTANCE_REMAINS', 'App did not exit; host left untouched');
    }
    await log('app-stopped', { appPids: [...appIds] });
    // Never terminate the host while an app is still alive: Electron interprets
    // host death as a crash and can display its recovery dialog.
    await signalKnown(old.host, 'host', 'SIGTERM', old.host);
    const hostGone = () => scanOld().then(found => found.host.length === 0 && found.app.length === 0);
    if (!await waitUntil(hostGone, adapter.now() + hostGraceMs)) {
      if (!await appGone()) throw codeError('OLD_INSTANCE_REMAINS', 'App reappeared; host left untouched');
      await signalKnown(old.host, 'host', 'SIGKILL', old.host);
      if (!await waitUntil(hostGone, adapter.now() + 3000))
        throw codeError('OLD_INSTANCE_REMAINS', 'Old host did not exit');
    }
    // A stale/unrelated HTTP listener must not make the next launch look healthy.
    if (await adapter.health()) throw codeError('PORT_OCCUPIED', 'HTTP port is healthy before launching new app');
    await persist({ phase: 'starting', attempt });
    await log('launching');
    // 用**刚刚停掉的那个实例自己的** bundle / 路径重新拉起：App 可能在 /Applications 之外的
    // 挂载卷上，写死路径会启动到另一份（旧版本）App。
    const launchApp = old.app[0];
    await adapter.launch({ bundleId: launchApp?.bundle, appPath: launchApp?.bundle, executable: launchApp?.executable });
    const seen = { app: [], host: [] };
    const ready = await waitUntil(async () => {
      const found = await scan();
      if (found.app.length > 1 || found.host.length > 1)
        throw codeError('AMBIGUOUS_INSTANCE', 'Multiple DSH processes appeared after launch');
      const freshApp = found.app.find(p => !appIds.has(p.pid));
      const freshHost = found.host.find(p => !hostIds.has(p.pid) && p.ppid === freshApp?.pid);
      for (const [type, row] of [['app', freshApp], ['host', freshHost]]) if (row && !seen[type].some(p => p.pid === row.pid)) { seen[type].push(row); await log(`new-${type}-detected`, { pid: row.pid }); }
      const healthy = Boolean(freshApp && freshHost) && await adapter.health();
      if (healthy) await log('http-ready');
      return healthy;
    }, adapter.now() + startupTimeoutMs);
    if (!ready) throw Object.assign(codeError('START_TIMEOUT', 'New app, host and HTTP did not all become ready'), { targets: seen });
    await persist({ phase: 'ready', attempt, completedAt: iso(adapter.now()) });
    await log('ready');
  }
  async function stopFailedInstance(targets = { app: [], host: [] }) {
    const current = await scan(targets.host);
    if (current.app.length > 1 || current.host.length > 1) throw codeError('AMBIGUOUS_INSTANCE', 'Failed instance identity is ambiguous');
    await log('failed-instance-stop-app');
    await signalKnown(targets.app, 'app', 'SIGTERM');
    const appGone = async () => (await scan(targets.host)).app.length === 0;
    if (!await waitUntil(appGone, adapter.now() + appGraceMs)) {
      await signalKnown(targets.app, 'app', 'SIGKILL');
      if (!await waitUntil(appGone, adapter.now() + 3000)) throw codeError('RECOVERY_INSTANCE_REMAINS', 'Failed App remains');
    }
    await log('failed-instance-stop-host');
    await signalKnown(targets.host, 'host', 'SIGTERM', targets.host);
    const allGone = async () => { const f = await scan(targets.host); return !f.app.length && !f.host.length; };
    if (!await waitUntil(allGone, adapter.now() + hostGraceMs)) {
      await signalKnown(targets.host, 'host', 'SIGKILL', targets.host);
      if (!await waitUntil(allGone, adapter.now() + 3000)) throw codeError('RECOVERY_INSTANCE_REMAINS', 'Failed Host remains');
    }
    if (await adapter.health()) throw codeError('PORT_OCCUPIED', 'Listener remains after failed instance stopped');
    await log('failed-instance-stopped');
  }
  async function scheduledRestart(plan) {
    try {
      await adapter.sleep(delayMs);
      if (closed) return;
      await runRestart();
      if (plan) await persist({ ...status, details: { ...status.details, requestId: plan.plan.requestId, sessionId: plan.plan.sessionId, pluginName: plan.plan.pluginName, expiresAt: plan.plan.expiresAt } });
      if (plan?.plan?.sessionId) await log('restore-notification-pending', { requestId: plan.plan.requestId, sessionId: plan.plan.sessionId });
      if (plan) { await fs.rm(plan.path, { force: true }); await log('plan-consumed', { requestId: plan.plan.requestId }); }
    } catch (error) {
      if (error.code === 'START_TIMEOUT') {
        try {
          await stopFailedInstance(error.targets);
          if (plan?.plan?.pluginName && typeof adapter.disablePlugin === 'function') {
            await persist({ phase: 'recovery', attempt });
            await log('recovery-needed', { pluginName: plan.plan.pluginName });
            const result = await adapter.disablePlugin(plan.plan.pluginName, plan.plan.patchHash);
            await log('recovery-plugin-disabled', { pluginName: plan.plan.pluginName, result });
            await log('recovery-launching');
            await runRestart(); // Exactly one retry; this catch never recurses.
            await persist({ phase: 'recovered', attempt, completedAt: iso(adapter.now()), details: { requestId: plan.plan.requestId, sessionId: plan.plan.sessionId, expiresAt: plan.plan.expiresAt, disabledPlugin: plan.plan.pluginName } });
            await log('recovery-ready', { pluginName: plan.plan.pluginName });
            return;
          }
        } catch (rescueError) {
          if (rescueError.code === 'START_TIMEOUT') await stopFailedInstance(rescueError.targets).catch(e => log('cleanup-failed', { error: String(e) }));
          await log('recovery-failed', { error: String(rescueError) }).catch(() => {});
          error = rescueError;
        }
      }
      if (plan) await fs.rm(plan.path, { force: true }).catch(() => {});
      await persist({ phase: 'failed', attempt, completedAt: iso(adapter.now()),
        error: `${error.code || 'RESTART_FAILED'}: ${error.message}` }).catch(() => {});
      await log('failed', { error: String(error), requestId: plan?.plan?.requestId }).catch(() => {});
    } finally {
      if (plan) await fs.rm(plan.path, { force: true }).catch(() => {});
      busy = false; activePlan = null;
    }
  }
  async function handle(request) {
    const keys = Object.keys(request || {});
    if (!['status', 'restart', 'ackRecovery'].includes(request?.op) || keys.some(key => !['op', 'requestId'].includes(key)))
      throw codeError('INVALID_REQUEST', 'Only status/restart/ackRecovery with optional requestId are accepted');
    if (request.op === 'status') {
      const found = await scan();
      return { ...status, running: found.app.length > 0 && found.host.length > 0,
        details: { ...status.details, appCount: found.app.length, hostCount: found.host.length, ...(recoveryReport ? { report: recoveryReport } : {}) } };
    }
    if (request.op === 'ackRecovery') {
      if (!['ready', 'recovered'].includes(status.phase) || !request.requestId || status.details?.requestId !== request.requestId || status.details?.recoveryNotifiedAt || (status.details?.expiresAt && Date.parse(status.details.expiresAt) <= adapter.now())) throw codeError('NO_RECOVERY_NOTICE', '没有匹配的待发送恢复通知');
      const claimed = { ...status, details: { ...status.details, recoveryNotifiedAt: iso(adapter.now()) } };
      const response = { ...claimed, details: { ...claimed.details, ...(recoveryReport ? { report: recoveryReport } : {}) } };
      await persist(claimed);
      await log('recovery-notified', { requestId: request.requestId, sessionId: status.details.sessionId });
      recoveryReport = null;
      return response;
    }
    if (busy) throw codeError('BUSY', 'Restart already scheduled or running');
    busy = true; // Before any await: socket handlers can enter concurrently.
    activePlan = null;
    try {
      if (request.requestId !== undefined) {
        if (typeof request.requestId !== 'string') throw codeError('INVALID_PLAN', '无效 requestId');
        const plan = await readPlan(path.dirname(paths.dataDir));
        if (!plan || plan.requestId !== request.requestId) throw codeError('INVALID_PLAN', 'requestId 与重启方案不匹配');
        activePlan = await consumePlan(path.dirname(paths.dataDir), plan.requestId, plan.hash);
        if (!activePlan) throw codeError('INVALID_PLAN', '方案领取失败');
        recoveryReport = activePlan.plan.report || null;
        await log('report-loaded', { requestId: activePlan.plan.requestId, hasReport: Boolean(recoveryReport), reason: recoveryReport?.reason || null, verifyCount: recoveryReport?.verifyAfterRestart?.length || 0, handoffLength: recoveryReport?.handoff?.length || 0 });
        if (typeof adapter.profilePatchHash === 'function') activePlan.plan.patchHash = await adapter.profilePatchHash();
      }
      attempt += 1;
      await persist({ phase: 'scheduled', attempt, scheduledAt: iso(adapter.now() + delayMs), details: { requestId: activePlan?.plan?.requestId || `manual-${attempt}`, pluginName: activePlan?.plan?.pluginName } });
      await log('scheduled', { attempt, requestId: status.details.requestId });
      pending = scheduledRestart(activePlan);
      return { ...status, running: false };
    } catch (error) {
      if (activePlan) await fs.rm(activePlan.path, { force: true }).catch(() => {});
      activePlan = null; busy = false; throw error;
    }
  }
  async function serve(socket) {
    try {
      const text = await readRequest(socket);
      if (text.trim() !== text.split('\n')[0]) throw codeError('INVALID_REQUEST', 'One JSON line required');
      const result = await handle(JSON.parse(text.split('\n')[0]));
      socket.end(`${JSON.stringify(immutableResponse(true, result))}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify(immutableResponse(false, null, error))}\n`);
    }
  }
  async function start() {
    await privateDirectory(paths.dataDir);
    await ensureSocketVacant(paths.socketPath);
    try {
      const previous = JSON.parse(await fs.readFile(paths.statusPath, 'utf8'));
      if (Number.isSafeInteger(previous.attempt)) attempt = previous.attempt;
      status = { protocolVersion: PROTOCOL_VERSION, phase: ['idle', 'ready', 'recovered', 'failed', 'interrupted'].includes(previous.phase) ? previous.phase : 'interrupted',
        attempt, updatedAt: iso(adapter.now()), ...(previous.error ? { error: previous.error } : {}), ...(previous.details ? { details: previous.details } : {}) };
    } catch (error) { if (error.code !== 'ENOENT') await log('status-read-failed', { error: String(error) }); }
    await persist(status);
    server = net.createServer(serve);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    await ipcAfterListen(paths.socketPath);
    await log('listening');
    return { paths, close, whenIdle: () => pending };
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // 管道没有文件实体，监听中 unlink 会 EBUSY；darwin 侧行为保持不变。
    if (ipcHasFileEntity) {
      try { await fs.unlink(paths.socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await ipcBeforeClose(paths.socketPath);
  }
  return { start, close, whenIdle: () => pending, paths };
}

export async function startDaemon(options) { return createDaemon(options).start(); }
