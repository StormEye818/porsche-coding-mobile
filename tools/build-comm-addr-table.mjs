#!/usr/bin/env node
/**
 * build-comm-addr-table.mjs — 按代聚合「完整」cat=0x10 地址表与静态分派证据，
 * 产出 data/comm-addr-table.json（HB-2 / HB-3 证据层，tools/verify-oem-probe-diff.mjs 复跑）。
 *
 * 纪律（PRD §3.1 HB-2 ④ / ⑥ / ⑦，团队裁定）：
 *   - 分母各自标源、禁止混算：527（cat=0x10 subs 全表）/ 402（仅 tx∈0x700–0x77F
 *     限定段满足 rx=tx+0x6A）/ 185（cat=0x60 block 四帧逐字节全同）/
 *     40（共享同一 16 候选的 sysId）/ 120（family-default sysId）/
 *     163/148/12（身份链）/ 3/13/16（候选分组）互不替代；
 *   - 不截断：按代输出完整 cat=0x10 地址表（10 代 39/33/31/36/33/27/46/34/38/40 条），
 *     每条带 ownerSysId / rx / rxRule；
 *   - 非 0x10 cat 低优先级候选标 commCat{20|30|50}-family + bindDirect:false，禁止直绑；
 *   - 凡「每候选 1 帧 / diff=空 / 帧数差=0」一律加「探针阶段」限定语。
 *
 * 输出 schema（架构师 §3.1 + 团队规格增量）：
 *   schemaVersion, source, generations[], limitCheck{}, lowPriorityCandidates,
 *   probeSequence{frames,flags,cat60BlockCount,byteIdentical,oemRef},
 *   probePhase{framesPerCandidate,uds,kwp,requestKey,oemRef},
 *   identityPhase{uds,kwp,oemRef}, byGeneration, familyDefaultSysIds,
 *   probeFrames, identityFrames, frameTemplateHex, stats。
 *
 * 跑法：node tools/build-comm-addr-table.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMM = join(ROOT, 'data', 'sysdata-comm.json');
const BIND = join(ROOT, 'data', 'bind-plan.json');
const IDENT = join(ROOT, 'data', 'ident-registry.json');
const OUT = join(ROOT, 'data', 'comm-addr-table.json');

const comm = JSON.parse(readFileSync(COMM, 'utf8'));
const bind = JSON.parse(readFileSync(BIND, 'utf8'));
const ident = JSON.parse(readFileSync(IDENT, 'utf8'));

const hex16 = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
const sortedKeys = (o) => Object.keys(o || {}).sort();

/** 10 代完整 cat=0x10 地址表的实测条数（PRD §3.1 HB-2 ④，硬校验）。 */
const SPEC_GEN_COUNTS = {
  0x0b: 39, 0x0c: 33, 0x0d: 31, 0x0e: 36, 0x0f: 33,
  0x10: 27, 0x12: 46, 0x14: 34, 0x15: 38, 0x16: 40,
};

/** rx 规则：由 (rx-tx) 静态复算，不改写原厂值。 */
function rxRuleOf(tx, rx) {
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

// ── 逐代聚合完整 cat=0x10 地址表（tx→rx 去重，保留 ownerSysId） ──────────
const byGen = {};
const cat10Subs = [];
const cat60Blocks = [];
const nonCat10Subs = [];
for (const sid of sortedKeys(comm.ecu || {})) {
  const gen = parseInt(sid, 16) >> 8;
  for (const blk of comm.ecu[sid].blocks || []) {
    if (blk.cat === 0x60) cat60Blocks.push({ sid, frames: blk.frames || [], subs: blk.subs || [] });
    for (const s of blk.subs || []) {
      if (typeof s.tx !== 'number' || typeof s.rx !== 'number') continue;
      if (blk.cat === 0x10) {
        cat10Subs.push({ sid, gen, tx: s.tx, rx: s.rx });
        const g = (byGen[gen] ??= { gen, genHex: '0x' + gen.toString(16).toUpperCase().padStart(2, '0'), ownerSysIds: new Set(), pairs: new Map() });
        g.ownerSysIds.add(sid);
        const key = `${s.tx}/${s.rx}`;
        const prev = g.pairs.get(key);
        if (prev) prev.ownerSysIds.add(sid);
        else g.pairs.set(key, { tx: s.tx, rx: s.rx, ownerSysId: sid, ownerSysIds: new Set([sid]), rxRule: rxRuleOf(s.tx, s.rx) });
      } else if (blk.cat !== 0x10) {
        nonCat10Subs.push({ sid, gen, cat: blk.cat, tx: s.tx, rx: s.rx });
      }
    }
  }
}

// 402/402 仅在 tx∈0x700–0x77F 限定段成立（全表 402/527，另 125 条老代）
const inRange = cat10Subs.filter((p) => p.tx >= 0x700 && p.tx <= 0x77F);
const plus6A = inRange.filter((p) => p.rx === p.tx + 0x6A);
const outOfRange = cat10Subs.filter((p) => !(p.tx >= 0x700 && p.tx <= 0x77F));
const outRuleDist = {};
for (const p of outOfRange) outRuleDist[rxRuleOf(p.tx, p.rx)] = (outRuleDist[rxRuleOf(p.tx, p.rx)] || 0) + 1;

// 185/185 四帧逐字节全同
const frameSigs = new Map();
for (const b of cat60Blocks) {
  const sig = JSON.stringify(b.frames);
  frameSigs.set(sig, (frameSigs.get(sig) || 0) + 1);
}
const dominantFrameSig = [...frameSigs.entries()].sort((a, b) => b[1] - a[1])[0];
const fourFrameByteIdentical = frameSigs.size === 1 && dominantFrameSig[1] === 185;

/** [flag,len,bytes...] → hex 帧（如 [0,2,62,0] → '3E00'）。 */
const frameHex = (f) => (f || []).slice(2).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
const templateFrames = JSON.parse(dominantFrameSig[0]);
const probeFrames = templateFrames.map(frameHex);
const frameFlags = templateFrames.map((f) => f[0]);

// ── 低优先级候选：非 0x10 cat 唯一 (tx,rx)，标 family + bindDirect:false ──
const cat10PairSet = new Set(cat10Subs.map((p) => `${p.tx}/${p.rx}`));
const nonCat10Unique = new Map();
for (const p of nonCat10Subs) {
  const key = `${p.tx}/${p.rx}`;
  const prev = nonCat10Unique.get(key);
  if (prev) { prev.cats.add(p.cat); prev.ownerSysIds.add(p.sid); }
  else nonCat10Unique.set(key, { tx: p.tx, rx: p.rx, cats: new Set([p.cat]), ownerSysIds: new Set([p.sid]) });
}
const familyCats = new Set([0x20, 0x30, 0x50]);
const lowPriorityAll = [];
for (const [key, p] of [...nonCat10Unique.entries()].sort()) {
  if (![...p.cats].some((c) => familyCats.has(c))) continue;      // 只标 commCat{20|30|50}-family
  if (cat10PairSet.has(key)) continue;                             // 与 cat=0x10 表重合的交给主表
  lowPriorityAll.push({
    tx: hex16(p.tx), rx: hex16(p.rx),
    ownerSysId: [...p.ownerSysIds].sort()[0],
    cats: [...p.cats].sort((a, b) => a - b).map((c) => '0x' + c.toString(16).toUpperCase()),
    rxRule: rxRuleOf(p.tx, p.rx),
    provenance: 'commCat{20|30|50}-family',
    bindDirect: false,
    note: '非 cat=0x10 家族地址，低优先级候选；禁止免探针直绑，只作探针候选（应答即绑）',
  });
}
// 「37 条」口径：cat=0x20 唯一 (tx,rx) 中不在 cat=0x10 表内者（实测 39−2=37）。
const cat20Only = [...nonCat10Unique.entries()].filter(([key, p]) =>
  [...p.cats].every((c) => c === 0x20) && !cat10PairSet.has(key));
if (cat20Only.length !== 37) {
  throw new Error(`低优先级主组应为 37 条（cat=0x20 唯一 tx/rx 不在 cat=0x10），实得 ${cat20Only.length}`);
}
const lowPriorityCandidates = lowPriorityAll.filter((p) => p.cats.length === 1 && p.cats[0] === '0x20');
if (lowPriorityCandidates.length !== 37) {
  throw new Error(`lowPriorityCandidates 主组应为 37 条，实得 ${lowPriorityCandidates.length}`);
}

// ── 按代输出（完整，不截断） ──────────────────────────────────────────
const generations = [];
for (const genStr of sortedKeys(byGen)) {
  const g = byGen[genStr];
  const pairs = [...g.pairs.values()].sort((a, b) => a.tx - b.tx || a.rx - b.rx).map((p) => ({
    tx: hex16(p.tx), rx: hex16(p.rx), ownerSysId: p.ownerSysId, rxRule: p.rxRule,
  }));
  const rules = [...new Set(pairs.map((p) => p.rxRule))].sort();
  generations.push({
    gen: g.genHex,
    ownerSysIds: [...g.ownerSysIds].sort(),
    pairCount: pairs.length,
    pairs,
    probeFrames,
    identityFrames: [...new Set(Object.values(ident.moduleIdent || {}).map((m) => m.request))].sort(),
    frameTemplateHex: probeFrames.join('→'),
    rxRule: rules.length === 1 ? rules[0] : rules,
  });
  // 10 代硬校验
  if (Object.prototype.hasOwnProperty.call(SPEC_GEN_COUNTS, g.gen) && SPEC_GEN_COUNTS[g.gen] !== pairs.length) {
    throw new Error(`gen ${g.genHex} 完整 cat=0x10 地址表应 ${SPEC_GEN_COUNTS[g.gen]} 条，实得 ${pairs.length}`);
  }
}
for (const gen of Object.keys(SPEC_GEN_COUNTS)) {
  if (!generations.some((g) => parseInt(g.gen, 16) === Number(gen))) {
    throw new Error(`缺少 10 代中的 gen 0x${Number(gen).toString(16)} 地址表`);
  }
}

// byGeneration（架构师规格增量：addresses[] / count / rxRule）
const byGeneration = {};
for (const g of generations) {
  byGeneration[g.gen] = {
    addresses: g.pairs,
    count: g.pairCount,
    rxRule: g.rxRule,
  };
}

// familyDefaultSysIds（按 provenance 显式过滤 commCat10-family-default 后计数）
const famDefault = {};
const famSids = Object.entries(bind.ecu || {})
  .filter(([, v]) => JSON.stringify(v.provenance || []).includes('commCat10-family-default'))
  .sort(([a], [b]) => a.localeCompare(b));
for (const [sid, e] of famSids) {
  const blocks = comm.ecu?.[sid]?.blocks || [];
  const cat60 = blocks.find((b) => b.cat === 0x60);
  const cat60Subs = cat60 ? (cat60.subs || []) : [];
  famDefault[sid] = {
    cands: (e.pairs || []).map((p) => ({ tx: p.tx, rx: p.rx })),
    cat60Index: cat60Subs.length ? hex16(cat60Subs[0].tx) : null,
    frameSig: cat60 ? cat60.frames.map(frameHex).join('→') : null,
  };
}
// fam120 候选分组（PRD 附录 A 权威 {3:28,13:2,16:90}）：
// 分组标签 = min(该代完整 cat=0x10 地址表条数, 16)。gen0x03=3 / gen0x13=13 /
// 其余 10 代=16。由完整静态地址表机读得出，不依赖 bind-plan 是否已删截断，
// 因此 build-comm-addr-table 与 export-bind-plan 先后顺序不影响结果（确定性）。
const genFullCount = {};
for (const g of generations) genFullCount[g.gen] = g.pairCount;
const famGroupDist = {};
const famFullDist = {};
for (const [sid, v] of famSids) {
  const genKey = '0x' + (parseInt(sid, 16) >> 8).toString(16).toUpperCase().padStart(2, '0');
  const full = genFullCount[genKey] || 0;
  const group = Math.min(full, 16);
  famGroupDist[group] = (famGroupDist[group] || 0) + 1;
  const n = (v.pairs || v.candidates || []).length;
  famFullDist[n] = (famFullDist[n] || 0) + 1;
}

// identityFrames：ident-registry.moduleIdent.request 分布（1A9F×6 / 22F1A2×6）
const identRequests = {};
for (const m of Object.values(ident.moduleIdent || {})) identRequests[m.request] = (identRequests[m.request] || 0) + 1;

const limitCheck = {
  cat10SubsTotal: cat10Subs.length,
  txRange700_77F: inRange.length,
  rxEqTxPlus6A: plus6A.length,
  cat60Blocks: cat60Blocks.length,
  fourFrameByteIdentical: fourFrameByteIdentical ? cat60Blocks.length : 0,
  fullTable402of527: `${plus6A.length}/${cat10Subs.length}`,
  txNotInRange: outOfRange.length,
  outOfRangeRuleDistribution: outRuleDist,
  cat60DistinctFrameSignatures: frameSigs.size,
  fam120: famSids.length,
  fam120CandidateDistribution: famGroupDist,
  fam120FullCandidateDistribution: famFullDist,
  lowPriorityPrimary37: cat20Only.length,
  lowPriorityAllFamilies: lowPriorityAll.length,
  identityRequestDistribution: identRequests,
  denominatorDiscipline: '527/402/185/40/120/163/148/12/3/13/16 各自标源、互不替代；402/402 仅在 tx∈0x700–0x77F 限定段成立；185/185 是 cat=0x60 block 四帧逐字节全同；120/120 与 163/163 分列独立断言、禁止混算',
};

const doc = {
  schemaVersion: 1,
  kind: 'comm-addr-table',
  source: 'data/sysdata-comm.json（cat=0x10 全表按代聚合 / cat=0x60 四帧模板 / 非 0x10 cat 低优先级族） + data/bind-plan.json（family-default 与 provenance） + data/ident-registry.json（moduleIdent.request）',
  generations,
  limitCheck,
  lowPriorityCandidates,
  lowPriorityCandidatesAllFamilies: lowPriorityAll,
  probeSequence: {
    frames: probeFrames,
    flags: frameFlags,
    cat60BlockCount: cat60Blocks.length,
    byteIdentical: fourFrameByteIdentical,
    oemRef: 'PORSCHE_SYS_DATA.BIN cat=0x60 记录（185/185 block 统一四帧）；GAG_COMMAND.GAG.bin 命令 ID 段 0x00200000-0x0020000A；L1 原厂包内静态',
    note: '四帧 3E00→22F19E→22F1A2→1003 是进模块后序列；74/74 与 185/185 是同一帧序的两个统计口径，只证 L1/L2 自洽，不证明 L3 运行时实发帧已对齐',
  },
  probePhase: {
    framesPerCandidate: 1,
    uds: '221409',
    kwp: '1A9F',
    requestKey: '0xFF001409',
    oemRef: 'libPORSCHE_LINK.so:0x18F00 DriveLinksMode_1001：候选循环 0x18F80-0x18F9C、movw/movt r10=0xFF001409、movs r2,#1（每候选 1 帧）、cbz r1,0x18F9E（n=0 直绑）、0x18FE2 movw r0,#0x1102 补帧 22 11 02、0x18FB2-0x18FBC send(0x100359,A,2) 绑定',
    note: '「每候选 1 帧 / diff=空 / 帧数差=0」一律限定在探针阶段；身份裁决阶段另见 identityPhase 与 ②-b 断言',
  },
  identityPhase: {
    uds: ['22F19E', '1A9B'],
    kwp: ['1A9B'],
    oemRef: 'cat=0x60 进模块四帧 3E00→22F19E→22F1A2→1003（185/185）；ident-registry.json moduleIdent.request 分布 1A9F×6 / 22F1A2×6；当前我方 finish()/identityAdjudicate 帧集为 22F19E+1A9B / 1A9B，与原厂四帧不一致（当前 B，待 T03-b R4 修法）',
    note: '②-b 身份裁决阶段：当前非 A，待 T03-b 落地后由 tools/verify-oem-probe-diff.mjs 硬断言切换',
  },
  byGeneration,
  familyDefaultSysIds: famDefault,
  probeFrames,
  identityFrames: [...new Set(Object.values(ident.moduleIdent || {}).map((m) => m.request))].sort(),
  frameTemplateHex: probeFrames.join('→'),
  stats: {
    generationCount: generations.length,
    pairCountTotal: generations.reduce((a, g) => a + g.pairCount, 0),
    cat10SubsTotal: cat10Subs.length,
    cat60BlockCount: cat60Blocks.length,
    lowPriorityCandidateCount: lowPriorityCandidates.length,
    lowPriorityAllFamiliesCount: lowPriorityAll.length,
    familyDefaultCount: famSids.length,
    fam120CandidateDistribution: famGroupDist,
    specGenerationCounts: SPEC_GEN_COUNTS,
  },
};
writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
console.log(`写出 data/comm-addr-table.json：${generations.length} 代 / ${doc.stats.pairCountTotal} 条完整地址对 / cat10Subs=${cat10Subs.length} / 402=${plus6A.length} / 185=${cat60Blocks.length} / 低优先级主组=${lowPriorityCandidates.length} / fam120=${famSids.length}`);
for (const g of generations) console.log(`  ${g.gen} pairCount=${g.pairCount} rxRule=${JSON.stringify(g.rxRule)}`);
console.log('limitCheck', JSON.stringify(limitCheck));
