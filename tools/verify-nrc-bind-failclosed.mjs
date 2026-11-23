#!/usr/bin/env node
/**
 * verify-nrc-bind-failclosed.mjs — 探测 NRC 可绑 / 身份读码 NRC 不算正响应：两阶段可证伪门禁。
 *
 * E0 依据（指令级取证已核实，本门禁只判伪、不重证）：
 *   `DriveLinksMode_1001@libPORSCHE_LINK.so`
 *     `0x18f8c blx` 发探针 `221409`，`0x18f8e ldr` **立即覆盖其返回值** ——
 *     探针应答（含 `7F2231` NRC）根本不进入 uxth 判定；
 *     `0x18fc0 cmp #1` 判的是随后**绑定帧** `0x100359`（E0 原始 movw #0x359 + movt #0x10）的回执。
 *   11-23 进不去模块根因：把探针帧的 NRC 误套到绑定帧的 uxth 判据上。
 *   实车 0x70D/0x777 对 `221409` 回 `7F2231`，但同地址 3E00→7E00、1003→5003、
 *   22F1A2→62F1A2 全正响应 = 地址明确活着、可绑。
 *
 * 阶段分离判据（本门禁真执行，不是字符串命中）：
 *   ① 探测：`src/sweep.js:classifyProbe` 抽源码真执行，NRC（含小写/无帧 ID）必须 `'alive'`，
 *      wrong-id / silent 语义保留；显式布尔 `nrcIsAliveAtProbe=true` 被钉住。
 *   ② 探测绑定：`src/app.js:tryAddr` 的 sendFn 抽源码 + 真实 frameIdsOf/parseRespAuto +
 *      真实 bindByRequestKey：NRC 回帧必须 uxth=1 / source=native / frameId=候选 rx /
 *      note 含 E0 阶段分离口径 / state=bound；正响应仍须 uxth=1（不是全拒门禁）。
 *   ③ 身份阶段：真实 `identityAdjudicate`（src/probe.js）对 `7F 22 31` 不产生身份文本、
 *      不裁决 DSN；合法 DSN 正响应仍须 match（证明不是全拒）。
 *   ④ 读码阶段：真实 `parseRespAuto` 判 `kind='nrc'`；真实 `Coder.readBlock` 对 NRC
 *      抛 CodingError(nrc=0x31)，无故障的读帧仍返回数据。
 *   ⑤ 反例注入：把抽出的 `nrcIsAliveAtProbe` 改成 false（丢弃探测 NRC alive 语义），
 *      同一套断言必须转红；正响应与绑定帧常量断言仍绿，证明门禁可判伪而非恒真。
 *
 * stdout：`PASS <ASSERT_NAME> <detail>` / `FAIL ...`；
 * 末行 `NRC_BIND_FAIL_CLOSED_PASS count=N` 或 `NRC_BIND_FAIL_CLOSED_FAIL failed=N`；退出码 0/1。
 *
 * 用法：node tools/verify-nrc-bind-failclosed.mjs
 */
import { readFileSync } from 'node:fs';
import {
  BIND_REQUEST_ID, bindByRequestKey, clear, snapshot,
} from '../src/live-map.js';
import { Coder, CodingError, frameIdsOf, parseRespAuto } from '../src/coder.js';
import { identityAdjudicate } from '../src/probe.js';
import { Elm327 } from '../src/elm327.js';
import { MockAdapter } from '../src/mock-adapter.js';

const APP_SRC = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const SWEEP_SRC = readFileSync(new URL('../src/sweep.js', import.meta.url), 'utf8');

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

/** 抽取 `{` 起的函数/箭头体全文。 */
function sliceBraced(text, from) {
  const open = text.indexOf('{', from);
  if (open < 0) return null;
  const end = matchBrace(text, open);
  return end < 0 ? null : text.slice(from, end + 1);
}

/** 抽 src/sweep.js 的 classifyProbe（去掉 export 关键字后可在 new Function 内执行）。 */
function extractClassifySource() {
  const sig = 'export function classifyProbe(';
  const at = SWEEP_SRC.indexOf(sig);
  if (at < 0) return null;
  const body = sliceBraced(SWEEP_SRC, at);
  return body ? body.replace(/^export\s+/, '') : null;
}

/** 抽 src/app.js tryAddr 内 `bindByRequestKey(rkInput(rk), async () => {...})` 的 sendFn。 */
function extractSendSource() {
  const marker = 'bindByRequestKey(rkInput(rk), async () =>';
  const at = APP_SRC.indexOf(marker);
  if (at < 0) return null;
  const arrow = APP_SRC.indexOf('async () =>', at);
  return sliceBraced(APP_SRC, arrow);
}

const classifySrc = extractClassifySource();
const sendSrc = extractSendSource();
if (!classifySrc || !sendSrc) {
  ck('SOURCE_EXTRACTED', false, `classify=${classifySrc?.length ?? 0} send=${sendSrc?.length ?? 0}`);
  console.log('NRC_BIND_FAIL_CLOSED_FAIL failed=1');
  process.exit(1);
}
ck('SOURCE_EXTRACTED', true, `classify=${classifySrc.length}B send=${sendSrc.length}B`);
ck('SOURCE_NRC_ALIVE_FLAG_EXPLICIT',
  /const nrcIsAliveAtProbe = true;/.test(classifySrc)
    && !/return\s+'nrc'/.test(classifySrc),
  'classifyProbe 显式声明探测 NRC=alive，无 nrc 非存活 verdict');

/** 用真实源码文本造可执行的 classifyProbe（注入另一个版本即可做反例）。 */
function makeClassify(src) {
  // eslint-disable-next-line no-new-func -- 抽真实源码注入执行，不是复制被测实现
  return new Function(`return (${src});`)();
}

const ROW = Object.freeze({ tx: 0x070d, rx: 0x0777, requestKey: '0x003006CC' });
const RK = ROW.requestKey;
/** ELM 原文：frameIdsOf 解析为 [0x777]；NRC 与正响应 body 均非空。 */
const RAW_NRC = '777 7F 22 31';
const RAW_OK = '777 62 14 09 01';

/** 用真实源码 sendFn + 真实 coder/解析依赖造待测函数；classifyProbe 由参数注入。 */
function makeSend(classify) {
  const notes = [];
  const note = (s) => notes.push(String(s));
  const p = { tx: ROW.tx, rx: ROW.rx, requestKey: RK };
  const hex = (n) => `0x${Number(n).toString(16).toUpperCase()}`;
  // eslint-disable-next-line no-new-func -- 抽真实源码注入执行，不是复制被测实现
  const factory = new Function('coder', 'cmd', 'p', 'note', 'hex',
    'frameIdsOf', 'parseRespAuto', 'classifyProbe', `return (${sendSrc});`);
  const sendFn = factory({ elm: { cmd: async () => currentRaw } }, '221409',
    p, note, hex, frameIdsOf, parseRespAuto, classify);
  let currentRaw = '';
  return {
    notes,
    async run(raw) {
      currentRaw = raw;
      clear();
      let direct = null;
      const bound = await bindByRequestKey(RK, async () => {
        direct = await sendFn();
        return direct;
      });
      return { direct, bound, size: snapshot().size, notes: [...notes] };
    },
  };
}

/**
 * 对一版 classifyProbe 跑探测阶段完整判据；返回失败名列表。
 * `counted=false` 用于反例注入：注入版的 FAIL 是预期红，不计入门禁总分。
 */
async function runSuite(classify, suiteName, counted = true) {
  const failed = [];
  const probe = (ids, body) => classify({ tx: ROW.tx, rx: ROW.rx }, ids, body);
  const add = (name, pass, detail = '') => {
    const good = Boolean(pass);
    console.log(`${good ? 'PASS' : 'FAIL'} ${suiteName}_${name} ${detail}`.trimEnd());
    if (counted) results.push({ name: `${suiteName}_${name}`, ok: good });
    if (!good) failed.push(name);
  };

  // ① 探测阶段：NRC（含小写 hex / 无帧 ID）一律 alive；wrong-id / silent 不回退。
  add('CLASSIFY_NRC_IS_ALIVE', probe([ROW.rx], '7F2231') === 'alive',
    `verdict=${probe([ROW.rx], '7F2231')}`);
  add('CLASSIFY_LOWERCASE_NRC_IS_ALIVE', probe([ROW.rx], '7f2231') === 'alive',
    `verdict=${probe([ROW.rx], '7f2231')}`);
  add('CLASSIFY_NRC_NO_IDS_IS_ALIVE', probe([], '7F2231') === 'alive',
    `verdict=${probe([], '7F2231')}`);
  add('CLASSIFY_POSITIVE_STILL_ALIVE', probe([ROW.rx], '62140901') === 'alive',
    `verdict=${probe([ROW.rx], '62140901')}`);
  add('CLASSIFY_WRONG_ID_STILL_WRONG_ID', probe([0x788], '7F2231') === 'wrong-id',
    `verdict=${probe([0x788], '7F2231')}`);
  add('CLASSIFY_EMPTY_STILL_SILENT', probe([ROW.rx], '') === 'silent',
    `verdict=${probe([ROW.rx], '')}`);

  // ② app.js 真 sendFn + 真绑定链：NRC 照常绑定，且 note 明确阶段分离口径。
  const harness = makeSend(classify);
  const nrcRun = await harness.run(RAW_NRC);
  add('SENDFN_NRC_UXTH_ONE',
    nrcRun.direct?.uxth === 1 && nrcRun.direct?.source === 'native'
      && nrcRun.direct?.frameId === ROW.rx && /7F2231/.test(nrcRun.direct?.body || ''),
    `uxth=${nrcRun.direct?.uxth ?? '-'} source=${nrcRun.direct?.source ?? '-'}`
      + ` frameId=${nrcRun.direct?.frameId ?? '-'} body=${nrcRun.direct?.body ?? '-'}`);
  add('SENDFN_NRC_NOTE_E0_PHASE_SPLIT',
    nrcRun.notes.some((s) => s.includes('NRC 负响应=地址在场，探测阶段按 E0 可绑；身份/读码另判')),
    `notes=${JSON.stringify(nrcRun.notes)}`);
  add('SENDFN_NRC_BOUND',
    nrcRun.bound?.ok === true && nrcRun.bound?.state === 'bound'
      && nrcRun.bound?.binding?.frameId === ROW.rx && nrcRun.size === 1,
    `ok=${nrcRun.bound?.ok ?? '-'} state=${nrcRun.bound?.state ?? '-'} size=${nrcRun.size}`);

  const okRun = await harness.run(RAW_OK);
  add('SENDFN_POSITIVE_STILL_BOUND',
    okRun.direct?.uxth === 1 && okRun.bound?.ok === true
      && okRun.bound?.state === 'bound' && okRun.bound?.binding?.frameId === ROW.rx
      && okRun.size === 1,
    `uxth=${okRun.direct?.uxth ?? '-'} state=${okRun.bound?.state ?? '-'} size=${okRun.size}`);

  // ③ 绑定帧常量保持 E0 原始值（不随探测语义撤回而回退）。
  add('BIND_REQUEST_ID_IS_0X100359', BIND_REQUEST_ID === 0x100359,
    `value=0x${BIND_REQUEST_ID.toString(16)}`);

  return failed;
}

/* ───────────────── 干净源码：探测阶段必须全绿 ───────────────── */
const cleanFailed = await runSuite(makeClassify(classifySrc), 'CLEAN');
ck('CLEAN_SUITE_ALL_GREEN', cleanFailed.length === 0, `failed=${cleanFailed.length}`);

/* ───────────────── 身份阶段：NRC 不是身份串、不算正响应 ───────────────── */
const identFrame = (bytes) => `7E8 ${bytes.length.toString(16).toUpperCase().padStart(2, '0')} `
  + bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const asciiBytes = (s) => [...String(s)].map((c) => c.charCodeAt(0) & 0xff);
const RAW_ID_NRC = identFrame([0x7F, 0x22, 0x31]);
const RAW_ID_OK = identFrame([0x62, 0xF1, 0xA2, ...asciiBytes('050018')]);
const IDENT_P = Object.freeze({ tx: 0x7e0, rx: 0x7e8 });
const IDENT_EXPECT = Object.freeze({ keys: ['BCM_hinten'] });
const IDENT_OPTS = Object.freeze({
  frames: ['22F1A2'],
  moduleIdent: null,
  identToVariant: Object.freeze({ '050018': [{ module: 'BCM_hinten', variant: 'GT4' }] }),
});

const idNrc = await identityAdjudicate(async () => RAW_ID_NRC, IDENT_P, 'uds', IDENT_EXPECT, IDENT_OPTS);
ck('IDENTITY_NRC_NOT_POSITIVE',
  idNrc.texts.length === 0 && idNrc.verdict !== 'match' && idNrc.dsn === null,
  `texts=${JSON.stringify(idNrc.texts)} verdict=${idNrc.verdict} dsn=${JSON.stringify(idNrc.dsn)}`);
const idOk = await identityAdjudicate(async () => RAW_ID_OK, IDENT_P, 'uds', IDENT_EXPECT, IDENT_OPTS);
ck('IDENTITY_DSN_POSITIVE_STILL_MATCHES',
  idOk.verdict === 'match' && idOk.dsn?.text === '050018',
  `verdict=${idOk.verdict} dsn=${idOk.dsn?.text ?? '-'}`);

/* ───────────────── 读码阶段：NRC 上抛，正响应照读 ───────────────── */
const readParse = parseRespAuto('7E8 03 7F 22 31', '220600', 0x22);
ck('READ_NRC_PARSE_KIND_NOT_OK',
  readParse.kind === 'nrc' && readParse.body[0] === 0x7f,
  `kind=${readParse.kind} body=${readParse.body.map((b) => b.toString(16)).join('')}`);
const makeCoder = (opts) => new Coder(new Elm327(new MockAdapter({ latencyMs: 0, ...opts }),
  { timeoutMs: 500 }), { tx: 0x7e0, rx: 0x7e8, ecuName: 'DME', family: 'uds' });
let readErr = null;
try { await makeCoder({ fail: { 0x06: 0x31 } }).readBlock(0x0600, 0x22); }
catch (e) { readErr = e; }
ck('READ_NRC_THROWS_CODING_ERROR',
  readErr instanceof CodingError && readErr.nrc === 0x31,
  `error=${readErr?.constructor?.name ?? '-'} nrc=${readErr?.nrc ?? '-'}`);
const readOk = await makeCoder({}).readBlock(0x0600, 0x22).catch(() => null);
ck('READ_POSITIVE_STILL_RETURNS_BYTES',
  Array.isArray(readOk) && readOk.length > 0,
  `bytes=${readOk?.length ?? '-'}`);

/* ───────────────── 反例注入：丢弃探测 NRC alive 语义 → 必须转红 ───────────────── */
const injectedSrc = classifySrc.replace(
  'const nrcIsAliveAtProbe = true;', 'const nrcIsAliveAtProbe = false;');
ck('INJECT_NRC_ALIVE_FLAG_APPLIED',
  injectedSrc !== classifySrc && /const nrcIsAliveAtProbe = false;/.test(injectedSrc),
  `changed=${injectedSrc !== classifySrc}`);
const injectedFailed = await runSuite(makeClassify(injectedSrc), 'INJECTED', false);
ck('INJECT_NRC_ALIVE_ASSERTION_TURNS_RED',
  injectedFailed.includes('CLASSIFY_NRC_IS_ALIVE')
    && injectedFailed.includes('CLASSIFY_NRC_NO_IDS_IS_ALIVE'),
  `failed=${JSON.stringify(injectedFailed)}`);
ck('INJECT_E0_NOTE_ASSERTION_TURNS_RED',
  injectedFailed.includes('SENDFN_NRC_NOTE_E0_PHASE_SPLIT'),
  `failed=${JSON.stringify(injectedFailed)}`);
ck('INJECT_BIND_STILL_GREEN',
  !injectedFailed.includes('SENDFN_NRC_UXTH_ONE')
    && !injectedFailed.includes('SENDFN_NRC_BOUND'),
  '探测绑定只看 body + 原生 frameId，不依赖 classify 的 NRC alive 口径');
ck('INJECT_POSITIVE_STAYS_GREEN',
  !injectedFailed.includes('CLASSIFY_POSITIVE_STILL_ALIVE')
    && !injectedFailed.includes('SENDFN_POSITIVE_STILL_BOUND')
    && !injectedFailed.includes('BIND_REQUEST_ID_IS_0X100359'),
  '正响应与绑定常量在注入版仍绿（证明不是恒真/全拒）');
ck('INJECTED_SUITE_RED', injectedFailed.length > 0, `failed=${injectedFailed.length}`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `NRC_BIND_FAIL_CLOSED_FAIL failed=${failed} total=${results.length}`
  : `NRC_BIND_FAIL_CLOSED_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
