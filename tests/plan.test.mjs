import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planPath, validatePlan, writePlan, readPlan, consumePlan, removeClaimed } from '../code/daemon/plan.mjs';
import { disablePluginInProfile } from '../code/daemon/runtime.mjs';

const plan = () => ({ version: 1, requestId: 'restart-test-1234', pluginName: 'example-plugin',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });

test('restart plan is strict, private, atomic and one-shot', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plan-test-'));
  try {
    assert.equal(validatePlan(plan()).pluginName, 'example-plugin');
    await writePlan(home, plan());
    // Windows 没有 POSIX 私有权（mode 恒 0o666，本机实测）：显式断言"降级事实"，而不是跳过断言。
    const planMode = (await fs.stat(planPath(home))).mode & 0o777;
    assert.equal(planMode, process.platform === 'win32' ? 0o666 : 0o600);
    const read = await readPlan(home);
    assert.equal(read.requestId, 'restart-test-1234');
    const claimed = await consumePlan(home, read.requestId);
    assert.equal(claimed.plan.requestId, read.requestId);
    assert.equal(await readPlan(home), null);
    await removeClaimed(claimed.path);
    await assert.rejects(() => writePlan(home, { ...plan(), pluginName: 'bad name' }), /pluginName/);
    await assert.rejects(() => writePlan(home, { ...plan(), report: { handoff: 'x'.repeat(201) } }), /报告文本过长/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('rescue removes exactly one matching plugin insert block', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-rescue-test-'));
  try {
    const profile = path.join(home, 'profiles', 'desktop');
    await fs.mkdir(profile, { recursive: true });
    const file = path.join(profile, 'cordis.patch.yml');
    await fs.writeFile(file, '- insert:\n    - id: keep\n      name: keep\n    - id: example-plugin\n      name: example-plugin\n    - id: other\n      name: other\n', { mode: 0o600 });
    const result = await disablePluginInProfile(home, 'example-plugin');
    assert.equal(result.pluginName, 'example-plugin');
    assert.match(await fs.readFile(file, 'utf8'), /id: keep/);
    assert.match(await fs.readFile(file, 'utf8'), /id: example-plugin\n      disabled: true\n      name: example-plugin/);
    assert.match(await fs.readFile(file, 'utf8'), /id: other/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
