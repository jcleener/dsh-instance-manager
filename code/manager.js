import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePlan } from './daemon/plan.mjs';
import { isWindows, ipcPath, assertOwnedDirectory, resolveWindowsInterpreter, hiddenLauncherVbs, daemonCommandFile,
  supervisorTaskXml, createWindowsTask, runWindowsTask, deleteWindowsTask, windowsTaskExists, startViaWmi,
  spawnDetached, listWindowsProcesses, normalizeWinCommand, killWindows } from './platform.mjs';

export const LABEL = 'local.dsh.instance-manager';
const exec = promisify(execFile);
export function paths(home = process.env.DSH_HOME || join(homedir(), '.dsh'), { platform = process.platform } = {}) {
  const base = join(home, 'instance-manager');
  const autostart = join(base, 'autostart');
  return {
    home, base, runtime: join(base, 'runtime'), autostart, platform,
    // darwin = LaunchAgent plist；win32 = 计划任务 XML。沿用 plist 键名，
    // 保住"描述文件存在即已安装"这个既有调用点语义。
    plist: platform === 'win32'
      ? join(autostart, 'instance-manager.task.xml')
      : join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
    vbs: join(autostart, 'launch.vbs'),
    cmd: join(autostart, 'run-daemon.cmd'),
    supervisorConfig: join(autostart, 'supervisor.json'),
    supervisorLog: join(base, 'supervisor.log'),
    socket: ipcPath(home, platform),
  };
}
export function cleanEnvironment(env = process.env) {
  const next = { ...env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DSH_DESKTOP_NODE_EXECUTABLE']) delete next[key];
  return next;
}
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function launchAgentPlist(node, runner, base) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${escape(node)}</string><string>${escape(runner)}</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>EnvironmentVariables</key><dict><key>DSH_HOME</key><string>${escape(dirname(base))}</string></dict>\n<key>StandardOutPath</key><string>${escape(join(base, 'launchd.stdout.log'))}</string>\n<key>StandardErrorPath</key><string>${escape(join(base, 'launchd.stderr.log'))}</string>\n</dict></plist>\n`;
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function copyTree(source, target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(source, entry.name), join(target, entry.name));
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(target, entry.name));
    else throw new Error('拒绝复制符号链接或非普通文件');
  }
}
async function launchctl(args) {
  if (process.platform !== 'darwin') throw new Error('仅支持 macOS LaunchAgent');
  return exec('/bin/launchctl', args, { env: cleanEnvironment(), timeout: 15000, maxBuffer: 131072 });
}
const domain = () => `gui/${process.getuid()}`;
/** bootstrap 已加载的服务会报 EALREADY/EIO，属正常竞态，不当失败。 */
async function bootstrapQuietly(p) {
  try { await launchctl(['bootstrap', domain(), p.plist]); }
  catch (error) { if (!/already|EALREADY|EIO|Bootstrap failed: 5|Input\/output/i.test(String(error?.message ?? error))) throw error; }
}
export async function start(options = {}) {
  const p = paths(options.home);
  if (isWindows) return startWindows(p, options);
  if (!await exists(p.plist)) throw new Error('请先安装后台启动器');
  let loaded = false;
  try { await launchctl(['print', `${domain()}/${LABEL}`]); loaded = true; } catch { /* absent */ }
  if (!loaded) await bootstrapQuietly(p);
  const { requestStatus } = await import('./daemon/index.mjs');
  let lastError;
  // LaunchAgent ThrottleInterval is 10s; allow a delayed relaunch to become ready.
  for (let i = 0; i < 75; i++) {
    try { await requestStatus({ home: p.home, timeout: 900 }); return { ok: true, action: 'start' }; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  // 已加载但 socket 一直起不来（bootout/bootstrap 竞态）：强制踢一次再试一轮。
  try { await launchctl(['bootout', `${domain()}/${LABEL}`]); } catch { /* 可能已不在 */ }
  await bootstrapQuietly(p);
  for (let i = 0; i < 75; i++) {
    try { await requestStatus({ home: p.home, timeout: 900 }); return { ok: true, action: 'start' }; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw new Error(`LaunchAgent 已注册但 socket 未就绪：${lastError?.message ?? '超时'}`);
}
export async function stop(options = {}) {
  const p = paths(options.home);
  if (isWindows) return stopWindows(p, options);
  let loaded = false;
  try { await launchctl(['print', `${domain()}/${LABEL}`]); loaded = true; } catch { /* absent */ }
  if (loaded) await launchctl(['bootout', `${domain()}/${LABEL}`]);
  return { ok: true, action: 'stop' };
}
export async function install(options = {}) {
  const p = paths(options.home);
  if (isWindows) return installWindows(p, options);
  const node = options.node || join(p.home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node');
  await access(node, constants.X_OK);
  if (process.platform !== 'darwin') throw new Error('仅支持 macOS');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), 'daemon');
  await mkdir(p.base, { recursive: true, mode: 0o700 });
  await mkdir(dirname(p.plist), { recursive: true });
  await stop(options);
  const stage = `${p.runtime}.next-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  await copyTree(source, join(stage, 'daemon'));
  await rm(p.runtime, { recursive: true, force: true });
  await rename(stage, p.runtime);
  await writeFile(p.plist, launchAgentPlist(node, join(p.runtime, 'daemon', 'runner.mjs'), p.base), { mode: 0o600 });
  await start(options);
  return { ok: true, action: 'install' };
}
/**
 * 运行副本里 daemon 半实际所在的目录。
 * ⚠️ Windows 的布局是 `runtime/daemon-<哈希>/daemon/*.mjs`（见 installWindows），比 macOS 多一层
 * `daemon/`；少拼这一层会永远读不到文件 → 永远判定"有差异"。2026-10-10 实测踩过：
 * 每次 apply 都白重装、`changed` 恒为 true，而且**改了 daemon 半的代码永远不会生效**。
 */
export function runtimeDaemonFileDir(runningDir, windows = isWindows) {
  if (runningDir === null) return null;
  return windows ? join(runningDir, 'daemon') : runningDir;
}

/** 逐个文件比对"插件源码"与"运行副本"（纯 I/O，不碰 home，便于单元测试）。 */
export async function runtimeFilesDiffer(sourceDir, runningFileDir, names) {
  if (runningFileDir === null) return true;
  for (const name of names) {
    let fresh = null, running = null;
    try { fresh = await readFile(join(sourceDir, name)); } catch { continue; }
    try { running = await readFile(join(runningFileDir, name)); } catch { /* 运行副本缺失 → 需要重装 */ }
    if (running === null || !fresh.equals(running)) return true;
  }
  return false;
}

/**
 * 让独立后台的运行副本与插件源码保持一致。
 * 独立后台是**复制**到 `~/.dsh/instance-manager/runtime/` 运行的：只改插件源码不会影响正在运行的它。
 * 所以内容有差异时必须：**先停掉在跑的 daemon**（否则 `start` 撞上 `ALREADY_RUNNING → 退出 0`，
 * 旧进程会一直跑旧代码）→ 再 `install`（拷副本 + 起新进程）。
 * @returns {Promise<{ok:true, action:'sync', changed:boolean, restarted?:boolean}>}
 */
export async function syncDaemonRuntime(options = {}) {
  const p = paths(options.home);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), 'daemon');
  let names;
  try { names = (await readdir(source)).filter(n => n.endsWith('.mjs')).sort(); }
  catch { return { ok: true, action: 'sync', changed: false }; }
  const runningDir = isWindows ? await newestRuntimeDir(p) : join(p.runtime, 'daemon');
  if (!await runtimeFilesDiffer(source, runtimeDaemonFileDir(runningDir), names)) {
    return { ok: true, action: 'sync', changed: false };
  }
  const before = await status(options).catch(() => null);
  if (['scheduled', 'stopping', 'starting', 'recovery', 'recovery-starting'].includes(before?.daemon?.phase)) {
    // 重启正在执行：此刻停后台会把"没人再拉起 App"变成现实。留给下次 apply。
    return { ok: true, action: 'sync', changed: false, deferred: 'restart-in-progress' };
  }
  const wasRunning = Boolean(before?.running);
  if (wasRunning) await stop(options);
  try {
    await install(options);
  } catch (error) {
    await start(options).catch(() => {});   // 至少把某个后台拉起来，别留下"没有执行体"的状态
    throw error;
  }
  return { ok: true, action: 'sync', changed: true, restarted: wasRunning };
}

/** 找到当前的版本化运行副本目录（正常只有一个：install 会清理旧的）。 */
async function newestRuntimeDir(p) {
  try {
    const entries = (await readdir(p.runtime, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('daemon-'));
    if (entries.length === 0) return null;
    return join(p.runtime, entries.sort((a, b) => a.name.localeCompare(b.name)).at(-1).name);
  } catch { return null; }
}
export async function uninstall(options = {}) {
  const p = paths(options.home);
  if (isWindows) {
    await stopWindows(p, options);
    await deleteWindowsTask().catch(() => {});
    await rm(p.plist, { force: true });
    await rm(p.vbs, { force: true });
    await rm(p.cmd, { force: true });
    await rm(p.supervisorConfig, { force: true });
    return { ok: true, action: 'uninstall' };
  }
  await stop(options);
  await rm(p.plist, { force: true });
  await rm(p.runtime, { recursive: true, force: true });
  // 保留日志和结果，不触碰profile、模型或会话。
  return { ok: true, action: 'uninstall' };
}
export async function status(options = {}) {
  const p = paths(options.home);
  const installed = isWindows ? await windowsTaskExists() : await exists(p.plist);
  try {
    const { requestStatus } = await import('./daemon/index.mjs');
    const daemon = await requestStatus({ home: p.home });
    return { ok: true, installed, running: true, daemon, lastResult: daemon };
  } catch (error) {
    let lastResult;
    try { lastResult = JSON.parse(await readFile(join(p.base, 'status.json'), 'utf8')); } catch { /* first install */ }
    return { ok: true, installed, running: false, lastResult, error: error.message };
  }
}
export async function logs(options = {}) {
  const p = paths(options.home);
  const pieces = [];
  for (const file of ['daemon.log', 'host.log', 'launchd.stderr.log', 'launchd.stdout.log', 'supervisor.log']) {
    try { const text = await readFile(join(p.base, file), 'utf8'); pieces.push(`${file}:\n${text.slice(-24000)}`); } catch { /* absent */ }
  }
  return { ok: true, text: pieces.join('\n\n') || '尚无日志' };
}
export async function recordEvent(event, details, options = {}) {
  const base = paths(options.home).base;
  const dir = await lstat(base);
  try { assertOwnedDirectory(dir, '不安全的日志目录'); } catch { throw new Error('不安全的日志目录'); }
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (isWindows ? 0 : constants.O_NOFOLLOW);
  const handle = await open(join(base, 'host.log'), flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (isWindows ? false : stat.uid !== process.getuid())) throw new Error('不安全的 Host 日志');
    if (!isWindows) await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');
  }
  finally { await handle.close(); }
}
export async function acknowledgeRecovery(requestId, options = {}) {
  const { acknowledgeRecovery } = await import('./daemon/index.mjs');
  return { ok: true, status: await acknowledgeRecovery({ home: paths(options.home).home, requestId }) };
}
export async function preflight(pluginName, options = {}) {
  const current = await status(options);
  if (!current.running || current.daemon?.protocolVersion !== 2) throw new Error('后台不可用或版本不兼容，未重启');
  if (['scheduled', 'stopping', 'starting', 'recovery', 'recovery-starting'].includes(current.daemon.phase)) throw new Error('已有重启正在执行');
  const { preflightPlugin } = await import('./daemon/runtime.mjs');
  return { ok: true, ...await preflightPlugin(paths(options.home).home, pluginName) };
}
export async function prepareRestart(plan, options = {}) {
  await preflight(plan.pluginName, options);
  return { ok: true, plan: await writePlan(paths(options.home).home, plan) };
}
export async function requestPreparedRestart(requestId, options = {}) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new Error('无效 requestId');
  const { requestRestart } = await import('./daemon/index.mjs');
  return { ok: true, status: await requestRestart({ home: paths(options.home).home, requestId }) };
}
export async function restart(options = {}) {
  if (options.plan) await prepareRestart(options.plan, options);
  const { requestRestart } = await import('./daemon/index.mjs');
  try { return { ok: true, status: await requestRestart({ home: paths(options.home).home, requestId: options.plan?.requestId }) }; }
  catch (error) {
    if (options.plan) {
      const { clearPlan } = await import('./daemon/plan.mjs');
      await clearPlan(paths(options.home).home, options.plan.requestId).catch(() => {});
    }
    throw error;
  }
}
let managementInFlight = false;
export async function action(name, options = {}) {
  const actions = { install, start, stop, uninstall, restart };
  if (!Object.hasOwn(actions, name)) throw new Error('不支持的管理动作');
  if (managementInFlight) throw new Error('已有管理操作正在进行');
  managementInFlight = true;
  try {
    if (['install', 'stop', 'uninstall'].includes(name)) {
      const current = await status(options);
      if (['scheduled', 'stopping', 'starting', 'recovery', 'recovery-starting'].includes((current.daemon || current.lastResult)?.phase)) {
        throw new Error('正在重启期间不能停止、卸载或覆盖后台启动器');
      }
    }
    return await actions[name](options);
  } finally { managementInFlight = false; }
}

// ───────────────────────── Windows 后台启动器 ─────────────────────────
// 与 macOS 的分工相同：本模块负责"装上、启动、停掉、卸载"，daemon 负责重启执行。
// 差别只在监管机制：macOS 用 LaunchAgent（RunAtLoad + KeepAlive），
// Windows 用计划任务（LogonTrigger + RestartOnFailure + IgnoreNew）。

/**
 * 安装：把 daemon 复制成**版本化运行副本**，写隐藏启动包装与计划任务，注册任务后启动。
 * 运行副本用 `daemon-<内容哈希>` 且只增不改：Windows 上删除"正在被旧 daemon 使用"的目录
 * 会 EBUSY/EPERM，原地替换会留下半个 runtime——而它偏偏会被 apply() 的 catch 吞掉（完全静默）。
 */
async function installWindows(p, options = {}) {
  const interpreter = await resolveWindowsInterpreter({ execPath: process.execPath });
  await mkdir(p.autostart, { recursive: true });
  const source = resolve(dirname(fileURLToPath(import.meta.url)), 'daemon');
  const platformSource = resolve(dirname(fileURLToPath(import.meta.url)), 'platform.mjs');
  const names = (await readdir(source)).filter((name) => name.endsWith('.mjs')).sort();
  // 运行副本必须**镜像源码布局**：daemon 里的模块用 `../platform.mjs` 引用平台模块，
  // 只复制 daemon/ 下的文件会让 daemon 在第一行 import 就 ERR_MODULE_NOT_FOUND。
  const hash = crypto.createHash('sha256');
  hash.update(await readFile(platformSource));
  for (const name of names) hash.update(await readFile(join(source, name)));
  const stamp = hash.digest('hex').slice(0, 12);
  const target = join(p.runtime, `daemon-${stamp}`);
  await mkdir(join(target, 'daemon'), { recursive: true });
  for (const name of names) await copyFile(join(source, name), join(target, 'daemon', name));
  await copyFile(platformSource, join(target, 'platform.mjs'));
  const runnerPath = join(target, 'daemon', 'runner.mjs');
  const cmdPath = join(p.autostart, 'run-daemon.cmd');
  await writeFile(cmdPath, daemonCommandFile({ interpreter, runnerPath, logPath: p.supervisorLog }), 'utf8');
  await writeFile(p.vbs, hiddenLauncherVbs({ cmdPath }), 'utf8');
  // 计划任务没有环境变量可传，所以把真实 Web 端口落盘：daemon 的 health() 靠它避免
  // 写死 19387 造成的假就绪/假 PORT_OCCUPIED。
  const webPort = resolveWebPort(options.port);
  await writeFile(join(p.base, 'runtime.json'), `${JSON.stringify({ home: p.home, port: webPort, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  await writeFile(p.supervisorConfig, `${JSON.stringify({ interpreter, runnerPath, cmdPath, home: p.home, port: options.port ?? null, supervisor: 'windows-scheduled-task' }, null, 2)}\n`, 'utf8');
  await writeFile(p.plist, supervisorTaskXml({ vbsPath: p.vbs }), 'utf8');
  let supervisor = 'scheduled-task';
  try { await createWindowsTask({ xmlPath: p.plist }); }
  catch (error) { supervisor = `degraded:${error.message}`; }
  try {
    const started = await startWindows(p, options);
    return { ok: true, action: 'install', interpreter: interpreter.kind, runtime: target, supervisor, started };
  } finally {
    // 即使本次启动失败也要清掉旧副本：否则每次代码改动都会在磁盘上留一份死副本。
    await pruneOldRuntimes(p, target);
  }
}

/** 计划任务没有环境变量可传，所以把真实 Web 端口落盘给 daemon 的 health() 用。 */
function resolveWebPort(explicit) {
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  try {
    const port = Number(new URL(process.env.DSH_WEB_URL || '').port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

/** 只保留最新运行副本；删除失败不致命（旧 daemon 可能仍持有句柄，下次再清）。 */
async function pruneOldRuntimes(p, keep) {
  let entries = [];
  try { entries = await readdir(p.runtime, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(p.runtime, entry.name);
    if (!entry.isDirectory() || full === keep) continue;
    try { await rm(full, { recursive: true, force: true }); } catch { /* 下次再清 */ }
  }
}

async function readSupervisorConfig(p) {
  try { return JSON.parse(await readFile(p.supervisorConfig, 'utf8')); } catch { return null; }
}

/**
 * 启动：优先让**计划任务服务**创建进程（`schtasks /Run`）。这条路径保证 daemon 不在
 * DSH App 的 Chromium Job 里——否则 App 一死 daemon 会被连带杀死，而"杀掉 App 再拉起它"
 * 正是本插件的核心动作。任务不存在时才退化为 WMI 创建，最后才用普通 detached spawn。
 */
async function startWindows(p, options = {}) {
  const { requestStatus } = await import('./daemon/index.mjs');
  try { await requestStatus({ home: p.home, timeout: 900 }); return { ok: true, action: 'start', via: 'already-running' }; }
  catch { /* 未在运行 */ }
  const config = await readSupervisorConfig(p);
  if (!config) throw new Error('后台启动器未安装：请先执行 install');
  const commandLine = `"${config.interpreter.path}" "${config.runnerPath}"`;
  let via = 'scheduled-task';
  try { await runWindowsTask(); }
  catch {
    via = 'wmi';
    try { await startViaWmi(commandLine); }
    catch {
      via = 'direct-spawn';
      spawnDetached(config.interpreter.path, [config.runnerPath], { env: { ...process.env, DSH_HOME: p.home }, cwd: p.base });
    }
  }
  let lastError;
  for (let i = 0; i < 75; i++) {
    try { await requestStatus({ home: p.home, timeout: 900 }); return { ok: true, action: 'start', via }; }
    catch (error) { lastError = error; await new Promise((done) => setTimeout(done, 200)); }
  }
  throw new Error(`后台已拉起但管道未就绪：${lastError?.message ?? '超时'}`);
}

/**
 * 停止：计划任务的 `/End` 杀不掉 node —— 任务动作是 wscript，它以隐藏窗口启动 node 后
 * 立即退出，node 成了"孤儿"。所以必须按**运行副本路径**精确识别进程再终止。
 * 保留计划任务本身（下次登录仍会自启），语义与 macOS `launchctl bootout` 一致。
 */
async function stopWindows(p, options = {}) {
  const config = await readSupervisorConfig(p);
  const marker = normalizeWinCommand(config?.runnerPath ?? join(p.runtime, 'daemon-'));
  let rows = [];
  try { rows = await listWindowsProcesses(); } catch { rows = []; }
  let killed = 0;
  for (const row of rows) {
    const command = normalizeWinCommand(row.command);
    const hit = command.includes(marker)
      || (command.includes('/runtime/daemon-') && command.includes('runner.mjs'));
    if (!hit) continue;
    try { await killWindows(row.pid, 'SIGKILL'); killed++; } catch { /* 已自行退出 */ }
  }
  const { requestStatus } = await import('./daemon/index.mjs');
  for (let i = 0; i < 25; i++) {
    try { await requestStatus({ home: p.home, timeout: 500 }); }
    catch { return { ok: true, action: 'stop', killed }; }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('后台仍在运行，停止失败');
}
