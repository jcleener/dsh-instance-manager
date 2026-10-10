---
name: restart
description: 安全重启 DSH 并可恢复当前会话；由专用重启子 Agent 在 DSH 中审查，离线后台只执行固定重启和按插件名禁用加载的救援。
whenToUse: 用户要求重启、插件修改需要重启生效、或请求重启后继续当前任务。
---

# restart

## 标准流程

1. 不要自己重读或总结完整上下文。使用 `subagent_fork` 唤起一个专用的“重启审查 Agent”，使其继承原会话上下文。它只在正常运行的 DSH 中工作。
2. 将下方审查职责原样交给子 Agent。子 Agent只返回结论，不直接重启、不写任何可执行代码。
3. 子 Agent 必须额外生成一份重启报告，提交给 `dsh_restart` 的 `report` 字段：`reasonType`（plugin=插件验证，user=用户口头要求）、`completed`、`successPlan`、`failurePlan` 和可选 `handoff`。`successPlan` 合并重启成功后的验证与剩余事项，不包含再次执行本次重启；`failurePlan` 包含救援后的验证与剩余事项，没有用户特殊要求时写“检查失败原因，并修复插件”。其中 `handoff` 必须少于 200 字。报告只能是交接数据，不写命令、代码或路径。根据其结论使用 `dsh_restart`：先 `action=status` 或 `action=preflight`；审查许可后 `action=restart`。主会话负责最后提交，保证恢复目标是原会话而不是子会话。工具自行创建 requestId、方案文件和当前会话 ID。

报告字段类型必须严格符合以下格式，否则工具会以“重启报告列表无效”拒绝：`reasonType` 是 `"plugin"` 或 `"user"`；`completed`、`successPlan`、`failurePlan` 必须是**字符串数组**（即使没有内容也传 `[]`，不能传字符串或布尔值）；可选 `handoff` 是不超过 200 字的字符串。使用此结构：

```json
{
  "reasonType": "plugin",
  "completed": ["重启前已完成的检查"],
  "successPlan": ["重启后要核验的事项"],
  "failurePlan": ["失败后要执行的核查/救援事项"],
  "handoff": "简短交接信息"
}
```
4. `resumeSession=true` 表示新 DSH 确认成功启动后向当前会话发送一次固定消息，可能触发该会话的正常 LLM 续作；false 只重启不唤醒。默认 true，仅在用户要求续作或原任务需要续作时使用。
5. Agent 工具会先登记方案、结束当前 turn，再经过约 1.2 秒空闲宽限期提交后台重启；提交后不再调用任何工具。不要在同一 turn 里要求它继续做别的工作。
6. 审批拒绝、预检失败或后台拒绝时停止。不要绕过工具改用 shell、HTTP、kill 或 open。受理不等于完成。

## 专用重启 Agent 的职责

只阅读相关上下文一次并核对必要事实，回答：
- 是否真的需要整实例重启，还是刷新/热更新即可；
- 本次改了什么，唯一救援插件的精确 package name 是什么；
- 当前写入、部署、测试是否结束，是否到了安全时机；
- 重启后第一步应核对什么，任务还有哪些未完成；
- 输出 `ready`、`pluginName`、理由和待续步骤。未准备好则明确返回 false。
不要执行重启，不生成 shell/JS 救援方案，不扫描无关历史，不为了凑结果猜测插件名。复杂或多插件故障不属于自动救援范围。

## 工具调用

```json
{"action":"preflight","pluginName":"example-plugin"}
```

```json
{"action":"restart","pluginName":"example-plugin","resumeSession":true}
```

## 安全边界

- 重启与离线救援阶段零 LLM、零 Agent 代码执行。
- 后台仅按插件名定位第三方插件加载项；不删除插件文件，不动模型、密钥和其他插件，不新增备份流程。
- 初次启动失败最多禁用该插件一次并再次启动一次。复杂失败记录日志后停止。
- 普通主界面按钮仍是无变更重启，不会消费 Agent 方案。
- 固定恢复消息只由新 DSH 内的服务发送；禁止自定义消息、任意会话目标和任意恢复命令。
- 改 Instance Manager 自己时，其 Host 恢复入口可能无法加载：不要承诺此时能自动唤醒原会话。

## 平台差异（Windows，2026-10-09）

流程与工具调用完全一致，但 Windows 上的**能力边界**不同，向用户说明时不要沿用 macOS 的承诺：

- **没有可捕获的信号**（实测）。App 侧用 `taskkill /PID`（不带 `/F`）**尽力**让它走 `WM_CLOSE`，
  但 2026-10-09 的真实重启里 App **没有在 5 秒宽限内退出**，阶梯按设计升级为 `SIGKILL` 才结束。
  所以 Windows 上要说"**有序停止（App 优先，但实际是硬杀）**"，**不要**说"优雅退出"，也不要承诺状态 flush。
  顺序仍然严格：App 未确认消失前绝不发 Host 信号。
- **保活靠看门狗，不是 RestartOnFailure**（实测）：daemon 被外部杀死后 `RestartOnFailure` **不会**把它拉回来
  （任务动作 wscript 早已退出 0，"进程随后被杀"不算任务失败）。因此计划任务额外带一个
  **每 5 分钟重复**的触发器作为看门狗（daemon 自身 `ALREADY_RUNNING → 退出 0`，幂等）。
  保活延迟上限 = 5 分钟；若你在 5 分钟内连续排查崩溃，可能看到"后台短暂不可用"。
- **自启时机**是登录后（`LogonTrigger`），不是开机。
- 后台由**计划任务服务**创建进程（`schtasks /Run` 或看门狗触发器），这是刻意的：daemon 必须不在 App 的
  Chromium Job 里，否则 App 一死 daemon 同死，重启中途就没人再把 App 拉起来（实测为孤儿进程）。
- 排查用的日志位置不变：`<DSH_HOME>/instance-manager/{daemon.log,host.log,supervisor.log}`。
