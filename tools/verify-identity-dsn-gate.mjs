#!/usr/bin/env node
/**
 * verify-identity-dsn-gate.mjs — E0 逐行账本「身份裁决三缺陷」可证伪真执行门禁。
 *
 * 根因（E0 已逐行取证，本门禁不重证，只判伪）：
 *   ① 22F1A2 应答是 6 位 DSN 串（050018 → BCM_hinten_9x1_GT4），旧实现拿
 *      moduleIdent 的「模块名 + ASAMODXFileVersi_*」名字键去 identMatch 比对 → 必 mismatch；
 *      且「公共前缀≥4」会把 ISO-TP 半包 '050' 误配到 '050018'。
 *   ② 1003 会话正响应 `50 03 00 32 01 F4` 混进身份通道，剥头后变成身份文本「2」。
 *   ③ 未识别时 autoPickVariant(mi,'') 静默落 *_GT5 并放行写入（21/26 个 BCM 默认值是 GT5）。
 *
 * 真执行口径（不是字符串命中）：
 *   - 从 src/probe.js **抽取真实 identityAdjudicate 源码**，注入真实依赖后 new Function 执行；
 *     ① 050018 精确命中 GT4；② 050 不命中不误配；③ 1003 不产生文本；④ P200 走旧名字串路径。
 *   - 反例注入：把抽取源码的「精确查表」改成前缀匹配 → ②必须转红；
 *     把「SID 白名单」改成 if(false) → ③必须转红；干净版与导入版逐项对照，证明不是恒真。
 *   - 从 src/app.js 抽取调用处 opts / fail-closed 分支 / 写闸门分支源码并真执行，
 *     证明确实传了 identToVariant、未识别不加载 items、identityUnresolved 拒写但手选仍放行。
 *
 * stdout：`PASS <ASSERT> <detail>` / `FAIL ...`；
 * 末行 `IDENTITY_DSN_GATE_PASS count=N` 或 `IDENTITY_DSN_GATE_FAIL failed=N`；退出码 0/1。
 *
 * 用法：node tools/verify-identity-dsn-gate.mjs
 */
import { readFileSync } from 'node:fs';
import {
  IDENTITY_TEXT_SIDS, IDENT_1A_CHAIN, IDENT_1A_MAX_MISS,
  adjudicateFourTuple, identityAdjudicate, identityFramesFor,
  identityVerdict, normIdent, validateIdentityFrames,
} from '../src/probe.js';
import { frameIdsOf, parseRespAuto } from '../src/coder.js';
import { autoPickVariant } from '../src/variant.js';

const PROBE_SRC = readFileSync(new URL('../src/probe.js', import.meta.url), 'utf8');
const APP_SRC = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const REG = JSON.parse(readFileSync(new URL('../data/ident-registry.json', import.meta.url), 'utf8'));

const results = [];
const ck = (name, pass, detail = '') => {
  const good = Boolean(pass);
  results.push({ name, ok: good });
  console.log(`${good ? 'PASS' : 'FAIL'} ${name} ${detail}`.trimEnd());
  return good;
};

/** 花括号配对，跳过字符串/模板串/注释；返回右花括号下标，失败 -1。 */
function matchBrace(text, openIdx) {
  let depth = 0;
  let quote = '';
  let comment = '';
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (comment === 'line') {
      if (c === '\n') comment = '';
      continue;
    }
    if (comment === 'block') {
      if (c === '*' && n === '/') { comment = ''; i++; }
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '/') { comment = 'line'; i++; continue; }
    if (c === '/' && n === '*') { comment = 'block'; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从 marker 起抽完整 {...} 块（函数体 / if 块 / 对象字面量）。 */
function sliceBraced(src, marker, from = 0) {
  const at = src.indexOf(marker, from);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  const end = matchBrace(src, open);
  return end < 0 ? null : src.slice(at, end + 1);
}

/** 抽函数声明全文（跳过签名里的默认参数 `opts = {}`）。 */
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
  console.log('IDENTITY_DSN_GATE_FAIL failed=1');
  process.exit(1);
}
ck('SOURCE_EXTRACTED', true, `identityAdjudicate=${ADJ_SRC.length}B`);

/** 用真实源码造可执行裁决器；注入改过的源码即反例版本。 */
function makeAdjudicate(src) {
  // eslint-disable-next-line no-new-func -- 抽真实源码注入执行，不是复制被测实现
  return new Function(
    'identityFramesFor', 'validateIdentityFrames', 'IDENT_1A_CHAIN', 'IDENT_1A_MAX_MISS',
    'frameIdsOf', 'parseRespAuto', 'normIdent', 'identityVerdict', 'adjudicateFourTuple',
    'IDENTITY_TEXT_SIDS',
    `return (${src});`,
  )(identityFramesFor, validateIdentityFrames, IDENT_1A_CHAIN, IDENT_1A_MAX_MISS,
    frameIdsOf, parseRespAuto, normIdent, identityVerdict, adjudicateFourTuple,
    IDENTITY_TEXT_SIDS);
}

/* ───────────── 真实应答原文（单帧 ISO-TP，回帧 ID 0x7E8） ───────────── */
const RX = 0x7E8;
const frame = (bytes) => `${RX.toString(16).toUpperCase()} `
  + `${bytes.length.toString(16).toUpperCase().padStart(2, '0')} `
  + bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const ascii = (s) => [...String(s)].map((c) => c.charCodeAt(0) & 0xff);
const RAW_DSN_GT4 = frame([0x62, 0xF1, 0xA2, ...ascii('050018')]);
const RAW_DSN_TRUNC = frame([0x62, 0xF1, 0xA2, ...ascii('050')]);       // ISO-TP 半包
const RAW_SESSION = frame([0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]);        // 1003 正响应
const RAW_NAME = frame([0x5A, 0x9F, ...ascii('P200')]);                  // KWP 名字串

const P = { tx: 0x7E0, rx: RX };
const EXPECT_DSN = { keys: ['BCM_hinten', 'BCM_vorne'] };
const EXPECT_NAME = { keys: ['P200'] };
const BASE_OPTS = { moduleIdent: REG.moduleIdent, identToVariant: REG.identToVariant };

/** 对一版裁决器跑 4 个用例；返回按用例名索引的结果。 */
async function runCases(adjudicate) {
  const run = async (cmd, raw, expect) => adjudicate(
    async (hex) => (hex === cmd ? raw : ''), P, 'uds', expect,
    { ...BASE_OPTS, frames: [cmd] },
  );
  return {
    gt4: await run('22F1A2', RAW_DSN_GT4, EXPECT_DSN),
    trunc: await run('22F1A2', RAW_DSN_TRUNC, EXPECT_DSN),
    session: await run('1003', RAW_SESSION, EXPECT_DSN),
    name: await run('1A9F', RAW_NAME, EXPECT_NAME),
  };
}

/* ───────────── 干净源码：四用例必须全绿 ───────────── */
const clean = makeAdjudicate(ADJ_SRC);
const got = await runCases(clean);

ck('REGISTRY_EXACT_KEYS', Object.keys(REG.identToVariant).length === 163
  && Array.isArray(REG.identToVariant['050018'])
  && !REG.identToVariant['050'],
  `keys=${Object.keys(REG.identToVariant).length} 050=${REG.identToVariant['050'] ?? 'absent'}`);

ck('DSN_050018_HITS_GT4',
  got.gt4.verdict === 'match' && got.gt4.variant === 'BCM_hinten_9x1_GT4'
    && got.gt4.matchedModule === 'BCM_hinten' && got.gt4.dsn?.disambiguated === true,
  `verdict=${got.gt4.verdict} variant=${got.gt4.variant || '-'} module=${got.gt4.matchedModule || '-'}`);

const truncJson = JSON.stringify(got.trunc);
ck('DSN_050_NO_PREFIX_FALLBACK',
  got.trunc.verdict !== 'match' && !got.trunc.variant
    && !/GT4|GT5/.test(truncJson) && got.trunc.dsnUnresolved === true,
  `verdict=${got.trunc.verdict} variant=${got.trunc.variant || '-'} unresolved=${got.trunc.dsnUnresolved}`);

ck('SESSION_1003_NO_IDENTITY_TEXT',
  got.session.texts.length === 0 && got.session.verdict === 'unknown' && !got.session.text,
  `texts=${JSON.stringify(got.session.texts)} verdict=${got.session.verdict}`);

ck('NAME_P200_OLD_PATH_NOT_REGRESSED',
  got.name.verdict === 'match' && got.name.text === 'P200' && !got.name.variant,
  `verdict=${got.name.verdict} text=${got.name.text} variant=${got.name.variant || '-'}`);

/** 导入版与抽取版逐字节同判，证明抽取保真（不是另写一份实现）。 */
const imported = await runCases(identityAdjudicate);
ck('IMPORTED_MATCHES_EXTRACTED',
  ['gt4', 'trunc', 'session', 'name'].every((k) =>
    imported[k].verdict === got[k].verdict
    && imported[k].variant === got[k].variant
    && JSON.stringify(imported[k].texts) === JSON.stringify(got[k].texts)),
  `verdicts=${['gt4', 'trunc', 'session', 'name'].map((k) => imported[k].verdict).join('/')}`);

/* ───────────── 反例注入 1：DSN 精确查表 → 前缀匹配，②必须转红 ───────────── */
const EXACT_ANCHOR = 'const hit = table ? table[key] : null;';
const PREFIX_INJECTED = 'const hit = table ? (table[key] || table[Object.keys(table).find((k) => k.startsWith(key))]) : null;';
const prefixSrc = ADJ_SRC.replace(EXACT_ANCHOR, PREFIX_INJECTED);
ck('INJECT_PREFIX_GUARD_APPLIED', prefixSrc !== ADJ_SRC && prefixSrc.includes(PREFIX_INJECTED),
  `changed=${prefixSrc !== ADJ_SRC}`);
const prefixCases = await runCases(makeAdjudicate(prefixSrc));
ck('INJECT_PREFIX_MAKE_050_HIT_GT',
  prefixCases.trunc.verdict === 'match' && /GT4|GT5/.test(prefixCases.trunc.variant || ''),
  `verdict=${prefixCases.trunc.verdict} variant=${prefixCases.trunc.variant || '-'}`);
ck('INJECT_PREFIX_KEEPS_OTHER_CASES_GREEN',
  prefixCases.gt4.verdict === 'match' && prefixCases.name.verdict === 'match'
    && prefixCases.session.texts.length === 0,
  '注入只打掉精确查表，不是全拒');

/* ───────────── 反例注入 2：去掉 SID 白名单，③必须转红 ───────────── */
const SID_ANCHOR = 'if (!IDENTITY_TEXT_SIDS.includes(sid)) {';
const sidSrc = ADJ_SRC.replace(SID_ANCHOR, 'if (false) {');
ck('INJECT_SID_GUARD_APPLIED', sidSrc !== ADJ_SRC && sidSrc.includes('if (false) {'),
  `changed=${sidSrc !== ADJ_SRC}`);
const sidCases = await runCases(makeAdjudicate(sidSrc));
ck('INJECT_NO_SID_WHITELIST_MAKE_SESSION_TEXT',
  sidCases.session.texts.length > 0 && sidCases.session.texts.includes('2'),
  `texts=${JSON.stringify(sidCases.session.texts)}`);
ck('INJECT_NO_SID_WHITELIST_KEEPS_NAME_GREEN',
  sidCases.name.verdict === 'match' && sidCases.gt4.verdict === 'match',
  '注入只打掉 SID 白名单，名字串与 DSN 仍判');

/* ───────────── app.js 接线：调用处 opts / fail-closed / 写闸门（真执行） ───────────── */
const CALL_MARK = 'identityAdjudicate(cmdFn, { tx: addr.tx, rx: addr.rx },';
const callAt = APP_SRC.indexOf(CALL_MARK);
const optAt = callAt < 0 ? -1 : APP_SRC.indexOf('{ frames, moduleIdent, partNumber, identToVariant:', callAt);
const optSrc = optAt < 0 ? null : sliceBraced(APP_SRC, '{ frames, moduleIdent, partNumber, identToVariant:', optAt);
let wiringOk = false;
if (optSrc) {
  const sentinel = { SENTINEL: true };
  // eslint-disable-next-line no-new-func -- 真执行 app.js 调用处的 opts 字面量
  const buildOpts = new Function('frames', 'moduleIdent', 'partNumber', 'reg', `return (${optSrc});`);
  const built = buildOpts([], null, '', { identToVariant: sentinel });
  wiringOk = built.identToVariant === sentinel;
}
ck('APP_PASSES_IDENT_TO_VARIANT', wiringOk, `opts=${optSrc || 'not found'}`);

const unrecSrc = sliceBraced(APP_SRC, 'if (/未识别|无识别文本/.test(auto.how)) {');
let unrecOk = false;
if (unrecSrc) {
  const st = { identityUnresolved: false, selectedVariant: {} };
  const notes = [];
  // eslint-disable-next-line no-new-func -- 真执行 app.js 未识别分支
  const run = new Function('state', 'log', 'mod', 'auto',
    `return (() => { ${unrecSrc} })();`);
  run(st, (s) => notes.push(String(s)), 'BCM_hinten',
    { name: 'BCM_hinten_9x1_GT5', how: '未识别（不自动兜底）' });
  unrecOk = st.identityUnresolved === true
    && Object.keys(st.selectedVariant).length === 0
    && notes.some((s) => s.includes('fail-closed 不加载编码块（不猜变体）'));
}
ck('APP_UNRECOGNIZED_FAILS_CLOSED', unrecOk, `src=${unrecSrc ? unrecSrc.length + 'B' : 'not found'}`);

const itemsSrc = sliceBraced(APP_SRC, 'if (!state.identityUnresolved) {');
let itemsOk = false;
let itemCalls = -1;
if (itemsSrc) {
  let calls = 0;
  // eslint-disable-next-line no-new-func -- 真执行 app.js 的 items 加载闸门
  const run = new Function('state', 'currentModel', 'mod', 'loadModuleItems', 'items',
    `return (async () => { ${itemsSrc} return items; })();`);
  const items = await run({ identityUnresolved: true }, 'M', 'BCM_hinten',
    async () => { calls++; return [{ lid: 1 }]; }, []);
  itemCalls = calls;
  itemsOk = calls === 0 && items.length === 0;
}
ck('APP_UNRECOGNIZED_LOADS_NO_ITEMS', itemsOk, `loadModuleItems calls=${itemCalls}`);

const writeSrc = sliceBraced(APP_SRC, 'if (state.identityUnresolved && !state.selectedVariant?.[p.module]) {');
let writeOk = false;
if (writeSrc) {
  // eslint-disable-next-line no-new-func -- 真执行 app.js 写闸门分支
  const run = new Function('state', 'p', 'toast',
    `return (() => { ${writeSrc} return 'ALLOWED'; })();`);
  const deniedNotes = [];
  const denied = run({ identityUnresolved: true, selectedVariant: {} }, { module: 'BCM_hinten' },
    (...a) => deniedNotes.push(a.join('|')));
  const allowed = run({ identityUnresolved: true, selectedVariant: { BCM_hinten: '手动变体' } },
    { module: 'BCM_hinten' }, () => {});
  writeOk = denied !== 'ALLOWED' && deniedNotes.some((s) => s.includes('fail-closed'))
    && allowed === 'ALLOWED';
}
ck('APP_WRITE_GATE_DENIES_BUT_KEEPS_MANUAL', writeOk,
  `src=${writeSrc ? writeSrc.length + 'B' : 'not found'}`);

const honest = autoPickVariant(
  { module: 'BCM_hinten', variant: 'BCM_hinten_9x1_GT5', variants: [{ name: 'BCM_hinten_9x1_GT5' }] },
  '050',
);
ck('VARIANT_HONEST_HOW', honest.how === '未识别（不自动兜底）', `how=${honest.how}`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `IDENTITY_DSN_GATE_FAIL failed=${failed} total=${results.length}`
  : `IDENTITY_DSN_GATE_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
