import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preflight, prepareRestart } from '../code/manager.js';
test('unavailable daemon refuses plan before writing any file', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-preflight-'));
  try {
    await assert.rejects(preflight('sample', { home }), /后台不可用/);
    await assert.rejects(prepareRestart({ pluginName: 'sample' }, { home }), /后台不可用/);
    await assert.rejects(fs.access(path.join(home, 'instance-manager', 'restart-plan.json')));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
