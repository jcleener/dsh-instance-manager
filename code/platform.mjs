// 平台接缝：POSIX 权限语义、IPC 端点、Windows 进程观测/终止/启动、Windows 自启监管。
//
// 设计约束（与本插件既有不变量一致）：
// 1. darwin 行为必须逐字节不变：本模块只把"平台判定"集中起来，不改 macOS 语义。
// 2. Windows 上**没有** POSIX uid/mode 语义：不承诺 0600/0700，改为结构校验
//    （普通文件 + 非重解析点 + 位于 DSH_HOME 下）。这是**降级**，必须在 README 写明。
// 3. IPC：darwin 用 AF_UNIX 文件，win32 用命名管道。管道没有文件实体，
//    因此"端点是否空闲"只能靠**连接探测**，绝不能用 stat 判断。
// 4. 识别实例只认"可执行文件名 + 命令行特征"，绝不按映像名一律下杀手。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const platformName = process.platform;
export const isWindows = process.platform === 'win32';

// ───────────────────────── POSIX 权限语义（win32 降级） ─────────────────────────

/** 归属校验：win32 上没有可比对的 uid，返回 true 并在文档中声明这是降级。 */
export function sameOwner(stat) {
  if (isWindows) return true;
  return stat.uid === process.getuid();
}

export function assertOwnedDirectory(stat, message = 'Daemon data directory is not owned by this user') {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameOwner(stat)) throw new Error(message);
}

export function assertOwnedFile(stat, { mode, message = 'File is not an owned regular file' } = {}) {
  if (!stat.isFile() || stat.isSymbolicLink() || !sameOwner(stat)) throw new Error(message);
  // mode 断言只在 POSIX 上有意义：Windows 上文件恒为 0o666 / 目录 0o777&~umask。
  if (!isWindows && mode !== undefined && (stat.mode & 0o777) !== mode) throw new Error(message);
}

export async function hardenPath(target, mode) {
  if (isWindows) return;
  await fs.chmod(target, mode);
}

// ───────────────────────── IPC 端点 ─────────────────────────

export const ipcKind = isWindows ? 'pipe' : 'unix';
/** 端点是否由文件系统实体承载（决定"陈旧端点"是否可能、能否 unlink）。 */
export const ipcHasFileEntity = !isWindows;

/** 端点名必须与 DSH_HOME 和用户绑定：`\\.\pipe\` 是全局命名空间，两个用户不能撞名。 */
export function ipcPath(home, platform = process.platform) {
  // POSIX 分支手工拼接：不能用 path.join——在 Windows 上跑 darwin 断言时它会给出反斜杠。
  if (platform !== 'win32') return `${String(home).replace(/[\\/]+$/, '')}/instance-manager/daemon.sock`;
  const user = process.env.USERNAME || process.env.USER || '';
  const digest = crypto.createHash('sha256').update(`${home}\\${user}`).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\dsh-instance-manager-${digest}`;
}

/** 管道无文件实体，无需（也无法）chmod；监听中 unlink 会 EBUSY，故关闭前不做任何事。 */
export async function ipcAfterListen() {}
export async function ipcBeforeClose() {}

// ───────────────────────── Windows 进程观测 ─────────────────────────

const WIN_PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const WIN_APP_BASENAME = 'deepseek harness.exe';

/** CSV 解析：命令行里含逗号与引号（PowerShell 用 "" 转义），不能按逗号裸切。 */
export function parseCsvLine(line) {
  const out = [];
  let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/** 只枚举我们可能关心的映像名：全量 CIM 约 343ms，过滤后约 164ms（实测）。 */
export async function listWindowsProcesses() {
  // 用 `LIKE 'DeepSeek Harness%'` 而不是 `Name='DeepSeek Harness.exe'`：与 macOS 侧"名字前缀命中"的
  // 原有语义对齐 —— 否则 `DeepSeek Harness.exe-spoof` 这类映像名在枚举阶段就被漏掉，
  // "两边同一语义"只是空话（用户 2026-10-10 确认前缀命中是刻意语义）。
  const script = 'Get-CimInstance Win32_Process -Filter "Name LIKE \'DeepSeek Harness%\' or Name=\'node.exe\'" | '
    + 'Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Csv -NoTypeInformation';
  const { stdout } = await exec(WIN_PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('"'));
  const rows = [];
  for (const line of lines) {
    const f = parseCsvLine(line);
    if (f.length < 5) continue;
    const pid = Number(f[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    rows.push({ pid, ppid: Number(f[1]) || 0, name: f[2], command: f[3] || '', startTime: f[4] || '' });
  }
  return rows;
}

/** 归一化：去引号、反斜杠转正斜杠，便于跨分隔符比较。 */
export function normalizeWinCommand(command) {
  return String(command || '').replace(/"/g, '').replace(/\\/g, '/');
}

/** Electron 子进程与 CLI shim 的排除规则（每一条都对应本机实测存在的一类进程）。 */
const WIN_EXCLUDE = ['--type=', '--utility-sub-type=', 'app.asar', 'crashpad', 'dsh-subprocess-local', 'dsh-desktop-host/lib/cli.js'];

export function classifyWindowsRow(row, { profileDir, appBasename = WIN_APP_BASENAME } = {}) {
  const raw = String(row.command || '');
  const command = normalizeWinCommand(raw);
  const lower = command.toLowerCase();
  // 可执行名必须从**原始串**取：App 路径含空格（`D:\DeepSeek Harness\…`），去引号后再按空格切会把路径切碎。
  const quoted = /^\s*"([^"]+)"/.exec(raw);
  const executable = quoted ? quoted[1] : ((command.match(/^([^ ]+\.exe)/i) || [])[1] || '').replace(/\//g, '\\');
  const basename = executable.split(/[\\/]/).pop() || '';
  const profile = normalizeWinCommand(profileDir).toLowerCase();

  if (lower.includes('--expose-internals') && lower.includes('dsh-desktop-host/lib/index.js') && lower.includes(profile)) {
    return { type: 'host', executable, command };
  }
  // 与 macOS 一致：**名字前缀命中**即可（`DeepSeek Harness.exe-spoof` 也算同一个 App），不做结尾校验。
  // 这是刻意语义（用户 2026-10-10 确认），不要用测试断言倒逼收紧。
  if (!basename.toLowerCase().startsWith(appBasename)) return { type: 'none', executable, command };
  if (WIN_EXCLUDE.some((needle) => lower.includes(needle.toLowerCase()))) return { type: 'none', executable, command };
  // App 主进程在本机实测 argv 为空（只有 exe 路径）；其余同映像名进程一律排除。
  const args = raw.trim().replace(/^"[^"]*"\s*/, '').trim();
  if (args.length > 0) return { type: 'none', executable, command };
  return { type: 'app', executable, command, args: [] };
}

/** SIGTERM 在 Windows 上没有信号语义：用 taskkill（不带 /F）尽力让 GUI 走 WM_CLOSE。 */
export async function killWindows(pid, signal) {
  if (signal === 'SIGKILL') {
    try { process.kill(pid, 'SIGKILL'); return; }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
  }
  try {
    await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid)],
      { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const text = `${error.stdout || ''}${error.stderr || ''}`;
    if (/not found|没有找到|找不到/i.test(text)) return;
    // taskkill 对无窗口进程会失败：退回硬杀，语义与 macOS 的 TERM→KILL 阶梯一致。
    try { process.kill(pid, 'SIGKILL'); }
    catch (inner) { if (inner.code !== 'ESRCH') throw inner; }
  }
}

/** 活性探测：Windows 上受保护进程返回 EPERM，那也说明"存在"。 */
export function isAliveWindows(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function spawnDetached(executable, args, { env, cwd } = {}) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd, env });
  child.unref();
  return child.pid;
}

// ───────────────────────── Windows 解释器解析 ─────────────────────────

/**
 * 独立后台必须由**真正的 node** 运行：`resources\runtime\bin\node.exe` 并不存在
 * （那里只有 shim），真正的解释器在 primary-runtime 下。
 */
export async function resolveWindowsInterpreter({ execPath }) {
  const candidates = [];
  const appDir = path.dirname(execPath || '');
  if (appDir) {
    candidates.push(path.join(appDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'));
    candidates.push(path.join(appDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'node.exe'));
  }
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  for (const candidate of candidates) {
    try { await fs.access(candidate); return { kind: 'node', path: candidate }; } catch { /* 下一个 */ }
  }
  // 兜底：拿 Electron exe 当 node 用（必须显式设置 ELECTRON_RUN_AS_NODE，且 daemon 内要清掉它再拉起 App）。
  return { kind: 'electron-as-node', path: execPath };
}

// ───────────────────────── Windows 自启监管（计划任务 + 隐藏包装） ─────────────────────────

export const WIN_TASK_NAME = 'dsh-instance-manager';
const WIN_SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function xmlEscape(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/**
 * 后台启动批处理。**不要把 `prog arg >> log` 直接塞进 `cmd /c` 的内联命令行**：
 * 路径含空格时 cmd 的引号剥离规则会把重定向吃掉（本机实测：日志不生成、进程也起不来）。
 * 写成 .cmd 文件、再由 wscript 隐藏调用，引用才可靠。
 */
export function daemonCommandFile({ interpreter, runnerPath, logPath }) {
  const lines = ['@echo off'];
  if (interpreter.kind === 'electron-as-node') lines.push('set "ELECTRON_RUN_AS_NODE=1"');
  lines.push(`"${interpreter.path}" "${runnerPath}" 1>>"${logPath}" 2>&1`);
  return `${lines.join('\r\n')}\r\n`;
}

/** 隐藏窗口包装：计划任务无法设置窗口样式，必须经 wscript 以样式 0 启动 .cmd。 */
export function hiddenLauncherVbs({ cmdPath }) {
  return ['\' dsh-instance-manager 后台启动器（自动生成，请勿手改）',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${cmdPath}""", 0, False`, ''].join('\r\n');
}

/**
 * 计划任务 XML。四个默认值会咬人，必须显式关掉：
 * ExecutionTimeLimit（默认 72h 会定时杀掉 daemon）、电池两项（笔记本上不启动）、
 * 以及需要 IgnoreNew 防止重复实例。
 *
 * ⚠️ 2026-10-09 实测：`RestartOnFailure` **不能**在 daemon 被外部杀死后把它拉回来——
 * 任务动作是 wscript，它早就以 0 退出，"进程随后被杀"不算任务失败（实测杀掉后 100 秒仍无进程）。
 * 因此额外加一个**每 5 分钟重复**的 TimeTrigger 当看门狗：任务定期重新执行 launch.vbs，
 * 已在跑时 daemon 自身会以 `ALREADY_RUNNING` **退出码 0**（见 runner.mjs），所以是幂等的。
 * 这才与 macOS 的 `KeepAlive` 等价（保活延迟上限 = 5 分钟）。
 * 注意 schema 要求 `<TimeTrigger>` 排在 `<LogonTrigger>` 之前。
 */
export function supervisorTaskXml({ vbsPath, taskName = WIN_TASK_NAME, keepAliveInterval = 'PT5M' }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>dsh-instance-manager background restart executor</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled>
      <Repetition><Interval>${xmlEscape(keepAliveInterval)}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${xmlEscape(vbsPath)}"</Arguments></Exec></Actions>
</Task>
`;
}

export async function createWindowsTask({ xmlPath, taskName = WIN_TASK_NAME }) {
  // schtasks 对编码敏感：任务 XML 写成 UTF-16LE（带 BOM）。
  const xml = await fs.readFile(xmlPath, 'utf8');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  const tmp = `${xmlPath}.utf16`;
  await fs.writeFile(tmp, utf16);
  try {
    await exec(path.join(WIN_SYSTEM32, 'schtasks.exe'), ['/Create', '/XML', tmp, '/TN', taskName, '/F'],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } finally { await fs.rm(tmp, { force: true }); }
}

export async function runWindowsTask(taskName = WIN_TASK_NAME) {
  await exec(path.join(WIN_SYSTEM32, 'schtasks.exe'), ['/Run', '/TN', taskName],
    { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

export async function deleteWindowsTask(taskName = WIN_TASK_NAME) {
  try {
    await exec(path.join(WIN_SYSTEM32, 'schtasks.exe'), ['/Delete', '/TN', taskName, '/F'],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const text = `${error.stdout || ''}${error.stderr || ''}`;
    if (!/cannot find|找不到|没有找到/i.test(text)) throw error;
  }
}

export async function windowsTaskExists(taskName = WIN_TASK_NAME) {
  try {
    await exec(path.join(WIN_SYSTEM32, 'schtasks.exe'), ['/Query', '/TN', taskName],
      { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return true;
  } catch { return false; }
}

/**
 * 兜底启动：经 WMI 创建进程。这样 daemon 的父进程是 WmiPrvSE，
 * 不会落在 DSH App 的 Chromium Job 里（否则 App 一死 daemon 同死，重启就没人拉起 App）。
 */
export async function startViaWmi(commandLine) {
  const script = `$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${JSON.stringify(commandLine)} }; $p.ProcessId`;
  const { stdout } = await exec(WIN_PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return Number(String(stdout).trim()) || 0;
}

export function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
