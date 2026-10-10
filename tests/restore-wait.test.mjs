import test from 'node:test';
import assert from 'node:assert/strict';
import { startRestoreMonitor, restoreText } from '../code/restore.js';
test('normal report uses approved concise format and only success plan', () => {
  const text = restoreText({ phase: 'ready', details: { requestId: 'req', pluginName: 'example-plugin', report: {
    completed: ['已提交方案'], successPlan: ['确认就绪', '完成业务测试'], failurePlan: ['修复失败原因'],
  } } });
  assert.match(text, /使用 restart skill 提交的重启申请已执行完毕/);
  assert.match(text, /【重启原因】\nexample-plugin 插件需要重启后验证。/);
  assert.match(text, /【重启结果】\n一次性重启成功。/);
  assert.match(text, /【需核对事项】\n1. 确认就绪\n2. 完成业务测试/);
  assert.doesNotMatch(text, /修复失败原因/);
});
test('rescued report uses failure plan and oral-user reason', () => {
  const text = restoreText({ phase: 'recovered', details: { requestId: 'req', disabledPlugin: 'example-plugin', report: {
    reasonType: 'user', successPlan: ['业务成功检查'], failurePlan: ['检查失败原因，并修复插件。'],
  } } });
  assert.match(text, /用户口头要求重启/);
  assert.match(text, /首次重启失败，停止加载 example-plugin 插件后重启成功/);
  assert.match(text, /检查失败原因，并修复插件/);
  assert.doesNotMatch(text, /业务成功检查/);
});
test('overlong handoff is dropped during activation', () => {
  assert.doesNotMatch(restoreText({ phase: 'ready', details: { requestId: 'r', pluginName: 'p', report: { handoff: 'x'.repeat(201) } } }), /交接/);
});
test('startup/recovery phases never admit a session prompt', async () => {
  let prompts = 0, claims = 0, reads = 0, finish;
  const done = new Promise(r => { finish = r; });
  const stop = startRestoreMonitor({ status: async () => {
    reads++; if (reads === 3) finish();
    return { daemon: { phase: reads === 1 ? 'starting' : 'recovery', details: { requestId: 'req', sessionId: 's' } } };
  }, claim: async () => { claims++; }, controller: { prompt: async () => { prompts++; } }, log: () => {}, intervalMs: 1, maxTicks: 3 });
  await done; stop(); assert.equal(prompts, 0); assert.equal(claims, 0);
});
test('disposed monitor cannot claim or deliver after delayed status', async () => {
  let resolve, claims = 0, prompts = 0;
  const pending = new Promise(r => { resolve = r; });
  const stop = startRestoreMonitor({ status: () => pending, claim: async () => { claims++; }, controller: { prompt: async () => { prompts++; } }, log: () => {} });
  stop(); resolve({ daemon: { phase: 'ready', details: { requestId: 'r', sessionId: 's' } } });
  await new Promise(r => setImmediate(r)); assert.equal(claims, 0); assert.equal(prompts, 0);
});
test('disposed monitor cannot deliver after delayed claim', async () => {
  let resolve, claimed, prompts = 0;
  const entered = new Promise(r => { claimed = r; });
  const pending = new Promise(r => { resolve = r; });
  const notice = { phase: 'ready', details: { requestId: 'r', sessionId: 's' } };
  const stop = startRestoreMonitor({ status: async () => ({ daemon: notice }), claim: () => { claimed(); return pending; }, controller: { prompt: async () => { prompts++; } }, log: () => {} });
  await entered; stop(); resolve({ status: notice });
  await new Promise(r => setImmediate(r)); assert.equal(prompts, 0);
});
