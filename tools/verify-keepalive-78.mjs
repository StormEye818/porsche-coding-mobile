#!/usr/bin/env node
/**
 * verify-keepalive-78.mjs —— `7F <sid> 78`（responsePending）语义门禁。
 *
 * 断言名（供审计/U-1 三件套引用）：`KEEPALIVE_78_SINGLE_SEND`
 *
 * 守的是什么
 * ──────────
 * 78 的语义是「ECU **已受理**、正在处理」，**不是**「没收到」。
 * 因此我方在任何情况下都不得因为 78 而重发原请求帧：
 *   · `31 01` 重发 = 重启例程（非幂等，会毁掉正在跑的长例程）
 *   · `2E/3B` 重发 = 重复写入
 *   · `27` 重发   = 重复提交 key
 *   · `2F/17/11/14` 重发 = 重复执行动作
 * 正确做法：补发保活帧 `3E 00`，逐轮扫描该轮收到的**所有**帧，等 ECU 把最终响应
 * 带出来；等不到就报「结果不明」并要求回读核验 —— **不重试**。
 *
 * 夹具契约（MockAdapter.delay78，仅测试用）
 * ────────────────────────────────────────
 *   new MockAdapter({ delay78: { nrcTimes, frames, keepAliveNrc } })
 *     · 第 1 次收到原请求 → `7F <sid> 78`；此后每收一帧再回一次 78，直到用完 nrcTimes
 *     · 用完之后的**下一帧**：应答 = 「该帧自己的正常应答」+ `\r` + `frames` 各帧
 *     · `frames` 省略 → 用原请求的正常应答
 *   `coder.keepAliveMs` 被本门禁设成 **10ms**（默认 2500ms 会让一条用例白等 2.5s×N 轮）。
 *
 * 6 条行为断言（全部观测我方真实上总线的字节，不看源码文本）
 * ─────────────────────────────────────────────────────────────
 *   A1  `78 → 78 → 6E …` 写帧在 txLog 里**恰好出现 1 次**
 *   A2  `3E00` 恰好出现 **2 次**，且保活应答（`7E 00`）被正确忽略
 *       —— 返回值必须是原请求的正响应，不是保活帧的应答
 *   A3  `31 01` 在 78 下同样**只出现 1 次**，且不在本层续等（78 上浮给 `31 03` 轮询）
 *   A4  续等耗尽 → 抛错且文案含「结果不明」，写帧仍**只出现 1 次**
 *   A5  无 78 的正常路径**零保活帧**，且 `KEEPALIVE_MS` 满足 ISO 14229-2 S3server/2
 *   A6  保活帧自己回 `7F 3E 12`（NRC）时，**不得**被当成本请求失败；最终仍拿到正响应
 *
 * 跑法: node tools/verify-keepalive-78.mjs
 * 退出码: 0 = 全绿；1 = 有 FAIL
 */
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder, CodingError, KEEPALIVE_MS, MAX_PENDING_MS } from '../src/coder.js';

const NAME = 'KEEPALIVE_78_SINGLE_SEND';
const TEST_KA_MS = 10;              // 测试用保活节拍（避免白等）
let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' —— ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' —— ' + x : ''}`); }
};

/** 建一条「模拟 ECU + ELM327 + Coder」的真代码路径链路。 */
async function link(ecuOpts = {}) {
  const ecu = new MockAdapter({ latencyMs: 0, ...ecuOpts });
  const elm = new Elm327(ecu, { timeoutMs: 3000 });
  await elm.init({ protocol: 6 });
  const coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: '78门禁ECU', verbose: false });
  coder.keepAliveMs = TEST_KA_MS;
  await coder.setAddress(0x7E0, 0x7E8, '78门禁ECU');
  return { ecu, elm, coder };
}

/** 归一化一条上总线命令，用于逐字节比对。 */
const norm = (s) => String(s).replace(/\s+/g, '').toUpperCase();
/** 统计从 mark 之后发出的某帧次数。 */
const countTx = (ecu, frame, mark = 0) => ecu.txLog.slice(mark).filter((t) => norm(t) === frame).length;
/** 字节数组 → 空格分隔大写 hex。 */
const hex = (body) => (body ? body.map((b) => b.toString(16).padStart(2, '0')).join(' ') : '(无)');

const SID2E_WRITE = '2E0102AABB';   // UDS 写帧（写 2 字节 DID 0x0102）
const SID31_START = '31010107';     // 例程启动（非幂等，最不能重发）
const WRITE_OK = '6E 01 02';        // 上面写帧的正常正响应

console.log(`\n[${NAME}] 7F 78 = 已受理待处理，只续等、绝不重发原帧`);
console.log(`  · KEEPALIVE_MS=${KEEPALIVE_MS}ms（我方设计值 = ISO 14229-2 S3server 5000ms 的一半，`
  + '非原厂取证值）· 本门禁运行时覆盖为 ' + TEST_KA_MS + 'ms');
console.log(`  · MAX_PENDING_MS=${MAX_PENDING_MS}ms（78 续等总上限）`);

// ── A1 + A2：写帧在 78→78→6E 下只发一次；3E00 恰好两次；保活应答被忽略 ──
{
  const { ecu, coder } = await link({ delay78: { nrcTimes: 2, frames: [WRITE_OK], delayMs: 0 } });
  const mark = ecu.txLog.length;
  let res = null;
  let err = null;
  try {
    res = await coder.uds(SID2E_WRITE, 8000, { pendingWait: true });
  } catch (e) { err = e; }
  const writeTx = countTx(ecu, SID2E_WRITE, mark);
  const kaTx = countTx(ecu, '3E00', mark);

  ok('A1 写帧 2E 在 78→78→6E 全程只上总线 1 次（重发即重复写入）',
    !err && writeTx === 1,
    `txLog 计数=${writeTx} / 3E00=${kaTx} / err=${err ? err.message.slice(0, 40) : '无'}`);

  // 返回的必须是**原请求**的正响应：6E 01 02；不能是保活帧的 7E 00
  ok('A2 保活帧 3E00 恰好发 2 次，且其应答被忽略（拿到的是 6E 而不是 7E）',
    !err && kaTx === 2 && !!res && res.body[0] === 0x6e && res.pendingRounds === 2 && res.sliceUsed === true,
    `3E00 计数=${kaTx} / 最终响应=${hex(res && res.body)} / pendingRounds=${res ? res.pendingRounds : 'n-a'}`
      + ` / sliceUsed=${res ? res.sliceUsed : 'n-a'}`);
}

// ── A3：31 01 在 78 下同样只发一次（不续等、不保活、错误上浮去走 31 03 轮询） ──
{
  const { ecu, coder } = await link({ delay78: { nrcTimes: 3, delayMs: 0 } });
  const mark = ecu.txLog.length;
  let err = null;
  try {
    await coder.uds(SID31_START, 3000);          // 例程层**不传** pendingWait
  } catch (e) { err = e; }
  const startTx = countTx(ecu, SID31_START, mark);
  const kaTx = countTx(ecu, '3E00', mark);

  ok('A3 例程启动 31 01 在 78 下只上总线 1 次，且不在此层续等（78 上浮给 31 03 轮询）',
    !!err && err instanceof CodingError && err.nrc === 0x78 && startTx === 1 && kaTx === 0,
    `31 01 计数=${startTx} / 3E00 计数=${kaTx} / nrc=${err ? err.nrc : '无'}`);
}

// ── A4：续等耗尽 → 「结果不明」，写帧仍只发一次 ──
{
  const { ecu, coder } = await link({ delay78: { nrcTimes: 999, delayMs: 0 } });
  const mark = ecu.txLog.length;
  let err = null;
  let res = null;
  const t0 = Date.now();
  try {
    res = await coder.uds(SID2E_WRITE, 8000, { pendingWait: true, maxPendingMs: 400 });
  } catch (e) { err = e; }
  const elapsed = Date.now() - t0;
  const writeTx = countTx(ecu, SID2E_WRITE, mark);
  const kaTx = countTx(ecu, '3E00', mark);

  ok('A4 续等耗尽抛「结果不明」且写帧仍只上总线 1 次（禁止自动重试）',
    !!err && /结果不明/.test(err.message) && err.nrc === 0x78 && writeTx === 1 && !res,
    `写帧计数=${writeTx} / 3E00 计数=${kaTx} / 用时=${elapsed}ms / 文案=${err ? err.message.slice(0, 44) + '…' : '未抛错'}`);
}

// ── A5：无 78 的正常路径零保活帧（不侵入常规收发）+ 常量约束 ──
{
  const { ecu, coder } = await link();
  const defaultKa = new Coder(new Elm327(new MockAdapter({ latencyMs: 0 }), { timeoutMs: 3000 }),
    { tx: 0x7E0, rx: 0x7E8 }).keepAliveMs;
  const mark = ecu.txLog.length;
  let res = null;
  let err = null;
  try {
    res = await coder.uds('22F190', 3000, { pendingWait: true });   // 读 VIN，ECU 秒回
  } catch (e) { err = e; }
  const kaTx = countTx(ecu, '3E00', mark);
  const readTx = countTx(ecu, '22F190', mark);

  ok('A5 无 78 的正常读：零保活帧、读帧 1 次、正响应直达；且 0 < KEEPALIVE_MS ≤ 2500（S3server/2）',
    !err && kaTx === 0 && readTx === 1 && !!res && res.body[0] === 0x62
      && KEEPALIVE_MS > 0 && KEEPALIVE_MS <= 2500 && MAX_PENDING_MS >= KEEPALIVE_MS
      && defaultKa === KEEPALIVE_MS,
    `3E00 计数=${kaTx} / 读帧计数=${readTx} / 首字节=0x${res && res.body ? res.body[0].toString(16) : '--'}`
      + ` / KEEPALIVE_MS=${KEEPALIVE_MS} / 实例默认=${defaultKa}`);
}

// ── A6：保活帧自己回 NRC（7F 3E 12）不得被当成本请求失败 ──
{
  const { ecu, coder } = await link({
    delay78: { nrcTimes: 1, frames: [WRITE_OK], delayMs: 0, keepAliveNrc: 0x12 },
  });
  const mark = ecu.txLog.length;
  let res = null;
  let err = null;
  try {
    res = await coder.uds(SID2E_WRITE, 8000, { pendingWait: true });
  } catch (e) { err = e; }
  const writeTx = countTx(ecu, SID2E_WRITE, mark);
  const kaTx = countTx(ecu, '3E00', mark);

  ok('A6 保活帧自报 7F 3E 12 不算本请求失败（findNrcFor 按 reqSid 过滤），仍拿到 6E',
    !err && writeTx === 1 && kaTx === 1 && !!res && res.body[0] === 0x6e && res.pendingRounds === 1,
    `写帧=${writeTx} / 3E00=${kaTx} / 响应=${hex(res && res.body)}`
      + ` / err=${err ? err.message.slice(0, 40) : '无'}`);
}

console.log(`\n===== ${NAME}: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
