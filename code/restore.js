// Only the successfully booted DSH Host can admit a fixed continuation message.
export function restoreText(status) {
  const d = status.details || {}, r = d.report || {};
  const plugin = d.pluginName || d.disabledPlugin || '未记录';
  const rescued = status.phase === 'recovered';
  const lines = ['你刚才使用 restart skill 提交的重启申请已执行完毕。以下为重启后的报告。',
    `【请求 ID】\n${d.requestId}`,
    `【重启原因】\n${r.reasonType === 'user' ? '用户口头要求重启。' : `${plugin} 插件需要重启后验证。`}`,
    `【重启结果】\n${rescued ? `首次重启失败，停止加载 ${d.disabledPlugin || plugin} 插件后重启成功。` : '一次性重启成功。'}`];
  if (r.completed?.length) lines.push(`【重启前已确认事项】\n${r.completed.map(x => `- ${x}`).join('\n')}`);
  const checks = rescued
    ? (r.failurePlan?.length ? r.failurePlan : ['检查首次启动失败原因，并修复插件。'])
    : (r.successPlan?.length ? r.successPlan : [...(r.verifyAfterRestart || []), ...(r.pending || [])]);
  const items = [...new Set(checks)];
  if (!rescued && typeof r.handoff === 'string' && r.handoff.length <= 200 && r.handoff) items.push(r.handoff);
  if (items.length) lines.push(`【需核对事项】\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
  return lines.join('\n\n');
}
export function startRestoreMonitor({ status, claim, controller, log, intervalMs = 1000, maxTicks = 120, settleTicks = 10 }) {
  let stopped = false, inFlight = false, ticks = 0;
  const lifetime = new AbortController();
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    let attempted = false;
    try {
      ticks++;
      const value = await status();
      if (stopped) return;
      const s = value.daemon;
      if (['ready', 'recovered'].includes(s?.phase) && s.details?.sessionId && !s.details.recoveryNotifiedAt) {
        // 先让实例稳定再唤醒会话：新宿主刚起来、HTTP 端口一通，daemon 就判定 ready，
        // 但此时插件与技能仍在注册中。过早投递恢复消息，会让 agent 拿到**残缺的环境快照**
        // （例如技能目录不全），进而误判"插件没加载成功"。
        // ticks 是本次宿主进程内的局部计数，每次重启都新建、从 0 开始，无需持久化。
        // 注意：门必须放在 claim 之前——claim 是提交点，先提交再等待会让崩溃变成丢消息。
        if (ticks <= settleTicks) return;
        // Claim before admission. A crash after claim may lose delivery, never duplicates it.
        attempted = true;
        const result = await claim(s.details.requestId);
        if (stopped) return;
        const notice = result.status;
        if (!['ready', 'recovered'].includes(notice?.phase) || notice.details?.requestId !== s.details.requestId || notice.details?.sessionId !== s.details.sessionId) throw new Error('恢复领取结果不匹配');
        stopped = true;
        await controller.prompt({ requestId: `dsh-restart-${notice.details.requestId}`, sessionId: notice.details.sessionId,
          mode: 'queue', content: [{ type: 'text', text: restoreText(notice) }] }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]));
        log('restore-notification-sent', { requestId: notice.details.requestId });
      }
    } catch (error) { if (attempted) stopped = true; log('restore-notification-error', { error: String(error) }); }
    finally { inFlight = false; if (stopped || ticks >= maxTicks) clearInterval(timer); }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return () => { stopped = true; lifetime.abort(); clearInterval(timer); };
}
