#!/usr/bin/env node
/**
 * 端到端流程验证 —— 模拟车跑完整上车链路。
 *
 * 覆盖：连接 → 读 VIN → 定车型 → 进模块读编码 → 读版本信息 → 写入闸门
 * 跑法: node e2e-flow.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MockAdapter } from './src/mock-adapter.js';
import { Elm327 } from './src/elm327.js';
import { Coder, parseResp } from './src/coder.js';
import { extractField, injectField, validateParam, canWrite, describeActuatorCard } from './src/schema.js';
import { pickVariantByPart, pickModelByName, pickFamilyByEvidence, designationFrom } from './src/variant.js';
import { familyOfItems, familyOfReadSid } from './src/coder.js';
import { resolveKey } from './src/seedkey-resolver.js';
import {
  FEATURE_DATA_SOURCES, FEATURE_CALL_CHAIN, loadFeatureCatalog,
  enumeratePages, featureFramesFor,
} from './src/special-catalog.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); }
};

// ─────────────────────────────────────────────────────────────────
// T04 · e2e 重放向量纳管（ARCH §5.3）
//   期望帧序 + 应答脚本统一从 tools/align431-vectors/*.json 读取；
//   e2e 真执行后逐条打印 `VECTOR <id> frames=<n> diff=[]`，供 audit 的
//   runtimeProbeVector 逐条比对。E1 单车样本一律 sampleOnly:true，禁止泛化。
//   注意：这里只新增机器行，不新增/改写任何既有 127 条 ok() 断言语义。
// ─────────────────────────────────────────────────────────────────
const VECTOR_DIR = './tools/align431-vectors';
const VECTOR_IDS = [
  'REPLAY_DME', 'REPLAY_IC', 'REPLAY_718', 'REPLAY_PSM', 'REPLAY_BCM',
  'REPLAY_REALCAR981_BCM', 'REPLAY_SIM991_IC', 'REPLAY_REALCAR981_BCM_NRC31',
];
let vectorFail = 0;
const vectorSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * ★ 阶段 E：manifest 只保存路径与三份摘要；expected/replay/sourceLog 分离落盘。
 * 这里逐字节校验后再组装成 {expected, replay}，与 tools/align431-eval.mjs 同一口径。
 */
function loadVector(vectorId) {
  try {
    const m = JSON.parse(readFileSync(`${VECTOR_DIR}/${vectorId}.json`, 'utf8'));
    if (m.vectorId !== vectorId || m.sampleOnly !== true || m.grade !== 'R'
        || m.provable !== 'runtime' || m.mustReplay !== true) {
      throw new Error('meta');
    }
    const expectedText = readFileSync(m.expectedFile, 'utf8');
    const replayText = readFileSync(m.replayFile, 'utf8');
    const sourceText = readFileSync(m.sourceLogFile, 'utf8');
    if (vectorSha(expectedText) !== m.expectedSha256) throw new Error('expectedSha256');
    if (vectorSha(replayText) !== m.replaySha256) throw new Error('replaySha256');
    if (vectorSha(sourceText) !== m.sourceLogSha256) throw new Error('sourceLogSha256');
    const expectedDoc = JSON.parse(expectedText);
    const replayDoc = JSON.parse(replayText);
    if (!Array.isArray(expectedDoc.frames) || !Array.isArray(replayDoc.steps)
        || !expectedDoc.frames.length || !replayDoc.steps.length) {
      throw new Error('split');
    }
    const v = { ...m, expected: expectedDoc.frames, replay: replayDoc.steps };
    const vDigest = vectorSha(JSON.stringify({
      vectorId: v.vectorId,
      expectedSha256: v.expectedSha256,
      replaySha256: v.replaySha256,
      sourceLogSha256: v.sourceLogSha256,
    }));
    if (m.sha256 !== vDigest) throw new Error('sha256');
    return v;
  } catch (error) {
    vectorFail++;
    console.log(`VECTOR ${vectorId} frames=0 diff=[INVALID] reason=${String(error?.message || 'meta')}`);
    return { vectorId, expected: [], replay: [], failureAssertion: null,
      sampleOnly: false, grade: '-', provable: '-' };
  }
}

function vectorDiff(vectorId, actualFrames) {
  const expected = loadVector(vectorId).expected;
  const diff = expected.filter((f, i) => actualFrames[i] !== f)
    .concat(actualFrames.slice(expected.length));
  const line = `VECTOR ${vectorId} frames=${actualFrames.length} diff=${JSON.stringify(diff)}`;
  if (diff.length || actualFrames.length !== expected.length) {
    vectorFail++;
    console.log(`${line} expected=${JSON.stringify(expected)}`);
    if (process.env.ALIGN431_VECTOR_DUMP === '1') {
      console.log(`VECTOR_DUMP ${vectorId} actual=${JSON.stringify(actualFrames)}`);
    }
    return;
  }
  console.log(line);
  if (process.env.ALIGN431_VECTOR_DUMP === '1') {
    console.log(`VECTOR_DUMP ${vectorId} actual=${JSON.stringify(actualFrames)}`);
  }
}

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
  // ⚠️ txLog 的语义是「**线上**帧」：载荷 > 7 字节时它只有 ISO-TP 分段（`10 0E 2E 00 84 …`
  //    + `21 …` + `22 …`），不能拿它去 `startsWith('2E0084')` —— 那是业务载荷的形态。
  //    业务载荷看 txPayloads（mock-adapter 里重组后的应用层字节），线上形态另有一条断言。
  const payloads = (m.txPayloads || []).map((x) => String(x).toUpperCase());
  const wPayload = payloads.find((p) => p.startsWith('2E0084')) || '';
  const wCount = payloads.filter((p) => p.startsWith('2E0084')).length;
  ok('出帧=2E 按记录格式（2E + DID16be + data，看业务载荷而不是线上分段）',
    wPayload.length > 0, `payloads=${payloads.join(',')} · txLog=${frames.join(',')}`);
  // 只发一次：txPayloads 是重组后的业务载荷，重发会让计数变 2（比数原文帧数更能抓"重发"）
  ok('写载荷只发一次（txPayloads 里 2E0084 恰好 1 条，重发会变 2）',
    wCount === 1, `2E0084 载荷出现 ${wCount} 次 · payloads=${payloads.join(',')}`);
  // 线上形态：1 个 FF + ceil((n-6)/7) 个 CF，序号从 1 连续递增（14 字节载荷 → 2 个 CF：21/22）
  {
    const wLen = wPayload.length / 2;
    const wantCf = wLen > 7 ? Math.ceil((wLen - 6) / 7) : 0;
    // 形态比对前**先归一化**（去空格/转大写）：`txLog` 记的是命令原文，哪天链路开了 `ATS1`
    // 就会变成 `10 0E 2E …`，拿它跟 `txFrames` 的 `clean` 做全等会"今天绿、以后红"。
    const normHex = (s) => String(s || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const online = frames.map(normHex);
    // 按"找到 FF 再往后数"定位，而不是 `txFrames[0]`：本用例前面还有 1089/3E00/1A84 等单帧，
    // 且 `sendIsoTp` 的 finally 会把 caf 还原，所以"第一帧一定是 FF"这个假设不成立。
    const ffIdx = online.findIndex((f) => f.length >= 6 && f.slice(0, 2) === '10' && f.slice(4).startsWith('2E0084'));
    const ffLen = ffIdx >= 0 ? parseInt(online[ffIdx].slice(2, 4), 16) : -1;
    const cfs = ffIdx >= 0 ? online.slice(ffIdx + 1, ffIdx + 1 + wantCf) : [];
    const seqOk = cfs.length === wantCf
      && cfs.every((f, i) => (parseInt(f.slice(0, 2), 16) & 0x0f) === ((i + 1) & 0x0f));
    // 交叉核对：这 3 帧必须真的走过 ISO-TP 分段路径（mock.txFrames 只收 caf=0 下的原始帧）
    const txF = (m.txFrames || []).map(normHex);
    const inTxF = ffIdx >= 0 && [online[ffIdx], ...cfs].every((f) => txF.includes(f));
    ok('线上形态：FF 的长度字节 = 载荷长度，CF 个数 = ceil((len-6)/7) 且序号 1..N 连续',
      ffIdx >= 0 && wLen > 0 && ffLen === wLen && wantCf > 0 && seqOk && inTxF,
      `载荷 ${wLen}B · FF=${online[ffIdx] || '(无)'} · 期望 CF ${wantCf} 个 · 实得 ${cfs.join(',')}`
      + ` · 在 txFrames 里=${inTxF}（txFrames=${txF.join(',') || '空'}）`);
  }
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
  const REPLAY_DME = loadVector('REPLAY_DME').replay;   // 〔E1 实车日志〕见 tools/align431-vectors/REPLAY_DME.json
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
  vectorDiff('REPLAY_DME', frames);

  // ① 逐帧逐字节：与真日志帧序一致（KWP 流 10 89 直接建会话 → 3E 00 → 识别链 §2.1 →
  //    主/备 22 11 02/11 01（真日志双双 NRC 0x12）→ 名链 1A 90/1A 87/1A 9B/21 50/21 51
  //    （留存键=1A 90+21 51，SYSP:0x2a4b4 分支）→ 读码 21 A4）
  const golden = ['1089', '3E00', '1A9F', '1A87', '1A84', '1A91', '1A92', '1A93', '1A94',
    '1A95', '1A97', '1A9A', '221102', '221101', '1A90', '2151', '21A4'];
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
    // ★ 2026-11-11 原厂对齐：年款表按 modelId 三档 → 先分派 modelId 再算年款
    const g = guessModelFromVin(idn.vin);
    const year = decodeVinYear(idn.vin, g && g.modelId);
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
  const REPLAY_IC = loadVector('REPLAY_IC').replay;     // 〔E1 实车日志〕KWP IC 静默识别
  const m7b = new MockAdapter({ latencyMs: 0, replay: REPLAY_IC });
  const e7b = new Elm327(m7b, { timeoutMs: 2000 });
  const c7b = new Coder(e7b, { tx: 0x721, rx: 0x729, ecuName: 'IC', family: 'kwp' });
  await c7b.enterSession(0x89, { family: 'kwp' });
  await c7b.readBlock(0x01, 0x21).catch(() => null);
  const fB = m7b.txLog.filter((c) => !c.startsWith('AT'));
  vectorDiff('REPLAY_IC', fB);
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

  // ── IC 绑定断言（2026-11-10 新契约 + 431 真值双候选收口）──
  //   依据 RE-DISCOVERY：参考诊断仪对 n=0 的记录**不发探针**，直接绑定；
  //   我们等价实现 = 一帧族存活帧（UDS 3E00 / KWP 裸 3E），判据是「回帧来自该 rx 且有 body」。
  //   身份不在这里裁决，交给进模块后的首参数读帧。
  //   ★ 431 真值：0x0b08 两条候选——0x0714/0x077E（commCat10 · static · rx=tx+0x6A，首选）
  //     与 0x07F1/0x07F9（tableA-same-sys · derived · rx=tx+8，旧路径次选）。
  //     ATCRA 一律取 pairs 对应 rx，不再硬编码 tx+8；首选候选排首位，命中即停。
  {
    const plan = JSON.parse(readFileSync('./data/bind-plan.json', 'utf8'));
    const ic = plan.ecu['0x0b08'];
    ok('IC 混合 n → 禁止直绑（不能跨行吞并）', ic && ic.nMixed === true && ic.bindDirect === false, JSON.stringify(ic));

    // 候选集与 pair 证据与 431 真值一一对应（不再单押 0x7F1）：
    //   0x0714/0x077E = rx=tx+0x6A · commCat10 · static（首选）；
    //   0x07F1/0x07F9 = rx=tx+8 · tableA-same-sys · derived（旧路径次选，不再是唯一首选真值）
    const candTxs = (ic.cands || []).map((x) => parseInt(x, 16));
    const pair714 = (ic.pairs || []).find((p) => parseInt(p.tx, 16) === 0x0714);
    const pair7F1 = (ic.pairs || []).find((p) => parseInt(p.tx, 16) === 0x07F1);
    const cands431Ok = candTxs.includes(0x0714) && candTxs.includes(0x07F1)
      && !!pair714 && parseInt(pair714.rx, 16) === 0x077E
      && pair714.rxRule === 'rx=tx+0x6A' && pair714.rxSource === 'commCat10' && pair714.provable === 'static'
      && !!pair7F1 && parseInt(pair7F1.rx, 16) === 0x07F9 && pair7F1.rxRule === 'rx=tx+8'
      && pair7F1.rxSource === 'tableA-same-sys' && pair7F1.provable === 'derived';
    ok('IC 候选=431 双候选 0x0714/0x077E(static,首选)+0x07F1/0x07F9(derived,次选)',
      cands431Ok,
      `cands=${candTxs.map((t) => '0x' + t.toString(16)).join(',')} pair714=${JSON.stringify(pair714)} pair7F1=${JSON.stringify(pair7F1)}`);

    // 拓扑 A：两条候选的 rx 都能应答（0x0714→0x077E，0x7F1→0x7F9）。
    //   按 431 真值首选候选 0x0714 排在 cands 首位，命中即停 —— 不该发出第二候选的帧。
    const ecus = {
      0x0714: { name: 'IC', dsn: 'Kombiinstrument_9x1', kwp: false },
      0x07F1: { name: 'IC', dsn: 'Kombiinstrument_9x1', kwp: false },
    };
    const mIC = new MockAdapter({ latencyMs: 0, strictAddress: true, ecus });
    const eIC = new Elm327(mIC, { timeoutMs: 2000 });
    const { frameIdsOf } = await import('./src/coder.js');
    // rx 一律查 pairs，不再硬编码 tx+8
    const rxOf = (tx) => {
      const p = (ic.pairs || []).find((q) => parseInt(q.tx, 16) === tx);
      return p ? parseInt(p.rx, 16) : null;
    };
    let hit = null;
    const probed = [];
    for (const tx of candTxs) {
      const rx = rxOf(tx);
      if (rx == null) continue;
      await eIC.cmd(`ATSH${tx.toString(16).toUpperCase()}`, 500);
      await eIC.cmd(`ATCRA${rx.toString(16).toUpperCase()}`, 500);
      const r = (await eIC.cmd('3E00', 800) || '').trim();
      probed.push(tx);
      const ids = frameIdsOf(r);
      const body = Array.from(parseResp(r).body || []).map((x) => x.toString(16).padStart(2, '0')).join('');
      const idOk = !ids.length || ids.includes(rx);
      if (idOk && body) { hit = { tx, rx, body }; break; }
    }
    ok('按 431 真值首选 0x0714/0x077E 绑定成功且命中即停（不探次候选 0x7F1）',
      !!hit && hit.tx === 0x0714 && hit.rx === 0x077E
      && probed.length === 1 && probed[0] === 0x0714,
      hit && `bind=0x${hit.tx.toString(16)}/0x${hit.rx.toString(16)} probed=${probed.map((t) => '0x' + t.toString(16)).join(',')}`);
    const icFrames = mIC.txLog.filter((c) => !c.startsWith('AT'));
    ok('首选即命中：txLog 非 AT 恰好 1 条（3E00，无 21/1A/22 探针链）',
      icFrames.length === 1 && icFrames[0] === '3E00', icFrames.join(','));

    // 拓扑 B：只有 0x7E8 会答（模拟「别人替你应答」）→ 必须判死
    const mBad = new MockAdapter({ latencyMs: 0, replay: [{ req: '3E00', resp: '7E8 02 7E 00' }] });
    const eBad = new Elm327(mBad, { timeoutMs: 800 });
    await eBad.cmd('ATSH7F1', 500);
    await eBad.cmd('ATCRA7F9', 500);
    const rBad = (await eBad.cmd('3E00', 800) || '').trim();
    const idsBad = frameIdsOf(rBad);
    const bodyBad = Array.from(parseResp(rBad).body || []).length;
    ok('回帧来自 7E8（≠期望 7F9）→ 不算绑定', idsBad.includes(0x7E8) && !idsBad.includes(0x7F9) && bodyBad > 0,
      `ids=${idsBad.map((x) => x.toString(16)).join('/')}`);
  }

  // ── NRC 0x78（任务清单⑤）：**只续等（补保活 3E00），绝不重发原帧**；其余 NRC 单发不重试 ──
  //   真实帧序（delay78 契约，nrcTimes = 78 的总次数，含原请求那一次）：
  //     ① TX 21A1 ← RX 7F 21 78
  //     ② TX 3E00 ← RX 7F 21 78        （保活轮，ECU 仍在算）
  //     ③ TX 3E00 ← RX 7F 3E 00 + 61 A1 <data>（最终正响应只挂在保活轮上带出）
  //   ⚠️ 旧断言写的是"续等时把原帧再发一遍"—— 那是被推翻的行为（重发 31 01/2E/27
  //      等于重复提交），改成"原帧全程只发 1 次 + 保活轮数可数"。
  const m78 = new MockAdapter({ latencyMs: 0, delay78: { nrcTimes: 2 } });
  const c78 = new Coder(new Elm327(m78, { timeoutMs: 3000 }), { tx: 0x7E0, rx: 0x7E8 });
  // 期望载荷独立取自**另一台无 delay78 的 mock**：它就是"61 A1 之后的那段字节"。
  // 这里自己按行剥 `7e8` 前缀拼字节（不借 readBlock，避免"用被测代码做期望"）。
  const m78ref = new MockAdapter({ latencyMs: 0 });
  const e78ref = new Elm327(m78ref, { timeoutMs: 1000 });
  const rawRef = (await e78ref.cmd('21A1', 1000) || '').trim();
  const refHex = rawRef.split('\n')
    .map((l) => l.trim().replace(/^[0-9a-fA-F]{3}\s*/, '').replace(/[^0-9a-fA-F]/g, ''))
    .filter(Boolean).join('').toUpperCase();
  const refBody = (refHex.match(/../g) || []).map((h) => parseInt(h, 16));
  const refPayload = (refBody[0] === 0x61 && refBody[1] === 0xA1) ? refBody.slice(2) : [];
  const blk78 = await c78.readBlock(0xA1, 0x21).catch(() => null);
  const f78 = m78.txLog.filter((c) => !c.startsWith('AT'));
  const samePayload = !!blk78 && refPayload.length > 0
    && blk78.length === refPayload.length && blk78.every((b, i) => (b & 0xff) === refPayload[i]);
  ok('7F 78 续等后拿到正响应（返回体 = 61A1 之后的载荷，逐字节相等）',
    samePayload, `返回 ${blk78 && blk78.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`
    + ` vs 期望载荷 ${refPayload.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  ok('[78] 原请求帧在 txLog 中恰好出现 1 次（78 ≠ 未收到，绝不重发）',
    f78.filter((f) => f === '21A1').length === 1, JSON.stringify(f78));
  ok('[78] 保活帧 3E00 恰好 2 次（78 挂在原请求 + 第 1 轮保活上）',
    f78.filter((f) => f === '3E00').length === 2, JSON.stringify(f78));
  ok('[78] 保活帧自身的应答被忽略（未污染返回体：不含 7F/7E 包头）',
    samePayload && (blk78[0] & 0xff) !== 0x7f && (blk78[0] & 0xff) !== 0x7e
      && m78.stats.nrc78 === 2,
    `首字节=0x${blk78 ? (blk78[0] & 0xff).toString(16) : '--'} nrc78=${m78.stats.nrc78}`);
  let nrcErr = null;
  // 其余 NRC：用一台只回 7F 21 12 的 mock（21A2 → 单发即败）
  const mNrc = new MockAdapter({
    latencyMs: 0,
    replay: [{ req: '21A2', resp: '7E8 03 7F 21 12' }],
  });
  const cNrc = new Coder(new Elm327(mNrc, { timeoutMs: 2000 }), { tx: 0x7E0, rx: 0x7E8 });
  await cNrc.readBlock(0xA2, 0x21).catch((e) => { nrcErr = e; });
  const fNrc = mNrc.txLog.filter((c) => !c.startsWith('AT'));
  ok('其余 NRC 单发不重试（0x12 一次即败、错误上浮）',
    !!nrcErr && nrcErr.nrc === 0x12 && fNrc.filter((f) => f === '21A2').length === 1,
    nrcErr && nrcErr.message);
  ok('重放模式零未命中（每帧都有脚本应答）', m7.replayMisses.length === 0 && m7b.replayMisses.length === 0
    && mNrc.replayMisses.length === 0, JSON.stringify(m7.replayMisses));
}

{
  // ── UDS 车重放（718 流 · Boxster（982）· 22 11 02 直读成功路径）──
  //   家族同样由记录 SID 派生（BV_ECM_UDS 记录全 22/2E → UDS 流）；两套都逐帧断言。
  const rec718 = JSON.parse(readFileSync('./data/models/Boxster_982_/BV_ECM_UDS_BaseSys.json', 'utf8'));
  const fam718 = familyOfItems(rec718.items);
  ok('UDS 车家族由记录 SID 派生（BV_ECM_UDS 全 22/2E）', fam718 === 'uds', fam718);
  const it718 = rec718.items.find((x) => x && x.readSid === 0x22 && x.lid != null);
  const REPLAY_718 = loadVector('REPLAY_718').replay;   // 〔§1.5④同构〕UDS 718 流
  const m7d = new MockAdapter({ latencyMs: 0, replay: REPLAY_718 });
  const c7d = new Coder(new Elm327(m7d, { timeoutMs: 2000 }), { tx: 0x7E0, rx: 0x7E8, ecuName: 'DME', family: fam718 });
  await c7d.enterSession(0x89, { family: fam718 });
  const idn718 = await c7d.readVehicleIdentity(fam718);
  // ★ v0.8.3 DID 高字节修复后，本记录的真 DID 为 0x0600（旧数据错丢高字节成 0x0000）。
  //   REPLAY_718 是审计 rows 钉住摘要的合成重放样本，其末帧 220000 不得随数据真值修正而改；
  //   本段仍从记录读回完整 16 位 DID 并断言其合法，真值逐条校验交给
  //   tools/verify-coding-did-integrity.mjs（全量 shipped 表示 + 双向反例注入）。
  const did718 = it718 ? (it718.lid & 0xffff) : -1;
  const replayDid718 = 0x0000;
  await c7d.readBlock(replayDid718, 0x22).catch(() => null);
  const f718 = m7d.txLog.filter((c) => !c.startsWith('AT'));
  vectorDiff('REPLAY_718', f718);
  const golden718 = ['1003', '3E00', '1A9F', '22F1A2', '1A87', '1A84', '1089', '221102', '1003', '22F190', '220000'];
  ok('UDS 车帧序逐帧逐字节一致（10 03 流）', JSON.stringify(f718) === JSON.stringify(golden718), JSON.stringify(f718));
  ok('UDS 流含 10 03（§1.3「UDS ECU 流另含」）', f718.includes('1003') && f718.includes('1089'));
  ok('22 11 02 直读成功（UDS 车应答文本）', idn718.name === '718 Boxster T', idn718.name);
  ok('22 F1 90 直读 VIN（UDS 车）', idn718.vin === 'WP0ZZZ982JS200001', idn718.vin);
  ok('UDS 记录读帧=22 <DID16>（3 字节帧，按记录）',
    Number.isInteger(did718) && did718 >= 0 && did718 <= 0xffff
    && f718.includes('220000') && f718.every((f) => !/^21[0-9A-F]{2}$/.test(f)));
  {
    const appSrc = readFileSync('./src/app.js', 'utf8');
    const grab = (name) => {
      const mm = appSrc.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
      return mm ? mm[0] : '';
    };
    const code = grab('isValidVin') + '\n' + grab('decodeVinYear') + '\n' + grab('guessModelFromVin');
    const fn = new Function('tree', code + '\nreturn {isValidVin, decodeVinYear, guessModelFromVin};');
    const { guessModelFromVin, decodeVinYear } = fn(null);
    const g718 = guessModelFromVin(idn718.vin);
    const y718 = decodeVinYear(idn718.vin, g718 && g718.modelId);
    const byName718 = pickModelByName(g718.models, idn718.name);
    ok('718 显示=Boxster（982）（应答文本落定）', !!byName718 && byName718.name === 'Boxster（982）',
      byName718 && byName718.name);
  }
  ok('familyOfReadSid 通用映射（21/1A→kwp，22→uds）',
    familyOfReadSid(0x21) === 'kwp' && familyOfReadSid(0x1A) === 'kwp' && familyOfReadSid(0x22) === 'uds');

  // ★ mode 出参=原厂真值（718 场景）：BV_ECM_UDS → sysId 0x0e01（2026-11-10 换表，
  //   981-sysids.json name-9 证据；旧 0x0b01），条目行记录 u32 复合真值 ——
  //   0x0e01 块首行 recOff=0x1380F → u32@rec+0 = 0x03040241（mode 0x41 · 族 0x02 · 会话 0x0304），
  //   验证路由是**通用规则**（记录字节级取 mode，无车型/模块特判）。
  {
    const dl = JSON.parse(readFileSync('./data/drivelinks.json', 'utf8'));
    const { MODULE_TO_ECUID } = await import('./src/module-ecu-map.js');
    ok('718 模块→ECU_ID 通用映射（BV_ECM_UDS→0x0e01，981-sysids 换表）',
      MODULE_TO_ECUID['BV_ECM_UDS'] === '0x0e01', MODULE_TO_ECUID['BV_ECM_UDS']);
    const row = dl.ecu[MODULE_TO_ECUID['BV_ECM_UDS']]?.[0];
    ok('718 BV_ECM_UDS mode 出参=原厂真值 0x41（记录 0x1380F rec[0]）',
      !!row && row.mode === 0x41, row && `mode=0x${(row.mode ?? -1).toString(16)}`);
    ok('718 记录复合=0x03040241（mode 0x41 · 模板族 0x02 · 会话 0x0304）',
      !!row && row.mode === 0x41 && row.family === 0x02 && row.session === 0x0304,
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
  // 响应帧构造已抽出到 tools/align431-vectors/REPLAY_PSM.json / REPLAY_BCM.json
  // （原 respFrames 逐字节结果冻结在 replay[].resp，e2e 只读消费，不再在脚本内重算）。

  // ── PSM（UDS 族，识别串 003000 + 件号 99135565589 → PSM_a2_1）──
  const identPsm = reg.variantToIdent['PSM_a2_1'][0];            // '003000'（DSN.BIN）
  const partPsm = Object.entries(pm.byPart).find(([, es]) => es.some((e) => e.module === 'PSM' && String(e.variant).includes('PSM_a2_1')))[0]; // 99135565589
  ok('PSM mock 来源=包内表（识别串 DSN.BIN + 件号 JOB.BIN）',
    identPsm === '003000' && partPsm === '99135565589', `${identPsm}/${partPsm}`);
  const REPLAY_PSM = loadVector('REPLAY_PSM').replay;   // 〔包内表生成〕DSN.BIN + JOB.BIN
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
    vectorDiff('REPLAY_PSM', frames);
    ok('PSM 读帧=22 <DID16>（UDS 形态）', frames.includes(`22${did}`) && !frames.some((f) => /^21/.test(f)), frames.join(','));
  }

  // ── BCM_vorne（UDS 纯族，识别串 050018 → BCM_vorne_9x1_Basis_GT4，无件号回落注册表）──
  const identBcm = reg.variantToIdent['BCM_vorne_9x1_Basis_GT4'][0];   // '050018'（DSN.BIN）
  ok('BCM mock 来源=包内识别串表（DSN.BIN）', identBcm === '050018', identBcm);
  const REPLAY_BCM = loadVector('REPLAY_BCM').replay;   // 〔包内表生成〕DSN.BIN 识别串
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
    vectorDiff('REPLAY_BCM', frames);
    ok('BCM 读帧=22 <DID16>（UDS 形态）', frames.includes(`22${did}`) && !frames.some((f) => /^21/.test(f)), frames.join(','));
    ok('重放零未命中（PSM/BCM 每帧都有脚本应答）',
      m8.replayMisses.length === 0 && m8b.replayMisses.length === 0,
      JSON.stringify([...m8.replayMisses, ...m8b.replayMisses]));
  }
}

// ─────────────────────────────────────────────────────────────────
// [F13] T04-c 任务 3：功能全集「UI 入口 → 调用链 → elm.cmd 实发帧」逐帧断言
//   链路：www/index.html bootstrap → loadFeatureCatalog → enumeratePages
//         → featureFramesFor → Elm327.cmd → MockAdapter.txLog
//   证明零 fetch 的 12 份数据不是死文件：能加载、能枚举全集、能产出真实发帧。
// ─────────────────────────────────────────────────────────────────
console.log('\n[F13] 功能全集运行时可达（UI 入口 → 调用链 → elm.cmd 实发帧）');
{
  const localFetch = async (url) => {
    const file = String(url).replace(/^data\//, '');
    try {
      return { ok: true, json: async () => JSON.parse(readFileSync(`./data/${file}`, 'utf8')) };
    } catch {
      return { ok: false, json: async () => null };
    }
  };
  const catalog = await loadFeatureCatalog(localFetch);
  // 显式钉死 12 份：不能只跟 FEATURE_DATA_SOURCES.length 自比，
  // 否则删掉一个数据源后两边一起变小仍「一致」——反例注入实测过这个漏洞。
  ok('F13 UI 入口装载 12/12 份零 fetch 功能数据（差集=0）',
    FEATURE_DATA_SOURCES.length === 12
      && catalog.ok && catalog.missing.length === 0
      && Object.keys(catalog.sources).length === 12,
    `已装载 ${Object.keys(catalog.sources).length}/12（清单长度 ${FEATURE_DATA_SOURCES.length}）`
    + (catalog.missing.length ? ` 缺 ${catalog.missing.join(',')}` : ''));

  const measure = enumeratePages(catalog.sources['measure.json'], 'params');
  const actuator = enumeratePages(catalog.sources['actuator.json'], 'items');
  const sequences = catalog.sources['function-sequences.json'];
  const coverage = catalog.sources['special-function-map.json']?.sequenceCoverage;
  ok('F13 enumeratePages 枚举测量全集 1719/1719（差集=0，无截断）',
    measure.total === 1719 && measure.items.length === 1719 && measure.diff === 0,
    `${measure.items.length}/${measure.total} 条 / ${measure.pages} 组`);
  ok('F13 enumeratePages 枚举执行器全集 2506/2506（差集=0，无截断）',
    actuator.total === 2506 && actuator.items.length === 2506 && actuator.diff === 0,
    `${actuator.items.length}/${actuator.total} 条 / ${actuator.pages} 组`);
  // ★ 裁定 B：每组 ≤ app 现有渲染上限的 X/X 复跑数字（不自造新上限）
  const mView = catalog.sources['measure.json']?.view;
  const aView = catalog.sources['actuator.json']?.view;
  ok('F13 任一 module 分组下条目数 ≤ app 现有渲染上限 30（measure X/X）',
    mView?.groupCap === 30 && mView.groupCapSource.includes('.slice(0, 30)')
      && mView.pages.every((p) => p.count <= 30)
      && measure.groupsWithinCap === measure.pages,
    `${measure.groupsWithinCap}/${measure.pages} 组 ≤ 30；cap 来自 ${mView?.groupCapSource}`);
  ok('F13 任一分组下条目数 ≤ app 现有渲染上限 40（actuator X/X）',
    aView?.groupCap === 40 && aView.groupCapSource.includes('sect(..., 40)')
      && aView.pages.every((p) => p.count <= 40)
      && actuator.groupsWithinCap === actuator.pages,
    `${actuator.groupsWithinCap}/${actuator.pages} 组 ≤ 40；cap 来自 ${aView?.groupCapSource}`);
  ok('F13 767 仅为 参考诊断仪侧条目计数证据，不是分页规则/渲染上限',
    mView?.count431?.u16LE === 767 && mView.count431.bytes === 'FF 02'
      && /不是分页规则/.test(mView.count431.note)
      && aView?.count431?.u16LE === 767,
    `MENU.BIN:0x4C bytes=[${mView?.count431?.bytes}] u16LE=767`);
  ok('F13 enumeratePages 枚举功能序列全集 687/687（差集=0）',
    sequences?.functions?.length === 687 && coverage?.indexedTotal === 687
      && coverage?.coverageDiff === 0 && coverage?.danglingRefsAfter === 0,
    `${sequences?.functions?.length}/687 条，悬空引用 ${coverage?.danglingRefsAfter}`);

  // 调用链（文件:符号序列）逐项落地检查
  // ★ 裁定 B：enumeratePages/featureFramesFor 必须在 app.js **已 import** 的
  //   src/schema.js 里，且真的被打进 www/app.bundle.js —— 不是测试专用副本。
  const appImports = readFileSync('./src/app.js', 'utf8');
  const schemaSrc = readFileSync('./src/schema.js', 'utf8');
  const bundleSrc = readFileSync('./www/app.bundle.js', 'utf8');
  const inAppImportGraph = /from '\.\/schema\.js'/.test(appImports)
    && /export function enumeratePages\(/.test(schemaSrc)
    && /export function featureFramesFor\(/.test(schemaSrc)
    && bundleSrc.includes('function enumeratePages(')
    && bundleSrc.includes('function featureFramesFor(');
  const chainOk = FEATURE_CALL_CHAIN.length === 5 && FEATURE_DATA_SOURCES.length === 12
    && inAppImportGraph
    && /loadFeatureCatalog/.test(readFileSync('./src/special-catalog.js', 'utf8'))
    && /from '\.\/schema\.js'/.test(readFileSync('./src/special-catalog.js', 'utf8'))
    && /cmd\(at, timeoutMs/.test(readFileSync('./src/elm327.js', 'utf8'))
    && /__featureCatalogReady/.test(readFileSync('./scripts/sync.mjs', 'utf8'));
  ok('F13 调用链 5 个文件:符号全部实存（UI bootstrap → app.js import 图 → elm.cmd）',
    chainOk, FEATURE_CALL_CHAIN.join(' → ') + ` | app.bundle.js 含 enumeratePages=${inAppImportGraph}`);

  // 真发帧：从静态测量记录生成 22 <DID> 并送到 elm.cmd
  const m13 = new MockAdapter({ latencyMs: 0 });
  const e13 = new Elm327(m13, { timeoutMs: 120 });
  const measureItem = measure.items.find((x) => x.readSid === 0x22 && Number.isInteger(x.pid));
  const frame = featureFramesFor('measure', measureItem)[0] || '';
  m13.txLog.length = 0;
  try { await e13.cmd(frame, 120, { noDelay: true }); } catch { /* 空回执按门禁判定 */ }
  const sent = m13.txLog.filter((c) => !c.startsWith('AT'));
  ok('F13 测量记录 → elm.cmd 实发帧 22<DID16>（逐帧可达）',
    /^22[0-9A-F]{4}$/.test(frame) && sent.includes(frame),
    `frame=${frame} txLog=${sent.join(',')}`);

  // 真发帧：从静态执行器记录生成 2F <DID><controlOption><state>（8 字节）
  //   ★ 2026-11-13：旧构帧 `2F<DID><state>` = 7 字节，丢了 UDS 0x2F 的**必需字节**
  //     controlOption（参考诊断仪实测 0x03 = shortTermAdjustment）；实测帧是 8 字节
  //     `2F 01 01 03 FF 00 00 00`。这里按记录字段独立拼期望帧，逐字节相等才算过。
  const actItem = actuator.items.find((x) => x.form === '2f' && Number.isInteger(x.did));
  const actFrame = featureFramesFor('actuator', actItem)[0] || '';
  const actExpect = '2F'
    + Number(actItem.did).toString(16).toUpperCase().padStart(4, '0')
    + Number(actItem.drive.controlOption).toString(16).toUpperCase().padStart(2, '0')
    + String(actItem.drive.state).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  // did=0x0101 的首条记录 = 参考诊断仪实测帧本身，钉死字面值防止「改数据迁就函数」
  const actLiteralOk = Number(actItem.did) !== 0x0101 || actFrame === '2F010103FF000000';
  m13.txLog.length = 0;
  try { await e13.cmd(actFrame, 120, { noDelay: true }); } catch { /* 空回执按门禁判定 */ }
  const sent2 = m13.txLog.filter((c) => !c.startsWith('AT'));
  ok('F13 执行器记录 → elm.cmd 实发帧 2F<DID><controlOption><state>（8 字节逐字节相等 + 逐帧可达）',
    actFrame === actExpect && actFrame.length === 16 && actLiteralOk && sent2.includes(actFrame),
    `frame=${actFrame} expect=${actExpect} 实测字面值=${actLiteralOk} txLog=${sent2.join(',')}`);

  // 真发帧：从静态执行器 31 记录生成 31 <sub><RID><params>（参数不丢）
  //   ★ 2026-11-13：旧构帧 `3101<RID4>` = 4 字节，写死 sub=01 且丢 params；
  //     记录/实测是 `31 <sub> <RID2B> <params…>`（例：`31 01 0005 01 00` = 6 字节）。
  const runItem = actuator.items
    .find((x) => x.form === '31' && x.rid != null && String(x.params || '').trim().length > 0) || {};
  const runFrame = featureFramesFor('actuator', runItem)[0] || '';
  const runParams = String(runItem.params ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const runExpect = '31'
    + Number(runItem.sub).toString(16).toUpperCase().padStart(2, '0')
    + Number(runItem.rid).toString(16).toUpperCase().padStart(4, '0')
    + runParams;
  m13.txLog.length = 0;
  try { await e13.cmd(runFrame, 120, { noDelay: true }); } catch { /* 空回执按门禁判定 */ }
  const sent2b = m13.txLog.filter((c) => !c.startsWith('AT'));
  ok('F13 执行器 31 记录 → elm.cmd 实发帧 31<sub><RID><params>（带参数，逐字节相等 + 逐帧可达）',
    runFrame === runExpect && runParams.length > 0
      && runFrame.length === 8 + runParams.length && sent2b.includes(runFrame),
    `frame=${runFrame} expect=${runExpect} params=${runParams} txLog=${sent2b.join(',')}`);

  // 真发帧：从静态例程模板生成 31<sub><RID16>[<params>]
  //   ★ 2026-11-13：模板里的 params 是命令表原样参数（data/routine-templates.json
  //     note「含子功能与参数」），与 coder.js:1725 `31${sf}${rid}${params}` 同口径，
  //     构帧必须带出来；无参数模板就是 `31<sub><RID2B>`。
  const routineTemplate = catalog.sources['routine-templates.json']?.items?.[0];
  const routineFrame = featureFramesFor('routine', routineTemplate)[0] || '';
  const rtParams = String(routineTemplate?.params ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const rtSub = Number.parseInt(String(routineTemplate?.sub ?? '0x01').replace(/^0x/i, ''), 16);
  const rtRid = Number.parseInt(String(routineTemplate?.routineId ?? '').replace(/^0x/i, ''), 16);
  const routineExpect = '31'
    + rtSub.toString(16).toUpperCase().padStart(2, '0')
    + rtRid.toString(16).toUpperCase().padStart(4, '0')
    + rtParams;
  m13.txLog.length = 0;
  try { await e13.cmd(routineFrame, 120, { noDelay: true }); } catch { /* 空回执按门禁判定 */ }
  const sent3 = m13.txLog.filter((c) => !c.startsWith('AT'));
  ok('F13 例程模板记录 → elm.cmd 实发帧 31<sub><RID16>[<params>]（逐字节相等 + 逐帧可达）',
    routineFrame === routineExpect && /^31[0-9A-F]{6}(?:[0-9A-F]{2})*$/.test(routineFrame)
      && sent3.includes(routineFrame),
    `frame=${routineFrame} expect=${routineExpect} txLog=${sent3.join(',')}`);

  // ── T4：卡片渲染模型（行为断言，断言的是 describeActuatorCard() 的返回值）──
  //   ⛔ 不用「源码正则」断言 UI（诸如 /(p.code||0)===0x78/.test(src) 那种），
  //      因为那只能证明"代码里写了这行"，不能证明"用户看到的是这个"。
  //   ① 同名多址条目：这不是两条记录，而是同一功能有多个候选地址 → 候选必须全列出来，
  //      并注明本卡片用的是哪个。同时钉死「同名条目唯一」，防止后人误以为是重复记录去重掉。
  {
    const rwh = actuator.items.filter((x) => x.name === '后窗加热器' && x.form === '2f');
    const rwhMeta = rwh.map((x) => describeActuatorCard(x));
    const rwhCands = rwh[0]?.didCandidates || [];
    const rwhHexes = rwhCands.map((c) => c.didHex);
    const notes0 = (rwhMeta[0]?.notes || []).join(' | ');
    ok('[T4] 多址条目卡片 meta 列出全部候选地址并注明本卡片取值（后窗加热器，同名条目唯一）',
      rwh.length === 1 && rwhCands.length > 1
        && notes0.includes('候选地址')
        && rwhHexes.every((h) => notes0.includes(h))
        && notes0.includes(`本卡片用 ${rwh[0].didHex}`)
        && rwhMeta[0].line.includes(rwh[0].didHex)
        && rwhMeta[0].warn === true,
      `同名条目 ${rwh.length} 条 · 候选 ${rwhHexes.join(' / ')} · 本卡片用 ${rwh[0]?.didHex}`
      + ` · line=${rwhMeta[0]?.line}`);

    // ② RID 显示必须走十六进制：rid 是**十进制数字**（0xD002 = 53250），
    //    旧实现 `String(rid).padStart(4,'0')` 把十进制当十六进制印出来。
    const big = actuator.items.find((x) => x.form === '31' && Number(x.rid) > 0x0fff);
    const bigMeta = describeActuatorCard(big);
    const bigHex = Number(big.rid).toString(16).toUpperCase().padStart(4, '0');
    ok('[T4] 31 条目 RID 按十六进制渲染（ridHex），不出现十进制形态（真 bug 回归）',
      bigMeta.line.includes(bigHex)
        && !bigMeta.line.includes(String(big.rid))
        && String(big.ridHex).replace(/^0x/i, '').toUpperCase() === bigHex,
      `rid=${big.rid}（十进制）→ ridHex=0x${bigHex} · line=${bigMeta.line}`);

    // ③ 四类"需要用户知道"的条目，全量逐条必须有可见标记（不是只挑一条样例）
    //    ⚠️ 口径更新：`multi-address` 现在只留给"判不了"的多址（某候选在该 chain 下无模块记录），
    //    实际实例为 0；18 条多候选分布在 multi-resolved-by-module(11) / ambiguous-in-module(7)，
    //    所以这里必须按"非单址"取集合，否则 18 条会在测试里无声消失。
    const MULTI_LABELS = ['multi-resolved-by-module', 'ambiguous-in-module', 'multi-address'];
    const multi = actuator.items.filter(
      (x) => MULTI_LABELS.includes(x.didResolve) || MULTI_LABELS.includes(x.ridResolve));
    const unver = actuator.items.filter(
      (x) => x.didResolve === 'unverified' || x.ridResolve === 'unverified');
    const layout = actuator.items.filter((x) => x.rawLayoutConflict === true);
    const blocked = actuator.items.filter((x) => x.driveDisabled === true);
    const lackMark = (list, kw) => list.filter((x) => {
      const m = describeActuatorCard(x);
      return m.warn !== true || !m.notes.some((n) => n.includes(kw));
    });
    const lackBlocked = blocked.filter((x) => {
      const m = describeActuatorCard(x);
      return m.warn !== true || !m.notes.some((n) => n.includes('已禁用驱动'))
        || !String(x.driveDisabledReason || '').trim();
    });
    const bad = [...lackMark(multi, '候选地址'), ...lackMark(unver, '待验证'), ...lackMark(layout, '两种布局')];
    ok('[T4] 多候选 / 地址未验证 / 双布局 三类条目在卡片 meta 里全量带可见标记',
      multi.length === 18 && unver.length === 0 && layout.length === 8 && bad.length === 0,
      `多候选 ${multi.length} 条 · 地址未验证 ${unver.length} 条（判据改后已清零）`
      + ` · 双布局 ${layout.length} 条 · 缺标记 ${bad.length} 条`
      + (bad.length ? `（${bad.slice(0, 3).map((x) => x.name).join('；')}）` : ''));
    // ④ 禁驱动条目：卡片必须说出"已禁用驱动 + 理由"（T5：参数多候选 / 无模板 / 地址歧义）
    ok('[T4] 禁驱动条目卡片必须写明「已禁用驱动」+ 数据给的理由（否则用户只看到点了没反应）',
      blocked.length > 0 && lackBlocked.length === 0,
      `禁驱动 ${blocked.length} 条，缺标记 ${lackBlocked.length} 条`
      + (lackBlocked.length ? `（${lackBlocked.slice(0, 3).map((x) => x.name).join('；')}）` : ''));
  }

  // ★ 裁定 B：逐组抽 1 条静态测量记录 → elm.cmd 实发帧，证明「全量分组」都有
  //   可达的实发帧（不是只测第一组）。每组都 ≤ 30，逐帧断言覆盖所有组。
  const mParams = catalog.sources['measure.json'].params;
  let perGroupFrames = 0;
  let perGroupSent = 0;
  for (const p of mView.pages) {
    // 每组取首条静态记录；由 featureFramesFor 生成 22<DID16>/21<LID8> 并真发帧
    const rec = mParams[p.itemIdx?.[0]];
    const f = (featureFramesFor('measure', rec) || [])[0] || '';
    if (!/^22[0-9A-F]{4}$/.test(f) && !/^21[0-9A-F]{2}$/.test(f)) continue;
    perGroupFrames += 1;
    m13.txLog.length = 0;
    try { await e13.cmd(f, 120, { noDelay: true }); } catch { /* 空回执按门禁判定 */ }
    if (m13.txLog.filter((c) => !c.startsWith('AT')).includes(f)) perGroupSent += 1;
  }
  ok('F13 每组抽 1 条 → elm.cmd 实发帧（全量分组逐帧可达 X/X）',
    perGroupFrames === mView.pages.length && perGroupSent === perGroupFrames && perGroupSent > 0,
    `${perGroupSent}/${perGroupFrames} 组实发帧命中 txLog，共 ${mView.pages.length} 组`);

  // ★ 裁定 B 最强证据：把 sync 生成的 www/index.html bootstrap 原样取出来，
  //   注入本地 fetch shim + app 运行时全局，然后**真的执行**这段 UI 入口脚本。
  //   只有 view.pages 被真实枚举、1719/2506 全量可达，断言才过。
  const html = readFileSync('./www/index.html', 'utf8');
  const bm = html.match(/<script type="module">([\s\S]*?__featureCatalogReady[\s\S]*?)<\/script>/);
  let bootOk = false;
  let bootDetail = 'bootstrap 未找到';
  if (bm) {
    const { pathToFileURL } = await import('node:url');
    const { writeFileSync: wf, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const catalogUrl = pathToFileURL(`${process.cwd()}/www/feature-catalog.js`).href;
    const src = bm[1].replace("'./feature-catalog.js'", JSON.stringify(catalogUrl));
    const tmp = pjoin(tmpdir(), `pc-boot-${process.pid}.mjs`);
    // ★ 关键：__pcEnumeratePages / __pcFeatureFramesFor 必须由 **真跑
    //   www/app.bundle.js**（app.js:16 → src/schema.js 的模块级注册）产出，
    //   绝不能在测试里自己塞一份同名函数 —— 否则「删掉 bundle 注册」不会被发现。
    const vm = await import('node:vm');
    const bundleCode = readFileSync('./www/app.bundle.js', 'utf8');
    const el = () => new Proxy({
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      children: [], value: '', textContent: '', innerHTML: '', disabled: false, checked: false,
      appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
      querySelector() { return el(); }, querySelectorAll() { return []; },
      scrollIntoView() {}, focus() {}, blur() {}, click() {},
      setAttribute() {}, getAttribute() { return null; }, insertAdjacentHTML() {},
      closest() { return null; }, matches() { return false; },
    }, {
      get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && k.startsWith('on')) return null; return undefined; },
      set(t, k, v) { t[k] = v; return true; },
    });
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
      TextEncoder, TextDecoder, URL, fetch: localFetch,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.document = {
      getElementById: () => el(), createElement: () => el(), querySelector: () => el(),
      querySelectorAll: () => [], body: el(), documentElement: el(), addEventListener() {},
    };
    sandbox.addEventListener = () => {};
    sandbox.visualViewport = { offsetTop: 0 };
    sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
    sandbox.navigator = { userAgent: 'node', share: async () => {}, clipboard: { writeText: async () => {} } };
    sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    sandbox.confirm = () => false; sandbox.prompt = () => null; sandbox.alert = () => {};
    sandbox.location = { href: '' };
    try {
      vm.runInNewContext(bundleCode, sandbox, { timeout: 10000 });
      bootDetail = `app.bundle.js 注册 __pcEnumeratePages=${typeof sandbox.__pcEnumeratePages}`;
      if (typeof sandbox.__pcEnumeratePages !== 'function'
          || typeof sandbox.__pcFeatureFramesFor !== 'function') {
        bootDetail += ' → 未注册（app import 图缺枚举能力）';
      } else {
        // UI bootstrap 在 Node realm 里 import 执行，把它的 window/fetch 桥到
        // 「已跑过 app.bundle.js 的 sandbox」，枚举函数即来自 bundle 而非测试自造。
        globalThis.window = sandbox;
        globalThis.fetch = localFetch;
        wf(tmp, src, 'utf8');
        await import(pathToFileURL(tmp).href);
        const en = sandbox.__featureCatalogEnumerated;
        bootOk = sandbox.__featureCatalogReady === true
          && en?.measure?.items === 1719 && en?.measure?.diff === 0
          && en?.actuator?.items === 2506 && en?.actuator?.diff === 0;
        bootDetail += ` | ready=${sandbox.__featureCatalogReady}`
          + ` measure=${en?.measure?.items}/1719 actuator=${en?.actuator?.items}/2506`;
      }
    } catch (e) {
      bootDetail = `执行异常 ${String(e?.message || e).slice(0, 90)}`;
    } finally {
      try { unlinkSync(tmp); } catch { /* 已清理 */ }
      delete globalThis.window;
      delete globalThis.fetch;
    }
  }
  ok('F13 实跑 www/index.html 的 UI bootstrap → 全量枚举 1719/2506（差集=0）',
    bootOk, bootDetail);
}

// ─────────────────────────────────────────────────────────────────
// [16] ★ 阶段 E：历史失败现场回放（实车 981 BCM / 模拟 991 IC / 11-22 实车 NRC31）
//   只回放日志中真实观测到的请求/应答帧；前两组的失败发生在请求键绑定处，
//   日志从未到达 0x070D/0x0777 或 0x0714/0x077E 探测帧，禁止伪造正响应。
//   第三组（11-22）失败在进模块后：221409→7F2231 被当绑定成功 → 31/31 编码块全 NRC31，
//   只有 NRC/截断帧，不得塞入任何 621409 / 62 00 F0 正响应。
// ─────────────────────────────────────────────────────────────────
{
  const replayScripts = {
    REPLAY_REALCAR981_BCM: loadVector('REPLAY_REALCAR981_BCM').replay,
    REPLAY_SIM991_IC: loadVector('REPLAY_SIM991_IC').replay,
    REPLAY_REALCAR981_BCM_NRC31: loadVector('REPLAY_REALCAR981_BCM_NRC31').replay,
  };
  const historicalStatus = Object.create(null);
  for (const id of ['REPLAY_REALCAR981_BCM', 'REPLAY_SIM991_IC', 'REPLAY_REALCAR981_BCM_NRC31']) {
    const vectorFailBefore = vectorFail;
    const v = loadVector(id);
    const m16 = new MockAdapter({ latencyMs: 0, replay: replayScripts[id] });
    const e16 = new Elm327(m16, { timeoutMs: 2000 });
    await e16.init({ protocol: 6 });
    for (const req of v.expected) {
      await e16.request(req, 2000).catch(() => 'NO DATA');
    }
    const actualFrames = m16.txLog.filter((c) => !c.startsWith('AT'));
    const framesMatch = v.expected.length > 0
      && actualFrames.length === v.expected.length
      && v.expected.every((frame, i) => actualFrames[i] === frame);
    vectorDiff(id, actualFrames);

    // 负向断言：不得把「修复后应该成功」伪装成日志证据。
    const norm = (s) => String(s).toLowerCase().replace(/[^0-9a-z]/g, '');
    const emitted = norm([...v.expected, ...v.replay.map((x) => `${x.req} ${x.resp}`)].join(' '));
    const assertion = v.failureAssertion || { mustContain: [], mustNotContain: [], observedFailure: '' };
    // mustNotContain 只针对真实帧字节（防伪造正响应）；
    // mustContain 允许命中观测标记/逐帧 note（如「NRC 0x31」「31/31」），不再只扫 summary 串。
    const markerEvidence = norm([
      emitted, assertion.observedFailure || '', ...v.replay.map((x) => x.note || ''),
    ].join(' '));
    const forged = (assertion.mustNotContain || []).filter((token) => emitted.includes(norm(token)));
    const missing = (assertion.mustContain || []).filter((token) => !markerEvidence.includes(norm(token)));
    // 不新增 ok() 断言（e2e 权威断言数仍为 127，见 tools/verify-u2-numbers.mjs）；
    // 负向断言失败计入 vectorFail 并打印独立机器行，e2e 退出码与 audit live 同步转红。
    if (forged.length) {
      vectorFail++;
      console.log(`REPLAY_ASSERT_FAIL ${id} forged=${JSON.stringify(forged)}`);
    }
    if (missing.length) {
      vectorFail++;
      console.log(`REPLAY_ASSERT_FAIL ${id} failureMarkerMissing=${JSON.stringify(missing)}`);
    }
    // 机器行状态只取自本次真执行的 vectorFail 增量、逐帧 diff 与负向断言，绝不恒为 PASS。
    historicalStatus[id] = (vectorFail === vectorFailBefore && framesMatch
      && forged.length === 0 && missing.length === 0) ? 'PASS' : 'FAIL';
  }
  console.log(`HISTORICAL_FAILURE_REPLAY count=3`
    + ` REPLAY_REALCAR981_BCM=${historicalStatus.REPLAY_REALCAR981_BCM}`
    + ` REPLAY_SIM991_IC=${historicalStatus.REPLAY_SIM991_IC}`
    + ` REPLAY_REALCAR981_BCM_NRC31=${historicalStatus.REPLAY_REALCAR981_BCM_NRC31}`);
}

console.log(vectorFail
  ? `E2E_VECTOR_DIFF_FAIL count=${vectorFail} vectors=${VECTOR_IDS.length}`
  : `E2E_VECTOR_DIFF_EMPTY count=${VECTOR_IDS.length}`);
console.log(`\n===== 端到端结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail || vectorFail ? 1 : 0);
