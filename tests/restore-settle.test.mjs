#!/usr/bin/env node
/**
 * 恢复消息「稳定期计数门」测试（直接驱动插件代码，不需要重启实例）
 *
 * 背景：daemon 的 ready 判据只是"HTTP 端口通"（`probeHttp('/')` 返回 200–499），
 * 此时新宿主的插件与技能**仍在注册中**。原先 `startRestoreMonitor` 的首次 tick 立即执行，
 * 一看到 ready 就投递恢复消息，导致 agent 拿到**残缺的环境快照**（例如技能目录不全），
 * 误判"插件没加载成功"。
 *
 * 修复：发送前要求轮询计数 `ticks > settleTicks`（默认 10，即约 10 秒）。
 * ticks 是本宿主进程内的局部计数，每次重启新建、从 0 开始——本测试也验证这一点。
 *
 * 用法：node plugins/dsh-instance-manager/tests/restore-settle.test.mjs
 */
import { startRestoreMonitor } from '../code/restore.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
	if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
	else { failed += 1; console.log(`  ✗ ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTERVAL = 25, SETTLE = 10;   // tick 11 出现在约 250ms

function harness({ phase = 'ready' } = {}) {
	const prompts = [];
	let statusCalls = 0;
	return {
		prompts,
		get statusCalls() { return statusCalls; },
		deps: {
			intervalMs: INTERVAL,
			maxTicks: 500,
			settleTicks: SETTLE,
			log: () => {},
			status: async () => {
				statusCalls += 1;
				return { daemon: { phase, details: { sessionId: 's1', requestId: 'r1' } } };
			},
			claim: async (requestId) => ({ status: { phase, details: { sessionId: 's1', requestId } } }),
			controller: { prompt: async (msg) => { prompts.push(msg); } },
		},
	};
}

console.log('恢复消息稳定期计数门测试\n');

// ── C1：未达到 settleTicks 前绝不发送 ──────────────────────────────
{
	const h = harness();
	const stop = startRestoreMonitor(h.deps);
	await sleep(150);                       // ≈ tick 6，仍在稳定期内
	check('C1 稳定期内不发送恢复消息', h.prompts.length === 0, `实际发送 ${h.prompts.length} 次`);
	check('C1 稳定期内确实在轮询（门不是靠不轮询实现的）', h.statusCalls >= 4, `status 调用 ${h.statusCalls} 次`);
	stop();
}

// ── C2：超过 settleTicks 后发送，且只发送一次 ──────────────────────
{
	const h = harness();
	const stop = startRestoreMonitor(h.deps);
	await sleep(150);
	const early = h.prompts.length;
	await sleep(350);                       // 总计 ≈ 500ms，远超 tick 11
	check('C2 稳定期前未发送', early === 0, `提前发送 ${early} 次`);
	check('C2 超过稳定期后发送了恢复消息', h.prompts.length === 1, `实际 ${h.prompts.length} 次`);
	check('C2 发送后不再重复投递', h.prompts.length === 1, `实际 ${h.prompts.length} 次`);
	check('C2 投递内容为队列模式的文本消息',
		h.prompts[0]?.mode === 'queue' && h.prompts[0]?.content?.[0]?.type === 'text',
		JSON.stringify(h.prompts[0]?.mode));
	stop();
}

// ── C3：每次新建 monitor 计数都从 0 开始（重启即归零）──────────────
{
	const a = harness();
	const stopA = startRestoreMonitor(a.deps);
	await sleep(400);                       // 第一个 monitor 已发送
	check('C3 第一个 monitor 已发送', a.prompts.length === 1, `实际 ${a.prompts.length} 次`);
	stopA();

	const b = harness();                    // 模拟"重启后新宿主里新建的 monitor"
	const stopB = startRestoreMonitor(b.deps);
	await sleep(150);                       // 与新 monitor 相同的短窗口
	check('C3 新建 monitor 的计数从 0 开始（不继承上一个）', b.prompts.length === 0, `立即发送了 ${b.prompts.length} 次`);
	stopB();
}

// ── C4：未就绪时永不发送 ──────────────────────────────────────────
{
	const h = harness({ phase: 'idle' });
	const stop = startRestoreMonitor(h.deps);
	await sleep(400);
	check('C4 非 ready/recovered 阶段不发送', h.prompts.length === 0, `实际 ${h.prompts.length} 次`);
	stop();
}

// ── C5：门不消耗 maxTicks 预算（稳定期后仍有投递机会）─────────────
{
	const h = harness();
	h.deps.maxTicks = 30;                   // tick 11 发送时远未到上限
	const stop = startRestoreMonitor(h.deps);
	await sleep(500);
	check('C5 maxTicks 较小时仍能完成投递', h.prompts.length === 1, `实际 ${h.prompts.length} 次`);
	stop();
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
