#!/usr/bin/env node
/**
 * verify-align431-injection.mjs — T04 可证伪注入自检（ARCH §5.4 十类）。
 *
 * 纪律：
 *   - 每类注入都发生在 mkdtemp 临时镜像（顶层软链接 + 少量覆写文件）或内存对象里，
 *     **绝不修改真实仓库**；镜像用后即删，结束再核对关键文件 sha256 未变。
 *   - 注入后对应断言必须转红（gate stdout 出现 `FAIL <断言名>` 且退出非 0，
 *     或共享内核返回 ok:false）；全绿基线必须为真，假绿计数必须为 0。
 *   - 输出只含机器名与计数，绝不含临时路径 / 时钟 / cwd / 随机值，
 *     因此 audit 把它作为 gate 执行后 sha256 仍然稳定。
 *
 * 用法：node tools/verify-align431-injection.mjs
 * stdout：`INJECT <序号> <类名> RED <断言> ...` / `INJECTION_RED_RATE 100%` 等。
 */
import {
  mkdtempSync, symlinkSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  copyFileSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, E0_ROOT, digest, readJson, assertionIntegrity, evaluateE0Vector,
  evaluateRuntimeVector, evaluateProvableTag, readVector, REGISTRY_FILE,
} from './align431-eval.mjs';

const REAL_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
// .git 必须软链接进镜像：builder 的 IMPL_LANDED_NO_LOCAL_ONLY_CARRIER 要用
// `git ls-files --error-unmatch` 验证依赖确实入库（只读操作，不改真实 .git）。
const SKIP_TOP = new Set(['data', 'src', 'tools', 'www', 'node_modules']);
// ★ 阶段 E：7 组 mustReplay 向量的 manifest/expected/replay + 来源文件全部钉住。
// 任何一组字节被改（含只改 expected/replay 不改 sha）都必须在结束核对时转红。
const VECTOR_IDS_FOR_WATCH = [
  'REPLAY_DME', 'REPLAY_IC', 'REPLAY_718', 'REPLAY_PSM', 'REPLAY_BCM',
  'REPLAY_REALCAR981_BCM', 'REPLAY_SIM991_IC',
];
const WATCH_FILES = [
  'data/bind-plan.json', 'data/comm-addr-table.json', 'data/align431-evidence-registry.json',
  'tools/align431-rows.json', 'tools/verify-live-map-failclosed.mjs', 'src/live-map.js',
  ...VECTOR_IDS_FOR_WATCH.flatMap((id) => [
    `tools/align431-vectors/${id}.json`,
    `tools/align431-vectors/${id}.expected.json`,
    `tools/align431-vectors/${id}.replay.json`,
  ]),
  ...['REPLAY_DME', 'REPLAY_IC', 'REPLAY_718', 'REPLAY_PSM', 'REPLAY_BCM']
    .map((id) => `tools/align431-vectors/${id}.source.json`),
  'docs/realcar/2026-11-20-981-BCM-hinten-v080.txt',
  'docs/realcar/2026-11-20-991-IC-sim-v080.txt',
];

/** @type {{id:string,name:string,assertion:string,red:boolean,green:boolean}[]} */
const results = [];
/** @type {string[]} */
const failures = [];

/** 关键文件基线摘要（结束必须完全相等）。 */
const watchBefore = new Map(WATCH_FILES.map((rel) => [rel, digest(readFileSync(join(REAL_ROOT, rel), 'utf8'))]));

/** 建临时镜像：除 data/src/tools/www 外全部软链接，目录内逐项软链接。 */
function makeOverlay() {
  const root = mkdtempSync(join(tmpdir(), 'align431-inj-'));
  for (const name of readdirSync(REAL_ROOT)) {
    if (SKIP_TOP.has(name)) continue;
    try { symlinkSync(join(REAL_ROOT, name), join(root, name)); } catch { /* 已存在则跳过 */ }
  }
  for (const dir of ['data', 'src', 'tools']) {
    mkdirSync(join(root, dir));
    for (const name of readdirSync(join(REAL_ROOT, dir))) {
      try { symlinkSync(join(REAL_ROOT, dir, name), join(root, dir, name)); } catch { /* 已存在 */ }
    }
  }
  mkdirSync(join(root, 'www'));
  symlinkSync(join(REAL_ROOT, 'www', 'data'), join(root, 'www', 'data'));
  return root;
}

/**
 * 删除镜像。用 shell `rm -rf`（不跟随软链接）而不是 fs.rmSync：
 * 本机沙箱里 fs.rmSync 对 180 个软链接要 30s，shell 只要 0.1s；
 * 注入自检是 audit 内的一个 gate，必须稳定低于 gate 超时。
 */
function removeOverlay(root) {
  try { execFileSync('rm', ['-rf', root], { stdio: 'ignore', timeout: 10000 }); }
  catch { /* 已删除则忽略 */ }
}

/** 覆写镜像中的 JSON（真实文件只读）。 */
function overlayJson(root, rel, mutate) {
  const p = join(root, rel);
  try { unlinkSync(p); } catch { /* 原本是软链接或不存在 */ }
  const obj = JSON.parse(readFileSync(join(REAL_ROOT, rel), 'utf8'));
  mutate(obj);
  writeFileSync(p, JSON.stringify(obj, null, 1) + '\n', 'utf8');
}

/** 覆写镜像中的文本（真实文件只读）。 */
function overlayText(root, rel, text) {
  const p = join(root, rel);
  try { unlinkSync(p); } catch { /* 同上 */ }
  writeFileSync(p, text, 'utf8');
}

/** 在镜像里真跑一个 gate（cwd=镜像，eval ROOT 指向镜像，环境钉死）。 */
function runGate(root, gateRel) {
  const r = spawnSync(process.execPath, [join(root, gateRel)], {
    cwd: root,
    env: {
      ...process.env,
      ALIGN431_ROOT_OVERRIDE: root,
      E0_ROOT,
      TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', FORCE_COLOR: '0',
      ALIGN431_T03B: '1', NODE_OPTIONS: '',
    },
    encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status === null ? -1 : r.status, stdout: String(r.stdout || '') };
}

/** 在镜像里跑 builder 的依赖入库自检（快速路径，不重生全量 rows）。 */
function runBuilderCarrierCheck(root) {
  const r = spawnSync(process.execPath, [join(root, 'tools/build-align431-rows.mjs'), '--check-carriers'], {
    cwd: root,
    env: {
      ...process.env,
      ALIGN431_ROOT_OVERRIDE: root,
      E0_ROOT,
      TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', FORCE_COLOR: '0',
      ALIGN431_T03B: '1', NODE_OPTIONS: '',
    },
    encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  return { code: r.status === null ? -1 : r.status, stdout: String(r.stdout || '') };
}

/** gate 是否真的因指定断言转红。 */
function gateRed(run, assertion) {
  return run.code !== 0 && new RegExp(`FAIL ${assertion}\\b`).test(run.stdout);
}

/** gate 在干净镜像上是否全绿。 */
function gateGreen(run) {
  const failLines = run.stdout.split('\n').filter((l) => /^\s*FAIL\s/.test(l));
  return run.code === 0 && failLines.length === 0;
}

/**
 * 把 gate 脚本复制进镜像。
 * 部分 gate（如 verify-align431-static-truth.mjs）自己用 import.meta.url 推导 ROOT，
 * 只靠 eval 的 ROOT 覆盖不够；复制后 gate 的 ROOT 自然落在镜像上。
 */
function overlayGateScript(root, gateRel) {
  try { unlinkSync(join(root, gateRel)); } catch { /* 软链接 */ }
  copyFileSync(join(REAL_ROOT, gateRel), join(root, gateRel));
}

/** 把 live-map gate 与被测源码同时复制进镜像（ESM 相对 import 才会指向镜像 src）。 */
function overlayLiveMap(root, mutate) {
  const gateRel = 'tools/verify-live-map-failclosed.mjs';
  overlayGateScript(root, gateRel);
  if (!mutate) return;
  const srcRel = 'src/live-map.js';
  const text = readFileSync(join(REAL_ROOT, srcRel), 'utf8');
  const old = "if (!report.can || report.frameId == null || (report.source != null && report.source !== 'native')) {";
  const next = "if (false && (!report.can || report.frameId == null || (report.source != null && report.source !== 'native'))) {";
  if (!text.includes(old)) throw new Error('注入锚点缺失：live-map report guard');
  overlayText(root, srcRel, text.replace(old, next));
}

/**
 * 登记一类注入结果。
 * @param {string} id 两位编号
 * @param {string} name 机器名
 * @param {string} assertion 期望转红的断言名
 * @param {boolean} green 干净基线是否绿
 * @param {boolean} red 注入后是否红
 */
function record(id, name, assertion, green, red) {
  results.push({ id, name, assertion, red: Boolean(red), green: Boolean(green) });
  if (!green || !red) failures.push(`${id}:${name} green=${Boolean(green)} red=${Boolean(red)}`);
}

// ─────────────────────────── 基线：干净镜像全绿 ───────────────────────────
const baselineRoot = makeOverlay();
try {
  overlayLiveMap(baselineRoot, false);
  overlayGateScript(baselineRoot, 'tools/verify-align431-static-truth.mjs');
  overlayGateScript(baselineRoot, 'tools/verify-oem-probe-diff.mjs');
  const st = runGate(baselineRoot, 'tools/verify-align431-static-truth.mjs');
  const op = runGate(baselineRoot, 'tools/verify-oem-probe-diff.mjs');
  const lm = runGate(baselineRoot, 'tools/verify-live-map-failclosed.mjs');
  console.log(`INJECT_BASE STATIC_TRUTH green=${gateGreen(st) ? 1 : 0}`);
  console.log(`INJECT_BASE OEM_PROBE_DIFF green=${gateGreen(op) ? 1 : 0}`);
  console.log(`INJECT_BASE LIVE_MAP_FAIL_CLOSED green=${gateGreen(lm) ? 1 : 0}`);
  if (!gateGreen(st) || !gateGreen(op) || !gateGreen(lm)) {
    failures.push('BASELINE_NOT_GREEN');
  }
} finally {
  removeOverlay(baselineRoot);
}

// ① 错 sysId：把 0x0e23 首选真值改成 DME 地址 → 身份坐标断言必红。
{
  const root = makeOverlay();
  try {
    overlayJson(root, 'data/bind-plan.json', (bp) => {
      const e = bp.ecu['0x0e23'];
      e.cands[0] = '0x070E';
      if (e.pairs && e.pairs[0]) e.pairs[0].tx = '0x070E';
    });
    overlayGateScript(root, 'tools/verify-align431-static-truth.mjs');
    const run = runGate(root, 'tools/verify-align431-static-truth.mjs');
    record('01', 'WRONG_SYSID_0E23', 'STATIC_TRUTH_E0_0E23', true, gateRed(run, 'STATIC_TRUTH_E0_0E23'));
  } finally { removeOverlay(root); }
}

// ② 错 rx：+0x6A 改成 +8 → 402 限定段与 rxRule 断言必红。
{
  const root = makeOverlay();
  try {
    overlayJson(root, 'data/comm-addr-table.json', (t) => {
      if (t.limitCheck) t.limitCheck.rxEqTxPlus6A = 401;
      const groups = Object.values(t.byGeneration || {});
      if (groups[0] && groups[0].addresses && groups[0].addresses[0]) {
        groups[0].addresses[0].rxRule = 'rx=tx+8';
      }
    });
    overlayGateScript(root, 'tools/verify-oem-probe-diff.mjs');
    const run = runGate(root, 'tools/verify-oem-probe-diff.mjs');
    record('02', 'WRONG_RX_PLUS8', 'OEM_DIFF_402_402', true, gateRed(run, 'OEM_DIFF_402_402'));
  } finally { removeOverlay(root); }
}

// ③ 伪候选：请求键低 16 位 v3key 当 CAN 源 → 路径级断言与 E0 坐标必红。
{
  const root = makeOverlay();
  try {
    overlayJson(root, 'data/bind-plan.json', (bp) => {
      bp.ecu['0x0e23'].provenance[0].sources.push('v3key');
    });
    overlayGateScript(root, 'tools/verify-align431-static-truth.mjs');
    const run = runGate(root, 'tools/verify-align431-static-truth.mjs');
    const gateIsRed = gateRed(run, 'STATIC_TRUTH_NO_REQUESTKEY_AS_CAN');
    const fakeRegistry = readJson(REGISTRY_FILE);
    const fakeEntry = fakeRegistry.entries.find((e) => e.evidenceId === 'E-01');
    fakeEntry.e0Coord = { file: '', VA: '0x0', detail: '' };
    const e0Red = !evaluateE0Vector({ evidenceId: 'E-01' },
      { json: { [REGISTRY_FILE]: fakeRegistry } }).ok;
    record('03', 'FAKE_CANDIDATE_REQUESTKEY_AS_CAN', 'STATIC_TRUTH_NO_REQUESTKEY_AS_CAN', true,
      gateIsRed && e0Red);
  } finally { removeOverlay(root); }
}

// ④ planSysId=null 静默兜底 → fail-closed，不得标 A。
{
  const base = { kind: 'provableTag', provable: 'runtime', vectorId: 'REPLAY_DME',
    runtimeRequired: true, runtimeAnswerBacked: true, symbolHitOnly: false, sampleGeneralized: false };
  const green = evaluateProvableTag(base).ok;
  const red = !evaluateProvableTag({ ...base, planSysId: null }).ok;
  record('04', 'PLAN_SYSID_NULL_SILENT_FALLBACK', 'PROVABLE_TAG_PLAN_SYSID_NULL', green, red);
}

// ⑤ 全 NO DATA 仍标 A → 运行时应答举证必红。
{
  // ★ 阶段 E：manifest 不再自带 expected/replay，须用共享内核加载分离文件后的组装视图。
  const loaded = readVector('REPLAY_DME');
  if (!loaded.ok) throw new Error(loaded.detail);
  const v = loaded.vector;
  const noData = { ...v, replay: v.replay.map((x) => ({ ...x, resp: 'NO DATA' })) };
  const ctx = { vectors: { REPLAY_DME: noData }, e2eStdout: 'VECTOR REPLAY_DME frames=17 diff=[]' };
  const spec = { vectorId: 'REPLAY_DME', requireAnswer: true };
  const green = evaluateRuntimeVector(spec, { vectors: { REPLAY_DME: v },
    e2eStdout: 'VECTOR REPLAY_DME frames=17 diff=[]' }).ok;
  const red = !evaluateRuntimeVector(spec, ctx).ok;
  record('05', 'ALL_NO_DATA_MARKED_A', 'RUNTIME_PROBE_VECTOR_ANSWER_BACKED', green, red);
}

// ⑥ E1 单车日志泛化全代 → sampleOnly/provable 必红。
{
  const base = { kind: 'provableTag', provable: 'runtime', vectorId: 'REPLAY_DME',
    runtimeRequired: true, runtimeAnswerBacked: true, symbolHitOnly: false, sampleGeneralized: false };
  const green = evaluateProvableTag(base).ok;
  const red = !evaluateProvableTag({ ...base, sampleGeneralized: true }).ok;
  record('06', 'E1_GENERALIZED_TO_ALL_MODELS', 'PROVABLE_TAG_E1_SAMPLE_ONLY', green, red);
}

// ⑦ 运行时静态写死 CAN → provableTag 必红。
{
  const base = { kind: 'provableTag', provable: 'runtime', vectorId: 'REPLAY_PSM',
    runtimeRequired: true, runtimeAnswerBacked: true, symbolHitOnly: false, sampleGeneralized: false };
  const green = evaluateProvableTag(base).ok;
  const red = !evaluateProvableTag({ ...base, provable: 'static' }).ok;
  record('07', 'RUNTIME_HARDCODED_CAN', 'PROVABLE_TAG_RUNTIME_STATIC', green, red);
}

// ⑧ Macan 只绑 0x0f23 漏 0x0f34（按 blockOff 区分的双绑）→ 四元/双绑断言必红。
{
  const root = makeOverlay();
  try {
    overlayJson(root, 'data/bind-plan.json', (bp) => {
      const f23 = bp.ecu['0x0f23'];
      bp.ecu['0x0f34'].cands = (f23.cands || []).slice(0, 2);
    });
    overlayGateScript(root, 'tools/verify-align431-static-truth.mjs');
    const run = runGate(root, 'tools/verify-align431-static-truth.mjs');
    record('08', 'MACAN_SINGLE_BIND', 'STATIC_TRUTH_MACAN_DUAL_BIND', true,
      gateRed(run, 'STATIC_TRUTH_MACAN_DUAL_BIND'));
  } finally { removeOverlay(root); }
}

// ⑨ 删/改名任一 gate 断言 → NO_ASSERTION_DELETED 完整性必红。
{
  const rows = readJson('tools/align431-rows.json');
  const all = [...(rows.baselineRows || []), ...(rows.addedRows || [])];
  const baselineRows = all.map((r) => ({ ...r }));
  const deleted = all.map((r) => r === all[0]
    ? { ...r, assertion: `${r.assertion}_DELETED` } : { ...r });
  const green = assertionIntegrity(baselineRows, rows.t04.assertionIndex).ok;
  const red = !assertionIntegrity(deleted, rows.t04.assertionIndex).ok;
  record('09', 'ASSERTION_DELETED', 'NO_ASSERTION_DELETED', green, red);
}

// ⑩ 原生上报缺失仍 bound → fail-closed 分支必红（镜像内改 src/live-map.js）。
{
  const root = makeOverlay();
  try {
    overlayLiveMap(root, true);
    const run = runGate(root, 'tools/verify-live-map-failclosed.mjs');
    record('10', 'REPORT_MISSING_STILL_BOUND', 'INJECT_REPORT_MISSING_STILL_BOUND', true,
      gateRed(run, 'INJECT_REPORT_MISSING_STILL_BOUND'));
  } finally { removeOverlay(root); }
}

// ⑪（十类之外）防回归：implLanded 依赖必须是 tracked 载体；改掉 tracked proof token 必须红。
let carrierGuardOk = false;
{
  const greenRoot = makeOverlay();
  const redRoot = makeOverlay();
  try {
    const greenRun = runBuilderCarrierCheck(greenRoot);
    const green = greenRun.code === 0 && /IMPL_LANDED_NO_LOCAL_ONLY_CARRIER PASS/.test(greenRun.stdout);
    const rel = 'tools/build-routines-verified.py';
    const original = readFileSync(join(REAL_ROOT, rel), 'utf8');
    const token = 'MENU_911_681_TO_454_PROOF';
    if (!original.includes(token)) throw new Error('注入锚点缺失：build-routines proof token');
    overlayText(redRoot, rel, original.split(token).join('MENU_911_681_TO_454_PR00F'));
    const redRun = runBuilderCarrierCheck(redRoot);
    const red = redRun.code !== 0 && /IMPL_LANDED_NO_LOCAL_ONLY_CARRIER FAIL/.test(redRun.stdout);
    carrierGuardOk = green && red;
    console.log(`INJECT_EXTRA IMPL_LANDED_NO_LOCAL_ONLY_CARRIER baseline=${green ? 1 : 0} red=${red ? 1 : 0}`);
    if (!carrierGuardOk) failures.push('IMPL_LANDED_NO_LOCAL_ONLY_CARRIER');
  } finally {
    removeOverlay(greenRoot);
    removeOverlay(redRoot);
  }
}

// 注入结束：真实仓库关键文件必须逐字节未变。
let restored = true;
for (const [rel, before] of watchBefore) {
  if (digest(readFileSync(join(REAL_ROOT, rel), 'utf8')) !== before) restored = false;
}
if (!restored) failures.push('RESTORE_HASH_MISMATCH');
console.log(`INJECT_RESTORE_HASH_EQUAL ${restored ? 1 : 0}`);

for (const r of results) {
  console.log(`INJECT ${r.id} ${r.name} RED ${r.red ? 1 : 0} GREEN ${r.green ? 1 : 0} ASSERT ${r.assertion}`);
}
const redCount = results.filter((r) => r.red && r.green).length;
const redRate = results.length ? Math.round((redCount / results.length) * 100) : 0;
const falseGreen = results.filter((r) => !r.red || !r.green).length + (restored ? 0 : 1);
console.log(`INJECTION_RED_COUNT ${redCount}/${results.length}`);
console.log(`INJECTION_RED_RATE ${redRate}%`);
console.log(`INJECTION_FALSE_GREEN ${falseGreen}`);
const allOk = redRate === 100 && falseGreen === 0 && carrierGuardOk;
if (allOk) {
  console.log('INJECTION_RED_RATE_100 PASS');
} else {
  for (const f of failures) console.log(`INJECTION_FAIL ${f}`);
  console.log('INJECTION_RED_RATE_100 FAIL');
}
process.exit(allOk ? 0 : 1);
