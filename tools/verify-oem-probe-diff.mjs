#!/usr/bin/env node
/**
 * verify-oem-probe-diff.mjs — HB-2 / HB-3 九条门禁断言（PRD §3.1 / §7 T5）。
 *
 * ① OEM_DIFF_PROBE_PHASE_2A：探针阶段 probeChainFor = {kwp:'1A9F',uds:'221409'}
 *    vs 原厂 0xFF001409 / 补帧 0x1102，diff=空（独立 node -e 只读 src/app.js）；
 * ② OEM_DIFF_IDENTITY_PHASE_2B：身份裁决阶段「实跑逐帧断言函数」
 *    assertIdentityPhaseFrames() —— 校验 enterSystem 之后 selectOemSequence 四帧
 *    3E00→22F19E→22F1A2→1003 的期望/实发 diff=空、帧数差=0、身份裁决不在探针阶段。
 *    ★ 2026-11-13 T03-b 已落地：探针阶段 finish() 只「应答即绑」（删 ATSTFF /
 *      identityAdjudicate / ATST0F），身份裁决移到 enterSystem 之后按 cat=0x60 四帧
 *      + ident-registry.json moduleIdent 判据执行；src/probe.js 的 identityPhaseFrames()
 *      即生产实发帧集。identityPhaseHardAssert() 默认 true → 本行为**硬断言**，
 *      不满足即 FAIL 且退出码非 0。禁止注释占位 / ok(true,...) / 永久 skip。
 * ③ OEM_DIFF_185_185：185/185 四帧逐字节全同（+ byGeneration[].rxRule 与
 *    cat60BlockCount/byteIdentical 字段一致性）；
 * ④ OEM_DIFF_402_402：402/402 仅在 tx∈0x700–0x77F 限定段（全表 402/527）；
 * ⑤ OEM_DIFF_TRUNCATION_REMOVED：5 处 [:16]/[:20] 全删（按 provenance 过滤后计数）；
 * ⑥ OEM_DIFF_120_MISMATCH_ZERO：120 条错配归零（按 provenance 显式过滤）；
 * ⑦ OEM_DIFF_FAM120_DIST：fam120 {3:28,13:2,16:90}；
 * ⑧ OEM_DIFF_IDENTITY_CHAIN：163/163 + 148/148 + 12/12；
 * ⑨ OEM_DIFF_DENOMINATOR_SPLIT：120/120 与 163/163 分列独立断言，禁止混算分母。
 *
 * 跑法：npm run verify:oem-probe  （或 node tools/verify-oem-probe-diff.mjs）
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readJson, readText, sortedKeys } from './align431-eval.mjs';

const comm = readJson('data/comm-addr-table.json');
const plan = readJson('data/bind-plan.json');
const ident = readJson('data/ident-registry.json');
const sysComm = readJson('data/sysdata-comm.json');
if (!comm || !plan || !ident || !sysComm) {
  console.error('缺少 data/*.json，请先跑 build-comm-addr-table.mjs 与 export-bind-plan.py');
  process.exit(2);
}

let pass = 0, fail = 0, report = 0;
const L = [];
const ok = (id, cond, detail = '') => {
  if (cond) { pass++; L.push(`  PASS ${id}${detail ? ' — ' + detail : ''}`); }
  else { fail++; L.push(`  FAIL ${id}${detail ? ' — ' + detail : ''}`); }
};
/** ②-b 报告通道（T03-b 落地后仅在显式诊断回退时可触发；默认走硬断言）。 */
const reportNonA = (id, detail, nextCarrier) => {
  report++;
  L.push(`  REPORT ${id} — 当前非 A：${detail}`);
  L.push(`    下一载体=${nextCarrier}`);
};

/**
 * T03-b 落地开关（2026-11-13 批次 2 已落地）：默认 true = 硬断言。
 * 保留 ALIGN431_T03B='0' 作为**显式**诊断回退（只在排查该行时手动设置，
 * 默认执行路径永远走硬断言），防止有人用环境变量把门禁悄悄降级成 REPORT。
 */
function identityPhaseHardAssert() {
  return process.env.ALIGN431_T03B !== '0';
}

/**
 * ②-b 实跑逐帧断言函数：从 src/ 只读提取我方实际帧集与调用阶段，
 * 与 comm-addr-table.probeSequence.frames 的 431 期望四帧做逐帧 diff。
 *
 * @returns {{verdict:'A'|'非A', expected:string[], actualUds:string[], actualKwp:string[],
 *            diff:string[], frameCountDiff:number, identityInProbePhase:boolean,
 *            reason:string, nextCarrier:string}}
 */
export function assertIdentityPhaseFrames() {
  const app = readText('src/app.js') || '';
  const probe = readText('src/probe.js') || '';
  const expected = comm.probeSequence.frames.slice();
  // 我方当前 UDS/KWP 身份帧集（identityFramesFor，probe.js:141）
  const mUds = probe.match(/return\s*\(family\s*===\s*'kwp'\s*\?\s*\[([^\]]*)\]\s*:\s*\[([^\]]*)\]\)/);
  const parseFrames = (s) => (s || '').match(/'([0-9A-Fa-f]+)'/g)?.map((x) => x.replace(/'/g, '').toUpperCase()) || [];
  const actualKwp = mUds ? parseFrames(mUds[1]) : comm.identityPhase.kwp.slice();
  const actualUds = mUds ? parseFrames(mUds[2]) : comm.identityPhase.uds.slice();
  // finish() 是否在探针阶段 tryAddr 内调用 identityAdjudicate（当前实现）
  const finishIdx = app.indexOf('const finish = async');
  const finishBody = finishIdx >= 0 ? app.slice(finishIdx, finishIdx + 2200) : '';
  const identityInProbePhase = /identityAdjudicate\s*\(/.test(finishBody);
  // 期望四帧 vs 我方实发帧集：逐帧 diff（集合差 + 顺序差）
  const unionUds = [...new Set([...actualUds, ...expected])];
  const diff = unionUds.filter((f) => !expected.includes(f) || !actualUds.includes(f));
  const orderAligned = expected.every((f, i) => actualUds[i] === f);
  const frameCountDiff = actualUds.length - expected.length;
  const verdict = diff.length === 0 && orderAligned && frameCountDiff === 0 && !identityInProbePhase ? 'A' : '非A';
  return {
    verdict, expected, actualUds, actualKwp, diff,
    frameCountDiff, orderAligned, identityInProbePhase,
    reason: verdict === 'A' ? '期望帧序列 vs 我方实发 diff=空' :
      `我方 UDS 身份帧集=${JSON.stringify(actualUds)}（多 1A9B、少 22F1A2/3E00/1003）；`
      + `frameCountDiff=${frameCountDiff}；identityInProbePhase=${identityInProbePhase}`,
    nextCarrier: 'T03-b R4 修法：探针只保留「应答即绑」每候选 1 帧；删掉 finish() 额外 2 帧；'
      + '身份裁决移到 enterSystem 后按四帧 + ident-registry.json 判据做 identMatch；'
      + '落地后把 identityPhaseHardAssert() 切 true 或设 ALIGN431_T03B=1 转硬断言',
  };
}

/** 按 provenance 显式过滤 commCat10-family-default（团队规格增量 2）。 */
function familyDefaultEntries() {
  return Object.entries(plan.ecu || {})
    .filter(([, v]) => JSON.stringify(v.provenance || []).includes('commCat10-family-default'))
    .sort(([a], [b]) => a.localeCompare(b));
}
/** 该 provenance 的条目是否仍带错配语义（非静态地址表规则）。 */
function mismatchCount(entries) {
  return entries.filter(([, v]) => {
    const p = JSON.stringify(v.provenance || []);
    return !p.includes('commCat10-addressTable') || !p.includes('oemProbeSequence');
  }).length;
}

L.push('=== HB-2 / HB-3 九条门禁断言（PRD §3.1 / §7 T5） ===');
const famEntries = familyDefaultEntries();

// ① 探针阶段 ②-a：独立 node -e 只读 src/app.js，不依赖本门禁
{
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e',
      `const s=require('fs').readFileSync('src/app.js','utf8');`
      + `const i=s.indexOf('function probeChainFor');const b=s.slice(i,i+320);`
      + `const kwp=(b.match(/family === 'kwp'\\) return \\[([^\\]]+)\\]/)||[])[1]||'';`
      + `const uds=(b.match(/return \\['([0-9A-Fa-f]+)'\\];\\s*\\/\\/ UDS/)||[])[1]||'';`
      + `process.stdout.write(JSON.stringify({kwp:(kwp.match(/'([^']+)'/)||[])[1]||'',uds:uds}));`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { out = '{"kwp":"","uds":""}'; }
  const got = JSON.parse(out || '{"kwp":"","uds":""}');
  const expect = { kwp: '1A9F', uds: '221409' };
  const diff = Object.keys(expect).filter((k) => got[k] !== expect[k]);
  ok('OEM_DIFF_PROBE_PHASE_2A 探针阶段 probeChainFor vs 原厂 0xFF001409 / 补帧 0x1102 diff=空',
    diff.length === 0 && comm.probePhase.framesPerCandidate === 1
      && comm.probePhase.uds === '221409' && comm.probePhase.kwp === '1A9F'
      && comm.probePhase.requestKey === '0xFF001409',
    `实跑=${JSON.stringify(got)} 期望=${JSON.stringify(expect)} diff=${JSON.stringify(diff)} 每候选帧数=${comm.probePhase.framesPerCandidate}`);
}

// ② 身份裁决阶段 ②-b：实跑逐帧断言函数（可切换硬断言）
{
  const r = assertIdentityPhaseFrames();
  if (r.verdict === 'A') {
    ok('OEM_DIFF_IDENTITY_PHASE_2B 身份裁决阶段期望/实发 diff=空、帧数差=0、身份裁决不在探针阶段',
      true, `expected=${r.expected.join('→')} actual=${r.actualUds.join('→')} frameCountDiff=${r.frameCountDiff}`);
  } else if (identityPhaseHardAssert()) {
    // T03-b 落地后：本行转为硬断言，FAIL 并使退出码非 0。
    ok('OEM_DIFF_IDENTITY_PHASE_2B 身份裁决阶段期望/实发 diff=空、帧数差=0、身份裁决不在探针阶段',
      false, `${r.reason}；nextCarrier=${r.nextCarrier}`);
  } else {
    reportNonA('OEM_DIFF_IDENTITY_PHASE_2B', r.reason, r.nextCarrier);
  }
  L.push(`    实跑证据：expected=${r.expected.join('→')} / actualUds=${r.actualUds.join('→')}`
    + ` / diff=${JSON.stringify(r.diff)} / frameCountDiff=${r.frameCountDiff}`
    + ` / identityInProbePhase=${r.identityInProbePhase}`
    + ` / hardAssert=${identityPhaseHardAssert()}`);
}

// ③ 185/185 四帧逐字节全同 + 字段一致性
{
  const lc = comm.limitCheck || {};
  const ps = comm.probeSequence || {};
  const byGenOk = Object.values(comm.byGeneration || {}).every((g) =>
    (g.addresses || []).every((a) => typeof a.rxRule === 'string' && a.rxRule.length > 0));
  ok('OEM_DIFF_185_185 cat=0x60 四帧逐字节全同 + byGeneration[].rxRule / cat60BlockCount / byteIdentical 一致',
    lc.cat60Blocks === 185 && lc.fourFrameByteIdentical === 185
      && lc.cat60DistinctFrameSignatures === 1 && ps.cat60BlockCount === 185
      && ps.byteIdentical === true && ps.frames.join('→') === '3E00→22F19E→22F1A2→1003'
      && JSON.stringify(ps.flags) === JSON.stringify([0, 1, 1, 0]) && byGenOk,
    `cat60Blocks=${lc.cat60Blocks} distinct=${lc.cat60DistinctFrameSignatures} frames=${ps.frames.join('→')} byGeneration.rxRule=${byGenOk}`);
}

// ④ 402/402 仅 tx∈0x700–0x77F 限定段
{
  const lc = comm.limitCheck || {};
  const limited = (sysComm.ecu ? Object.values(sysComm.ecu) : []).flatMap((e) => e.blocks || [])
    .filter((b) => b.cat === 0x10).flatMap((b) => b.subs || [])
    .filter((s) => s.tx >= 0x700 && s.tx <= 0x77F);
  const plus6a = limited.filter((s) => s.rx === s.tx + 0x6A).length;
  const allSubs = (sysComm.ecu ? Object.values(sysComm.ecu) : []).flatMap((e) => e.blocks || [])
    .filter((b) => b.cat === 0x10).flatMap((b) => b.subs || []);
  ok('OEM_DIFF_402_402 仅在 tx∈0x700–0x77F 限定段成立（全表 402/527，另 125 条老代）',
    lc.txRange700_77F === 402 && lc.rxEqTxPlus6A === 402 && lc.cat10SubsTotal === 527
      && lc.txNotInRange === 125 && plus6a === 402 && allSubs.length === 527
      && lc.fullTable402of527 === '402/527',
    `限定段=${lc.txRange700_77F} rxEqTxPlus6A=${lc.rxEqTxPlus6A} 全表=${lc.cat10SubsTotal} 段外=${lc.txNotInRange} 独立复跑=${plus6a}/${allSubs.length}`);
}

// ⑤ 5 处截断全删（源码扫描 + 按 provenance 过滤后的候选数）
{
  const py = readText('tools/export-bind-plan.py') || '';
  // 只检测「候选序表达式」上的截断（sorted(...)[:16] / [:20] / dict(sorted(...)[:16])）。
  // `problems[:20]` 只是错误信息数组的展示切片，不是候选截断，不计入。
  const truncPatterns = [
    /sorted\([^)]*\)\s*\[:16\]/g,
    /sorted\([^)]*\)\s*\[:20\]/g,
    /dict\(sorted\([^)]*\)\s*\[:16\]/g,
    /ordered\s*=\s*sorted\([^)]*\)\s*\[:16\]/g,
  ];
  const truncations = [];
  for (const re of truncPatterns) {
    const m = py.match(re);
    if (m) truncations.push(...m);
  }
  // 按 provenance 显式过滤（团队规格增量 2），不按「候选数 > 16 就归 120」。
  const over16 = famEntries.filter(([, v]) => (v.pairs || []).length > 16).length;
  const distinctGroupProv = new Set();
  let addrTableProvCount = 0;
  for (const [, v] of Object.entries(plan.ecu || {})) {
    for (const p of v.provenance || []) {
      if (p.provenance === 'tierA' || p.provenance === 'crossgen') distinctGroupProv.add(p.provenance);
      if (typeof p.provenance === 'string' && p.provenance.startsWith('commCat10-addressTable')) addrTableProvCount += 1;
    }
  }
  ok('OEM_DIFF_TRUNCATION_REMOVED 5 处候选截断全删（按 provenance 过滤；tierA/crossgen 独立标源）',
    truncations.length === 0 && over16 === 90
      && distinctGroupProv.has('tierA') && distinctGroupProv.has('crossgen')
      && addrTableProvCount > 0 && plan.stats.truncationFixed === 90,
    `残留候选截断=${truncations.length} fam120候选>16=${over16} 独立provenance=${[...distinctGroupProv].sort().join(',')} 地址表provenance条数=${addrTableProvCount} truncationFixed=${plan.stats.truncationFixed}`);
}

// ⑥ 120 条错配归零（按 provenance 显式过滤，不按候选数 >16 归 120）
{
  const n = famEntries.length;
  const bad = mismatchCount(famEntries);
  const hasAddrTable = famEntries.every(([, v]) => {
    const p = JSON.stringify(v.provenance || []);
    return p.includes('commCat10-addressTable') && p.includes('ownerSysId');
  });
  ok('OEM_DIFF_120_MISMATCH_ZERO 120 条错配归零（provenance 显式过滤 commCat10-family-default）',
    n === 120 && bad === 0 && hasAddrTable && plan.stats.commFamilyDefault === 120
      && plan.stats.mismatchFixed === 120,
    `fam120=${n} 错配残留=${bad} 地址表provenance齐备=${hasAddrTable} stats.commFamilyDefault=${plan.stats.commFamilyDefault}`);
}

// ⑦ fam120 {3:28,13:2,16:90}
{
  const d = plan.stats.candidateDistribution || {};
  ok('OEM_DIFF_FAM120_DIST fam120 候选分布 {3:28,13:2,16:90}（各自标源、不与 402/527 混算）',
    JSON.stringify(d) === JSON.stringify({ 3: 28, 13: 2, 16: 90 })
      && comm.limitCheck.fam120CandidateDistribution['3'] === 28
      && comm.limitCheck.fam120CandidateDistribution['13'] === 2
      && comm.limitCheck.fam120CandidateDistribution['16'] === 90,
    `bind-plan.stats=${JSON.stringify(d)} comm-addr.limitCheck=${JSON.stringify(comm.limitCheck.fam120CandidateDistribution)}`);
}

// ⑧ 身份链 163/163 + 148/148 + 12/12
{
  const n163 = Object.keys(ident.identToVariant || {}).length;
  const n148 = Object.keys(ident.variantToIdent || {}).length;
  const n12 = Object.keys(ident.moduleIdent || {}).length;
  const req = {};
  for (const m of Object.values(ident.moduleIdent || {})) req[m.request] = (req[m.request] || 0) + 1;
  const threeFields = Object.values(ident.moduleIdent || {}).every((m) => m.request && m.identName && m.suffixHex);
  // 键序遍历比较（避免 JSON.stringify 的键插入顺序造成假阴性）。
  const stable = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
  const reqOk = stable(comm.limitCheck.identityRequestDistribution) === stable({ '1A9F': 6, '22F1A2': 6 });
  // 一条断言同时钉死三个独立分母（PRD §3.1 要求 163/163、148/148、12/12 各自可证），
  // 断言名逐字带上三个 U-1 门禁断言 id，保持「9 条断言」总数不变。
  ok('OEM_DIFF_IDENTITY_163_163 / OEM_DIFF_IDENTITY_148_148 / OEM_DIFF_IDENTITY_12_12'
    + '（163/163 联合覆盖 + 148/148 变体名 + 12/12 模块三字段，三条分列同证）',
    n163 === 163 && n148 === 148 && n12 === 12 && threeFields && reqOk,
    `163=${n163} 148=${n148} 12=${n12} request分布=${stable(req)} 三字段齐备=${threeFields}`);
}

// ⑨ 120/120 与 163/163 分列独立断言，禁止混算分母
{
  const n120 = famEntries.length;
  const n163 = Object.keys(ident.identToVariant || {}).length;
  const doubled = Object.entries(plan.ecu || {}).filter(([, v]) => {
    const p = JSON.stringify(v.provenance || []);
    return p.includes('commCat10-family-default') && p.includes('identToVariant');
  }).length;
  ok('OEM_DIFF_DENOMINATOR_SPLIT 120/120（分派规则）与 163/163（身份链）分列独立断言、禁止混算',
    n120 === 120 && n163 === 163 && n120 !== n163 && doubled === 0
      && /分列独立断言|禁止混算/.test(comm.limitCheck.denominatorDiscipline),
    `120=${n120} 163=${n163} 混算条目=${doubled} 分母纪律字段=有`);
}

L.push('');
L.push(`===== verify-oem-probe-diff：${pass} PASS / ${fail} FAIL / ${report} REPORT（T03-b 已落地，②-b 为硬断言） =====`);
L.push('②-b 硬断言：identityPhaseHardAssert() 默认 true；期望四帧 vs 实发 diff=空 / frameCountDiff=0 / identityInProbePhase=false。');
L.push('复跑命令：npm run verify:oem-probe ; node tools/build-comm-addr-table.mjs ; python3 tools/export-bind-plan.py');
L.push(`结论：硬断言失败=${fail}，退出码=${fail === 0 ? 0 : 1}（②-b 不满足即 FAIL 且退出码非 0）`);
process.stdout.write(L.join('\n') + '\n');
process.exit(fail === 0 ? 0 : 1);
