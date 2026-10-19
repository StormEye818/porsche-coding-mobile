#!/usr/bin/env node
/**
 * DRIVELINKS 覆盖率复核（可复跑，口径唯一）。
 *
 * 跑法: node tools/coverage.mjs
 *
 * ⚠️ 口径纪律（2026-10-18 踩过）：
 *    只看「有没有抛异常」会把 **341 条「原厂 stdSeedKey 无 case」** 算成已收编，
 *    覆盖率虚高到 98%。那 341 条是「本来不需要发 key」，**不是算法已逆出**。
 *    必须按 `needsKey` 分三类：
 *      real   有算法，能算出真 key
 *      noAlgo 原厂 该 mode 没有 case → 不需要发 key（ECU 回非零 seed 时拒写）
 *      threw  算法还没逆出来 / 刻意拒写 → 拒写
 */
import { readFileSync } from 'node:fs';
import { resolveKey } from '../src/seedkey-resolver.js';

const dl = JSON.parse(readFileSync(new URL('../data/drivelinks.json', import.meta.url), 'utf8'));

const buckets = { real: 0, noAlgo: 0, threw: 0 };
const noAlgoModes = new Set();
const threwModes = new Map();
const badEcu = new Set();
let tot = 0;

for (const [ecu, arr] of Object.entries(dl.ecu)) {
  let ecuOk = true;
  for (const r of arr) {
    tot++;
    try {
      const x = resolveKey(r.m, 0x12345678);
      if (x.needsKey === false) { buckets.noAlgo++; noAlgoModes.add(r.m); }
      else buckets.real++;
    } catch (e) {
      buckets.threw++;
      ecuOk = false;
      threwModes.set(r.m, (threwModes.get(r.m) || 0) + 1);
    }
  }
  if (!ecuOk) badEcu.add(ecu);
}

const pct = (n) => (n / tot * 100).toFixed(1) + '%';
console.log('DRIVELINKS 记录总数        ', tot, ` (ECU ${Object.keys(dl.ecu).length})`);
console.log('  真·有算法（能发 key）    ', buckets.real, pct(buckets.real));
console.log('  原厂无 case（不需 key）  ', buckets.noAlgo, pct(buckets.noAlgo));
console.log('  拒写（未逆出 / 刻意）    ', buckets.threw, pct(buckets.threw));
console.log();
console.log('拒写 mode:');
for (const [m, n] of [...threwModes.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  0x${m.toString(16).padStart(2, '0')}  ${n} 条`);
}
console.log();
console.log('未全覆盖的 ECU:', badEcu.size, [...badEcu].slice(0, 20).join(' '));
console.log();
console.log('无 case mode 数:', noAlgoModes.size,
  [...noAlgoModes].sort((a, b) => a - b).map((m) => '0x' + m.toString(16)).join(' '));
