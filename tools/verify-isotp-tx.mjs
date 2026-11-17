#!/usr/bin/env node
/**
 * verify-isotp-tx.mjs —— ISO-TP **发送方向**（多帧分段）门禁。
 *
 * 断言名（供审计 / U-1 三件套引用）：`ISOTP_TX_SEGMENTATION_OEM`
 *
 * 守的是什么
 * ──────────
 * 经典 CAN 的 ISO-TP 单帧上限 = 7 字节，而我们的写请求全部越线
 * （`2F` 8 字节、原厂 `31` 最长 14 字节、`2E` 最长 261 字节）。
 * 把「加 PCI / 分段」委托给 ELM327 固件（ATCAF1）在这条链路上**不成立**
 * （vLinker MS 经 EA 通道不执行 ATCAF1，`coder.js` 有实车记录），
 * 所以 PCI 必须我们自己拼，且必须**一条不差**地发出去。
 *
 * 断言清单
 * ────────
 *  ⓪ `segmentPayload` 的边界定义：7 字节不分段 / 8 字节必须分段（**两侧都断言**，
 *     单侧断言抓不到 `>=7` / `>8` 这类差一错误）
 *  ① 8 字节执行器帧 `2F010103FF000000` → 恰 2 段 `10082F010103FF00` + `2100000000000000`，
 *     数据位拼回**逐字节相等**（68/71 实测 DID 都是这个形态）
 *  ② 原厂 14 字节例程帧 `3104027606F601010DD406EA0101` → 1 FF + 2 CF，拼回相等
 *  ③ 261 字节构造帧 → FF 长度位 `0x105`、段数 38（1 + ceil((261-6)/7)）、拼回相等
 *  ④ `stMin=20` → 相邻 CF 的实际间隔 ≥ 18ms（留 2ms 容差）
 *  ⑤ `blockSize=8` 且 mock 只在收满 block 后**异步**推送 FC → 我们必须在第 8 个 CF
 *     之后停下等 FC；没等就硬发会被丢帧。用「整条请求成功」证明我们**确实等了**
 *  ⑥ `fc.status=0x32`（溢出）→ 抛 `ISO_TP_TX_OVERFLOW`，且 mock 收到的 CF 数为 0
 *     （没有硬着头皮发完）
 *  ⑦ 适配器对 `ATCAF0` 回 `?` → 抛 `ISO_TP_TX_UNSUPPORTED`，且一条业务帧都没上总线
 *  ⑧ 反向自检：把 8 字节帧当单帧直接发（旧路径）在 `caf=0` 的 mock 上必须失败
 *     —— 证明这条门禁抓得到缺陷，不是恒真
 *  ⑨ 真代码路径：`coder.uds('2F010103FF000000')` → 分段 → mock 重组 → 拿到 `6F …`
 *  ⑩ SF 路径零变化：≤7 字节仍走 `cmd`，`txLog` 里**不出现** `ATCAF0`
 *  ⑪ `parseFlowControl` 的 STmin 换算（ms / 100µs 档 / 保留值 / 非 FC 帧）
 *  ⑫ **7 字节实测帧** `2FC000030A0301`（`0xC000` state `0A 03 01`）→ `needsSegmentation=false`
 *     → 走单帧，`segmentPayload` 只出 1 段 `072FC000030A0301`，线上零 `ATCAF0`
 *     —— 这条专防「把 ≤7 也强行分段」的回归（阈值错成 `>=7` 会在这里红）
 *  ⑬ **9 字节实测帧** `2F040103FFD8F07530`（`0x0401` state 5 字节）→ FF 长度位 `0x0009` + 1 CF
 *  ⑭ **11 字节实测帧** `2F040203FF64000009C402`（`0x0402` state 7 字节）→ FF 长度位 `0x000B` + 1 CF
 *  ⑮ **数据驱动**：`data/gag-actuators.json` 的 71 个 `2F` DID 逐条按 `state` 真长构帧，
 *     帧长分布必须是 `7×1 / 8×68 / 9×1 / 11×1`，分段判据与 `needsSegmentation` 逐条一致，
 *     且每条的段内数据位拼回**逐字节相等**（⇒ 70/71 越线，1 条单帧）
 *  ⑯ **真实 35 字节编码写载荷**（`2E 0021` + 32 字节块，即 `coder.applyChange` 实际发出的那条）
 *     → FF `10232E0021…` + 5 CF，拼回逐字节相等，且**适配器收到的原始帧序列 == 分段结果**
 *     （线上一条不多、一条不少）
 *
 * 跑法：node tools/verify-isotp-tx.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL
 */
import { readFileSync } from 'node:fs';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327, Elm327Error } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import {
  MAX_SF_PAYLOAD, CF_PAD_BYTE, needsSegmentation, segmentPayload, parseFlowControl,
} from '../src/isotp-tx.js';

const NAME = 'ISOTP_TX_SEGMENTATION_OEM';
let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' —— ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' —— ' + x : ''}`); }
};

const norm = (s) => String(s).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
/** 增量时刻：把 txLog 与 txTimes 按下标对齐，取出所有 CF 的发送时刻。 */
const cfTimes = (sim) => sim.txLog
  .map((t, i) => ({ t, at: sim.txTimes[i] }))
  .filter(({ t }) => /^2[0-9A-F]{15}$/.test(norm(t)))
  .map(({ at }) => at);
/** 把 mf 帧序列的「数据位」拼回去（按 FF 声明长度截断）。 */
const reassemble = (frames) => {
  const len = parseInt(frames[0].slice(0, 4), 16) & 0x0fff;
  const data = frames[0].slice(4) + frames.slice(1).map((f) => f.slice(2)).join('');
  return data.slice(0, len * 2);
};
/** 造确定性的长度载荷（字节 i = (i*7+3) & 0xFF），带 2E 前缀（业务上真会发的形状）。 */
const makeLong = (nBytes) => {
  const b = [0x2e, 0xf1, 0x90];
  while (b.length < nBytes) b.push((b.length * 7 + 3) & 0xff);
  return b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
};
/** 建一条只到适配器层的链路（不跑 init：本门禁不需要 400ms 的 ATZ 等待）。 */
const link = (opts = {}) => {
  const sim = new MockAdapter({ latencyMs: 0, ...opts });
  const elm = new Elm327(sim, { timeoutMs: 8000 });
  return { sim, elm };
};

console.log(`\n[${NAME}] ISO-TP 发送方向：PCI 自己拼、分段一条不差`);

// ── ⓪ 边界定义 ──
{
  const b7 = makeLong(7);
  const b8 = makeLong(8);
  const s7 = segmentPayload(b7);
  const s8 = segmentPayload(b8);
  ok(`⓪ SF/MF 边界 = 7 字节（MAX_SF_PAYLOAD=${MAX_SF_PAYLOAD}）：7B 走 SF、8B 必须分段`,
    needsSegmentation(b7) === false && needsSegmentation(b8) === true
    && s7.mode === 'sf' && s7.frames.length === 1 && norm(s7.frames[0]) === `07${b7}`
    && s8.mode === 'mf' && s8.frames.length === 2 && s7.length === 7 && s8.length === 8,
    `7B→${s7.frames[0]} / 8B→${s8.frames[0]}…`);
}

// ── ① 8 字节执行器帧 ──
{
  const payload = '2F010103FF000000';
  const seg = segmentPayload(payload);
  const want = ['10082F010103FF00', '2100000000000000'];
  const back = reassemble(seg.frames);
  ok('① 8B 执行器帧 2F010103FF000000 → 恰 2 段（FF 1008… + CF 2100…），数据位拼回逐字节相等',
    seg.mode === 'mf' && JSON.stringify(seg.frames) === JSON.stringify(want)
    && back === payload && seg.length === 8,
    `frames=${JSON.stringify(seg.frames)} 拼回=${back}${back === payload ? '' : ' ≠ ' + payload}`);
}

// ── ② 原厂 14 字节例程帧 ──
{
  const payload = '3104027606F601010DD406EA0101';
  const seg = segmentPayload(payload);
  const isFF = (f) => (parseInt(f.slice(0, 2), 16) >> 4) === 1;
  const isCF = (f) => (parseInt(f.slice(0, 2), 16) >> 4) === 2;
  const back = reassemble(seg.frames);
  ok('② 原厂 14B 例程帧（RID 0x0276 / recordIndex 1912）→ 1 FF + 2 CF，拼回逐字节相等',
    seg.length === 14 && seg.frames.length === 3
    && isFF(seg.frames[0]) && isCF(seg.frames[1]) && isCF(seg.frames[2])
    && seg.frames[0] === '100E3104027606F6' && back === payload,
    `frames=${JSON.stringify(seg.frames)} 拼回=${back}`);
}

// ── ③ 261 字节（最大编码写帧） ──
{
  const payload = makeLong(261);
  const seg = segmentPayload(payload);
  const ffLen = parseInt(seg.frames[0].slice(0, 4), 16) & 0x0fff;
  const expectSegs = 1 + Math.ceil((261 - 6) / 7);
  const back = reassemble(seg.frames);
  const last = seg.frames[seg.frames.length - 1];
  ok('③ 261B 构造帧 → FF 长度位 0x105、段数 38、末帧按 CF_PAD_BYTE 补满、拼回相等',
    ffLen === 0x105 && seg.frames.length === expectSegs && expectSegs === 38
    && back === payload && seg.frames[0].slice(0, 4) === '1105'
    && norm(last).endsWith(CF_PAD_BYTE.toString(16).padStart(2, '0')),
    `FF=${seg.frames[0].slice(0, 4)} 段数=${seg.frames.length}/${expectSegs} 末帧=${last} 拼回=${back === payload}`);
}

// ── ④ stMin 节拍 ──
{
  const { sim, elm } = link({ fc: { blockSize: 0, stMin: 20, status: 0 } });
  const payload = makeLong(100);                       // 14 个 CF，够测节拍
  let err = null;
  try { await elm.sendIsoTp(payload, 8000); } catch (e) { err = e; }
  const times = cfTimes(sim);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const minGap = gaps.length ? Math.min(...gaps) : -1;
  ok('④ stMin=20（FC 字节 0x14）→ 相邻 CF 实际间隔 ≥ 18ms（容差 2ms）',
    !err && cfTimes(sim).length === 14 && minGap >= 18 && sim.txPayloads.includes(payload),
    `CF 数=${times.length} 最小间隔=${minGap}ms（全部=${JSON.stringify(gaps.slice(0, 6))}…）`
      + ` err=${err ? err.message.slice(0, 40) : '无'}`);
}

// ── ⑤ blockSize：必须在 block 边界停下等 FC ──
{
  const { sim, elm } = link({ fc: { blockSize: 8, stMin: 0, status: 0 } });
  const payload = makeLong(100);                       // 14 个 CF → 8 + 6 两块
  let err = null;
  try { await elm.sendIsoTp(payload, 8000); } catch (e) { err = e; }
  const segs = sim.txFrames.length;
  ok('⑤ blockSize=8：第 8 个 CF 后停下等（异步推送的）FC，整条请求仍成功、零丢帧',
    !err && segs === 15 && sim.stats.txSegErrors === 0 && sim.txPayloads.includes(payload),
    `段数=${segs}（1 FF + 14 CF） 丢帧=${sim.stats.txSegErrors}`
      + ` 重组成功=${sim.txPayloads.includes(payload)} err=${err ? err.message.slice(0, 40) : '无'}`);
}

// ── ⑥ FC 溢出 ──
{
  const { sim, elm } = link({ fc: { blockSize: 0, stMin: 0, status: 0x32 } });
  const payload = makeLong(100);
  let err = null;
  try { await elm.sendIsoTp(payload, 8000); } catch (e) { err = e; }
  const cfSent = sim.txFrames.filter((f) => /^2/.test(f)).length;
  ok('⑥ FC status=0x32（溢出）→ 抛 ISO_TP_TX_OVERFLOW，CF 一个都没发（没硬着头皮发完）',
    !!err && err instanceof Elm327Error && err.code === 'ISO_TP_TX_OVERFLOW'
    && cfSent === 0 && sim.txFrames.length === 1,
    `code=${err ? err.code : '未抛错'} CF 数=${cfSent} 总段数=${sim.txFrames.length}`
      + `（应有 CF 数 ${Math.ceil((100 - 6) / 7)}）`);
}

// ── ⑦ ATCAF0 被拒 ──
{
  const { sim, elm } = link({ rejectAt: ['ATCAF0'] });
  let err = null;
  try { await elm.sendIsoTp('2F010103FF000000', 8000); } catch (e) { err = e; }
  const biz = sim.txLog.filter((c) => /^(2F|31|2E|10[0-9A-F]|21[0-9A-F])/i.test(norm(c)));
  ok('⑦ 适配器对 ATCAF0 回 ? → 抛 ISO_TP_TX_UNSUPPORTED，且一条业务帧都没上总线',
    !!err && err instanceof Elm327Error && err.code === 'ISO_TP_TX_UNSUPPORTED'
    && biz.length === 0 && sim.txFrames.length === 0,
    `code=${err ? err.code : '未抛错'} 业务帧=${biz.length} 分段帧=${sim.txFrames.length}`);
}

// ── ⑧ 反向自检：旧路径（8B 当单帧直发）必须失败 ──
{
  const { sim, elm } = link({ caf: 0 });               // 适配器已被关掉自动 PCI
  await elm.cmd('ATCAF0', 2000);
  let resp = '';
  let err = null;
  try { resp = await elm.cmd('2F010103FF000000', 2000); } catch (e) { err = e; }
  const positive = /6F/i.test(String(resp || '')) || /6F/.test(String(err && err.message));
  ok('⑧ 反向自检：把 8B 当单帧直发（旧路径）在 caf=0 上会被判「缺首帧」而失败 —— 门禁非恒真',
    sim.stats.txSegErrors >= 1 && !positive && /NO DATA/i.test(String(resp || '')),
    `resp=${JSON.stringify(String(resp || '').slice(0, 24))} 丢帧计数=${sim.stats.txSegErrors}`
      + ` 拿到 6F=${positive}`);
}

// ── ⑨ 真代码路径：coder.uds → sendIsoTp → mock 重组 → 6F ──
{
  const sim = new MockAdapter({ latencyMs: 0 });
  const elm = new Elm327(sim, { timeoutMs: 8000 });
  const coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: 'ISOTP门禁ECU', verbose: false });
  await coder.setAddress(0x7E0, 0x7E8, 'ISOTP门禁ECU');
  const before = sim.txLog.length;
  let res = null;
  let err = null;
  try { res = await coder.uds('2F010103FF000000', 8000); } catch (e) { err = e; }
  const segs = sim.txFrames.slice();
  const hadCaf0 = sim.txLog.slice(before).some((c) => /^ATCAF0$/i.test(c.trim()));
  const hadCaf1 = sim.txLog.slice(before).some((c) => /^ATCAF1$/i.test(c.trim()));
  ok('⑨ 真代码路径：coder.uds 发 8B 2F → ATCAF0 → FF+CF → mock 重组 → 6F 正响应',
    !err && !!res && res.body[0] === 0x6f
    && JSON.stringify(segs) === JSON.stringify(['10082F010103FF00', '2100000000000000'])
    && hadCaf0 && hadCaf1 && sim.txPayloads.includes('2F010103FF000000'),
    `响应=${res ? res.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') : '(无)'}`
      + ` 分段=${JSON.stringify(segs)} ATCAF0=${hadCaf0} ATCAF1恢复=${hadCaf1}`
      + ` err=${err ? err.message.slice(0, 40) : '无'}`);
}

// ── ⑩ SF 路径零变化 ──
{
  const { sim, elm } = link();
  let resp = '';
  try { resp = await elm.sendIsoTp('22F190', 3000); } catch (e) { resp = `ERR:${e.message}`; }
  const atCaf0 = sim.txLog.filter((c) => /^ATCAF0$/i.test(c.trim())).length;
  ok('⑩ ≤7 字节仍走 cmd（不改 caf）：txLog 里零 ATCAF0、零分段帧，帧原文逐字节不变',
    atCaf0 === 0 && sim.txFrames.length === 0
    && sim.txLog.some((c) => norm(c) === '22F190') && /62/i.test(String(resp)),
    `ATCAF0=${atCaf0} 分段帧=${sim.txFrames.length} TX=${JSON.stringify(sim.txLog.filter((c) => !c.startsWith('AT')))}`);
}

// ── ⑪ parseFlowControl / STmin 换算 ──
{
  const a = parseFlowControl('300000');
  const b = parseFlowControl('7E8 31 08 14');           // 带 CAN ID + WAIT + BS=8 + STmin=20
  const c = parseFlowControl('32 00 00');               // 溢出
  const d = parseFlowControl('30 00 F5');               // 500µs → 0.5ms
  const e = parseFlowControl('30 00 80');               // 保留值 → 0
  const f = parseFlowControl('02 6E 01');               // 不是 FC
  const g = parseFlowControl('33 00 00');               // status=3 保留 → null
  ok('⑪ parseFlowControl：CTS/WAIT/溢出/STmin(ms·100µs·保留)/带 CAN ID/非 FC 帧，全部按 ISO 15765-2 判',
    a && a.status === 0 && a.blockSize === 0 && a.stMinMs === 0
    && b && b.status === 1 && b.blockSize === 8 && b.stMinMs === 20
    && c && c.status === 2
    && d && d.stMinMs === 0.5
    && e && e.stMinMs === 0
    && f === null && g === null,
    `30 00 00→${JSON.stringify(a)} / 31 08 14→${JSON.stringify(b)} / 32→status ${c && c.status}`
      + ` / STmin F5=${d && d.stMinMs}ms / 80=${e && e.stMinMs} / 非FC=${f} / status3=${g}`);
}

// ── ⑫ 7 字节实测帧：必须走单帧，绝不强行分段 ──
// 证据：data/gag-actuators.json → DID 0xC000，drive.state「0A 03 01」（另有 00 03 01 / 01 03 01 两次观测），
//       帧长 = 2F(1) + DID(2) + controlOption(1) + state(3) = 7 ⇒ 落在 SF 上限内。
// 这是全仓库唯一一条 ≤7 的 2F 实测，专门钉住「阈值差一」：把 >7 写成 >=7 这里立刻红。
{
  const payload = '2FC000030A0301';
  const seg = segmentPayload(payload);
  const { sim, elm } = link();
  let err = null;
  try { await elm.sendIsoTp(payload, 3000); } catch (e) { err = e; }
  const atCaf0 = sim.txLog.filter((c) => /^ATCAF0$/i.test(norm(c))).length;
  ok('⑫ 7B 实测帧 2FC000030A0301（0xC000 state 0A 03 01）→ 不分段、单帧 072FC000030A0301、线上零 ATCAF0',
    needsSegmentation(payload) === false && seg.mode === 'sf'
    && seg.frames.length === 1 && seg.frames[0] === '072FC000030A0301'
    && seg.length === 7 && atCaf0 === 0 && sim.txFrames.length === 0
    && sim.txLog.some((c) => norm(c) === payload),
    `needsSegmentation=${needsSegmentation(payload)} frames=${JSON.stringify(seg.frames)}`
      + ` ATCAF0=${atCaf0} 分段帧=${sim.txFrames.length} err=${err ? err.message.slice(0, 32) : '无'}`);
}

// ── ⑬ / ⑭ 9B 与 11B 实测帧：state 长度可变，构帧不得假定 4 字节 ──
// 证据：0x0401 state「FF D8 F0 75 30」（5B ⇒ 帧 9B）、0x0402 state「FF 64 00 00 09 C4 02」（7B ⇒ 帧 11B）。
{
  const cases = [
    { did: '0x0401', payload: '2F040103FFD8F07530', len: 9, ff: '10092F040103FFD8', cf: '21F0753000000000' },
    { did: '0x0402', payload: '2F040203FF64000009C402', len: 11, ff: '100B2F040203FF64', cf: '21000009C4020000' },
  ];
  for (const [i, c] of cases.entries()) {
    const seg = segmentPayload(c.payload);
    const back = reassemble(seg.frames);
    const ffLen = parseInt(seg.frames[0].slice(0, 4), 16) & 0x0fff;
    ok(`${i === 0 ? '⑬' : '⑭'} ${c.len}B 实测帧 ${c.did}（state ${(c.len - 4)} 字节）→ FF 长度位 0x${c.len
      .toString(16).toUpperCase().padStart(4, '0')} + 1 CF，拼回逐字节相等`,
      seg.mode === 'mf' && seg.length === c.len && seg.frames.length === 2
      && ffLen === c.len && seg.frames[0] === c.ff && seg.frames[1] === c.cf
      && back === c.payload,
      `frames=${JSON.stringify(seg.frames)} 拼回=${back}${back === c.payload ? '' : ' ≠ ' + c.payload}`);
  }
}

// ── ⑮ 数据驱动：71 个 2F 实测 DID 逐条按 state 真长构帧 ──
// 为什么是 71 不是 150：150 是旧 data/actuator.json 里 form:'2f' 的**目录条目数**（且是塌缩版），
// 实测侧是 参考诊断仪导出 里 154 条 2F 请求按线上 DID 去重后的 71 个。帧长 = 4 + state 字节数。
{
  const gag = JSON.parse(readFileSync(new URL('../data/gag-actuators.json', import.meta.url), 'utf8'));
  const items = Array.isArray(gag.items) ? gag.items : [];
  const dist = {};
  let agreed = 0;
  let roundTrip = 0;
  const bad = [];
  for (const it of items) {
    const state = String((it.drive && it.drive.state) || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const ctrl = (it.drive && it.drive.controlOption != null) ? Number(it.drive.controlOption) : 3;
    const payload = `2F${String(it.didHex || '').replace(/^0x/i, '').toUpperCase().padStart(4, '0')}`
      + `${(ctrl & 0xff).toString(16).padStart(2, '0').toUpperCase()}${state}`;
    const len = payload.length / 2;
    dist[len] = (dist[len] || 0) + 1;
    const need = len > MAX_SF_PAYLOAD;
    const seg = segmentPayload(payload);
    if (needsSegmentation(payload) === need && (seg.mode === 'mf') === need
      && seg.length === len) agreed += 1;
    else bad.push(`${it.didHex}:len=${len}`);
    const back = seg.mode === 'sf' ? seg.frames[0].slice(2) : reassemble(seg.frames);
    if (back === payload) roundTrip += 1;
    else bad.push(`${it.didHex}:rt`);
  }
  const mf = items.filter((it) => {
    const state = String((it.drive && it.drive.state) || '').replace(/[^0-9A-Fa-f]/g, '');
    return 4 + state.length / 2 > MAX_SF_PAYLOAD;
  }).length;
  ok('⑮ 71 个 2F 实测 DID：帧长分布 7×1 / 8×68 / 9×1 / 11×1，分段判据逐条一致，拼回逐字节相等（⇒ 70/71 越线）',
    items.length === 71 && gag.count === 71
    && dist[7] === 1 && dist[8] === 68 && dist[9] === 1 && dist[11] === 1
    && agreed === 71 && roundTrip === 71 && bad.length === 0 && mf === 70,
    `items=${items.length} 分布=${JSON.stringify(dist)} 判据一致=${agreed}/71`
      + ` 拼回=${roundTrip}/71 需分段=${mf}/71${bad.length ? ' 异常=' + bad.join(',') : ''}`);
}

// ── ⑯ 真实 35 字节编码写载荷：线上帧序列必须与分段结果逐字节一致 ──
// 这条载荷就是 `coder.applyChange` 在「2E + DID 0x0021 + 32 字节块」上真正发出去的那条
// （fullchain 审计里 txLog 看到的分段形态就是它）。字节级正确性只在这里钉。
{
  const payload = '2E00215A531473F493D4B3B4D394F37413543334531473F493D4B3B4D394F374135433';
  const seg = segmentPayload(payload);
  const back = reassemble(seg.frames);
  const { sim, elm } = link();
  let err = null;
  try { await elm.sendIsoTp(payload, 8000); } catch (e) { err = e; }
  const onWire = sim.txFrames.join(',');
  ok('⑯ 真实 35B 编码写载荷（2E 0021 + 32B 块）→ FF 10232E0021… + 5 CF，拼回相等，且线上帧序列 == 分段结果',
    seg.length === 35 && seg.frames.length === 6 && seg.frames[0].slice(0, 10) === '10232E0021'
    && back === payload && !err && onWire === seg.frames.join(',')
    && sim.txPayloads.includes(payload) && sim.stats.txSegErrors === 0,
    `FF=${seg.frames[0]} 段数=${seg.frames.length}（应 6） 拼回=${back === payload}`
      + ` 线上一致=${onWire === seg.frames.join(',')} 丢帧=${sim.stats.txSegErrors}`
      + ` err=${err ? err.message.slice(0, 32) : '无'}`);
}

// ── ⑰ 反向自检：caf=0 下 `hooks.uds` 必须收到**重组后的业务载荷**，且只收 1 次 ──
// 为什么值得单独钉：`#txIsoTp` 曾经在「重组完成」处直接 `#uds(hexPayload)`，**旁路了
// `#dispatch`**（钩子）。后果是「钩写帧」的测试全部失效 —— 钩子看到的是 `1022…` 带 PCI
// 的首帧、`cmd.startsWith('3B')` 永不成立，报出来却是「写帧×0」，看起来像客户端没发。
// 这条断言把「钩子拿到的字符串」钉成业务载荷，而不是线上帧；把 `#dispatch` 改回 `#uds`
// 会立刻变红（实测见交付说明）。
{
  const seen = [];
  const { sim, elm } = link({ caf: 0, hooks: { uds: (cmd) => { seen.push(cmd); return undefined; } } });
  await elm.cmd('ATCAF0', 2000);
  const payload = makeLong(15);                        // 15B → FF + 2 CF = 3 段
  let err = null;
  try { await elm.sendIsoTp(payload, 8000); } catch (e) { err = e; }
  const wireSeg = sim.txFrames.slice();                // 分段那 3 帧（只看这一段）
  // 同一条 caf=0 链路上再发一条**单帧**（`02 3E 00`）：SF 必须剥 PCI 后才是 `3E00`。
  // 把 `06 3E 00` 原样交给业务层，业务层会把 0x06 当 SID 解析 —— 能解析、但答非所问。
  // ⚠️ 必须先重新 `ATCAF0`：`sendIsoTp` 的 `finally` 已经把 caf 恢复成 1 了。
  let sfResp = '';
  try {
    await elm.cmd('ATCAF0', 2000);
    sfResp = await elm.cmd('023E00', 2000);
  } catch (e) { sfResp = `ERR:${e.message}`; }
  ok('⑰ caf=0 下 hooks.uds 收到的是**重组后的业务载荷**（分段 1 次 + 单帧剥 PCI 1 次，且不等于任何一段线上帧）',
    seen.length === 2 && seen[0] === payload && seen[1] === '3E00'
    && wireSeg.length === 3 && !wireSeg.includes(seen[0] || '\u0000')
    && wireSeg.join('') !== payload && sim.txPayloads.includes(payload)
    && sim.txFrames[3] === '023E00',                 // 线上仍是带 PCI 的单帧
    `钩子调用=${seen.length} 次 载荷相符=${seen[0] === payload} 单帧剥 PCI=${JSON.stringify(seen[1])}`
      + ` 分段帧=${JSON.stringify(wireSeg)} 钩子拿到=${JSON.stringify((seen[0] || '').slice(0, 24))}…`
      + ` err=${err ? err.message.slice(0, 32) : '无'} sfResp=${JSON.stringify(String(sfResp).slice(0, 16))}`);
}

console.log(`\n===== ${NAME}: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);