# DSH Instance Manager · 安全重启与有限救援

> **本插件的工作区布局**（规范见 [plugins/README.md](../README.md)）
>
> - `code/` 运行代码 ｜ `tests/` 测试代码 ｜ `docs/` 开发文档 ｜ `reference/` 参考资料
> - `package.json` / `cordis.patch.yml` / `README.md` / `LICENSE` 是包契约文件，**必须留在本目录根**
> - 状态：**在用（Restart 能力）** ｜ 运行实体：`~/.dsh/profiles/desktop/plugins/dsh-instance-manager/`
> - 本目录是**备份 + 开发文档存放处**，**不在这里开发**：要改代码请改运行实体，验证通过后再回写到这里

## 定位

DSH 中的重启专用子 Agent 负责必要性与时机审查；skill 负责流程；Instance Manager 负责确定性重启、按插件名禁用加载与日志。离线后台不调用 LLM、不执行 Agent 代码，不增加备份流程。

## 使用

在新旧会话里说“使用 restart skill”。插件启动后通过全局 skills 服务注册 `restart`，通过 tools 服务注册 `dsh_restart`。

skill 用 `subagent_fork` 唤起继承上下文的专用重启审查 Agent；它只审查一次并返回结论。原会话使用工具提交，恢复目标绑定原会话：

```json
{"action":"preflight","pluginName":"example-plugin"}
```
```json
{"action":"restart","pluginName":"example-plugin","resumeSession":true}
```

工具生成唯一请求 ID 和十分钟有效期。原会话实际 `approvalPolicy=never` 时不询问，预检与主会话校验通过后直接登记固定重启；`ask` 或无法读取策略时仍通过 DSH 原生审批服务取得授权。此免询问分支不改变其他工具的审批策略，也不取消后台并发锁/失败保护。相同会话完成一次重启后可再次提交，没有一次授权上限。工具只接受 action/pluginName/resumeSession；不接受 PID、路径、命令和自定义提示词。resumeSession=true 仅在成功启动的新 DSH 中发送固定续作消息，可触发原会话正常 LLM；重启和救援期间零 LLM。

## 跨插件接口

Host Service `dshInstanceManager`：`status()`、`preflight(pluginName)`、`prepareRestart(plan)`、`requestPreparedRestart(requestId)`、`requestRestart(plan?)`。可直接传方案一次提交，也可 prepare 后按 requestId 提交。有变更重启传方案；无参数是普通重启，不会消费待执行方案。插件在同一 Host 内不是安全沙箱，Service 只约束传入内容，不能抵御同 UID 任意代码执行。

方案 version=1，只允许 requestId/pluginName/sessionId/createdAt/expiresAt。仅按精确插件 package name 定位，匹配不唯一或结构无法保证时停止；不按行列或模型提供路径执行。

## 后台行为

- macOS 用户级 LaunchAgent：local.dsh.instance-manager，独立于 DSH 存活；启动后台本身不启动 DSH。
- 数据目录：~/.dsh/instance-manager/；私有 socket daemon.sock。
- 单次方案 restart-plan.json 原子提交、领取、消费；重复请求不造成多次执行。
- 发信号前重新验证 PID/argv，实例不唯一拒绝，先 App 后 Host，TERM 超时才 KILL。
- 成功要求新 App、其 Host 子进程及 HTTP 监听就绪。此判定不是目标插件业务验证。
- 新实例启动失败才可救援：确认故障实例退出，校验配置哈希，只把登记插件 entry 及同 ID 的覆盖项设为 disabled:true，保留配置和源码，不触碰模型、密钥和其他插件。最多再启动一次；复杂错误停止。
- 后台中途退出不会无声恢复为空闲，不自动重复救援。
- 所有步骤写 daemon.log；新 DSH 中固定恢复投递写 host.log。日志有请求 ID/时间/阶段/错误，避免完整配置和密钥。
- 恢复通知先在后台原子领取再投递，最多一次；领取后崩溃可能丢失消息，但不重复启动会话任务。投递失败只记录，不重新调用模型诊断。
- Instance Manager 自己加载失败时，仍可由独立后台禁用其加载；但此时 Host 的恢复通知入口不可用，不能承诺自动续作。

## 部署与验收

工作区源码、profile 实际插件副本、独立后台副本是三个位置，必须分别部署并核对哈希。技能随插件打包，不能只留在工作区。

```sh
NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
"$NODE" dsh-instance-manager/bin/manage.mjs status
"$NODE" dsh-instance-manager/bin/manage.mjs logs
# install 更新并启动独立后台，不重启 DSH；restart 才执行整实例重启。
```

测试采用隔离 adapter、临时 profile，不向真实 App 发信号。不把通过单测或部署完成当成新版冷启动验收；用户实际重启后再核实工具、skill、状态及恢复入口。

## 恢复消息的「稳定期计数门」（2026-10-03）

daemon 的 `ready` 判据只是 **HTTP 端口通**（`probeHttp('/')` 返回 200–499），此时新宿主的
插件与技能**仍在注册中**。而 `startRestoreMonitor` 的首次 tick 立即执行，原先一看到 `ready`
就投递恢复消息 —— 结果 agent 拿到的是**残缺的环境快照**（例如技能目录不全），会误判
"插件没加载成功"。此问题在 2026-10-03 的实际重启中真实发生过。

**修复**：发送前要求轮询计数 `ticks > settleTicks`（默认 10，约 10 秒）。

- 门放在 **`claim()` 之前**：`claim` 是提交点，注释明确"claim 后崩溃可能丢消息，但绝不重复"；
  先提交再等待会把崩溃变成**丢消息**。
- `ticks` 是 `startRestoreMonitor` 内的局部计数，而该函数在 `ctx.effect()` 里随每次宿主加载
  新建 —— 因此**每次重启天然从 0 开始**，无需任何持久化或显式重置。
- `settleTicks` 与 `intervalMs` / `maxTicks` 一样是**可注入参数**，便于确定性测试。

**设计上的反直觉点**：不能把就绪判据改成"探测某个插件的路由"——救援场景里被禁用的恰恰
可能就是那个插件，门将永远不开，恢复消息永远发不出去。救援路径的判据必须独立于任何
可能刚被禁掉的插件，所以固定计数是正确选择。

**回归测试**：`node tests/restore-settle.test.mjs`（10 项，含"稳定期内不发送"、
"只发送一次"、"新建 monitor 计数归零"、"非就绪不发送"、"maxTicks 较小时仍能投递"）。

> 全套测试请用：`node --test "tests/*.test.mjs"`（`package.json` 的 `test` 脚本此前只跑了其中一个文件）。

## 平台支持（2026-10-09 · 新增 Windows）

在保持 macOS 路径逐字节不变的前提下，把后台重启执行体做成双平台。Windows 侧的实现与实测结论见
[`docs/WINDOWS-DESIGN.md`](docs/WINDOWS-DESIGN.md)。

| 能力 | macOS（原有） | Windows（本次新增） |
|---|---|---|
| 监管/自启 | LaunchAgent（`RunAtLoad` + `KeepAlive`） | **计划任务**（`LogonTrigger` + 每 5 分钟重复触发器当看门狗 + `IgnoreNew`；`RestartOnFailure` 保留但**不构成保活**，见下） |
| 启动方式 | `launchctl bootstrap` | `schtasks /Run` → WMI 创建 → detached spawn（逐级降级） |
| 隐藏窗口 | 不适用 | `wscript.exe`（样式 0）调用 `autostart/run-daemon.cmd` |
| IPC | `<base>/daemon.sock`（AF_UNIX） | 命名管道 `\\.\pipe\dsh-instance-manager-<sha256(home+user) 前 16 位>` |
| 进程发现 | `/bin/ps -axo` + `.app/Contents/MacOS` 特征 | CIM（`Win32_Process`）+ 映像名/argv 特征 |
| 终止语义 | `SIGTERM` → 宽限 → `SIGKILL` | `taskkill /PID`（不带 `/F`）→ `process.kill('SIGKILL')` |
| 私有权 | uid 校验 + `0600`/`0700` | **无 POSIX 私有权**：断言"普通文件 + 非重解析点 + 位于 DSH_HOME 下"；实测 mode 恒 `0o666` |
| 运行副本 | `runtime/daemon/` | `runtime/daemon-<内容哈希>/`（版本化，避免删除在用目录时 EBUSY） |
| 解释器 | `$DSH_HOME/dsh-runtimes/.../node` | `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`（⚠️ `resources/runtime/bin` 下只有 **shim**），兜底用 App exe + `ELECTRON_RUN_AS_NODE=1` |

### 为什么启动必须经计划任务服务

Windows 会把"父进程在 Job 对象里"的子进程自动并入同一 Job，而 Chromium 给自己的子进程用的是带
`KILL_ON_JOB_CLOSE` 的 Job；Node 的 `detached: true` **不传** `CREATE_BREAKAWAY_FROM_JOB`。
如果 daemon 由 App 的 `apply()` 直接 spawn，**App 一死 daemon 会被连带杀死——正好死在重启窗口中途，
没人再把 App 拉起来**。计划任务由服务创建进程，天然不在任何 Chromium Job 里。
本机实测：daemon 的 `ppid` 已消失（孤儿进程），确认与 App 进程树无关。

### 降级承诺（Windows 做不到 macOS 的那些，必须写明）

- **保活靠看门狗，延迟 ≤ 5 分钟**（实测修正）：daemon 被外部杀死后，计划任务的
  `RestartOnFailure` **不会**把它拉回来 —— 任务动作（wscript）早已成功退出，"进程随后被杀"不算任务失败
  （实测杀掉后 100 秒仍无进程、任务仍是 `Ready`、`Last Result: 0`）。因此给同一任务加了一个
  **每 5 分钟重复**的触发器当看门狗：定期重跑 `launch.vbs` 起 daemon，已在跑时 daemon 自身
  `ALREADY_RUNNING → 退出码 0`（幂等，不会造成重启风暴）。macOS 的 `KeepAlive` 是即时的，这里是 ≤ 5 分钟。
- **"安全重启"口径下调**（实测）：Windows 没有可捕获信号。App 侧用 `taskkill /PID`（不带 `/F`）**尽力**走
  `WM_CLOSE`，但 2026-10-09 的真实重启里 App **没有在 5 秒宽限内退出**，阶梯按设计升级为 `SIGKILL` 才结束
  —— 所以实际是**硬杀**，只是顺序严格保证 **先 App 后 Host**，且 App 未确认消失前不发 Host 信号。
  **不要**向用户承诺"优雅退出"或状态 flush。
- **无 stdout/stderr 重定向能力**：计划任务没有这个功能，改由 `run-daemon.cmd` 把 daemon 输出重定向到 `supervisor.log`。
- `RunAtLoad` → `LogonTrigger`：是**登录后**启动，不是开机启动。

### Windows 侧的实测结论（本机，2026-10-09）

- daemon 可正常启动并应答：`manage.mjs status` → `running: true`，`appCount: 1`、`hostCount: 1`（正确认出 App 主进程与桌面宿主，且不把 `--type=*` 子进程与 `dsh-subprocess-local\lib\runner.js` 误判成实例）。
- **进程识别与 macOS 同语义**：*名字前缀命中*即算同一个 App —— `…\DeepSeek Harness.exe-spoof` 也算（macOS 侧 `…/MacOS/DeepSeek Harness-spoof` 同样算）。这是刻意语义，**移植时不要"顺手收紧"**（2026-10-09 为迁就一条老断言收紧过 macOS 匹配，2026-10-10 已按 owner 澄清回退）。
- `preflight('dsh-instance-manager')` 成功解析 profile 的 `cordis.patch.yml` 并算出补丁哈希。
- 安装经计划任务完成（`started.via = "scheduled-task"`）。
- 全套测试 `node --test "tests/*.test.mjs"`：**51/51 通过**（改造前在同一台 Windows 上是 40 用例 19 红，全部因平台硬编码）。
- **端到端重启成功**（13:15 的真实重启，daemon.log 阶梯）：
  `scheduled → stopping → app-stop-requested → process-signal(TERM) → process-signal(KILL) → app-stopped → launching → new-app-detected → new-host-detected → http-ready → ready → recovery-notified`。
  一次性成功、**未触发救援**（补丁无 `disabled`）；恢复消息**恰好送达一次**，原会话被唤醒续作；
  新宿主仍为 `profile=desktop`；重启后进程内的 `dsh_restart` 工具由"报 macOS `.sock`、`installed:false`"变为
  `installed:true / running:true / phase:ready`，证明**新代码确实冷加载**。
- **看门狗自愈成功**：强杀 daemon 后，任务在下一个 5 分钟边界自动把它拉起（本次实测延迟约 5 秒，最坏 5 分钟），未产生重复实例。
- **改 daemon 半的代码会自动生效**（2026-10-10 修）：Windows 运行副本布局是 `runtime/daemon-<哈希>/daemon/*.mjs`，
  而比对逻辑原先少拼了一层 `daemon/` → **永远判定"有差异"**：① 每次 apply 都白重装（`host.log` 里
  `daemon-runtime-synced` 恒出现，`changed` 失去诊断意义）；② 重装走 `start` 撞上 `ALREADY_RUNNING → 退出 0`
  → **在跑的 daemon 一直跑旧代码**（这正是当时必须手动 `manage.mjs stop` 才生效的原因）。
  现已修：比对层级正确，且发现真差异时**先停旧进程再装**（返回 `restarted: true`）；
  若此刻正在重启（phase ∈ scheduled/stopping/starting/recovery）则推迟，绝不在重启中途停后台。
  实测：一致 → `changed:false`（修复前恒为 true）；改一字节 → `changed:true, restarted:true` 且 daemon pid 变化；
  撤销 → 再换一次；随后稳定 `changed:false`。

**已确认**：①**客户端半（浏览器侧 UI）**已由用户刷新页面确认无问题（2026-10-10）。

**尚未验证（不声称做过）**：①计划任务创建在其它账户形态下是否需要管理员；②macOS 侧需在 macOS 上复跑 `node --test` 确认 50/50（本机无法验证）。
