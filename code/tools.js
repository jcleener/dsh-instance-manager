import { randomUUID } from 'node:crypto';
export function restartTool({ manager, approval, controller }) {
  return {
    name: 'dsh_restart',
    description: '安全重启当前 DSH。先加载 restart skill 并由专用子 Agent 审查。status/preflight 不重启；restart 仅按插件名登记固定救援，可在新 DSH 启动后续作当前会话。禁止命令/路径/自定义消息。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'preflight', 'restart'] },
      pluginName: { type: 'string' }, report: { type: 'object' }, resumeSession: { type: 'boolean' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (!args || Object.keys(args).some(key => !['action', 'pluginName', 'report', 'resumeSession'].includes(key))) throw new Error('无效请求字段');
      if (args.action === 'status') return manager.status();
      if (!['preflight', 'restart'].includes(args.action)) throw new Error('无效 action');
      const checked = await manager.preflight(args.pluginName);
      if (args.action === 'preflight') return checked;
      if (!exec.agent || !approval || !controller) throw new Error('缺少会话或授权服务，未重启');
      const inspection = await controller.inspect(exec.agent.id, exec.signal);
      if (!inspection?.meta || inspection.meta.parentSession || inspection.meta.origin === 'subagent') throw new Error('只能由原主会话提交重启，子 Agent 只负责审查');
      if (args.resumeSession !== undefined && typeof args.resumeSession !== 'boolean') throw new Error('resumeSession 必须为布尔值');
      exec.signal.throwIfAborted();
      // This opt-in exception applies ONLY to the fixed restart tool, not to
      // DSH's global approval service or arbitrary commands.
      const policy = typeof approval.effectivePolicy === 'function'
        ? approval.effectivePolicy(exec.agent.session)
        : undefined;
      const outcome = policy === 'never' ? 'allowed-once' : await approval.request({
        agent: exec.agent, toolName: 'dsh_restart', callId: exec.callId, signal: exec.signal,
        reason: `重启当前 DSH；启动失败时仅禁用插件 ${args.pluginName} 的加载项。${args.resumeSession ? '成功启动后向当前会话发送固定续作消息。' : '不自动续作。'}`,
      });
      if (outcome !== 'allowed-once') return { ok: false, error: `重启未获授权：${outcome}` };
      exec.signal.throwIfAborted();
      const now = Date.now();
      const plan = { version: 1, requestId: randomUUID(), pluginName: args.pluginName, report: args.report,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString() };
      if (args.resumeSession) plan.sessionId = exec.agent.id;
      // Persist the fixed plan while DSH is alive, then end this turn before
      // asking the independent daemon to stop App/Host. This grace window is
      // what prevents Electron's "interrupt running task?" dialog.
      const prepared = await manager.prepareRestart(plan);
      exec.concludeTurn();
      const idleGraceMs = 1200;
      setTimeout(() => {
        void manager.requestPreparedRestart(plan.requestId).catch(error => {
          manager.recordEvent?.('restart-submit-failed', { requestId: plan.requestId, error: String(error) }).catch?.(() => {});
        });
      }, idleGraceMs);
      return { ok: true, phase: 'waiting-for-idle', requestId: plan.requestId, inMs: idleGraceMs, plan: prepared.plan };

    },
  };
}
