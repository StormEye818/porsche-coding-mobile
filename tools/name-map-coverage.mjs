#!/usr/bin/env node
/**
 * name-map（SPECF 名字表）覆盖率复核 —— 与 tools/coverage.mjs（DRIVELINKS，按 mode）
 * 互补：**这一路是按「变体名」走的**（`ASAM_seedkey_xxx` → 变体 ID → computeVariantKey）。
 *
 * 跑法: node tools/name-map-coverage.mjs
 *
 * 三分类（口径同 coverage.mjs，别把「不抛异常」当有算法）：
 *   real   有算法，能算出真 key
 *   empty  原厂该函数是**空壳**（EMPTY，outlen=0）—— 本来就不发 key
 *   threw  还没逆出来 / 拒写
 */
import { NAME_TO_VARIANT } from '../src/seedkey-name-map.js';
import { computeVariantKey } from '../src/seedkey-registry.js';

const ids = [...new Set(Object.values(NAME_TO_VARIANT))];
const buckets = { real: 0, empty: 0, threw: 0 };
const bad = [];
const empties = [];

for (const id of ids) {
  try {
    const r = computeVariantKey(id, Uint8Array.of(0x12, 0x34, 0x56, 0x78));
    if (r.outlen === 0 || r.algo === 'EMPTY') { buckets.empty++; empties.push(id.slice(0, 8)); }
    else buckets.real++;
  } catch (e) {
    buckets.threw++;
    bad.push(`${id.slice(0, 8)}: ${e.message.slice(0, 60)}`);
  }
}

const tot = ids.length;
const pct = (n) => (n / tot * 100).toFixed(1) + '%';
console.log('name-map 变体（去重后）  ', tot, ` (名字 ${Object.keys(NAME_TO_VARIANT).length} 条)`);
console.log('  真·有算法（能发 key）  ', buckets.real, pct(buckets.real));
console.log('  空壳（原厂不发 key）   ', buckets.empty, pct(buckets.empty), empties.join(' '));
console.log('  拒写（未逆出 / 刻意）  ', buckets.threw, pct(buckets.threw));
if (bad.length) console.log('\n' + bad.join('\n'));
process.exit(buckets.threw ? 1 : 0);
