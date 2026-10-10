import * as manager from './manager.js';
import { readFileSync } from 'node:fs';
import { startRestoreMonitor } from './restore.js';
import { restartTool } from './tools.js';
export const name = 'dsh-instance-manager';
const skillContent = readFileSync(new URL('./skills/restart/SKILL.md', import.meta.url), 'utf8');
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 2048) throw new Error('请求过大'); }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'action')) throw new Error('无效请求');
  return value;
}
export function apply(ctx) {
  // 独立后台是复制到 ~/.dsh/instance-manager/runtime/ 运行的：每次启动把运行副本与
  // 插件源码对齐（内容相同则什么都不做），否则改好的后台逻辑永远不会生效。
  void manager.syncDaemonRuntime()
    .then(r => { if (r?.changed) void manager.recordEvent('daemon-runtime-synced', {}).catch(() => {}); })
    // 同步失败不阻塞插件加载，但**不能静默**：曾经正是这里的 catch 让"Windows 上后台根本装不上"
    // 表现成"插件加载正常"。改为记录一条事件，可用 manage.mjs status/logs 查。
    .catch(error => { void manager.recordEvent('daemon-runtime-sync-failed', { error: String(error?.message || error) }).catch(() => {}); });
  ctx.provide('dshInstanceManager', {
    status: () => manager.status(), preflight: pluginName => manager.preflight(pluginName),
    prepareRestart: plan => manager.prepareRestart(plan),
    requestPreparedRestart: requestId => manager.requestPreparedRestart(requestId),
    requestRestart: plan => manager.restart(plan ? { plan } : {}),
  });
  ctx.inject(['skills'], scope => {
    ctx.effect(() => scope.skills.register({ name: 'restart', source: 'runtime',
      description: '安全重启 DSH：专用子 Agent 审查，离线零 LLM 救援，成功后可续作当前会话。',
      whenToUse: '插件变更需要重启、用户要求安全重启或重启后继续任务', content: skillContent,
      invocation: { modelInvocable: true, userInvocable: true } }));
  });
  ctx.inject(['tools', 'approval', 'sessionController'], scope => {
    ctx.effect(() => scope.tools.register(restartTool({ manager, approval: scope.approval, controller: scope.sessionController })));
  });
  ctx.inject(['sessionController'], scope => {
    ctx.effect(() => startRestoreMonitor({ status: manager.status, claim: manager.acknowledgeRecovery,
      controller: scope.sessionController, log: (event, details) => { void manager.recordEvent(event, details).catch(() => {}); } }));
  });
  ctx.inject(['webServer', 'connection'], scope => {
    for (const [path, method, run] of [
      ['/dsh-instance-manager/status', 'GET', () => manager.status()],
      ['/dsh-instance-manager/logs', 'GET', () => manager.logs()],
      ['/dsh-instance-manager/action', 'POST', async req => manager.action((await body(req)).action)],
    ]) ctx.effect(() => scope.webServer.register({ kind: 'exact', path, handler: async (req, res) => {
      const rejected = scope.connection.requestRejection(req);
      if (rejected !== undefined) return json(res, rejected, { ok: false, error: '请求未通过 DSH 认证' });
      if (req.method !== method) return json(res, 405, { ok: false, error: 'method' });
      if (method === 'POST' && req.headers['x-dsh-instance-manager'] !== '1') return json(res, 403, { ok: false, error: '缺少操作请求头' });
      try { json(res, 200, await run(req)); } catch (error) { json(res, 400, { ok: false, error: error.message }); }
    } }));
  });
}
