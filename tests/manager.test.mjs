import assert from 'node:assert/strict';
import { cleanEnvironment, launchAgentPlist, paths, action } from '../code/manager.js';
const e = cleanEnvironment({ HOME: '/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', NODE_PATH: '/x', DSH_DESKTOP_NODE_EXECUTABLE: '/x', PATH: '/bin' });
assert.deepEqual(e, { HOME: '/x', PATH: '/bin' });
const xml = launchAgentPlist('/a & b/node', '/runtime/runner.mjs', '/user/.dsh/instance-manager');
assert.ok(xml.includes('/a &amp; b/node'));
assert.ok(xml.includes('<key>RunAtLoad</key><true/>'));
assert.ok(xml.includes('<key>KeepAlive</key><true/>'));
assert.ok(!xml.includes('DeepSeek Harness.app'));
// 端点形状按平台显式断言（两条都断言，避免任何一平台"静默通过"）：
// darwin = AF_UNIX 文件；win32 = 命名管道，名字含 DSH_HOME 与用户的摘要。
assert.equal(paths('/h', { platform: 'darwin' }).socket, '/h/instance-manager/daemon.sock');
assert.match(paths('/h', { platform: 'win32' }).socket, /^\\\\\.\\pipe\\dsh-instance-manager-[0-9a-f]{16}$/);
assert.equal(paths('/h').socket, process.platform === 'win32'
  ? paths('/h', { platform: 'win32' }).socket
  : paths('/h', { platform: 'darwin' }).socket);
await assert.rejects(action('arbitrary-shell'), /不支持/);
console.log('manager-contract-ok (no launchctl performed)');
