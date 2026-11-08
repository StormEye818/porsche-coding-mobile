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
import { pickVariantByPart, pickModelByName } from './src/variant.js';
import { familyOfItems, familyOfReadSid } from './src/coder.js';
import { resolveKey } from './src/seedkey-resolver.js';

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
  ok('ATCAF1 显式（ELM327 自动 ISO-TP PCI）', e.log.some(([c]) => c.includes('ATCAF1')) && !e.log.some(([c]) => c.includes('ATCAF0')));
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
console.log('\n[5] 写入闸门（参考诊断仪同款：只读项/缺 LID/越界/回读 —— 配对表已拆）');
{
  const base = { id: 't', module: 'M', byte: 0, bit: 0, bitsize: 8, level: 'source-defined' };
  const pReadOnly = { ...base, lid: 1, readSid: 0x22, writeSid: 0 };           // 无写服务
  const pBadWriteSid = { ...base, lid: 1, readSid: 0x1A, writeSid: 0x57 };     // 非写服务
  const pNoLid = { ...base };
  const p1a2e = { ...base, lid: 0x84, readSid: 0x1A, writeSid: 0x2E };         // 1a/2e 混族记录
  ok('只读项（writeSid=0）被拒', canWrite(pReadOnly) === false);
  ok('非写服务 writeSid=0x57 被拒（参考诊断仪写帧仅 3B/2E）', canWrite(pBadWriteSid) === false);
  ok('缺 LID 被拒', canWrite(pNoLid) === false);
  ok('1a/2e 记录 validateParam 不再拦（配对表已拆）', validateParam(p1a2e).length === 0);
  ok('1a/2e 记录 canWrite 放行（写走记录 writeSid）', canWrite(p1a2e) === true);
  ok('21/2E 配对表外记录也不再被 validateParam 拦',
    validateParam({ ...base, lid: 1, readSid: 0x21, writeSid: 0x2E }).length === 0);
  // 范围校验（max=null 不当 0）
  const check = (v, p) => (p.min != null && v < p.min) || (p.max != null && v > p.max);
  ok('max=null 时 v>0 不算超范围', check(5, { min: 0, max: null }) === false);
  ok('max=3 时 v=5 算超范围', check(5, { min: 0, max: 3 }) === true);
}

// ─────────────────────────────────────────────
console.log('\n[5b] 1a/2e 记录写入帧断言（出帧=2E 按记录格式，覆盖审计②）');
{
  const m = new MockAdapter({ latencyMs: 0, seedBytes: [0x12, 0x34] });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7E0, rx: 0x7E8 });
  c.seedKeyProvider = { name: 'test', verified: true, calc: () => new Uint8Array([0x12, 0x34]) };
  // 981 DME 1a/2e 记录形态：readSid=0x1A 读 `1A <LID8>`，writeSid=0x2E 写 `2E <DID16be> <data>`
  const p = {
    id: 't1a2e', module: 'DME_BDE_Continental', name: '日', byte: 0, bit: 0, bitsize: 8,
    min: 0, max: 255, level: 'source-defined', lid: 0x84, readSid: 0x1A, writeSid: 0x2E,
  };
  const r = await c.applyChange(p, 0x11, { dryRun: false, session: 0x89, secLevel: 0x09 });
  ok('1a/2e 写入成功（备份→写→回读）', !!r && r.dryRun === false && !!r.readback);
  const frames = m.txLog.filter((x) => !x.startsWith('AT'));
  ok('出帧=2E 按记录格式（2E + DID16be + data）', frames.some((f) => f.startsWith('2E0084')), frames.join(','));
  ok('读帧按记录 readSid=1A <LID8>', frames.includes('1A84'), frames.join(','));
  ok('无配对闸拒写痕迹（21↔3B 配对表已拆）', !frames.some((f) => f.startsWith('3B0084')), frames.join(','));
  ok('回读校验走同一记录读帧（再发 1A84）', frames.filter((f) => f === '1A84').length >= 2, frames.join(','));
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

// ─────────────────────────────────────────────
console.log('\n[7] 实车日志重放（14 款 Cayman 981 · VIN WP0AB2983EK190083 · DME KWP）');
{
  // ★ 任务清单⑥：mock-adapter 实车日志重放模式 —— 逐条重放用户日志的应答字节，
  //   断言我方发出的每帧与规格逐字节一致（RE-FLOWSPEC / RE-MODELADDR 逐条）。
  //   来源标注：〔日志〕=用户实车日志原字节；〔§〕=规格取证（JOB.BIN@~0xbc21 / RE-MODELADDR §1.5④）。
  const REPLAY_DME = [
    { req: '1089', resp: '7E8 02 50 89' },                                   // 〔日志〕10 89 正响应
    { req: '3E00', resp: '7E8 02 7E 00' },                                   // 保活 3E 00（会话后）
    { req: '1A9F', resp: '7E8 06 5A 9F 50 32 30 30' },                       // 〔日志〕1A 9F "P200"
    { req: '1A87', resp: '7E8 10 0D 5A 87 39 38 31 36\r7E8 21 31 38 36 34 30 31 35' },  // 〔日志〕1A 87=98161864015
    { req: '1A84', resp: 'NO DATA' },
    { req: '1A91', resp: 'NO DATA' },
    { req: '1A92', resp: '7E8 10 0D 5A 92 39 39 31 36\r7E8 21 31 38 36 30 32 30 33' },  // 〔§〕HW 件号 99161860203（JOB.BIN）
    { req: '1A93', resp: '7E8 05 5A 93 48 30 34' },                          // 〔§〕HW 版本 H04（JOB.BIN）
    { req: '1A94', resp: '7E8 10 0D 5A 94 39 38 31 36\r7E8 21 31 38 36 34 30 31 35' },  // 〔日志〕1A 94=98161864015
    { req: '1A95', resp: 'NO DATA' },
    { req: '1A97', resp: 'NO DATA' },
    { req: '1A9A', resp: 'NO DATA' },
    { req: '221102', resp: '7E8 0A 62 11 02 43 61 79 6D 61 6E 20' },        // 〔§1.5④〕22 11 02 应答名 "Cayman"
    { req: '1A90', resp: '7E810135A9057503041\r7E8214232393833454B\r7E822313930303833AA' }, // 〔日志〕1A 90 VIN 多帧
    { req: '21A4', resp: '7E8 05 61 A4 11 22 33' },                          // 编码块读（KWP 21 <LID8>）
  ];
  const m7 = new MockAdapter({ latencyMs: 0, replay: REPLAY_DME });
  const e7 = new Elm327(m7, { timeoutMs: 2000 });
  // 家族按通用规则从**记录 SID 字段**派生（familyOfItems）：981 DME 记录 21/3B 主导 → KWP 流
  const rec981 = JSON.parse(readFileSync('./data/models/Cayman_981_/DME_BDE_Continental_BaseSys.json', 'utf8'));
  const fam981 = familyOfItems(rec981.items);
  ok('KWP 车家族由记录 SID 派生（通用规则）', fam981 === 'kwp', fam981);
  const c7 = new Coder(e7, { tx: 0x7E0, rx: 0x7E8, ecuName: 'DME', family: fam981 });
  await c7.enterSession(0x89, { family: 'kwp' });
  const idn = await c7.readVehicleIdentity('kwp');
  await c7.readBlock(0xA4, 0x21).catch(() => null);
  const frames = m7.txLog.filter((c) => !c.startsWith('AT'));

  // ① 逐帧逐字节：与规格帧序一致（KWP 流 10 89 直接建会话 → 3E 00 → 识别链 §2.1 →
  //    主/备 22 11 02 → 备选链 1A 90 → 读码 21 A4）
  const golden = ['1089', '3E00', '1A9F', '1A87', '1A84', '1A91', '1A92', '1A93', '1A94',
    '1A95', '1A97', '1A9A', '221102', '1A90', '21A4'];
  ok('DME 帧序逐帧逐字节一致', JSON.stringify(frames) === JSON.stringify(golden),
    JSON.stringify(frames));
  ok('KWP 流不发 10 03（任务清单⑤）', !frames.includes('1003'));
  ok('识别链帧序=RE-FLOWSPEC §2.1（1A 9F→87→84→91→92→93→94→95→97→9A）',
    frames.slice(2, 12).join(',') === '1A9F,1A87,1A84,1A91,1A92,1A93,1A94,1A95,1A97,1A9A');
  ok('保活=3E 00（无 3E 80）', frames.includes('3E00') && !frames.includes('3E80'));
  ok('读码帧=KWP 21 <LID8>（2 字节帧）', frames.includes('21A4') && !frames.some((f) => /^22/.test(f) && f !== '221102'));

  // ② VIN / trim 显示（任务清单①）：显示=应答文本，981 → Cayman（981）
  ok('1A 90 VIN 多帧重组出完整 VIN', idn.vin === 'WP0AB2983EK190083', idn.vin);
  ok('22 11 02 应答文本=Cayman', idn.name === 'Cayman', idn.name);
  {
    const appSrc = readFileSync('./src/app.js', 'utf8');
    const grab = (name) => {
      const mm = appSrc.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
      return mm ? mm[0] : '';
    };
    const code = grab('isValidVin') + '\n' + grab('decodeVinYear') + '\n' + grab('guessModelFromVin');
    const fn = new Function('tree', code + '\nreturn {isValidVin, decodeVinYear, guessModelFromVin};');
    const { guessModelFromVin, decodeVinYear } = fn(null);
    const year = decodeVinYear(idn.vin);
    const g = guessModelFromVin(idn.vin, year);
    const byName = pickModelByName(g.models, idn.name);
    ok('显示=Cayman（981）（应答文本 strcmp 落定，非 Boxster）',
      !!byName && byName.name === 'Cayman（981）', byName && byName.name);
    const yy = String(year % 100).padStart(2, '0');
    ok('显示串=「14款 Cayman」（应答文本）', `${yy}款 ${idn.name}` === '14款 Cayman');
  }

  // ③ 变体（任务清单④）：件号 98161864015（1A 87/94 token）→ SDI9_1_981_3_4L_EU5
  ok('件号 token 采集自 1A 87/94', c7.lastPartTokens.includes('98161864015'),
    JSON.stringify(c7.lastPartTokens));
  {
    const pm = JSON.parse(readFileSync('./data/ecu-part-map.json', 'utf8'));
    const cat = JSON.parse(readFileSync('./data/models-catalog.json', 'utf8'));
    const names = (cat.models['Cayman（981）'].modules.find((mm) => mm.module === 'DME_BDE_Continental').variants || [])
      .map((v) => v.name);
    const picked = pickVariantByPart(pm.byPart, pm.byHwPart, {
      partNumber: c7.lastPartNo, partTokens: c7.lastPartTokens,
      hwPartNo: c7.lastHwPart, swText: c7.lastSwNo, swTable: pm.bySw,
      module: 'DME_BDE_Continental', variants: names,
    });
    ok('变体=SDI9_1_981_3_4L_EU5（98161864015 全等命中）',
      !!picked && picked.name === 'SDI9_1_981_3_4L_EU5', picked && `${picked.name}（${picked.how}）`);
    ok('匹配语义=全等命中（零件号精确命中）', !!picked && picked.how === '零件号精确命中', picked && picked.how);
  }

  // ④ mode 出参=原厂真值（2026-11-09 收口断言）：DME（P200，件号 98161864015，
  //    变体 SDI9_1_981_3_4L_EU5）。真值来源（逐指令）：条目 6B=[u16 blockKey][u32 recOff]，
  //    记录复合 u32@rec+0 → mode=低字节。金标按记录字节级独立取出：
  //    sysId 0x0b01 块首行 blockKey=0x0160 → rec@0x1F59 → u32@rec+0=0x03040208。
  {
    const dl = JSON.parse(readFileSync('./data/drivelinks.json', 'utf8'));
    const hit = dl.ecu['0x0b01'];
    const row = hit && hit[0];
    ok('981 DME mode 出参=原厂真值 0x08（记录 0x1F59 rec[0]，非 m 字段）',
      !!row && row.mode === 0x08, row && `mode=0x${(row.mode ?? -1).toString(16)}`);
    ok('981 DME 记录复合=0x03040208（mode 0x08 · 模板族 0x02 · 会话 0x0304）',
      !!row && row.mode === 0x08 && row.family === 0x02 && row.session === 0x0304,
      row && `0x${((row.session << 16) | (row.family << 8) | row.mode).toString(16)}`);
    ok('旧 m 字段=记录偏移低字节 0x59（垃圾 mode，已改名 recOffsetLo 防误用）',
      !!row && row.recOffsetLo === 0x59 && row.mode !== row.recOffsetLo,
      row && `recOffsetLo=0x${row.recOffsetLo.toString(16)} mode=0x${row.mode.toString(16)}`);
    const calc = resolveKey(row.mode, 0x12345678, { ecuId: '0x0b01' });
    ok('mode 0x08 可算 key（route=securityModel 内联，不拒不锁）',
      calc.outlen > 0 && calc.mode === 0x08, `${calc.algo} outlen=${calc.outlen}`);
  }

  // ── 进 IC（任务清单②）：tx ∈ 0x721/722/723 候选族，KWP 只发 21 01/1A xx ──
  const REPLAY_IC = [
    { req: '1089', resp: '7E8 02 50 89' },
    { req: '3E00', resp: '7E8 02 7E 00' },
    { req: '1A9F', resp: 'NO DATA' },       // KWP IC 识别静默（真车实证）
    { req: '1A87', resp: 'NO DATA' },
    { req: '1A84', resp: 'NO DATA' },
    { req: '2101', resp: '7E8 04 61 01 00 00' },
  ];
  const m7b = new MockAdapter({ latencyMs: 0, replay: REPLAY_IC });
  const e7b = new Elm327(m7b, { timeoutMs: 2000 });
  const c7b = new Coder(e7b, { tx: 0x721, rx: 0x729, ecuName: 'IC', family: 'kwp' });
  await c7b.enterSession(0x89, { family: 'kwp' });
  await c7b.readBlock(0x01, 0x21).catch(() => null);
  const fB = m7b.txLog.filter((c) => !c.startsWith('AT'));
  ok('IC 帧序逐帧一致（10 89→3E 00→识别链早停→21 01）',
    JSON.stringify(fB) === JSON.stringify(['1089', '3E00', '1A9F', '1A87', '1A84', '2101']), JSON.stringify(fB));
  ok('进 IC 的 tx 在 0x721/722/723 候选族', [0x721, 0x722, 0x723].includes(c7b.tx), c7b.tx.toString(16));
  ok('永不对 KWP 发 0x22（IC 全程无 22 xx）', !fB.some((f) => f.startsWith('22')));
  {
    const ea = JSON.parse(readFileSync('./data/ecu-addresses.json', 'utf8'));
    const ic = ea.entries.find((x) => x.sysId.toLowerCase() === '0x0b08');
    const txs = (ic.cands || []).map((x) => parseInt(x.tx, 16));
    ok('IC 候选表含 0x721/722/723（0x35F9 族）',
      [0x721, 0x722, 0x723].every((t) => txs.includes(t)), txs.map((t) => t.toString(16)).join(','));
    ok('internal 0x0117 UDS 簇短名单已删（无 0x77A 簇）', !txs.includes(0x77a) && !txs.includes(0x7c0));
  }

  // ── NRC（任务清单⑤）：7F 78 续等重发原帧；其余 NRC 单发不重试 ──
  const m7c = new MockAdapter({
    latencyMs: 0,
    replay: [
      { req: '21A1', resp: '7E8 03 7F 21 78' },   // 响应挂起 → 续等
      { req: '21A1', resp: '7E8 03 61 A1 99' },
      { req: '21A2', resp: '7E8 03 7F 21 12' },   // 服务级拒 → 单发即败
    ],
  });
  const c7c = new Coder(new Elm327(m7c, { timeoutMs: 2000 }), { tx: 0x7E0, rx: 0x7E8 });
  const blk78 = await c7c.readBlock(0xA1, 0x21).catch(() => null);
  ok('7F 78 续等后拿到正响应', !!blk78 && blk78[0] === 0x99, blk78 && blk78.map((b) => b.toString(16)).join(' '));
  const f78 = m7c.txLog.filter((c) => !c.startsWith('AT'));
  ok('续等重发帧与原帧逐字节一致', f78.filter((f) => f === '21A1').length === 2, JSON.stringify(f78));
  let nrcErr = null;
  await c7c.readBlock(0xA2, 0x21).catch((e) => { nrcErr = e; });
  const f78b = m7c.txLog.filter((c) => !c.startsWith('AT'));
  ok('其余 NRC 单发不重试（0x12 一次即败、错误上浮）',
    !!nrcErr && nrcErr.nrc === 0x12 && f78b.filter((f) => f === '21A2').length === 1,
    nrcErr && nrcErr.message);
  ok('重放模式零未命中（每帧都有脚本应答）', m7.replayMisses.length === 0 && m7b.replayMisses.length === 0
    && m7c.replayMisses.length === 0, JSON.stringify(m7.replayMisses));
}

{
  // ── UDS 车重放（718 流 · Boxster（982）· 22 11 02 直读成功路径）──
  //   家族同样由记录 SID 派生（BV_ECM_UDS 记录全 22/2E → UDS 流）；两套都逐帧断言。
  const rec718 = JSON.parse(readFileSync('./data/models/Boxster_982_/BV_ECM_UDS_BaseSys.json', 'utf8'));
  const fam718 = familyOfItems(rec718.items);
  ok('UDS 车家族由记录 SID 派生（BV_ECM_UDS 全 22/2E）', fam718 === 'uds', fam718);
  const it718 = rec718.items.find((x) => x && x.readSid === 0x22 && x.lid != null);
  const REPLAY_718 = [
    { req: '1003', resp: '7E8 02 50 03' },                                   // UDS 流=10 03（§1.3 另含）
    { req: '3E00', resp: '7E8 02 7E 00' },
    { req: '1A9F', resp: '7E8 06 5A 9F 50 32 30 30' },
    { req: '1A87', resp: 'NO DATA' },
    { req: '1A84', resp: 'NO DATA' },
    { req: '1A91', resp: 'NO DATA' },                                        // 3 miss 早停（§2.1）
    { req: '1089', resp: '7E8 02 50 89' },                                   // 编码主会话（§7④ 挂 10 89）
    { req: '221102', resp: '7E8 10 10 62 11 02 37 31 38\r7E8 21 20 42 6F 78 73 74 65\r7E8 22 72 20 54 AA AA AA AA' }, // 〔§1.5④同构〕22 11 02 直读 "718 Boxster T"
    { req: '1003', resp: '7E8 02 50 03' },                                   // 备选链模板 10 03（SYSP:0x56a66）
    { req: '22F190', resp: '7E8 10 14 62 F1 90 57 50 30\r7E8 21 5A 5A 5A 39 38 32 4A\r7E8 22 53 32 30 30 30 30 31' }, // 22 F1 90 直读 VIN
    { req: '220000', resp: '7E8 04 62 00 00 5A' },                           // 记录读（BV_ECM_UDS 5 块集 {00,28,29,2B,FE} 之 00）
  ];
  const m7d = new MockAdapter({ latencyMs: 0, replay: REPLAY_718 });
  const c7d = new Coder(new Elm327(m7d, { timeoutMs: 2000 }), { tx: 0x7E0, rx: 0x7E8, ecuName: 'DME', family: fam718 });
  await c7d.enterSession(0x89, { family: fam718 });
  const idn718 = await c7d.readVehicleIdentity(fam718);
  const did718 = it718 ? (it718.lid & 0xffff) : 0;
  await c7d.readBlock(did718, 0x22).catch(() => null);
  const f718 = m7d.txLog.filter((c) => !c.startsWith('AT'));
  const golden718 = ['1003', '3E00', '1A9F', '1A87', '1A84', '1A91', '1089', '221102', '1003', '22F190', '220000'];
  ok('UDS 车帧序逐帧逐字节一致（10 03 流）', JSON.stringify(f718) === JSON.stringify(golden718), JSON.stringify(f718));
  ok('UDS 流含 10 03（§1.3「UDS ECU 流另含」）', f718.includes('1003') && f718.includes('1089'));
  ok('22 11 02 直读成功（UDS 车应答文本）', idn718.name === '718 Boxster T', idn718.name);
  ok('22 F1 90 直读 VIN（UDS 车）', idn718.vin === 'WP0ZZZ982JS200001', idn718.vin);
  ok('UDS 记录读帧=22 <DID16>（3 字节帧，按记录）',
    f718.includes('220000') && f718.every((f) => !/^21[0-9A-F]{2}$/.test(f)));
  {
    const appSrc = readFileSync('./src/app.js', 'utf8');
    const grab = (name) => {
      const mm = appSrc.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
      return mm ? mm[0] : '';
    };
    const code = grab('isValidVin') + '\n' + grab('decodeVinYear') + '\n' + grab('guessModelFromVin');
    const fn = new Function('tree', code + '\nreturn {isValidVin, decodeVinYear, guessModelFromVin};');
    const { guessModelFromVin, decodeVinYear } = fn(null);
    const g718 = guessModelFromVin(idn718.vin, decodeVinYear(idn718.vin));
    const byName718 = pickModelByName(g718.models, idn718.name);
    ok('718 显示=Boxster（982）（应答文本落定）', !!byName718 && byName718.name === 'Boxster（982）',
      byName718 && byName718.name);
  }
  ok('familyOfReadSid 通用映射（21/1A→kwp，22→uds）',
    familyOfReadSid(0x21) === 'kwp' && familyOfReadSid(0x1A) === 'kwp' && familyOfReadSid(0x22) === 'uds');

  // ★ mode 出参=原厂真值（718 场景）：BV_ECM_UDS → sysId 0x0b01（模块名→ECU_ID 通用映射），
  //   条目行记录 u32 复合真值 —— 与 981 DME 同 ECU 族同真值，验证路由是**通用规则**
  //   （记录字节级取 mode，无车型/模块特判）。
  {
    const dl = JSON.parse(readFileSync('./data/drivelinks.json', 'utf8'));
    const { MODULE_TO_ECUID } = await import('./src/module-ecu-map.js');
    ok('718 模块→ECU_ID 通用映射（BV_ECM_UDS→0x0b01）',
      MODULE_TO_ECUID['BV_ECM_UDS'] === '0x0b01', MODULE_TO_ECUID['BV_ECM_UDS']);
    const row = dl.ecu[MODULE_TO_ECUID['BV_ECM_UDS']]?.[0];
    ok('718 BV_ECM_UDS mode 出参=原厂真值 0x08（记录 0x1F59 rec[0]）',
      !!row && row.mode === 0x08, row && `mode=0x${(row.mode ?? -1).toString(16)}`);
    ok('718 记录复合=0x03040208（mode 0x08 · 模板族 0x02 · 会话 0x0304）',
      !!row && row.mode === 0x08 && row.family === 0x02 && row.session === 0x0304,
      row && `0x${((row.session << 16) | (row.family << 8) | row.mode).toString(16)}`);
  }
}

console.log(`\n===== 端到端结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
