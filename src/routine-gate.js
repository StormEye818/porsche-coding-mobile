/**
 * routine-gate.js — 0x31 例程的**执行侧**驱动闸（2026-11-17）。
 *
 * 为什么需要它
 * ────────────
 * `schema.featureFramesFor('actuator')` 只对 catalog / 0x2F 路径生效；
 * `.actRun → coder.runRoutine()` 根本不经过它。于是出现「UI 把按钮置灰，
 * 但绕过 DOM 后执行层照样发帧」的自相矛盾：data/actuator.json 里 133 条
 * form=31 的 driveDisabled 条目 `params` 全为空串，一旦被触发就会发出
 * 我们判定「不能定型」的裸 `31 <sub> <rid>` 帧。
 *
 * 本模块把「能不能驱动」做成**单一策略源**：
 *   · 纯策略在 schema.js 的 `drivableReason()`；
 *   · rid → 条目索引在 `buildActuatorRoutineIndex()`；
 *   · 这里只负责记忆索引 + 在发帧前抛错。
 * app.js 在启动时装载索引；coder.js 在 runRoutine 发帧前调用 `assertDrivableRoutine()`。
 * 4 个 runRoutine 调用点因此共用同一道闸，不需要各自抄判断。
 *
 * ⚠️ 库模式（未调用 `setRoutineGateItems()`）：默认放行，保持 Coder 作为独立库
 *   在 e2e / verify-runtime-safety 等脚本里的既有行为。app.js 一启动就把闸切到
 *   **严格模式**，此后「索引没装上」= 拒绝，绝不默认放行。
 */

import { drivableReason, buildActuatorRoutineIndex } from './schema.js';

/** rid → actuator 条目；null = 尚未装载。 */
let routineIndex = null;
/** app 装载过索引即为严格模式；此后缺数据 = 拒绝。 */
let strict = false;

/**
 * 装载（或替换）驱动闸索引，并切到严格模式。
 * @param {Array<object>} items data/actuator.json 的 items
 * @returns {number} 索引条目数
 */
export function setRoutineGateItems(items) {
  routineIndex = buildActuatorRoutineIndex(items);
  strict = true;
  return routineIndex.size;
}

/** 仅供测试：回到库模式（未装载索引），不要在生产代码里调用。 */
export function resetRoutineGateForTests() {
  routineIndex = null;
  strict = false;
}

/**
 * 查禁止理由。stop(0x02) / requestResults(0x03) 不带待猜参数，不受本闸约束 ——
 * 正在跑的例程必须仍然可以查结果和停止，否则闸本身会变成危险。
 *
 * ⚠️ 参数敏感（2026-11-17 回归修正）：`driveDisabled` 说的是「**这条 actuator 记录
 * 自己**构不出参数」，不是「任何 caller 都不得对该 RID 发 31」。原厂功能序列回放
 * 自带完整参数（如 `31 01 04 02 01`），是独立证据源，不是靠猜构帧。因此：
 *   · params 非空 ⇒ 放行（显式参数已由调用方定型）；
 *   · params 为空 ⇒ 按 driveDisabled 拦截（这正是被堵的空参裸帧）。
 * 早期版本不看 params，误伤了 186/687 条功能序列（其中 158 条自带参数）。
 *
 * @param {number} subFunc 子功能
 * @param {number} rid 例程 ID（十进制数）
 * 第二个例外是**来源**：`oemSequence=true` 表示整条 `31 <sub><rid><params>`
 * 是从原厂功能序列逐字节回放的命令（连空 params 也是原厂记录的原样形态），
 * 调用方没有猜任何东西。真实数据里 46 条序列的 52 个 31 帧正是这种
 * 「禁用 rid + 空 params」形态；若不认来源，零回归就做不到，而这 46 条
 * 功能本来是原厂能做的。除这个显式标记外，空 params 一律按原策略拒绝。
 *
 * @param {string} [params] 调用方给出的显式参数（十六进制串）
 * @param {{oemSequence?:boolean}} [opts] 来源标记；只有原厂序列回放会置 true
 * @returns {string|null} null=允许；字符串=禁止理由（来自数据的 driveDisabledReason）
 */
export function getRoutineGateReason(subFunc, rid, params = '', opts = {}) {
  if (subFunc === 0x02 || subFunc === 0x03) return null;
  if (String(params || '').replace(/\s/g, '').length > 0) return null;
  if (opts && opts.oemSequence === true) return null;
  // 空索引与未装载同等看待：app 启动时先 setRoutineGateItems([])，
  // fetch 回来之前必须拒绝，不能因为「索引是空 Map」就悄悄放行。
  if (!routineIndex || routineIndex.size === 0) {
    return strict ? '驱动策略数据未加载，拒绝执行例程（不许默认放行）' : null;
  }
  return drivableReason('routine', routineIndex.get(rid) || null);
}

/**
 * 发帧前断言；禁止时抛 Error（**在任何 `31` 帧发出之前**）。
 * @param {number} subFunc
 * @param {number} rid
 * @param {string} [params] 显式参数；非空即放行（见 getRoutineGateReason）
 * @param {{onDeny?:(message:string, reason:string)=>void, oemSequence?:boolean}} [opts]
 * @returns {null} 允许时返回 null
 * @throws {Error} 带数据里的理由
 */
export function assertDrivableRoutine(subFunc, rid, params = '', opts = {}) {
  const o = opts || {};
  const reason = getRoutineGateReason(subFunc, rid, params, o);
  if (!reason) return null;
  const message = `已禁用驱动：${reason}`;
  if (typeof o.onDeny === 'function') o.onDeny(message, reason);
  throw new Error(message);
}
