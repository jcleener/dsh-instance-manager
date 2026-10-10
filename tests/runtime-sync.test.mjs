// 运行副本比对：这条测试是为了钉死 2026-10-10 实测到的 Windows bug——
// 运行副本布局是 `runtime/daemon-<哈希>/daemon/*.mjs`，比 macOS 多一层 `daemon/`。
// 旧代码少拼这一层 → 永远读不到副本文件 → 永远判定"有差异"：
//   ① 每次 apply 都白重装（host.log 里 `daemon-runtime-synced` 恒出现，`changed` 失去意义）；
//   ② 重装后 start 撞上 ALREADY_RUNNING → 退出 0 → **在跑的 daemon 永远跑旧代码**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeDaemonFileDir, runtimeFilesDiffer } from '../code/manager.js';

test('运行副本比对：Windows 的 daemon/ 子目录层级必须算对', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dim-sync-'));
  try {
    const source = join(root, 'source');
    const winDir = join(root, 'runtime', 'daemon-abc123');
    const macDir = join(root, 'runtime', 'daemon-mac');
    const names = ['runner.mjs', 'runtime.mjs'];
    await mkdir(join(winDir, 'daemon'), { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(macDir, { recursive: true });
    for (const name of names) await writeFile(join(source, name), `// v1 ${name}\n`);

    // macOS：副本目录本身就是文件目录
    assert.equal(runtimeDaemonFileDir(macDir, false), macDir);
    // Windows：文件在 daemon/ 子目录里
    assert.equal(runtimeDaemonFileDir(winDir, true), join(winDir, 'daemon'));
    assert.equal(runtimeDaemonFileDir(null, true), null);

    // 副本还没写 → 有差异
    assert.equal(await runtimeFilesDiffer(source, runtimeDaemonFileDir(winDir, true), names), true);

    // 写上同样的内容 → 无差异。**修复前这一步在 Windows 上恒为 true**（读的是 winDir/runner.mjs）
    for (const name of names) await writeFile(join(winDir, 'daemon', name), `// v1 ${name}\n`);
    assert.equal(await runtimeFilesDiffer(source, runtimeDaemonFileDir(winDir, true), names), false);
    // 把"少拼一层"的错误形态也钉住：它必须判定为有差异（否则就是在静默跑旧代码）
    assert.equal(await runtimeFilesDiffer(source, winDir, names), true);

    // 改一个字节 → 有差异（这才是真正需要停-装-起的那种情况）
    await writeFile(join(source, 'runtime.mjs'), '// v2 runtime.mjs\n');
    assert.equal(await runtimeFilesDiffer(source, runtimeDaemonFileDir(winDir, true), names), true);

    // 缺文件也算差异
    await rm(join(winDir, 'daemon', 'runtime.mjs'));
    assert.equal(await runtimeFilesDiffer(source, runtimeDaemonFileDir(winDir, true), names), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
