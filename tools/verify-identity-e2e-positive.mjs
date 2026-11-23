#!/usr/bin/env node
/**
 * verify-identity-e2e-positive.mjs — v0.8.3 批次C **正向端到端**可证伪门禁。
 *
 * 背景（E0 已核实，本门禁只证伪、不重证）
 * ──────────────────────────────────────
 * 0x0e23（BCM_hinten）进模块实发识别帧集只有 3 帧（3E00/22F1A2/1003，无 22F19E）；
 * 其中 22F1A2 的 flag=1（原厂要求正响应）。实车应答 `777100962F1A2303530`
 * = FF 声明 9B、实收 6B、缺 CF；G1 正确拒为 truncated，但旧 coder.js catch
 * 把 flag=1 识别帧的 CodingError 与 flag=0 帧一起静默吞 → oemIdentityResponses
 * 无留证 → identityAdjudicate 判 unknown。补上 CF（`21 30 31 38`）即为完整
 * DSN "050018" → identToVariant 精确命中 BCM_hinten_9x1_GT4。
 *
 * 真执行口径（不是字符串命中）
 * ──────────────────────────────
 *   - 从 src/probe.js / src/coder.js / src/app.js **抽取真实源码**，注入真实依赖
 *     （probe 同门导出、coder 真 CodingError 结构、REG 真注册表）后 new Function 执行；
 *   - A 正路径：完整多帧 → DSN 050018 精确命中、消歧 GT4；
 *   - B 负路径：仅 FF（无 CF）/ 单帧 "050" → 不出现 GT4/GT5、不假命中 "050"；
 *   - C 截断诊断：真执行 coder.js catch 留证 + identityAdjudicate → verdict='truncated'，
 *     且 flag=0 帧容错语义逐字节不变；
 *   - D 帧集一致：真执行 app.js 的 frames 表达式，验证来自 coder.oemIdentityFrames
 *     （0x0e23 场景不含 22F19E），空帧集回退 identityPhaseFrames 仍健壮；
 *   - E 反例注入（可证伪）：删 CF → A 必须转红；DSN 查表改前缀匹配 → B 必须转红。
 *
 * stdout：PASS/FAIL <ASSERT> <detail>；
 * 末行 `IDENTITY_E2E_POSITIVE_PASS count=N` 或 `IDENTITY_E2E_POSITIVE_FAIL failed=N`；退出码 0/1。
 *
 * 跑法：node tools/verify-identity-e2e-positive.mjs
 */
import { readFileSync } from 'node:fs';
import {
  IDENTITY_TEXT_SIDS, IDENT_1A_CHAIN, IDENT_1A_MAX_MISS,
  adjudicateFourTuple, identityAdjudicate, identityFramesFor,
  identityVerdict, normIdent, validateIdentityFrames,
} from '../src/probe.js';
import { frameIdsOf, parseRespAuto } from '../src/coder.js';

const PROBE_SRC = readFileSync(new URL('../src/probe.js', import.meta.url), 'utf8');
const CODER_SRC = readFileSync(new URL('../src/coder.js', import.meta.url), 'utf8');
const APP_SRC = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const REG = JSON.parse(readFileSync(new URL('../data/ident-registry.json', import.meta.url), 'utf8'));

const results = [];
const ck = (name, pass, detail = '') => {
  const good = Boolean(pass);
  results.push({ name, ok: good });
  console.log(`${good ? 'PASS' : 'FAIL'} ${name} ${detail}`.trimEnd());
  return good;
};

/** 花括号配对（跳过字符串/模板串/注释），返回右花括号下标，失败 -1。 */
function matchBrace(text, openIdx) {
  let depth = 0;
  let quote = '';
  let comment = '';
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (comment === 'line') { if (c === '\n') comment = ''; continue; }
    if (comment === 'block') { if (c === '*' && n === '/') { comment = ''; i++; } continue; }
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '/') { comment = 'line'; i++; continue; }
    if (c === '/' && n === '*') { comment = 'block'; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 抽函数声明全文（跳过签名默认参数），去掉 export 前缀。 */
function sliceFunction(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const sigEnd = src.indexOf(') {', at);
  if (sigEnd < 0) return null;
  const open = sigEnd + 2;
  const end = matchBrace(src, open);
  return end < 0 ? null : src.slice(at, end + 1).replace(/^export\s+/, '');
}

const ADJ_SRC = sliceFunction(PROBE_SRC, 'export async function identityAdjudicate(');
if (!ADJ_SRC) {
  ck('SOURCE_EXTRACTED', false, 'identityAdjudicate 未抽出');
  console.log('IDENTITY_E2E_POSITIVE_FAIL failed=1');
  process.exit(1);
}
ck('SOURCE_EXTRACTED', true, `identityAdjudicate=${ADJ_SRC.length}B`);

/** 用真实源码造裁决器；注入改过的源码即反例版本。 */
function makeAdjudicate(src) {
  // eslint-disable-next-line no-new-func -- 抽真实源码注入真依赖执行，不是复制被测实现
  return new Function(
    'identityFramesFor', 'validateIdentityFrames', 'IDENT_1A_CHAIN', 'IDENT_1A_MAX_MISS',
    'frameIdsOf', 'parseRespAuto', 'normIdent', 'identityVerdict', 'adjudicateFourTuple',
    'IDENTITY_TEXT_SIDS',
    `return (${src});`,
  )(identityFramesFor, validateIdentityFrames, IDENT_1A_CHAIN, IDENT_1A_MAX_MISS,
    frameIdsOf, parseRespAuto, normIdent, identityVerdict, adjudicateFourTuple,
    IDENTITY_TEXT_SIDS);
}

/* ───────────── 0x0e23 真实帧集与真实应答原文（rx=0x777） ───────────── */
const FRAMES_0E23 = ['3E00', '22F1A2', '1003'];       // 实发集：无 22F19E
const P = { tx: 0x070D, rx: 0x777 };
const EXPECT = { keys: ['BCM_hinten', 'BCM_vorne'] };  // 050018 双候选，按模块名消歧
const OPTS = { frames: FRAMES_0E23, moduleIdent: REG.moduleIdent, identToVariant: REG.identToVariant };
// 完整多帧：FF 声明 9B + 6B 数据（62 F1 A2 30 35 30 = "050"）+ CF 3B（30 31 38 = "018"）
// 与 tools/verify-isotp-truncation.mjs FULL_RAW 逐字节同源，剥 3B 头即 "050018"。
const RAW_FULL = '777 10 09 62 F1 A2 30 35 30\r777 21 30 31 38';
const RAW_FF_ONLY = '777100962F1A2303530';            // 实车截断：声明 9B、实收 6B、缺 CF
const RAW_DSN_050 = '777 06 62 F1 A2 30 35 30';       // 单帧半 DSN "050"（查表不得前缀命中）
const runAdj = (adj, raw) => adj(
  async (hex) => (String(hex).toUpperCase() === '22F1A2' ? raw : ''),
  P, 'uds', EXPECT, OPTS,
);

const clean = makeAdjudicate(ADJ_SRC);

/* ───────────── A 正路径：完整 DSN → GT4 ───────────── */
const a = await runAdj(clean, RAW_FULL);
ck('REGISTRY_EXACT_050018', Object.keys(REG.identToVariant).length === 163
  && Array.isArray(REG.identToVariant['050018'])
  && !REG.identToVariant['050'],
  `keys=${Object.keys(REG.identToVariant).length} 050=${REG.identToVariant['050'] ?? 'absent'}`);
ck('A_FULL_DSN_HITS_GT4',
  a.verdict === 'match' && a.variant === 'BCM_hinten_9x1_GT4'
  && a.matchedModule === 'BCM_hinten' && a.dsn?.text === '050018'
  && a.dsn?.disambiguated === true,
  `verdict=${a.verdict} variant=${a.variant || '-'} dsn=${a.dsn?.text || '-'} disambiguated=${a.dsn?.disambiguated}`);

/* ───────────── B 负路径：仅 FF / 半 DSN 不假命中 ───────────── */
const b = await runAdj(clean, RAW_FF_ONLY);
ck('B_FF_ONLY_NO_GT_NO_050',
  b.verdict !== 'match' && !b.variant && !b.texts.includes('050')
  && !/GT4|GT5/.test(JSON.stringify(b)),
  `verdict=${b.verdict} texts=${JSON.stringify(b.texts)} variant=${b.variant || '-'}`);
const b2 = await runAdj(clean, RAW_DSN_050);
ck('B_050_NO_PREFIX_FALLBACK',
  b2.verdict !== 'match' && b2.dsnUnresolved === true && !b2.variant
  && !/GT4|GT5/.test(JSON.stringify(b2)),
  `verdict=${b2.verdict} texts=${JSON.stringify(b2.texts)} unresolved=${b2.dsnUnresolved}`);

/* ───────────── C 截断诊断：真执行 coder.js catch 留证 + 裁决 ───────────── */
// 抽 coder.js 里 _enterByOemFrames 的 catch 块全文（从发帧 try 之后第一个 catch）。
const CATCH_ANCHOR = "const r = await this.uds(f.hex, timeoutFor('SHORT'),";
const catchAt = CODER_SRC.indexOf(CATCH_ANCHOR);
const catchOpen = catchAt < 0 ? -1 : CODER_SRC.indexOf('} catch (e) {', catchAt);
let catchBody = null;
if (catchOpen >= 0) {
  const open = CODER_SRC.indexOf('{', catchOpen);
  const close = matchBrace(CODER_SRC, open);
  catchBody = close > open ? CODER_SRC.slice(open + 1, close) : null;
}
ck('C_CODER_CATCH_EXTRACTED', Boolean(catchBody && /f\.flag === 1/.test(catchBody)
  && /oemIdentityResponses\[key\]/.test(catchBody)),
  `catch=${catchBody ? catchBody.length + 'B' : 'not found'}`);

/** 真执行 catch：fake this 注入截断 CodingError，返回留证后的 ctx 与日志。 */
function runCatch(f, err, hard = false) {
  const say = [];
  const ctx = {
    _say: (s) => say.push(String(s)),
    oemIdentityResponses: {},
    oemIdentityFrames: FRAMES_0E23.slice(),
  };
  if (!catchBody) return { ctx, say, threw: null };
  let threw = null;
  try {
    // eslint-disable-next-line no-new-func -- 真执行 coder.js 抽出的 catch；for 包裹使 continue 合法
    const fn = new Function('f', 'hard', 'e', `for (let _once = 0; _once < 1; _once++) { ${catchBody} }`);
    fn.call(ctx, f, hard, err);
  } catch (e) { threw = e; }
  return { ctx, say, threw };
}
const truncErr = Object.assign(new Error(
  '服务 22F1A2 多帧应答被截断：声明 9 字节，实收 6 字节。不能拿短块继续。',
), { name: 'CodingError', kind: 'truncated', expected: 9, received: 6, raw: RAW_FF_ONLY });
const cFlag1 = runCatch({ hex: '22F1A2', flag: 1 }, truncErr);
ck('C_FLAG1_WRITES_TRUNC_MARKER',
  cFlag1.threw === null && cFlag1.ctx.oemIdentityResponses['22F1A2'] === RAW_FF_ONLY
  && cFlag1.say.some((s) => s.includes('22F1A2') && s.includes('截断')
    && s.includes('truncated') && s.includes('unknown')),
  `resp=${JSON.stringify(cFlag1.ctx.oemIdentityResponses)} say=${JSON.stringify(cFlag1.say)}`);
const cFlag0 = runCatch({ hex: '1003', flag: 0 }, truncErr);
ck('C_FLAG0_TOLERANCE_UNCHANGED',
  cFlag0.threw === null && Object.keys(cFlag0.ctx.oemIdentityResponses).length === 0
  && cFlag0.say.some((s) => s.includes('flag=0') && s.includes('按原厂容错继续'))
  && !cFlag0.say.some((s) => s.includes('truncated')),
  `resp=${JSON.stringify(cFlag0.ctx.oemIdentityResponses)} say=${JSON.stringify(cFlag0.say)}`);

// 用 coder.js 真留证喂给 app.js 同款 replay cmdFn 再裁决。
const replay = cFlag1.ctx.oemIdentityResponses;
const c = await clean(
  async (hex) => String(replay[String(hex).toUpperCase()] ?? ''),
  P, 'uds', EXPECT, OPTS,
);
ck('C_VERDICT_TRUNCATED_NOT_UNKNOWN',
  c.verdict === 'truncated' && c.texts.length === 0
  && Array.isArray(c.truncatedFrames)
  && c.truncatedFrames.some((f) => f.hex === '22F1A2' && f.expected === 9 && f.received === 6)
  && c.identityRule.includes('截断') && !c.variant,
  `verdict=${c.verdict} truncatedFrames=${JSON.stringify(c.truncatedFrames)} rule=${c.identityRule}`);
// 导入版与抽取版同判（证明抽取保真，不是另写实现）
const cImported = await identityAdjudicate(
  async (hex) => String(replay[String(hex).toUpperCase()] ?? ''),
  P, 'uds', EXPECT, OPTS,
);
ck('C_IMPORTED_MATCHES_EXTRACTED',
  cImported.verdict === c.verdict && cImported.variant === c.variant
  && JSON.stringify(cImported.truncatedFrames) === JSON.stringify(c.truncatedFrames),
  `imported=${cImported.verdict}/${cImported.variant || '-'} extracted=${c.verdict}/${c.variant || '-'}`);

/* ───────────── D 帧集一致：真执行 app.js frames 表达式 ───────────── */
const FRAME_EXPR_MARK = 'const frames = (Array.isArray(coder.oemIdentityFrames)';
const feAt = APP_SRC.indexOf(FRAME_EXPR_MARK);
let frameExpr = null;
if (feAt >= 0) {
  const lineEnd = APP_SRC.indexOf('\n', feAt);
  const line = APP_SRC.slice(feAt, lineEnd < 0 ? APP_SRC.length : lineEnd).trim();
  frameExpr = line.slice('const frames = '.length).replace(/;$/, '');
}
ck('D_APP_EXPR_EXTRACTED', Boolean(frameExpr
  && /coder\.oemIdentityFrames/.test(frameExpr)
  && /identityPhaseFrames\(enterFamily\)/.test(frameExpr)),
  `expr=${frameExpr || 'not found'}`);
let dLive = null;
let dFallback = null;
if (frameExpr) {
  // eslint-disable-next-line no-new-func -- 真执行 app.js 抽出的帧集表达式
  const build = new Function('coder', 'enterFamily', 'identityPhaseFrames', `return (${frameExpr});`);
  dLive = build({ oemIdentityFrames: FRAMES_0E23 }, 'uds', identityFramesFor);
  dFallback = build({}, 'uds', identityFramesFor);
}
ck('D_LIVE_FRAMES_NO_22F19E',
  JSON.stringify(dLive) === JSON.stringify(FRAMES_0E23) && !dLive.includes('22F19E'),
  `frames=${JSON.stringify(dLive)}`);
ck('D_EMPTY_FALLBACK_KEEPS_ROBUST',
  JSON.stringify(dFallback) === JSON.stringify(identityFramesFor('uds')),
  `fallback=${JSON.stringify(dFallback)}`);

/* ───────────── E 反例注入（可证伪） ───────────── */
// E1：删 CF（完整多帧 → 仅 FF）→ A 必须转红。
const aNoCf = await runAdj(clean, RAW_FF_ONLY);
ck('E1_REMOVE_CF_A_TURNS_RED',
  a.verdict === 'match' && a.variant === 'BCM_hinten_9x1_GT4'
  && aNoCf.verdict !== 'match' && !aNoCf.variant,
  `full=${a.verdict}/${a.variant || '-'} noCF=${aNoCf.verdict}/${aNoCf.variant || '-'}`);
// E2：DSN 精确查表 → 前缀匹配 → B（单帧 "050"）必须转红。
const EXACT_ANCHOR = 'const hit = table ? table[key] : null;';
const PREFIX_INJECTED = 'const hit = table ? (table[key] || table[Object.keys(table).find((k) => k.startsWith(key))]) : null;';
const prefixSrc = ADJ_SRC.replace(EXACT_ANCHOR, PREFIX_INJECTED);
ck('E2_PREFIX_INJECTION_APPLIED', prefixSrc !== ADJ_SRC && prefixSrc.includes(PREFIX_INJECTED),
  `changed=${prefixSrc !== ADJ_SRC}`);
const b2Injected = await runAdj(makeAdjudicate(prefixSrc), RAW_DSN_050);
ck('E2_PREFIX_LOOKUP_B_TURNS_RED',
  b2.verdict !== 'match' && !b2.variant
  && b2Injected.verdict === 'match' && /GT4|GT5/.test(b2Injected.variant || ''),
  `clean=${b2.verdict}/${b2.variant || '-'} injected=${b2Injected.verdict}/${b2Injected.variant || '-'}`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `IDENTITY_E2E_POSITIVE_FAIL failed=${failed} total=${results.length}`
  : `IDENTITY_E2E_POSITIVE_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
