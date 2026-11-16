#!/usr/bin/env node
/**
 * tools/verify-catalog-frame-bytes.mjs
 * 门禁：**CATALOG_FRAME_BYTE_EQUAL_431**
 *
 * 目的
 *   证明 `src/schema.js` 的 catalog/枚举构帧路径（`buildIoControlFrame` /
 *   `buildRoutineFrame` / `featureFramesFor`）产出的帧，与 `data/*.json` 里
 *   记录的原厂实测帧**逐字节相等**，而不是「长得像」。
 *
 * 背景（复核过的缺陷）
 *   · 旧 `featureFramesFor('actuator')` 对 `form:'2f'` 构 `2F<DID4><state>` = 7 字节，
 *     丢了 UDS 0x2F 的必需字节 controlOption，实测帧是 8 字节 `2F 01 01 03 FF 00 00 00`；
 *   · `form:'31'` 旧构 `3101<RID4>` = 4 字节，丢 sub 与 params；
 *   · data 层把 ALL_ACTINFO 命令块的**类别字节**当成 DID（`(blob[end]<<8)|blob[end+1]`），
 *     逐项地址其实在命令块 **+6 处 u16 小端**，于是 150 条 2F 全塌到 did=0x0101。
 *
 * 记录布局（2026-11-13 重建后的唯一口径，`data/actuator.json:source.rule` 同步）
 *   命令块：`[0]变体 [1]类别(2F→01/31→10/容器→FF) [2]controlOption|sub [3]SID
 *            [4:6]==00 00 [6:8]逐项地址 u16 **LE** [8:10]==00 00 [10]选择器`
 *   `entry.ctrlBytes` = 整条命令块（11 字节典型）→ 地址在 `ctrlBytes[6..7]`（LE）。
 *
 * 六段断言
 *   (a0) 出处/口径自洽：bin 是相对路径、binResolver 三档之内、没有 binAbs、
 *        source.paramsUnresolved 现算相符、布局冲突条目「cmdRaw +6 LE = 27B 候选」
 *        且「取值未被改动」—— 全部现算，不认数据自述。
 *   (a1) 0x2F 构帧在 `did` 键下逐字节相等 + 长度 === 4 + state 字节数
 *        ⚠️ **2F 不是固定 8 字节**：`data/gag-actuators.json` 的 71 个实测 DID 帧长是
 *        7×1（`0xC000`，state `0A 03 01`）/ 8×68 / 9×1（`0x0401`）/ 11×1（`0x0402`），
 *        70/71 越过 7 字节单帧上限。本目录里会出帧的 2F 条目现算是 8×308 / 9×4 / 11×3。
 *        所以断言只能是「4 + state 真长」，`=== 8` 只对默认态 `FF 00 00 00` 成立
 *        （默认态是 4 字节 state，8 = 4 + 4，这一条单独断言）。
 *        ⚠️ 诚实标签：这是**内部一致性**（期望值按 did join 到实测表），本身不证明
 *        「目录项 ↔ 记录」的逐项身份；(a2)(a3) 才管身份。
 *   (a2) 逐项身份**下界**：`distinctJoinTargets ≥ GAG 真实 2F DID 数（现读）`。
 *   (a3) 逐项地址分层（`didResolve` 是**结构标签**，不是功能域结论）：
 *        [a3-s] single-address  帧内 DID === entry.did === u16le(ctrlBytes+6) + 候选恰 1 个
 *        [a3-m] multi-address   同样三条硬等式 + `entry.did ∈ didCandidates` + 候选 ≥ 2
 *                               + `multiAddressBasis` 与候选高字节**现算**一致
 *                               （high-byte-differs 只是"两个候选高字节不同"这一数值事实，
 *                                不声称分属不同 ECU/模块）
 *        [a3-v] unverified      只做结构断言，不比地址
 *        另：（BIN 可达时）数据侧 didCandidates 必须与原始规范记录 +6 地址集合逐个相等。
 *        ⚠️ 禁驱动条目（`driveDisabled === true`）不出帧：不参与「帧内 DID」等式，
 *        改为断言 `featureFramesFor(...).length === 0` + 非空 `driveDisabledReason`
 *        （"给一个能发的帧"比"不给帧"危险，所以这条是硬断言，不是豁免）。
 *   (a4) 无塌缩：`distinct(did) === distinct(frames)` 且实测/默认来源覆盖全量。
 *   (a5-1/2/3) 状态出处：实测条数 = did 落在 GAG 集的条数；实测值必须是 GAG 观测过的；
 *        默认态必须逐字节 `FF 00 00 00`（默认值不许偷偷变成"实测"）。
 *   (a6) 端序：LE 命中 GAG 数 > BE 命中数（+ BIN 可达时逐条 LE 断言），并打印随机基线。
 *   (b1) 0x31 构帧 = `31<sub><RID u16 LE 来源><params>`（与数据记录自洽；诚实标签在标题）
 *   (b2) RID = `u16le(ctrlBytes+6)` =（BIN 可达时）原始记录 `+6` 的 u16 LE
 *   (c)  data/measure.json 读帧长度/形态（该文件没有记录帧字段，无法逐字节比对）
 *   (d)  反向自检三档：旧 7 字节 2F、旧 4 字节 31、**旧 did 口径（类别字）跑新数据**
 *        —— 任何一档「也通过」都说明门禁恒真 → 打印 SELF_CHECK_FAILED 并 exit 1
 *   (e)  data/routine-templates.json 139 条（kind='routine'）逐字节相等 + 参数不丢
 *   (f)  0x31 参数六桶（gag-routines + function-sequences）+ 长度交叉核对（集合相等，不比总数）
 *   (g)  地址判定：`unverified === 0`（判据换成"同 (block,chain,sid) 所有规范记录同 id"）、
 *        16 条改判条目用内联常量表逐条钉地址、7 条模块级歧义白名单双向断言 + 必须禁驱动、
 *        按 SID 的记账恒等式（single + multi = total，multi = separable + ambiguous + not-applicable）
 *   (h)  27 字节记录形态：只记录不取舍 —— 8 条冲突链写死名字、`cmdRaw` 从 BIN 与字节两侧
 *        独立复算 `+6` u16 **LE**、27B 读数**不得**进候选列表、多址精确计数 13 + 5 = 18、
 *        `multiAddressBasis` 只剩两个取值（`raw-layout-conflict` 零实例）、候选项上无 `inGagLib`
 *
 * 门禁有效性（防"同一事实重复计数"）
 *   每段打印 `distinctFrames` / `distinctExpected` / `joinKeyUsed` / `distinctJoinTargets`；
 *   `distinctJoinTargets < 条目数` 时打印 ⚠ WARNING（那是数据事实，不判失败）。
 *
 * 可复现性
 *   BIN 不可达时打印 `SKIP_ACTINFO`，跳过「原始记录复算」类断言（不假装验过）；
 *   所有阈值都从数据现读，不硬编码 150/130/144/71。
 *
 * 跑法：node tools/verify-catalog-frame-bytes.mjs
 * 退出码：全过 0 / 任一不符 1
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIoControlFrame,
  buildRoutineFrame,
  featureFramesFor,
  explainActuatorFrame,
  IO_CONTROL_DEFAULT_OPTION,
} from '../src/schema.js';

const ASSERTION = 'CATALOG_FRAME_BYTE_EQUAL_431';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTINFO_BIN = '/Users/se818/porsche-mapper/ref/decoded/ALL_ACTINFO.BIN';

let pass = 0;
let fail = 0;
const failures = [];

/**
 * 记录一条断言。
 * @param {string} name
 * @param {boolean} cond
 * @param {string} [extra]
 */
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${extra ? ' -- ' + extra : ''}`);
  }
  return !!cond;
}

/** 读仓库内 JSON。 */
function loadJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

/** 定宽大写 hex。 */
function padHex(value, width) {
  return Number(value).toString(16).toUpperCase().padStart(width, '0');
}

/**
 * 字节串规范化：`'FF 00 00 00'` / `'0300ff'` / `'0x0B'` → `'FF000000'` / `'0300FF'` / `'0B'`。
 * @param {*} v
 * @returns {string} 大写无分隔符 hex（长度偶数；非法输入返回 ''）
 */
function normBytes(v) {
  if (v == null) return '';
  const tokens = String(v).replace(/0x/gi, ' ').split(/[^0-9A-Fa-f]+/).filter(Boolean);
  let out = '';
  for (const t of tokens) {
    if (t.length > 2) {
      if (t.length % 2) return '';
      out += t.toUpperCase();
    } else {
      out += t.toUpperCase().padStart(2, '0');
    }
  }
  return out.length % 2 === 0 ? out : '';
}

/**
 * hex 串 → 字节数组；非法（非 hex / 奇数长度）返回空数组。
 * @param {string} hex
 * @returns {number[]}
 */
function bytesOf(hex) {
  const s = String(hex || '');
  if (!s || s.length % 2 || !/^[0-9A-F]+$/.test(s)) return [];
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(Number.parseInt(s.slice(i, i + 2), 16));
  return out;
}

/** 两个字节串是否逐字节相等（长度不同即否）。 */
function bytesEqual(a, b) {
  const x = bytesOf(a);
  const y = bytesOf(b);
  if (!x.length || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** 首个不等字节的位置（调试用）。 */
function firstDiff(a, b) {
  const x = bytesOf(a);
  const y = bytesOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      const hx = x[i] == null ? '--' : padHex(x[i], 2);
      const hy = y[i] == null ? '--' : padHex(y[i], 2);
      return `byte[${i}] built=${hx} expect=${hy}（len ${x.length} vs ${y.length}）`;
    }
  }
  return '无差异';
}

/** 一段的汇总行。 */
function sectionSummary(label, okCount, total) {
  console.log(`    ${label}: ${okCount}/${total}`);
  return okCount === total;
}

/**
 * 取「join 目标 → 命中条数」里最大的几组，用于把「同一事实被重复计数」摊开给人看。
 * @param {Map<string, number>} counts
 * @param {number} [n]
 * @returns {string}
 */
function topGroups(counts, n = 3) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ×${v}`)
    .join(' , ');
}

/** 计数自增。 */
function bump(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

// ───────────────────────────────────────────────────────────────────
// 数据装载
// ───────────────────────────────────────────────────────────────────
const actuatorDoc = loadJson('data/actuator.json');
const gagActuatorDoc = loadJson('data/gag-actuators.json');
const gagRoutineDoc = loadJson('data/gag-routines.json');
const measureDoc = loadJson('data/measure.json');
const routineTemplateDoc = loadJson('data/routine-templates.json');

const actuatorItems = Array.isArray(actuatorDoc.items) ? actuatorDoc.items : [];
const measureItems = Array.isArray(measureDoc.params) ? measureDoc.params : [];
const routineTemplateItems = Array.isArray(routineTemplateDoc.items) ? routineTemplateDoc.items : [];
const gagByDid = new Map((gagActuatorDoc.items || []).map((g) => [Number(g.did), g]));
const gagRoutines = gagRoutineDoc.routines || {};
const gagDids = new Set(gagByDid.keys());
const gagRids = new Set(Object.keys(gagRoutines)
  .map((k) => Number.parseInt(String(k).replace(/^0x/i, ''), 16))
  .filter((v) => Number.isInteger(v)));
const srcStats = (actuatorDoc.source && actuatorDoc.source.stats) || {};

const items2f = actuatorItems.filter((x) => String(x.form || '').toLowerCase() === '2f');
const items31 = actuatorItems.filter((x) => String(x.form || '').toLowerCase() === '31');
const itemsContainer = actuatorItems.filter((x) => String(x.form || '').toLowerCase() === 'container');
const itemsRecord30 = actuatorItems.filter((x) => String(x.form || '').toLowerCase() === '30');
const itemsOther = actuatorItems.filter((x) => String(x.form || '').toLowerCase() === 'other');

/** 命令块字段读取（offsets 见文件头；不带 data 侧任何换算）。 */
const cmdAddrLE = (cb) => (cb.length >= 8 ? (cb[6] | (cb[7] << 8)) : NaN);
const cmdAddrBE = (cb) => (cb.length >= 8 ? ((cb[6] << 8) | cb[7]) : NaN);
const ctrlBytesOf = (it) => bytesOf(normBytes(it.ctrlBytes));

console.log(`\n=== ${ASSERTION} ===`);
console.log(`数据：actuator.json ${actuatorItems.length} 条（2f=${items2f.length} / 31=${items31.length}`
  + ` / container=${itemsContainer.length} / 30=${itemsRecord30.length} / other=${itemsOther.length}）`
  + ` · measure.json ${measureItems.length} 条`
  + ` · routine-templates.json ${routineTemplateItems.length} 条`
  + ` · gag-actuators ${gagDids.size} DID · gag-routines ${gagRids.size} RID`);
if (actuatorDoc.source) {
  console.log(`数据出处：${actuatorDoc.source.bin} · ${actuatorDoc.source.size} B`
    + ` · sha256=${String(actuatorDoc.source.sha256).slice(0, 16)}…`
    + ` · binResolver=${actuatorDoc.source.binResolver}`
    + ` · 记录 ${srcStats.recordsScanned} 条 · 未验证地址 ${srcStats.addrUnverified} 条`
    + ` · 多址条目 2f ${srcStats.multiAddressEntries2f} / 31 ${srcStats.multiAddressEntries31}`
    + ` · didResolve ${JSON.stringify(srcStats.didResolve || {})}`
    + ` · paramsUnresolved ${actuatorDoc.source.paramsUnresolved}`);
}

// ───────────────────────────────────────────────────────────────────
// 独立复算 ALL_ACTINFO（不引用 build 脚本的任何中间结果）
//   · 只为「原始记录 +6 处 u16 LE」这一条判据服务，可用性由 SKIP_ACTINFO 兜底
// ───────────────────────────────────────────────────────────────────
/**
 * 解析 ALL_ACTINFO：索引表（平台块边界）+ 全部名称记录的命令块。
 * 与 tools/build-actuators.py 是**两份独立实现**，互相校验而不是互相信任。
 * @param {Buffer} buf
 * @returns {{records: Map<string, {off:number, cmd:Buffer}[]>, blocks: {ptr:number,name:string}[], count:number}}
 */
function parseActinfo(buf) {
  const text = buf.toString('latin1');
  // 1) 头部索引表：[u8 id][u16 名长][名\0][u32 指针]，从偏移 1 起
  const blocks = [];
  let p = 1;
  while (p + 7 <= buf.length) {
    const nameLen = buf.readUInt16LE(p + 1);
    if (!(nameLen > 0 && nameLen <= 60) || p + 3 + nameLen + 4 > buf.length) break;
    const raw = buf.subarray(p + 3, p + 3 + nameLen);
    if (raw[raw.length - 1] !== 0) break;
    const name = raw.subarray(0, raw.length - 1).toString('latin1');
    if (!name || !/^[\x20-\x7e]+$/.test(name)) break;
    const ptr = buf.readUInt32LE(p + 3 + nameLen);
    if (ptr > 0 && name !== '0') blocks.push({ ptr, name });
    p += 1 + 2 + nameLen + 4;
  }
  blocks.sort((a, b) => a.ptr - b.ptr);

  // 2) 名称记录：`[u16 名长][chain\0][命令块…]`
  const re = /([\x02-\x60])\x00(0x[0-9A-Fa-f]{6,8}(?:\$0x[0-9A-Fa-f]{6,8})*)\x00/g;
  const hits = [];
  let m = re.exec(text);
  while (m !== null) {
    const nameLen = buf.readUInt16LE(m.index);
    const chain = m[2];
    if (nameLen === chain.length + 1) {
      hits.push({ chain, off: m.index, cmdOff: m.index + m[0].length });
    }
    m = re.exec(text);
  }
  const records = new Map();
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k];
    const end = k + 1 < hits.length ? hits[k + 1].off : buf.length;
    const list = records.get(h.chain) || [];
    list.push({ off: h.off, cmd: buf.subarray(h.cmdOff, Math.min(end, h.cmdOff + 256)) });
    records.set(h.chain, list);
  }
  return { records, blocks, count: hits.length };
}

let actinfo = null;
try {
  actinfo = parseActinfo(readFileSync(ACTINFO_BIN));
  console.log(`BIN 复算：${ACTINFO_BIN} → 记录 ${actinfo.count} 条 · 平台块 ${actinfo.blocks.length} 个`
    + `（${actinfo.blocks.map((b) => b.name).join('/')}）`);
  if (srcStats.recordsScanned != null && srcStats.recordsScanned !== actinfo.count) {
    console.log(`  ⚠ 记录数与 data/actuator.json:source.stats.recordsScanned 不一致：`
      + `${srcStats.recordsScanned} vs ${actinfo.count}（数据可能不是这份 BIN 生成）`);
  }
} catch (err) {
  actinfo = null;
  console.log(`SKIP_ACTINFO: 解码副本不可达（${ACTINFO_BIN}）：${err.code || err.message}`);
  console.log('SKIP_ACTINFO: 「原始记录 +6 复算」类断言本次跳过（不假装验过），其余断言照跑。');
}

/**
 * 取某 chain 的规范命令块（11 字节 + 两个 u16 恒 0），可限定 SID。
 * @param {string} chain
 * @param {number} [sid]
 * @returns {Buffer[]}
 */
function rawCanonical(chain, sid) {
  if (!actinfo) return [];
  const list = actinfo.records.get(chain) || [];
  return list
    .map((r) => r.cmd)
    .filter((c) => c.length === 11 && c[4] === 0 && c[5] === 0 && c[8] === 0 && c[9] === 0
      && (sid == null || c[3] === sid));
}

/**
 * 禁驱动条目的统一判据：**不许出帧** + 必须写明理由。
 * 这是 `src/schema.js` 里「`driveDisabled === true` ⇒ `featureFramesFor` 返回 []」的反面断言：
 * 哪天有人让禁驱动条目重新出帧（或忘了写理由），这里立刻红。
 * 返回 `{ frames, ok }`：`frames` 是实际帧数（应为 0），`ok` 是判据是否成立。
 * @param {object} it
 * @returns {{frames:number, ok:boolean}}
 */
function driveDisabledState(it) {
  const frames = featureFramesFor('actuator', it) || [];
  return { frames: frames.length, ok: frames.length === 0 && String(it.driveDisabledReason || '').trim().length > 0 };
}

// ───────────────────────────────────────────────────────────────────
// (a0) 出处与口径自洽（可复现性 + 「解析歧义只报告不取舍」）
//
//   这一段的每一条都**现算**，不读数据的自述结论：
//   ① source.bin 必须是相对路径，source 段不许出现绝对路径（换机器要能复现）；
//   ② binResolver 只允许 cli / repo-ref / mapper 三档，且旧字段 binAbs 必须消失；
//   ③ source.paramsUnresolved 必须等于「form:'31' 且 paramsSrc='absent'」的现算条数；
//   ④ 布局冲突条目的 cmdRaw 必须是 27 字节块，且它的 +6 u16 **LE** 现算值 = 27B 候选值；
//   ⑤ 冲突条目「只报告不取舍」：选定地址必须仍是 11 字节规范块给的那个值。
// ───────────────────────────────────────────────────────────────────
console.log('\n(a0) 出处与口径自洽：相对路径 / binResolver / 布局冲突 / 参数未解决');
{
  const src = actuatorDoc.source || {};
  const binIsRel = typeof src.bin === 'string' && src.bin.length > 0 && !src.bin.startsWith('/');
  const absLeak = Object.entries(src)
    .filter(([k, v]) => k !== 'reproduce' && typeof v === 'string'
      && /(^|\s)\/[A-Za-z]/.test(v) && v.length < 400)
    .map(([k]) => k);
  check('[a0-1] source.bin 是相对路径，且 source 段没有绝对路径字段（换机器可复现）',
    binIsRel && absLeak.length === 0,
    `bin=${src.bin} · 绝对路径字段 ${absLeak.join(' / ') || '无'}`);

  const RESOLVERS = ['cli', 'repo-ref', 'mapper'];
  check('[a0-2] source.binResolver ∈ {cli, repo-ref, mapper}，且旧字段 binAbs 已删除',
    RESOLVERS.includes(src.binResolver) && !('binAbs' in src),
    `binResolver=${src.binResolver} · binAbs 存在=${'binAbs' in src}`
    + ` · sha256=${String(src.sha256).slice(0, 16)}…`);

  const liveUnresolved = items31.filter(
    (x) => x.paramsResolved === 'multi' || x.paramsSrc === 'no-template').length;
  const liveResolved = items31.filter((x) => x.paramsResolved === 'unique').length;
  check('[a0-3] source.paramsUnresolved = 现算(multi + no-template)（不是抄来的常数）',
    src.paramsUnresolved === liveUnresolved && liveUnresolved > 0
      && liveUnresolved + liveResolved === items31.length,
    `数据 ${src.paramsUnresolved} vs 现算 ${liveUnresolved}（unique ${liveResolved} + 未解决 ${liveUnresolved}`
    + ` = ${liveResolved + liveUnresolved} / 31 共 ${items31.length}）`);

  const layoutItems = actuatorItems.filter((x) => x.rawLayoutConflict === true);
  const badLayout = layoutItems.filter((it) => {
    const raw = bytesOf(normBytes(it.cmdRaw));
    const alt = (it.rawLayoutCandidates || []).find((c) => c.layout === 'cmd-block-27B');
    if (raw.length !== 27 || !alt) return true;
    return cmdAddrLE(raw) !== Number(alt.value);
  });
  check('[a0-4] 布局冲突条目：cmdRaw 是 27 字节块，且 +6 LE 现算 = rawLayoutCandidates 的 27B 值',
    layoutItems.length > 0 && badLayout.length === 0,
    `${layoutItems.length} 条冲突，不符 ${badLayout.length} 条`
    + (badLayout.length ? `（${badLayout.map((x) => x.name).join('；')}）` : ''));

  const badKeep = layoutItems.filter((it) => {
    const canon = (it.rawLayoutCandidates || []).find((c) => c.layout === 'cmd-block-11B');
    const used = Number(it.did != null ? it.did : it.rid);
    return !canon || Number(canon.value) !== used;
  });
  check('[a0-5] 布局冲突条目「只报告不取舍」：选定地址仍是 11 字节规范块给的值（未被改动）',
    badKeep.length === 0 && layoutItems.length > 0,
    `不符 ${badKeep.length}/${layoutItems.length}`
    + (badKeep.length ? `：${badKeep.map((x) => x.name).join('；')}` : ''));
}

// ───────────────────────────────────────────────────────────────────
// (a) 0x2F
// ───────────────────────────────────────────────────────────────────
/**
 * 0x2F 的**期望帧**（不经过 buildIoControlFrame，独立拼装）。
 *   `2F <DID 2B> <controlOption 1B> <controlState …>`
 * controlOption：GAG 实测（按 did）优先；无实测取记录命令块 +2（新布局）。
 * @param {object} it
 * @returns {{hex:string, source:string, controlOption:number, state:string, measured:object|null}}
 */
function expect2f(it) {
  const did = Number(it.did);
  const measured = gagByDid.get(did) || null;
  const cb = ctrlBytesOf(it);
  let controlOption;
  let source;
  if (measured) {
    controlOption = Number(measured.drive.controlOption);
    source = 'gag-actuators.json（实测）';
  } else {
    controlOption = cb.length > 2 ? cb[2] : IO_CONTROL_DEFAULT_OPTION;
    source = 'actuator.json:ctrlBytes[2]（记录命令块 +2）';
  }
  const state = normBytes(measured ? measured.drive.state : it.drive && it.drive.state);
  return {
    hex: `2F${padHex(did, 4)}${padHex(controlOption, 2)}${state}`,
    source,
    controlOption,
    state,
    measured,
  };
}

console.log('\n(a1) 0x2F 构帧与实测/记录在 did 键下逐字节相等（内部一致性，不含逐项身份）'
  + '\n(a2) 逐项身份下界（distinctJoinTargets ≥ 431 真实 2F DID 数，现读）');
{
  let pass2f = 0;
  const bad = [];
  // 禁驱动条目（地址在模块内歧义）**不出帧**，所以它们不参与「逐字节相等」的总体，
  // 单独按「0 帧 + 有理由」判 —— 混进分母只会把"没比对"伪装成"比对通过"。
  const items2fCmp = items2f.filter((x) => x.driveDisabled !== true);
  const items2fBlocked = items2f.filter((x) => x.driveDisabled === true);
  const fallbackUsed = [];
  const frames2f = new Set();
  const expected2f = new Set();
  const joinTargets2f = new Map();
  for (const it of items2fCmp) {
    const missing = [];
    if (!Number.isInteger(Number(it.did))) missing.push('did');
    if (!it.drive || it.drive.controlOption == null) missing.push('drive.controlOption');
    if (!it.drive || it.drive.state == null) missing.push('drive.state');
    if (!it.ctrlBytes && !gagByDid.get(Number(it.did))) missing.push('ctrlBytes/实测');
    if (missing.length) {
      bad.push(`${it.name || '(无名)'}：条目字段不全（缺 ${missing.join('/')}）`);
      continue;
    }
    const exp = expect2f(it);
    const trace = explainActuatorFrame(it);
    const built = trace.frame;
    const frames = featureFramesFor('actuator', it);
    if (trace.controlOptionSource.startsWith('default-')) fallbackUsed.push(`${it.name}：${trace.controlOptionSource}`);

    const b = bytesOf(built);
    // 长度判据：`2F` + DID(2) + CO(1) + state(n) → 4 + state 字节数；
    // 缺陷形态（7 字节 = 少了 CO）在 (d) 档整档复现，这里逐条钉死"长度 = 4 + state"。
    const okLen = b.length === 4 + exp.state.length / 2 && b.length >= 5;
    const okBytes = bytesEqual(built, exp.hex);
    const okSid = b[0] === 0x2f;
    const okDid = b.length >= 3 && ((b[1] << 8) | b[2]) === Number(it.did);
    const okCo = b.length >= 4 && b[3] === exp.controlOption;
    const okState = b.length >= 4
      && b.slice(4).map((x) => padHex(x, 2)).join('') === exp.state;
    const okWrap = frames.length === 1 && frames[0] === built;
    const okDriveVsMeasured = !exp.measured || (
      Number(exp.measured.drive.controlOption) === Number(it.drive.controlOption)
      && normBytes(exp.measured.drive.state) === normBytes(it.drive.state)
      && (exp.measured.observedStates || []).map(normBytes).includes(normBytes(it.drive.state))
    );
    if (okLen && okBytes && okSid && okDid && okCo && okState && okWrap && okDriveVsMeasured) {
      pass2f += 1;
    } else {
      bad.push(`${it.name || '(无名)'} did=${it.didHex || it.did}`
        + ` built=${built || '(空)'} expect=${exp.hex}`
        + ` len8=${okLen} 逐字节=${okBytes} sid=${okSid} did=${okDid} co=${okCo} state=${okState}`
        + ` wrap=${okWrap} drive=实测=${okDriveVsMeasured}`
        + ` | ${firstDiff(built, exp.hex)}`);
    }
    frames2f.add(built);
    expected2f.add(exp.hex);
    bump(joinTargets2f, exp.measured
      ? `gag-actuators#did=0x${padHex(Number(it.did), 4)}`
      : `ctrlBytes#chain=${it.chain}`);
  }
  const maxGroup2f = Math.max(0, ...joinTargets2f.values());
  console.log(`    指标：distinctFrames=${frames2f.size} distinctExpected=${expected2f.size}`
    + ` joinKeyUsed=did→data/gag-actuators.json（无实测则 entry.ctrlBytes 记录）`
    + ` distinctJoinTargets=${joinTargets2f.size}/${items2fCmp.length}`
    + `（另有禁驱动 ${items2fBlocked.length} 条不参与比对）`);
  console.log(`    join 目标（按命中条数）：${topGroups(joinTargets2f, 5)}`);
  if (joinTargets2f.size < items2fCmp.length) {
    console.log(`    ⚠ WARNING：distinctJoinTargets(${joinTargets2f.size}) < 条目数(${items2fCmp.length})`
      + ` —— 最大一组 "${topGroups(joinTargets2f, 1)}" 意味着 ${maxGroup2f} 条 form:'2f'`
      + ` 匹配同一条证据记录，因此这一部分 pass 数**不是独立确认**（数据事实，不判失败）。`);
  }
  const lenDist2f = new Map();
  for (const it of items2fCmp) {
    bump(lenDist2f, bytesOf((featureFramesFor('actuator', it) || [])[0] || '').length);
  }
  // 「全部 2F 条目」的帧长分布：按 `4 + state 字节数` 从记录现算（禁驱动条目也有 state，
  // 只是不发帧）。两个分母都要打印 —— 少了谁，后人都会拿另一个数字来对账然后互相怀疑。
  const lenDistAll2f = new Map();
  let noState2f = 0;
  for (const it of items2f) {
    const st = normBytes(it.drive && it.drive.state);
    if (!st.length) { noState2f += 1; continue; }
    bump(lenDistAll2f, 4 + st.length / 2);
  }
  const fmtLen = (m) => [...m.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}B×${v}`).join(' / ');
  console.log(`    帧长分布：出帧 ${items2fCmp.length}/${items2f.length} 条 → ${fmtLen(lenDist2f)}`
    + ` · 全部 ${items2f.length} 条（按 4+state 现算）→ ${fmtLen(lenDistAll2f)}`
    + (noState2f ? `（其中 ${noState2f} 条无 state，未计入）` : '')
    + ` · 另有禁驱动 ${items2fBlocked.length} 条出 0 帧`);
  check('[a1] 2F 帧长 = 4 + state 字节数，且默认态（FF 00 00 00）必须正好 8 字节',
    items2fCmp.every((it) => {
      const f = bytesOf((featureFramesFor('actuator', it) || [])[0] || '');
      const st = normBytes(it.drive && it.drive.state);
      const need = 4 + st.length / 2;
      return f.length === need && (st !== 'FF000000' || f.length === 8);
    }),
    `出帧条目 ${items2fCmp.length}/${items2f.length} 条（谓词 \`driveDisabled !== true\`，机读可复算；`
    + `被排除的 ${items2fBlocked.length} 条全为 ambiguous-in-module，理由字段写着「模块级无法消歧」；`
    + `2F 的 rawLayoutConflict 只有 1 条且是 multi-resolved-by-module，仍在其中）`
    + ` → ${fmtLen(lenDist2f)}`
    + `；按全部 ${items2f.length} 条算（禁驱动条目取记录态 state）→ ${fmtLen(lenDistAll2f)}。`
    + `2F 不是固定 8 字节：8 只是默认态 FF 00 00 00 的基线，实测态 9/11 字节都存在`);
  check('[a1] 0x2F 构帧逐字节相等（pass/total，禁驱动条目另行判定）',
    pass2f === items2fCmp.length && items2fCmp.length > 0,
    `${pass2f}/${items2fCmp.length}`
    + (bad.length ? `；不符 ${bad.length} 条（前 5）：\n        - ${bad.slice(0, 5).join('\n        - ')}` : ''));
  check('[a1] 0x2F 比对条数 = 数据条目数（无静默跳过）',
    pass2f + bad.length === items2fCmp.length
      && pass2f + bad.length + items2fBlocked.length === items2f.length,
    `pass ${pass2f} + 不符 ${bad.length} = ${pass2f + bad.length} / 参与比对 ${items2fCmp.length}`
    + `；+ 禁驱动 ${items2fBlocked.length} = ${pass2f + bad.length + items2fBlocked.length} / 数据 ${items2f.length}`);
  const blockedBad2f = items2fBlocked.filter((it) => !driveDisabledState(it).ok);
  check('[a1] 禁驱动条目必须 0 帧且写明理由（不许"给一个能发的帧"）',
    blockedBad2f.length === 0,
    `禁驱动 ${items2fBlocked.length} 条，不符 ${blockedBad2f.length} 条`
    + (blockedBad2f.length
      ? `：${blockedBad2f.slice(0, 3).map((x) => `${x.name}(帧 ${driveDisabledState(x).frames}/理由 ${x.driveDisabledReason ? '有' : '无'})`).join('；')}`
      : `（${items2fBlocked.map((x) => x.name).slice(0, 3).join(' / ')}…）`));
  check('[a1] 0x2F 每条都真的从 entry.drive.controlOption 取 controlOption（无回落）',
    fallbackUsed.length === 0,
    fallbackUsed.length ? `${fallbackUsed.length} 条回落：${fallbackUsed.slice(0, 3).join('；')}`
      : `默认值 ${padHex(IO_CONTROL_DEFAULT_OPTION, 2)} 仅作函数签名缺省，未被数据触发`);
  console.log(`    实测来源分布：gag-actuators ${items2f.filter((x) => gagByDid.get(Number(x.did))).length} 条`
    + ` · 记录默认 ${items2f.filter((x) => !gagByDid.get(Number(x.did))).length} 条`);
  sectionSummary('(a1) 0x2F 内部一致性', pass2f, items2fCmp.length);

  // ── (a2) 逐项身份**下界** ──────────────────────────────────────
  //   GAG 实测的 2F DID 全集 = 身份空间的真实基数（现读 data/gag-actuators.json）。
  //   我们的 distinct 帧内 DID 必须至少覆盖这么多不同身份 —— 这是**下界**判据，
  //   真正的逐条证明在 (a3)。⛔ 不许为让它绿而把 DID 随便分配给目录项（造假）。
  const identityNeed = gagDids.size;
  const identityProven = joinTargets2f.size >= identityNeed;
  console.log(`    (a2) 逐项身份下界：distinctJoinTargets=${joinTargets2f.size}`
    + ` vs 431 真实 2F DID 数=${identityNeed}（需 ≥）`);
  check('[a2] 逐项身份下界成立（distinctJoinTargets ≥ 431 真实 2F DID 数）', identityProven,
    `distinctJoinTargets=${joinTargets2f.size}（需 ≥ ${identityNeed}，GAG 真实 2F DID 全集）`);
  if (!identityProven) {
    console.log(`    NOT_PROVEN: 逐项寻址未解 —— distinctJoinTargets=${joinTargets2f.size}`
      + ` < ${identityNeed}（431 真实 2F DID 数）`);
  }
  sectionSummary('(a2) 逐项身份下界', identityProven ? 1 : 0, 1);

  // ── (a3) 逐项地址：按 didResolve 分层，四类分别计数 ────────────
  //   ① 帧内 DID（构帧输出，BE on wire）
  //   ② entry.did（数据字段）
  //   ③ u16le(entry.ctrlBytes + 6)（记录命令块原始字节）
  //   ④ BIN 可达时：该 chain 全部规范 0x2F 记录的 +6 u16 LE **集合**（门禁自己重解析）
  //
  //   词表（team-lead 裁定：**结构标签** + 模块判决，不带功能域结论）：
  //     [a3-s] single-address            帧内 DID === entry.did === ctrlBytes+6，候选恰 1 个
  //     [a3-mr] multi-resolved-by-module 三条硬等式 + 候选 ≥2 + moduleResolution=separable
  //            + **门禁独立重算**两候选的模块集不相交（不信数据自报）
  //     [a3-ma] ambiguous-in-module      同上但模块集相交 ⇒ 必须 driveDisabled
  //     [a3-mm] multi-address            多址但判不了（某候选无模块记录 / 27 字节布局）⇒ not-applicable
  //   ⚠️ 四类**分别计数打印**，不许合并成一个 pass/total —— 合并会掩盖少数类的判定质量。
  const CLASSES = ['single-address', 'multi-resolved-by-module', 'ambiguous-in-module', 'multi-address'];
  // ⚠️ 只有两个取值：`raw-layout-conflict` 已随「27 字节形态不进入候选列表」一并删除
  //    （它曾只为那 8 条布局冲突条目而存在；留着零实例的枚举值只会腐烂）。
  const BASIS_ALLOWED = ['high-byte-differs', 'high-byte-same'];
  // 模块目录独立重建：`(sid|addr|chain)` → 命名模块集合（占位名 `E1/#12` 不计入）。
  const modIdx = new Map();
  const modTable = loadJson('data/actinfo-modules.json');
  for (const mod of modTable.modules || []) {
    const blk = mod.block || '';
    const nm = String(mod.moduleName || '').trim();
    const tag = nm ? `${blk}/${nm}` : `${blk}/#${mod.idx}`;
    const placeholder = !nm || /^[^/]+\/#\d+$/.test(tag);
    for (const g of mod.groups || []) {
      for (const r of g.records || []) {
        const addr = typeof r.addr === 'string'
          ? (r.addr.toLowerCase().startsWith('0x') ? Number.parseInt(r.addr.slice(2), 16) : Number(r.addr))
          : Number(r.addr || 0);
        const key = `${String(r.sid).toUpperCase()}|${addr}|${r.chain}`;
        if (!modIdx.has(key)) modIdx.set(key, new Set());
        if (!placeholder) modIdx.get(key).add(tag);
      }
    }
  }
  const moduleSet = (sidTag, addr, chain) => modIdx.get(`${sidTag}|${addr}|${chain}`) || new Set();
  const byResolve = { '(缺字段)': [] };
  for (const k of CLASSES) byResolve[k] = [];
  for (const it of items2f) {
    const k = byResolve[it.didResolve] ? it.didResolve : '(缺字段)';
    byResolve[k].push(it);
  }
  const frameDids2f = new Set();
  const dataAddrs2f = new Set();
  const enabledDid2f = new Set();     // 会出帧的条目的选定地址（(a4) 无塌缩只在这一集上比）
  const blockedDid2f = new Set();     // 禁驱动条目的选定地址（不出帧，单列记账）
  const rawAddrs2f = new Set();
  const candUnion2f = new Set();
  let rawChecked = 0;
  let candMatchBad = 0;
  const badA3 = { '(缺字段)': [] };
  const passA3 = { '(缺字段)': 0 };
  for (const k of CLASSES) { badA3[k] = []; passA3[k] = 0; }
  const structuralOk = (it, cb, b) => b.length >= 4 && b[0] === 0x2f
    && b.length === 4 + normBytes(it.drive && it.drive.state).length / 2 && cb.length === 11;
  const fitHex = (v) => `0x${padHex(v, 4)}`;

  for (const it of items2f) {
    const cls = byResolve[it.didResolve] ? it.didResolve : '(缺字段)';
    const cb = ctrlBytesOf(it);
    const blocked = it.driveDisabled === true;
    const b = bytesOf((featureFramesFor('actuator', it) || [])[0] || '');
    const frameDid = b.length >= 3 ? ((b[1] << 8) | b[2]) : NaN;
    const dataAddr = cmdAddrLE(cb);
    if (Number.isFinite(frameDid)) frameDids2f.add(frameDid);
    if (Number.isFinite(dataAddr)) dataAddrs2f.add(dataAddr);
    (blocked ? blockedDid2f : enabledDid2f).add(Number(it.did));
    const candObjs = Array.isArray(it.didCandidates) ? it.didCandidates : [];
    const cands = candObjs.map((c) => Number(c.did));
    for (const c of cands) candUnion2f.add(c);
    // "真实候选"：排除 27 字节布局给出的那个（那不是另一个 ECU 的地址）
    const realCands = cands.filter((_, i) => !candObjs[i].layout);

    const reasons = [];
    if (!cands.includes(Number(it.did))) reasons.push('entry.did 不在自己的 didCandidates 里');
    if (blocked) {
      // 禁驱动 ⇒ 必须 0 帧 + 写理由；「帧内 DID」这条等式对它不适用（没有帧），
      // 但 entry.did 仍必须等于记录 +6 —— 地址字段本身依旧要自洽。
      const st = driveDisabledState(it);
      if (!st.ok) reasons.push(`禁驱动条目却出了 ${st.frames} 帧或没写理由`);
      if (!(Number(it.did) === dataAddr)) reasons.push(`entry.did=${fitHex(Number(it.did))} ≠ ctrlBytes+6(LE)=${fitHex(dataAddr)}`);
    } else {
      if (!structuralOk(it, cb, b)) reasons.push('结构断言失败（SID/长度/保留位/命令块长度）');
      // 三条硬等式对**所有**会出帧的类都成立：选定值本身必须自洽（多址不豁免）
      if (!(frameDid === Number(it.did))) reasons.push(`帧内 DID=${fitHex(frameDid)} ≠ entry.did=${fitHex(Number(it.did))}`);
      if (!(Number(it.did) === dataAddr)) reasons.push(`entry.did=${fitHex(Number(it.did))} ≠ ctrlBytes+6(LE)=${fitHex(dataAddr)}`);
    }

    // ④ BIN 原始记录集合
    let rawSet = null;
    if (actinfo) {
      const raws = rawCanonical(it.chain, 0x2f);
      if (raws.length) {
        rawChecked += 1;
        rawSet = new Set(raws.map((c) => c[6] | (c[7] << 8)));
        for (const a of rawSet) rawAddrs2f.add(a);
        const same = rawSet.size === cands.length && cands.every((a) => rawSet.has(a));
        if (!same) candMatchBad += 1;
        const match = raws.some((c) => c.toString('hex').toUpperCase() === normBytes(it.ctrlBytes));
        if (!match) reasons.push('entry.ctrlBytes 与 BIN 里任一规范记录命令块不逐字节相同');
      }
    }

    if (cls === 'single-address') {
      if (cands.length !== 1) reasons.push(`single-address 却给了 ${cands.length} 个候选`);
      if (it.multiAddressBasis != null) reasons.push('单址条目不该带 multiAddressBasis');
      if (it.moduleResolution != null) reasons.push('单址条目不该带 moduleResolution');
    } else {
      // 多址四件事：候选数、basis 现算、模块现算、禁驱动
      // ⚠️ 27 字节布局的值**不在** didCandidates 里（语义红线：那不是另一个 ECU 的拷贝），
      //    所以这里的"真实候选"就应当是全部候选，且规模必然 ≥ 2；只剩 1 个却是多址 ⇒ 红。
      const basis = String(it.multiAddressBasis || '');
      if (!BASIS_ALLOWED.includes(basis)) {
        reasons.push(`multiAddressBasis 取值越界：${basis || '(缺)'}`);
      }
      if (realCands.length < 2) {
        reasons.push(`${cls} 却只有 ${realCands.length} 个真实候选`);
      } else {
        const highs = new Set(realCands.map((a) => a >> 8));
        const basisWant = highs.size > 1 ? 'high-byte-differs' : 'high-byte-same';
        if (basis !== basisWant) reasons.push(`multiAddressBasis=${basis} 与真实候选高字节现算 ${basisWant} 不符`);
      }
      if (cls === 'multi-address') {
        if (it.moduleResolution !== 'not-applicable') reasons.push(`multi-address 的 moduleResolution 应为 not-applicable，现为 ${it.moduleResolution}`);
      } else {
        // 门禁**独立重算**模块集：数据自报 seperable/ambiguous 必须与现算一致
        const sets = realCands.map((a) => moduleSet('2F', a, it.chain));
        if (sets.some((x) => x.size === 0)) {
          reasons.push('某候选在该 chain 下无命名模块记录 —— 不可能判成可拆/歧义');
        } else {
          const inter = new Set([...sets[0]].filter((x) => sets.every((y) => y.has(x))));
          const want = inter.size === 0 ? 'separable' : 'ambiguous';
          if (it.moduleResolution !== want) reasons.push(`moduleResolution=${it.moduleResolution} 与门禁现算 ${want} 不符（交集 ${inter.size}）`);
          if (cls === 'multi-resolved-by-module' && want !== 'separable') reasons.push('可拆判决与模块交集矛盾');
          if (cls === 'ambiguous-in-module' && want !== 'ambiguous') reasons.push('歧义判决与模块交集矛盾');
        }
      }
      const shouldBlock = cls === 'ambiguous-in-module';
      if (shouldBlock && it.driveDisabled !== true) reasons.push('模块级歧义却没禁驱动');
      if (shouldBlock && !String(it.driveDisabledReason || '').trim()) reasons.push('禁驱动但没写理由');
    }
    void rawSet;
    if (reasons.length === 0) passA3[cls] += 1;
    else badA3[cls].push(`${it.name || '(无名)'} did=${it.didHex || it.did}：${reasons.join('；')}`);
  }

  const fmtCls = (k) => `${k}=${passA3[k]}/${byResolve[k].length}`;
  console.log(`    didResolve 分层：${CLASSES.filter((k) => byResolve[k].length).map(fmtCls).join(' · ')}`
    + ` · 缺字段 ${byResolve['(缺字段)'].length}`);
  console.log(`    口径对比：帧内 DID ${frameDids2f.size} 个 · entry.did ${new Set(items2f.map((x) => Number(x.did))).size} 个`
    + ` · ctrlBytes+6(LE) ${dataAddrs2f.size} 个 · didCandidates 并集 ${candUnion2f.size} 个`
    + (actinfo ? ` · BIN 原始记录复算 ${rawChecked} 条（候选集合不符 ${candMatchBad} 条）` : ' · BIN 不可达'));
  const a3Totals = CLASSES.reduce((acc, k) => acc + passA3[k], 0);
  const a3Bads = CLASSES.reduce((acc, k) => acc + badA3[k].length, 0);
  check('[a3-s] single-address：三条硬等式 + 候选恰 1 + 不带多址字段',
    passA3['single-address'] === byResolve['single-address'].length
      && byResolve['single-address'].length > 0,
    `single-address ${passA3['single-address']}/${byResolve['single-address'].length}`
    + (badA3['single-address'].length ? `；不符：${badA3['single-address'].slice(0, 3).join('；')}` : ''));
  check('[a3-mr] multi-resolved-by-module：三条硬等式 + 候选 ≥2 + 门禁独立重算模块集不相交',
    passA3['multi-resolved-by-module'] === byResolve['multi-resolved-by-module'].length
      && byResolve['multi-resolved-by-module'].length > 0
      && byResolve['multi-resolved-by-module'].every((it) => Array.isArray(it.resolvedModuleNames)
        && it.resolvedModuleNames.length >= 2
        && it.resolvedModuleNames.every((r) => Array.isArray(r.modules) && r.modules.length > 0
          && r.modules.every((m) => typeof m === 'string' && m.trim() && !/^[^/]+\/#\d+$/.test(m)))),
    `multi-resolved ${passA3['multi-resolved-by-module']}/${byResolve['multi-resolved-by-module'].length}`
    + `（${byResolve['multi-resolved-by-module'].map((it) => (it.didCandidates || []).map((c) => c.didHex).join('/')).join(' , ')}）`
    + (badA3['multi-resolved-by-module'].length ? `；不符：${badA3['multi-resolved-by-module'].join('；')}` : ''));
  check('[a3-ma] ambiguous-in-module：模块集现算相交 + 必须禁驱动且写理由',
    passA3['ambiguous-in-module'] === byResolve['ambiguous-in-module'].length
      && byResolve['ambiguous-in-module'].length > 0,
    `ambiguous ${passA3['ambiguous-in-module']}/${byResolve['ambiguous-in-module'].length}`
    + `（${byResolve['ambiguous-in-module'].map((it) => it.name).join(' / ')}）`
    + (badA3['ambiguous-in-module'].length ? `；不符：${badA3['ambiguous-in-module'].join('；')}` : ''));
  check('[a3-mm] multi-address：判不了就标 not-applicable（不许拿"空模块集 ⇒ 不相交"当可拆）',
    passA3['multi-address'] === byResolve['multi-address'].length,
    `multi-address ${passA3['multi-address']}/${byResolve['multi-address'].length}`
    + (badA3['multi-address'].length ? `；不符：${badA3['multi-address'].join('；')}` : ''));
  check('[a3] 每条 form:\'2f\' 都带 didCandidates/didResolve，且四类之和 = 条目数',
    byResolve['(缺字段)'].length === 0 && a3Totals + a3Bads === items2f.length,
    `缺字段 ${byResolve['(缺字段)'].length} 条 · 分层覆盖 ${a3Totals + a3Bads}/${items2f.length}`);
  if (actinfo) {
    check('[a3] 数据侧 didCandidates 与 BIN 原始 0x2F 记录地址集合逐个相等（不漏不多）',
      candMatchBad === 0, `不符 ${candMatchBad}/${rawChecked} 条`);
  } else {
    console.log('SKIP_ACTINFO: [a3] 的「BIN 原始记录 / 候选集合」子断言跳过');
  }
  sectionSummary('(a3) 逐项地址', a3Totals, items2f.length);

  // ── (a4) 无塌缩 ────────────────────────────────────────────────
  //  ① 帧内地址不塌缩：distinct(帧内 DID) === distinct(entry.did)
  //  ② 记录侧不丢：候选并集抹掉"未选中候选"后必须正好等于选定集合（记账恒等式）
  //  ③ BIN 可达时：候选并集 === BIN 里这些 chain 的全部规范 0x2F 地址（296 = 296，独立复算）
  //  ④ 密度：distinct(entry.did) ≥ 条目数的 50%
  //  旧版（150 条全塌到 did=0x0101）会同时违反 ① 和 ④。
  const unselected = new Set([...candUnion2f].filter((a) => !dataAddrs2f.has(a)));
  const collapse = frameDids2f.size === enabledDid2f.size && enabledDid2f.size > 1;
  check('[a4] 无 did 塌缩：distinct 帧内 DID === distinct 会出帧条目的 entry.did（两边都现算）',
    collapse, `帧内 ${frameDids2f.size} vs 数据 ${enabledDid2f.size}`
    + `（会出帧 ${enabledDid2f.size} + 禁驱动 ${blockedDid2f.size} = ${enabledDid2f.size + blockedDid2f.size} 个不同 DID`
    + ` · 条目 ${items2f.length}）`);
  check('[a4] 记账恒等式：候选并集 = 选定地址 ∪ 未选中候选（不丢不多）',
    candUnion2f.size === dataAddrs2f.size + unselected.size && unselected.size >= 0,
    `并集 ${candUnion2f.size} = 选定 ${dataAddrs2f.size} + 未选中 ${unselected.size}`
    + `（未选中：${[...unselected].map((v) => '0x' + padHex(v, 4)).join('/') || '无'}）`);
  if (actinfo) {
    check('[a4] 候选并集 === BIN 里这些 chain 的全部规范 0x2F 地址（独立复算，不认数据自述）',
      rawAddrs2f.size === candUnion2f.size && [...rawAddrs2f].every((a) => candUnion2f.has(a)),
      `BIN ${rawAddrs2f.size} vs 数据 ${candUnion2f.size}`);
  } else {
    console.log('SKIP_ACTINFO: [a4] 的「候选并集 === BIN 地址全集」子断言跳过');
  }
  check('[a4] 逐项身份密度：distinct entry.did ≥ 条目数的 50%（塌缩时会远低于此）',
    dataAddrs2f.size / Math.max(1, items2f.length) >= 0.5,
    `${dataAddrs2f.size}/${items2f.length} = ${(dataAddrs2f.size / Math.max(1, items2f.length) * 100).toFixed(1)}%`);
  sectionSummary('(a4) 无塌缩', collapse ? 1 : 0, 1);

  // ── (a5) 状态出处（stateSrc 只有 measured / default 两个取值）────────
  const measuredItems = items2f.filter((x) => x.stateSrc === 'measured');
  const defaultItems = items2f.filter((x) => x.stateSrc === 'default');
  const noSrc = items2f.filter((x) => x.stateSrc !== 'measured' && x.stateSrc !== 'default');
  const shouldBeMeasured = items2f.filter((x) => gagDids.has(Number(x.did))).length;
  check('[a5-0] stateSrc 只有 measured / default 两个取值（第三条一律算失败）',
    noSrc.length === 0,
    noSrc.length ? `${noSrc.length} 条越界：${noSrc.slice(0, 3).map((x) => `${x.name}=${x.stateSrc}`).join('；')}`
      : `measured ${measuredItems.length} · default ${defaultItems.length} · 合计 ${items2f.length}`);
  check('[a5-1] measured 条数 = did 落在 GAG 实测集的条数（现算，无口径漂移）',
    measuredItems.length === shouldBeMeasured && measuredItems.length > 0,
    `stateSrc=measured ${measuredItems.length} 条 vs did∈GAG ${shouldBeMeasured} 条`
    + `（另：default ${defaultItems.length} 条 · 无出处 ${noSrc.length} 条）`);
  const badState = measuredItems.filter((it) => {
    const g = gagByDid.get(Number(it.did));
    if (!g) return true;
    const observed = (g.observedStates || []).map(normBytes);
    return !observed.includes(normBytes(it.drive && it.drive.state));
  });
  check('[a5-2] 每个 measured 态都逐字节等于 GAG 观测过的状态之一（不许编状态）',
    badState.length === 0,
    badState.length ? `${badState.length} 条不在 observedStates 里：`
      + badState.slice(0, 3).map((x) => `${x.name}(${normBytes(x.drive && x.drive.state)})`).join('；')
      : `measured ${measuredItems.length} 条全覆盖`);
  const badDefault = defaultItems.filter((it) => normBytes(it.drive && it.drive.state) !== 'FF000000');
  check('[a5-3] default 条目的 drive 态必须正好是 FF 00 00 00（默认值不许冒充实测）',
    badDefault.length === 0 && noSrc.length === 0,
    `${badDefault.length} 条不是 FF000000`
    + (badDefault.length ? `：${badDefault.slice(0, 3).map((x) => `${x.name}(${normBytes(x.drive && x.drive.state)})`).join('；')}` : '')
    + ` · 无出处 ${noSrc.length} 条`);
  sectionSummary('(a5) 状态出处', badState.length === 0 && badDefault.length === 0 && noSrc.length === 0 ? 1 : 0, 1);

  // ── (a6) 端序 ──────────────────────────────────────────────────
  //  判据（门禁自算，不引用别人的数字）：
  //   · LE 命中 GAG DID 集 的条数必须 **>** BE 命中条数；
  //   · BIN 可达时逐条断言：原始记录 +6 的 u16 **LE** 才是 entry.did（(a3) 已含）；
  //   · 打印随机基线 N×|GAG|/65536，避免"命中两三条就宣称端序成立"。
  const leHit2f = items2f.filter((it) => gagDids.has(cmdAddrLE(ctrlBytesOf(it)))).length;
  const beHit2f = items2f.filter((it) => gagDids.has(cmdAddrBE(ctrlBytesOf(it)))).length;
  const leAddrHits2f = [...dataAddrs2f].filter((v) => gagDids.has(v)).length;
  const nullBase2f = (dataAddrs2f.size * gagDids.size / 65536).toFixed(2);
  console.log(`    端序证据（2F）：LE 命中 GAG ${gagDids.size} DID 集 ${leHit2f}/${items2f.length} 条`
    + `（${leAddrHits2f}/${dataAddrs2f.size} 个地址）· BE ${beHit2f}/${items2f.length}`
    + ` · 随机基线 ≈ ${nullBase2f} 个地址`);
  check('[a6] 端序：2F 的 LE 命中数 > BE 命中数（且 LE 地址更分散）',
    leHit2f > beHit2f && leAddrHits2f > 0,
    `LE ${leHit2f} vs BE ${beHit2f}（distinct 地址 ${dataAddrs2f.size}，基线 ${nullBase2f}）`);
  sectionSummary('(a6) 端序', leHit2f > beHit2f ? 1 : 0, 1);
}

// ───────────────────────────────────────────────────────────────────
// (b) 0x31
// ───────────────────────────────────────────────────────────────────
/**
 * 0x31 的**期望帧**（不经过 buildRoutineFrame，独立拼装）。
 *   命令块：`[var][cat=0x10][sub @2][SID=0x31 @3][00 00][RID u16 LE @6][00 00][选择器 @10]`
 * → 帧 = `31 <sub> <RID 2B> <params…>`；params 只认 GAG 实测例程库里 (RID, sub) 命中项，
 *   没有实测就空（与 build-actuators.py 同规则 —— 这条是"自洽"，不是独立证据）。
 * @param {object} it
 * @returns {{hex:string, source:string, sub:number, rid:number, params:string, lib:object|null}}
 */
/** 包内第二张 31 模板表：`(sub, rid)` → 非空载荷集合（门禁自己从原始帧解析）。 */
const seqTemplates = (() => {
  const tab = new Map();
  const doc = loadJson('data/function-sequences.json');
  for (const fn of doc.functions || []) {
    for (const cmd of fn.cmds || []) {
      const tok = String(cmd).split(' ');
      if (tok.length < 4 || tok[0].toUpperCase() !== '31') continue;
      const sub = Number.parseInt(tok[1], 16);
      const rid = Number.parseInt(tok[2] + tok[3], 16);
      const payload = tok.slice(4).join('').toUpperCase();
      const key = `${sub}|${rid}`;
      if (!tab.has(key)) tab.set(key, new Set());
      if (payload) tab.get(key).add(payload);
    }
  }
  return tab;
})();

function expect31(it) {
  const cb = ctrlBytesOf(it);
  const recSub = cb.length > 2 ? cb[2] : 1;
  const recRid = cmdAddrLE(cb);
  const variants = gagRoutines[`0x${padHex(recRid, 4)}`] || [];
  const lib = variants.find((e) => Number.parseInt(String(e.sub).replace(/^0x/i, ''), 16) === recSub) || null;
  const sub = recSub;
  // 两个源独立重算（不读 it.params —— 那会退化成"自己跟自己比"）
  const seq = seqTemplates.get(`${recSub}|${recRid}`) || null;
  const seqNonEmpty = seq ? [...seq] : [];
  let params;
  let source;
  if (lib && normBytes(lib.params)) {
    params = normBytes(lib.params);
    source = `gag-routines.json[0x${padHex(recRid, 4)}].sub=0x${padHex(recSub, 2)}`;
  } else if (lib) {
    params = '';
    source = `gag-routines.json 明确 4 字节（${it.name}）`;
  } else if (!seq) {
    params = '';
    source = '两表都没有模板 → 期望 4 字节壳（但数据应标 no-template 并禁驱动）';
  } else if (seqNonEmpty.length === 1) {
    params = seqNonEmpty[0];
    source = `function-sequences.json (${padHex(recSub, 2)}|${padHex(recRid, 4)}) 唯一非空载荷`;
  } else if (seqNonEmpty.length === 0) {
    params = '';
    source = 'function-sequences.json 载荷集只有空串';
  } else {
    params = null;      // 多候选：不许挑，也就不许构帧
    source = `function-sequences.json 多候选（${seqNonEmpty.length} 个）`;
  }
  const multi = params === null;
  return {
    hex: multi ? '' : `31${padHex(sub, 2)}${padHex(recRid, 4)}${params}`,
    source,
    sub,
    rid: recRid,
    params,
    multi,
    lib,
  };
}

console.log('\n(b1) 0x31 构帧 = 31<sub><RID><params>（与数据记录自洽；同源规则，不构成独立证据）'
  + '\n(b2) RID 端序 = 记录命令块 +6 的 u16 LE');
{
  let pass31 = 0;
  const bad = [];
  const frames31 = new Set();
  const expected31 = new Set();
  const joinTargets31 = new Map();
  let multiNoFrame = 0;
  // 禁驱动条目（参数多候选 / 两表无模板 / 地址在模块内歧义）**不出帧**，因此不参与
  // 「逐字节相等」的总体，单列按「0 帧 + 有理由」判 —— 混进分母会把"没比对"伪装成"通过"。
  const items31Cmp = items31.filter((x) => x.driveDisabled !== true);
  const items31Blocked = items31.filter((x) => x.driveDisabled === true);
  for (const it of items31Cmp) {
    const cb = ctrlBytesOf(it);
    if (cb.length !== 11) {
      bad.push(`${it.name || '(无名)'}：命令块非 11 字节（实得 ${cb.length}）`);
      continue;
    }
    const exp = expect31(it);
    if (exp.multi) {
      // multi ⇒ 数据必须禁驱动，所以它只可能出现在禁驱动集里；走到这里说明两处口径打架
      bad.push(`${it.name || '(无名)'} rid=0x${padHex(it.rid, 4)}：参数多候选却没禁驱动`);
      continue;
    }
    const trace = explainActuatorFrame(it);
    const built = trace.frame;
    const frames = featureFramesFor('actuator', it);

    const b = bytesOf(built);
    const okLen = b.length === 4 + exp.params.length / 2;
    const okBytes = bytesEqual(built, exp.hex);
    const okSid = b[0] === 0x31;
    const okSub = b.length >= 2 && b[1] === exp.sub;
    const okRid = b.length >= 4 && ((b[2] << 8) | b[3]) === exp.rid;
    const okParams = b.length >= 4
      && b.slice(4).map((x) => padHex(x, 2)).join('') === exp.params;
    const okFieldRid = Number(it.rid) === exp.rid;
    const okFieldSub = Number(it.sub) === exp.sub;
    const okWrap = frames.length === 1 && frames[0] === built;
    // params 必须与门禁独立重算的两个源一致（不再只对 gag-lib 生效）
    const okParamsSrc = normBytes(it.params) === exp.params;
    if (okLen && okBytes && okSid && okSub && okRid && okParams && okFieldRid && okFieldSub && okWrap && okParamsSrc) {
      pass31 += 1;
    } else {
      bad.push(`${it.name || '(无名)'} rid=0x${padHex(it.rid, 4)}`
        + ` built=${built || '(空)'} expect=${exp.hex}（${exp.source}）`
        + ` len=${okLen} 逐字节=${okBytes} sid=${okSid} sub=${okSub} rid=${okRid}`
        + ` params=${okParams} 字段rid=${okFieldRid} 字段sub=${okFieldSub} wrap=${okWrap}`
        + ` paramsSrc=${okParamsSrc} | ${firstDiff(built, exp.hex)}`);
    }
    frames31.add(built);
    expected31.add(exp.hex);
    bump(joinTargets31, `ctrlBytes#${normBytes(it.ctrlBytes)}`);
  }
  // 禁驱动集：0 帧 + 非空理由；多候选额外要求 paramsResolved='multi' 且 params 留空（不挑）
  const badBlocked31 = [];
  for (const it of items31Blocked) {
    const st = driveDisabledState(it);
    const exp = expect31(it);
    const why = [];
    if (!st.ok) why.push(`帧 ${st.frames} 条 / 理由 ${it.driveDisabledReason ? '有' : '无'}`);
    if (exp.multi) {
      multiNoFrame += 1;
      if (it.paramsResolved !== 'multi') why.push(`paramsResolved=${it.paramsResolved}（应为 multi）`);
      if (normBytes(it.params) !== '') why.push('params 应留空（多候选不许挑）');
    }
    if (why.length) {
      badBlocked31.push(`${it.name || '(无名)'} rid=0x${padHex(it.rid, 4)}：${why.join('；')}`);
    }
  }
  const withParams = items31Cmp.filter((x) => normBytes(x.params).length > 0).length;
  const libMatched = items31.filter((x) => x.paramsSrc === 'gag-lib').length;
  console.log(`    指标：distinctFrames=${frames31.size} distinctExpected=${expected31.size}`
    + ` joinKeyUsed=entry.ctrlBytes 命令块（per-entry）+ gag-routines 按 (RID,sub) 命中`
    + ` distinctJoinTargets=${joinTargets31.size}/${items31Cmp.length}`
    + `（另有禁驱动 ${items31Blocked.length} 条不参与比对）`);
  console.log(`    参数出处：gag-lib 命中 ${libMatched} 条（会出帧且非空 ${withParams}）`
    + ` · specf-seq ${items31.filter((x) => x.paramsSrc === 'specf-seq').length} 条`
    + ` · 禁驱动不出帧 ${items31Blocked.length} 条（其中参数多候选 ${multiNoFrame} 条）`);
  if (joinTargets31.size < items31Cmp.length) {
    console.log(`    ⚠ WARNING：distinctJoinTargets(${joinTargets31.size}) < 条目数(${items31Cmp.length})`
      + ` —— 最大一组 "${topGroups(joinTargets31, 1)}"；即多条目录项共享逐字节相同的命令块`
      + `（数据事实，不判失败）。`);
  }
  check('[b1] 期望值不超过证据数（distinctExpected ≤ distinctJoinTargets）',
    expected31.size <= joinTargets31.size,
    `distinctExpected=${expected31.size} ≤ distinctJoinTargets=${joinTargets31.size}`
    + `（差额 ${joinTargets31.size - expected31.size} = 同 RID 的多种记录变体收敛成库里同一条命令）`);
  check('[b1] 0x31 构帧逐字节相等（pass/total，禁驱动条目另行判定）',
    pass31 === items31Cmp.length && items31Cmp.length > 0,
    `${pass31}/${items31Cmp.length}`
    + (bad.length ? `；不符 ${bad.length} 条（前 5）：\n        - ${bad.slice(0, 5).join('\n        - ')}` : ''));
  check('[b1] 0x31 比对条数 = 数据条目数（无静默跳过）',
    pass31 + bad.length === items31Cmp.length
      && pass31 + bad.length + items31Blocked.length === items31.length,
    `pass ${pass31} + 不符 ${bad.length} = ${pass31 + bad.length} / 参与比对 ${items31Cmp.length}`
    + `；+ 禁驱动 ${items31Blocked.length} = ${pass31 + bad.length + items31Blocked.length} / 数据 ${items31.length}`);
  check('[b1] 禁驱动条目必须 0 帧且写明理由（多候选还要 params 留空、paramsResolved=multi）',
    badBlocked31.length === 0,
    `禁驱动 ${items31Blocked.length} 条，不符 ${badBlocked31.length} 条`
    + (badBlocked31.length ? `：${badBlocked31.slice(0, 3).join('；')}` : ''));
  check('[b1] 带参数条目的参数未被丢弃（帧长 = 4 + params 字节）',
    items31Cmp.every((x) => {
      const f = bytesOf(featureFramesFor('actuator', x)[0] || '');
      const need = normBytes(x.params);
      return !need.length || f.length === 4 + need.length / 2;
    }),
    `带参数 ${withParams}/${items31Cmp.length} 条（禁驱动 ${items31Blocked.length} 条不参与）`);
  sectionSummary('(b1) 0x31 与记录自洽', pass31, items31Cmp.length);

  // ── (b2) RID 端序 ──────────────────────────────────────────────
  let passB2 = 0;
  const badB2 = [];
  const leRids31 = new Set();
  const beRids31 = new Set();
  let raw31Checked = 0;
  for (const it of items31) {
    const cb = ctrlBytesOf(it);
    if (cb.length !== 11) { badB2.push(`${it.name || '(无名)'}：命令块非 11 字节`); continue; }
    const le = cmdAddrLE(cb);
    const be = cmdAddrBE(cb);
    leRids31.add(le);
    beRids31.add(be);
    let ok = Number(it.rid) === le;
    const why = [`entry.rid=0x${padHex(it.rid, 4)} vs 记录+6(LE)=0x${padHex(le, 4)}（BE 口径=0x${padHex(be, 4)}）`];
    if (actinfo) {
      const raws = rawCanonical(it.chain, 0x31);
      if (raws.length) {
        raw31Checked += 1;
        const addrs = new Set(raws.map((c) => c[6] | (c[7] << 8)));
        if (!addrs.has(Number(it.rid))) {
          ok = false;
          why.push(`BIN 原始记录 +6(LE) ${[...addrs].map((v) => '0x' + padHex(v, 4)).join('/')} 不含 entry.rid`);
        }
      }
    }
    if (ok) passB2 += 1;
    else badB2.push(`${it.name || '(无名)'} ${why.join('；')}`);
  }
  const leHit31 = items31.filter((it) => gagRids.has(cmdAddrLE(ctrlBytesOf(it)))).length;
  const beHit31 = items31.filter((it) => gagRids.has(cmdAddrBE(ctrlBytesOf(it)))).length;
  console.log(`    端序证据（31）：LE RID 命中 gag-routines ${gagRids.size} 个 RID 的 ${leHit31}/${items31.length} 条`
    + `（${[...leRids31].filter((v) => gagRids.has(v)).length}/${leRids31.size} 个 RID）`
    + ` · BE ${beHit31}/${items31.length}`
    + ` · 随机基线 ≈ ${(leRids31.size * gagRids.size / 65536).toFixed(2)} 个 RID`
    + (actinfo ? ` · BIN 原始记录复算 ${raw31Checked} 条` : ' · BIN 不可达'));
  check('[b2] 0x31 的 RID = 记录命令块 +6 的 u16 LE（与 2F DID 同槽位同端序）'
    + (actinfo ? ' = BIN 原始记录 +6' : ''),
  passB2 === items31.length && items31.length > 0,
  `${passB2}/${items31.length}`
    + (badB2.length ? `；不符 ${badB2.length} 条（前 3）：\n        - ${badB2.slice(0, 3).join('\n        - ')}` : ''));
  check('[b2] 端序：31 的 LE 命中数 > BE 命中数', leHit31 > beHit31 && leHit31 > 0,
    `LE ${leHit31} vs BE ${beHit31}`);
  sectionSummary('(b2) RID 端序=+6(LE)', passB2, items31.length);
}

// ───────────────────────────────────────────────────────────────────
// (c) 读帧（measure）—— 只断言形态/长度
//
//   为什么不能逐字节比对：data/measure.json 的条目字段只有 readSid/pid/位域定义
//   （byte/bit/bitsize/express/…），**没有任何记录帧字段**（连 ctrlBytes 都没有）。
//   读帧本身就是 `22 <DID2B>` / `21 <LID1B>` 的纯构造，没有独立实测证据可比，
//   因此这里断言「形态 + 长度 + 字段回读」。
// ───────────────────────────────────────────────────────────────────
console.log('\n(c) 读帧：形态/长度断言（measure.json 无记录帧字段，无法逐字节比对）');
{
  let passM = 0;
  const bad = [];
  let sid22 = 0;
  let sid21 = 0;
  for (const it of measureItems) {
    const frame = (featureFramesFor('measure', it) || [])[0] || '';
    const b = bytesOf(frame);
    const sid = Number(it.readSid);
    const pid = Number(it.pid);
    const expLen = sid === 0x22 ? 3 : 2;
    const okLen = b.length === expLen;
    const okSid = b[0] === sid && [0x21, 0x22, 0x1a].includes(sid);
    const okPayload = sid === 0x22
      ? b.length === 3 && ((b[1] << 8) | b[2]) === pid
      : b.length === 2 && b[1] === pid;
    if (okLen && okSid && okPayload) {
      passM += 1;
      if (sid === 0x22) sid22 += 1; else sid21 += 1;
    } else {
      bad.push(`${it.id || '(无 id)'} sid=0x${padHex(sid, 2)} pid=0x${padHex(pid, 4)}`
        + ` frame=${frame || '(空)'} 期望长度=${expLen} 实得=${b.length}`);
    }
  }
  check('[c] 读帧形态/长度全量成立（22→3 字节 / 21|1A→2 字节）',
    passM === measureItems.length && measureItems.length > 0,
    `${passM}/${measureItems.length}（22 族 ${sid22} · 21 族 ${sid21}）`
    + (bad.length ? `；不符 ${bad.length} 条（前 5）：\n        - ${bad.slice(0, 5).join('\n        - ')}` : ''));
  sectionSummary('(c) 读帧', passM, measureItems.length);
}

// ───────────────────────────────────────────────────────────────────
// (d) 反向自检三档：旧逻辑必须**比对失败**
//
//   如果拿旧实现去跑上面同一套比对也能「通过」，说明门禁的比对是恒真的。
//   ① 旧 2F 构帧（7 字节 `2F<DID><state>`，丢 controlOption）
//   ② 旧 31 构帧（4 字节 `3101<RID>`，丢 sub/params）
//   ③ ★ 旧数据口径：把命令块 [0..1]（变体+类别字）当 DID —— 在新数据上必须大面积失败
// ───────────────────────────────────────────────────────────────────
console.log('\n(d) 反向自检：旧构帧/旧取址逻辑必须比对失败');
let selfCheckOk = true;
{
  const legacy2f = (it) => `2F${padHex(Number(it.did), 4)}${normBytes(it.drive && it.drive.state)}`;
  const legacy31 = (it) => `3101${padHex(Number(it.rid), 4)}`;

  let legacy2fPass = 0;
  let legacy2fLen7 = 0;
  for (const it of items2f) {
    const built = legacy2f(it);
    const exp = expect2f(it);
    if (bytesOf(built).length === 7) legacy2fLen7 += 1;
    if (bytesEqual(built, exp.hex) && bytesOf(built).length === 8) legacy2fPass += 1;
  }
  let legacy31Pass = 0;
  for (const it of items31) {
    const built = legacy31(it);
    const exp = expect31(it);
    if (bytesEqual(built, exp.hex)) legacy31Pass += 1;
  }
  // ③ 旧取址：did = (cmd[0] << 8) | cmd[1]
  const legacyDid = (it) => {
    const cb = ctrlBytesOf(it);
    return cb.length >= 2 ? ((cb[0] << 8) | cb[1]) : NaN;
  };
  const legacyDids = new Set(items2f.map(legacyDid));
  let legacyDidPass = 0;
  for (const it of items2f) {
    const d = legacyDid(it);
    if (Number.isFinite(d) && d === Number(it.did)) legacyDidPass += 1;
  }
  const legacyExample = items2f.length ? legacy2f(items2f[0]) : '';
  const legacyExpect = items2f.length ? expect2f(items2f[0]).hex : '';

  console.log(`    ① 旧 2F 构帧样例：${legacyExample}（${bytesOf(legacyExample).length} 字节）`
    + ` vs 期望 ${legacyExpect}（${bytesOf(legacyExpect).length} 字节）`);
  console.log(`       旧 2F 比对通过 ${legacy2fPass}/${items2f.length}（其中 7 字节 ${legacy2fLen7} 条）`);
  console.log(`    ② 旧 31 构帧通过 ${legacy31Pass}/${items31.length}`
    + `（无参数且 sub=01 的条目与旧帧同形，属预期）`);
  console.log(`    ③ 旧取址口径（cmd[0..1] 类别字当 DID）在新数据上：distinct DID=${legacyDids.size}`
    + `（${[...legacyDids].map((v) => '0x' + padHex(v, 4)).join(',')}）`
    + ` · 与 entry.did 一致 ${legacyDidPass}/${items2f.length} 条`);

  const self2f = check('[d] 旧 2F 构帧（7 字节）比对必须 0 条通过', legacy2fPass === 0,
    `通过 ${legacy2fPass}/${items2f.length}；7 字节 ${legacy2fLen7} 条`);
  const self31 = check('[d] 旧 31 构帧（4 字节、丢参数）必须至少 1 条失败',
    legacy31Pass < items31.length,
    `旧 31 通过 ${legacy31Pass}/${items31.length}（失败 ${items31.length - legacy31Pass} 条）`);
  const selfDid = check('[d] 旧取址口径（类别字当 DID）在新数据上必须大面积失败',
    legacyDids.size < 10 && legacyDidPass <= items2f.length * 0.05,
    `旧口径 distinct DID=${legacyDids.size}（现数据 ${new Set(items2f.map((x) => Number(x.did))).size} 个）`
    + ` · 通过 ${legacyDidPass}/${items2f.length}`);
  selfCheckOk = self2f && self31 && selfDid;

  if (!selfCheckOk) {
    console.log('\nSELF_CHECK_FAILED：用旧逻辑跑同一套比对竟然通过 —— 门禁恒真，比对无效。');
  }
}

// ───────────────────────────────────────────────────────────────────
// (e) 例程模板（kind='routine'）—— data/routine-templates.json 139 条
//
//   旧 `featureFramesFor('routine')` 构 `31<sub><RID>` = 4 字节，**丢掉 params**；
//   模板 note 明写「含子功能与参数」，coder.js:1725 生产路径也是
//   `31${sf}${rid}${params}` —— 丢参数属同类缺陷。
// ───────────────────────────────────────────────────────────────────
console.log("\n(e) 例程模板 kind='routine'：构帧逐字节相等 + 参数不丢");
{
  const EXPECTED_EMPTY_PARAMS = [
    'rid=0x0404 sub=0x03',
    'rid=0x0111 sub=0x50',
    'rid=0x0000 sub=0x01',
    'rid=0x0000 sub=0x18',
    'rid=0x0622 sub=0x73',
    'rid=0x0000 sub=0x08',
  ].sort();

  let passRt = 0;
  let withParams = 0;
  let lostParams = 0;
  const bad = [];
  const emptyParams = [];
  const framesRt = new Set();
  const expectedRt = new Set();
  const joinTargetsRt = new Map();

  for (const it of routineTemplateItems) {
    const sub = Number.parseInt(String(it.sub).replace(/^0x/i, ''), 16);
    const rid = Number.parseInt(String(it.routineId).replace(/^0x/i, ''), 16);
    const paramsRaw = String(it.params ?? '').replace(/\s/g, '');
    const params = normBytes(it.params);
    const missing = [];
    if (!Number.isInteger(sub)) missing.push('sub');
    if (!Number.isInteger(rid)) missing.push('routineId');
    if (!params && paramsRaw !== '') missing.push('params（非法 hex）');
    if (missing.length) {
      bad.push(`${it.routineId || '(无 id)'}：条目字段不全（缺 ${missing.join('/')}）`);
      continue;
    }
    const exp = `31${padHex(sub, 2)}${padHex(rid, 4)}${params}`;
    const built = (featureFramesFor('routine', it) || [])[0] || '';
    const b = bytesOf(built);
    const okBytes = bytesEqual(built, exp);
    const okLen = built.length === 8 + params.length;
    const okBuilder = built === buildRoutineFrame(sub, rid, params);
    const okStruct = b[0] === 0x31 && b.length >= 4 && b[1] === sub
      && ((b[2] << 8) | b[3]) === rid
      && b.slice(4).map((x) => padHex(x, 2)).join('') === params;

    if (params.length) withParams += 1;
    else emptyParams.push({ label: `rid=${it.routineId} sub=${it.sub}`, frame: built });
    if (params.length && b.length === 4) lostParams += 1;

    framesRt.add(built);
    expectedRt.add(exp);
    bump(joinTargetsRt, `template#${it.routineId}|${it.sub}|${params}`);

    if (okBytes && okLen && okBuilder && okStruct) {
      passRt += 1;
    } else {
      bad.push(`${it.routineId} sub=${it.sub} built=${built || '(空)'} expect=${exp}`
        + ` 逐字节=${okBytes} 长度=${okLen} builder一致=${okBuilder} 结构=${okStruct}`
        + ` | ${firstDiff(built, exp)}`);
    }
  }

  const emptySorted = emptyParams.slice().sort((x, y) => (x.label < y.label ? -1 : 1));
  console.log(`    指标：distinctFrames=${framesRt.size} distinctExpected=${expectedRt.size}`
    + ` joinKeyUsed=routine-templates.json 条目字段（per-entry）`
    + ` distinctJoinTargets=${joinTargetsRt.size}/${routineTemplateItems.length}`);
  console.log(`    空 params 条目 ${emptySorted.length} 条（结构上应为 4 字节帧）：`);
  for (const e of emptySorted) {
    console.log(`      - ${e.label} → 帧 ${e.frame || '(空)'}（${(e.frame || '').length / 2} 字节）`);
  }
  if (joinTargetsRt.size < routineTemplateItems.length) {
    console.log(`    ⚠ WARNING：distinctJoinTargets(${joinTargetsRt.size}) < 条目数(${routineTemplateItems.length})`
      + ` —— 最大一组 "${topGroups(joinTargetsRt, 1)}"；模板表有重复`
      + ` (routineId, sub, params) 组合（数据层重复，不判失败）。`);
  }
  check('[e] 例程模板期望值只由条目字段决定（distinctExpected = distinctJoinTargets）',
    expectedRt.size === joinTargetsRt.size,
    `distinctExpected=${expectedRt.size} distinctJoinTargets=${joinTargetsRt.size}`);
  check('[e] 例程模板构帧 = 31<sub><RID><params>（逐字节相等 pass/total）',
    passRt === routineTemplateItems.length && routineTemplateItems.length > 0,
    `${passRt}/${routineTemplateItems.length}`
    + (bad.length ? `；不符 ${bad.length} 条（前 5）：\n        - ${bad.slice(0, 5).join('\n        - ')}` : ''));
  check('[e] 构帧长度 = 4 + params 字节数（全量）',
    routineTemplateItems.every((it) => {
      const f = (featureFramesFor('routine', it) || [])[0] || '';
      return f.length === 8 + normBytes(it.params).length;
    }),
    `逐条 ${routineTemplateItems.length} 条长度校验`);
  check('[e] params 非空条目数 = 133/139（6 条空 params 属结构事实）',
    withParams === 133 && routineTemplateItems.length === 139,
    `params 非空 ${withParams}/${routineTemplateItems.length}（期望 133/139）`);
  check('[e] 6 条空 params 条目清单固定（钉死 rid+sub，防参数被清空后当"本来就空"）',
    emptySorted.length === EXPECTED_EMPTY_PARAMS.length
      && emptySorted.map((e) => e.label).join(';') === EXPECTED_EMPTY_PARAMS.join(';'),
    `实得 ${emptySorted.length} 条：${emptySorted.map((e) => e.label).join(' / ')}`);
  check('[e] params 非空但帧长 == 4 字节（丢参数）必须 0 条', lostParams === 0,
    `${lostParams} 条；带参数 ${withParams} 条`);
  sectionSummary('(e) 例程模板', passRt, routineTemplateItems.length);

// ───────────────────────────────────────────────────────────────────
// (f) 0x31 参数：两个源、六桶互斥穷尽、长度交叉核对
//
//   旧实现只接 `data/gag-routines.json` 一个源，把 123 条包内本来就有模板的例程
//   标成"无参数"。现在两个源 + 六桶 + `paramsResolved` 三值，并且：
//   · `paramsResolved=multi` **不许挑一个**（标定值猜错等于写坏 ECU）→ 禁驱动；
//   · `no-template` 是"连模板都没有"，与"多候选"是两件事 → driveDisabled；
//   · 两源都有非空载荷时长度必须相等（模板串错位的探测器），唯一白名单 01|0600。
// ───────────────────────────────────────────────────────────────────
console.log('\n(f) 0x31 参数六桶（gag-routines + function-sequences）+ 长度交叉核对');
{
  const BUCKETS = ['gagLibNonEmpty', 'gagLibEmpty', 'specfSeqUnique',
    'specfSeqMulti', 'specfSeqEmpty', 'noTemplate'];
  const SRC_ALLOWED = ['gag-lib', 'specf-seq', 'specf-seq-empty', 'no-template'];
  const RES_ALLOWED = ['unique', 'multi', 'none'];
  const LEN_WHITELIST = ['01|0600'];
  const fok = { f1: false, f2: false, f3: false, f4: false, f5: false, f6: false, f7: false };

  const live = {};
  for (const b of BUCKETS) live[b] = 0;
  const offSrc = [];
  const offRes = [];
  let joinMissingSub = 0;
  let subMismatch = 0;
  for (const it of items31) {
    // join key 的 sub 必须从 it.sub 解析出来（缺失才回退 ctrlBytes[2]），否则 key 会被
    // 污染成 "undefined|xxxx"，统计悄悄偏小 —— 这里逐条断言两侧一致。
    const cb = ctrlBytesOf(it);
    if (!Number.isInteger(Number(it.sub))) joinMissingSub += 1;
    else if (Number(it.sub) !== cb[2]) subMismatch += 1;
    if (!SRC_ALLOWED.includes(it.paramsSrc)) offSrc.push(`${it.name}:${it.paramsSrc}`);
    if (!RES_ALLOWED.includes(it.paramsResolved)) offRes.push(`${it.name}:${it.paramsResolved}`);
    const p = normBytes(it.params);
    if (it.paramsSrc === 'gag-lib') live[p ? 'gagLibNonEmpty' : 'gagLibEmpty'] += 1;
    else if (it.paramsSrc === 'specf-seq') live[it.paramsResolved === 'multi' ? 'specfSeqMulti' : 'specfSeqUnique'] += 1;
    else if (it.paramsSrc === 'specf-seq-empty') live.specfSeqEmpty += 1;
    else if (it.paramsSrc === 'no-template') live.noTemplate += 1;
  }
  const recorded = actuatorDoc.source?.paramsStats || {};
  const sumLive = BUCKETS.reduce((a, b) => a + live[b], 0);
  const sumRec = BUCKETS.reduce((a, b) => a + Number(recorded[b] || 0), 0);
  console.log(`    六桶（现算）：${BUCKETS.map((b) => `${b}=${live[b]}`).join(' · ')}`
    + ` = ${sumLive} / 31 共 ${items31.length}`
    + ` · paramsUnresolved=${live.specfSeqMulti + live.noTemplate}`);
  const resDist = new Map();
  const srcDist = new Map();
  for (const it of items31) {
    bump(resDist, String(it.paramsResolved));
    bump(srcDist, String(it.paramsSrc));
  }
  console.log(`    paramsResolved 分布：${[...resDist.entries()].map(([k, v]) => `${k}=${v}`).join(' · ')}`
    + ` · paramsSrc 分布：${[...srcDist.entries()].map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  fok.f1 = check('[f-1] 六桶互斥穷尽：和 = form:\'31\' 条数（两侧都现算，不写死 283）',
    sumLive === items31.length && sumRec === items31.length
      && BUCKETS.every((b) => Number(recorded[b]) === live[b]),
    `现算 ${JSON.stringify(live)} = ${sumLive} · 数据 ${JSON.stringify(recorded)} = ${sumRec}`
    + ` · 31 共 ${items31.length}`);
  fok.f2 = check('[f-2] paramsSrc 只在四值内、paramsResolved 只在三值内',
    offSrc.length === 0 && offRes.length === 0,
    `越界 src ${offSrc.length}（${offSrc.slice(0, 3).join(',')}）· 越界 resolved ${offRes.length}`);
  fok.f3 = check('[f-3] join key 无污染：每条 31 都能解析出 sub，且 it.sub === ctrlBytes[2]',
    joinMissingSub === 0 && subMismatch === 0,
    `缺 sub ${joinMissingSub} 条 · 与 ctrlBytes[2] 不符 ${subMismatch} 条`);
  const multi = items31.filter((x) => x.paramsResolved === 'multi');
  const badMulti = multi.filter((x) => !Array.isArray(x.paramsCandidates)
    || x.paramsCandidates.length < 2 || x.driveDisabled !== true
    || !String(x.driveDisabledReason || '').trim() || normBytes(x.params) !== '');
  fok.f4 = check('[f-4] paramsResolved=multi：候选 ≥2、params 留空、必须禁驱动且写理由（防"标了多值却仍可点"）',
    multi.length > 0 && badMulti.length === 0,
    `multi ${multi.length} 条，不符 ${badMulti.length} 条`
    + (badMulti.length ? `（${badMulti.slice(0, 3).map((x) => x.name).join('；')}）` : ''));
  const none = items31.filter((x) => x.paramsResolved === 'none');
  const badNone = none.filter((x) => x.driveDisabled !== true
    || !String(x.driveDisabledReason || '').trim()
    || (Array.isArray(x.paramsCandidates) && x.paramsCandidates.length));
  fok.f5 = check('[f-5] paramsResolved=none（no-template）：必须禁驱动且不许带候选',
    none.length > 0 && badNone.length === 0, `none ${none.length} 条，不符 ${badNone.length} 条`);
  const uniqNonEmpty = items31.filter(
    (x) => x.paramsSrc === 'specf-seq' && x.paramsResolved === 'unique' && normBytes(x.params));
  const badUniq = uniqNonEmpty.filter((x) => !Array.isArray(x.paramsCandidates)
    || !x.paramsCandidates.map((c) => normBytes(c)).includes(normBytes(x.params)));
  fok.f6 = check('[f-6] paramsResolved=unique 且参数非空：params 必须出现在 paramsCandidates 里',
    uniqNonEmpty.length > 0 && badUniq.length === 0,
    `unique 非空 ${uniqNonEmpty.length} 条，不符 ${badUniq.length} 条`);
  // ④ 长度交叉核对：只比"两源都有非空载荷"的对；分母现算，断言的是**集合**不是总数
  const lc = actuatorDoc.source?.paramsSources?.lengthCrossCheck || {};
  const badKeys = (lc.mismatches || []).map((m) => String(m.key)).sort();
  fok.f7 = check('[f-7] 两源非空载荷长度交叉核对：不符集合 == 白名单（集合相等，不比总数）',
    Number(lc.pairsBothNonEmpty) > 0
      && JSON.stringify(badKeys) === JSON.stringify(LEN_WHITELIST.slice().sort()),
    `pairsBothPresent=${lc.pairsBothPresent} · pairsBothNonEmpty=${lc.pairsBothNonEmpty}`
    + ` · 不符 ${badKeys.length} 对 ${JSON.stringify(badKeys)}（白名单 ${JSON.stringify(LEN_WHITELIST)}）`);
  sectionSummary('(f) 0x31 参数六桶', Object.values(fok).filter(Boolean).length, 7);
}

// ───────────────────────────────────────────────────────────────────
// (g) 地址判定：unverified 清零、模块可拆/歧义、按 SID 记账
//
//   ① `unverified` 的旧判据是"地址 < 0x0100"，那 16 条其实是**判据错**不是数据错：
//      同 (block, chain, sid) 下所有规范记录给的是**同一个** id → 改判 single-address。
//      只改判定、不改地址 —— 用内联常量表逐条钉住（不用 git show HEAD，那是旧塌缩数据）。
//   ② 7 条模块级歧义白名单：双向断言（多一条少一条都红），且必须禁驱动。
//   ③ 按 SID 的记账恒等式：single + multi = total，multi = separable + ambiguous + not-applicable。
//      ⚠️ 31 的 multi 是 12 不是 5：另有 7 条是 27 字节布局冲突（判不了，not-applicable）。
// ───────────────────────────────────────────────────────────────────
console.log('\n(g) 地址判定：unverified 清零 / 模块可拆 / 歧义白名单 / 按 SID 记账');
{
  // 曾经被判 unverified 的 16 条（(chain, sid, addr)）：改判后地址值必须一字不差
  const gok = { g1: false, g2: false, g3: false, g4: false, g5: false };
  const FORMER_UNVERIFIED = [
    ['0x80002F17', '2F', 0x0000], ['0x80002F19', '2F', 0x0001],
    ['0x800035B1', '2F', 0x0004], ['0x80005076', '2F', 0x0002],
    ['0x80004ACF', '31', 0x0006], ['0x80004AD1', '31', 0x0007],
    ['0x80004AD2', '31', 0x0004], ['0x80004AEE', '31', 0x0002],
    ['0x80004AF0', '31', 0x0010], ['0x80004AF2', '31', 0x0011],
    ['0x80004AF4', '31', 0x0012], ['0x80004AF6', '31', 0x0013],
    ['0x80004D09', '31', 0x0008], ['0x80004D16', '31', 0x0006],
    ['0x80004D25', '31', 0x0004], ['0x80000075', '31', 0x000A],
  ];
  const badFormer = FORMER_UNVERIFIED.filter(([chain, sid, addr]) => {
    const it = actuatorItems.find((x) => x.chain === chain);
    if (!it) return true;
    const used = sid === '2F' ? Number(it.did) : Number(it.rid);
    const res = sid === '2F' ? it.didResolve : it.ridResolve;
    return used !== addr || res !== 'single-address' || it.addrBelowFloor !== true;
  });
  gok.g1 = check('[g-1] 16 条低地址改判 single-address 且地址值一字未动（内联常量表逐条）',
    badFormer.length === 0,
    `不符 ${badFormer.length}/${FORMER_UNVERIFIED.length}`
    + (badFormer.length ? `（${badFormer.map((x) => x[0]).join(',')}）` : ''));

  const unv = actuatorItems.filter((x) => x.didResolve === 'unverified' || x.ridResolve === 'unverified');
  gok.g2 = check('[g-2] unverified === 0（判据 = 同 (block,chain,sid) 所有规范记录同 id，不再拿地址高低当未验证）',
    unv.length === 0, `仍有 ${unv.length} 条：${unv.slice(0, 3).map((x) => x.name).join('；')}`);

  const WL = [
    ['0x800017F2', '2F', [0x0501, 0x0535]],
    ['0x80001E52', '2F', [0x0339, 0x7017]],
    ['0x80001E54', '2F', [0x033A, 0x7018]],
    ['0x80001E56', '2F', [0x033B, 0x7019]],
    ['0x80001E76', '2F', [0x0337, 0x703A]],
    ['0x80001E13', '31', [0x2021, 0x2022]],
    ['0x800034BA', '31', [0x030D, 0x03E5]],
  ];
  const realAddrs = (it) => (it.didCandidates || it.ridCandidates || [])
    .filter((c) => !c.layout)
    .map((c) => Number(c.did != null ? c.did : c.rid))
    .sort((a, b) => a - b);
  const sigOf = (chain, sid, addrs) => `${chain}|${sid}|${addrs.slice().sort((a, b) => a - b)
    .map((a) => `0x${padHex(a, 4)}`).join('/')}`;
  const liveAmb = actuatorItems
    .filter((x) => x.didResolve === 'ambiguous-in-module' || x.ridResolve === 'ambiguous-in-module')
    .map((x) => sigOf(x.chain, x.form === '2f' ? '2F' : '31', realAddrs(x)));
  const wantAmb = WL.map(([chain, sid, addrs]) => sigOf(chain, sid, addrs));
  const onlyLive = liveAmb.filter((x) => !wantAmb.includes(x));
  const onlyWant = wantAmb.filter((x) => !liveAmb.includes(x));
  gok.g3 = check('[g-3] 模块级歧义集合 == 白名单 7 条（双向：多一条少一条都红）',
    onlyLive.length === 0 && onlyWant.length === 0 && liveAmb.length === wantAmb.length,
    `数据 ${liveAmb.length} 条 · 白名单 ${wantAmb.length} 条 · 多出 ${JSON.stringify(onlyLive)} · 缺 ${JSON.stringify(onlyWant)}`);
  const ambRows = actuatorItems.filter(
    (x) => x.didResolve === 'ambiguous-in-module' || x.ridResolve === 'ambiguous-in-module');
  const badAmb = ambRows.filter((x) => x.driveDisabled !== true
    || !String(x.driveDisabledReason || '').trim());
  gok.g4 = check('[g-4] 7 条歧义条目全部禁驱动且理由非空',
    ambRows.length === WL.length && badAmb.length === 0, `不符 ${badAmb.length}/${ambRows.length}`);
  // ③ 按 SID 现算并打印（这才是"数据自洽"，不是"数字吻合别人一次性的口径产物"）
  const rows = [];
  for (const [label, list, field] of [['2F', items2f, 'didResolve'], ['31', items31, 'ridResolve']]) {
    const c = { single: 0, multi: 0, separable: 0, ambiguous: 0, 'not-applicable': 0 };
    for (const it of list) {
      const r = String(it[field] || '');
      if (r === 'single-address') c.single += 1;
      else if (r === 'multi-resolved-by-module') { c.multi += 1; c.separable += 1; }
      else if (r === 'ambiguous-in-module') { c.multi += 1; c.ambiguous += 1; }
      else if (r === 'multi-address') { c.multi += 1; c['not-applicable'] += 1; }
    }
    rows.push({ label, total: list.length, ...c });
    console.log(`    ${label}: total=${list.length}  single=${c.single}  multi=${c.multi}`
      + `（separable=${c.separable} / ambiguous=${c.ambiguous} / not-applicable=${c['not-applicable']}）`);
  }
  const acctOk = rows.every((r) => r.single + r.multi === r.total
    && r.multi === r.separable + r.ambiguous + r['not-applicable']);
  gok.g5 = check('[g-5] 按 SID 记账自洽：single + multi = total，multi = separable + ambiguous + not-applicable',
    acctOk, rows.map((r) => `${r.label} ${r.single}+${r.multi}=${r.total} / ${r.multi}=${r.separable}+${r.ambiguous}+${r['not-applicable']}`).join(' · '));
  const total = rows.reduce((a, r) => ({ single: a.single + r.single, multi: a.multi + r.multi }), { single: 0, multi: 0 });
  console.log(`    合计: single=${total.single}  multi=${total.multi}（= separable ${rows.reduce((a, r) => a + r.separable, 0)}`
    + ` + ambiguous ${rows.reduce((a, r) => a + r.ambiguous, 0)}）；`
    + `歧义白名单 ${liveAmb.length}/${wantAmb.length} 命中 · unverified ${unv.length} 条`);
  sectionSummary('(g) 地址判定', Object.values(gok).filter(Boolean).length, 5);
}
}

// ───────────────────────────────────────────────────────────────────
// (h) 27 字节记录形态：只记录、不进候选（「语义不可混标」的硬边界）
//
//   两条**独立**线索同时指向「2F 多址 13 + 31 多址 5 = 18」：
//     ① 规范 11 字节块按 SID 分组的候选地址（本目录口径）；
//     ② 地址歧义研究：18 = 11 条模块可唯一确定 + 7 条白名单不可解。
//   一旦把 27 字节块的 +6 读数也追加进候选列表，合计就变 25，这个恒等式当场断掉 ——
//   所以这里把「另一形态的值只出现在 rawLayoutCandidates」钉成断言，
//   而不是只写在注释里（注释拦不住下一次"顺手补全"）。
//
//   ⚠️ 同时保留的**事实陈述**：27 字节块是一个有结构的记录形态（地址双字节在尾部重复），
//   `+6` 按 **u16 LE** 读 —— 这两点都能从 cmdRaw 字节独立重算，所以断言它们；
//   但"哪个形态权威"离线无法判定（这 8 条链在实测帧库里一条都没有），因此不做取舍。
// ───────────────────────────────────────────────────────────────────
console.log('\n(h) 27 字节记录形态：只记录不取舍 / 不进候选列表 / 多址合计 18');
{
  const hok = {};
  const LAYOUT_NAMES = [
    '机油压力控制', '转速升高快速测试', '热管理', '真空系统',
    '恒温器诊断第1部分系统测试', '恒温器诊断第2部分系统测试', '油箱通风阀', '关闭发动机',
  ].sort();
  const liveLayout = actuatorItems.filter((x) => x.rawLayoutConflict === true);
  const liveNames = liveLayout.map((x) => String(x.name || '')).sort();
  hok.h1 = check('[h-1] rawLayoutConflict=true 的条目 == 8 条写入死名字（集合相等，多一条少一条都红）',
    JSON.stringify(liveNames) === JSON.stringify(LAYOUT_NAMES),
    `数据 ${liveNames.length} 条：${liveNames.join(' / ')}`);

  // ② 每条恰好两项、两个 layout 名各一，且门禁**自己**从 cmdRaw 字节重算 +6：
  //    LE 读数必须等于 27B 候选值，且必须与 BE 读数不同（否则端序就没有证据力）
  //    另：BIN 可达时，cmdRaw 必须是 BIN 里该 chain 真实存在的 27 字节块（不认数据的自述）
  const binAltBad = [];
  if (actinfo) {
    for (const it of liveLayout) {
      const alts = (actinfo.records.get(it.chain) || [])
        .map((r) => r.cmd).filter((c) => c.length === 27);
      const alt = (it.rawLayoutCandidates || []).find((c) => c.layout === 'cmd-block-27B');
      const raw = normBytes(it.cmdRaw);
      if (!alt || !alts.map((c) => c.toString('hex').toUpperCase()).includes(raw)) {
        binAltBad.push(`${it.name}:cmdRaw 不是 BIN 里该 chain 的 27 字节块`);
      } else if (alts.length !== Number(alt.occurrences)) {
        binAltBad.push(`${it.name}:BIN 27B 记录 ${alts.length} 条 vs occurrences=${alt.occurrences}`);
      }
    }
  }
  const badPairs = [];
  const badEndian = [];
  for (const it of liveLayout) {
    const cs = Array.isArray(it.rawLayoutCandidates) ? it.rawLayoutCandidates : [];
    const layouts = cs.map((c) => String(c.layout)).sort().join(',');
    if (cs.length !== 2 || layouts !== 'cmd-block-11B,cmd-block-27B') {
      badPairs.push(`${it.name}:候选 ${cs.length} 项 [${layouts || '空'}]`);
      continue;
    }
    const raw = bytesOf(normBytes(it.cmdRaw));
    const alt = cs.find((c) => c.layout === 'cmd-block-27B');
    const le = cmdAddrLE(raw);
    const be = cmdAddrBE(raw);
    if (raw.length !== 27 || le !== Number(alt.value) || le === be) {
      badEndian.push(`${it.name}:cmdRaw ${raw.length}B · +6 LE=0x${padHex(le, 4)}`
        + ` vs 27B 候选 0x${padHex(Number(alt.value), 4)} · BE=0x${padHex(be, 4)}`);
    }
  }
  hok.h2 = check('[h-2] 每条冲突恰好 2 项候选（11B/27B 各一），且门禁从 cmdRaw 重算 +6 LE = 27B 值 ≠ BE 读数',
    liveLayout.length > 0 && badPairs.length === 0 && badEndian.length === 0
      && binAltBad.length === 0,
    `不符 ${badPairs.length + badEndian.length + binAltBad.length}/${liveLayout.length}`
    + (badPairs.length ? `；候选集合：${badPairs.slice(0, 3).join('；')}` : '')
    + (badEndian.length ? `；端序重算：${badEndian.slice(0, 3).join('；')}` : '')
    + (binAltBad.length ? `；BIN 复核：${binAltBad.slice(0, 3).join('；')}` : '')
    + (actinfo ? `；BIN 侧 27 字节块逐条命中 ${liveLayout.length - binAltBad.length} 条` : '；BIN 不可达'));

  // ③ 结构证据：地址双字节在 27 字节块里**重复出现**（+6 与尾部各一次以上）。
  //    这条是「27B 是有结构的记录形态、+6 不是噪声」的独立重算，不读数据的 note。
  const repeatBad = [];
  for (const it of liveLayout) {
    const raw = bytesOf(normBytes(it.cmdRaw));
    const alt = (it.rawLayoutCandidates || []).find((c) => c.layout === 'cmd-block-27B');
    if (!alt || raw.length !== 27) { repeatBad.push(`${it.name}:cmdRaw 非 27 字节`); continue; }
    const v = Number(alt.value);
    const lePair = [v & 0xff, (v >> 8) & 0xff];
    const bePair = [lePair[1], lePair[0]];
    const countPair = (pair) => {
      let n = 0;
      for (let k = 0; k + 1 < raw.length; k += 1) if (raw[k] === pair[0] && raw[k + 1] === pair[1]) n += 1;
      return n;
    };
    const leCount = countPair(lePair);
    const at6 = raw[6] === lePair[0] && raw[7] === lePair[1];
    if (!at6 || leCount < 3 || leCount <= countPair(bePair)) {
      repeatBad.push(`${it.name}:+6 命中=${at6} LE 对出现 ${leCount} 次 / BE 对 ${countPair(bePair)} 次`);
    }
  }
  hok.h3 = check('[h-3] 27 字节块是结构化记录：地址双字节在 +6 与尾部重复（LE 对出现 ≥3 次且多于 BE 对）',
    repeatBad.length === 0,
    `不符 ${repeatBad.length}/${liveLayout.length}`
    + (repeatBad.length ? `：${repeatBad.slice(0, 3).join('；')}` : '（8/8 满足：地址双字节在 +6 与尾部各出现一次以上）'));

  // ④ 语义边界：27B 的读数**不得**出现在候选地址列表里（防止哪天又被人"补全"回去）
  const leaked = [];
  for (const it of liveLayout) {
    const alt = (it.rawLayoutCandidates || []).find((c) => c.layout === 'cmd-block-27B');
    if (!alt) continue;
    const cands = (it.didCandidates || it.ridCandidates || [])
      .map((c) => Number(c.did != null ? c.did : c.rid));
    const altVal = Number(alt.value);
    if (cands.includes(altVal)) {
      leaked.push(`${it.name}:候选列表里出现了 27B 值 0x${padHex(altVal, 4)}`);
    }
  }
  hok.h4 = check('[h-4] 27 字节形态的读数不出现在 didCandidates / ridCandidates 里（语义不可混标）',
    leaked.length === 0,
    leaked.length ? `泄漏 ${leaked.length} 条：${leaked.slice(0, 3).join('；')}`
      : `${liveLayout.length} 条冲突条目的候选列表只含规范 11 字节块地址`);

  // ⑤ 精确计数 + 零实例枚举：18 = 13 + 5，且 multiAddressBasis 里再没有 raw-layout-conflict
  const multi2f = items2f.filter((x) => x.didResolve !== 'single-address');
  const multi31 = items31.filter((x) => x.ridResolve !== 'single-address');
  const cand2f = items2f.filter((x) => (x.didCandidates || []).length > 1);
  const cand31 = items31.filter((x) => (x.ridCandidates || []).length > 1);
  const basisRaw = actuatorItems.filter((x) => String(x.multiAddressBasis || '') === 'raw-layout-conflict');
  hok.h5 = check('[h-5] 多址精确计数：2F 13 + 31 5 = 18（= 11 模块可拆 + 7 白名单不可解），'
    + '且 multiAddressBasis 里 raw-layout-conflict 出现 0 次',
  multi2f.length === 13 && multi31.length === 5
      && multi2f.length + multi31.length === 18
      && cand2f.length === multi2f.length && cand31.length === multi31.length
      && basisRaw.length === 0,
  `2F ${multi2f.length}（候选>1 的 ${cand2f.length}） + 31 ${multi31.length}（候选>1 的 ${cand31.length}）`
  + ` = ${multi2f.length + multi31.length} · raw-layout-conflict 残留 ${basisRaw.length} 条`);

  // ⑥ 实测背书标记不得挂在"不采用"的值上（带 inGagLib:true 的候选会被误读成"实测背书"）
  const gagMarked = [];
  for (const it of liveLayout) {
    for (const c of it.rawLayoutCandidates || []) {
      if (c && Object.prototype.hasOwnProperty.call(c, 'inGagLib')) {
        gagMarked.push(`${it.name}:${c.layout} 带 inGagLib=${c.inGagLib}`);
      }
    }
  }
  hok.h6 = check('[h-6] rawLayoutCandidates 项上没有 inGagLib 字段（"不采用、仅记录"的值不需要实测背书标记）',
    gagMarked.length === 0,
    gagMarked.length ? `带标记 ${gagMarked.length} 处：${gagMarked.slice(0, 3).join('；')}`
      : `${liveLayout.length * 2} 个候选对象均无 inGagLib 字段`);
  sectionSummary('(h) 27B 记录形态边界', Object.values(hok).filter(Boolean).length, 6);
}

console.log(`\n${ASSERTION}: ${pass} passed / ${fail} failed`
  + ` | 2f=${items2f.length} 31=${items31.length}`
  + ` measure=${measureItems.length} routine=${routineTemplateItems.length}`
  + (actinfo ? '' : ' | SKIP_ACTINFO'));
if (failures.length) {
  console.log(`\n失败明细（${failures.length}）：`);
  for (const f of failures) console.log(`  - ${f}`);
}
if (!selfCheckOk) {
  console.log('\nSELF_CHECK_FAILED —— 反向自检未通过，门禁结果不可信。');
  process.exit(1);
}
if (fail) {
  console.log(`\n不通过：${ASSERTION} FAIL`);
  process.exit(1);
}
console.log(`\n通过：${ASSERTION} PASS`);
process.exit(0);
