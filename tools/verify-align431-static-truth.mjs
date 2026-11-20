#!/usr/bin/env node
/**
 * verify-align431-static-truth.mjs — T02 静态层真值确定性复算门禁。
 *
 * 真执行（无 mock、无快照信任）：
 *   ① 从 data/sysdata-comm.json 的 cat=0x10 raw 独立复算 tx=A>>5 / rx=C>>5；
 *   ② 与 data/comm-addr-table.json、data/bind-plan.json 双向核对；
 *   ③ 复算 623 / 408 / 296 / 172→0 / 302 / 281（大小写 + 0x 前缀归一）；
 *   ④ 校验 0x0e23 首选真值、0x0f4d 四元对象、Macan 0x0f23/0x0f34 双绑、
 *      Boxster/Cayman 文件集+items 签名校验、每条 cat=0x10 行带 provable。
 *
 * 反例注入必红：错 rx / 删 0x0e23 真值候选 / 删 0x0f4d 四元字段 /
 *   Macan 单绑 / 未做签名校验即允许合并。
 *
 * 用法：node tools/verify-align431-static-truth.mjs
 * stdout 每行机器可读：`PASS <ASSERT_NAME> <detail>` / `FAIL ...`；
 * 末行 `STATIC_TRUTH_PASS count=N` 或 `STATIC_TRUTH_FAIL failed=N`；退出码 0 / 1。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readText = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 大小写 + 0x 前缀归一后的整数（§7 归一口径）。 */
const norm = (x) => {
  if (typeof x === 'number') return x;
  const s = String(x).toLowerCase().replace(/^0x/, '');
  const v = Number.parseInt(s, 16);
  return Number.isFinite(v) ? v : Number.NaN;
};
const genOf = (sid) => parseInt(String(sid), 16) >> 8;
const keyOf = (sid) => String(sid).toLowerCase();
const hex4 = (v) => `0x${Number(v).toString(16).toUpperCase().padStart(4, '0')}`;

/** 与生成器独立实现的 rx 规则命名（按记录 delta，不查全局常量表）。 */
function ruleOf(tx, rx) {
  const d = rx - tx;
  if (d === 0x6A) return 'rx=tx+0x6A';
  if (d === 0x100) return 'rx=tx+0x100';
  if (d === 8) return 'rx=tx+8';
  if (d === 16) return 'rx=tx+0x10';
  if (d === 32) return 'rx=tx+0x20';
  if (d === 0) return 'rx=tx';
  if (d < 0) return 'rx<tx(非11位请求段的应答回绕/旧代编码)';
  return `rx=tx+0x${d.toString(16).toUpperCase()}`;
}

const results = [];
function assertEq(name, pass, detail) {
  const ok = Boolean(pass);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
}

const bp = readJson('data/bind-plan.json');
const comm = readJson('data/sysdata-comm.json');
const table = readJson('data/comm-addr-table.json');
const v3 = readJson('data/drivelinks-v3.json');
const menu = readJson('data/menu-tree-v3.json');
const allSysids = readJson('data/all-model-sysids.json');

// ── 独立真值：从 raw A/C 复算，绝不信任生成器写出的 tx/rx ───────────────
const rawTruth = new Map(); // sid -> Map<`tx/rx`, {tx,rx,rule,e0Coord}>
const encodingProblems = [];
let rawCat10Count = 0;
for (const [sid, entry] of Object.entries(comm.ecu || {})) {
  for (const block of entry.blocks || []) {
    if (block.cat !== 0x10) continue;
    for (const sub of block.subs || []) {
      if (typeof sub.tx !== 'number' || typeof sub.rx !== 'number') continue;
      rawCat10Count += 1;
      const raw = String(sub.raw || '');
      if (!/^0x[0-9a-fA-F]{8}$/.test(raw)) {
        encodingProblems.push(`${sid}:raw=${raw}`);
        continue;
      }
      const a = Number.parseInt(raw.slice(2, 6), 16) >> 5;
      const c = Number.parseInt(raw.slice(6, 10), 16) >> 5;
      if (a !== sub.tx || c !== sub.rx) {
        encodingProblems.push(`${sid}:${raw}→${hex4(a)}/${hex4(c)}≠${hex4(sub.tx)}/${hex4(sub.rx)}`);
        continue;
      }
      const rows = rawTruth.get(keyOf(sid)) || new Map();
      rows.set(`${a}/${c}`, {
        tx: a, rx: c, rule: ruleOf(a, c),
        e0Coord: `PORSCHE_SYS_DATA.BIN:${block.commOff || 'unknown'}`,
      });
      rawTruth.set(keyOf(sid), rows);
    }
  }
}

// ── 分母口径：evidence §7 以 comm-addr-table.byGeneration[].addresses[].ownerSysId 为准 ──
const ownerTruth = new Map(); // sid -> [{tx,rx,rule}]
let tableRowCount = 0;
const tableRuleProblems = [];
for (const group of Object.values(table.byGeneration || {})) {
  for (const row of group.addresses || []) {
    tableRowCount += 1;
    const owner = keyOf(row.ownerSysId);
    const tx = norm(row.tx);
    const rx = norm(row.rx);
    const expected = ruleOf(tx, rx);
    if (row.rxRule !== expected) tableRuleProblems.push(`${owner}:${row.tx}/${row.rx}:${row.rxRule}≠${expected}`);
    if (row.provable !== 'static' || !row.e0Coord || !row.raw) {
      tableRuleProblems.push(`${owner}:缺 provable/e0Coord/raw`);
    }
    const arr = ownerTruth.get(owner) || [];
    arr.push({ tx, rx, rule: row.rxRule || expected });
    ownerTruth.set(owner, arr);
  }
}

const ecu = bp.ecu || {};
const ecuIds = Object.keys(ecu);

// ① 623 / 408 / 296
assertEq('STATIC_TRUTH_623_SYSIDS', ecuIds.length === 623, `count=${ecuIds.length}`);
const baseline = bp.truthBaseline || {};
assertEq('STATIC_TRUTH_BASELINE_EVIDENCE',
  baseline.genBelow14TruthSysIds === 296 && baseline.genBelow14MissingBefore === 172 &&
  baseline.genBelow14TruthPairs === 302 && baseline.genBelow14RxNotPlus8 === 281 &&
  Array.isArray(baseline.evidence) && baseline.evidence.length >= 2,
  `baseline=${JSON.stringify(baseline)}`);
const truthInEcu = [...ownerTruth.keys()].filter((s) => Object.prototype.hasOwnProperty.call(ecu, s));
assertEq('STATIC_TRUTH_408_TRUTH_SYSIDS', truthInEcu.length === 408, `count=${truthInEcu.length}`);
const below14 = truthInEcu.filter((s) => genOf(s) < 0x14);
assertEq('STATIC_TRUTH_296_GEN_BELOW14_TRUTH', below14.length === 296, `count=${below14.length}`);

// ② 172→0（大小写 + 0x 前缀归一）
const missing = [];
for (const sid of below14) {
  const canSet = new Set((ecu[sid].cands || []).map(norm));
  if (!ownerTruth.get(sid).some((t) => canSet.has(t.tx))) missing.push(sid);
}
assertEq('STATIC_TRUTH_172_MISSING_ZERO', missing.length === 0,
  `missing=${missing.length} baseline=${baseline.genBelow14MissingBefore} sample=${missing.slice(0, 4).join(',')}`);

// ③ 302 / 281
const pairs = below14.flatMap((sid) => ownerTruth.get(sid));
const notPlus8 = pairs.filter((t) => t.rule !== 'rx=tx+8');
assertEq('STATIC_TRUTH_302_PAIRS', pairs.length === 302, `count=${pairs.length}`);
assertEq('STATIC_TRUTH_281_RX_NOT_PLUS8', notPlus8.length === 281, `count=${notPlus8.length}`);

// ④ raw A/C 编码 + rxRule 原样保留 + provable 必填
const tableRowsWithOwner = [];
for (const [sid, rows] of rawTruth) {
  for (const row of rows.values()) tableRowsWithOwner.push({ sid, ...row });
}
assertEq('STATIC_TRUTH_RAW_AC_ENCODING', rawCat10Count === 527 && encodingProblems.length === 0,
  `cat10Subs=${rawCat10Count} problems=${encodingProblems.length} sample=${encodingProblems.slice(0, 3).join(',')}`);
// 每条表行必须能在该 owner 的 raw A/C 真值里逐字节找到（rx/rule 同时一致）。
const tableVsRawProblems = [];
for (const group of Object.values(table.byGeneration || {})) {
  for (const row of group.addresses || []) {
    const owner = keyOf(row.ownerSysId);
    const expected = rawTruth.get(owner)?.get(`${norm(row.tx)}/${norm(row.rx)}`);
    if (!expected || expected.rule !== row.rxRule) {
      tableVsRawProblems.push(`${owner}:${row.tx}/${row.rx}:${row.rxRule}`);
    }
  }
}
assertEq('STATIC_TRUTH_COMM_TABLE_MATCHES_RAW', tableRuleProblems.length === 0 && tableVsRawProblems.length === 0,
  `tableRows=${tableRowCount} ruleProblems=${tableRuleProblems.length} rawMismatch=${tableVsRawProblems.length} sample=${tableVsRawProblems.slice(0, 3).join(',')}`);

// ⑤ rx 优先取记录 C：逐条比对 bind-plan pairs 与独立 raw 真值
const wrongRx = [];
const globalPlus8 = [];
let truthPairChecks = 0;
for (const [sid, rows] of rawTruth) {
  const entry = ecu[sid];
  if (!entry) continue;
  const truthTx = new Map([...rows.values()].map((r) => [r.tx, r]));
  const stated = new Map((entry.truth || []).map((t) => [norm(t.tx), t]));
  for (const [tx, expect] of truthTx) {
    truthPairChecks += 1;
    const pair = (entry.pairs || []).find((p) => norm(p.tx) === tx);
    if (!pair || norm(pair.rx) !== expect.rx) {
      wrongRx.push(`${sid}:${hex4(tx)} expect=${hex4(expect.rx)} got=${pair ? pair.rx : 'MISSING'}`);
    }
    if (expect.rx !== tx + 8 && pair && norm(pair.rx) === tx + 8) {
      globalPlus8.push(`${sid}:${hex4(tx)}`);
    }
    const declared = stated.get(tx);
    if (!declared || norm(declared.rx) !== expect.rx || declared.rxRule !== expect.rule) {
      wrongRx.push(`${sid}:truth字段与raw不一致`);
    }
  }
}
assertEq('STATIC_TRUTH_RX_FROM_RECORD_C', wrongRx.length === 0,
  `checked=${truthPairChecks} wrong=${wrongRx.length} sample=${wrongRx.slice(0, 3).join(',')}`);
assertEq('STATIC_TRUTH_RX_NOT_GLOBAL_PLUS8', globalPlus8.length === 0,
  `overridden=${globalPlus8.length} sample=${globalPlus8.slice(0, 3).join(',')}`);

// ⑥ 0x0e23 首选真值 0x070D / 0x0777 (+0x6A)
const e23 = ecu['0x0e23'] || {};
const e23Pair = (e23.pairs || []).find((p) => norm(p.tx) === 0x70D);
assertEq('STATIC_TRUTH_E0_0E23',
  norm((e23.cands || [])[0]) === 0x70D && e23Pair && norm(e23Pair.rx) === 0x777 &&
  e23Pair.rxRule === 'rx=tx+0x6A' &&
  (rawTruth.get('0x0e23') || new Map()).has('1805/1911'),
  `cands=${(e23.cands || []).slice(0, 3).join(',')} rx=${e23Pair ? e23Pair.rx : 'MISSING'} rule=${e23Pair ? e23Pair.rxRule : 'MISSING'}`);

// ⑦ 0x0f4d 四元对象（直接字段 + fourTuple 双份齐全）
const f4d = ecu['0x0f4d'] || {};
const four = f4d.fourTuple || {};
const expectedKeys = [0x06CC, 0x06CD, 0x06CE, 0x06CF];
const fieldsMatch = ['sysId', 'sysName', 'requestKey', 'can', 'altIdentitySysIds', 'identityRule']
  .every((k) => Object.prototype.hasOwnProperty.call(four, k) &&
    JSON.stringify(four[k]) === JSON.stringify(f4d[k]));
const fourOk = fieldsMatch &&
  four.sysId === '0x0f4d' && four.sysName === 'SWA2_BaseSys' &&
  JSON.stringify(four.requestKey) === JSON.stringify(expectedKeys) &&
  four.can && norm(four.can.tx) === 0x74E && norm(four.can.rx) === 0x7B8 &&
  four.can.rxRule === 'rx=tx+0x6A' && four.can.provable === 'static' &&
  JSON.stringify(four.altIdentitySysIds) === JSON.stringify(['0x0e5f', '0x0e60']) &&
  typeof four.identityRule === 'string' && four.identityRule.includes('PARTNUMBER') &&
  four.provable === 'static';
assertEq('STATIC_TRUTH_FOUR_TUPLE_0F4D', fourOk,
  `four=${JSON.stringify(four)} directMatch=${fieldsMatch}`);

// ⑧ 请求键低 16 位不得成为 CAN 来源（provenance 路径级硬断言）
const forbiddenSources = new Set(['v3key', 'v3cand', 'v3candRx']);
let badSourceCount = 0;
let unprovenCandCount = 0;
for (const [sid, entry] of Object.entries(ecu)) {
  for (const p of entry.provenance || []) {
    for (const s of p.sources || []) {
      if (forbiddenSources.has(s) || /^0x0030|^0xFF60/i.test(String(s))) badSourceCount += 1;
    }
  }
  if (genOf(sid) < 0x0E) continue;
  const provenCans = new Set((entry.provenance || [])
    .filter((p) => p.can && (p.sources || []).some((s) => !forbiddenSources.has(s)))
    .map((p) => norm(p.can)));
  for (const c of entry.cands || []) {
    if (!provenCans.has(norm(c))) unprovenCandCount += 1;
  }
}
assertEq('STATIC_TRUTH_NO_REQUESTKEY_AS_CAN', badSourceCount === 0 && unprovenCandCount === 0,
  `forbiddenSources=${badSourceCount} unprovenCandidates=${unprovenCandCount}`);

// ⑨ provable / E0 坐标齐备（含每条 cat=0x10 表行）
let missingProvable = 0;
for (const [sid, entry] of Object.entries(ecu)) {
  if (entry.provable !== 'static' || !entry.e0Coord) missingProvable += 1;
  for (const p of entry.provenance || []) {
    if (!p.provable || !p.e0Coord) missingProvable += 1;
  }
}
assertEq('STATIC_TRUTH_PROVABLE_PRESENT', missingProvable === 0, `missing=${missingProvable}`);

// ⑩ rx 规则原样分布（禁 &0x7FF 回绕 / 禁 +0x6A 全局常量化）
const ruleSet = [...new Set(tableRowsWithOwner.map((r) => r.rule))].sort();
const requiredRules = ['rx=tx+0x6A', 'rx=tx+0x100', 'rx=tx+8', 'rx<tx(非11位请求段的应答回绕/旧代编码)'];
const staticTruth = table.staticTruth || {};
assertEq('STATIC_TRUTH_RX_RULE_DIVERSITY',
  requiredRules.every((r) => ruleSet.includes(r)) && staticTruth.provable === 'static' &&
  JSON.stringify(staticTruth.distinctRxRules || []) === JSON.stringify(ruleSet),
  `rules=${JSON.stringify(ruleSet)} staticTruth=${JSON.stringify(staticTruth.distinctRxRules || [])}`);
const ltTx = table.limitCheck?.outOfRangeRuleDistribution?.['rx<tx(非11位请求段的应答回绕/旧代编码)'] || 0;
const wrapRows = tableRowsWithOwner.filter((r) => r.rx > 0x7FF || r.tx > 0x7FF);
assertEq('STATIC_TRUTH_NO_7FF_WRAP', wrapRows.length === 0 && ltTx === 5 &&
  tableRuleProblems.length === 0,
  `outOf11BitRows=${wrapRows.length} outOfRangeRxLtTx=${ltTx}`);

// ⑪ Macan「后端电子设备」双绑：0x0f23(BCM_hinten) + 0x0f34(Heckklappe)
const macanNode = (() => {
  for (const group of menu.groups || []) {
    for (const model of group.models || []) {
      if (model.label !== 'Macan') continue;
      for (const fn of model.functions || []) {
        for (const sys of fn.systems || []) {
          if (sys.ref === '后端电子设备|16845') return sys;
        }
      }
    }
  }
  return null;
})();
const cajunModules = (allSysids.platforms || {}).CAJUN?.modules || {};
const macanSysIds = (macanNode?.modules || []).map((m) => keyOf(cajunModules[m]?.sysId || ''));
const f23 = ecu['0x0f23'] || {};
const f34 = ecu['0x0f34'] || {};
const f23Tx = [...(rawTruth.get('0x0f23') || new Map()).values()].map((r) => r.tx).sort((a, b) => a - b);
const f34Tx = [...(rawTruth.get('0x0f34') || new Map()).values()].map((r) => r.tx).sort((a, b) => a - b);
const macanOk = macanSysIds.includes('0x0f23') && macanSysIds.includes('0x0f34') &&
  f23Tx.length > 0 && f34Tx.length > 0 &&
  f23Tx.some((t) => (f23.cands || []).map(norm).includes(t)) &&
  f34Tx.some((t) => (f34.cands || []).map(norm).includes(t)) &&
  !f23Tx.some((t) => f34Tx.includes(t)) &&
  JSON.stringify(f23.blockOff || []) !== JSON.stringify(f34.blockOff || []);
assertEq('STATIC_TRUTH_MACAN_DUAL_BIND', macanOk,
  `menuSysIds=${macanSysIds.join(',')} f23Tx=${f23Tx.map(hex4).join(',')} f34Tx=${f34Tx.map(hex4).join(',')} blockOff=${JSON.stringify(f23.blockOff)}/${JSON.stringify(f34.blockOff)}`);

const e59 = ecu['0x0e59'] || {};
const e5a = ecu['0x0e5a'] || {};
assertEq('STATIC_TRUTH_SAME_BLOCKOFF_PAIR',
  JSON.stringify(e59.blockOff || []) === JSON.stringify(e5a.blockOff || []) &&
  (e59.blockOff || []).length > 0,
  `0x0e59=${JSON.stringify(e59.blockOff)} 0x0e5a=${JSON.stringify(e5a.blockOff)}`);

// ⑫ Boxster/Cayman 文件集 + items 签名全等才允许合并（反例：986 vs 987）
const mergePairs = [
  ['Boxster_981_', 'Cayman_981_'],
  ['Boxster_982_', 'Cayman_982_'],
  ['Boxster_987_', 'Cayman_987_'],
  ['Boxster_986_', 'Cayman_987_'],
];
const modelRoot = join(ROOT, 'data', 'models');
const sigOf = (dir, file) => {
  const items = JSON.parse(readFileSync(join(modelRoot, dir, file), 'utf8')).items || [];
  return JSON.stringify(items.map((i) => [i.module, i.lid, i.readSid]));
};
const mergeProblems = [];
for (const [left, right] of mergePairs) {
  const aFiles = readdirSync(join(modelRoot, left)).filter((f) => f.endsWith('.json')).sort();
  const bFiles = readdirSync(join(modelRoot, right)).filter((f) => f.endsWith('.json')).sort();
  const onlyA = aFiles.filter((f) => !bFiles.includes(f));
  const onlyB = bFiles.filter((f) => !aFiles.includes(f));
  const shared = aFiles.filter((f) => bFiles.includes(f));
  const sigDiff = shared.filter((f) => sigOf(left, f) !== sigOf(right, f));
  const equal = onlyA.length === 0 && onlyB.length === 0 && sigDiff.length === 0;
  const label = `${left}|${right}`;
  const stored = (bp.datasetMerge || {})[label] || {};
  if (stored.allowed !== equal || stored.signatureEqual !== equal ||
      stored.fileSetEqual !== (onlyA.length === 0 && onlyB.length === 0) ||
      stored.signatureDiff !== sigDiff.length) {
    mergeProblems.push(`${label}:stored=${JSON.stringify(stored)} recomputed=${equal}`);
  }
}
const sourcePy = readText('tools/export-bind-plan.py');
const hasSignatureCheck = sourcePy.includes('model_items_signature') &&
  sourcePy.includes('signatureEqual') && sourcePy.includes('sig_diff');
assertEq('STATIC_TRUTH_DATASET_SIGNATURE_EQUAL',
  mergeProblems.length === 0 && hasSignatureCheck && (bp.datasetMerge || {})['Boxster_981_|Cayman_981_']?.allowed === true &&
  (bp.datasetMerge || {})['Boxster_986_|Cayman_987_']?.allowed === false,
  `problems=${mergeProblems.length} hasSignatureCheck=${hasSignatureCheck}`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `STATIC_TRUTH_FAIL failed=${failed} total=${results.length}` : `STATIC_TRUTH_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
