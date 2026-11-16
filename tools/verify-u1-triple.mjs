#!/usr/bin/env node
/**
 * verify-u1-triple.mjs — U-1 标 A 三件套门禁（PRD §5 U-1 / R-5 / §7 T1、T4）。
 *
 * ★ 审计阻断项修正：三件套缺失数必须由「磁盘实况」得出，禁止用字符串形状自证。
 *   本脚本直接复用 tools/align431-eval.mjs 的共享内核 carrierStatusOf(row)：
 *     ① src/ 代码路径 —— 必须是 src/ 路径且该 src 文件真实存在；
 *     ② tools/verify-* 门禁断言名 —— gate 文件必须真实存在（fs.existsSync），
 *        且文件文本内确实含 row.assertion 断言名（Node .includes()，不用 grep）；
 *     ③ 431 证据坐标 —— 必须是合法 <file>:<offset|VA|recordId>。
 *   任一不满足即计入缺失；缺失数 > 0 时退出码非 0（这是正确信号，禁止为凑 0 放宽）。
 *
 * R-5：取证等级（forensicGrade）与 U-1 载体状态（u1CarrierStatus）分列两字段；
 *   载体待落盘不降级取证 A，但三件套缺失数 ≠ 0 ⇒ T1/T4 不达成、不得宣称收口。
 *
 * 跑法：node tools/verify-u1-triple.mjs
 */
import { readJson, carrierStatusOf, sortedKeys } from './align431-eval.mjs';

const rows = readJson('tools/align431-rows.json');
if (!rows) {
  console.error('缺少 tools/align431-rows.json，请先运行 node tools/build-align431-rows.mjs');
  process.exit(2);
}
const all = [...(rows.baselineRows || []), ...(rows.addedRows || [])];

/** 逐行按磁盘实况判定三件套；返回缺失项数组（空 = 齐备）。 */
const tri = (r) => carrierStatusOf(r).missing;

const missingRows = all.map((r) => ({ row: r, missing: tri(r) }))
  .filter((x) => x.missing.length > 0);
const pending = all.filter((r) => String(r.u1CarrierStatus).includes('待落盘'));
const forensicA = all.filter((r) => r.forensicGrade === 'A');
const forensicAPending = forensicA.filter((r) => String(r.u1CarrierStatus).includes('待落盘'));

const reasonCounts = {};
for (const x of missingRows) {
  for (const m of x.missing) reasonCounts[m] = (reasonCounts[m] || 0) + 1;
}
const byCategory = {};
for (const x of missingRows) {
  byCategory[x.row.category] = (byCategory[x.row.category] || 0) + 1;
}

const L = [];
L.push('=== U-1 标 A 三件套门禁（按磁盘实况，禁止字符串形状自证） ===');
L.push(`总行数=${all.length} 基线=${(rows.baselineRows || []).length} 新增=${(rows.addedRows || []).length}`);
L.push('检查规则：gate 文件 fs.existsSync + gate 文本 .includes(assertion) + src 文件实存 + 431 坐标合法');
L.push(`三件套缺失行数=${missingRows.length}`);
L.push(`缺失原因分布=${JSON.stringify(Object.fromEntries(Object.entries(reasonCounts).sort()))}`);
L.push(`缺失行分类分布=${JSON.stringify(Object.fromEntries(Object.entries(byCategory).sort()))}`);
L.push(`取证等级分布=${JSON.stringify({ A: forensicA.length, 非A: all.length - forensicA.length })}`);
L.push(`U-1 载体待落盘总数=${pending.length} 取证 A 且载体待落盘=${forensicAPending.length}（R-5：不降级取证 A）`);
L.push(`待落盘却判 A 的行数=${all.filter((r) => String(r.u1CarrierStatus).includes('待落盘') && r.verdict === 'A').length}`);
L.push('前 12 条缺失明细：');
for (const x of missingRows.slice(0, 12)) {
  L.push(`  MISS ${x.row.rowId} | gate=${x.row.gate}#${x.row.assertion} | 缺 ${x.missing.join(',')}`);
}
L.push('说明：门禁未落盘 / 断言名不在门禁文件内 → 三件套缺失数 ≠ 0 → T1/T4 不达成、不得宣称「全部收口」。');
// U1_TRIPLE_ZERO_MISSING：实跑行为断言名（不是字符串占位）——按磁盘实况逐行重算，
// 删任一 gate 断言名 → 缺失数立刻 > 0、退出码非 0（反例注入可证伪）。
L.push(`U1_TRIPLE_ZERO_MISSING 断言：逐行 carrierStatusOf() 重算，缺失=${missingRows.length}`);
L.push(`U1_TRIPLE_ZERO_MISSING 结论：${missingRows.length === 0
  ? '三件套 0 缺失（src 路径 + tools/verify-* 断言名 + 431 坐标全部齐备）'
  : `仍有 ${missingRows.length} 行缺件，禁止宣称收口`}`);
L.push('复跑命令：node tools/verify-u1-triple.mjs ; node tools/build-align431-rows.mjs ; npm run audit:align431');
const exit = missingRows.length === 0 ? 0 : 1;
L.push(`结论：三件套缺失=${missingRows.length}，退出码=${exit}（缺失非零即非 0，为正确信号）`);
process.stdout.write(L.join('\n') + '\n');
process.exit(exit);
