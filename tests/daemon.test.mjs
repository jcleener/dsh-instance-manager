import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDaemon, requestStatus, requestRestart, defaultPaths } from '../code/daemon/index.mjs';
import { APP_PATH, MAIN_EXECUTABLE, HOST_SCRIPT, discoverTargets, parsePs, createSystemAdapter } from '../code/daemon/runtime.mjs';

/**
 * 私有权断言：darwin 上必须是 POSIX 私有 mode；Windows 没有 POSIX 私有权
 * （mode 恒 0o666，本机实测），因此断言的是"已按平台降级"这个事实，而不是跳过断言。
 */
const assertPrivate = (actual, posixMode) => assert.equal(actual, process.platform === 'win32' ? 0o666 : posixMode);

const app = (pid = 10) => ({ pid, ppid: 1, command: MAIN_EXECUTABLE });
const host = (pid = 11, ppid = 10, profile = '__PROFILE__') => ({ pid, ppid,
  command: `${MAIN_EXECUTABLE} --expose-internals ${HOST_SCRIPT} ${APP_PATH}/Contents/Resources/app.asar/dsh ${profile} ${APP_PATH}/Contents/Resources/runtime/primary-runtime` });
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(adapter, config = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-daemon-test-'));
  adapter.profile = path.join(home, 'profiles', 'desktop');
  adapter.processes = adapter.processes.map(row => ({ ...row,
    command: row.command.replace('__PROFILE__', adapter.profile) }));
  // 这些 fixture 用的是 macOS 形状的进程命令行（`.app/Contents/MacOS/…`），
  // 因此显式声明平台：本套件回归的是 macOS 重启流程，不随宿主平台漂移。
  const daemon = createDaemon({ home, adapter, platform: 'darwin', delayMs: 5000, pollMs: 100,
    appGraceMs: 200, hostGraceMs: 200, startupTimeoutMs: 300, ...config });
  await daemon.start();
  return { home, daemon, async cleanup() { await daemon.close(); await fs.rm(home, { recursive: true, force: true }); } };
}

function fake(initial = []) {
  let clock = Date.now();
  let processes = initial;
  let healthy = false;
  const events = [];
  const gate = deferred();
  return {
    events, gate, profile: '__PROFILE__',
    get processes() { return processes; },
    set processes(value) { processes = value; },
    set healthy(value) { healthy = value; },
    now: () => clock,
    async sleep(ms) { if (ms === 5000) await gate.promise; clock += ms; },
    async listProcesses() { return processes.map(row => ({ ...row })); },
    async signal(pid, signal) {
      events.push(`${signal}:${pid}`);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') processes = processes.filter(row => row.pid !== pid);
    },
    async launch() { events.push('launch'); processes = [app(20), host(21, 20, this.profile)]; healthy = true; },
    async health() { return healthy; },
  };
}

test('real ps-style same-binary host never appears in app; wrong profile is excluded', () => {
  const home = '/tmp/fixed-dsh-home';
  const profile = `${home}/profiles/desktop`;
  const rows = [app(), host(11, 10, profile), host(12, 10, '/tmp/other/profiles/desktop'),
    { pid: 13, ppid: 10, command: '/usr/bin/node /tmp/dsh-desktop-host' },
    { pid: 14, ppid: 1, command: '/usr/bin/open -a /Applications/DeepSeek Harness.app' },
    { pid: 15, ppid: 1, command: `${MAIN_EXECUTABLE}-spoof` }];
  // `…-spoof` **也算同一个 App**：原实现就是"名字前缀命中"（用户 2026-10-10 确认这是刻意语义）。
  // 这里原本断言 [10]（"spoof 不该算"），我曾据此给 appExecutableOf 加结尾校验 → 等于改了 macOS 语义，已回退。
  assert.deepEqual(discoverTargets(rows, { home }).app.map(row => row.pid), [10, 15]);
  assert.deepEqual(discoverTargets(rows, { home }).host.map(row => row.pid), [11]);
  assert.deepEqual(parsePs(`  10  1  ${MAIN_EXECUTABLE}\n`), [app()]);
});

test('idle startup, private permissions, delayed reply, exclusive restart, completed readiness', async () => {
  const adapter = fake([app(), host()]);
  const f = await fixture(adapter);
  try {
    const p = defaultPaths(f.home);
    assert.equal((await requestStatus({ home: f.home })).phase, 'idle');
    assert.deepEqual(adapter.events, []);
    assertPrivate((await fs.stat(p.dataDir)).mode & 0o777, 0o700);
    assertPrivate((await fs.stat(p.socketPath)).mode & 0o777, 0o600);
    const accepted = await requestRestart({ home: f.home });
    assert.equal(accepted.phase, 'scheduled');
    assert.equal(accepted.running, false);
    assert.equal(adapter.events.length, 0);
    await assert.rejects(requestRestart({ home: f.home }), { code: 'BUSY' });
    adapter.gate.release();
    await f.daemon.whenIdle();
    const status = await requestStatus({ home: f.home });
    assert.equal(status.phase, 'ready');
    assert.equal(status.running, true);
    assert.deepEqual(adapter.events, ['SIGTERM:10', 'SIGTERM:11', 'launch']);
    assertPrivate((await fs.stat(p.statusPath)).mode & 0o777, 0o600);
    assertPrivate((await fs.stat(p.logPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(p.statusPath, 'utf8')).phase, 'ready');
  } finally { await f.cleanup(); }
});

test('request payload cannot select an arbitrary pid or command', async () => {
  const adapter = fake();
  const f = await fixture(adapter);
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(defaultPaths(f.home).socketPath);
      let reply = '';
      socket.on('connect', () => socket.write('{"op":"restart","pid":123,"command":"rm"}\n'));
      socket.on('data', chunk => { reply += chunk; });
      socket.on('end', () => resolve(JSON.parse(reply.trim())));
      socket.on('error', reject);
    });
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.equal((await requestStatus({ home: f.home })).phase, 'idle');
    assert.deepEqual(adapter.events, []);
  } finally { await f.cleanup(); }
});

test('does not launch if old host survives TERM and KILL, records failure', async () => {
  const adapter = fake([app(), host()]);
  adapter.signal = async (pid, signal) => {
    adapter.events.push(`${signal}:${pid}`);
    if (pid === 10) adapter.processes = adapter.processes.filter(row => row.pid !== pid);
  };
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.equal((await requestStatus({ home: f.home })).phase, 'failed');
    assert.match((await requestStatus({ home: f.home })).error, /OLD_INSTANCE_REMAINS/);
    assert.ok(adapter.events.includes('SIGKILL:11'));
    assert.ok(!adapter.events.includes('launch'));
  } finally { await f.cleanup(); }
});

test('verified same-binary host remains eligible after becoming orphaned', async () => {
  const adapter = fake([app(), host()]);
  adapter.signal = async (pid, signal) => {
    adapter.events.push(`${signal}:${pid}`);
    if (pid === 10) adapter.processes = adapter.processes.filter(row => row.pid !== pid)
      .map(row => ({ ...row, ppid: 1 }));
    if (pid === 11) adapter.processes = [];
  };
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.equal((await requestStatus({ home: f.home })).phase, 'ready');
    assert.ok(adapter.events.includes('SIGTERM:11'));
  } finally { await f.cleanup(); }
});

test('occupied health port cannot be mistaken for a successful new launch', async () => {
  const adapter = fake();
  adapter.healthy = true;
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.match((await requestStatus({ home: f.home })).error, /PORT_OCCUPIED/);
    assert.ok(!adapter.events.includes('launch'));
  } finally { await f.cleanup(); }
});

test('ambiguous multiple apps fail closed without signaling anything', async () => {
  const adapter = fake([app(), app(99), host()]);
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.match((await requestStatus({ home: f.home })).error, /AMBIGUOUS_INSTANCE/);
    assert.deepEqual(adapter.events, []);
  } finally { await f.cleanup(); }
});

test('PID reuse with changed command must never receive TERM or KILL', async () => {
  const adapter = fake([app(), host()]);
  let scans = 0;
  adapter.listProcesses = async () => {
    scans += 1;
    if (scans === 2) adapter.processes = [
      { pid: 10, ppid: 1, command: `${MAIN_EXECUTABLE} --different-instance` },
      adapter.processes[1]];
    return adapter.processes.map(row => ({ ...row }));
  };
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.ok(!adapter.events.some(event => /:10$/.test(event)));
  } finally { await f.cleanup(); }
});

test('App ignoring TERM is KILLed and verified gone before Host TERM', async () => {
  const adapter = fake([app(), host()]);
  adapter.signal = async (pid, signal) => {
    adapter.events.push(`${signal}:${pid}`);
    if (pid === 10 && signal === 'SIGKILL') adapter.processes = adapter.processes.filter(row => row.pid !== 10);
    if (pid === 11) {
      assert.equal(adapter.processes.some(row => row.pid === 10), false, 'Host must not be signaled with live App');
      adapter.processes = adapter.processes.filter(row => row.pid !== 11);
    }
  };
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.deepEqual(adapter.events, ['SIGTERM:10', 'SIGKILL:10', 'SIGTERM:11', 'launch']);
    assert.equal((await requestStatus({ home: f.home })).phase, 'ready');
  } finally { await f.cleanup(); }
});

test('App resisting even KILL fails safely without touching Host', async () => {
  const adapter = fake([app(), host()]);
  adapter.signal = async (pid, signal) => { adapter.events.push(`${signal}:${pid}`); };
  const f = await fixture(adapter);
  try {
    await requestRestart({ home: f.home });
    adapter.gate.release();
    await f.daemon.whenIdle();
    assert.deepEqual(adapter.events, ['SIGTERM:10', 'SIGKILL:10']);
    assert.match((await requestStatus({ home: f.home })).error, /OLD_INSTANCE_REMAINS/);
  } finally { await f.cleanup(); }
});

test('HTTP 401 proves listener available but 503 is not ready', async () => {
  let status = 401;
  const server = http.createServer((_request, response) => { response.writeHead(status); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = createSystemAdapter({ port: server.address().port });
    assert.equal(await adapter.health(), true);
    status = 503;
    assert.equal(await adapter.health(), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
