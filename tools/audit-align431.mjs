#!/usr/bin/env node
/**
 * audit-align431.mjs — 「全链路字节级对齐 431」确定性逐行审计入口（PRD §3 P0-7 / §7 T1、T2）。
 *
 * 输出契约：
 *   ① 41+N 行逐行 A / 非 A + R-1 两坐标（431 证据坐标 <file>:<offset|VA|recordId>
 *      与我方代码路径 <file>:<symbol|line>）；新增行单独编号、不覆盖基线 41 行；
 *   ② 每个数字的实测来源命令（含 N=120 的复跑命令）；
 *   ③ 非 A 行的「下一载体 + R-3 可复跑扫描命令」；
 *   ④ 禁用结案词命中数（PRD §0 十类，Node includes 扫描全库 .md）；
 *   ⑤ 每行按 R-5 分列 forensicGrade（取证等级）与 u1CarrierStatus（U-1 载体状态）。
 *
 * 判据：全 A 退出码 0，任一非 A 非 0；连续两次运行规范化输出 sha256 相同。
 * 确定性：禁时间戳 / generatedAt / 绝对路径 / 随机顺序；遍历一律 Object.keys().sort()；
 *         末尾输出规范化文本的 sha256。T04/T05 全 A 后已接入 scripts.test 末步。
 *
 * 跑法：npm run audit:align431   （或 node tools/audit-align431.mjs）
 */
import {
  readJson, scanForbiddenWords, evaluateRow, carrierStatusOf, sha256, sortedKeys, fileExists,
  clearGateCache,
} from './align431-eval.mjs';

const ROWS_FILE = 'tools/align431-rows.json';
const rows = readJson(ROWS_FILE);
if (!rows) {
  console.error(`缺少 ${ROWS_FILE}，请先运行 node tools/build-align431-rows.mjs`);
  process.exit(2);
}

const out = [];
const emit = (s = '') => out.push(String(s));

/**
 * 机读 U-1 三件套缺失数 —— 复用共享内核 carrierStatusOf(row)：
 * gate 文件实存 + gate 文本内含 assertion + src 文件实存 + 431 坐标合法。
 * 禁止用字符串形状（startsWith('tools/verify-')）冒充载体存在。
 */
function u1TripleMissing(row) {
  return carrierStatusOf(row).missing;
}

const allRows = [...(rows.baselineRows || []), ...(rows.addedRows || [])];
const evaluated = allRows.map((row) => {
  // verdict / u1CarrierStatus 一律按「审计运行时的磁盘实况」重算，
  // 不信任 JSON 里落盘的快照值 —— 门禁文件被改名/落盘时立即反映（反例注入可证）。
  const live = evaluateRow(row);
  return {
    row,
    verdict: live.verdict,
    detail: live.detail,
    u1CarrierStatus: live.u1CarrierStatus,
    carrierReasons: live.carrierReasons,
    u1Missing: u1TripleMissing(row),
    // ★ 前置未满足（gate 退出码 2）与「内容不一致」是两件事，必须各自可数。
    preconditionMissing: live.gatePreconditionMissing === true,
  };
});

emit('=== align431 确定性逐行审计（PRD §3 P0-7 / §7 T1、T2） ===');
emit(`rowsFile=${ROWS_FILE} schemaVersion=${rows.schemaVersion}`);
emit(`[基线] source=${rows.baseline.source} :${rows.baseline.lineStart}-:${rows.baseline.lineEnd} count=${rows.baseline.count} ROWS_DELETE_ZERO=${rows.baseline.deleteZero} ROWS_MERGE_ZERO=${rows.baseline.mergeZero} 原编号逐行保留=${rows.baseline.originalNumberingPreserved}`);
emit(`[新增] N=${rows.addedRowCount}（脚本按实际条目机读生成，非手填常数） 分类=${Object.keys(rows.categoryCounts || {}).length}`);
for (const k of sortedKeys(rows.categoryCounts || {})) emit(`  CATEGORY ${k} = ${rows.categoryCounts[k]}`);
emit(`[总行数] 41+N = ${rows.baseline.count} + ${rows.addedRowCount} = ${allRows.length}`);
emit('');

// ① 逐行判定 + R-1 两坐标 + R-5 两字段
emit('--- ① 逐行判定（A / 非 A；R-1 两坐标；R-5 分列两字段） ---');
for (const e of evaluated) {
  const r = e.row;
  const coord = `431证据=${r.evidence431} | 我方代码=${r.codePath}`;
  const two = `取证等级=${r.forensicGrade} | U-1载体状态=${e.u1CarrierStatus}`;
  const extra = `gate=${r.gate}#${r.assertion} | diffCmd=${r.diffCmd} | check=${e.detail}`;
  emit(`[${e.verdict === 'A' ? 'A  ' : '非A'}] ${r.rowId} | 分类=${r.category} | ${coord} | ${two} | ${extra}`);
}
emit('');

// ② 每个数字的实测来源命令
emit('--- ② 数字实测来源命令（分母各自标源、禁止混算；含 N=120 复跑） ---');
for (const n of rows.numberSources || []) {
  emit(`NUMBER ${n.name} = ${JSON.stringify(n.value)} | scope=${n.scope} | sourceCmd=${n.sourceCmd}${n.note ? ' | note=' + n.note : ''}`);
}
emit(`NUMBER 文档旧值清单（PRD §5 U-2 机读，非硬编码份数）= ${JSON.stringify(rows.legacyNumbers || [])}`);
emit('');

// ③ 非 A 行的下一载体 + R-3 可复跑扫描命令
const nonA = evaluated.filter((e) => e.verdict !== 'A');
emit(`--- ③ 非 A 行：下一载体 + R-3 可复跑扫描命令（非 A 行数 = ${nonA.length}） ---`);
for (const e of nonA) {
  const r = e.row;
  // 载体缺失导致的非 A（含反例注入临时改名）也必须给可落地载体与扫描命令，
  // 不能因为 rows 快照里该行原本是 A 就留空。
  const liveCarrier = e.carrierReasons.length
    ? `落盘 U-1 三件套：${e.carrierReasons.join('；')}（gate=${r.gate}#${r.assertion}）`
    : '';
  const carrier = r.nextCarrier || liveCarrier || `补证据/实现载体：${e.detail}`;
  const scan = r.scanCmd || `node -e "const fs=require('fs');console.log(fs.existsSync('${r.gate}'))"`;
  emit(`NONA ${r.rowId} | 原因=${e.detail}`);
  emit(`  下一载体=${carrier} | carrierPhase=${r.carrierPhase}`);
  emit(`  R-3扫描命令=${scan}`);
}
emit('');

// ④ 禁用结案词命中数（Node includes，全库 .md）
const fw = scanForbiddenWords();
emit('--- ④ 禁用结案词（PRD §0 十类，Node fs.readFileSync().includes() 扫**入库** .md） ---');
// ⚠️ 这一行**进 sha256**，所以只许写**与机器无关**的事实。
//    「本机未入库几份」是本机事实（本地 42 / clone 0），写进来会把 sha256 变回机器相关 ——
//    那正是本轮要修的东西。它在输出末尾以「不进指纹」标注单列。
emit(`扫描集=${fw.scanDegraded
  ? '全部本地 .md（非 git 环境，机器相关，指纹不可跨机对照）'
  : '入库 .md（.gitignore 排除的文档不参与，扫描面因此与机器无关）'}`);
emit(`扫描 .md 文件数=${fw.files} 原始命中=${fw.raw} 作为结案理由命中=${fw.asClosingReason}`);
for (const k of sortedKeys(fw.byClass)) emit(`  CLASS ${k} = ${fw.byClass[k]}`);
for (const k of sortedKeys(fw.buckets)) emit(`  BUCKET ${k} = ${fw.buckets[k]}`);
for (const h of fw.closingHits) emit(`  CLOSING ${h}`);
emit(`  U-5 顶部指向缺失（T03/T04 收口，非结案词命中）= ${fw.topPointerMissing.length} ${JSON.stringify(fw.topPointerMissing)}`);
emit(`  复跑命令=node tools/verify-forbidden-words.mjs`);
emit('');

// ⑤ U-1 三件套 / 门禁映射
const u1MissingRows = evaluated.filter((e) => e.u1Missing.length);
emit('--- ⑤ U-1 标 A 三件套缺失数（src/ 代码路径 + tools/verify-* 断言名 + 431 证据坐标） ---');
emit(`三件套缺失行数=${u1MissingRows.length}（按 gate 文件实存 + 断言名实存 + src 文件实存 + 431 坐标合法逐行机读；门禁缺失即计入，不降级取证 A 但该行判非 A）`);
for (const e of u1MissingRows.slice(0, 20)) emit(`  U1MISS ${e.row.rowId} 缺 ${e.u1Missing.join(',')}`);
emit(`待落盘门禁=${JSON.stringify((rows.deferredGates || []).map((g) => g.gate + '@' + g.phase))}`);
emit('');

// 汇总 + 退出码
const aCount = evaluated.filter((e) => e.verdict === 'A').length;
const nonACount = nonA.length;
// ★ 前置未满足（gate 退出码 2，例：`www/` 未构建）单独计数。
//   它不是内容缺陷，处置方向是「先跑 npm run sync」；混进「非 A」会把人引去查代码。
const precondRows = nonA.filter((e) => e.preconditionMissing);
const precondCount = precondRows.length;
const allA = nonACount === 0 && fw.asClosingReason === 0 && u1MissingRows.length === 0
  && rows.baseline.deleteZero && rows.baseline.mergeZero && rows.baseline.originalNumberingPreserved;
emit('--- 汇总 ---');
emit(`基线=${rows.baseline.count} 新增=${rows.addedRowCount} 总行数=${allRows.length} A=${aCount} 非A=${nonACount}`);
emit(`前置未满足行数=${precondCount}（gate 退出码 2 = 前置未构建、未判内容；请先 npm run sync）`);
emit(`禁用结案词命中(作为结案理由)=${fw.asClosingReason} 三件套缺失=${u1MissingRows.length} 删行=${rows.baseline.deleteZero ? 0 : 1} 合并行=${rows.baseline.mergeZero ? 0 : 1}`);
// ★ 退出码说明按 live 求值动态生成：不写死任何阶段结论、不留自宣式文字。
//   全 A →「全 A，退出码 0」；否则逐项列出实际未归零的原因与「仍有 N 行非 A」。
const blockers = [];
if (nonACount > 0) blockers.push(`仍有 ${nonACount} 行非 A`);
if (fw.asClosingReason > 0) blockers.push(`禁用结案词命中 ${fw.asClosingReason}`);
if (u1MissingRows.length > 0) blockers.push(`三件套缺失 ${u1MissingRows.length}`);
if (!rows.baseline.deleteZero) blockers.push('删行≠0');
if (!rows.baseline.mergeZero) blockers.push('合并行≠0');
// 退出码三态：0=全 A；2=非 A **全部**由前置未满足造成（内容未判）；1=其余（含真内容缺陷）。
const onlyPrecondition = nonACount > 0 && precondCount === nonACount;
const otherBlockers = fw.asClosingReason > 0 || u1MissingRows.length > 0
  || !rows.baseline.deleteZero || !rows.baseline.mergeZero || !rows.baseline.originalNumberingPreserved;
const exitCode = allA ? 0 : ((onlyPrecondition && !otherBlockers) ? 2 : 1);
if (exitCode === 2) {
  emit(`退出码=2（${precondCount} 行因前置未构建未判，非内容缺陷 —— 请先 npm run sync；`
    + '仍非全 A、仍非 0，不因「只是没构建」放绿）');
} else {
  emit(`退出码=${exitCode}（${allA
    ? `全 A ${aCount}/${allRows.length}，禁用结案词/三件套/删行/合并行均归零`
    : `${blockers.join('；')}，退出码非 0`}）`);
}

// 确定性：末尾输出规范化文本 sha256（不含本行）
const normalized = out.join('\n');
emit(`sha256=${sha256(normalized)}`);
// ★ 以下两行**不进指纹**（在 normalized 之后才 append）：它们承载**本机事实**，
//   若进指纹就会让「换机可对照」失效 —— 与本轮修的东西自相矛盾。
emit(`（不进指纹）本机未入库 .md ${fw.scanIgnoredCount} 份 —— `
  + `${fw.scanDegraded
    ? '⚠ 非 git 环境：已降级为扫描全部本地 .md，扫描面随机器变，本次指纹不可跨机对照'
    : '.gitignore 政策排除，属本机调研文档，不参与扫描'}`);
process.stdout.write(out.join('\n') + '\n');
// ★ QA R3 / 问题2：退出前清理每个 gate 的独立临时目录，避免残留影响后续运行。
clearGateCache();
process.exit(exitCode);
