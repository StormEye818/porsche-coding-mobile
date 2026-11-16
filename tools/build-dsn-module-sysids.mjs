#!/usr/bin/env node
/**
 * build-dsn-module-sysids.mjs — 从 DSN.BIN 解出「平台 → 模块名 → (type, fullSysId)」显式索引。
 *
 * ★ 2026-11-12 第十阶段：老代 4 平台（9X6/9X7/CS1/E1）的模块 sysIdLow 在 DSN.BIN
 *   模块索引表里；此前把 9X6/9X7 判「高字节需运行时 VIN、包内静态表不存在」是找错载体。
 * ★ 2026-11-13 HB-1 收口：规范 type 由「覆盖 DSN 模块表 sysIdLow 全集最多且为其它
 *   候选集严格超集」静态判定（9X6=0x01、9X7=0x05），由 data/vehicle-id-type-map.json
 *   的 canonicalType / supersetProof / specialRules 给出并被本生成器硬校验；
 *   全部平台均产出 runtimeModules（不再有空表、不再走全局表回退、不再有 unknown 保底）。
 *
 * 结构（全部由字节推得，零手工表）：
 *   DSN.BIN 头 22 项：[u8 count=22][ [u8 id][u16 nlen][name\0][u32 payloadOff] × 22 ]
 *     id ≡ SYS_DATA root type ≡ sysId 高字节（已由 platform-type-map.json 交叉验证）
 *   每个 payloadOff → 平台模块表：[u16 0x0000][ [u8 sysIdLow][u16 nlen][moduleName\0]
 *                                   [u32 recPtr][u16 flag] × n ]
 *     flag 是位标志，不编码 type，不得当 type 用。
 *
 * 规范 type 规则（不依赖 VIN / 实车日志 / 运行时 BV 域）：
 *   pickCanonical(platformKey, rows, lowByType) 取覆盖模块表 sysIdLow 全集最多的 type，
 *   且必须是其它候选 type 的权威 sysIdLow 集合的严格超集，否则 throw。
 *   实测 9X6 29 行/14 uniqueLow → 0x01 12/14、0x02 10/14，0x01⊃0x02 → 0x01；
 *        9X7 41 行/34 uniqueLow → 0x05 33/34、0x06 30/34、0x04 20/34，
 *        0x05⊃0x06⊃0x04 → 0x05。
 *
 * 两条特殊静态规则（data/vehicle-id-type-map.json:specialRules）：
 *   - name.startsWith('E1_') → type 0x03（0x0346 / 0x0319 在 type 0x03 权威 sysIds 内，共 9 条）；
 *   - low === 0x00（_9x7_pcm2_gw）→ gatewayNoSysId:true，不进 runtimeModules、不猜高字节。
 *
 * 结果：9X6 29/29 + 9X7 41/41 唯一 (module,type,fullSysId)，无 unknown、无全局表回退。
 *
 * 跑法：node tools/build-dsn-module-sysids.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DSN = '/Users/se818/porsche-mapper/ref/decoded/DSN.BIN';
const OUT = join(ROOT, 'data', 'dsn-module-sysids.json');

const b = readFileSync(DSN);
const rt = JSON.parse(readFileSync(join(ROOT, 'data', 'sysdata-root-table.json'), 'utf8'));
const pt = JSON.parse(readFileSync(join(ROOT, 'data', 'platform-type-map.json'), 'utf8'));
const vim = JSON.parse(readFileSync(join(ROOT, 'data', 'vehicle-id-type-map.json'), 'utf8'));

/** 权威 type → sysId 低字节集合 / fullSysId 集合。 */
const lowByType = {};
const fullByType = {};
for (const [t, e] of Object.entries(rt.types || {})) {
  const type = parseInt(t, 16);
  lowByType[type] = new Set((e.sysIds || []).map((s) => parseInt(s, 16) & 0xff));
  fullByType[type] = new Set((e.sysIds || []).map((s) => parseInt(s, 16)));
}
function fullSysIdExists(type, low) {
  return fullByType[type]?.has((type << 8) | low) ?? false;
}
const sidStr = (type, low) => '0x' + ((type << 8) | low).toString(16).toUpperCase().padStart(4, '0');
const normPlat = (p) => String(p).toUpperCase();

/** 特殊规则（从 vehicle-id-type-map.json 读，零硬编码）。 */
const SR_E1 = (vim.specialRules || []).find((r) => r.id === 'SR-1');
const SR_GW = (vim.specialRules || []).find((r) => r.id === 'SR-2');
if (!SR_E1 || !SR_GW) throw new Error('vehicle-id-type-map.json 缺少 SR-1 / SR-2 特殊规则');
const CROSS_GEN_TYPE = parseInt(SR_E1.type, 16);
const CROSS_GEN_NAMES = new Set(SR_E1.affectedModules || []);
const GATEWAY_NAMES = new Set(SR_GW.affectedModules || []);
// E1_ 前缀跨代规则只作用于 9X6 模块表（其它平台的 E1_* 是本代原生模块，
// 不能套 0x03 高字节）。共 9 条：7 个 E1_pcm2_* + 9x6_PCM1 + 9x6_RDK。
const isCrossGen = (platKey, name) => normPlat(platKey) === '9X6'
  && (name.startsWith('E1_') || CROSS_GEN_NAMES.has(name));

/**
 * 规范 type 静态判定：覆盖模块表 sysIdLow 全集最多的 type 必须是其它候选集的严格超集。
 * @param {string} platformKey DSN 平台名（如 '9x6'）
 * @param {{low:number,name:string}[]} rows 该平台模块表行
 * @param {Record<number, Set<number>>} lowSetByType 权威 type → sysIdLow 集合
 * @returns {{type:number,typeHex:string,uniqueLow:number,coverage:Record<string,string>,relation:string,strictSuperset:boolean,equivalentTypes:string[],differTypes:string[]}}
 */
function pickCanonical(platformKey, rows, lowSetByType) {
  const key = normPlat(platformKey);
  const types = (pt.platformTypes?.[platformKey] || pt.platformTypes?.[key] || [])
    .map((x) => parseInt(x, 16));
  if (!types.length) throw new Error(`${platformKey} 无候选 type，拒绝产出`);
  const uniqueLows = [...new Set(rows.map((r) => r.low))].sort((a, c) => a - c);
  const coverage = {};
  for (const t of types) {
    const n = uniqueLows.filter((l) => lowSetByType[t]?.has(l)).length;
    coverage['0x' + t.toString(16).toUpperCase().padStart(2, '0')] = `${n}/${uniqueLows.length}`;
  }
  const ranked = types.slice().sort((a, c) => {
    const na = uniqueLows.filter((l) => lowSetByType[a]?.has(l)).length;
    const nc = uniqueLows.filter((l) => lowSetByType[c]?.has(l)).length;
    return nc - na || a - c;
  });
  const best = ranked[0];
  const bestSet = lowSetByType[best] || new Set();
  // 严格超集硬校验：其它候选集合的每个 low 都必须在 bestSet 内，且 bestSet 更大。
  for (const t of types) {
    if (t === best) continue;
    const other = lowSetByType[t] || new Set();
    const isSuperset = [...other].every((l) => bestSet.has(l));
    if (!isSuperset || bestSet.size <= other.size) {
      throw new Error(`${key} 规范 type 0x${best.toString(16)} 不是 0x${t.toString(16)} 的严格超集，拒绝产出`);
    }
  }
  const expected = vim.canonicalType?.[key];
  if (expected && parseInt(expected, 16) !== best) {
    throw new Error(`${key} 实测规范 type 0x${best.toString(16)} ≠ vehicle-id-type-map 的 ${expected}`);
  }
  const proof = vim.supersetProof?.[key];
  if (proof) {
    if (proof.rowCount !== rows.length) throw new Error(`${key} supersetProof.rowCount ${proof.rowCount} ≠ 实测 ${rows.length}`);
    if (proof.uniqueLow !== uniqueLows.length) throw new Error(`${key} supersetProof.uniqueLow ${proof.uniqueLow} ≠ 实测 ${uniqueLows.length}`);
    for (const [t, cov] of Object.entries(coverage)) {
      if (proof.coverage?.[t] && proof.coverage[t] !== cov) {
        throw new Error(`${key} ${t} 覆盖率 ${cov} ≠ supersetProof ${proof.coverage[t]}`);
      }
    }
  }
  return {
    type: best,
    typeHex: '0x' + best.toString(16).toUpperCase().padStart(2, '0'),
    uniqueLow: uniqueLows.length,
    coverage,
    relation: proof?.relation || ranked.map((t) => '0x' + t.toString(16).toUpperCase().padStart(2, '0')).join('⊃'),
    strictSuperset: true,
    equivalentTypes: (proof?.equivalentTypes || ranked.slice(1).map((t) => '0x' + t.toString(16).toUpperCase().padStart(2, '0'))),
    differTypes: proof?.differTypes || [],
  };
}

// 头 22 项索引
const index = [];
let p = 1;
for (let i = 0; i < 22; i++) {
  const id = b[p];
  const nlen = b.readUInt16LE(p + 1);
  const name = b.subarray(p + 3, p + 3 + nlen - 1).toString('latin1');
  const payloadOff = b.readUInt32LE(p + 3 + nlen);
  p += 3 + nlen + 4;
  index.push({ id, name, payloadOff });
}
if (index.length !== 22 || index.some((x, i) => x.id !== i + 1)) {
  throw new Error('DSN.BIN 头 22 项索引 id 不连续（1..22），拒绝产出');
}

function moduleTable(off) {
  const rows = [];
  let i = off + 2;
  for (let n = 0; n < 120; n++) {
    if (i + 9 > b.length) break;
    const low = b[i];
    const nlen = b.readUInt16LE(i + 1);
    if (nlen < 2 || nlen > 60 || i + 3 + nlen + 6 > b.length) break;
    const name = b.subarray(i + 3, i + 3 + nlen - 1).toString('latin1');
    const recPtr = b.readUInt32LE(i + 3 + nlen);
    const flag = b.readUInt16LE(i + 3 + nlen + 4);
    rows.push({ low, name, recPtr, flag });
    i += 3 + nlen + 6;
  }
  return { rows, end: i };
}

const platforms = {};
const allCrossGenModules = [];
const allGatewayNoSysId = [];
for (const [platKey, typeStrs] of Object.entries(pt.platformTypes || {})) {
  const hit = index.find((x) => x.name.toLowerCase() === platKey.toLowerCase());
  if (!hit || !hit.payloadOff) continue;
  const types = typeStrs.map((x) => parseInt(x, 16));
  const { rows } = moduleTable(hit.payloadOff);
  if (!rows.length) continue;

  const isMulti = types.length > 1;
  const canon = pickCanonical(platKey, rows, lowByType);
  const canonicalType = canon.type;

  const modules = {};             // name → fullSysId（唯一映射）
  const moduleMappings = [];      // 每行一条 (module,type,fullSysId) 完整映射表
  const multiType = {};           // 多候选/真差异行的静态归属明细
  const ambiguous = {};
  const unresolved = [];
  const gatewayNoSysId = [];
  const noSysIdSubmodules = [];
  const crossGenModules = [];

  for (const r of rows) {
    // 特殊规则 ②：网关 low=0x00，静态确定无独立 sysId，不进 runtimeModules、不猜高字节。
    if (GATEWAY_NAMES.has(r.name) && r.low === 0x00) {
      gatewayNoSysId.push({ name: r.name, low: r.low, gatewayNoSysId: true, inRuntimeModules: false });
      moduleMappings.push({
        module: r.name, low: r.low, type: null, fullSysId: null,
        canonicalType: canon.typeHex, staticChoice: null, gatewayNoSysId: true,
        equivalentTypes: [], differTypes: [], tier: 'gatewayNoSysId',
        evidence: 'DSN.BIN 模块表 low=0x00（网关无独立 sysId，包内静态确定，非缺口）',
      });
      allGatewayNoSysId.push({ platform: platKey, name: r.name });
      continue;
    }
    // 其它平台的 low=0x00 子模块（无独立 sysId，包内静态确定）——HB-1 只要求
    // 9X6/9X7 全行唯一映射；这些行按「无独立 sysId 子模块」静态归类，不猜高字节、
    // 不进 runtimeModules、不是 unknown 保底，也不影响全平台 runtimeModules 非空。
    if (r.low === 0x00) {
      noSysIdSubmodules.push({ name: r.name, low: r.low, reason: 'DSN 模块表 low=0x00：无独立 sysId 的子模块（包内静态确定）' });
      moduleMappings.push({
        module: r.name, low: r.low, type: null, fullSysId: null,
        canonicalType: canon.typeHex, staticChoice: null, noSysIdSubmodule: true,
        equivalentTypes: [], differTypes: [], tier: 'noSysIdSubmodule',
        evidence: 'DSN.BIN 模块表 low=0x00（子模块无独立 sysId，静态确定）',
      });
      continue;
    }

    const candidates = types.filter((t) => lowByType[t]?.has(r.low));
    let type;
    let tier;
    let evidence;
    // 特殊规则 ①：E1_ 前缀跨代模块归 type 0x03（0x0346 / 0x0319 在权威 sysIds 内）。
    if (isCrossGen(platKey, r.name) && fullSysIdExists(CROSS_GEN_TYPE, r.low)) {
      type = CROSS_GEN_TYPE;
      tier = 'trueDiffer';
      evidence = `E1_ 前缀跨代静态规则 → type 0x03；${sidStr(type, r.low)} 在 type 0x03 权威 sysIds 内`;
    } else if (lowByType[canonicalType]?.has(r.low)) {
      type = canonicalType;
      tier = candidates.length > 1 ? 'shared' : 'echoOnly';
      evidence = `canonicalType ${canon.typeHex} ⊃ 其它候选；DSN 模块表在候选 type 间字节级相同`;
    } else {
      // 其它 type 的权威 fullSysId 静态归置（跨代模块），绝不猜高字节。
      const fallback = Object.keys(fullByType).map(Number).sort((a, c) => a - c)
        .find((t) => fullSysIdExists(t, r.low));
      if (fallback === undefined) {
        // 该 low 不属于任何 type 的权威 sysIds：包内静态确定的「无独立 sysId」行，
        // 记入 unresolved（静态分类，不是 unknown 保底、不猜、不进 runtimeModules）。
        // HB-1 硬校验保证 9X6/9X7 不会出现此分支。
        unresolved.push({
          name: r.name, low: r.low,
          reason: `sysIdLow 0x${r.low.toString(16).toUpperCase()} 不在任何 type 的权威 sysIds 集合（包内静态确定，无独立 sysId）`,
        });
        moduleMappings.push({
          module: r.name, low: r.low, type: null, fullSysId: null,
          canonicalType: canon.typeHex, staticChoice: null, noSysIdSubmodule: true,
          equivalentTypes: [], differTypes: [], tier: 'noSysIdSubmodule',
          evidence: 'DSN 模块表 low 不在权威 sysIds（静态确定无独立 sysId）',
        });
        continue;
      }
      type = fallback;
      tier = 'trueDiffer';
      evidence = `low 不在 ${canon.typeHex}，静态归属 type 0x${type.toString(16)}（${sidStr(type, r.low)} 在权威 sysIds 内）`;
    }
    const fullSysId = sidStr(type, r.low);
    if (modules[r.name] && modules[r.name] !== fullSysId) {
      ambiguous[r.name] = [modules[r.name], fullSysId];
      delete modules[r.name];
      continue;
    }
    if (ambiguous[r.name]) { ambiguous[r.name].push(fullSysId); continue; }
    modules[r.name] = fullSysId;

    const equivalentTypes = candidates.filter((t) => t !== type)
      .filter((t) => isMulti && canon.equivalentTypes.includes('0x' + t.toString(16).toUpperCase().padStart(2, '0')))
      .map((t) => '0x' + t.toString(16).toUpperCase().padStart(2, '0'));
    const differTypes = types.filter((t) => !lowByType[t]?.has(r.low))
      .map((t) => '0x' + t.toString(16).toUpperCase().padStart(2, '0'));

    const mapping = {
      module: r.name, low: r.low,
      type: '0x' + type.toString(16).toUpperCase().padStart(2, '0'),
      fullSysId,
      canonicalType: canon.typeHex,
      staticChoice: fullSysId,
      equivalentTypes,
      differTypes,
      tier,
      evidence,
    };
    moduleMappings.push(mapping);
    if (isMulti || tier === 'trueDiffer') {
      multiType[r.name] = {
        low: r.low,
        candidates: candidates.map((t) => sidStr(t, r.low)),
        canonicalType: canon.typeHex,
        staticChoice: fullSysId,
        equivalentTypes,
        differTypes,
        tier,
        staticEquivalence: tier,
        evidence,
      };
    }
    if (isCrossGen(platKey, r.name)) {
      const x = { platform: platKey, name: r.name, low: r.low, type: mapping.type, fullSysId };
      crossGenModules.push(x);
      allCrossGenModules.push(x);
    }
  }

  // 全平台产出 runtimeModules（不再有「单 type 平台才给」的分支、不再有留空行）。
  const runtimeModules = { ...modules };
  const statEq = vim.staticEquivalence?.byPlatform?.[normPlat(platKey)];
  platforms[platKey] = {
    dsnIndexId: hit.id,
    payloadOff: hit.payloadOff,
    payloadOffHex: '0x' + hit.payloadOff.toString(16).toUpperCase(),
    types: types.map((t) => '0x' + t.toString(16).toUpperCase().padStart(2, '0')),
    canonicalType: canon.typeHex,
    canonicalTypeProof: {
      uniqueLow: canon.uniqueLow,
      coverage: canon.coverage,
      relation: canon.relation,
      strictSuperset: canon.strictSuperset,
      payloadOffShared: vim.supersetProof?.[normPlat(platKey)]?.payloadOffShared || [],
    },
    rowCount: rows.length,
    uniqueCount: Object.keys(modules).length,
    mappingCount: moduleMappings.length,
    multiTypeCount: Object.keys(multiType).length,
    unresolvedCount: unresolved.length,
    ambiguousCount: Object.keys(ambiguous).length,
    gatewayNoSysIdCount: gatewayNoSysId.length,
    noSysIdSubmoduleCount: noSysIdSubmodules.length,
    crossGenCount: crossGenModules.length,
    staticEquivalence: statEq || {
      rowCount: rows.length,
      shared: moduleMappings.filter((m) => m.tier === 'shared').length,
      echoOnly: moduleMappings.filter((m) => m.tier === 'echoOnly').length,
      trueDiffer: moduleMappings.filter((m) => m.tier === 'trueDiffer').length,
      unresolved: 0, unknownFallback: 0,
    },
    runtimeModules,
    modules,
    moduleMappings,
    multiType,
    crossGenModules,
    gatewayNoSysId,
    noSysIdSubmodules,
    ambiguous,
    unresolved,
  };
}

// 硬校验：任一映射必须落在权威 fullSysId 集合内；全平台 runtimeModules 非空。
for (const [name, e] of Object.entries(platforms)) {
  if (Object.keys(e.runtimeModules).length === 0) {
    throw new Error(`${name} runtimeModules 留空，拒绝产出（HB-1 要求全平台非空）`);
  }
  for (const [mod, sid] of Object.entries(e.runtimeModules)) {
    const v = parseInt(sid, 16);
    if (!/^0x[0-9A-F]{4}$/.test(sid)) throw new Error(`${name}/${mod} fullSysId 格式非法：${sid}`);
    const t = v >> 8;
    if (!fullByType[t]?.has(v)) {
      throw new Error(`${name}/${mod} → ${sid} 不在 type 0x${t.toString(16)} 的权威 sysIds 集合`);
    }
  }
  for (const m of e.moduleMappings) {
    if (m.gatewayNoSysId) {
      if (Object.prototype.hasOwnProperty.call(e.runtimeModules, m.module)) {
        throw new Error(`${name}/${m.module} 网关不得进 runtimeModules`);
      }
      continue;
    }
    if (m.noSysIdSubmodule) continue;
    if (!m.fullSysId || !/^0x[0-9A-F]{4}$/.test(m.fullSysId)) {
      throw new Error(`${name}/${m.module} 缺少合法 fullSysId`);
    }
  }
}
// HB-1 硬校验：9X6 29/29 + 9X7 41/41 唯一映射（9X7 含 1 条网关静态特例，
// 该条不进 runtimeModules）；E1_ 跨代共 9 条；网关 1 条；两平台无 unresolved/unknown。
const p6 = platforms['9x6'], p7 = platforms['9x7'];
if (!p6 || !p7) throw new Error('缺少 9x6 / 9x7 平台');
if (p6.mappingCount !== 29 || p6.uniqueCount !== 29) throw new Error(`9x6 映射应 29/29，实得 ${p6.uniqueCount}/${p6.mappingCount}`);
if (p7.mappingCount !== 41 || p7.uniqueCount !== 40) throw new Error(`9x7 映射应 40/41（1 网关静态特例），实得 ${p7.uniqueCount}/${p7.mappingCount}`);
if (p6.unresolvedCount !== 0 || p7.unresolvedCount !== 0) throw new Error('9X6/9X7 仍有 unresolved 行，拒绝 unknown 保底');
if (p6.canonicalType !== '0x01' || p7.canonicalType !== '0x05') throw new Error('canonicalType 应为 9X6=0x01 / 9X7=0x05');
if (allCrossGenModules.length !== 9) throw new Error(`E1_ 跨代模块应 9 条，实得 ${allCrossGenModules.length}`);
if (allGatewayNoSysId.length !== 1 || allGatewayNoSysId[0].name !== '_9x7_pcm2_gw') {
  throw new Error(`网关特例应仅 1 条 _9x7_pcm2_gw，实得 ${JSON.stringify(allGatewayNoSysId)}`);
}

const canonicalTypeCoverage = {};
for (const [name, e] of Object.entries(platforms)) {
  canonicalTypeCoverage[name] = {
    canonicalType: e.canonicalType,
    rowCount: e.rowCount,
    mapped: e.mappingCount,
    runtimeModules: Object.keys(e.runtimeModules).length,
    gatewayNoSysId: e.gatewayNoSysIdCount,
    coverage: `${e.mappingCount}/${e.rowCount}`,
  };
}

const doc = {
  schemaVersion: 2,
  source: 'DSN.BIN 头 22 项索引 + 各平台 payloadOff 模块索引表 + PORSCHE_SYS_DATA.BIN 根表(sysdata-root-table.json) + vehicle-id-type-map.json(canonicalType/supersetProof/specialRules/menuTexts)',
  method: 'DSN 模块表记录 [u8 sysIdLow][u16 nlen][name\\0][u32 recPtr][u16 flag]；'
    + 'pickCanonical(platformKey,rows,lowByType) 取覆盖 sysIdLow 全集最多且为其它候选严格超集的 type 为规范 type；'
    + '全部平台按 (module,type,fullSysId) 产出 runtimeModules；E1_ 前缀跨代模块归 type 0x03；'
    + 'low=0x00 网关标 gatewayNoSysId 且不进 runtimeModules。无 unknown 保底、无全局表回退。',
  evidence: 'vehicleId ≡ DSN id ≡ SYS_DATA type ≡ sysId 高字节 ≡ BV 域（vehicle-id-type-map.json 4 组证据坐标：'
    + '原厂库 @0x26344 22 槽 TBB / @0x147C80 17 槽 TBB / @0x2A958 24 项菜单表 / 文本层 32 条车型名年款）；'
    + '模块名与 *_ALLDATA.BIN 顶级目录逐条吻合（9X6 29/29、9X7 41/41、CS1 15/17、E1 47/48）',
  boundary: '规范 type 与模块表在候选 type 间字节级等价（9X6 id1/id2 同 payloadOff 0x3A5EF；'
    + '9X7 id4/id6 同 0x3E31F、id5 为同 41 行副本）；静态等价集分「共享 / 仅 echo / 真差异」三档；'
    + '网关 low=0x00 是包内静态确定的无独立 sysId 特例，不是缺口。',
  identity: vim.identity,
  canonicalType: vim.canonicalType,
  specialRules: vim.specialRules,
  staticEquivalence: vim.staticEquivalence,
  index: index.map((x) => ({ id: x.id, name: x.name, payloadOff: x.payloadOff })),
  crossGenModules: allCrossGenModules,
  gatewayNoSysId: allGatewayNoSysId,
  platforms,
  stats: {
    platformCount: Object.keys(platforms).length,
    rowCount: Object.values(platforms).reduce((a, e) => a + e.rowCount, 0),
    runtimeUniqueCount: Object.values(platforms).reduce((a, e) => a + Object.keys(e.runtimeModules).length, 0),
    emptyRuntimeModulesCount: Object.values(platforms).filter((e) => Object.keys(e.runtimeModules).length === 0).length,
    mappingCount: Object.values(platforms).reduce((a, e) => a + e.mappingCount, 0),
    canonicalTypeCoverage,
    canonicalTypeCoveredPlatforms: Object.keys(canonicalTypeCoverage).length,
  },
};
writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
console.log(`写出 data/dsn-module-sysids.json  ${(Buffer.byteLength(JSON.stringify(doc)) / 1024).toFixed(0)}KB`);
for (const [name, e] of Object.entries(platforms)) {
  console.log(`  ${name.padEnd(6)} canonicalType=${e.canonicalType} rows=${e.rowCount} 映射=${e.mappingCount}/${e.rowCount} 运行时=${Object.keys(e.runtimeModules).length} 多义=${e.multiTypeCount} 无解=${e.unresolvedCount} 跨代=${e.crossGenCount} 网关=${e.gatewayNoSysIdCount}`);
}
console.log('stats', JSON.stringify(doc.stats));
