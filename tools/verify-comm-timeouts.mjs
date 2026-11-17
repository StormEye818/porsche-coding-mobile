#!/usr/bin/env node
/**
 * verify-comm-timeouts.mjs —— 原厂通讯等待上限（`SetCommunicationMaximumWaitTime`）
 * 数据驱动门禁。
 *
 * 断言名（供审计 / U-1 三件套引用）：`COMM_TIMEOUT_431_STATIC`
 *   （该字符串只在 tools/ 下出现，不进 www 产物）
 *
 * 守的是什么（三层，缺一层都不算证过）
 * ──────────────────────────────────────
 * 层 0  解码器自检 —— `DECODER_SELF_CHECK`。
 *       6 组**已知对**的「字节 → 毫秒」必须先解对，任一不符立刻 exit 1。
 *       作用：保证下面所有「算术自证」不是查表对答案，而是真的在算。
 *
 * 层 (a) 算术自证 —— **任何环境都跑**，不依赖 ref/。
 *       · 每条 anchor 的 `immBytes` 由本脚本**自己解码**，必须等于表里的 `valueMs`
 *         （`movw` / `mov.w` 各一套解码，见 decodeMovw / decodeThumbExpandImm）
 *       · 全局初始化常量按 `u32le` 解
 *       · `unresolvedCandidates` 的 5 条同样自解，必须等于各自 `decodedMs`
 *       改动 `immBytes` 或数字任一边，这里立刻红 —— 无法「偷偷把 18000 改成 12000」。
 *
 * 层 (b) 现场字节 + 重定位 —— 仅 `ref/` 存在时；缺失打印 `SKIP_REF` 跳过。
 *       · 按 `fileOffset` 回读原厂库，必须与 `immBytes` **逐字节相等**
 *         （**先比字节再解码**，顺序反了解码异常会掩盖偏移错）
 *       · `fileOffset + n <= fileSize`，越界 **直接 exit 1**（`OFFSET_OUT_OF_BOUNDS`）
 *         —— 禁止 try/catch 静默跳过，否则就是「永远绿」的假断言
 *       · 跨库候选：复算 GOT 槽（`ldr r0,[pc,#imm]` 字面量 + `add r0,pc` 对齐基址）
 *         必须等于表里的 `relocOffset`，且 `.rel.dyn` 该条 `r_info & 0xff == 21`
 *         （R_ARM_GLOB_DAT）、符号名 == `SetCommunicationMaximumWaitTime`
 *
 * 层 (c) 单一真值 —— `src/comm-timeouts.js` ≡ JSON（双向，键集合 + 取值）。
 *
 * 另外守：
 * ⑤ `timeoutFor()` 未知/空角色一律抛错（不静默兜底）
 * ⑥ category ① 已迁移的 23 个调用点 anchor 全在、每文件 `timeoutFor(` 条数精确相等
 * ⑦ `src/elm327.js` 零 `timeoutFor(`（适配器 AT 读窗口属类别 ③）
 * ⑧a 已接线值必须 ∈ {5000, 8000, 16000}
 * ⑧b 任何不在那三个里的候选值只许出现在 `unresolvedCandidates`，**且不得被
 *    `timeoutFor()` 解析到**（接线隔离）—— 证据留档，但不进代码路径
 *
 * 跑法：node tools/verify-comm-timeouts.mjs
 * 退出码：0 = 全绿（含全 SKIP_REF）；1 = 有 FAIL
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { COMM_TIMEOUT, COMM_TIMEOUT_KINDS, COMM_TIMEOUT_ROLE, timeoutFor, commTimeoutTable }
  from '../src/comm-timeouts.js';

const NAME = 'COMM_TIMEOUT_431_STATIC';
let pass = 0;
let fail = 0;
let skip = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' —— ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' —— ' + x : ''}`); }
};
const skipped = (n, why) => { skip++; console.log(`  SKIP ${n} —— ${why}`); };

const DATA_REL = 'data/comm-timeouts-oem.json';
const decompileRel = 'ref/reverse/ghidra/libCOMM_ABSTRACT_LAYER.txt';

console.log(`\n[${NAME}] 原厂通讯等待上限数据驱动`);

// ══════════════════════════════════════════════════════════════
//  层 0：解码器自检 —— 必须先证明「我会算」，再拿算术去当判据
// ══════════════════════════════════════════════════════════════
/**
 * Thumb-2 `movw`（T3）立即数解码。
 * 编码布局：hw1 = `11110 i 10 0100 imm4`，hw2 = `0 imm3 Rd imm8`
 *   imm16 = imm4<<12 | i<<11 | imm3<<8 | imm8
 * @param {number[]} b4 4 字节（文件字节序，小端）
 * @returns {number}
 */
function decodeMovw(b4) {
  const hw1 = b4[0] | (b4[1] << 8);
  const hw2 = b4[2] | (b4[3] << 8);
  const i = (hw1 >> 10) & 1;
  const imm4 = hw1 & 0xf;
  const imm3 = (hw2 >> 12) & 7;
  const imm8 = hw2 & 0xff;
  return (((imm4 << 12) | (i << 11) | (imm3 << 8) | imm8) >>> 0);
}

/** ThumbExpandImm（12 位编码 → 32 位常量），`mov.w rX,#imm` 用。 */
function decodeThumbExpandImm(b4) {
  const hw1 = b4[0] | (b4[1] << 8);
  const hw2 = b4[2] | (b4[3] << 8);
  const imm12 = (((hw1 >> 10) & 1) << 11) | (((hw2 >> 12) & 7) << 8) | (hw2 & 0xff);
  const top2 = (imm12 >> 10) & 3;
  if (top2 === 0) {
    const t = (imm12 >> 8) & 3;
    const b = imm12 & 0xff;
    if (t === 0) return b >>> 0;
    if (t === 1) return (((b << 8) | b) >>> 0);
    if (t === 2) return ((b * 0x10001) >>> 0);
    return ((b * 0x1010101) >>> 0);
  }
  const unrot = 0x80 | (imm12 & 0x7f);
  const rot = (imm12 >> 7) & 0x1f;
  return (((unrot >>> rot) | (unrot << (32 - rot))) >>> 0);
}

/** 按 `encoding` 字段解码 4 字节；未知编码抛错（不猜）。 */
function decodeImm(bytesHex, encoding) {
  const bytes = String(bytesHex).trim().split(/\s+/).map((h) => parseInt(h, 16));
  if (bytes.length !== 4 || bytes.some((v) => !Number.isInteger(v))) {
    throw new Error(`immBytes 必须是 4 个字节：${JSON.stringify(bytesHex)}`);
  }
  if (encoding === 'movw') return decodeMovw(bytes);
  if (encoding === 'mov.w') return decodeThumbExpandImm(bytes);
  throw new Error(`未知 encoding：${JSON.stringify(encoding)}`);
}

const SELF_CHECK = [
  ['44 F2 50 60', 'movw', 0x4650],   // 18000
  ['46 F2 A8 10', 'movw', 0x61a8],   // 25000
  ['40 F6 B8 30', 'movw', 0x0bb8],   // 3000
  ['44 F6 20 60', 'movw', 0x4e20],   // 20000
  ['41 F2 88 32', 'movw', 0x1388],   // 5000
  ['4F F4 FA 52', 'mov.w', 0x1f40],  // 8000
];
const selfBad = SELF_CHECK.filter(([h, enc, want]) => decodeImm(h, enc) !== want)
  .map(([h, enc, want]) => `${h}/${enc} → ${decodeImm(h, enc)} ≠ ${want}`);
if (selfBad.length) {
  console.log(`  FAIL DECODER_SELF_CHECK —— ${selfBad.join(' | ')}`);
  console.log(`\n===== ${NAME}: DECODER_SELF_CHECK_FAILED =====`);
  process.exit(1);
}
console.log(`  ok   DECODER_SELF_CHECK —— 6 组已知对全部解对：`
  + SELF_CHECK.map(([h, , want]) => `${h.replace(/ /g, '')}=${want}`).join(' / '));

const data = JSON.parse(readFileSync(DATA_REL, 'utf8'));
const kinds = data.kinds || {};
const cands = data.unresolvedCandidates || [];
const expectedKinds = ['IDENTIFY', 'LINK_DEFAULT', 'RESET'];
const WIRED = new Set([5000, 8000, 16000]);

// ── ① 表结构 + 三档取值 ────────────────────────────────────────────
ok('① 表结构完整（unit=ms / kinds 恰为 3 档 / 每档 valueMs 为正整数）',
  data.unit === 'ms'
  && JSON.stringify(Object.keys(kinds).sort()) === JSON.stringify(expectedKinds)
  && expectedKinds.every((k) => Number.isInteger(kinds[k].valueMs) && kinds[k].valueMs > 0),
  `unit=${data.unit} kinds=${JSON.stringify(Object.keys(kinds).sort())}`
    + ` values=${JSON.stringify(expectedKinds.map((k) => kinds[k] && kinds[k].valueMs))}`);

ok('① 三档取值恰为 5000 / 8000 / 16000（COMM 层 8 个写入点只有这三个数）',
  kinds.LINK_DEFAULT?.valueMs === 5000 && kinds.IDENTIFY?.valueMs === 8000
  && kinds.RESET?.valueMs === 16000,
  `${kinds.LINK_DEFAULT?.valueMs} / ${kinds.IDENTIFY?.valueMs} / ${kinds.RESET?.valueMs}`);

// ── (a) 算术自证：本脚本自己解码 immBytes，与表里的数字比 ─────────────
{
  const bad = [];
  let n = 0;
  for (const k of expectedKinds) {
    const anchors = kinds[k].anchors || [];
    if (!anchors.length) { bad.push(`${k}: 无 anchors`); continue; }
    for (const a of anchors) {
      n += 1;
      let got;
      try { got = decodeImm(a.immBytes, a.encoding); }
      catch (e) { bad.push(`${k}@${a.insnOffset}: ${e.message}`); continue; }
      if (got !== kinds[k].valueMs) bad.push(`${k}@${a.insnOffset}: 解码 ${got} ≠ ${kinds[k].valueMs}`);
    }
  }
  ok(`(a) 三档 ${n} 个 anchor 的 immBytes 由本脚本自行解码 == valueMs（算术自证，不查表）`,
    n >= 5 && bad.length === 0, bad.length ? bad.slice(0, 3).join(' | ') : `${n} 个全对`);
}

{
  const g = data.globalDefault || {};
  const bytes = String(g.bytes || '').trim().split(/\s+/).map((h) => parseInt(h, 16));
  const val = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  ok('(a) 全局初始化常量按 u32le 解 == 5000，且记的是 fileOffset 而不是 VA',
    g.encoding === 'u32le' && val === 5000 && /^0x[0-9a-f]+$/i.test(g.fileOffset || '')
    && /^0x[0-9a-f]+$/i.test(g.va || '') && Number(g.fileOffset) !== Number(g.va),
    `bytes=${g.bytes} → ${val} / fileOffset=${g.fileOffset} va=${g.va}`);
}

{
  const bad = [];
  for (const c of cands) {
    let got;
    try { got = decodeImm(c.immBytes, c.encoding); }
    catch (e) { bad.push(`${c.lib}@${c.offset}: ${e.message}`); continue; }
    if (got !== c.decodedMs) bad.push(`${c.lib}@${c.offset}: 解码 ${got} ≠ ${c.decodedMs}`);
  }
  ok(`(a) unresolvedCandidates ${cands.length} 条的 immBytes 自解 == decodedMs（18000/18000/25000/3000/20000）`,
    cands.length === 5 && bad.length === 0,
    bad.length ? bad.slice(0, 3).join(' | ')
      : cands.map((c) => `${c.lib}@${c.offset}=${c.decodedMs}`).join(' / '));
}

// ── ⑦ 适配器层不得被污染（AT 读窗口属类别 ③） ──────────────────────
const elmSrc = readFileSync('src/elm327.js', 'utf8');
ok('⑦ src/elm327.js 零 timeoutFor（适配器 AT 读窗口不参与 ECU 等待档位）',
  !elmSrc.includes('timeoutFor(') && /ATSTFF/.test(elmSrc),
  `timeoutFor 出现 ${(elmSrc.match(/timeoutFor\(/g) || []).length} 次 / ATSTFF=${/ATSTFF/.test(elmSrc)}`);

// ── ④/(c) 单一真值：src/comm-timeouts.js ≡ JSON ─────────────────────
const srcKeys = Object.keys(COMM_TIMEOUT).sort();
const jsonKeys = Object.keys(kinds).sort();
const srcVals = srcKeys.map((k) => COMM_TIMEOUT[k]);
const jsonVals = jsonKeys.map((k) => kinds[k].valueMs);
ok('(c) 单一真值：src/comm-timeouts.js 的 COMM_TIMEOUT 与 JSON kinds 双向相等（键集合 + 取值）',
  JSON.stringify(srcKeys) === JSON.stringify(jsonKeys)
  && JSON.stringify(srcVals) === JSON.stringify(jsonVals),
  `src=${JSON.stringify(Object.fromEntries(srcKeys.map((k) => [k, COMM_TIMEOUT[k]])))}`
    + ` json=${JSON.stringify(Object.fromEntries(jsonKeys.map((k) => [k, kinds[k].valueMs])))}`);

ok('(c) COMM_TIMEOUT_KINDS 与 COMM_TIMEOUT 键集合一致（稳定排序）',
  JSON.stringify(COMM_TIMEOUT_KINDS) === JSON.stringify(srcKeys),
  JSON.stringify(COMM_TIMEOUT_KINDS));

// ── ⑤ timeoutFor 行为（不是只读常量表） ────────────────────────────
const roleNames = Object.keys(COMM_TIMEOUT_ROLE).sort();
const roleResolved = roleNames.every((r) => Object.prototype.hasOwnProperty.call(COMM_TIMEOUT, COMM_TIMEOUT_ROLE[r]));
const throwsOnUnknown = (() => { try { timeoutFor('NO_SUCH_ROLE'); return false; } catch { return true; } })();
const throwsOnEmpty = (() => { try { timeoutFor(''); return false; } catch { return true; } })();
const noSilentFallback = (() => { try { timeoutFor(undefined); return false; } catch { return true; } })();
const noFamilyDimension = (() => {
  // 原厂包内没有「按 ECU 模块分档」的维度；别造 dme/pab/bcm 这类角色
  try { timeoutFor('dme'); return false; } catch { return true; }
})();
ok('⑤ timeoutFor 按语义角色解析到档位，未知/空/模块名角色一律抛错（不返回兜底值）',
  roleResolved && throwsOnUnknown && throwsOnEmpty && noSilentFallback && noFamilyDimension
  && timeoutFor('REQUEST') === COMM_TIMEOUT.IDENTIFY
  && timeoutFor('SHORT') === COMM_TIMEOUT.LINK_DEFAULT
  && timeoutFor('LINK_RESET') === COMM_TIMEOUT.RESET,
  `roles=${JSON.stringify(COMM_TIMEOUT_ROLE)} REQUEST=${timeoutFor('REQUEST')}`
    + ` SHORT=${timeoutFor('SHORT')} throw(unknown)=${throwsOnUnknown} throw('dme')=${noFamilyDimension}`);

const tbl = commTimeoutTable();
ok('⑤ commTimeoutTable() 返回快照（unit/kinds/roles/design 齐备，且改快照不影响模块常量）',
  tbl.unit === 'ms' && Object.keys(tbl.kinds).length === 3
  && tbl.design && tbl.design.KEEPALIVE_MS === 2500 && tbl.design.MAX_PENDING_MS >= 60000 - 1
  && (() => { const before = COMM_TIMEOUT.IDENTIFY; tbl.kinds.IDENTIFY = 1; return COMM_TIMEOUT.IDENTIFY === before; })(),
  `unit=${tbl.unit} roles=${Object.keys(tbl.roles).sort().join('/')} design=${JSON.stringify(tbl.design)}`);

// ── ⑥ 迁移清单：anchor 仍在、每文件条数精确相等 ────────────────────
const mig = data.migration || {};
const sites = mig.sites || [];
const cache = new Map();
const srcOf = (f) => { if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8')); return cache.get(f); };
const siteBad = [];
for (const s of sites) {
  let src = '';
  try { src = srcOf(s.file); } catch (e) { siteBad.push(`${s.file}: 读不到 (${e.message})`); continue; }
  if (!src.includes(s.anchor)) { siteBad.push(`${s.file}: anchor 丢失「${s.anchor.slice(0, 50)}」`); continue; }
  if (!s.anchor.includes(`timeoutFor('${s.role}')`)) siteBad.push(`${s.file}: anchor 未含 timeoutFor('${s.role}')`);
}
const countBad = Object.entries(mig.counts || {}).filter(([f, n]) => {
  const got = (srcOf(f).match(/timeoutFor\(/g) || []).length;
  return got !== n;
}).map(([f, n]) => `${f}: 实得 ${(srcOf(f).match(/timeoutFor\(/g) || []).length} ≠ 表内 ${n}`);
ok(`⑥ category ① 迁移不回退：${sites.length} 个 anchor 全在、且每文件 timeoutFor( 条数精确相等`,
  sites.length === 23 && siteBad.length === 0 && countBad.length === 0,
  siteBad.length || countBad.length
    ? [...siteBad, ...countBad].slice(0, 3).join(' | ')
    : `${sites.length} 处 · counts=${JSON.stringify(mig.counts)}`);

// ── ⑧a / ⑧b 证据「隔离」而不是「删除」 ────────────────────────────
const invented = srcVals.filter((v) => !WIRED.has(v));
ok('⑧a 已接线值必须 ∈ {5000, 8000, 16000}（COMM 层 8 个写入点）',
  invented.length === 0 && srcVals.every((v) => WIRED.has(v)),
  `values=${JSON.stringify(srcVals)} 越界=${JSON.stringify(invented)}`);

{
  const shapeBad = [];
  for (const c of cands) {
    const need = ['lib', 'offset', 'immBytes', 'decodedMs', 'relocOffset', 'relocType', 'status', 'why'];
    const miss = need.filter((f) => c[f] === undefined || c[f] === '');
    if (miss.length) shapeBad.push(`${c.lib}@${c.offset} 缺 ${miss.join(',')}`);
    if (c.status !== 'unresolved') shapeBad.push(`${c.lib}@${c.offset} status=${c.status}（应为 unresolved）`);
    if (c.relocType !== 21) shapeBad.push(`${c.lib}@${c.offset} relocType=${c.relocType}（应为 21 R_ARM_GLOB_DAT）`);
    if (WIRED.has(c.decodedMs)) shapeBad.push(`${c.lib}@${c.offset} decodedMs=${c.decodedMs} 落在已接线集合里（应挪进 kinds）`);
  }
  const wiredFromCands = srcVals.filter((v) => cands.some((c) => c.decodedMs === v));
  ok('⑧b 候选值只许出现在 unresolvedCandidates：字段齐备、status=unresolved、relocType=21，且**无一被 timeoutFor() 解析到**',
    cands.length === 5 && shapeBad.length === 0 && wiredFromCands.length === 0,
    shapeBad.length ? shapeBad.slice(0, 3).join(' | ')
      : `${cands.length} 条候选 · 接线交集=${JSON.stringify(wiredFromCands)}`);
}

// ══════════════════════════════════════════════════════════════
//  层 (b)：现场字节 + GOT 槽 + 重定位（仅 ref/ 存在时）
// ══════════════════════════════════════════════════════════════
const libDir = (() => {
  if (!existsSync('ref')) return null;
  for (const d of readdirSync('ref')) {
    const p = `ref/${d}/V24.58`;
    if (existsSync(p)) return p;
  }
  return null;
})();
const hasRef = !!libDir && existsSync(decompileRel);

if (!hasRef) {
  skipped('(b) 原厂库现场字节与表内 immBytes 逐字节相等', 'ref/ 不存在（干净克隆，已 gitignore）');
  skipped('(b) 跨库候选的 GOT 槽 == .rel.dyn r_offset', 'ref/ 不存在（干净克隆）');
  skipped('(b) 反编译原文逐行核对（坐标层）', 'ref/ 不存在（干净克隆）');
  skipped('(b) 26 个库是只读消费者、1 个库是唯一 setter', 'ref/ 不存在（干净克隆）');
} else {
  const u16 = (b, o) => b.readUInt16LE(o);
  const u32 = (b, o) => b.readUInt32LE(o);

  /** 最小 ELF32 节头解析（只取本例要用的字段）。 */
  function elfSections(b) {
    const shoff = u32(b, 0x20);
    const shentsize = u16(b, 0x2e);
    const shnum = u16(b, 0x30);
    const shstrndx = u16(b, 0x32);
    const secs = [];
    for (let i = 0; i < shnum; i++) {
      const o = shoff + i * shentsize;
      secs.push({
        nameOff: u32(b, o), type: u32(b, o + 4), offset: u32(b, o + 16),
        size: u32(b, o + 20), link: u32(b, o + 24), entsize: u32(b, o + 36),
      });
    }
    const strSec = secs[shstrndx];
    const nameOf = (off) => {
      let e = strSec.offset + off; let s = '';
      while (b[e] !== 0) { s += String.fromCharCode(b[e]); e += 1; }
      return s;
    };
    for (const s of secs) s.name = nameOf(s.nameOff);
    return secs;
  }

  const cacheLib = new Map();
  const libOf = (name) => {
    if (!cacheLib.has(name)) {
      // 包内文件名可能带厂商前缀：按短名解析实际文件，源码不写死前缀
      const direct = `${libDir}/${name}`;
      cacheLib.set(name, readFileSync(existsSync(direct) ? direct : `${libDir}/lib${name}`));
    }
    return cacheLib.get(name);
  };
  const hexOf = (b, off, n) => [...b.subarray(off, off + n)]
    .map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const parseHex = (s) => String(s).trim().toUpperCase().split(/\s+/);

  // ── (b1) 三档 anchor + 全局常量：越界硬失败 + 逐字节相等 ──────────
  const byteBad = [];
  const boundsBad = [];
  let byteChecked = 0;
  const checkBytes = (tag, libName, offHex, wantHex, n) => {
    const b = libOf(libName);
    const off = Number(offHex);
    if (!Number.isFinite(off) || off < 0 || off + n > b.length) {
      boundsBad.push(`${tag}: fileOffset=0x${off.toString(16)} + ${n} > fileSize=0x${b.length.toString(16)}`);
      return;
    }
    byteChecked += 1;
    const got = hexOf(b, off, n);
    if (got !== parseHex(wantHex).join(' ')) byteBad.push(`${tag}: 实得 [${got}] ≠ 表内 [${parseHex(wantHex).join(' ')}]`);
  };
  for (const k of expectedKinds) {
    for (const a of kinds[k].anchors || []) {
      checkBytes(`${k}@${a.insnOffset}`, a.lib, a.fileOffset, a.immBytes, 4);
    }
  }
  const g = data.globalDefault || {};
  checkBytes('globalDefault', g.lib, g.fileOffset, g.bytes, 4);

  ok(`(b) 越界必须先炸：fileOffset + n <= fileSize（禁止 try/catch 静默跳过）`,
    boundsBad.length === 0,
    boundsBad.length ? boundsBad.slice(0, 3).join(' | ')
      : `${byteChecked} 处偏移全在文件内（libCOMM 文件长 0x${libOf(g.lib).length.toString(16)}）`);

  ok(`(b) ${byteChecked} 处偏移的现场字节与表内 immBytes/bytes 逐字节相等（先比字节，再解码）`,
    byteBad.length === 0, byteBad.length ? byteBad.slice(0, 3).join(' | ') : `${byteChecked} 处全对`);

  // ── (b2) 跨库候选：GOT 槽算术 + .rel.dyn 对齐 ─────────────────────
  const candBad = [];
  const candDetail = [];
  for (const c of cands) {
    const b = libOf(c.lib);
    const off = Number(c.offset);
    // ① 字节
    if (off + 4 > b.length) { candBad.push(`${c.lib}@${c.offset} 越界`); continue; }
    const got = hexOf(b, off, 4);
    if (got !== parseHex(c.immBytes).join(' ')) { candBad.push(`${c.lib}@${c.offset} 字节 [${got}] ≠ [${c.immBytes}]`); continue; }
    // ② 复算 GOT 槽：ldr r0,[pc,#imm] 的字面量 + add r0,pc 的 PC 基址
    const ldr = off - 8;
    const hw = u16(b, ldr);
    const litAddr = (((ldr + 4) & ~3) + (hw & 0xff) * 4) >>> 0;
    if (litAddr + 4 > b.length) { candBad.push(`${c.lib}@${c.offset} 字面量越界`); continue; }
    const lit = u32(b, litAddr);
    const slot = (lit + (((off - 2) & ~3))) >>> 0;
    if (slot !== Number(c.relocOffset)) {
      candBad.push(`${c.lib}@${c.offset} 槽 0x${slot.toString(16)} ≠ 表内 reloc ${c.relocOffset}`);
      continue;
    }
    // ③ .rel.dyn：r_offset == slot、r_info&0xff == 21、符号名一致
    const secs = elfSections(b);
    const rel = secs.find((s) => s.name === '.rel.dyn');
    const dynsym = secs.find((s) => s.name === '.dynsym');
    const dynstr = secs.find((s) => s.name === '.dynstr');
    if (!rel || !dynsym || !dynstr) { candBad.push(`${c.lib} 缺 .rel.dyn/.dynsym/.dynstr`); continue; }
    let hit = null;
    for (let i = 0; i < Math.floor(rel.size / 8); i++) {
      const o = rel.offset + i * 8;
      if (u32(b, o) !== slot) continue;
      const rInfo = u32(b, o + 4);
      const symIdx = rInfo >>> 8;
      let e = dynstr.offset + u32(b, dynsym.offset + symIdx * 16);
      let nm = '';
      while (b[e] !== 0) { nm += String.fromCharCode(b[e]); e += 1; }
      hit = { type: rInfo & 0xff, nm };
      break;
    }
    if (!hit) { candBad.push(`${c.lib}@${c.offset} .rel.dyn 里找不到 r_offset=0x${slot.toString(16)}`); continue; }
    if (hit.type !== 21) { candBad.push(`${c.lib}@${c.offset} r_info&0xff=${hit.type} ≠ 21`); continue; }
    if (hit.nm !== c.relocSymbol) { candBad.push(`${c.lib}@${c.offset} 符号=${hit.nm} ≠ ${c.relocSymbol}`); continue; }
    // ④ 同值兄弟偏移也必须是同一串字节（occurrences 的现场计数）
    const sibBad = (c.siblingOffsets || []).filter((so) => {
      const o2 = Number(so);
      return o2 + 4 > b.length || hexOf(b, o2, 4) !== parseHex(c.immBytes).join(' ');
    });
    if (sibBad.length) { candBad.push(`${c.lib} 兄弟偏移字节不符：${sibBad.join(',')}`); continue; }
    candDetail.push(`${c.lib}@${c.offset} slot=0x${slot.toString(16)} reloc=0x${Number(c.relocOffset).toString(16)} type=21 sym=${hit.nm} ×${(c.siblingOffsets || []).length}`);
  }
  ok(`(b) 跨库 ${cands.length} 条候选：字节 → 复算 GOT 槽 → 对齐 .rel.dyn r_offset → r_info&0xff=21，四段全成立`,
    cands.length === 5 && candBad.length === 0,
    candBad.length ? candBad.slice(0, 3).join(' | ') : candDetail.join(' | '));

  // ── (b3) 反编译原文逐行核对（坐标层） ────────────────────────────
  const dlines = readFileSync(decompileRel, 'utf8').split('\n');
  const enclosingFn = (lineNo) => {
    for (let i = lineNo - 1; i >= 0; i--) {
      const m = /^===== FUNC (\S+) @ ([0-9a-fA-F]+) =====/.exec(dlines[i] || '');
      if (m) return { name: m[1], addr: m[2], at: i + 1 };
    }
    return null;
  };
  const lineBad = [];
  let lineChecked = 0;
  for (const k of expectedKinds) {
    for (const ev of (kinds[k].evidence || [])) {
      lineChecked += 1;
      const actual = String(dlines[ev.line - 1] ?? '').trim();
      const fn = enclosingFn(ev.line);
      const val = kinds[k].valueMs;
      const reasons = [];
      if (actual !== ev.lineText) reasons.push(`行原文≠表: ${JSON.stringify(actual)}`);
      if (!actual.includes(`(${val})`)) reasons.push(`行内找不到 (${val})`);
      if (!fn || fn.name !== ev.enclosingFunction) reasons.push(`外层函数=${fn ? fn.name : '?'}≠${ev.enclosingFunction}`);
      if (!fn || fn.addr.toLowerCase().replace(/^0x/, '') !== String(ev.viewFunctionAddress).toLowerCase().replace(/^0x/, '')) {
        reasons.push(`函数地址=${fn ? fn.addr : '?'}≠${ev.viewFunctionAddress}`);
      }
      if (reasons.length) lineBad.push(`${k}@${ev.line}: ${reasons.join(' / ')}`);
    }
  }
  ok(`(b) ${lineChecked} 处调用点逐行核对（原文=表 / 含本档数字 / 外层函数名+地址一致）`,
    lineChecked === 8 && lineBad.length === 0,
    lineBad.length ? lineBad.slice(0, 3).join(' | ') : `${lineChecked} 处全对`);

  const md5 = (p) => execFileSync('md5', ['-q', p], { encoding: 'utf8' }).trim();
  const actualMd5 = md5(`${libDir}/${data.source.lib}`);
  ok('(b) 反编译原文与 .so 同源（MD5 与表内 libMd5 一致，防止拿错版本的反编译当证据）',
    actualMd5 === data.source.libMd5, `实际=${actualMd5} 表内=${data.source.libMd5}`);

  // ── (b4) setter / consumer 形态 ─────────────────────────────────
  const soFiles = readdirSync(libDir).filter((f) => f.endsWith('.so')).map((f) => `${libDir}/${f}`);
  const setters = [];
  const consumers = new Map();
  for (const so of soFiles) {
    let out = '';
    try { out = execFileSync('nm', ['-D', so], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { continue; }
    const ln = out.split('\n').find((l) => /SetCommunicationMaximumWaitTime$/u.test(l.trim()));
    if (!ln) continue;
    const [addr, type] = ln.trim().split(/\s+/);
    // 文件名长短两种形态都收：比对前归一（剥可选 lib 前缀），不改任何真实文件名
    const name = so.split('/').pop().replace(/^lib/, '');
    if (type === 'T') setters.push(name);
    else if (type === 'B') consumers.set(name, '0x' + addr.replace(/^0+/, '').toLowerCase());
  }
  const listed = data.consumers?.libs || {};
  const normKey = (k) => String(k).replace(/^lib/, '');
  const csm = new Map([...consumers].map(([k, v]) => [normKey(k), v]));
  const mismatched = Object.keys(listed).filter((k) => csm.get(normKey(k)) !== String(listed[k]).toLowerCase());
  const missing = Object.keys(listed).filter((k) => !csm.has(normKey(k)));
  ok('(b) 唯一 setter = libCOMM_ABSTRACT_LAYER（T），其余 26 库均为 B（只读消费者）且地址与表一致',
    setters.length === 1 && setters[0] === 'COMM_ABSTRACT_LAYER.so'
    && consumers.size === data.consumers.count && missing.length === 0 && mismatched.length === 0,
    `setters=${JSON.stringify(setters)} consumers=${consumers.size}/${data.consumers.count}`
      + `${missing.length ? ' 缺=' + missing.slice(0, 3).join(',') : ''}`
      + `${mismatched.length ? ' 地址不符=' + mismatched.slice(0, 3).join(',') : ''}`);

  // ── (b5) occurrences：现场字节计数与表内命中清单逐一相等 ──────────
  const occBad = [];
  for (const k of expectedKinds) {
    const o = kinds[k].occurrences || {};
    const want = (o.bytePatternHits || []).map((h) => Number(h));
    if (!want.length) { occBad.push(`${k}: 无 bytePatternHits`); continue; }
    const b = libOf(kinds[k].anchors[0].lib);
    const pat = Buffer.from(parseHex(kinds[k].anchors[0].immBytes).join(''), 'hex');
    const hits = [];
    let i = 0;
    for (;;) {
      const at = b.indexOf(pat, i);
      if (at < 0) break;
      hits.push(at);
      i = at + 1;
    }
    if (JSON.stringify(hits) !== JSON.stringify(want)) {
      occBad.push(`${k}: 现场命中 ${JSON.stringify(hits.map((x) => '0x' + x.toString(16)))}`
        + ` ≠ 表内 ${JSON.stringify(o.bytePatternHits)}`);
    }
  }
  ok('(b) occurrences 现场计数 == 表内 bytePatternHits（同一值在多个初始化分支重复出现，去重后仍可复算）',
    occBad.length === 0, occBad.length ? occBad.slice(0, 2).join(' | ')
      : expectedKinds.map((k) => `${k}×${(kinds[k].occurrences.bytePatternHits || []).length}`).join(' / '));
}

console.log(`\n===== ${NAME}: ${pass} passed / ${fail} failed / ${skip} skipped =====`);
process.exit(fail ? 1 : 0);
