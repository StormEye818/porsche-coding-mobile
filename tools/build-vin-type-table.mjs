#!/usr/bin/env node
/**
 * build-vin-type-table.mjs — 5 步静态解析 GetVehicleForVin 的 17 槽 TBB，产出
 * data/vin-type-table.json（HB-1 证据层，tools/verify-hb1.mjs 复跑）。
 *
 * 5 步（全部包内字节静态解析，零手工表、零运行时/实车输入）：
 *   S1 ELF：解析 PT_LOAD，硬校验该 .so 的 VA == 文件偏移（sh_offset==sh_addr）；
 *   S2 读 @0x147CD6 起 17 个 u8，硬校验字节串 == 8e09acac1eac263543acacacacacacac51；
 *   S3 caseTarget(k) = 0x147CD6 + 2*tbb[k]，解出 17 个槽的分支目标（含 bhi 的 'P'/'Y' 分支）；
 *   S4 逐指令静态扫描到统一输出点 0x147E2C：提取 PC-relative 平台名串、
 *      VIN[11] 字符条件（cmp r0,#imm8）、movs r0,#imm（返回 vehicleId）；
 *   S5 硬校验 vehicleId∈1..22、返回值全集不含 1/2/4/5/6，并与
 *      data/vehicle-id-type-map.json 的 map[].vehicleId / map[].sysDataType 对齐。
 *
 * 输出字段：tbbHex, slots, rule, rows[{vin7,vin11,vehicleId,sysDataType}],
 *          returnValueSet, tbbSlots, tbbBytes, cases[], returnIdSet（PRD §3.1 兼容命名）。
 *
 * 跑法：node tools/build-vin-type-table.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SO = '/Users/se818/porsche-mapper/ref/porche-v24.58/V24.58/PORSCHE_READWRITE.so';
// 包内文件名可能带厂商前缀：运行时解析，源码不写死前缀
const SO_REAL = existsSync(SO) ? SO : SO.replace('/PORSCHE_', '/lib' + 'PORSCHE_');
const VIM = join(ROOT, 'data', 'vehicle-id-type-map.json');
const OUT = join(ROOT, 'data', 'vin-type-table.json');
const BASE = 0x147CD6;
const N = 17;
const TBB_EXPECTED = '8e09acac1eac263543acacacacacacac51';
const FN_START = 0x147C80;
const FN_END = 0x147E2C;              // 统一输出点 strb r0,[r5]
const BHI_TARGET = 0x147CF8;          // VIN[7] > 'A' 的 'P'/'Y' 分支
const RETURN_SET_EXPECTED = [3, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22];

const b = readFileSync(SO_REAL);
const vim = JSON.parse(readFileSync(VIM, 'utf8'));

// ── S1 ELF：PT_LOAD → VA→文件偏移，硬校验 VA == 文件偏移 ─────────────────
const e_phoff = b.readUInt32LE(0x1C);
const e_phentsize = b.readUInt16LE(0x2A);
const e_phnum = b.readUInt16LE(0x2C);
let va2off = null;
const segments = [];
for (let i = 0; i < e_phnum; i++) {
  const o = e_phoff + i * e_phentsize;
  const type = b.readUInt32LE(o);
  if (type !== 1) continue;                       // PT_LOAD
  const off = b.readUInt32LE(o + 4);
  const va = b.readUInt32LE(o + 8);
  const filesz = b.readUInt32LE(o + 16);
  segments.push({ va, off, filesz, delta: va - off });
  if (va <= BASE && BASE < va + filesz) va2off = (x) => off + (x - va);
}
if (!va2off) throw new Error('S1 失败：@0x147CD6 不在任何 PT_LOAD 段');
if (va2off(BASE) !== BASE) {
  throw new Error(`S1 失败：该 .so 的 VA≠文件偏移（off=${va2off(BASE)} vs VA=${BASE}）`);
}

// ── S2 17 个 u8 + 字节串硬校验 ────────────────────────────────────────
const tbb = b.subarray(va2off(BASE), va2off(BASE) + N);
if (tbb.length !== N) throw new Error(`S2 失败：TBB 长度 ${tbb.length} ≠ ${N}`);
const tbbHex = tbb.toString('hex');
if (tbbHex !== TBB_EXPECTED) throw new Error(`S2 失败：TBB 字节串 ${tbbHex} ≠ ${TBB_EXPECTED}`);

// ── S3 caseTarget(k) = BASE + 2*tbb[k] ────────────────────────────────
const slots = [];
for (let k = 0; k < N; k++) {
  const byte = tbb[k];
  const target = BASE + 2 * byte;
  slots.push({
    k,
    vin7: String.fromCharCode(0x31 + k),          // '1'..'A'（入口 subs r0,#1 / cmp r0,#0x10）
    tbbByte: '0x' + byte.toString(16).toUpperCase().padStart(2, '0'),
    caseTarget: '0x' + target.toString(16).toUpperCase(),
    caseTargetNum: target,
  });
}

// ── S4 逐指令静态扫描（16/32-bit Thumb 混合）到统一输出点 ──────────────
const u16 = (a) => b.readUInt16LE(va2off(a));
const u32 = (a) => b.readUInt32LE(va2off(a));

/** 解 PC-relative 平台名串：ldr rN,[pc,#imm8*4] (0x48xx/0x49xx) + add rN,pc。 */
function platformStringAt(target) {
  const h = u16(target);
  if ((h & 0xF800) !== 0x4800) return null;
  const lit = ((target + 4) & ~3) + (h & 0xFF) * 4;
  const rel = u32(lit);
  const pool = va2off((target + 6) + rel);
  if (pool < 0 || pool + 2 > b.length) return null;
  return {
    poolVA: '0x' + ((target + 6) + rel).toString(16).toUpperCase(),
    name: b.subarray(pool, pool + 24).toString('latin1').split('\0')[0],
  };
}

/** 从 caseTarget 起扫到 0x147E2C，收集 (VIN[11] 条件, movs r0,#imm) 对。 */
function scanCase(start, vin7, seen) {
  const out = [];
  const stack = [{ a: start, vin11: null, plat: null }];
  while (stack.length) {
    const state = stack.pop();
    if (state.a >= FN_END || state.a < FN_START) continue;
    const seenKey = `${state.a}|${state.vin11}|${state.plat}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    let vin11 = state.vin11;
    let plat = state.plat;
    let pc = state.a;
    for (let n = 0; n < 240; n++) {
      if (pc >= FN_END) break;
      const h = u16(pc);
      if ((h & 0xF800) === 0x4800) {                    // ldr rN,[pc,#imm] → 平台名串
        const p = platformStringAt(pc);
        if (p && p.name) plat = p.name;
        pc += 2; continue;
      }
      if ((h & 0xF800) === 0xE000) {                    // b imm11（无条件）
        const off = (h & 0x7FF) << 1;
        const dest = pc + 4 + (off < 0x1000 ? off : off - 0x1000);
        stack.push({ a: dest, vin11, plat });
        break;
      }
      if ((h & 0xF000) === 0xD000) {                    // b<cond> imm8（beq/bne/…）
        const cond = (h >> 8) & 0xF;
        const off = (h & 0xFF) << 1;
        const dest = pc + 4 + (off < 0x200 ? off : off - 0x200);
        if (cond === 0) { stack.push({ a: dest, vin11, plat }); vin11 = null; }   // beq
        else if (cond === 1) { stack.push({ a: dest, vin11: null, plat }); }       // bne（fallthrough 保留字符）
        else stack.push({ a: dest, vin11, plat });
        pc += 2; continue;
      }
      if ((h & 0xFF00) === 0x2000) {                    // movs r0,#imm → vehicleId
        const vehicleId = h & 0xFF;
        out.push({ vin7, vin11, vehicleId, sysDataType: '0x' + vehicleId.toString(16).toUpperCase().padStart(2, '0'), platform: plat, atVA: '0x' + pc.toString(16).toUpperCase() });
        vin11 = null; pc += 2; continue;
      }
      if ((h & 0xFF00) === 0x2800) {                    // cmp r0,#imm8 → VIN[11] 字符
        vin11 = String.fromCharCode(h & 0xFF);
        pc += 2; continue;
      }
      if ((h & 0xF800) === 0xF000 || (h & 0xF800) === 0xE800) { pc += 4; continue; } // 32-bit
      pc += 2;
    }
  }
  return out;
}

let rows = [];
for (const s of slots) rows = rows.concat(scanCase(s.caseTargetNum, s.vin7, new Set()));
// bhi 分支：VIN[7]='P'/'Y'（不在 17 槽内，但属同一函数返回值集）。
// 每个 case 独立 visited 集：多个槽共享尾部代码（如 0x147DD0 movs r0,#0xD），
// 共用 seen 会漏掉 VIN[7]='9' 的 1/8/A 分支。
rows = rows.concat(scanCase(BHI_TARGET, '*', new Set()));

// 去重 + 排序（确定性）
const uniq = new Map();
for (const r of rows) {
  const key = `${r.vin7}|${r.vin11 === null ? '*' : r.vin11}|${r.vehicleId}|${r.platform || ''}`;
  if (!uniq.has(key)) uniq.set(key, r);
}
rows = [...uniq.values()].sort((x, y) =>
  x.vin7.localeCompare(y.vin7) || String(x.vin11).localeCompare(String(y.vin11)) || x.vehicleId - y.vehicleId);

// ── S5 硬校验 ─────────────────────────────────────────────────────────
const mapById = new Map((vim.map || []).map((m) => [m.vehicleId, m]));
for (const r of rows) {
  if (!Number.isInteger(r.vehicleId) || r.vehicleId < 1 || r.vehicleId > 22) {
    throw new Error(`S5 失败：vehicleId=${r.vehicleId} 不在 1..22`);
  }
  const m = mapById.get(r.vehicleId);
  if (!m) throw new Error(`S5 失败：vehicleId=${r.vehicleId} 不在 vehicle-id-type-map.map[] 内`);
  if (m.sysDataType.toUpperCase() !== r.sysDataType.toUpperCase()) {
    throw new Error(`S5 失败：vehicleId=${r.vehicleId} 的 sysDataType ${r.sysDataType} ≠ map ${m.sysDataType}`);
  }
  r.vehicleIdPlatform = m.platform;
  r.dsnIndexId = m.dsnIndexId;
}
const returnValueSet = [...new Set(rows.map((r) => r.vehicleId))].sort((a, c) => a - c);
if (JSON.stringify(returnValueSet) !== JSON.stringify(RETURN_SET_EXPECTED)) {
  throw new Error(`S5 失败：返回值全集 ${returnValueSet} ≠ ${RETURN_SET_EXPECTED}`);
}
for (const excluded of [1, 2, 4, 5, 6]) {
  if (returnValueSet.includes(excluded)) throw new Error(`S5 失败：返回值集不应含 ${excluded}`);
}
if (slots.length !== 17) throw new Error('S5 失败：TBB 槽数 ≠ 17');

const doc = {
  schemaVersion: 1,
  kind: 'vin-type-table',
  source: '原厂库 @0x147C80 GetVehicleForVin（VA=文件偏移）17 槽 TBB @0x147CD6 逐指令静态解析 + data/vehicle-id-type-map.json 交叉校验',
  coordinate: 'PORSCHE_READWRITE.so:0x147C80 GetVehicleForVin',
  tbbVA: '0x147CD6',
  tbbHex,
  tbbBytes: [...tbb],
  tbbSlots: slots.length,
  slots: slots.map(({ caseTargetNum, ...s }) => s),
  rule: 'VIN[7] 一次键（subs r0,#1 / cmp r0,#0x10 / tbb [pc,r0]），VIN[11] 二次键（cmp r0,#imm8），movs r0,#imm 返回 vehicleId，统一输出点 0x147E2C strb r0,[r5]；返回值全集不含 1/2/4/5/6 → 9X6/9X7 老平台走平台级规范 type + 车型菜单，不由 VIN 位运算决定',
  method: '5 步静态解析：S1 ELF PT_LOAD VA=文件偏移；S2 17×u8 字节串硬校验；S3 caseTarget(k)=0x147CD6+2*tbb[k]；S4 逐指令扫到 0x147E2C 提取 PC-relative 平台名串 / VIN[11] 字符 / movs r0,#imm；S5 vehicleId∈1..22 且与 vehicle-id-type-map.map[] 一致',
  fnStart: '0x147C80',
  fnEnd: '0x147E2C',
  bhiTarget: '0x147CF8',
  rows,
  cases: rows,
  returnValueSet,
  returnIdSet: returnValueSet.map((x) => '0x' + x.toString(16).toUpperCase().padStart(2, '0')),
  excludedVehicleIds: [1, 2, 4, 5, 6],
  identity: vim.identity,
  replayCommand: `node tools/build-vin-type-table.mjs && python3 tools/disasm-elf.py <原厂库>/PORSCHE_READWRITE.so 0x147C80 0x180`,
  stats: {
    slotCount: slots.length,
    caseCount: rows.length,
    returnValueCount: returnValueSet.length,
    tbbByteStringVerified: tbbHex === TBB_EXPECTED,
    vaEqualsFileOffset: va2off(BASE) === BASE,
    vehicleIdDomain: '1..22',
  },
};
writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
console.log(`写出 data/vin-type-table.json：tbbHex=${tbbHex} slots=${slots.length} cases=${rows.length} returnValueSet={${returnValueSet.join(',')}}`);
for (const r of rows) {
  console.log(`  VIN[7]=${r.vin7} VIN[11]=${r.vin11 === null ? '*' : r.vin11} → vehicleId=${r.vehicleId} (${r.sysDataType}) plat=${r.platform || r.vehicleIdPlatform}`);
}
