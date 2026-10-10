import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemon, requestRestart, requestStatus, acknowledgeRecovery } from '../code/daemon/index.mjs';
import { writePlan, planPath } from '../code/daemon/plan.mjs';
import { disablePluginInProfile, preflightPlugin } from '../code/daemon/runtime.mjs';
import { MAIN_EXECUTABLE, HOST_SCRIPT } from '../code/daemon/runtime.mjs';
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-safe-'));
  const profile = path.join(home, 'profiles', 'desktop');
  await fs.mkdir(profile, { recursive: true });
  const patch = path.join(profile, 'cordis.patch.yml');
  const text = '- insert:\n    - id: sample-entry\n      name: sample\n      config:\n        value: keep\n    - id: other\n      name: other\n- id: sample-entry\n  name: sample\n  disabled: false\n  config:\n    key: unchanged\n';
  await fs.writeFile(patch, text, { mode: 0o600 });
  let clock = Date.now(), rows = [], launches = 0, healthy = false, release;
  const gate = new Promise(r => { release = r; });
  const adapter = { now: () => clock, sleep: async ms => { if (ms === 5000) await gate; clock += ms; },
    listProcesses: async () => rows.map(r => ({ ...r })), signal: async pid => { rows = rows.filter(r => r.pid !== pid); healthy = false; },
    launch: async () => { launches++; const pid = 100 + launches * 10; rows = [{ pid, ppid: 1, command: MAIN_EXECUTABLE },
      { pid: pid + 1, ppid: pid, command: `${MAIN_EXECUTABLE} --expose-internals ${HOST_SCRIPT} bundled ${profile} runtime` }]; healthy = launches > 1; },
    health: async () => healthy, profilePatchHash: async () => (await preflightPlugin(home, 'sample')).patchHash,
    disablePlugin: (name, hash) => disablePluginInProfile(home, name, hash) };
  // macOS 形状的 fixture（`.app/Contents/MacOS/…`）：显式声明平台，不随宿主平台漂移。
  const daemon = createDaemon({ home, adapter, platform: 'darwin', startupTimeoutMs: 100, pollMs: 50, appGraceMs: 100, hostGraceMs: 100 });
  await daemon.start();
  const plan = { version: 1, requestId: 'restart-safe-1234', pluginName: 'sample', sessionId: 'original', createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 60000).toISOString() };
  return { home, patch, text, adapter, daemon, plan, release, get launches() { return launches; }, get rows() { return rows; },
    cleanup: async () => { await daemon.close(); await fs.rm(home, { recursive: true, force: true }); } };
}
test('startup failure disables only named plugin, retries once and claims notification once', async () => {
  const f = await fixture();
  try {
    const checked = await preflightPlugin(f.home, 'sample'); assert.equal(checked.id, 'sample-entry');
    await writePlan(f.home, f.plan);
    await requestRestart({ home: f.home, requestId: f.plan.requestId }); f.release(); await f.daemon.whenIdle();
    const s = await requestStatus({ home: f.home }); assert.equal(s.phase, 'recovered'); assert.equal(f.launches, 2);
    const text = await fs.readFile(f.patch, 'utf8');
    assert.match(text, /id: sample-entry\n      disabled: true/); assert.match(text, /name: sample\n  disabled: true/);
    assert.match(text, /name: other/); assert.match(text, /value: keep/); assert.match(text, /key: unchanged/);
    await assert.rejects(fs.access(planPath(f.home)));
    const result = await acknowledgeRecovery({ home: f.home, requestId: f.plan.requestId }); assert.equal(result.details.sessionId, 'original');
    await assert.rejects(acknowledgeRecovery({ home: f.home, requestId: f.plan.requestId }), { code: 'NO_RECOVERY_NOTICE' });
    const logs = (await fs.readFile(path.join(f.home, 'instance-manager', 'daemon.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(logs.filter(l => !['listening'].includes(l.event)).every(l => l.requestId));
  } finally { await f.cleanup(); }
});
test('ordinary restart ignores invalid plan and stops only failed new instance without editing profile', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(planPath(f.home), '{bad json', { mode: 0o600 });
    await requestRestart({ home: f.home }); f.release(); await f.daemon.whenIdle();
    assert.equal((await requestStatus({ home: f.home })).phase, 'failed'); assert.equal(f.rows.length, 0);
    assert.equal(await fs.readFile(f.patch, 'utf8'), f.text); assert.equal(await fs.readFile(planPath(f.home), 'utf8'), '{bad json');
  } finally { await f.cleanup(); }
});
test('simultaneous restart requests cannot pass the lock before first await', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([requestRestart({ home: f.home }), requestRestart({ home: f.home })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'BUSY');
    f.release(); await f.daemon.whenIdle();
  } finally { await f.cleanup(); }
});
test('successful plan restart preserves original session and never changes config', async () => {
  const f = await fixture();
  try {
    f.adapter.health = async () => f.rows.length === 2;
    await writePlan(f.home, f.plan);
    await requestRestart({ home: f.home, requestId: f.plan.requestId }); f.release(); await f.daemon.whenIdle();
    const s = await requestStatus({ home: f.home }); assert.equal(s.phase, 'ready'); assert.equal(s.details.sessionId, 'original');
    assert.equal(f.launches, 1); assert.equal(await fs.readFile(f.patch, 'utf8'), f.text);
    await acknowledgeRecovery({ home: f.home, requestId: f.plan.requestId });
  } finally { await f.cleanup(); }
});
test('interrupted persisted restart is not replayed on daemon startup', async () => {
  const f = await fixture(); let resumed;
  try {
    await f.daemon.close();
    await fs.writeFile(path.join(f.home, 'instance-manager', 'status.json'), JSON.stringify({ phase: 'starting', attempt: 9 }));
    resumed = createDaemon({ home: f.home, adapter: f.adapter }); await resumed.start();
    assert.equal((await requestStatus({ home: f.home })).phase, 'interrupted'); assert.equal(f.launches, 0);
  } finally { if (resumed) await resumed.close(); await f.cleanup(); }
});
test('configuration changed since preflight refuses rescue writes', async () => {
  const f = await fixture();
  try {
    const checked = await preflightPlugin(f.home, 'sample'); await fs.appendFile(f.patch, '# external edit\n');
    await assert.rejects(disablePluginInProfile(f.home, 'sample', checked.patchHash), /PROFILE_PATCH_CHANGED/);
    assert.match(await fs.readFile(f.patch, 'utf8'), /disabled: false/);
  } finally { await f.cleanup(); }
});
