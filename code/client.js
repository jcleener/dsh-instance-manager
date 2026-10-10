/* DSH 实例管理客户端：只依赖经现有插件验证的 react require + slots 服务。 */
window.__ModuleLoader__.load({
  id: 'dsh-instance-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const react = require('react');
    const e = react.createElement;
    const base = '/dsh-instance-manager';
    const css = [
      '.dim-restart{color:var(--dsw-alias-state-error-primary);background:transparent;border:1px solid transparent;border-radius:6px;padding:6px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}',
      '.dim-restart:hover,.dim-restart:focus-visible{border-color:var(--dsw-alias-state-error-primary);outline:none}',
      '.dim-restart:disabled{opacity:.5;cursor:not-allowed}',
      '.dim-settings{max-width:680px;padding:12px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dim-settings h3{margin:0 0 10px}',
      '.dim-settings p{margin:5px 0;color:var(--dsw-alias-label-secondary)}',
      '.dim-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}',
      '.dim-actions button{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;cursor:pointer}',
      '.dim-actions button:disabled{opacity:.5;cursor:not-allowed}',
      '.dim-actions .danger{color:var(--dsw-alias-state-error-primary)}',
      '.dim-settings pre{white-space:pre-wrap;max-height:260px;overflow:auto;color:var(--dsw-alias-label-secondary)}',
      '.dim-error{color:var(--dsw-alias-state-error-primary)!important}',
    ].join('');
    async function api(path, action) {
      const response = await fetch(`${base}/${path}`, action ? {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-instance-manager': '1' },
        body: JSON.stringify({ action }),
      } : { credentials: 'same-origin', cache: 'no-store' });
      const value = await response.json();
      if (!response.ok || value.ok === false) throw new Error(value.error?.message || value.error || `HTTP ${response.status}`);
      return value;
    }
    function useManager() {
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState('');
      const refresh = async () => {
        try { setState(await api('status')); setError(''); }
        catch (err) { setError(String(err?.message || err)); }
      };
      react.useEffect(() => {
        let active = true;
        const update = async () => {
          try { const next = await api('status'); if (active) { setState(next); setError(''); } }
          catch (err) { if (active) setError(String(err?.message || err)); }
        };
        update();
        const timer = setInterval(update, 5000);
        return () => { active = false; clearInterval(timer); };
      }, []);
      return { state, error, refresh, setError };
    }
    function RestartButton(props) {
      const { state, error, refresh, setError } = useManager();
      const [busy, setBusy] = react.useState(false);
      const ready = state?.installed === true && state?.running === true && !busy && !['scheduled','stopping','starting','recovery','recovery-starting'].includes(state?.daemon?.phase);
      const onClick = async () => {
        if (!ready) return;
        // 先弹出确认窗口；取消时绝不提交 /action/restart。
        if (!window.confirm('确认重启 DeepSeek Harness 实例？\n\n正在运行的任务将被中断。\n选择“取消”不会执行任何操作。')) return;
        setBusy(true);
        try { await api('action', 'restart'); await refresh(); }
        catch (err) { setError(String(err?.message || err)); setBusy(false); }
      };
      const label = busy ? '已受理…' : '重启实例';
      return e('button', { type:'button', className:'dim-restart', disabled:!ready,
        onClick, title:error || '由独立后台启动器重启；正在执行的任务会中断',
        'aria-label': label }, '⟳', props?.wide === false ? '' : ` ${label}`);
    }
    function SettingsSection() {
      const { state, error, refresh, setError } = useManager();
      const [busy, setBusy] = react.useState(false);
      const [output, setOutput] = react.useState('');
      const doAction = async action => {
        if (busy) return;
        if (['stop','uninstall'].includes(action) && !window.confirm(`确认${action === 'stop' ? '停止' : '卸载'}后台启动器？`)) return;
        setBusy(true);
        try {
          const result = await api('action', action);
          setOutput(`${action}: ${result.status?.phase || '完成'}`);
          await refresh();
        } catch (err) { setError(String(err?.message || err)); }
        finally { setBusy(false); }
      };
      const readLogs = async () => {
        try { setOutput((await api('logs')).text || '暂无日志'); }
        catch (err) { setError(String(err?.message || err)); }
      };
      const phase = state?.daemon?.phase || state?.lastResult?.phase || '未连接';
      return e('div', { className:'dim-settings' },
        e('h3', null, 'DSH 实例管理'),
        e('p', null, `后台启动器：${state?.installed ? '已安装' : '未安装'} · ${state?.running ? '运行中' : '未连接'} · 状态 ${phase}`),
        state?.lastResult?.error ? e('p', { className:'dim-error' }, state.lastResult.error) : null,
        error || state?.error ? e('p', { className:'dim-error' }, error || state.error) : null,
        e('p', null, '重启受理不等于启动成功；后台状态会持续更新。故障时可从终端离线管理。'),
        e('div', { className:'dim-actions' },
          e('button', { onClick:()=>doAction('install'), disabled:busy }, '安装'),
          e('button', { onClick:()=>doAction('start'), disabled:busy || !state?.installed }, '启动服务'),
          e('button', { onClick:()=>doAction('stop'), disabled:busy || !state?.running }, '停止服务'),
          e('button', { onClick:()=>doAction('uninstall'), disabled:busy || !state?.installed, className:'danger' }, '卸载服务'),
          e('button', { onClick:refresh, disabled:busy }, '刷新状态'),
          e('button', { onClick:readLogs, disabled:busy }, '查看日志')),
        output ? e('pre', null, output) : null);
    }
    function apply(ctx) {
      ctx.effect(() => {
        const node = document.createElement('style');
        node.textContent = css; node.dataset.dshInstanceManager = '1';
        document.head.appendChild(node);
        return () => node.remove();
      }, 'dsh-instance-manager: styles');
      ctx.inject(['slots'], scope => {
        scope.slots.inject('sidebar.footer.action', () => scope.slots.register(
          { name:'sidebar.footer.action', id:'dsh-instance-manager-restart', order:900, label:()=> '重启实例' },
          props => e(RestartButton, props)));
        scope.slots.inject('settings.section', () => scope.slots.register(
          { name:'settings.section', id:'dsh-instance-manager', order:81, label:()=> '实例管理' },
          props => e(SettingsSection, props)));
      });
    }
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
