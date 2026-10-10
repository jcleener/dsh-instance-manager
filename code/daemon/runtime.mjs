import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { isWindows, assertOwnedFile, hardenPath, listWindowsProcesses, classifyWindowsRow,
  normalizeWinCommand, killWindows, spawnDetached, isAliveWindows, defaultHome } from '../platform.mjs';
const execFile = promisify(callback);
export const APP_PATH = '/Applications/DeepSeek Harness.app';
/** App 的可执行文件名与 bundle 标识：**不依赖安装路径**，实例可能从挂载卷启动。 */
export const APP_NAME = 'DeepSeek Harness';
export const DEFAULT_BUNDLE_ID = 'com.deepseek.dsh';
const APP_PATH_ENV = 'DSH_INSTANCE_MANAGER_APP_PATH';
/** 目标 App 的实际路径：优先用启动方登记的路径，否则回退 /Applications。 */
export function resolveAppPath(explicit) {
  const candidate = explicit || process.env[APP_PATH_ENV] || '';
  if (candidate && candidate.endsWith('.app')) return candidate;
  return APP_PATH;
}
/** 目标 App 的 bundle 标识（用于 `/usr/bin/open -b`，与安装路径无关）。 */
export function resolveBundleId(explicit) {
  return explicit || process.env.DSH_INSTANCE_MANAGER_BUNDLE_ID || DEFAULT_BUNDLE_ID;
}
export const MAIN_EXECUTABLE = `${APP_PATH}/Contents/MacOS/${APP_NAME}`;
export const HOST_SCRIPT = `${APP_PATH}/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`;
const HOST_SCRIPT_SUFFIX = '/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js';
/** 归一化 `ps` 命令行：可执行路径去引号，便于按 basename 与参数特征匹配。 */
function normalizeCommand(command) {
  return String(command).replace(/"([^"]+)"/g, '$1');
}
/**
 * 命中命令行里的目标 App 可执行文件（/Applications 与挂载卷都算）。
 *
 * ⚠️ 匹配是**名字前缀命中、不做结尾校验**：`…/MacOS/DeepSeek Harness-spoof` 也算同一个 App。
 * 这是**原有语义，而且是刻意的**（用户 2026-10-10 明确确认）。2026-10-09 做 Windows 移植时，
 * 我曾为了迁就一条老测试断言（"spoof 不该算 app"）在这里加了结尾校验 —— 那等于**改了 macOS 行为**，
 * 违反"macOS 语义不变"的要求，现已回退。要改这条语义必须先问 owner，不要用测试断言倒逼代码。
 */
function appExecutableOf(command) {
  const text = normalizeCommand(command);
  const marker = `/Contents/MacOS/${APP_NAME}`;
  const at = text.indexOf(marker);
  return at < 0 ? null : { executable: text.slice(0, at + marker.length), text };
}
/** 命中 macOS `.app` 包路径，供实际启动使用。 */
function appBundleOf(executable) {
  const marker = '.app/Contents/MacOS/';
  const at = executable.indexOf(marker);
  return at < 0 ? null : executable.slice(0, at + '.app'.length);
}
/**
 * 按**可执行文件名 + 命令行特征**识别 App 与宿主，不再要求 App 装在 /Applications。
 * 运行中的实例可能来自任意挂载卷（本机出现过从 DMG 启动）：路径写死会让扫描结果为空
 * → 后台"找不到要停的实例" → 端口仍健康 → PORT_OCCUPIED 拒绝重启。
 */
/** 平台分发：darwin 用 ps + `.app` 特征；win32 用 CIM 行 + 映像名/argv 特征。 */
export function discoverTargets(processes, { home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), platform = 'darwin' } = {}) {
  if (platform === 'win32') return discoverWindowsTargets(processes, path.join(home, 'profiles', 'desktop'));
  return discoverDarwinTargets(processes, { home });
}
/**
 * Windows 分类。本机实测同时存在：App 主进程（**只有 exe、零参数**）、桌面宿主
 * （`--expose-internals` + `dsh-desktop-host\lib\index.js` + profileDir）、4 个 Electron
 * 子进程（`--type=*`），以及一个**极易误判**的 `dsh-subprocess-local\lib\runner.js` 形式
 * （无 `--type=`、无 `--expose-internals`）。误判的后果是 AMBIGUOUS_INSTANCE 或误杀。
 */
export function discoverWindowsTargets(processes, profileDir) {
  const host = [], app = [];
  const seen = new Set();
  for (const row of processes) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 1 || typeof row.command !== 'string') continue;
    const hit = classifyWindowsRow(row, { profileDir });
    if (hit.type === 'none' || seen.has(row.pid)) continue;
    seen.add(row.pid);
    const entry = { pid: row.pid, ppid: row.ppid, command: normalizeWinCommand(row.command),
      executable: hit.executable, startTime: row.startTime ?? '' };
    if (hit.type === 'host') host.push(entry);
    else app.push({ ...entry, args: hit.args ?? [] });
  }
  return { host, app };
}
export function discoverDarwinTargets(processes, { home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh') } = {}) {
  const rows = processes.filter(row => Number.isSafeInteger(row.pid) && row.pid > 1 && typeof row.command === 'string');
  const profileDir = path.join(home, 'profiles', 'desktop');
  // 分隔符不敏感：`ps` 输出永远是 POSIX 路径，而在 Windows 上跑这套断言时
  // path.join 会给反斜杠；两者都要能命中，否则"其它 profile 的宿主"会被误判成实例。
  const profileNeedles = [...new Set([profileDir, profileDir.replace(/\\/g, '/'), profileDir.replace(/\//g, '\\')])];
  const app = [], host = [];
  const seenApp = new Set(), seenHost = new Set();
  for (const row of rows) {
    const command = normalizeCommand(row.command);
    const hit = appExecutableOf(command);
    if (hit === null) continue;
    const isHost = command.includes(' --expose-internals ') && command.includes(HOST_SCRIPT_SUFFIX)
      && profileNeedles.some((needle) => command.includes(` ${needle} `) || command.includes(`"${needle}"`) || command.includes(` ${needle}`));
    if (isHost) {
      if (!seenHost.has(row.pid)) { seenHost.add(row.pid); host.push({ ...row, command }); }
      continue;
    }
    if (command.includes(' --expose-internals ') || command.includes(HOST_SCRIPT_SUFFIX)) continue;
    // Electron 的 Helper / Helper (Renderer) / Helper (GPU) 在 Frameworks 下叫同一个
    // 可执行名：它们不是实例，必须排除，否则会被判成"多个 App 同时在跑"。
    if (hit.text.includes('/Contents/Frameworks/')) continue;
    if (!seenApp.has(row.pid)) { seenApp.add(row.pid); app.push({ ...row, command, executable: hit.executable, bundle: appBundleOf(hit.executable) }); }
  }
  return { host, app };
}
export function parsePs(output) {
  return output.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
}
function probeHttp(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 1200, agent: false,
      headers: { connection: 'close' } }, res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); });
    req.once('timeout', () => req.destroy()); req.once('error', () => resolve(false));
  });
}
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function scalar(text) {
  const m = /^(?:([A-Za-z0-9@._/-]+)|"([A-Za-z0-9@._/-]+)"|'([A-Za-z0-9@._/-]+)')\s*(?:#.*)?$/.exec(text);
  return m ? m[1] || m[2] || m[3] : null;
}
// Deliberately only supports the known desktop patch's block lists. Unsupported
// YAML is rejected, never evaluated or rewritten wholesale. All config bytes stay.
function locate(original, pluginName) {
  if (typeof pluginName !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pluginName) || pluginName.startsWith('@deepseek-ai/')) throw new Error('INVALID_PLUGIN_NAME');
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) || [];
  const entries = [], overrides = [];
  let inInsert = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, '');
    if (/^- insert:\s*(?:#.*)?$/.test(line)) { inInsert = true; continue; }
    if (/^- /.test(line)) inInsert = false;
    let m;
    if (inInsert && (m = /^    - id: (.+)$/.exec(line))) {
      const id = scalar(m[1]);
      const next = lines.findIndex((l, j) => j > i && (/^    - /.test(l) || /^- /.test(l)));
      const stop = next < 0 ? lines.length : next;
      const names = lines.slice(i + 1, stop).filter(l => /^      name: /.test(l));
      if (names.length === 1) entries.push({ id, name: scalar(names[0].replace(/^      name: /, '').trim()), start: i, stop, indent: 6 });
    } else if ((m = /^- id: (.+)$/.exec(line))) {
      const next = lines.findIndex((l, j) => j > i && /^- /.test(l));
      overrides.push({ id: scalar(m[1]), start: i, stop: next < 0 ? lines.length : next, indent: 2 });
    }
  }
  const found = entries.filter(e => e.name === pluginName);
  if (found.length !== 1 || !found[0].id) throw new Error(found.length > 1 ? 'AMBIGUOUS_PLUGIN_ENTRY' : 'PLUGIN_ENTRY_NOT_FOUND');
  const entry = found[0];
  const targets = [entry, ...overrides.filter(e => e.id === entry.id)];
  for (const target of targets) {
    const prefix = ' '.repeat(target.indent);
    const names = lines.slice(target.start + 1, target.stop).filter(l => l.startsWith(`${prefix}name: `));
    if (names.some(l => scalar(l.replace(`${prefix}name: `, '').trim()) !== pluginName)) throw new Error('PLUGIN_OVERRIDE_MISMATCH');
    const flags = lines.slice(target.start + 1, target.stop).filter(l => l.startsWith(`${prefix}disabled:`));
    if (flags.length > 1 || flags.some(l => !new RegExp(`^${prefix}disabled: (?:true|false)\\s*(?:#.*)?$`).test(l.trimEnd()))) throw new Error('UNSUPPORTED_DISABLED_VALUE');
  }
  return { lines, entry, targets };
}
async function patch(home) {
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const stat = await fs.lstat(file);
  assertOwnedFile(stat, { message: 'UNSAFE_PROFILE_PATCH' });
  const original = await fs.readFile(file, 'utf8');
  return { file, stat, original, hash: digest(original) };
}
export async function preflightPlugin(home, pluginName) {
  const p = await patch(home);
  const parsed = locate(p.original, pluginName);
  return { pluginName, id: parsed.entry.id, patchHash: p.hash };
}
export async function disablePluginInProfile(home, pluginName, expectedHash) {
  const p = await patch(home);
  if (expectedHash && p.hash !== expectedHash) throw new Error('PROFILE_PATCH_CHANGED');
  const { lines, targets } = locate(p.original, pluginName);
  const newline = p.original.includes('\r\n') ? '\r\n' : '\n';
  for (const t of targets.sort((a, b) => b.start - a.start)) {
    const prefix = ' '.repeat(t.indent);
    const flag = lines.findIndex((l, i) => i > t.start && i < t.stop && l.startsWith(`${prefix}disabled:`));
    if (flag >= 0) lines[flag] = `${prefix}disabled: true${newline}`;
    else lines.splice(t.start + 1, 0, `${prefix}disabled: true${newline}`);
  }
  const next = lines.join('');
  // Re-read the generated target structure, not unrelated settings.
  locate(next, pluginName);
  const temp = `${p.file}.rescue-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(temp, next, { mode: isWindows ? undefined : (p.stat.mode & 0o777), flag: 'wx' });
    if (await fs.readFile(p.file, 'utf8') !== p.original) throw new Error('PROFILE_PATCH_CHANGED');
    await renameWithRetry(temp, p.file);
  } finally { await fs.rm(temp, { force: true }); }
  return { pluginName, beforeHash: p.hash, afterHash: digest(next), disabled: true };
}
/** Windows 上目标被短暂占用会 EPERM/EBUSY：替换做有限重试，语义不变（仍然是"先校验再覆盖"）。 */
async function renameWithRetry(from, to, attempts = 5, delayMs = 60) {
  for (let i = 1; ; i++) {
    try { await fs.rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || i >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
export async function profilePatchHash(home) { return (await patch(home)).hash; }
export function createSystemAdapter({ port, home = defaultHome(), bundleId, appPath } = {}) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid health port');
  const healthPort = resolveHealthPort(port, home);
  // Windows 上每次列进程都要 spawn PowerShell（实测 305-380ms），而核心轮询是 250ms 级：
  // 必须缓存 + 廉价活性复核，否则一次重启会 spawn 上百个 PowerShell。
  const winScan = createLivenessCache(listWindowsProcesses);
  return {
    now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async listProcesses() {
      if (isWindows) return winScan.list();
      const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      return parsePs(stdout);
    },
    signal(pid, signal) {
      if (isWindows) { winScan.invalidate(); return killWindows(pid, signal); }
      return process.kill(pid, signal);
    },
    async launch(target = {}) {
      if (isWindows) { winScan.invalidate(); return launchWindowsApp(target, home); }
      const env = { HOME: process.env.HOME || '', USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp/', DSH_HOME: home };
      // 先按 bundle 标识启动：与 App 装在哪里无关（/Applications、挂载卷、任意目录都能命中）。
      // 只有 bundle 解析不到时才回退按路径启动，避免"启动的 App 与实际运行的实例不是同一份"。
      const id = resolveBundleId(target.bundleId ?? bundleId);
      try {
        await execFile('/usr/bin/open', ['-b', id], { env, timeout: 10000, maxBuffer: 1024 * 1024 });
        return;
      } catch (error) {
        if (!id) throw error;
        const fallbackPath = resolveAppPath(target.appPath ?? appPath);
        try {
          await execFile('/usr/bin/open', ['-a', fallbackPath], { env, timeout: 10000, maxBuffer: 1024 * 1024 });
        } catch (fallbackError) {
          throw new Error(`启动 App 失败：bundle "${id}"（${error.message}），路径 "${fallbackPath}"（${fallbackError.message}）`);
        }
      }
    },
    health: () => probeHttp(healthPort), profilePatchHash: () => profilePatchHash(home),
    disablePlugin: (name, hash) => disablePluginInProfile(home, name, hash),
  };
}

/**
 * 健康端口不再写死 19387：桌面版端口可能变，别的本地服务也可能占用该端口
 * （会造成假就绪或假 PORT_OCCUPIED）。优先级：显式参数 → 环境变量 → runtime.json → 19387。
 */
export function resolveHealthPort(explicit, home = defaultHome()) {
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const fromEnv = Number(process.env.DSH_INSTANCE_MANAGER_WEB_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const url = new URL(process.env.DSH_WEB_URL || '');
    const fromUrl = Number(url.port);
    if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
  } catch { /* 未设置或非法 URL */ }
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'instance-manager', 'runtime.json'), 'utf8'));
    if (Number.isInteger(raw.port) && raw.port > 0) return raw.port;
  } catch { /* 未落盘 */ }
  return 19387;
}

/** 缓存 + 活性复核：活着的进程 argv 不会变，因此 TTL 内复用安全；signal/launch 后强制失效。 */
export function createLivenessCache(loader, ttlMs = 1200) {
  let rows = null, at = 0;
  return {
    invalidate() { rows = null; at = 0; },
    async list() {
      if (rows !== null && Date.now() - at < ttlMs && rows.every(row => isAliveWindows(row.pid))) return rows;
      rows = await loader();
      at = Date.now();
      return rows;
    },
  };
}

/** 用**被停掉那个实例自己的**可执行文件与 argv 重新拉起（不写死安装路径）。 */
export function launchWindowsApp(target, home = defaultHome()) {
  const env = { ...process.env, DSH_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 App 会以 Node 模式启动，开不出窗口
  delete env.NODE_OPTIONS;
  const executable = target.executable || process.env.DSH_INSTANCE_MANAGER_APP_PATH;
  if (!executable) throw new Error('没有可用于启动的可执行文件路径');
  return spawnDetached(executable, target.args ?? [], { cwd: path.dirname(executable), env });
}
