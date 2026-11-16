#!/usr/bin/env node
/**
 * verify-u2-numbers.mjs — U-2 数字与实测一致门禁（PRD §5 U-2 / P0-6 / 附录 A）。
 *
 * 纪律：
 *   - 「清单动态生成」：权威数字清单由 tools/align431-eval.mjs 的
 *     measureNumberSources() 从 data/*.json 实际条目机读产出；旧值清单由
 *     legacyNumbersFromPrd() 从 PRD §5 U-2 行文本机读抽出。均不硬编码 18/23 份。
 *   - 白名单（合法表述，不计冲突）：
 *       · PRD 里「引用旧值待改 / 已知冲突必须消除 / 历史值 / 须消除」的行；
 *       · GAP-INVENTORY-20261112.md:60 的 1A84/87/91/92/94（92 是 LID 字节，不是候选数）；
 *       · 注释 / 代码 / 十六进制字节行里不参与统计的数字；
 *       · Q4 范围外（6 份基线文档之外）历史取证文档（U-7：不必逐字清洗）；
 *       · 同行带否定/推翻/历史/快照/复跑标记的引用。
 *   - 分母清单 3/13/16、527/402/185、120/40、163/148/12、74/111、
 *     67/79/687、13873/153/119657 各自标源、互不替代。
 *
 * ★ 时间维（2026-11-17 补）：门禁模型必须能表达「这个数字在什么时候为真」。
 *   METRICS 只存**当前实测值**。按日期冻结的历史快照文档里那个值是**当日事实**，
 *   用今天的值去量它是范畴错误 —— 会把正确的历史记录判成错误，进而训练人
 *   「遇红就改标注」，最终把这条断言废掉（本轮 373/375、118/127、89/95 即如此）。
 *   处理方式：把在册文档**显式**分成两集（NEVER_EXEMPT 现行权威 / HISTORY_SNAPSHOT
 *   一次性留痕），后者不参与 drift 比对、仍参与 obsolete 与白名单统计，豁免条数逐文件打印。
 *   ★★ 方法论：**「豁免」必须来自显式分类，不能来自模式推断。**
 *   模式（日期、前缀）只能用来**提示**，不能用来**决定**：凡是「判错了会静默变绿」的
 *   规则，都是在把门禁往松的方向腐蚀。显式列表 + 分区断言的失败方向唯一 ——
 *   漏分类就红（U2_DOC_PARTITION），从不了绿。
 *   活文档（TAKEOVER.md）**绝不豁免**：它在 NEVER_EXEMPT 里，且
 *   U2_TOKEOVER_NEVER_EXEMPT + U2_DOC_PARTITION 把这条从「一条可被后人改掉的单独断言」
 *   升级为**结构性保证**（互斥分区禁止它同时出现在另一集）。
 *
 * 数字 diff = 0 退出码 0，否则非 0。
 * 跑法：node tools/verify-u2-numbers.mjs
 */
import {
  readJson, readText, markdownFiles, measureNumberSources, legacyNumbersFromPrd,
  PRD_FILE, GAP_FILE, CURRENT_SCOPE_DOCS, OVERTURN_MARKERS, PRD_QUOTATION_MARKERS, sortedKeys,
} from './align431-eval.mjs';

const rows = readJson('tools/align431-rows.json');
if (!rows) {
  console.error('缺少 tools/align431-rows.json，请先运行 node tools/build-align431-rows.mjs');
  process.exit(2);
}

/** 旧值 token → 带边界的 RegExp（避免把 92 匹配进 0x92 / 1992 / 920）。 */
function boundaryRe(tok) {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isPct = tok.endsWith('%');
  const tail = isPct ? '' : '(?![0-9A-Fa-fxX])';
  return new RegExp(`(?<![0-9A-Fa-fxX])${esc}${tail}`);
}

/**
 * U-2 白名单分类（★ QA R1 / G5 重写：必须存在**能失败**的路径）。
 *
 * 旧实现 7 处 `legit:true`、0 处 `legit:false` → 恒真，改错数字也退 0。
 * 新规则（逐条可证伪）：
 *   1 注释 / 引用块 / 十六进制字节行            → 合法（不参与统计）
 *   2 GAP-INVENTORY-20261112.md:60 的 LID 字节   → 合法（92 是 LID，不是候选数）
 *   3 同行带推翻/历史/引用/待挖标记             → 合法（作为历史快照或线索）
 *   4 41 行基线里原判 **A** 的行                → 合法（Q1 强制原文保留，数字是历史快照）
 *   5 PRD 现行文档：仅当同行含「引用/禁令/判据」标记才合法；否则计入冲突
 *   6 6 份基线文档：**行内**必须有历史/引用标记（顶部指向不能整篇豁免），否则冲突
 *   7 6 份基线之外的历史文档                     → 合法（U-7 Q4：不必逐字清洗）
 *   其余一律 `legit:false` → 计入 conflict → 退出码非 0。
 *
 * 另外启用**锚点漂移**检查：现行文档里与实测锚点相差 ±2 的「认领数字」
 * （N/M 或 N 条）也计冲突 —— 这样把 1070 改成 1071 会立即翻红。
 */
function classify(file, lineNo, line, inBaselineA) {
  if (/^\s*(#|\/\/|>|```)/.test(line)) return { legit: true, bucket: '注释/引用块', carrier: '' };
  if (/0x[0-9A-Fa-f]{2,}|\[[0-9A-Fa-f]{2,}\]/.test(line) && !/\d+\s*条|\d+\s*个/.test(line)) {
    return { legit: true, bucket: '十六进制字节行(不参与统计)', carrier: '' };
  }
  if (file === GAP_FILE && lineNo === 60) return { legit: true, bucket: 'GAP:60 LID字节', carrier: '' };
  // ★ Q1 强制：GAP §2 :41–:81 是 41 行基线，originalText 必须逐字节保留 →
  //   其内数字按定义就是「历史快照」，合法（不是为过门禁而豁免，是 PRD Q1 的硬约束）。
  if (file === GAP_FILE && lineNo >= 41 && lineNo <= 81) {
    return { legit: true, bucket: 'GAP基线41行原文保留(Q1历史快照)', carrier: '' };
  }
  if (OVERTURN_MARKERS.some((m) => line.includes(m))) return { legit: true, bucket: '否定/历史/引用标记', carrier: '' };
  if (inBaselineA) return { legit: true, bucket: 'GAP基线A行原文保留(Q1)', carrier: '' };
  if (file === PRD_FILE) {
    if (PRD_QUOTATION_MARKERS.some((m) => line.includes(m))) return { legit: true, bucket: 'PRD引用/禁令/判据', carrier: '' };
    return { legit: false, bucket: 'PRD现行结论无引用标记', carrier: '补引用/历史标记或把数字改为实测值' };
  }
  if (CURRENT_SCOPE_DOCS.includes(file)) {
    // ★ 顶部指向不再整篇豁免：行内必须自带历史/引用标记。
    return { legit: false, bucket: 'U-5基线文档行内缺历史/引用标记', carrier: '补行内历史标记或统一到实测值' };
  }
  return { legit: true, bucket: 'Q4范围外历史文档', carrier: '' };
}

/** 实测锚点（用于「数字被改错」的漂移检测）：measureNumberSources + data 直读。 */
const AUTH_NUM = new Set();
{
  const flat = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) { AUTH_NUM.add(String(v)); return; }
    if (typeof v === 'string') { for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) AUTH_NUM.add(m[0]); return; }
    if (Array.isArray(v)) { for (const x of v) flat(x); return; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) flat(v[k]);
  };
  for (const n of measureNumberSources()) flat(n.value);
  const drv = readJson('data/drivelinks.json');
  if (drv && drv.recordCount) AUTH_NUM.add(String(drv.recordCount));
}
const AUTH_ANCHORS = [...AUTH_NUM].map(Number).filter((x) => Number.isInteger(x) && x >= 20);

/**
 * ★ G5：从 PRD 机读出的旧值清单去噪 —— 剔除
 *   · 日期 `20\d{6}`、   · 项目名 `431`、   · 任何**当前实测值**（AUTH_NUM）、
 *   · 分节号 `3.2`/`3.3` 这类非计数串。
 * 剩下的才是「真·旧值」，只有它们出现在现行结论行才算冲突。
 */
const LEGACY_RAW = (rows.legacyNumbers || legacyNumbersFromPrd()).filter((t) => t.length >= 2);
const LEGACY = LEGACY_RAW.filter((t) => {
  if (/^20\d{6}$/.test(t)) return false;      // 日期
  if (t === '431') return false;              // 项目名
  if (/^\d\.\d$/.test(t)) return false;       // 分节号 3.2 / 3.3
  if (AUTH_NUM.has(t.replace(/%$/, ''))) return false; // 当前实测值
  return true;
}).sort();

/**
 * ★ G5：PRD §5 U-2 明文列出的「已知冲突必须消除」旧值 → 现行实测值。
 * 只收**无歧义**形态（带单位/斜杠/百分号），避免误伤 `92`(0x92 / 1A84/87/91/92/94)、
 * `34`（门禁条数 34）这类同形不同义的串。行内有历史/引用/更正标记即豁免。
 */
const OBSOLETE = Object.freeze([
  ['1072 条', '1070 条'], ['962', '966'], ['3817/3817', '4588/4588'], ['3817', '4588'],
  ['99.8872%', '动态 Y/Y'], ['119657', '292574'],
]);
const ANNOT_RE = /历史|旧值|快照|推翻|待改|引用|更正|现行|统一到|改为|已作废|作废|不再|非缺口/;

/**
 * ★ 时间维（2026-11-17）：**显式分区**，不靠模式推断。
 *
 * 问题：`METRICS` 只存**当前实测值**；而按日期冻结的快照文档里那个值是**当日事实**
 * （`AUDIT-20261112.md` 写 smoke 373，那一天它就是 373）。用今天的 375 去量它是
 * 范畴错误 —— 会把正确的历史记录判成错误，进而训练人「遇红就改标注」，
 * 最后把这条断言废掉。
 *
 * 解法：把「在册文档」（`CURRENT_SCOPE_DOCS`，7 份）**显式**划成两集：
 *   NEVER_EXEMPT      现行权威 —— 永不豁免
 *   HISTORY_SNAPSHOT  一次性留痕 —— 不参与 drift 比对（obsolete / 白名单统计照旧）
 *
 * 为什么不用「文件名带 \d{8} 且早于某常量即豁免」：
 *   · 会把 `PRD-FULLALIGN-431-20261113.md`（现行权威）与
 *     `GAP-INVENTORY-20261112.md`（41 行基线源）一起豁免 —— 7 份在册文档豁免 5 份，
 *     drift 检查只剩 `ACCEPTANCE-MATRIX.md` + `TAKEOVER.md`；
 *   · 根因是范畴错误：**文件名日期编码的是「写就日」，不是「是否现行」**
 *     （与「拿今天的值量当天的记录」同一类错误）。PRD 写于 11-13，今天仍是权威文本；
 *   · 那个常量还会腐烂：需要每轮人工推进，而**忘给新文档分类**在旧方案里是**静默变绿**。
 *     显式分区把失败方向锁成唯一：漏分类 → `U2_DOC_PARTITION` 立即红。
 *
 * 分区断言（支点，双向 + 互斥）：
 *   U2_DOC_PARTITION          并集 === CURRENT_SCOPE_DOCS ∧ 交集为空 ∧ 无越界（不漏、不重）
 *   U2_TOKEOVER_NEVER_EXEMPT  TAKEOVER 不得出现在 HISTORY_SNAPSHOT（且必须实际不被豁免）
 */
const TAKEOVER_FILE = 'TAKEOVER.md';
const ACCEPTANCE_FILE = 'ACCEPTANCE-MATRIX.md';

/** 现行权威：永不豁免。改这里的唯一后果是「检查范围缩水」，所以逐份写清理由。 */
const NEVER_EXEMPT = Object.freeze([
  PRD_FILE,          // PRD-FULLALIGN-431-20261113.md —— 现行权威；文件名日期只是写就日
  GAP_FILE,          // GAP-INVENTORY-20261112.md —— 41 行基线源（Q1 原文保留另有行级豁免）
  ACCEPTANCE_FILE,   // 验收矩阵，无日期，无歧义
  TAKEOVER_FILE,     // 活文档，永远受检
]);

/** 一次性留痕：显式白名单，逐份写出。只有这 3 份，且不会增长。 */
const HISTORY_SNAPSHOT = Object.freeze([
  'AUDIT-20261112.md',
  'B-TO-A-CLOSURE-20261112.md',
  'RE-GAPVERIFY-20261112.md',
]);

/**
 * @param {string} file 相对仓库根的 .md 文件名
 * @returns {boolean} 是否属于 HISTORY_SNAPSHOT（→ 不参与 drift）
 *
 * 默认值必须偏向**更严**的一侧：「我不能断定它是历史」时按现行处理。
 * 因此这里只做两件事 —— 命中 NEVER_EXEMPT 一律 false，命中 HISTORY_SNAPSHOT 才是 true，
 * 其余（含带日期但未分类的文档）一律 false。
 */
function isHistoricalSnapshotOf(file) {
  const base = String(file).split('/').pop();
  if (base === TAKEOVER_FILE) return false;   // 结构性保险（另有 U2_TOKEOVER_NEVER_EXEMPT）
  if (NEVER_EXEMPT.includes(base)) return false;
  return HISTORY_SNAPSHOT.includes(base);
}

/**
 * ★ G5：数字**被改错**检测（精确、低噪声）。
 *
 * 只对「口径级」规范数字（CANON，均 ≥ 686）做 ±1 检测：
 * 这些是文档里当作统计口径引用的量，±1 只可能是笔误，不可能是别的真实量；
 * 表格序号（19/20/21…）、门禁条数（66/34…）等小数字不参与，避免全库噪声。
 *
 * 命中条件：本行出现 CANON±1 的**独立数字**，且**同文档**另有该 CANON 的正确写法
 * （CANON/CANON 或 `CANON 条`）—— 证明这是同一量被改错。
 * 历史文档里原样保留的正确数字永不命中。
 */
/**
 * ★ QA R2 / 必改6：**精确集合比对**（取代 ±1 邻域，后者漏挡 1070→1075 / 373→300 / 89→80）。
 *
 * 模型：为每个实测指标定义「指标名 → 权威值」。文档里只要出现该指标名，
 * 其紧邻的认领数字**必须等于**权威值；否则计 conflict。
 * 这样 1070→1075、373→300、89→80 三种改错都会被精确抓住（不是靠邻域近似）。
 * 历史标注（同行有 历史/旧值/快照/引用/推翻/当时/基线）与 Q1 强制基线行仍豁免。
 */
// ⚠️ 本表是**人工抄自门禁 stdout** 的权威值快照，不是从文档里读的。
//    门禁断言数一变（本轮 smoke 373→375、e2e 118→127、fullchain-audit 89→95），
//    这里必须同步更新，否则**正确的文档反而会被判冲突**（2026-11-17 提交后复跑即发生）。
//    更新纪律：只从 `node <gate>.mjs` 的输出里抄数字，**不许**从文档抄
//    —— 从文档抄就变成「拿文档验证文档」，这条断言立刻失去意义。
const METRICS = Object.freeze([
  { name: 'smoke-fixes', value: 375 },
  { name: 'e2e-flow', value: 127 },
  { name: 'verify-all-models', value: 79 },
  { name: 'verify-oem-session', value: 32 },
  { name: 'verify-oem-frames', value: 37 },
  { name: 'verify-fullchain-audit', value: 95 },
  { name: 'verify-fullchain', value: 38 },
  { name: 'verify-write-gate', value: 60 },
  { name: 'verify-runtime-safety', value: 30 },
  { name: 'test-align431', value: 38 },
  { name: 'walkthrough', value: 84 },
  { name: 'verify-pending', value: 69 },
  { name: 'verify-sysdata-comm', value: 16 },
  { name: 'drivelinks', value: 1070 },
  { name: 'opened', value: 4588 },
  { name: 'vendorExtPseudoRids', value: 44 },
]);

/** 指标锚定的精确比对：返回 `${指标}:${实值}≠${权威值}` 列表。
 *  只认「指标名后**紧邻**的认领数字」（允许 `**`、反引号、空格、括号、/ 间隔 ≤3），
 *  因此 `tools/verify-all-models.mjs\` | 19 条改造断言` 这类描述不会被误判。 */
function driftHits(line, docText) {
  const out = [];
  void docText;
  if (ANNOT_RE.test(line)) return out;   // 同行历史标注 → 豁免
  for (const m of METRICS) {
    const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(?<![A-Za-z0-9_-])${escaped}(?:\\.mjs)?[\`*\\s（(]{0,3}\\*{0,2}(\\d{1,7})`, 'g');
    for (const hit of line.matchAll(re)) {
      const n = Number(hit[1]);
      if (n === 0) continue;                       // 0 一般表示失败数
      if (n === m.value) continue;                 // 等于权威值 → 正确
      if (line.includes(`${m.value}/${m.value}`) || line.includes(`${m.value}/0`)) continue;
      // 「N 失败 / N 拒写」是失败计数，不是该指标的通过数 → 不算 drift
      const tail = line.slice(hit.index + hit[0].length, hit.index + hit[0].length + 6);
      if (/^\s*[（(]?\s*(?:失败|拒写|刻意拒写|个失败)/.test(tail)) continue;
      out.push(`${m.name}:${n}≠${m.value}`);
    }
  }
  return out;
}

/** PRD 声明旧值命中（无历史标记时）。
 *  豁免两类：
 *   · PRD 自身 —— 它就是「已知冲突必须消除」清单的**定义处**（只读，规格明令），
 *     其内出现旧值属于清单引用，不是现行结论；
 *   · 同行同时写出旧值与现行值（`| 3817 | **4588** |`）—— 自注解的映射行。 */
function obsoleteHits(line, file) {
  const out = [];
  if (file === PRD_FILE) return out;
  if (ANNOT_RE.test(line)) return out;
  for (const [oldTok, newTok] of OBSOLETE) {
    const esc = oldTok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = oldTok.endsWith('%') ? '' : '(?![0-9A-Fa-fxX])';
    if (!new RegExp(`(?<![0-9A-Fa-fxX])${esc}${tail}`).test(line)) continue;
    // 自注解：同行写出现行值 → 已对齐，合法
    const newNum = String(newTok).replace(/[^0-9.]/g, '');
    if (newNum && line.includes(newNum)) continue;
    out.push(`${oldTok}->${newTok}`);
  }
  return out;
}

/** 41 行基线原判 A 的行号集合（Q1 原文保留 → 数字是历史快照，合法）。 */
const BASELINE_A_LINES = new Set(
  (rows.baselineRows || []).filter((r) => r.originalVerdict === 'A').map((r) => r.baselineLine),
);

// 去噪后的旧值清单（日期/项目名/分节号/当前实测值都不算旧值）——G5 可失败的前提
const legacy = LEGACY;
const stored = {};
for (const n of rows.numberSources || []) stored[n.name] = n.value;
const live = measureNumberSources();
const liveMap = {};
for (const n of live) liveMap[n.name] = n.value;

const L = [];
L.push('=== U-2 数字与实测一致门禁（清单动态生成 + 白名单） ===');
L.push(`权威数字清单条数=${live.length}（measureNumberSources 机读 data/*.json，非硬编码）`);
L.push(`旧值清单=${JSON.stringify(legacy)}（PRD §5 U-2 文本机读，非硬编码份数）`);

// ① 权威数字：落盘值 vs 现测值 diff
let measureDiff = 0;
for (const name of sortedKeys(liveMap)) {
  const a = JSON.stringify(liveMap[name]);
  const b = name in stored ? JSON.stringify(stored[name]) : '(缺)';
  if (a !== b) { measureDiff += 1; L.push(`  MEASURE_DIFF ${name} 落盘=${b} 现测=${a}`); }
}
L.push(`① 权威数字落盘值 vs 现测值 diff=${measureDiff}`);

// ② 全库 .md 旧值表述冲突（动态清单 + 白名单分类后）
const conflicts = [];
const whitelistHits = {};
const pendingCarriers = {};
const driftConflicts = [];
const historicalExempt = {};
for (const f of markdownFiles()) {
  const text = readText(f);
  const lines = text.split('\n');
  const inScope = CURRENT_SCOPE_DOCS.includes(f);
  // ★ 时间维：HISTORY_SNAPSHOT（显式白名单）里的文档不做 drift 比对 —— 那里的数字是当日事实。
  const historical = isHistoricalSnapshotOf(f);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hits = legacy.filter((t) => { try { return boundaryRe(t).test(line); } catch { return false; } });
    // G5 两条独立可失败规则：① 指标锚定的精确比对（drift）② PRD 声明旧值未标注（obsolete）。
    // U-7/Q4：数字清理范围 = 6 份基线文档 + 现行 PRD；历史快照文档（按文件名）额外退出 drift。
    const drifts = (inScope && !historical) ? driftHits(line, text) : [];
    if (inScope && historical && driftHits(line, text).length) {
      // 只用于打印「本可抓到、但按时间层豁免」的条数：证明豁免真在生效且范围可见。
      // 范围外文档本来就不跑 drift，不计入，免得把「本来不管」说成「豁免」。
      historicalExempt[f] = (historicalExempt[f] || 0) + 1;
    }
    const obsoletes = inScope ? obsoleteHits(line, f) : [];
    if (!hits.length && !drifts.length && !obsoletes.length) continue;
    const inBaselineA = f === GAP_FILE && BASELINE_A_LINES.has(i + 1);
    const c = classify(f, i + 1, line, inBaselineA);
    whitelistHits[c.bucket] = (whitelistHits[c.bucket] || 0) + hits.length + drifts.length + obsoletes.length;
    if (c.carrier) {
      const key = `${c.bucket} @ ${f}`;
      pendingCarriers[key] = (pendingCarriers[key] || 0) + 1;
    }
    // ★ G5 核心：**漂移数字一律冲突**（覆盖 classify 的历史豁免）——
    //   历史文档里写「1070」合法，写成「1071」必须翻红（QA 验收口径）。
    if (drifts.length) {
      conflicts.push(`${f}:${i + 1} [drift=${drifts.join(',')}] ${line.trim().slice(0, 120)}`);
      driftConflicts.push(`${f}:${i + 1} [drift=${drifts.join(',')}]`);
      continue;
    }
    // ★ G5：PRD 明文「已知冲突必须消除」的旧值，未标历史/引用即冲突。
    //   Q1 强制的 GAP §2:41–81 原文保留行例外（历史快照）。
    const gapForced = f === GAP_FILE && i + 1 >= 41 && i + 1 <= 81;
    if (obsoletes.length && !gapForced) {
      conflicts.push(`${f}:${i + 1} [obsolete=${obsoletes.join(',')}] ${line.trim().slice(0, 120)}`);
      continue;
    }
    // ★ G5：`legacy` 清单里混入了分母（3/13/16、527/402/185、163/148/12 等），
    //   它们不是「旧值」。冲突只由 OBSOLETE（PRD 明文已知冲突）+ drift 决定。
    //   classify 仍用于统计白名单桶与载体，但**不再单独判冲突**（避免把分母误判）。
    void c;
  }
}
L.push(`② 旧值表述白名单分类=${JSON.stringify(whitelistHits)}`);
L.push(`②b U-5 历史快照数字待补顶部指向（T03/T04 载体，非本批次冲突）=${JSON.stringify(pendingCarriers)}`);
// ②c 时间层分区（显式分类，逐份打印，不静默）：
//    这些行本来会被 drift 抓到，但所在文档属于 HISTORY_SNAPSHOT（当日事实）。
//    豁免**必须有出处**（显式白名单），不能靠模式推断 —— 否则判错方向就是静默变绿。
const scopeSet = new Set(CURRENT_SCOPE_DOCS);
const neverSet = new Set(NEVER_EXEMPT);
const histSet = new Set(HISTORY_SNAPSHOT);

// 分区断言①：不漏（在册但未分类）/ 不重（同时归两集）/ 不越界（分类了但不在册）
const unclassified = CURRENT_SCOPE_DOCS.filter((f) => !neverSet.has(f) && !histSet.has(f));
const dualClassed = NEVER_EXEMPT.filter((f) => histSet.has(f));
const offScope = [...new Set([...neverSet, ...histSet])].filter((f) => !scopeSet.has(f));
const partitionOk = unclassified.length === 0 && dualClassed.length === 0 && offScope.length === 0;

// 分区断言②：TAKEOVER 不得出现在 HISTORY_SNAPSHOT（结构性，不靠函数里的 if 兜着）
const takeoverInHist = histSet.has(TAKEOVER_FILE);
const takeoverExempted = isHistoricalSnapshotOf(TAKEOVER_FILE);
const takeoverInScope = scopeSet.has(TAKEOVER_FILE);
const liveDocOk = takeoverInHist === false && takeoverExempted === false && takeoverInScope === true;

const exemptRows = Object.values(historicalExempt).reduce((s, n) => s + n, 0);
const exemptFiles = Object.keys(historicalExempt).length;
const liveDocs = CURRENT_SCOPE_DOCS.filter((f) => !histSet.has(f));

L.push('②c 历史快照文档（显式白名单 HISTORY_SNAPSHOT，不参与 drift；豁免必须有出处，不能靠模式推断）');
L.push(`   NEVER_EXEMPT 现行权威（${NEVER_EXEMPT.length} 份，永不豁免）= ${JSON.stringify(NEVER_EXEMPT)}`);
L.push(`   HISTORY_SNAPSHOT 一次性留痕（${HISTORY_SNAPSHOT.length} 份，不增长）= ${JSON.stringify(HISTORY_SNAPSHOT)}`);
L.push(`   已豁免行数（本可被 drift 抓到、因时间层放行）=${JSON.stringify(historicalExempt)}`);
L.push(`   合计 ${exemptRows} 行 / ${exemptFiles} 个文件；现行受检文档 ${liveDocs.length} 个 = ${JSON.stringify(liveDocs)}`);
L.push(`U2_DOC_PARTITION 在册文档 ${CURRENT_SCOPE_DOCS.length} 份完整划分`
  + `：未分类=${JSON.stringify(unclassified)}｜同时归两集=${JSON.stringify(dualClassed)}`
  + `｜分类了但不在册=${JSON.stringify(offScope)}`);
if (!partitionOk) {
  L.push('  FAIL U2_DOC_PARTITION 在册文档未被完整、互斥地划分为「现行」与「历史快照」两集');
}
L.push(`U2_TOKEOVER_NEVER_EXEMPT TAKEOVER.md：在 HISTORY_SNAPSHOT 内=${takeoverInHist}（必须 false）`
  + `｜实际被豁免=${takeoverExempted}（必须 false）｜在 CURRENT_SCOPE_DOCS 内=${takeoverInScope}（必须 true）`);
if (!liveDocOk) L.push('  FAIL U2_TOKEOVER_NEVER_EXEMPT 活文档 TAKEOVER.md 被时间层豁免或掉出受检范围');

for (const c of conflicts) L.push(`  CONFLICT ${c}`);
L.push(`③ 文档数字 diff=${conflicts.length}`);

// ── T04-d：三个断言名落地为实跑行为断言（动态清单，不硬编码份数）──────────
{
  // U2_D5_13873：遍历 data/models/* 实际统计 maxText 现值条目
  const { readdirSync: rd, statSync: st } = await import('node:fs');
  const { join: pj } = await import('node:path');
  let maxTextCount = 0;
  const walkModels = (dir) => {
    for (const name of rd(dir).sort()) {
      const full = pj(dir, name);
      if (st(full).isDirectory()) { walkModels(full); continue; }
      if (!name.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(readText(full) || '{}');
        for (const it of (doc.items || [])) if (it.maxText != null) maxTextCount += 1;
      } catch { /* 非结构化文件不计 */ }
    }
  };
  walkModels('data/models');
  L.push(`U2_D5_13873 实跑：data/models/* 的 maxText 现值条目=${maxTextCount}/13873`
    + `（display 按位宽表达，数据现值一字未改）`);
  const d5Ok = maxTextCount === 13873;

  // U2_NAMESPACE_SEPARATED：三命名空间独立，实读 routines-verified.json
  const rv = readJson('data/routines-verified.json');
  const ns = rv?.namespaces || {};
  L.push(`U2_NAMESPACE_SEPARATED 实跑：menuId=${ns.menuId}/67 RID=${ns.rid}/79`
    + ` 功能序列=${ns.functionSequence}/687（vendorExtPseudoRids=${rv?.vendorExtPseudoCount}，旧报告 45 为历史口径）`);
  const nsOk = ns.menuId === 67 && ns.rid === 79 && ns.functionSequence === 687;

  // U2_NUMBER_DIFF_ZERO：权威清单落盘值 vs 现测值 + 文档冲突合计
  L.push(`U2_NUMBER_DIFF_ZERO 实跑：权威数字 diff=${measureDiff} 文档冲突=${conflicts.length}`
    + ` 合计=${measureDiff + conflicts.length}（清单 ${live.length} 项动态机读）`);
  const diffOk = measureDiff + conflicts.length === 0;

  globalThis.__u2BehaviorOk = d5Ok && nsOk && diffOk && liveDocOk && partitionOk;
  if (!d5Ok) L.push('  FAIL U2_D5_13873 maxText 实跑值与 13873 不符');
  if (!nsOk) L.push('  FAIL U2_NAMESPACE_SEPARATED 三命名空间计数与 67/79/687 不符');
  if (!diffOk) L.push('  FAIL U2_NUMBER_DIFF_ZERO 存在数字冲突');
  if (!liveDocOk) L.push('  FAIL U2_TOKEOVER_NEVER_EXEMPT 活文档豁免/掉范围');
  if (!partitionOk) L.push('  FAIL U2_DOC_PARTITION 分区不完整或两集重叠');
  // 行为断言直接并入退出码：任一翻红即非 0（反例注入可证伪）
  L.push(`U2 行为断言合计：d5Ok=${d5Ok} nsOk=${nsOk} diffOk=${diffOk}`
    + ` liveDocOk=${liveDocOk} partitionOk=${partitionOk}`);
}
L.push('说明：分母各自标源——3/13/16（候选分组）、527/402/185（cat=0x10 / cat=0x60）、120/40（family-default / 共享 16 候选）、163/148/12（身份链）、74/111（帧序口径 / commCat10Exact）、67/79/687（menuId / 通信 RID / 功能序列）、13873/153/119657（D-5 / D-3 长度 / D-3 itemIds）互不替代。');
L.push('复跑命令：node tools/verify-u2-numbers.mjs ; node tools/build-align431-rows.mjs ; npm run audit:align431');
const diff = measureDiff + conflicts.length;
const behaviorOk = globalThis.__u2BehaviorOk !== false;
L.push(`结论：U-2 数字 diff=${diff}，行为断言=${behaviorOk ? 'PASS' : 'FAIL'}，退出码=${diff === 0 && behaviorOk ? 0 : 1}`);
process.stdout.write(L.join('\n') + '\n');
process.exit(diff === 0 && behaviorOk ? 0 : 1);
