import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../code/tools.js', import.meta.url), 'utf8');
function fixture(policy, decision = 'allowed-once') {
  const stats = { asks: 0, preflights: 0, prepared: [], submitted: [], concluded: 0 };
  const timers = [];
  let nextId = 0;
  const context = vm.createContext({ randomUUID: () => `test-request-${++nextId}`, Date, setTimeout: (fn, ms) => { assert.equal(ms, 1200); timers.push(fn); } });
  vm.runInContext(source.replace(/^import .*\n/, '').replace('export function restartTool', 'function restartTool'), context);
  const session = {};
  const approval = { effectivePolicy: s => { assert.equal(s, session); return policy; }, request: async () => { stats.asks++; return decision; } };
  const tool = context.restartTool({ approval, controller: { inspect: async () => ({ meta: { id: 'main' } }) }, manager: {
    status: async () => ({ ok: true }), preflight: async () => { stats.preflights++; return { ok: true }; },
    prepareRestart: async plan => { stats.prepared.push(plan); return { ok: true, plan }; },
    requestPreparedRestart: async id => { stats.submitted.push(id); return { ok: true }; },
  } });
  const exec = { agent: { id: 'main', session }, callId: 'call', signal: new AbortController().signal, concludeTurn: () => { stats.concluded++; } };
  return { stats, timers, tool, exec, approval };
}
test('never never asks; repeated calls in same session have no one-shot approval cap', async () => {
  const f = fixture('never', 'rejected');
  for (let i = 0; i < 2; i++) {
    const r = await f.tool.execute({ action: 'restart', pluginName: 'sample', resumeSession: true }, f.exec);
    assert.equal(r.ok, true); assert.equal(r.phase, 'waiting-for-idle');
    assert.equal(f.stats.prepared[i].sessionId, 'main');
    f.timers.shift()(); await Promise.resolve();
  }
  assert.equal(f.stats.asks, 0); assert.equal(f.stats.submitted.length, 2);
  assert.equal(f.stats.concluded, 2); assert.equal(f.stats.preflights, 2);
});
test('ask still asks and rejects without preparing or submitting', async () => {
  const f = fixture('ask', 'rejected');
  const r = await f.tool.execute({ action: 'restart', pluginName: 'sample' }, f.exec);
  assert.equal(r.ok, false); assert.equal(f.stats.asks, 1);
  assert.equal(f.stats.prepared.length, 0); assert.equal(f.timers.length, 0);
});
test('ask allow still keeps deferred submission and continuation', async () => {
  const f = fixture('ask'); await f.tool.execute({ action: 'restart', pluginName: 'sample', resumeSession: true }, f.exec);
  assert.equal(f.stats.asks, 1); assert.equal(f.stats.submitted.length, 0);
  f.timers.shift()(); await Promise.resolve(); assert.equal(f.stats.submitted.length, 1);
});
test('missing policy reader falls back to normal approval, never silently permits', async () => {
  const f = fixture('never', 'rejected'); delete f.approval.effectivePolicy;
  assert.equal((await f.tool.execute({ action: 'restart', pluginName: 'sample' }, f.exec)).ok, false);
  assert.equal(f.stats.asks, 1);
});
test('aborted never call and unexpected fields never prepare a plan', async () => {
  const f = fixture('never'); const c = new AbortController(); c.abort();
  await assert.rejects(f.tool.execute({ action: 'restart', pluginName: 'sample' }, { ...f.exec, signal: c.signal }));
  await assert.rejects(f.tool.execute({ action: 'restart', pluginName: 'sample', command: 'bad' }, f.exec));
  assert.equal(f.stats.prepared.length, 0); assert.equal(f.stats.asks, 0);
});
