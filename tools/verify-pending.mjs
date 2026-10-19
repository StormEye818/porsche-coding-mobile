/**
 * 待逆清单的**离线对拍**：把 tools/vectors 里的 32 点 仿真 采样跑一遍。
 *
 *   node tools/verify-pending.mjs
 *
 * 覆盖两个维度：
 *   mode    —— `pswCalc(mode, seed)`（securityModel 的 switch 路径）
 *   variant —— `computeVariantKey(id, seedBytes)`（ASAP1A 变体名路径）
 *
 * ⚠️ 期望值全部来自 仿真 实跑原厂 .so（tools/lib-真值对拍.py / tools/vectors/*.json），
 *    不是 JS 自己抄自己。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pswCalc } from '../src/seedkey-pswcalc.js';
import { computeVariantKey } from '../src/seedkey-registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const modeSamples = JSON.parse(readFileSync(join(here, 'vectors/mode-samples.json'), 'utf8'));
const varSamples = JSON.parse(readFileSync(join(here, 'vectors/pend-samples.json'), 'utf8'));

/**
 * **刻意保持拒写**的 mode —— 它们不算回归失败，但会在汇总里单独列出。
 *
 * `0x1d`：`mode 0x1D` 在库里是 **size=2 的空壳**，真算法依赖运行时状态
 *   (`(token+0x408838) + seed`)，**不是纯函数**，离线实现不了。
 *   真值表里 want == seed（identity）只是「空壳跑完没改 seed」的假象，
 *   **不是**正解 —— 把这条当已收编会直接吃 NRC 0x35。见 TAKEOVER.md §5.1。
 */
const EXPECT_REJECT = new Map([[0x1d, 'mode 0x1D 是 2 字节空壳，非纯函数，刻意拒写']]);

let pass = 0, skip = 0;
const failedModes = new Set();
const failures = [];

for (const [hex, rows] of Object.entries(modeSamples)) {
  const mode = parseInt(hex, 16);
  let ok = 0, n = 0;
  for (const r of rows) {
    if (r.key == null) { skip++; continue; }
    const seed = parseInt(r.seed, 16);
    const want = parseInt(r.key, 16);
    n++;
    let got;
    try { got = pswCalc(mode, seed).key >>> 0; } catch (e) { got = null; }
    if (got === want) ok++;
    else if (failures.length < 40) failures.push(`mode ${hex} seed=${r.seed} want=${r.key} got=${got == null ? 'REJECT' : got.toString(16)}`);
  }
  if (n === 0) continue;
  if (ok === n) { pass++; console.log(`  ok  mode ${hex}  ${ok}/${n}`); }
  else { failedModes.add(`mode ${hex}`); console.log(`  FAIL mode ${hex}  ${ok}/${n}`); }
}

for (const [id, rows] of Object.entries(varSamples)) {
  let ok = 0, n = 0;
  for (const r of rows) {
    if (r.key == null) { skip++; continue; }
    const seed = parseInt(r.seed, 16);
    const bytes = Uint8Array.of((seed >>> 24) & 0xff, (seed >>> 16) & 0xff, (seed >>> 8) & 0xff, seed & 0xff);
    n++;
    let got = null;
    try {
      const res = computeVariantKey(id, bytes);
      let v = 0;
      for (const b of res.key) v = ((v << 8) | b) >>> 0;
      got = v;
    } catch (e) { got = null; }
    if (got === parseInt(r.key, 16)) ok++;
    else if (failures.length < 40) failures.push(`var ${id} seed=${r.seed} want=${r.key} got=${got == null ? 'REJECT' : got.toString(16)}`);
  }
  if (n === 0) continue;
  if (ok === n) { pass++; console.log(`  ok  var  ${id.slice(0, 12)}  ${ok}/${n}`); }
  else { failedModes.add(`var ${id}`); console.log(`  FAIL var  ${id.slice(0, 12)}  ${ok}/${n}`); }
}

const expected = [...failedModes].filter((k) => k.startsWith('mode ')
  && EXPECT_REJECT.has(parseInt(k.split(' ')[1], 16)));
const unexpected = [...failedModes].filter((k) => !expected.includes(k));

console.log(`\n通过 ${pass} 项 / 失败 ${unexpected.length} 项 / 刻意拒写 ${expected.length} 项 / 无采样跳过 ${skip} 点`);
if (expected.length) {
  console.log('刻意拒写（不算回归失败）：');
  for (const k of expected) console.log(`  ${k}  ${EXPECT_REJECT.get(parseInt(k.split(' ')[1], 16))}`);
}
if (failures.length) console.log('\n前若干不一致：\n' + failures.slice(0, 20).join('\n'));
process.exit(unexpected.length ? 1 : 0);
