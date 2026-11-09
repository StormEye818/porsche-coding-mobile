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
import { pickVariantByPart, pickModelByName, pickFamilyByEvidence, designationFrom } from './src/variant.js';
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
  // ★ 2026-11-09 验收重放（🔴 从真日志建 fixture，常驻回归）：应答字节=用户日志原字节。
  //   标注：〔日志〕=真车日志字节；〔日志·车名链〕=车名键指认（RE-TRACEABILITY-20261109.md：
  //   SYSP:0x2a4b4 0x55 分支留存键=21 51，1A 9B/21 50 发后即清）。
  const REPLAY_DME = [
    { req: '1089', resp: '7E8 02 50 89' },                                   // 〔日志〕10 89 正响应
    { req: '3E00', resp: '7E8 02 7E 00' },                                   // 保活 3E 00（会话后）
    { req: '1A9F', resp: '7E8 06 5A 9F 50 32 30 30' },                       // 〔日志〕1A 9F "P200"
    { req: '1A87', resp: '7E8 10 0D 5A 87 39 38 31 36\r7E8 21 31 38 36 34 30 31 35' },  // 〔日志〕1A 87=98161864015
    { req: '1A84', resp: 'NO DATA' },
    { req: '1A91', resp: '7E8 10 0D 5A 91 39 39 31 36\r7E8 21 31 38 36 30 32 30 33' },  // 〔日志〕1A 91=99161860203（HW 件号）
    { req: '1A92', resp: 'NO DATA' },
    { req: '1A93', resp: '7E8 05 5A 93 48 30 34' },                          // 〔日志〕1A 93=H04（HW 版本）
    { req: '1A94', resp: '7E8 10 0D 5A 94 39 38 31 36\r7E8 21 31 38 36 34 30 31 35' },  // 〔日志〕1A 94=98161864015
    { req: '1A95', resp: 'NO DATA' },
    { req: '1A97', resp: 'NO DATA' },
    { req: '1A9A', resp: 'NO DATA' },
    { req: '221102', resp: '7E8 03 7F 22 12' },                              // 〔日志〕22 11 02 → NRC 0x12（DME 拒 0x22）
    { req: '221101', resp: '7E8 03 7F 22 12' },                              // 〔日志〕备链 22 11 01 同拒
    { req: '1A90', resp: '7E810135A9057503041\r7E8214232393833454B\r7E822313930303833AA' }, // 〔日志〕1A 90 VIN 多帧
    { req: '1A87', resp: '7E8 10 0D 5A 87 39 38 31 36\r7E8 21 31 38 36 34 30 31 35' },  // 〔日志〕名链再发（确定性 ECU 同应答；fire-and-forget）
    { req: '1A9B', resp: 'NO DATA' },                                        // 〔日志〕fire-and-forget（0x55 分支发后即清）
    { req: '2150', resp: 'NO DATA' },                                        // 〔日志〕fire-and-forget（同上）
    { req: '2151', resp: '7E8 08 61 51 43 61 79 6D 61 6E' },                 // 〔日志·车名链〕21 51="Cayman"（0x55 分支留存键，SYSP:0x2a4b4）
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

  // ① 逐帧逐字节：与真日志帧序一致（KWP 流 10 89 直接建会话 → 3E 00 → 识别链 §2.1 →
  //    主/备 22 11 02/11 01（真日志双双 NRC 0x12）→ 名链 1A 90/1A 87/1A 9B/21 50/21 51
  //    （留存键=1A 90+21 51，SYSP:0x2a4b4 分支）→ 读码 21 A4）
  const golden = ['1089', '3E00', '1A9F', '1A87', '1A84', '1A91', '1A92', '1A93', '1A94',
    '1A95', '1A97', '1A9A', '221102', '221101', '1A90', '1A87', '1A9B', '2150', '2151', '21A4'];
  ok('DME 帧序逐帧逐字节一致', JSON.stringify(frames) === JSON.stringify(golden),
    JSON.stringify(frames));
  ok('KWP 流不发 10 03（任务清单⑤）', !frames.includes('1003'));
  ok('识别链帧序=RE-FLOWSPEC §2.1（1A 9F→87→84→91→92→93→94→95→97→9A）',
    frames.slice(2, 12).join(',') === '1A9F,1A87,1A84,1A91,1A92,1A93,1A94,1A95,1A97,1A9A');
  ok('保活=3E 00（无 3E 80）', frames.includes('3E00') && !frames.includes('3E80'));
  // 🔴③ 读出帧=21 <LID8> 系（绝无 22 00xx DID 读；22 11 02/11 01=车名对请求，RE-MODELADDR §2.5 双请求）
  ok('🔴③ 读码帧=KWP 21 <LID8> 系（绝无 22 00xx）', frames.includes('21A4')
    && !frames.some((f) => /^2200/.test(f))
    && !frames.some((f) => /^22/.test(f) && f !== '221102' && f !== '221101'));

  // ② VIN / trim 显示（🔴 验收断言①）：显示名=Cayman（14款 Cayman）
  ok('1A 90 VIN 多帧重组出完整 VIN', idn.vin === 'WP0AB2983EK190083', idn.vin);
  ok('🔴① 车名=21 51 留存应答（0x55 分支指认，SYSP:0x2a4b4）=Cayman',
    idn.name === 'Cayman' && idn.nameSrc === '2151', `${idn.name}/${idn.nameSrc}`);
  ok('🔴④ 1A 87（件号 98161864015）不进车名', !String(idn.name).includes('98161864015'), idn.name);
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
    const desig = designationFrom(year, idn.name);
    ok('🔴① 显示串=「14款 Cayman」', desig === '14款 Cayman', desig);
    ok('🔴④ 显示串不含 1A 87 件号', !desig.includes('98161864015'), desig);
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

  // 🔴② 数据家族+变体 = 选择层（识别串优先→件号→协议族兜底，pickFamilyByEvidence 真代码路径）：
  //   候选=菜单 ECM/DME 条目（menu-tree-v3 真数据），识别串 P200 + 件号 98161864015 →
  //   DME_BDE_Continental / SDI9_1_981_3_4L_EU5（事故里落错 BV_ECM_UDS 的对侧）。
  {
    const reg = JSON.parse(readFileSync('./data/ident-registry.json', 'utf8'));
    const mf = JSON.parse(readFileSync('./data/module-family.json', 'utf8'));
    const cat = JSON.parse(readFileSync('./data/models-catalog.json', 'utf8'));
    const mt3 = JSON.parse(readFileSync('./data/menu-tree-v3.json', 'utf8'));
    let menuMods = null;
    for (const g of mt3.groups || []) for (const m of g.models || []) {
      if (m.id === 'Cayman（981）') for (const fn of m.functions || []) for (const s of fn.systems || []) {
        if (/ECM\/DME/.test(s.label)) menuMods = s.modules;
      }
    }
    ok('ECM 菜单候选含事故双家族（BV_ECM_UDS + DME_BDE_Continental）',
      !!menuMods && menuMods.includes('BV_ECM_UDS') && menuMods.includes('DME_BDE_Continental'),
      JSON.stringify(menuMods));
    const entries = (menuMods || []).map((mod) => ({ mod, mi: (cat.models['Cayman（981）'].modules || []).find((x) => x.module === mod) })).filter((e) => e.mi);
    const pick = pickFamilyByEvidence(entries, {
      identTokens: ['P200'],
      partNo: '98161864015', partTokens: c7.lastPartTokens,
      registry: reg, byPart: JSON.parse(readFileSync('./data/ecu-part-map.json', 'utf8')).byPart,
      moduleFamily: mf, observedFamily: 'kwp',
    });
    ok('🔴② 数据家族=DME_BDE_Continental（识别串 P200→件号 98161864015）',
      pick.mod === 'DME_BDE_Continental', pick.how);
    ok('🔴② 变体=SDI9_1_981_3_4L_EU5', pick.variant === 'SDI9_1_981_3_4L_EU5', String(pick.variant));
    // 识别串单证据也必须把家族收窄到含 DME（协议族 kwp 兜底排掉 BV_ECM_UDS 全 UDS 族）
    const pickIdentOnly = pickFamilyByEvidence(entries, {
      identTokens: ['P200'], registry: reg, moduleFamily: mf, observedFamily: 'kwp',
    });
    ok('🔴② 识别串单证据+协议族兜底 → 仍 DME_BDE_Continental（不落 BV_ECM_UDS）',
      pickIdentOnly.mod === 'DME_BDE_Continental', pickIdentOnly.how);
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

  // ── 进 IC（KWP 家族）：KWP 只发 21 01/1A xx，永不对 KWP 发 0x22 ──
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
  ok('永不对 KWP 发 0x22（IC 全程无 22 xx）', !fB.some((f) => f.startsWith('22')));
  {
    const ea = JSON.parse(readFileSync('./data/ecu-addresses.json', 'utf8'));
    const ic = ea.entries.find((x) => x.sysId.toLowerCase() === '0x0b08');
    const txs = (ic.cands || []).map((x) => parseInt(x.tx, 16));
    // ★ 2026-11-09 RE-ICADDR：0x721/722/723（低字节 join 族）真车 NO DATA 已证伪 ——
    //   KWP IC internal 0x02F9 无精确表A 行 = joinState 未决，不再入候选。
    ok('IC 候选不含 0x721/722/723（低字节 join 已证伪退役）',
      ![0x721, 0x722, 0x723].some((t) => txs.includes(t)), txs.map((t) => t.toString(16)).join(','));
    ok('KWP IC 0x02F9 joinState=unresolved/partial（表B 行证据落档）',
      ['unresolved', 'partial'].includes(ic.joinState)
      && (ic.joinUnresolved || []).some((u) => u.internal === '0x02F9'),
      JSON.stringify(ic.joinUnresolved));
    ok('internal 0x0117 UDS 簇短名单已删（无 0x77A 簇）', !txs.includes(0x77a) && !txs.includes(0x7c0));
  }

  // ── IC 地址断言（mock 命中族中位）：假发现循环应答 + IC 绑定结果 ──
  //   发现循环（参考诊断仪 转写，RE-ICADDR §3.2）：候选源=SpecArray/表行（本例=14B 记录族 0x71E-0x725
  //   + 表行序 0x7F1），帧=21 01/1A xx（KWP）；身份=识别串 Kombi/仪表 语义匹配（GetSubSysDataAddr
  //   strcmp/前缀/strstr）；NRC 地址（0x7F1 形态）=有 ECU 身份不符不算候选；NO DATA=候选死换下一个。
  //   mock 假发现循环在族中位 0x722 应答身份串 → 断言 IC 绑定结果（tx/rx 对 + 身份）。
  {
    const fam = [0x71E, 0x71F, 0x720, 0x721, 0x722, 0x723, 0x724, 0x725];
    const median = fam[Math.floor(fam.length / 2)];   // 0x722
    ok('族中位定义（DRIVELINKS 14B 记录族 0x71E-0x725）', median === 0x722, median.toString(16));
    // strictAddress 拓扑：只有列出的 tx 有 ECU —— 族其余地址 = NO DATA（候选死）。
    const ecus = {
      [median]: { name: 'IC', dsn: 'Kombiinstrument_9x1', kwp: true },   // 族中位 = IC（mock 命中族中位）
      0x7F1: { name: 'unknown', nrcAll: true },                          // 真车 0x7F1 形态：只回 NRC
    };
    const mIC = new MockAdapter({ latencyMs: 0, strictAddress: true, ecus });
    const eIC = new Elm327(mIC, { timeoutMs: 2000 });
    // 与 app.probeAddressFor 同款探测环（probeDecision 判定，RE-FLOWSPEC §1.6/2.3）
    const { probeDecision } = await import('./src/probe.js');
    let hit = null, sawNrc = false, nonKwpFrame = false;
    const order = [0x7F1, ...fam];   // 表行序候选（0x7F1 精确 join 行）先于族候选
    for (const tx of order) {
      if (hit) break;
      await eIC.cmd(`ATSH${tx.toString(16).toUpperCase()}`, 500);
      await eIC.cmd(`ATCRA${(tx + 8).toString(16).toUpperCase()}`, 500);
      for (const cmd of ['2101', '1A9F', '1A87', '1A90']) {
        if (/^22/.test(cmd)) nonKwpFrame = true;
        const r = (await eIC.cmd(cmd, 800) || '').trim();
        const pr = parseResp(r);
        const body = Array.from(pr.body || []).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
        const text = Array.from(pr.body || []).filter((c) => c >= 0x20 && c < 0x7f)
          .map((c) => String.fromCharCode(c)).join('').trim();
        const d = probeDecision(body, text, { label: 'IC(仪表)', moduleKeys: ['Kombiinstrument'], otherLabels: [] });
        if (d.verdict === 'accept') { hit = { tx, ident: d.ident }; break; }
        if (d.verdict === 'nrc-reject') sawNrc = true;
      }
    }
    ok('族探测命中=族中位 0x722（mock 命中族中位）', !!hit && hit.tx === median,
      hit && `hit=0x${hit.tx.toString(16)} ident=${hit.ident}`);
    ok('命中依据=识别串匹配（Kombi 语义），非 NRC/存活',
      !!hit && /Kombi/i.test(hit.ident || ''), hit && hit.ident);
    ok('NRC 地址 0x7F1 被 nrc-reject（不算候选，NRC 字节非识别串）',
      sawNrc && !!hit && hit.tx !== 0x7F1, hit && `hit=0x${hit.tx.toString(16)}`);
    ok('KWP 族探测只发 21 01/1A xx（无 22）', !nonKwpFrame && !mIC.txLog.some((c) => !c.startsWith('AT') && c.startsWith('22')));
    ok('0x7F1 先探后弃（表行序候选未命中即换族候选）',
      mIC.txLog.includes('ATSH7F1') && mIC.txLog.includes(`ATSH${median.toString(16).toUpperCase()}`),
      mIC.txLog.filter((c) => c.startsWith('ATSH')).join(','));
    ok('IC 绑定结果=发现循环命中项（tx/rx 对与身份成对落定）',
      !!hit && hit.tx === median && hit.ident && hit.ident.length > 0,
      hit && `bind=0x${hit.tx.toString(16)}/0x${(hit.tx + 8).toString(16)} ident=${hit.ident}`);
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
    { req: '22F1A2', resp: 'NO DATA' },                                    // 注册表识别请求（UDS 族插入 1A9F 后）
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
  const golden718 = ['1003', '3E00', '1A9F', '22F1A2', '1A87', '1A84', '1089', '221102', '1003', '22F190', '220000'];
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

// ─────────────────────────────────────────────
console.log('\n[7x] 验收重放·多模块形态（PSM/BCM_vorne UDS 族 —— mock 应答从包内识别串/件号表生成）');
{
  // ★ 任务口径：除 DME（KWP）外覆盖至少 2 个不同形态模块（KWP+UDS 混合）。
  //   应答内容全部来自包内表：识别串=DSN.BIN 注册表（data/ident-registry.json
  //   variantToIdent）、件号=JOB.BIN 会话库（data/ecu-part-map.json）—— 零编造。
  const reg = JSON.parse(readFileSync('./data/ident-registry.json', 'utf8'));
  const pm = JSON.parse(readFileSync('./data/ecu-part-map.json', 'utf8'));
  const mf = JSON.parse(readFileSync('./data/module-family.json', 'utf8'));
  const cat = JSON.parse(readFileSync('./data/models-catalog.json', 'utf8'));
  const mt3 = JSON.parse(readFileSync('./data/menu-tree-v3.json', 'utf8'));
  const menuModules = (labelRe) => {
    for (const g of mt3.groups || []) for (const m of g.models || []) {
      if (m.id === 'Cayman（981）') for (const fn of m.functions || []) for (const s of fn.systems || []) {
        if (labelRe.test(s.label)) return s.modules;
      }
    }
    return null;
  };
  const hex2 = (b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase();
  // 响应帧构造（CAF1 头 + ISO-TP）：header 前缀（如 [0x62,0xF1,0xA2] / [0x5A,0x84]）+ ASCII 文本；
  // >7 数据字节走 FF/CF 多帧（与真日志 1A 87/91/94 多帧形态同款）。
  const respFrames = (header, text) => {
    const data = [...header, ...[...String(text)].map((c) => c.charCodeAt(0))];
    const h = (arr) => arr.map(hex2).join(' ');
    if (data.length <= 7) return `7E8 ${hex2(data.length)} ${h(data)}`;
    const lines = [`7E8 ${hex2(0x10 | (data.length >> 8))} ${hex2(data.length)} ${h(data.slice(0, 6))}`];
    for (let seq = 1, i = 6; i < data.length; i += 7, seq++) {
      lines.push(`7E8 ${hex2(0x20 | (seq & 0x0f))} ${h(data.slice(i, i + 7))}`);
    }
    return lines.join('\r');
  };

  // ── PSM（UDS 族，识别串 003000 + 件号 99135565589 → PSM_a2_1）──
  const identPsm = reg.variantToIdent['PSM_a2_1'][0];            // '003000'（DSN.BIN）
  const partPsm = Object.entries(pm.byPart).find(([, es]) => es.some((e) => e.module === 'PSM' && String(e.variant).includes('PSM_a2_1')))[0]; // 99135565589
  ok('PSM mock 来源=包内表（识别串 DSN.BIN + 件号 JOB.BIN）',
    identPsm === '003000' && partPsm === '99135565589', `${identPsm}/${partPsm}`);
  const REPLAY_PSM = [
    { req: '1003', resp: '7E8 02 50 03' },
    { req: '1089', resp: '7E8 02 50 89' },
    { req: '3E00', resp: '7E8 02 7E 00' },
    { req: '1A9F', resp: 'NO DATA' },
    { req: '22F1A2', resp: respFrames([0x62, 0xF1, 0xA2], identPsm) },   // 〔DSN.BIN 身份记录 22 F1 A2〕
    { req: '1A87', resp: 'NO DATA' },
    { req: '1A84', resp: respFrames([0x5A, 0x84], partPsm) },            // 〔JOB.BIN PARTNUMBER〕
    { req: '1A91', resp: 'NO DATA' },
    { req: '1A92', resp: 'NO DATA' },
    { req: '1A93', resp: 'NO DATA' },
  ];
  const m8 = new MockAdapter({ latencyMs: 0, replay: REPLAY_PSM });
  const e8 = new Elm327(m8, { timeoutMs: 2000 });
  const c8 = new Coder(e8, { tx: 0x7E0, rx: 0x7E8, ecuName: 'PSM', family: 'uds' });
  await c8.enterSession(0x89, { family: 'uds' });
  ok('PSM 识别串采集（22 F1 A2 应答）', c8.identByCmd['22F1A2'] === '003000', JSON.stringify(c8.identByCmd));
  ok('PSM 件号采集（1A 84）', c8.lastPartTokens.includes('99135565589'), JSON.stringify(c8.lastPartTokens));
  {
    const menuMods = menuModules(/ESP\/PSM/);
    ok('PSM 菜单候选=Cayman 981 ESP/PSM 条目', JSON.stringify(menuMods) === '["PSM"]', JSON.stringify(menuMods));
    const entries = (menuMods || []).map((mod) => ({ mod, mi: (cat.models['Cayman（981）'].modules || []).find((x) => x.module === mod) })).filter((e) => e.mi);
    // 跨家族判别集：识别串必须从混合候选里挑出 PSM（而非 ECM 族）
    const mixed = [...entries,
      { mod: 'DME_BDE_Continental', mi: cat.models['Cayman（981）'].modules.find((x) => x.module === 'DME_BDE_Continental') },
      { mod: 'BV_ECM_UDS', mi: cat.models['Cayman（981）'].modules.find((x) => x.module === 'BV_ECM_UDS') }];
    const pickPsm = pickFamilyByEvidence(mixed, {
      identTokens: [c8.identByCmd['22F1A2']],
      partTokens: c8.lastPartTokens,
      registry: reg, byPart: pm.byPart, moduleFamily: mf, observedFamily: 'uds',
    });
    ok('PSM 家族选择=PSM（识别串 003000，混合候选判别）', pickPsm.mod === 'PSM', pickPsm.how);
    ok('PSM 变体=PSM_a2_1（识别串注册表）', pickPsm.variant === 'PSM_a2_1', String(pickPsm.variant));
  }
  {
    // 出帧：PSM 记录=22/2E 族（UDS）→ 读帧 `22 <DID16>`，绝无 21 <LID8>
    const rec = JSON.parse(readFileSync('./data/models/Cayman_981_/PSM_a2_1.json', 'utf8'));
    ok('PSM 记录 SID 族=22/2E（UDS）', rec.items.every((i) => i.readSid === 0x22), String(rec.items[0]?.readSid));
    const lid = rec.items.find((i) => i.lid != null).lid;
    const did = lid.toString(16).padStart(4, '0').toUpperCase();
    m8.replay.push({ req: `22${did}`, resp: `7E8 04 62 ${did.slice(0, 2)} ${did.slice(2)} 11` });
    await c8.readBlock(lid, 0x22).catch(() => null);
    const frames = m8.txLog.filter((c) => !c.startsWith('AT'));
    ok('PSM 读帧=22 <DID16>（UDS 形态）', frames.includes(`22${did}`) && !frames.some((f) => /^21/.test(f)), frames.join(','));
  }

  // ── BCM_vorne（UDS 纯族，识别串 050018 → BCM_vorne_9x1_Basis_GT4，无件号回落注册表）──
  const identBcm = reg.variantToIdent['BCM_vorne_9x1_Basis_GT4'][0];   // '050018'（DSN.BIN）
  ok('BCM mock 来源=包内识别串表（DSN.BIN）', identBcm === '050018', identBcm);
  const REPLAY_BCM = [
    { req: '1003', resp: '7E8 02 50 03' },
    { req: '1089', resp: '7E8 02 50 89' },
    { req: '3E00', resp: '7E8 02 7E 00' },
    { req: '1A9F', resp: 'NO DATA' },
    { req: '22F1A2', resp: respFrames([0x62, 0xF1, 0xA2], identBcm) },
    { req: '1A87', resp: 'NO DATA' },
    { req: '1A84', resp: 'NO DATA' },
    { req: '1A91', resp: 'NO DATA' },
  ];
  const m8b = new MockAdapter({ latencyMs: 0, replay: REPLAY_BCM });
  const e8b = new Elm327(m8b, { timeoutMs: 2000 });
  const c8b = new Coder(e8b, { tx: 0x7E0, rx: 0x7E8, ecuName: 'BCM_vorne', family: 'uds' });
  await c8b.enterSession(0x89, { family: 'uds' });
  ok('BCM 识别串采集（22 F1 A2 应答）', c8b.identByCmd['22F1A2'] === '050018', JSON.stringify(c8b.identByCmd));
  {
    const menuMods = menuModules(/前端电子/);
    ok('BCM 菜单候选=Cayman 981 前端电子条目', JSON.stringify(menuMods) === '["BCM_vorne"]', JSON.stringify(menuMods));
    const entries = (menuMods || []).map((mod) => ({ mod, mi: (cat.models['Cayman（981）'].modules || []).find((x) => x.module === mod) })).filter((e) => e.mi);
    // 跨模块判别集：050018 同时存在于 BCM_hinten/BCM_vorne 变体表 —— 菜单上下文 + 注册表落 BCM_vorne 变体
    const mixed = [...entries,
      { mod: 'BCM_hinten', mi: cat.models['Cayman（981）'].modules.find((x) => x.module === 'BCM_hinten') }];
    const pickBcm = pickFamilyByEvidence(mixed, {
      identTokens: [c8b.identByCmd['22F1A2']],
      registry: reg, byPart: pm.byPart, moduleFamily: mf, observedFamily: 'uds',
    });
    ok('BCM 家族选择=BCM_vorne（识别串 050018 + 菜单上下文）', pickBcm.mod === 'BCM_vorne', pickBcm.how);
    ok('BCM 变体=BCM_vorne_9x1_Basis_GT4（识别串注册表）', pickBcm.variant === 'BCM_vorne_9x1_Basis_GT4', String(pickBcm.variant));
  }
  {
    const rec = JSON.parse(readFileSync('./data/models/Cayman_981_/BCM_vorne_9x1_Basis_GT4.json', 'utf8'));
    ok('BCM 记录 SID 族=22/2E（UDS）', rec.items.every((i) => i.readSid === 0x22), String(rec.items[0]?.readSid));
    const lid = rec.items.find((i) => i.lid != null).lid;
    const did = lid.toString(16).padStart(4, '0').toUpperCase();
    m8b.replay.push({ req: `22${did}`, resp: `7E8 04 62 ${did.slice(0, 2)} ${did.slice(2)} 11` });
    await c8b.readBlock(lid, 0x22).catch(() => null);
    const frames = m8b.txLog.filter((c) => !c.startsWith('AT'));
    ok('BCM 读帧=22 <DID16>（UDS 形态）', frames.includes(`22${did}`) && !frames.some((f) => /^21/.test(f)), frames.join(','));
    ok('重放零未命中（PSM/BCM 每帧都有脚本应答）',
      m8.replayMisses.length === 0 && m8b.replayMisses.length === 0,
      JSON.stringify([...m8.replayMisses, ...m8b.replayMisses]));
  }
}

console.log(`\n===== 端到端结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
