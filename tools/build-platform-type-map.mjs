#!/usr/bin/env node
/**
 * build-platform-type-map.mjs — 落地「车型平台 → SYS_DATA type(代际)」的显式链接表。
 *
 * 背景（2026-11-12 全量收口）：上一阶段把 9X6/9X7/CS1/E1 判为「结构性不可证」，
 * 理由是 ALLDATA 变体名与 type 子系统名字集交集平票/零交集。复核发现根因不是「包里没有」，
 * 而是**找错了载体**：老代 type 0x01-0x0A 的 sysDataOff 是 u32 数值表（无 ASCII 名字），
 * 名字投票当然永远平票；显式链接在 DSN.BIN 的 22 项索引里。
 *
 * DSN.BIN 头结构（本工具实测解析，可复现）：
 *   @0x0    [u8 count = 22]
 *   @0x1    起连续 22 条变长记录：`[u8 id][u8 nameLen][u8 0][name\0 × nameLen][u32 payloadOff]`
 *           id 严格 1..22；payloadOff 指向该代的数据区。
 *   实测：id=1→"9x6"(0x3A5EF)、id=3→"E1"(0x328EC)、id=13/14→"9x1"(0x19B8C)、
 *         id=17→"E3"(0x4A185)、id=20→"992"(0x735CA)、id=21→"J1"(0x89F77)、id=22→"G3"(0x94FE2)…
 *
 * 交叉校验（本工具每次运行都做）：
 *   data/sysdata-comm.json 的 22 个 type 严格是 0x01..0x16，即
 *   **id ≡ SYS_DATA root type ≡ comm 子表 sysId 高字节**。
 *   已定案平台全部吻合（9X1→0x0E、918S→0x10、CAJUN→0x0F、E2→0x0B、G1→0x0C、
 *   G2→0x12、992→0x14、J1→0x15、G3→0x16）；唯一分歧是 E3（索引 0x11 / 运行时 0x12）。
 *
 * 产物：data/platform-type-map.json
 * 用法：node tools/build-platform-type-map.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSN = '/Users/se818/porsche-mapper/ref/decoded/DSN.BIN';
const COMM = path.join(ROOT, 'data', 'sysdata-comm.json');
const ALL = path.join(ROOT, 'data', 'all-model-sysids.json');
const OUT = path.join(ROOT, 'data', 'platform-type-map.json');

const b = fs.readFileSync(DSN);
const count = b[0];
if (count !== 22) throw new Error(`DSN 头索引数应为 22，实得 ${count}`);

const index = [];
let p = 1;
for (let i = 0; i < count; i++) {
  const id = b[p], len = b[p + 1], zero = b[p + 2];
  if (id !== i + 1 || zero !== 0 || len < 2 || len > 40 || p + 3 + len + 4 > b.length) {
    throw new Error(`DSN 索引第 ${i + 1} 条格式异常 @0x${p.toString(16)}：`
      + `id=${id} len=${len} zero=${zero}`);
  }
  const raw = b.subarray(p + 3, p + 3 + len);
  if (raw[len - 1] !== 0) throw new Error(`DSN 索引第 ${i + 1} 条名字未以 0 结尾`);
  const name = raw.subarray(0, len - 1).toString('latin1');
  const off = b.readUInt32LE(p + 3 + len);
  index.push({
    id,
    type: `0x${id.toString(16).toUpperCase().padStart(2, '0')}`,
    sysIdHighByte: `0x${id.toString(16).toUpperCase().padStart(2, '0')}`,
    platformName: name,
    payloadOff: `0x${off.toString(16).toUpperCase()}`,
    recordOff: `0x${p.toString(16).toUpperCase()}`,
  });
  p += 3 + len + 4;
}

// 与 comm 子表的 22 个 type 交叉校验：id ≡ type ≡ sysId 高字节。
const comm = JSON.parse(fs.readFileSync(COMM, 'utf8'));
const types = [...new Set(Object.values(comm.ecu).map((e) => e.type))].sort();
const typeNums = types.map((t) => Number.parseInt(t, 16));
if (!(types.length === 22 && typeNums.every((n, i) => n === i + 1))) {
  throw new Error(`SYS_DATA 22 个 type 与 DSN 索引 id 1..22 不对应：${types.join(' ')}`);
}

// 平台 → type 集（同名平台可占多个 type，即一个平台覆盖多代车型目录）。
const byPlatform = {};
for (const e of index) {
  if (!e.platformName || e.platformName === '0') continue;
  (byPlatform[e.platformName] ||= []).push(e.type);
}

// 4 个此前未定案平台的定案结果。
const pending = ['9X6', '9X7', 'CS1', 'E1'];
const resolved = {};
for (const plat of pending) {
  const key = Object.keys(byPlatform).find((k) => k.toLowerCase() === plat.toLowerCase());
  const tset = key ? byPlatform[key] : [];
  resolved[plat] = tset.length
    ? {
        types: tset,
        gen: tset.length === 1 ? tset[0].toLowerCase() : null,
        status: tset.length === 1 ? 'unique' : 'multi-type',
        basis: key ? `DSN 索引 "${key}" → type ${tset.join('/')}` : 'DSN 索引未命中',
      }
    : { types: [], gen: null, status: 'missing', basis: 'DSN 索引未命中' };
}

// 已定案平台逐项核对（找出索引层与运行时 gen 的分歧）。
const all = JSON.parse(fs.readFileSync(ALL, 'utf8'));
const agreement = [], divergence = [];
for (const [plat, info] of Object.entries(all.platforms || {})) {
  if (!info.gen) continue;
  const typesForPlat = byPlatform[plat.toLowerCase()]
    || byPlatform[Object.keys(byPlatform).find((k) => k.toLowerCase() === plat.toLowerCase())] || [];
  if (!typesForPlat.length) continue;
  if (typesForPlat.some((t) => Number.parseInt(t, 16) === Number.parseInt(info.gen, 16))) {
    agreement.push({ platform: plat, gen: info.gen });
  } else {
    divergence.push({ platform: plat, runtimeGen: info.gen, indexTypes: typesForPlat });
  }
}

const doc = {
  schemaVersion: 1,
  source: 'DSN.BIN 头 22 项索引(@0x1 起连续变长记录) + PORSCHE_SYS_DATA.BIN 根表 22 项 + sysdata-comm.json',
  evidence: 'id ≡ SYS_DATA root type ≡ comm 子表 sysId 高字节；22 个 type 严格等于 0x01..0x16',
  dsnLayout: '@0x0 [u8 count=22]；@0x1 起每条 [u8 id][u8 nameLen][u8 0][name\\0 × nameLen][u32 payloadOff]',
  verification: { commTypes: types, idSequence: '1..22', checked: true },
  index,
  platformTypes: byPlatform,
  resolvedPendingPlatforms: resolved,
  agreementWithRuntime: agreement,
  divergenceWithRuntime: divergence,
  boundary: '代际已定 ≠ 模块 sysId 已定：老代 0x01-0x0A 的 sysDataOff 是 u32 数值表而非 ASCII 名字表，'
    + '9X6/9X7 的 ALLDATA 系统名仍无法按 name-9 投票解析到 sysId，'
    + '因此运行时继续走全局表回退（apply=false），不猜模块地址。',
  e3Note: 'DSN 索引把 E3 列为 type 0x11，但运行时 E3 的 84 个模块 sysId 全为 0x12xx 且与 '
    + '0x12 名字集精确交集。索引层（车型目录）与 comm 子表层（模块映射）是两类证据：'
    + '运行时沿用 0x12 以保持模块映射一致，不覆盖已验收结果。',
};

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`写出 data/platform-type-map.json：${index.length} 条索引 / `
  + `${Object.keys(byPlatform).length} 个平台 / 22 type 与 id 校验通过`);
console.log('索引与运行时已定案平台一致：', agreement.length, '项；分歧：', JSON.stringify(divergence));
for (const [p, v] of Object.entries(resolved)) {
  console.log(`  ${p} → ${v.types.join('/') || '未命中'} / ${v.status} / gen=${v.gen ?? '—'}`);
}
