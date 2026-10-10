// Windows 平台接缝的纯函数测试。
//
// 表里的命令行是**本机实测抓到的真实 argv**（2026-10-09，pid 为当时观测值）。
// 其中 pid 36596 的 `dsh-subprocess-local\lib\runner.js` 形式是最危险的一条：
// 它既没有 `--type=` 也没有 `--expose-internals`，用"映像名相同就当 App"的规则
// 会把它判成第二个 App 实例 → AMBIGUOUS_INSTANCE 或误杀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHealthPort, discoverTargets, discoverWindowsTargets } from '../code/daemon/runtime.mjs';
import { ipcPath, classifyWindowsRow, parseCsvLine, supervisorTaskXml, hiddenLauncherVbs,
  resolveWindowsInterpreter, WIN_TASK_NAME } from '../code/platform.mjs';

const EXE = 'D:\\DeepSeek Harness\\DeepSeek Harness.exe';
const HOME = 'C:\\Users\\Administrator\\.dsh';
const PROFILE = `${HOME}\\profiles\\desktop`;
const RUNTIME = 'D:\\DeepSeek Harness\\resources\\runtime';

const rows = [
  { pid: 12472, ppid: 800, name: 'DeepSeek Harness.exe', command: `"${EXE}" ` },
  { pid: 24856, ppid: 12472, name: 'DeepSeek Harness.exe', command: `"${EXE}" --expose-internals "D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js" "D:\\DeepSeek Harness\\resources\\app.asar\\dsh" ${PROFILE} "${RUNTIME}\\primary-runtime" "D:\\DeepSeek Harness\\resources\\pnpm\\bin\\pnpm.mjs" "${RUNTIME}\\bin"` },
  { pid: 21668, ppid: 12472, name: 'DeepSeek Harness.exe', command: `"${EXE}" --type=gpu-process --user-data-dir="C:\\Users\\Administrator\\AppData\\Roaming\\@deepseek-ai/dsh-desktop"` },
  { pid: 35704, ppid: 12472, name: 'DeepSeek Harness.exe', command: `"${EXE}" --type=utility --utility-sub-type=network.mojom.NetworkService --lang=zh-CN` },
  { pid: 30272, ppid: 12472, name: 'DeepSeek Harness.exe', command: `"${EXE}" --type=renderer --app-path="D:\\DeepSeek Harness\\resources\\app.asar"` },
  { pid: 36596, ppid: 12472, name: 'DeepSeek Harness.exe', command: `"${EXE}" "D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js" -- powershell.exe -NoLogo` },
  { pid: 40000, ppid: 800, name: 'DeepSeek Harness.exe', command: `"${EXE}-spoof"` },
];

test('Windows 分类：App 主进程（含同名前缀映像）与桌面宿主；Electron 子进程与 CLI runner 排除', () => {
  const found = discoverWindowsTargets(rows, PROFILE);
  // 40000 是 `DeepSeek Harness.exe-spoof`：按与 macOS 相同的"名字前缀命中"语义，它**算同一个 App**（刻意，2026-10-10 确认）。
  assert.deepEqual(found.app.map((row) => row.pid), [12472, 40000]);
  assert.deepEqual(found.host.map((row) => row.pid), [24856]);
  assert.equal(found.app[0].executable, EXE);            // 含空格路径必须完整取出
  assert.deepEqual(found.app[0].args, []);               // 实测 App 主进程零参数
  assert.equal(found.host[0].startTime, '');              // CIM 未提供时不做假定
});

test('Windows 分类：其它 profile 的宿主不算本实例', () => {
  const other = { pid: 50000, ppid: 1, name: 'DeepSeek Harness.exe', command: `"${EXE}" --expose-internals "…\\dsh-desktop-host\\lib\\index.js" "D:\\DeepSeek Harness\\resources\\app.asar\\dsh" C:\\Other\\profiles\\desktop` };
  assert.equal(classifyWindowsRow(other, { profileDir: PROFILE }).type, 'none');
});

test('discoverTargets 按平台分发：win32 用 CIM 规则，darwin 缺省行为不变', () => {
  assert.deepEqual(discoverTargets(rows, { home: HOME, platform: 'win32' }).app.map((row) => row.pid), [12472, 40000]);
  // darwin 规则认的是 `.app/Contents/MacOS`，对 Windows 命令行应当什么都认不出来（安全的失败方向）。
  assert.deepEqual(discoverTargets(rows, { home: HOME, platform: 'darwin' }), { host: [], app: [] });
});

test('IPC 端点按平台选择：管道名与用户/DSH_HOME 绑定', () => {
  assert.equal(ipcPath('/h', 'darwin'), '/h/instance-manager/daemon.sock');
  const pipe = ipcPath(HOME, 'win32');
  assert.match(pipe, /^\\\\\.\\pipe\\dsh-instance-manager-[0-9a-f]{16}$/);
  assert.equal(pipe, ipcPath(HOME, 'win32'), '同一输入必须得到同一条管道名');
  assert.notEqual(pipe, ipcPath('C:\\Other\\.dsh', 'win32'));
});

test('健康端口不写死：显式参数 > 环境变量 > 默认 19387', () => {
  const before = process.env.DSH_INSTANCE_MANAGER_WEB_PORT;
  try {
    assert.equal(resolveHealthPort(29999, HOME), 29999);
    process.env.DSH_INSTANCE_MANAGER_WEB_PORT = '23456';
    assert.equal(resolveHealthPort(undefined, HOME), 23456);
    delete process.env.DSH_INSTANCE_MANAGER_WEB_PORT;
    assert.equal(resolveHealthPort(undefined, 'C:\\definitely-not-a-home'), 19387);
  } finally {
    if (before === undefined) delete process.env.DSH_INSTANCE_MANAGER_WEB_PORT;
    else process.env.DSH_INSTANCE_MANAGER_WEB_PORT = before;
  }
});

test('计划任务 XML 必须显式关掉会咬人的默认值', () => {
  const xml = supervisorTaskXml({ vbsPath: 'C:\\x\\launch.vbs', taskName: WIN_TASK_NAME });
  for (const needle of ['<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>',
    '<LogonTrigger>', '<RunLevel>LeastPrivilege</RunLevel>', 'wscript.exe']) {
    assert.ok(xml.includes(needle), `缺少 ${needle}`);
  }
});

test('启动包装：批处理文件承载引用，wscript 只负责隐藏窗口', async () => {
  const { daemonCommandFile } = await import('../code/platform.mjs');
  const nodeCmd = daemonCommandFile({ interpreter: { kind: 'node', path: 'C:\\Program Files\\nodejs\\node.exe' }, runnerPath: 'C:\\r.mjs', logPath: 'C:\\o.log' });
  assert.ok(nodeCmd.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\r.mjs" 1>>"C:\\o.log" 2>&1'));
  assert.ok(!nodeCmd.includes('ELECTRON_RUN_AS_NODE'));
  const electronCmd = daemonCommandFile({ interpreter: { kind: 'electron-as-node', path: 'C:\\app.exe' }, runnerPath: 'C:\\r.mjs', logPath: 'C:\\o.log' });
  assert.ok(electronCmd.includes('set "ELECTRON_RUN_AS_NODE=1"'), 'Electron 当 node 时必须显式设置（manager 的 cleanEnvironment 正会删掉它）');

  const vbs = hiddenLauncherVbs({ cmdPath: 'C:\\x\\run-daemon.cmd' });
  // 关键：vbs 只调用 .cmd 文件；**不能**内联 `cmd /c "prog" "arg" >> log`
  // （路径含空格时 cmd 会吃掉重定向——本机实测该形式起不来进程）。
  assert.ok(vbs.includes('sh.Run'));
  assert.ok(vbs.includes('run-daemon.cmd'));
  assert.ok(!vbs.includes('>>'), 'vbs 里不应出现内联重定向');
  assert.ok(vbs.includes('0, False'), '必须隐藏窗口');
});

test('解释器解析：优先真正的 node，绝不落到不存在的 shim 路径', async () => {
  const found = await resolveWindowsInterpreter({ execPath: 'D:\\DeepSeek Harness\\DeepSeek Harness.exe' });
  assert.ok(['node', 'electron-as-node'].includes(found.kind));
  if (found.kind === 'node') assert.match(found.path, /node\.exe$/i);
  assert.ok(!found.path.includes('resources\\runtime\\bin\\node.exe'), 'resources\\runtime\\bin 下只有 shim，不是解释器');
});

test('计划任务带保活看门狗（RestartOnFailure 拉不回被杀的 daemon）', () => {
  const xml = supervisorTaskXml({ vbsPath: 'C:\\x\\launch.vbs' });
  // 实测：daemon 被外部杀死后，RestartOnFailure 不会触发（任务动作 wscript 早已退出 0）。
  // 保活只能靠这个重复触发器定期重跑 launch.vbs；daemon 自身 ALREADY_RUNNING → 退出 0，幂等。
  assert.ok(xml.includes('<Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>'),
    '缺少每 5 分钟的保活重复触发器');
  assert.ok(xml.indexOf('<TimeTrigger>') < xml.indexOf('<LogonTrigger>'),
    'TimeTrigger 必须排在 LogonTrigger 之前（任务计划 schema 的顺序要求）');
  assert.ok(supervisorTaskXml({ vbsPath: 'C:\\x\\launch.vbs', keepAliveInterval: 'PT1M' }).includes('<Interval>PT1M</Interval>'),
    '保活间隔应当可注入，便于测试与按需收紧');
});

test('CIM CSV 解析：命令行含逗号、空格与引号也不能被切断', () => {
  const line = '"1","2","node.exe","C:\\Program Files\\nodejs\\node.exe" "D:\\a,b\\runner.mjs","20261009120000.000000+480"';
  const fields = parseCsvLine(line);
  assert.equal(fields.length, 5);
  assert.equal(fields[3], 'C:\\Program Files\\nodejs\\node.exe D:\\a,b\\runner.mjs');
  assert.equal(fields[4], '20261009120000.000000+480');
});
