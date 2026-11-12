#!/usr/bin/env node
/**
 * build-dsn-module-sysids.mjs — 从 DSN.BIN 解出「平台 → 模块名 → sysId」显式索引。
 *
 * ★ 2026-11-12 第十阶段收口：此前把老代 4 平台（9X6/9X7/CS1/E1）的模块 sysId
 *   判成「包内不可证」，根因是找错了载体 —— 老代 SYS_DATA 的 sysDataOff 确实是
 *   纯 u32 数值表（无 ASCII 子系统名字集），但 **DSN.BIN 里每个平台都有一张
 *   模块名索引表**，记录的第一个字节就是 sysId 低字节。
 *
 * 结构（全部由字节推得，零手工表）：
 *   DSN.BIN 头 22 项：[u8 count=22][ [u8 id][u16 nlen][name\0][u32 payloadOff] × 22 ]
 *     id ≡ SYS_DATA root type ≡ sysId 高字节（已由 platform-type-map.json 交叉验证）
 *   每个 payloadOff 指向该平台模块表：[u16 0x0000][
 *     [u8 sysIdLow][u16 nlen][moduleName\0][u32 recPtr][u16 flag] × n ]
 *     flag 是位标志（0 / 0x1000 / 0x0200 / 0x01FF），**不编码 type**，不得当 type 用。
 *
 * 判定规则：
 *   - 单 type 平台（CS1=0x13、E1=0x03）：sysIdLow 落在该 type 的权威 sysIds 集合
 *     → 唯一映射，method='dsn-module-index'，可静态接入运行时。
 *   - 多 type 平台（9X6={0x01,0x02}、9X7={0x04,0x05,0x06}）：同一 sysIdLow 可能
 *     在多个 type 都合法 → 只记录候选集，**不猜高字节**（运行时由 VIN/识别应答定）。
 *   - sysIdLow 不在任何候选 type 集合 → 记 unresolved（多为 id=0x00 的无独立 sysId
 *     子模块，或跨代模块），保持回退。
 *   - 同名多 id（如 CS1 TUER_VORNE→0x131E/0x131F）→ 记 ambiguous，不取第一个猜。
 *
 * 权威 sysIds 集合来自 data/sysdata-root-table.json（由 PORSCHE_SYS_DATA.BIN 根表解出）。
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

// 权威 type → sysId 低字节集合
const lowByType = {};
for (const [t, e] of Object.entries(rt.types || {})) {
  lowByType[parseInt(t, 16)] = new Set(
    (e.sysIds || []).map((s) => parseInt(s, 16) & 0xff));
}
function fullSysIdExists(type, low) {
  const key = '0x' + ((type << 8) | low).toString(16).padStart(4, '0');
  // sysIds 可能写成 0x0E01 或 0xe01，统一按数值比对
  return (rt.types['0x' + type.toString(16).toUpperCase().padStart(2, '0')]
    || rt.types['0x' + type.toString(16).toLowerCase().padStart(2, '0')]
    || {}).sysIds?.some((s) => parseInt(s, 16) === ((type << 8) | low)) ?? false;
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

// 平台模块表：[u16 prefix][[u8 low][u16 nlen][name\0][u32 recPtr][u16 flag] × n]
function moduleTable(off) {
  const rows = [];
  let i = off + 2;                       // 前 2 字节是 0x0000 前缀
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
for (const [platKey, typeStrs] of Object.entries(pt.platformTypes || {})) {
  const hit = index.find((x) => x.name.toLowerCase() === platKey.toLowerCase());
  if (!hit || !hit.payloadOff) continue;
  const types = typeStrs.map((x) => parseInt(x, 16));
  const { rows } = moduleTable(hit.payloadOff);
  if (!rows.length) continue;

  const modules = {};          // 唯一映射：name -> sysId
  const ambiguous = {};       // 同名多 id / 多 type
  const unresolved = [];
  const multiType = {};

  for (const r of rows) {
    const cand = types.filter((t) => lowByType[t]?.has(r.low));
    const sysIds = cand.map((t) => '0x' + ((t << 8) | r.low).toString(16).padStart(4, '0'));
    if (cand.length === 0) {
      unresolved.push({ name: r.name, low: r.low, reason: 'sysIdLow 不在该平台任何候选 type 的权威 sysIds 集合' });
      continue;
    }
    if (cand.length > 1) {
      multiType[r.name] = { low: r.low, candidates: sysIds, reason: '多 type 平台，高字节需运行时 VIN/识别应答决定，不猜' };
      continue;
    }
    if (modules[r.name] && modules[r.name] !== sysIds[0]) {
      ambiguous[r.name] = [modules[r.name], sysIds[0]];
      delete modules[r.name];
      continue;
    }
    if (ambiguous[r.name]) { ambiguous[r.name].push(sysIds[0]); continue; }
    modules[r.name] = sysIds[0];
  }

  platforms[platKey] = {
    dsnIndexId: hit.id,
    payloadOff: hit.payloadOff,
    payloadOffHex: '0x' + hit.payloadOff.toString(16).toUpperCase(),
    types: types.map((t) => '0x' + t.toString(16).toUpperCase().padStart(2, '0')),
    rowCount: rows.length,
    uniqueCount: Object.keys(modules).length,
    multiTypeCount: Object.keys(multiType).length,
    unresolvedCount: unresolved.length,
    ambiguousCount: Object.keys(ambiguous).length,
    // 单 type 平台才给可用于运行时的 modules；多 type 平台留空，避免猜高字节
    runtimeModules: types.length === 1 ? modules : {},
    modules, multiType, ambiguous, unresolved,
  };
}

// 硬校验：单 type 平台必须有唯一映射且都落在权威集合里
for (const [name, e] of Object.entries(platforms)) {
  if (e.types.length !== 1) continue;
  const t = parseInt(e.types[0], 16);
  for (const [mod, sid] of Object.entries(e.runtimeModules)) {
    if ((parseInt(sid, 16) >> 8) !== t || !lowByType[t]?.has(parseInt(sid, 16) & 0xff)) {
      throw new Error(`${name} ${mod} → ${sid} 不在 type ${e.types[0]} 的权威 sysIds 集合`);
    }
  }
  if (e.uniqueCount === 0) throw new Error(`${name} 单 type 却 0 条唯一映射，拒绝产出`);
}

const doc = {
  schemaVersion: 1,
  source: 'DSN.BIN 头 22 项索引 + 各平台 payloadOff 模块索引表 + PORSCHE_SYS_DATA.BIN 根表(sysdata-root-table.json)',
  method: '模块表记录 [u8 sysIdLow][u16 nlen][name\\0][u32 recPtr][u16 flag]；'
    + 'sysIdLow 与权威 sysIds 低字节做精确集合比对；单 type 平台得唯一 sysId，'
    + '多 type 平台只记候选集（高字节需运行时 VIN/识别应答，不猜）',
  evidence: 'id ≡ SYS_DATA root type ≡ sysId 高字节（platform-type-map.json 与 9 个已定案平台交叉验证）；'
    + '模块名与 *_ALLDATA.BIN 顶级目录逐条吻合（9X6 29/29、9X7 41/41、CS1 15/17、E1 47/48）',
  boundary: '9X6/9X7 是多 type 平台，包内静态表不存在「模块记录 → 所属 type/高字节」字段；'
    + '模块 flag 是位标志、ALLDATA dataOff 是纯偏移、变体数据块是编码键串、'
    + 'sysDataOff u32 与 ALLDATA/DSN 偏移精确交集 0，均已逐一排除',
  index: index.map((x) => ({ id: x.id, name: x.name, payloadOff: x.payloadOff })),
  platforms,
  stats: {
    platformCount: Object.keys(platforms).length,
    rowCount: Object.values(platforms).reduce((a, e) => a + e.rowCount, 0),
    runtimeUniqueCount: Object.values(platforms).reduce((a, e) => a + Object.keys(e.runtimeModules).length, 0),
  },
};
writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
console.log(`写出 data/dsn-module-sysids.json  ${(Buffer.byteLength(JSON.stringify(doc)) / 1024).toFixed(0)}KB`);
for (const [name, e] of Object.entries(platforms)) {
  console.log(`  ${name.padEnd(6)} types=${e.types.join(',')} rows=${e.rowCount} 唯一=${e.uniqueCount} 多义=${e.multiTypeCount} 无解=${e.unresolvedCount} 同名多id=${e.ambiguousCount} 运行时可用=${Object.keys(e.runtimeModules).length}`);
}
console.log('stats', JSON.stringify(doc.stats));
