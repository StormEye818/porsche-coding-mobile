#!/usr/bin/env node
/**
 * verify-nrc-bind-failclosed.mjs — E0「NRC 负响应被当地址绑定成功」可证伪真执行门禁。
 *
 * 根因（指令级取证，本门禁不再重证）：
 *   `PorscheSendCommandByID@libPORSCHE_COMM.so:0x12898`
 *     `0x12902 cmp r1,#0x7f` / `0x12906 moveq r5,#0` —— 首字节 0x7F 的 NRC 负响应
 *     强制返回 0 → `DriveLinksMode_1001@LINK:0x18fc0 cmp #1` 不成立 → 不绑定。
 *   旧实现两处把 NRC body 非空当"地址活着"：
 *     src/sweep.js:classifyProbe 返回 'alive'；
 *     src/app.js:probeAddressFor 的 sendFn 只判 `if (!body)`。
 *   实车日志 docs/realcar/2026-11-22-981-BCM-read-NRC31.txt:45 的
 *   `221409 → 7F2231` 就是这样被绑上 BCM，随后 31/31 编码块全 NRC31。
 *
 * 本门禁**抽取真实源码文本**并真执行（不是字符串命中、不复制实现）：
 *   ① `classifyProbe` 抽自 src/sweep.js，NRC body → 'nrc' 且 !== 'alive'；
 *   ② 正响应 `62140901` 仍 → 'alive'（证明不是把所有 body 一刀切拒掉）；
 *   ③ `src/app.js` 的 tryAddr sendFn 抽源码 + 真实 frameIdsOf/parseRespAuto +
 *      真实 bindByRequestKey：NRC 回帧必须 uxth=0 / reason=NRC_NEGATIVE_RESPONSE /
 *      note 含「NRC 负响应不绑定」/ live map 不写；正响应仍须 uxth=1 且 state=bound；
 *   ④ BIND_REQUEST_ID === 0x100359（E0 原始 movw #0x359 + movt #0x10）；
 *   ⑤ 反例注入：把抽出的 classifyProbe 源码里的 `isNrc` 判定改为 false（等价于旧实现），
 *      同一套断言必须转红，证明判据可判伪而非恒真。
 *
 * stdout：`PASS <ASSERT_NAME> <detail>` / `FAIL ...`；
 * 末行 `NRC_BIND_FAIL_CLOSED_PASS count=N` 或 `NRC_BIND_FAIL_CLOSED_FAIL failed=N`；退出码 0/1。
 *
 * 用法：node tools/verify-nrc-bind-failclosed.mjs
 */
import { readFileSync } from 'node:fs';
import {
  BIND_REQUEST_ID, FAIL_CLOSED_REASON, bindByRequestKey, clear, snapshot,
} from '../src/live-map.js';
import { frameIdsOf, parseRespAuto } from '../src/coder.js';

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
  const note = (s) => notes.push(String(s));
  const notes = [];
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
 * 对一版 classifyProbe 跑完整判据；返回失败名列表。
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

  // ① NRC 负响应（含无帧 ID 与小写 hex）绝不能是 alive。
  const nrc = probe([ROW.rx], '7F2231');
  add('CLASSIFY_NRC_NOT_ALIVE', nrc === 'nrc' && nrc !== 'alive', `verdict=${nrc}`);
  const lower = probe([ROW.rx], '7f2231');
  add('CLASSIFY_LOWERCASE_NRC_NOT_ALIVE', lower === 'nrc' && lower !== 'alive', `verdict=${lower}`);
  const noIds = probe([], '7F2231');
  add('CLASSIFY_NRC_NO_IDS_NOT_ALIVE', noIds === 'nrc' && noIds !== 'alive', `verdict=${noIds}`);

  // ② 正响应仍是 alive；wrong-id / silent 语义不回退。
  const okBody = probe([ROW.rx], '62140901');
  add('CLASSIFY_POSITIVE_STILL_ALIVE', okBody === 'alive', `verdict=${okBody}`);
  const wrong = probe([0x788], '7F2231');
  add('CLASSIFY_WRONG_ID_STILL_WRONG_ID', wrong === 'wrong-id', `verdict=${wrong}`);
  const silent = probe([ROW.rx], '');
  add('CLASSIFY_EMPTY_STILL_SILENT', silent === 'silent', `verdict=${silent}`);

  // ③ app.js 真 sendFn + 真绑定链：NRC 不绑，正响应照绑。
  const harness = makeSend(classify);
  const nrcRun = await harness.run(RAW_NRC);
  add('SENDFN_NRC_UXTH_ZERO',
    nrcRun.direct?.uxth === 0 && nrcRun.direct?.reason === 'NRC_NEGATIVE_RESPONSE',
    `uxth=${nrcRun.direct?.uxth ?? '-'} reason=${nrcRun.direct?.reason ?? '-'}`);
  add('SENDFN_NRC_NOTE_RECORDED',
    nrcRun.notes.some((s) => s.includes('NRC 负响应不绑定')),
    `notes=${JSON.stringify(nrcRun.notes)}`);
  add('SENDFN_NRC_BIND_FAILCLOSED',
    nrcRun.bound?.ok === false
      && nrcRun.bound?.code === FAIL_CLOSED_REASON.PROBE_UXTH_NOT_ONE && nrcRun.size === 0,
    `ok=${nrcRun.bound?.ok ?? '-'} code=${nrcRun.bound?.code ?? '-'} size=${nrcRun.size}`);

  const okRun = await harness.run(RAW_OK);
  add('SENDFN_POSITIVE_STILL_BOUND',
    okRun.direct?.uxth === 1 && okRun.bound?.ok === true
      && okRun.bound?.state === 'bound' && okRun.bound?.binding?.frameId === ROW.rx
      && okRun.size === 1,
    `uxth=${okRun.direct?.uxth ?? '-'} state=${okRun.bound?.state ?? '-'} size=${okRun.size}`);

  // ④ 绑定帧常量按 E0 原始字节纠正。
  add('BIND_REQUEST_ID_IS_0X100359', BIND_REQUEST_ID === 0x100359,
    `value=0x${BIND_REQUEST_ID.toString(16)}`);

  return failed;
}

/* ───────────────── 干净源码：必须全绿 ───────────────── */
const cleanFailed = await runSuite(makeClassify(classifySrc), 'CLEAN');
ck('CLEAN_SUITE_ALL_GREEN', cleanFailed.length === 0, `failed=${cleanFailed.length}`);

/* ───────────────── 反例注入：去掉 NRC 判定，同一套断言必须转红 ───────────────── */
const injectedSrc = classifySrc.replace(/const isNrc = [^\n]+;/, 'const isNrc = false;');
ck('INJECT_NRC_GUARD_APPLIED',
  injectedSrc !== classifySrc && /const isNrc = false;/.test(injectedSrc),
  `changed=${injectedSrc !== classifySrc}`);
const injectedFailed = await runSuite(makeClassify(injectedSrc), 'INJECTED', false);
ck('INJECT_NRC_ASSERTION_TURNS_RED', injectedFailed.includes('CLASSIFY_NRC_NOT_ALIVE'),
  `failed=${JSON.stringify(injectedFailed)}`);
ck('INJECT_BIND_ASSERTION_TURNS_RED', injectedFailed.includes('SENDFN_NRC_BIND_FAILCLOSED'),
  `failed=${JSON.stringify(injectedFailed)}`);
ck('INJECT_POSITIVE_STAYS_GREEN',
  !injectedFailed.includes('CLASSIFY_POSITIVE_STILL_ALIVE')
    && !injectedFailed.includes('SENDFN_POSITIVE_STILL_BOUND'),
  '正响应断言在注入版仍绿（证明门禁不是恒真/全拒）');
ck('INJECTED_SUITE_RED', injectedFailed.length > 0, `failed=${injectedFailed.length}`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `NRC_BIND_FAIL_CLOSED_FAIL failed=${failed} total=${results.length}`
  : `NRC_BIND_FAIL_CLOSED_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
