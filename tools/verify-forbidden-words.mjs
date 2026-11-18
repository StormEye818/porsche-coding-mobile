#!/usr/bin/env node
/**
 * verify-forbidden-words.mjs — R-4 / U-3 禁用结案词门禁。
 *
 * 用 Node fs.readFileSync(...).includes() 扫全库 .md 的 PRD §0 十类禁用结案词，
 * 按 U-3 / U-5 / U-7 / Q4 机读分类，只把「作为现行结案理由」的命中计为违规：
 *   - 清单/禁令引用、41 行基线原文（Q1 强制原样保留）、已推翻/否定/待挖线索引用
 *     → 合法（作为待挖线索时同行须附下一载体与扫描命令）；
 *   - Q4 范围外历史取证文档 → 不必逐字清洗（U-7）；
 *   - 6 份基线文档中被推翻但未带否定标记的旧结论 → 记 U-5 顶部指向缺失，
 *     由 T03/T04 收口，不计入「作为结案理由」命中。
 *
 * 禁止 Bash grep（BSD grep 的 \b 对中文/.md 实测返回 0，Node 扫描才准）。
 * 输出可复跑命令；命中（作为结案理由）= 0 时退出 0，否则非 0。
 *
 * 跑法：node tools/verify-forbidden-words.mjs
 */
import { scanForbiddenWords, sortedKeys, FORBIDDEN_CLASSES } from './align431-eval.mjs';

const r = scanForbiddenWords();

// ★ 防复发扫描集下限（2026-11-18 事故）：
//   冻结基线 965883d 的入库根 .md = 18（README + 17 份；出处见断言输出行）。
//   310f280 把 17 份退出跟踪后扫描集塌成 1 份、原始命中 0 —— 「asClosingReason=0」
//   只是因为几乎没扫文件，门禁实质空转。写死下限 18 并带出处，防止再次「塌成 1 份仍报 0」；
//   非 git 环境降级同样判红，不静默。
const SCANSET_MIN = 18;
const scansetOk = !r.scanDegraded && r.files >= SCANSET_MIN;

const lines = [];
const emit = (s = '') => lines.push(String(s));

emit('=== R-4 / U-3 禁用结案词扫描（Node includes，全库 .md） ===');
emit(`扫描方式=fs.readFileSync(file,'utf8').includes(word) 逐文件逐行；禁用 Bash grep`);
emit(`类别数=${Object.keys(FORBIDDEN_CLASSES).length} 文件数=${r.files} 原始命中=${r.raw}`);
emit(`扫描集来源=入库 .md｜tracked=${r.scanTracked} 忽略未入库=${r.scanIgnoredCount} 非git降级=${r.scanDegraded}（必须 false）`);
emit('--- 10 类原始命中 ---');
for (const k of sortedKeys(r.byClass)) emit(`  ${k} = ${r.byClass[k]}`);
emit('--- 分类桶（互斥，合计 = 原始命中） ---');
for (const k of sortedKeys(r.buckets)) emit(`  ${k} = ${r.buckets[k]}`);
emit('--- 作为「结案理由」命中 ---');
for (const h of r.closingHits) emit(`  CLOSING ${h}`);
emit(`作为结案理由命中数=${r.asClosingReason}`);
emit(`U-5 顶部指向缺失数=${r.topPointerMissing.length} ${JSON.stringify(r.topPointerMissing)}（T03/T04 收口项，非结案词命中）`);
emit('--- 可复跑命令 ---');
emit('node tools/verify-forbidden-words.mjs');
emit('node -e "import(\'./tools/align431-eval.mjs\').then(m=>console.log(m.scanForbiddenWords().asClosingReason))"');
emit('npm run audit:align431  （输出第 ④ 段同源）');
emit(`FORBIDDEN_WORDS_ZERO 作为结案理由命中=${r.asClosingReason}（应为 0）`);
emit(`FORBIDDEN_WORDS_TOP_POINTER_ZERO 顶部指向缺失=${r.topPointerMissing.length}（应为 0）`);
emit(`FORBIDDEN_WORDS_SCANSET_MIN 入库 .md 数=${r.files} 下限=${SCANSET_MIN}`
  + `（出处：git ls-tree -r --name-only 965883d | grep '\\.md$' 计 18 = README + 17 份恢复文档）`
  + `｜非git降级=${r.scanDegraded}（必须 false）→ ${scansetOk ? 'OK' : 'FAIL'}`);
const pass = r.asClosingReason === 0 && scansetOk;
emit(`结论：禁用结案词作为「结案理由」命中=${r.asClosingReason}，扫描集下限满足=${scansetOk}，退出码=${pass ? 0 : 1}`);

process.stdout.write(lines.join('\n') + '\n');
process.exit(pass ? 0 : 1);
