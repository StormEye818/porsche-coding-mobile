#!/usr/bin/env node
/**
 * verify-isotp-truncation.mjs —— ISO-TP **接收方向**（多帧截断）门禁。
 *
 * 断言名（供审计 / U-1 三件套引用）：`ISOTP_RX_TRUNCATION_REJECT`
 *
 * 守的是什么
 * ──────────
 * 实车日志 docs/realcar/2026-11-22-981-BCM-read-NRC31.txt 里 22F1A2 的应答原文
 *   `777100962F1A2303530`
 * = CAN ID 0x777 + ISO-TP 首帧 `10 09`（声明 9 字节）+ 只带 6 字节数据
 *   `62 F1 A2 30 35 30`，**没有连续帧**。
 * 431 回放向量 tools/align431-vectors/REPLAY_BCM.replay.json 的完整应答补上
 *   `7E8 21 30 31 38`，拼出 `62 F1 A2 30 35 30 30 31 38` = ASCII "050018"。
 *
 * 根因：uds() 里「正响应短路 return」排在「截断拒绝 throw」之前，而半包首字节
 * 恰是 0x62 (=wantResp)，于是缺连续帧的半包被当成功交回上层，剥头只剩 "050"。
 * 431 的做法是**读完整多帧才裁决，绝不拿半包当身份串**。
 *
 * 断言清单（全部真执行，不是字符串命中）
 * ──────────────────────────────────────
 *  ① parseRespAuto(truncated).kind === 'truncated'，且 expected=9 / received=6 /
 *     body 逐字节 = [62,F1,A2,30,35,30]（钉死诊断字段，防"改成 ok 也过"）
 *  ② 同一 raw 走真 Coder.uds()：必须抛 CodingError 且消息含「截断」，
 *     绝不返回半包；并显式记录该半包 body[0]===wantResp（证明走的正是旧 bug 路径）
 *  ③ 补连续帧后走真 Coder.uds()：不抛，body 逐字节 =
 *     [62,F1,A2,30,35,30,30,31,38]，剥 3 字节头 ASCII === "050018"
 *  ④ 反例：连续帧序号跳变（`21`→`22`）同样判 truncated，uds() 同样抛
 *
 * 反例注入（可证伪）：把 src/coder.js 里新的 truncated 保护挪回正响应短路之后
 * （或注释掉），重跑本脚本必须变红（② 由「抛」变「返回半包」）—— 证明门禁
 * 抓得到缺陷，不是恒真。注入演示由工程师手工执行并归档输出。
 *
 * 跑法：node tools/verify-isotp-truncation.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL
 */
import assert from 'node:assert/strict';
import { Coder, CodingError, parseRespAuto } from '../src/coder.js';

const NAME = 'ISOTP_RX_TRUNCATION_REJECT';
let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  assert.ok(c, `${n}${x ? ` — ${x}` : ''}`);
  pass++;
  console.log(`  ok   ${n}${x ? ` — ${x}` : ''}`);
};
const bad = (n, e) => {
  fail++;
  console.error(`  FAIL ${n}${e ? ` — ${e.message || e}` : ''}`);
};

/** 最小 fake ELM：cmd 恒返回指定原文，不实现分段（本门禁请求 ≤7B，走 SF）。 */
const elmFor = (raw) => ({
  mock: true,
  async cmd() { return raw; },
});
/** 十六进制串 → 字节数组 */
const bytesOf = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
/** 剥 3 字节正响应头后按 ASCII 解码 */
const asciiBody = (body) => body.slice(3).map((b) => String.fromCharCode(b & 0xff)).join('');

const TRUNC_RAW = '777100962F1A2303530';
const FULL_RAW = '7E8 10 09 62 F1 A2 30 35 30\r7E8 21 30 31 38';
const CF_BAD_RAW = '7E8 10 09 62 F1 A2 30 35 30\r7E8 22 30 31 38';
const REQ = '22F1A2';
const WANT_RESP = 0x62;

async function main() {
  console.log(`=== ${NAME} ===`);

  // ① parseRespAuto 对半包的诊断字段
  try {
    const p = parseRespAuto(TRUNC_RAW, REQ, 0x22);
    ok('①-a parseRespAuto(半包).kind=truncated', p.kind === 'truncated', `kind=${p.kind}`);
    ok('①-b 声明 9B / 实收 6B', p.expected === 9 && p.received === 6,
      `expected=${p.expected} received=${p.received}`);
    ok('①-c body 逐字节 = 62 F1 A2 30 35 30',
      JSON.stringify(p.body) === JSON.stringify(bytesOf('62 F1 A2 30 35 30')),
      JSON.stringify(p.body));
  } catch (e) { bad('① parseRespAuto 半包', e); }

  // ② uds 吃半包必须抛错（且那半包首字节恰是 wantResp —— 旧 bug 路径）
  try {
    const pre = parseRespAuto(TRUNC_RAW, REQ, 0x22);
    ok('②-前提 半包首字节 = wantResp(0x62)，旧短路会把它当成功',
      (pre.body[0] & 0xff) === WANT_RESP, `body[0]=0x${pre.body[0].toString(16)}`);
    let returned = null;
    let thrown = null;
    try {
      returned = await new Coder(elmFor(TRUNC_RAW), {
        tx: 0x7e0, rx: 0x777, ecuName: 'BCM', verbose: false,
      }).uds(REQ, 200);
    } catch (e) { thrown = e; }
    ok('②-a uds(半包) 绝不返回（必须抛）', returned === null,
      returned ? `错误地返回 ${JSON.stringify(returned)}` : '');
    ok('②-b 抛的是 CodingError', thrown instanceof CodingError || thrown?.name === 'CodingError',
      thrown ? `${thrown.name}: ${thrown.message}` : '未抛');
    ok('②-c 错误信息含「截断」/truncated',
      /截断|truncated/i.test(thrown?.message || ''), thrown?.message || '(无错误)');
  } catch (e) { bad('② uds 半包拒绝', e); }

  // ③ 补连续帧 → 完整 body，剥头 ASCII = 050018
  try {
    const r = await new Coder(elmFor(FULL_RAW), {
      tx: 0x7e0, rx: 0x7e8, ecuName: 'BCM', verbose: false,
    }).uds(REQ, 200);
    ok('③-a 完整多帧不抛且 kind=ok', r && r.kind === 'ok', `kind=${r?.kind}`);
    ok('③-b body 逐字节 = 62 F1 A2 30 35 30 30 31 38',
      JSON.stringify(r.body) === JSON.stringify(bytesOf('62 F1 A2 30 35 30 30 31 38')),
      JSON.stringify(r.body));
    ok('③-c 剥头 ASCII === "050018"', asciiBody(r.body) === '050018', asciiBody(r.body));
  } catch (e) { bad('③ 完整多帧', e); }

  // ④ 连续帧序号跳变同样拒绝
  try {
    const p = parseRespAuto(CF_BAD_RAW, REQ, 0x22);
    ok('④-a CF 序号跳变 → parseRespAuto truncated', p.kind === 'truncated', `kind=${p.kind}`);
    let returned = null;
    let thrown = null;
    try {
      returned = await new Coder(elmFor(CF_BAD_RAW), {
        tx: 0x7e0, rx: 0x7e8, ecuName: 'BCM', verbose: false,
      }).uds(REQ, 200);
    } catch (e) { thrown = e; }
    ok('④-b uds(CF跳变) 必抛、不返回半包', returned === null && thrown != null,
      returned ? `错误返回 ${JSON.stringify(returned)}` : (thrown?.message || ''));
  } catch (e) { bad('④ CF 序号跳变', e); }

  console.log(`--- ${NAME}: ${pass} PASS / ${fail} FAIL ---`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(`${NAME} 致命错误:`, e);
  process.exit(1);
});
