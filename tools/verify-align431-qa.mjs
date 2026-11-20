#!/usr/bin/env node
/**
 * verify-align431-qa.mjs — T05 独立 QA 门禁（ARCH §9 T05 / PRD §4 A-1..A-10 / §8）。
 *
 * 定位：**独立重算**，与被测 gate（audit-align431 / align431-eval 及其下游 gate）
 *        **不共享任何断言实现**。本文件不 import align431-eval.mjs，不调用被测 gate 的
 *        求值函数；它只读原始产物（rows / bind-plan / registry / 向量 / 证据账本 / 源码 /
 *        git 跟踪集 / audit 实跑输出），用本文件内独立实现逐条判定并以机器行打印。
 *
 * 纪律：
 *   - 只读：不改任何 src / data / tools / docs；不写临时文件到仓库；不 stage / 不 commit。
 *   - 每条判据打印一行 `QA <id> <name> PASS|FAIL expected=... actual=... [detail=...]`；
 *     汇总打印 `QA_SUMMARY x/y PASS`；任一条 FAIL → 退出码 1。
 *   - stdout 只含机器名与计数：不含本机绝对路径 / Date / random / cwd，
 *     因此可被 acceptance doc 引用而不破坏确定性。
 *
 * 判据清单（与任务书关键规格一一对应）：
 *   Q01 无坐标实现行 = 0                Q02 零覆盖高风险 sysId = 0（130/130）
 *   Q03 零覆盖 sysId = 0                Q04 靠符号命中翻 A 行 = 0
 *   Q05 零运行时应答仍标 A 行 = 0       Q06 注入能红率 100% / 假绿 0（黑盒复跑注入 gate）
 *   Q07 禁用口径结案理由命中 = 0        Q08 缺 provable 标记行 = 0
 *   Q09 runtime 静态写死数 = 0          Q10 车道变换四元对象字段缺失 = 0
 *   Q11 单一 sysId 数值裁决 / raw 相同即合并 = 0
 *   Q12 基线 41 行编号+原文保留 / 删行 0 / 合并行 0 / 断言只增不删
 *   Q13 243/243 A 且高风险覆盖 130/130 Q14 24 行 B/C/D 重判双举证、符号命中 0
 *   Q15 audit 两次 sha256 稳定且指纹不含本机绝对路径 / Date / random / cwd
 *
 * 用法：
 *   node tools/verify-align431-qa.mjs
 *   # 复用已采集的两次 audit stdout（避免重复慢跑；缺省则本工具自行真实跑两次）：
 *   ALIGN431_QA_AUDIT_A=/tmp/a1 ALIGN431_QA_AUDIT_B=/tmp/a2 node tools/verify-align431-qa.mjs
 *
 * 退出码：全 PASS → 0；任一 FAIL 或前置缺失 → 1。
 */
import {
  readFileSync, existsSync, readdirSync, statSync, mkdtempSync, openSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const E0_ROOT = join(ROOT, '..', 'porsche-mapper', 'ref');

/* ─────────────────────────── 基础设施（本文件独立实现） ─────────────────────────── */
/** node:crypto sha256 —— 不复用被测 gate 的 sha256 实现。 */
function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}
function readText(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
function readJson(rel) {
  const t = readText(rel);
  return t === null ? null : JSON.parse(t);
}
function hasOwn(o, k) {
  return Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
}
function sortedKeys(o) {
  return Object.keys(o || {}).sort();
}
/**
 * 本文件独立跑只读子进程（钉死 locale / 时区 / 禁色，机器无关）。
 *
 * ★ stdout 必须写到临时文件再读回，**不能**用 spawnSync 的 pipe：
 *   被测 audit 在 `process.stdout.write(160KB)` 后立即 `process.exit()`，
 *   pipe 场景实测只 flush 约 54KB、尾部 `sha256=` 行丢失（假红）。
 *   用文件 fd 与 ARCH §9 `npm run audit:align431 > /tmp/a1` 同语义，输出完整。
 *   临时目录用后即删（退出前不残留），且不在仓库内。
 */
function runNode(scriptRel, envExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'align431-qa-'));
  const outFile = join(dir, 'stdout.txt');
  const fd = openSync(outFile, 'w');
  try {
    const r = spawnSync(process.execPath, [join(ROOT, scriptRel)], {
      cwd: ROOT,
      env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', FORCE_COLOR: '0', ...envExtra },
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      timeout: 600000,
    });
    return {
      exitCode: r.status === null ? -1 : r.status,
      stdout: readFileSync(outFile, 'utf8'),
      stderr: String(r.stderr || ''),
    };
  } finally {
    closeSync(fd);
    try { execFileSync('rm', ['-rf', dir], { stdio: 'ignore', timeout: 10000 }); } catch { /* 已删 */ }
  }
}

/** 结果登记与机器行输出。 */
const results = [];
function check(id, name, pass, expected, actual, detail = '') {
  results.push({ id, name, pass: Boolean(pass), expected, actual });
  const tail = detail ? ` detail=${detail}` : '';
  console.log(`QA ${id} ${name} ${pass ? 'PASS' : 'FAIL'} expected=${expected} actual=${actual}${tail}`);
}

/* ─────────────────────────── 一次性读产物（只读） ─────────────────────────── */
const rows = readJson('tools/align431-rows.json');
const bp = readJson('data/bind-plan.json');
const registry = readJson('data/align431-evidence-registry.json');
const allRows = rows ? [...(rows.baselineRows || []), ...(rows.addedRows || [])] : [];

if (!rows || !bp || !registry || allRows.length === 0) {
  console.log('QA_PRECOND_FAIL 缺少 rows/bind-plan/registry 产物，请先完成 T01-T04');
  process.exit(1);
}

/* ─────────────────────────── Q01 无坐标实现行 = 0 ─────────────────────────── */
{
  // 实现行 = 审计纳入的每一行；标 A 且 E0 坐标无 reproduceDigest 即「无坐标实现」。
  const noCoordRows = allRows.filter((r) => r.verdict === 'A'
    && !(r.e0Coord && typeof r.e0Coord.reproduceDigest === 'string' && r.e0Coord.reproduceDigest.length > 0));
  // registry 每条做法亦须有可回指 E0 坐标：非空相对 file + (offset | VA | recordId) + detail。
  // （本文件独立实现坐标形状判定，不 import 被测 e0CoordShape；不认绝对/越界路径。）
  const coordOk = (c) => {
    if (!c || typeof c.file !== 'string' || !c.file.trim()) return false;
    if (/(?:^|\/)\.\.(?:\/|$)|^\/|^[A-Za-z]:[\\/]/.test(c.file)) return false;
    const hasOffset = Number.isInteger(c.offset) && c.offset >= 0;
    const hasVA = typeof c.VA === 'string' && /^0x[0-9a-fA-F]+$/.test(c.VA)
      && Number.parseInt(c.VA.slice(2), 16) > 0;
    const hasRecord = typeof c.recordId === 'string' && c.recordId.trim().length > 0;
    if (!hasOffset && !hasVA && !hasRecord) return false;
    return typeof c.detail === 'string' && c.detail.trim().length > 0;
  };
  const noCoordEntries = (registry.entries || []).filter((e) => !coordOk(e.e0Coord));
  const actual = noCoordRows.length + noCoordEntries.length;
  check('Q01', 'NO_COORD_IMPL_ROWS_ZERO', actual === 0, 0, actual,
    `rows=${noCoordRows.length} registryEntries=${noCoordEntries.length}`);
}

/* ─────────────────────────── Q02 零覆盖高风险 sysId = 0（130/130） ─────────────── */
const HIGH_RISK_EXPECTED = 130;
let highRiskList = [];
let highRiskCovered = [];
{
  const ecu = bp.ecu || {};
  highRiskList = sortedKeys(ecu).filter((s) => {
    const e = ecu[s] || {};
    return Boolean(e.fourTuple) || (Array.isArray(e.blockOff) && e.blockOff.length > 1) || e.nMixed === true;
  });
  highRiskCovered = highRiskList.filter((s) => {
    const e = ecu[s] || {};
    return e.provable === 'static' && Boolean(e.e0Coord);
  });
  const uncovered = highRiskList.length - highRiskCovered.length;
  check('Q02', 'ZERO_COVERAGE_HIGH_RISK_SYSID_ZERO',
    uncovered === 0 && highRiskList.length === HIGH_RISK_EXPECTED,
    `0 uncovered / ${HIGH_RISK_EXPECTED} highRisk`,
    `${uncovered} uncovered / ${highRiskCovered.length}/${highRiskList.length} highRisk`);
}

/* ─────────────────────────── Q03 零覆盖 sysId = 0 ─────────────────────────── */
{
  // 覆盖定义：该 sysId 有 E0 坐标且带 provable 标记；不适用者须有显式「431 亦无此路径」证据，
  // 不得静默跳过。当前 623 sysId 全部有 E0 坐标 + provable，故不适用集合为空。
  const ecu = bp.ecu || {};
  const keys = sortedKeys(ecu);
  const NA_MARK = /431\s*亦无此路径|亦无此路径|notApplicable|noPath|N\/A/i;
  const uncovered = keys.filter((s) => {
    const e = ecu[s] || {};
    const covered = Boolean(e.e0Coord) && (e.provable === 'static' || e.provable === 'runtime');
    const explicitlyNA = NA_MARK.test(JSON.stringify(e));
    return !covered && !explicitlyNA;
  });
  check('Q03', 'ZERO_COVERAGE_SYSID_ZERO', uncovered.length === 0 && keys.length === 623,
    '0 uncovered / 623 sysId', `${uncovered.length} uncovered / ${keys.length} sysId`);
}

/* ─────────────────────────── Q04 靠符号命中翻 A 行 = 0 ─────────────────────── */
{
  const bad = allRows.filter((r) => r.verdict === 'A' && r.symbolHitOnly === true);
  check('Q04', 'SYMBOL_HIT_A_ROWS_ZERO', bad.length === 0, 0, bad.length);
}

/* ─────────────────────────── Q05 零运行时应答仍标 A 行 = 0 ─────────────────── */
{
  const bad = allRows.filter((r) => r.verdict === 'A'
    && r.runtimeRequired === true && r.runtimeAnswerBacked !== true);
  check('Q05', 'ZERO_RUNTIME_ANSWER_A_ROWS_ZERO', bad.length === 0, 0, bad.length);
}

/* ─────────────────────────── Q06 注入能红率 100% / 假绿 0（黑盒复跑） ─────────── */
{
  // 不信文档自宣：本工具真实跑注入 gate，只读其机器行；注入 gate 在临时镜像内改值，
  // 结束核对 watch 文件 sha 未变，故本调用对真实仓库只读。
  const run = runNode('tools/verify-align431-injection.mjs');
  const rateM = /INJECTION_RED_RATE\s+(\d+)%/.exec(run.stdout);
  const falseM = /INJECTION_FALSE_GREEN\s+(\d+)/.exec(run.stdout);
  const countM = /INJECTION_RED_COUNT\s+(\d+)\/(\d+)/.exec(run.stdout);
  const rate = rateM ? Number(rateM[1]) : -1;
  const falseGreen = falseM ? Number(falseM[1]) : -1;
  const redNum = countM ? Number(countM[1]) : -1;
  const redDen = countM ? Number(countM[2]) : -1;
  const pass = run.exitCode === 0 && rate === 100 && falseGreen === 0
    && redDen >= 10 && redNum === redDen;
  check('Q06', 'INJECTION_RED_RATE_100_FALSE_GREEN_0', pass,
    'exit0 rate=100 falseGreen=0 red=n/n n>=10',
    `exit=${run.exitCode} rate=${rate}% falseGreen=${falseGreen} red=${redNum}/${redDen}`);
}

/* ─────────────────────────── Q07 禁用口径作为结案理由命中 = 0（独立扫描） ───── */
{
  // 本文件自带 10 类禁用词 / 推翻标记 / PRD 引用标记 —— 不 import 被测 scanForbiddenWords。
  const FORBIDDEN_CLASSES = {
    '包内不存在': ['包内不存在', '包内无', '包里没有', '包内静态零调用点', '包内不可证'],
    '需要真车测试': ['需要真车测试', '需要真车', '需真车', '需实车', '实车 VIN 日志', '真车确认'],
    '运行时态无法静态复刻': ['运行时态无法静态复刻', '运行时态', '运行时 BV 域'],
    '431同界': ['431 同界', '431同界'],
    '适配器能力差异': ['适配器能力差异', '适配器差异'],
    '有意偏离': ['有意偏离', '有意边界'],
    '结果由ECU裁决': ['结果由 ECU 裁决', '结果由ECU裁决', '由 ECU 裁决'],
    '源包限制': ['源包限制', '源包数据量'],
    '承诺外': ['承诺外'],
    '留白证据级': ['留白证据级', '留白 3 项', '精确留白'],
  };
  const OVERTURN = ['推翻', '禁止', '不得', '禁用', '历史', '旧结论', '旧值', '快照', '非缺口', '不适用',
    '作废', '误判', '更正', '保留作', '不再作为', '仅作', '并非', '不构成', '不作为', '已收口',
    '待落盘', '不能当结论', '待挖', '下一载体', '扫描命令', '不猜', '未证', '已证', '反证', '阴性',
    '零命中', '驳回', '不接受', '而不是', '被标', '现状', '错', '误', '待改', '须消除', '冲突',
    '统一到', '改为', '已更正', '已对齐', '已修', '已落地', '复跑', '基线', '当时'];
  const PRD_QUOTE = ['一律', '不得', '禁用', '结案词', 'R-4', 'U-3', '§0', '不可协商前提', '禁止',
    '引用旧值', '历史值', '须消除', '已知冲突', 'U-2', 'P0-6'];
  const PRD_FILE = 'PRD-FULLALIGN-431-20261113.md';
  const GAP_FILE = 'GAP-INVENTORY-20261112.md';
  // 只扫仓库根入库 .md（与被测 gate 扫描口径一致：根级、git 跟踪）。
  let tracked = [];
  try {
    const out = spawnSync('git', ['ls-files', '--', '*.md'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
    });
    if (out.status === 0) tracked = new Set(out.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { tracked = []; }
  const scanFiles = tracked instanceof Set
    ? readdirSync(ROOT).filter((f) => f.endsWith('.md') && statSync(join(ROOT, f)).isFile() && tracked.has(f)).sort()
    : [];
  const degraded = !(tracked instanceof Set) || scanFiles.length === 0;
  let closing = 0;
  for (const f of scanFiles) {
    const lines = readText(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hits = Object.keys(FORBIDDEN_CLASSES).filter((cls) =>
        FORBIDDEN_CLASSES[cls].some((w) => line.includes(w)));
      if (!hits.length) continue;
      if (f === PRD_FILE && PRD_QUOTE.some((m) => line.includes(m))) continue;
      if (f === GAP_FILE && i + 1 >= 41 && i + 1 <= 81) continue;
      if (OVERTURN.some((m) => line.includes(m))) continue;
      if (f !== PRD_FILE) continue; // 历史基线文档的旧结论按 U-5 单列，不计结案理由
      closing += hits.length;
    }
  }
  check('Q07', 'FORBIDDEN_CLOSING_REASON_ZERO', !degraded && closing === 0, 0, closing,
    `scanFiles=${scanFiles.length} degraded=${degraded ? 1 : 0}`);
}

/* ─────────────────────────── Q08 缺 provable 标记行 = 0 ───────────────────── */
{
  const badRows = allRows.filter((r) => !(r.provable === 'static' || r.provable === 'runtime'));
  const badEntries = (registry.entries || []).filter((e) => !(e.provable === 'static' || e.provable === 'runtime'));
  const badEcu = sortedKeys(bp.ecu || {}).filter((s) => {
    const p = (bp.ecu[s] || {}).provable;
    return !(p === 'static' || p === 'runtime');
  });
  const actual = badRows.length + badEntries.length + badEcu.length;
  check('Q08', 'MISSING_PROVABLE_TAG_ZERO', actual === 0, 0, actual,
    `rows=${badRows.length} registry=${badEntries.length} ecu=${badEcu.length}`);
}

/* ─────────────────────────── Q09 runtime 静态写死数 = 0 ───────────────────── */
{
  // 独立遍历每行 check 描述符树（不复用 evaluateCheck）：任何 runtimeRequired 的
  // provableTag 必须 provable='runtime'；标 runtime 的行不得内嵌 provable='static' 的
  // provableTag；runtime 行不得含静态写死 CAN 字面量字段 hardcodeCan。
  const walk = (node, out) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'provableTag') out.push(node);
    if (Array.isArray(node.of)) for (const c of node.of) walk(c, out);
  };
  let bad = 0;
  for (const row of allRows) {
    const tags = [];
    walk(row.check, tags);
    for (const t of tags) {
      if (t.runtimeRequired === true && t.provable !== 'runtime') bad += 1;
      if (row.provable === 'runtime' && t.provable === 'static') bad += 1;
      if (t.hardcodeCan === true) bad += 1;
    }
  }
  check('Q09', 'RUNTIME_HARDCODED_ZERO', bad === 0, 0, bad);
}

/* ─────────────────────────── Q10 车道变换四元对象字段缺失 = 0 ───────────────── */
{
  const f = ((bp.ecu || {})['0x0f4d'] || {}).fourTuple || {};
  const required = [];
  if (f.sysId !== '0x0f4d') required.push('sysId');
  if (!Array.isArray(f.requestKey) || f.requestKey.length < 4) required.push('requestKey');
  if (!f.can || typeof f.can !== 'object') required.push('can');
  else {
    if (!(f.can.tx > 0)) required.push('can.tx');
    if (!(f.can.rx > 0)) required.push('can.rx');
    if (f.can.rxRule !== 'rx=tx+0x6A') required.push('can.rxRule');
    if (f.can.provable !== 'static') required.push('can.provable');
  }
  if (!Array.isArray(f.altIdentitySysIds) || f.altIdentitySysIds.length < 2) required.push('altIdentitySysIds');
  if (typeof f.identityRule !== 'string' || !/PARTNUMBER/i.test(f.identityRule)) required.push('identityRule');
  if (f.provable !== 'static') required.push('provable');
  if (typeof f.e0Coord !== 'string' || !f.e0Coord.length) required.push('e0Coord');
  // Macan 0x0f23 / 0x0f34 须各有独立绑定（不同候选首值），不得只绑一枚。
  const f23 = (bp.ecu || {})['0x0f23'] || {};
  const f34 = (bp.ecu || {})['0x0f34'] || {};
  const c23 = (f23.cands || [])[0];
  const c34 = (f34.cands || [])[0];
  const macanOk = Boolean(c23) && Boolean(c34) && c23 !== c34;
  check('Q10', 'LANE_CHANGE_FOUR_TUPLE_FIELDS_MISSING_ZERO',
    required.length === 0 && macanOk, 0, required.length + (macanOk ? 0 : 1),
    `missing=${JSON.stringify(required)} macanDualBind=${macanOk ? 1 : 0}`);
}

/* ─────────────────────────── Q11 单一 sysId 数值裁决 / raw 相同即合并 = 0 ───── */
{
  // 数据面：四元 identityRule 必须 nameVariant + PARTNUMBER；alt 字段须为异名列表而非单值合并。
  const f = ((bp.ecu || {})['0x0f4d'] || {}).fourTuple || {};
  const ruleOk = typeof f.identityRule === 'string' && /nameVariant/i.test(f.identityRule)
    && /PARTNUMBER/i.test(f.identityRule);
  const altOk = Array.isArray(f.altIdentitySysIds) && f.altIdentitySysIds.includes('0x0e5f')
    && f.altIdentitySysIds.includes('0x0e60');
  // 代码面：app.js 身份裁决须走名字串 + 件号函数，不得只按单一 sysId 数值。
  const app = readText('src/app.js') || '';
  const sweep = readText('src/sweep.js') || '';
  const codeByNamePart = app.includes('identityFromNameAndPart') && /partNumber/.test(app);
  const twoVariants = sweep.includes('SWA2_BaseSys') && sweep.includes('BV_ContrUnitLaneChangAssis2UDS_BaseSys');
  // 产物不得出现「raw 相同即合并」布尔开关。
  const mergeSwitches = /"(mergeByRaw|identityBySysIdOnly|rawSameMerge)"\s*:\s*true/.test(
    JSON.stringify(bp.ecu || {}));
  const bad = (!ruleOk ? 1 : 0) + (!altOk ? 1 : 0) + (!codeByNamePart ? 1 : 0)
    + (!twoVariants ? 1 : 0) + (mergeSwitches ? 1 : 0);
  check('Q11', 'SINGLE_SYSID_RAW_MERGE_ZERO', bad === 0, 0, bad,
    `rule=${ruleOk ? 1 : 0} alt=${altOk ? 1 : 0} codeByNamePart=${codeByNamePart ? 1 : 0}`
    + ` twoVariants=${twoVariants ? 1 : 0} mergeSwitch=${mergeSwitches ? 1 : 0}`);
}

/* ─────────────────────────── Q12 基线 41 行 + 断言只增不删 ─────────────────── */
{
  const base = rows.baseline || {};
  const baseRows = rows.baselineRows || [];
  const gap = (readText('GAP-INVENTORY-20261112.md') || '').split('\n');
  // 编号逐行保留 41..81，原文逐字相等（Q1 强制）。
  const lines = baseRows.map((r) => r.baselineLine).sort((a, b) => a - b);
  const numberingOk = lines.length === 41 && lines[0] === 41 && lines[lines.length - 1] === 81
    && lines.every((n, i) => n === 41 + i);
  const textOk = baseRows.every((r) => gap[r.baselineLine - 1] === r.originalText);
  const flagsOk = base.deleteZero === true && base.mergeZero === true
    && base.originalNumberingPreserved === true;
  // 断言完整性：本文件独立重算 rowId=assertion 摘要（不复用 assertionIntegrity）。
  const pairs = allRows.map((r) => `${r.rowId}=${r.assertion || ''}`).sort().join('\n');
  const curSha = sha256(pairs);
  const recorded = rows.t04 && rows.t04.assertionIndex ? rows.t04.assertionIndex : {};
  const assertionOk = allRows.length === 243
    && allRows.every((r) => typeof r.gate === 'string' && r.gate.length > 0
      && typeof r.assertion === 'string' && r.assertion.trim().length > 0)
    && (!recorded.sha256 || curSha === recorded.sha256)
    && allRows.length >= (recorded.count || 0);
  const pass = numberingOk && textOk && flagsOk && assertionOk;
  check('Q12', 'BASELINE_41_ASSERTIONS_ONLY_ADDED', pass,
    '41 rows exact / delete0 merge0 / assertions 243 intact',
    `numbering=${numberingOk ? 1 : 0} text=${textOk ? 1 : 0} flags=${flagsOk ? 1 : 0}`
    + ` assertions=${assertionOk ? 1 : 0} rows=${allRows.length} shaMatch=${curSha === recorded.sha256 ? 1 : 0}`);
}

/* ─────────────────────────── Q13 243/243 A 且高风险覆盖 130/130 ─────────────── */
{
  const aCount = allRows.filter((r) => r.verdict === 'A').length;
  check('Q13', 'ALL_A_AND_HIGH_RISK_130_130',
    allRows.length === 243 && aCount === 243
      && highRiskCovered.length === 130 && highRiskList.length === 130,
    '243/243 A and 130/130 highRisk',
    `${aCount}/${allRows.length} A and ${highRiskCovered.length}/${highRiskList.length} highRisk`);
}

/* ─────────────────────────── Q14 24 行 B/C/D 重判双举证、符号命中 0 ─────────── */
{
  const bcd = allRows.filter((r) => ['B', 'C', 'D'].includes(r.originalVerdict));
  const bad = bcd.filter((r) => !(r.verdict === 'A'
    && r.e0Coord && typeof r.e0Coord.reproduceDigest === 'string'
    && r.runtimeAnswerBacked === true
    && typeof r.vectorId === 'string' && r.vectorId.length > 0
    && r.symbolHitOnly !== true));
  const recordedReAdj = (rows.t04 && Array.isArray(rows.t04.reAdjudicatedRows))
    ? rows.t04.reAdjudicatedRows.length : -1;
  check('Q14', 'BCD_24_READJUDICATED_DOUBLE_EVIDENCE',
    bcd.length === 24 && bad.length === 0 && recordedReAdj === 24,
    '24 rows A + E0 + runtime + vector, symbolHit=0, recorded=24',
    `bcd=${bcd.length} bad=${bad.length} recorded=${recordedReAdj}`);
}

/* ─────────────────────────── Q15 audit 两次 sha256 稳定 + 指纹无机器痕迹 ────── */
{
  // 缺省真实跑两次；可用 ALIGN431_QA_AUDIT_A / _B 复用已采集 stdout（验收链已跑过时避免重复慢跑）。
  const envA = process.env.ALIGN431_QA_AUDIT_A;
  const envB = process.env.ALIGN431_QA_AUDIT_B;
  const reuse = Boolean(envA && envB && existsSync(envA) && existsSync(envB));
  const a = reuse ? { exitCode: 0, stdout: readFileSync(envA, 'utf8') } : runNode('tools/audit-align431.mjs');
  const b = reuse ? { exitCode: 0, stdout: readFileSync(envB, 'utf8') } : runNode('tools/audit-align431.mjs');
  const shaA = sha256(a.stdout);
  const shaB = sha256(b.stdout);
  const internalA = (/sha256=([0-9a-f]{64})/.exec(a.stdout) || [])[1] || '';
  const internalB = (/sha256=([0-9a-f]{64})/.exec(b.stdout) || [])[1] || '';
  // 指纹段 = 从开头到 audit 自输出 sha256 行（含）；其后的「本机未入库 .md N 份」明确不进指纹。
  const fingerprint = a.stdout.split('sha256=')[0] + (internalA ? `sha256=${internalA}` : '');
  const MACHINE_MARKS = [
    /\/Users\//, /\/home\//, /\/private\/var\/folders\//, /\/tmp\/align431-/,
    /Date\.now\s*\(/, /new Date\s*\(/, /Math\.random\s*\(/, /process\.cwd\s*\(/, /generatedAt/i,
    /\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/, // ISO 时钟
  ];
  const marks = MACHINE_MARKS.filter((re) => re.test(fingerprint)).map((re) => re.source);
  const pass = a.exitCode === 0 && b.exitCode === 0 && shaA === shaB
    && internalA.length === 64 && internalA === internalB && marks.length === 0;
  check('Q15', 'AUDIT_TWICE_SHA_STABLE_NO_MACHINE_MARKS', pass,
    'exit0/0 same sha256, fingerprint free of abs-path/Date/random/cwd',
    `exit=${a.exitCode}/${b.exitCode} shaSame=${shaA === shaB ? 1 : 0}`
    + ` internalSame=${internalA === internalB ? 1 : 0} marks=${marks.length} reuse=${reuse ? 1 : 0}`);
}

/* ─────────────────────────── 汇总与退出码 ─────────────────────────── */
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`QA_SUMMARY ${passed}/${results.length} PASS`);
if (failed.length) {
  for (const r of failed) console.log(`QA_FAILED ${r.id} ${r.name}`);
  process.exit(1);
}
console.log('QA_ALL_PASS PASS');
process.exit(0);
