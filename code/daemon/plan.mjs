import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertOwnedDirectory, assertOwnedFile, hardenPath } from '../platform.mjs';

export const PLAN_VERSION = 1;
export function planPath(home) { return path.join(home, 'instance-manager', 'restart-plan.json'); }
export function validatePlan(plan, { now = Date.now() } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw Object.assign(new Error('重启方案必须是对象'), { code: 'INVALID_PLAN' });
  if (Object.keys(plan).some(key => !['version', 'requestId', 'pluginName', 'sessionId', 'createdAt', 'expiresAt', 'report'].includes(key))) throw Object.assign(new Error('重启方案含有未允许字段'), { code: 'INVALID_PLAN' });
  if (plan.version !== PLAN_VERSION) throw Object.assign(new Error('不支持的重启方案版本'), { code: 'INVALID_PLAN' });
  if (typeof plan.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(plan.requestId)) throw Object.assign(new Error('requestId 无效'), { code: 'INVALID_PLAN' });
  if (typeof plan.pluginName !== 'string' || !/^[A-Za-z0-9@._/-]{1,160}$/.test(plan.pluginName)) throw Object.assign(new Error('pluginName 无效'), { code: 'INVALID_PLAN' });
  if (plan.sessionId != null && (typeof plan.sessionId !== 'string' || plan.sessionId.length > 256)) throw Object.assign(new Error('sessionId 无效'), { code: 'INVALID_PLAN' });
  const report = plan.report;
  if (report != null) {
    if (!report || typeof report !== 'object' || Array.isArray(report) || Object.keys(report).some(k => !['reason','reasonType','completed','verifyAfterRestart','pending','successCriteria','successPlan','failurePlan','handoff'].includes(k))) throw Object.assign(new Error('重启报告格式无效'), { code: 'INVALID_REPORT' });
    for (const key of ['reason','handoff']) if (report[key] != null && (typeof report[key] !== 'string' || report[key].length > (key === 'handoff' ? 200 : 2000))) throw Object.assign(new Error('重启报告文本过长'), { code: 'INVALID_REPORT' });
    if (report.reasonType != null && !['plugin','user'].includes(report.reasonType)) throw Object.assign(new Error('重启原因类型无效'), { code: 'INVALID_REPORT' });
    for (const key of ['completed','verifyAfterRestart','pending','successCriteria','successPlan','failurePlan']) if (report[key] != null && (!Array.isArray(report[key]) || report[key].length > 20 || report[key].some(x => typeof x !== 'string' || x.length > 500))) throw Object.assign(new Error('重启报告列表无效'), { code: 'INVALID_REPORT' });
  }
  if (!Number.isSafeInteger(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now) throw Object.assign(new Error('重启方案已过期或 expiresAt 无效'), { code: 'PLAN_EXPIRED' });
  return { version: PLAN_VERSION, requestId: plan.requestId, pluginName: plan.pluginName || null, sessionId: plan.sessionId || null, createdAt: plan.createdAt || new Date(now).toISOString(), expiresAt: plan.expiresAt, ...(report ? { report } : {}) };
}
export async function readPlan(home, options = {}) {
  const file = planPath(home);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { assertOwnedFile(stat, { mode: 0o600, message: '重启方案文件不安全' }); }
  catch { throw Object.assign(new Error('重启方案文件不安全'), { code: 'UNSAFE_PLAN' }); }
  const plan = validatePlan(JSON.parse(await fs.readFile(file, 'utf8')), options);
  return { ...plan, hash: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}
export async function writePlan(home, input) {
  const plan = validatePlan(input);
  const dir = path.dirname(planPath(home));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const owner = await fs.lstat(dir);
  assertOwnedDirectory(owner, '不安全的方案目录');
  await hardenPath(dir, 0o700);
  const file = planPath(home);
  const tmp = `${file}.next-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  await fs.writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
  await hardenPath(tmp, 0o600);
  try {
    try { await fs.link(tmp, file); }
    catch (error) {
      // 非 NTFS/POSIX 卷（FAT/exFAT/部分网络盘）不支持硬链接：退化为独占创建，
      // 仍然只可能有一个赢家，因此"已有待执行方案"的语义不变。
      if (!['EPERM', 'EXDEV', 'ENOTSUP', 'EACCES', 'ENOSYS'].includes(error.code)) {
        if (error.code === 'EEXIST') throw Object.assign(new Error('已有待执行的重启方案'), { code: 'PLAN_EXISTS' });
        throw error;
      }
      try { await fs.writeFile(file, text, { mode: 0o600, flag: 'wx' }); }
      catch (inner) {
        if (inner.code === 'EEXIST') throw Object.assign(new Error('已有待执行的重启方案'), { code: 'PLAN_EXISTS' });
        throw inner;
      }
    }
  } finally { await fs.rm(tmp, { force: true }); }
  return plan;
}
export async function consumePlan(home, requestId, expectedHash) {
  const file = planPath(home);
  const current = await readPlan(home);
  if (!current || current.requestId !== requestId) throw Object.assign(new Error('重启方案 requestId 不匹配'), { code: 'INVALID_PLAN' });
  if (expectedHash && current.hash !== expectedHash) throw Object.assign(new Error('重启方案哈希不匹配'), { code: 'PLAN_CHANGED' });
  const claimed = `${file}.claimed-${requestId}`;
  try { await fs.rename(file, claimed); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const claimedPlan = await readPlanAt(claimed);
  if (expectedHash) {
    const actual = crypto.createHash('sha256').update(JSON.stringify(claimedPlan)).digest('hex');
    if (actual !== expectedHash) { await fs.rm(claimed, { force: true }); throw Object.assign(new Error('已领取方案哈希不匹配'), { code: 'PLAN_CHANGED' }); }
  }
  return { path: claimed, plan: claimedPlan };
}
async function readPlanAt(file) {
  const stat = await fs.lstat(file);
  assertOwnedFile(stat, { message: '已领取的重启方案不安全' });
  return validatePlan(JSON.parse(await fs.readFile(file, 'utf8')));
}
export async function removeClaimed(file) { await fs.rm(file, { force: true }); }
export async function clearPlan(home, requestId) {
  const file = planPath(home);
  if (!requestId) return false;
  try {
    const current = await readPlan(home);
    if (!current || current.requestId !== requestId) return false;
    await fs.rm(file, { force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
