#!/usr/bin/env node
/**
 * audit-address-join.mjs — 地址 join 体检（只读，不产出线上数据）
 *
 * 回答一个问题：`data/ecu-addresses.json` 里「模块 → 候选地址」是不是**模块唯一**的？
 *   - 若两个 sysId 的候选列表逐条相同 → 该 join 用的是「组键」，不是模块键（2026-11-10 发现的 IC/PSM 同表）
 *   - 若某模块的真地址不候选里（DME 0x7E0 为实车已证）→ join 坐标系错位
 *
 * 用法: node tools/audit-address-join.mjs [--json]
 */
import { readFileSync } from 'node:fs';

const addr = JSON.parse(readFileSync(new URL('../data/ecu-addresses.json', import.meta.url), 'utf8'));
const entries = addr.entries || [];
const asJson = process.argv.includes('--json');

const keyOf = (e) => (e.cands || []).map((c) => String(c.tx).toUpperCase()).sort().join(',');

// ① 候选列表完全相同 → 组键合并
const byKey = new Map();
for (const e of entries) {
  const k = keyOf(e);
  if (!k) continue;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(e);
}
const groups = [...byKey.entries()].filter(([, v]) => v.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

// ② 已知真地址是否落在自己的候选里（实车/锚点）
const ANCHORS = [
  { sysId: '0x0b01', can: 0x7e0, why: 'DME 读 VIN 已通' },
  { sysId: '0x0b13', can: 0x7d0, why: 'PASM 锚点' },
];

const report = {
  entries: entries.length,
  withCands: entries.filter((e) => (e.cands || []).length).length,
  empty: entries.filter((e) => !(e.cands || []).length).length,
  identicalGroups: groups.length,
  modulesInIdenticalGroups: groups.reduce((n, [, v]) => n + v.length, 0),
  anchors: ANCHORS.map((a) => {
    const e = entries.find((x) => x.sysId.toLowerCase() === a.sysId);
    const has = !!(e && (e.cands || []).some((c) => parseInt(c.tx, 16) === a.can));
    return { ...a, found: has };
  }),
};

if (asJson) {
  console.log(JSON.stringify({ ...report, groups: groups.map(([k, v]) => ({ cands: k, sysIds: v.map((x) => x.sysId) })) }, null, 1));
  process.exit(0);
}

console.log('地址 join 体检');
console.log(`  条目 ${report.entries} · 有候选 ${report.withCands} · 空候选 ${report.empty}`);
console.log(`  候选完全相同的组 ${report.identicalGroups} 组，涉及 ${report.modulesInIdenticalGroups} 个模块`);
for (const [k, v] of groups.slice(0, 6)) {
  console.log(`   · ${v.map((x) => x.sysId).join(' / ')}  →  ${k.split(',').length} 个候选全同`);
}
console.log('  锚点自检:');
for (const a of report.anchors) {
  console.log(`   · ${a.sysId} 真地址 0x${a.can.toString(16).toUpperCase()}（${a.why}）`
    + (a.found ? ' → 在候选里 ✅' : ' → 不在候选里 ❌（join 坐标系错位）'));
}
console.log('\n判定：锚点有 ❌ 或 同组模块 >1 → 地址不能按模块唯一确定，需换表（见 ANSWERS-20261110.md §1.4）');
