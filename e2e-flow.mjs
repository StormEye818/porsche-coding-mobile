#!/usr/bin/env node
/**
 * 端到端流程验证 —— 模拟车跑完整上车链路。
 *
 * 覆盖：连接 → 读 VIN → 定车型 → 进模块读编码 → 读版本信息 → 写入闸门
 * 跑法: node e2e-flow.mjs
 */
import { readFileSync } from 'node:fs';
import { MockAdapter } from './src/mock-adapter.js';
import { Elm327 } from './src/elm327.js';
import { Coder, parseResp } from './src/coder.js';
import { extractField, injectField, validateParam, canWrite } from './src/schema.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); }
};

// ─────────────────────────────────────────────
console.log('\n[1] 连接层');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const init = await e.init({ protocol: 6 });
  ok('ELM init 成功', !!init);
  ok('默认协议 ATSP6', e.log.some(([c]) => c.includes('ATSP6')));
  ok('ATCAF0 显式（parseResp 需要 PCI）', e.log.some(([c]) => c.includes('ATCAF0')));
  ok('流控 ATCFC1 + ATFCSD + ATFCSM0',
     e.log.some(([c]) => c.includes('ATCFC1')) && e.log.some(([c]) => c.includes('ATFCSD')) && e.log.some(([c]) => c.includes('ATFCSM0')));
  ok('无臆造 ATFC0', !e.log.some(([c]) => c.replace(/\r/g, '') === 'ATFC0'));
  ok('无 ATSP0（自动探测必失败）', !e.log.some(([c]) => c.includes('ATSP0')));
  ok('reqChain 串行锁存在', typeof e.reqChain?.then === 'function');
}

// ─────────────────────────────────────────────
console.log('\n[2] 解析层（ATS0/ATS1 双格式）');
{
  const cases = [
    ['ATS0 单帧 NRC', '7E8037F1012', 'nrc'],
    ['ATS1 单帧 NRC', '7E8 03 7F 10 12', 'nrc'],
    ['ATS0 正响应',   '7E8055A9F575030', 'ok'],
    ['ATS1 正响应',   '7E8 05 5A 9F 57 50 30', 'ok'],
    ['29位 ATS0',     '18DAF1100362F190', 'ok'],
    ['空',            '', 'empty'],
  ];
  for (const [n, raw, want] of cases) {
    const p = parseResp(raw);
    ok(n, p.kind === want, `kind=${p.kind}`);
  }
  // 多帧
  const ff = parseResp('7E8 10 14 62 F1 90 57 50 30');
  ok('多帧 FF 单独 → truncated', ff.kind === 'truncated');
  const part = parseResp('7E8 10 14 62 F1 90 57 50 30\n7E8 21 41 41 32 41 39 46 53');
  ok('FF+CF 不足 → truncated', part.kind === 'truncated' && part.body.length === 13, `kind=${part.kind} len=${part.body?.length}`);
  const both = parseResp('7E8 10 14 62 F1 90 57 50 30\n7E8 21 41 41 32 41 39 46 53\n7E8 22 53 31 32 33 34 35 36');
  ok('补满 20 字节 → ok', both.kind === 'ok' && both.body.length === 20, `kind=${both.kind} len=${both.body?.length}`);
}

// ─────────────────────────────────────────────
console.log('\n[3] 读 VIN → 定车型');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7E0, rx: 0x7E8 });
  await c.address();
  // 会话分级容错：10 03 失败不致命
  try { await c.uds('1003'); } catch (err) { console.log('    (10 03 拒绝，应继续)'); }
  // 读 VIN
  const blk = await c.readBlock(0xF190, 0x22).catch(() => null);
  ok('readBlock(0xF190, 0x22) 有返回', !!blk && blk.length > 0, `len=${blk?.length}`);
  // VIN 校验（复制 app 里的逻辑）
  const isValidVin = (v) => typeof v === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
  const vin = blk ? String.fromCharCode(...blk.slice(0, 17)).trim() : '';
  ok('VIN 长度 >= 17', vin.length >= 17, JSON.stringify(vin));
  ok('VIN 格式合法（或为空表示 mock 未造 VIN）', vin === '' || isValidVin(vin), JSON.stringify(vin));
}

// ─────────────────────────────────────────────
console.log('\n[4] 进模块读编码');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7E0, rx: 0x7E8 });
  c.seedKeyProvider = { name: 'test', verified: true, calc: () => new Uint8Array([0x12, 0x34]) };
  const blk = await c.readBlock(0x9A, 0x21).catch(() => null);
  ok('readBlock(0x9A, 0x21) 有返回', !!blk && blk.length > 0, `len=${blk?.length}`);
  // 位域提取
  const p = { id: 't', module: 'M', byte: 0, bit: 0, bitsize: 8, level: 'source-defined', lid: 0x9A, readSid: 0x21, writeSid: 0x3B };
  const errs = validateParam(p);
  ok('validateParam 通过', errs.length === 0, errs.join(','));
  if (blk) {
    const v = extractField(blk, p);
    ok('extractField 取值', typeof v === 'number');
    const back = injectField(blk, p, (v + 1) & 0xff);
    ok('injectField 回写', Array.isArray(back) && back.length === blk.length);
    ok('injectField 只改目标字节',
       back.filter((b, i) => b !== blk[i]).length <= 1);
  }
}

// ─────────────────────────────────────────────
console.log('\n[5] 写入闸门');
{
  const pReadOnly = { id: 't', module: 'M', byte: 0, bit: 0, bitsize: 8, level: 'source-defined', sidPairOk: false };
  const pNoLid = { id: 't', module: 'M', byte: 0, bit: 0, bitsize: 8, level: 'source-defined' };
  const pBad = { id: 't', module: 'M', byte: 0, bit: 0, bitsize: 8, level: 'source-defined', lid: 1, readSid: 0x21, writeSid: 0x2E };
  ok('只读项被拒', canWrite(pReadOnly) === false);
  ok('缺 LID 被拒', canWrite(pNoLid) === false);
  ok('SID 不配对被 validateParam 拦', validateParam(pBad).length > 0);
  // 范围校验（max=null 不当 0）
  const check = (v, p) => (p.min != null && v < p.min) || (p.max != null && v > p.max);
  ok('max=null 时 v>0 不算超范围', check(5, { min: 0, max: null }) === false);
  ok('max=3 时 v=5 算超范围', check(5, { min: 0, max: 3 }) === true);
}

// ─────────────────────────────────────────────
console.log('\n[6] 读版本信息');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7E0, rx: 0x7E8 });
  const LBL = { 0x84: 'ECU 零件号', 0x92: '硬件号', 0x93: '硬件版本', 0x95: '软件版本' };
  for (const id of Object.keys(LBL)) {
    const r = await c.uds('1A' + Number(id).toString(16).toUpperCase().padStart(2, '0'), 2000, { allowEmpty: true });
    let b = Array.from(r.body || []);
    if (b[0] === 0x5a) b = b.slice(2); else if (b[0] === 0x62) b = b.slice(3);
    while (b.length && [0x00, 0x20, 0xff].includes(b[b.length - 1])) b.pop();
    const txt = b.map((x) => (x >= 0x20 && x < 0x7f) ? String.fromCharCode(x) : '').join('').trim();
    ok(`${LBL[Number(id)]} 可读且无乱码`, txt.length > 0 && !txt.includes('!'), JSON.stringify(txt));
  }
}

console.log(`\n===== 端到端结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
