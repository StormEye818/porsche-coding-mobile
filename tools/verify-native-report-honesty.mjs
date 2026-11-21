#!/usr/bin/env node
/**
 * verify-native-report-honesty.mjs — 阶段 C「禁止静态冒充 R 级上报」真执行门禁。
 *
 * 背景（E0/E-05）：请求键→CAN 绑定的真值只能来自原生发现上报（R 级 frameId / 回帧）。
 * 旧 `src/app.js` 在 `nativeProbeForRow()` / `tryAddr()` 里用
 *   `ids.length ? ids.find(...) : row.rx`（或 `: p.rx`）把静态候选 rx 当成观测帧 ID，
 * 于是「有 body 但无帧 ID」的应答仍会被 reportNative 接受 —— 静态冒充 R 级。
 *
 * 本门禁不是同形状 fixture 自证：它**抽取 src/app.js 中这两个真实函数的源码文本**
 * （花括号配对，跳过字符串/注释），用 `new Function` 注入依赖后**真执行**：
 *   - frameIdsOf / parseRespAuto / classifyProbe 用真实 src 实现；
 *   - ELM 回帧文本由测试注入（无 body / 错 rx / 正解三种）；
 *   - 绑定链调用真实 src/live-map.js:bindByRequestKey()（内部 reportNative）。
 * 并对抽取源码做静态守卫检查；最后把「`: row.rx` / `: p.rx` 兜底」再注入回源码，
 * 断言同一个门禁立即转红（自证判据可判伪）。
 *
 * stdout 每行机器可读：`PASS <ASSERT_NAME> <detail>` / `FAIL ...`；
 * 末行 `NATIVE_REPORT_HONESTY_PASS count=N` 或 `NATIVE_REPORT_HONESTY_FAIL failed=N`；退出码 0/1。
 *
 * 用法：node tools/verify-native-report-honesty.mjs
 *   # 仅用于外部注入自检：指向一份把静态兜底恢复的 app.js 副本，本工具必须退出 1。
 *   NATIVE_HONESTY_APP=/tmp/injected-app.js node tools/verify-native-report-honesty.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAIL_CLOSED_REASON, clear, snapshot, bindByRequestKey, PROBE_FRAME,
} from '../src/live-map.js';
import { frameIdsOf, parseRespAuto } from '../src/coder.js';
import { classifyProbe } from '../src/sweep.js';

const APP_FILE = process.env.NATIVE_HONESTY_APP
  ? resolve(process.env.NATIVE_HONESTY_APP)
  : fileURLToPath(new URL('../src/app.js', import.meta.url));
const APP_SRC = readFileSync(APP_FILE, 'utf8');

const results = [];
const ck = (name, pass, detail = '') => {
  const good = Boolean(pass);
  results.push({ name, ok: good });
  console.log(`${good ? 'PASS' : 'FAIL'} ${name} ${detail}`.trimEnd());
};

/* ───────────────── 源码抽取（不复制被测实现，改源码即改被测对象） ───────────────── */

/**
 * 从左花括号起做配对，跳过单/双引号、模板串与注释；返回右花括号下标。
 * @param {string} text 源码
 * @param {number} openIdx 左花括号下标
 * @returns {number} 右花括号下标，失败返回 -1
 */
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

/** 抽取 `async function nativeProbeForRow(row) { ... }` 全文。 */
function extractProbeSource() {
  const sig = 'async function nativeProbeForRow(row)';
  const start = APP_SRC.indexOf(sig);
  if (start < 0) return null;
  const open = APP_SRC.indexOf('{', start + sig.length);
  const end = matchBrace(APP_SRC, open);
  return end < 0 ? null : APP_SRC.slice(start, end + 1);
}

/** 抽取 tryAddr 内 `bindByRequestKey(rkInput(rk), async () => { ... })` 的 sendFn 全文。 */
function extractSendSource() {
  const marker = 'bindByRequestKey(rkInput(rk), async () =>';
  const at = APP_SRC.indexOf(marker);
  if (at < 0) return null;
  const arrow = APP_SRC.indexOf('async () =>', at);
  const open = APP_SRC.indexOf('{', arrow);
  const end = matchBrace(APP_SRC, open);
  return end < 0 ? null : APP_SRC.slice(arrow, end + 1);
}

const probeSrc = extractProbeSource();
const sendSrc = extractSendSource();
ck('APP_NATIVE_PROBE_SOURCE_EXTRACTED',
  !!probeSrc && /frameIdsOf\(raw\)/.test(probeSrc) && /NO_OBSERVED_FRAME_ID/.test(probeSrc),
  `bytes=${probeSrc ? probeSrc.length : 0}`);
ck('APP_TRYADDR_SENDFN_SOURCE_EXTRACTED',
  !!sendSrc && /frameIdsOf\(raw\)/.test(sendSrc) && /NO_OBSERVED_FRAME_ID/.test(sendSrc),
  `bytes=${sendSrc ? sendSrc.length : 0}`);
if (!probeSrc || !sendSrc) {
  console.log('NATIVE_REPORT_HONESTY_FAIL failed=2');
  process.exit(1);
}

/* ───────────────── 注入执行：被测函数源码 + 真实依赖 + 注入回帧 ───────────────── */

const ROW = Object.freeze({ tx: 0x070d, rx: 0x0777, requestKey: '0x003006CC' });
const RK = '0x003006CC';
/** 三种真实回帧文本：frameIdsOf 分别解析为 [] / [0x788] / [0x777]，body 均非空。 */
const RAW_NO_ID = '62 14 09 01';
const RAW_WRONG_ID = '788 62 14 09 01';
const RAW_MATCH = '777 62 14 09 01';
const hex = (n) => `0x${Number(n).toString(16).toUpperCase()}`;

function makeProbe(src, raw) {
  const coder = { elm: { cmd: async () => raw } };
  const atCmdOk = async () => ({ ok: true });
  const hx = (n) => Number(n).toString(16).toUpperCase();
  // eslint-disable-next-line no-new-func -- 注入依赖后真执行被测源码，不是复制实现
  const factory = new Function('coder', 'atCmdOk', 'hx', 'PROBE_FRAME',
    'frameIdsOf', 'parseRespAuto', 'classifyProbe', `return (${src});`);
  return factory(coder, atCmdOk, hx, PROBE_FRAME, frameIdsOf, parseRespAuto, classifyProbe);
}

function makeSend(src, raw, notes) {
  const coder = { elm: { cmd: async () => raw } };
  const note = (s) => notes.push(String(s));
  const p = { tx: ROW.tx, rx: ROW.rx, requestKey: RK };
  // eslint-disable-next-line no-new-func -- 注入依赖后真执行被测源码，不是复制实现
  const factory = new Function('coder', 'cmd', 'p', 'note', 'hex',
    'frameIdsOf', 'parseRespAuto', `return (${src});`);
  return factory(coder, '221409', p, note, hex, frameIdsOf, parseRespAuto);
}

/**
 * 对一组源码跑完整判据集合（静态 + 行为）。
 * @returns {{checks:Array<{name:string,ok:boolean,detail:string}>, ok:boolean}}
 */
async function honestyCheck(probeCode, sendCode) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

  // 静态：任何 `... ? ... : row.rx/p.rx` 或 `frameId: row.rx/p.rx` 都是冒充。
  const RX_FALLBACK = /frameId\s*=[^\n;]*\?[^\n;]*:\s*(?:row|p)\.rx\b/;
  const RX_DIRECT = /frameId\s*:\s*(?:row|p)\.rx\b/;
  add('PROBE_NO_STATIC_RX_FALLBACK',
    !RX_FALLBACK.test(probeCode) && !RX_DIRECT.test(probeCode),
    `fallback=${RX_FALLBACK.test(probeCode) || RX_DIRECT.test(probeCode)}`);
  add('BIND_NO_STATIC_RX_FALLBACK',
    !RX_FALLBACK.test(sendCode) && !RX_DIRECT.test(sendCode),
    `fallback=${RX_FALLBACK.test(sendCode) || RX_DIRECT.test(sendCode)}`);
  add('PROBE_OBSERVED_FRAME_GUARD_PRESENT', probeCode.includes('NO_OBSERVED_FRAME_ID'));
  add('BIND_OBSERVED_FRAME_GUARD_PRESENT', sendCode.includes('NO_OBSERVED_FRAME_ID'));

  /** 单场景真执行：probe + 真实 bindByRequestKey，返回可断言形状。 */
  const behave = async (raw) => {
    clear();
    const probe = await makeProbe(probeCode, raw)(ROW);
    const notes = [];
    const bound = await bindByRequestKey(RK, makeSend(sendCode, raw, notes));
    return { probe, bound, size: snapshot().size, notes };
  };

  // ① 有 body、无帧 ID → probe uxth=0 / reason 明确；绑定链 fail-closed 且不写表。
  const noId = await behave(RAW_NO_ID);
  add('PROBE_BODY_WITHOUT_FRAME_ID_FAILS',
    noId.probe?.uxth === 0 && noId.probe?.reason === 'NO_OBSERVED_FRAME_ID',
    `uxth=${noId.probe?.uxth ?? '-'} reason=${noId.probe?.reason ?? '-'}`);
  add('BIND_BODY_WITHOUT_FRAME_ID_FAILCLOSED',
    noId.bound?.ok === false && noId.bound?.code === FAIL_CLOSED_REASON.PROBE_UXTH_NOT_ONE
      && noId.size === 0,
    `ok=${noId.bound?.ok ?? '-'} code=${noId.bound?.code ?? '-'} size=${noId.size}`);

  // ② 帧 ID 存在但不等于候选 rx → 不绑定。
  const wrong = await behave(RAW_WRONG_ID);
  add('PROBE_WRONG_FRAME_ID_REJECTED',
    wrong.probe?.uxth === 0 && wrong.probe?.frameId === undefined,
    `ids=${JSON.stringify(frameIdsOf(RAW_WRONG_ID))} uxth=${wrong.probe?.uxth ?? '-'}`);
  add('BIND_WRONG_FRAME_ID_FAILCLOSED',
    wrong.bound?.ok === false && wrong.size === 0,
    `ok=${wrong.bound?.ok ?? '-'} code=${wrong.bound?.code ?? '-'} size=${wrong.size}`);

  // ③ 帧 ID == rx 且有 body → 可进入绑定链（不是把门禁变成全拒）。
  const good = await behave(RAW_MATCH);
  add('PROBE_OBSERVED_FRAME_MATCH_BOUND',
    good.probe?.uxth === 1 && good.probe?.source === 'native'
      && good.probe?.frameId === ROW.rx && !!good.probe?.body,
    `uxth=${good.probe?.uxth ?? '-'} frameId=${hex(good.probe?.frameId ?? -1)} body=${good.probe?.body ?? '-'}`);
  add('BIND_OBSERVED_FRAME_MATCH_BOUND',
    good.bound?.ok === true && good.bound?.state === 'bound'
      && good.bound?.binding?.frameId === ROW.rx && good.bound?.binding?.rx === ROW.rx
      && good.size === 1,
    `state=${good.bound?.state ?? '-'} frameId=${hex(good.bound?.binding?.frameId ?? -1)} size=${good.size}`);

  return { checks, ok: checks.every((c) => c.ok) };
}

/* ───────────────── 主门禁：干净源码必须全绿 ───────────────── */
const clean = await honestyCheck(probeSrc, sendSrc);
for (const c of clean.checks) ck(c.name, c.ok, c.detail);

/* ───────────────── 自证判伪：把静态兜底注入回去，门禁必须转红 ───────────────── */
const injectedProbe = probeSrc
  .replace(' : undefined;', ' : row.rx;')
  .replace('if (!Number.isInteger(frameId) || frameId !== row.rx) {', 'if (false) {');
const injectedSend = sendSrc
  .replace(' : undefined;', ' : p.rx;')
  .replace('if (!Number.isInteger(frameId) || frameId !== p.rx) {', 'if (false) {');
ck('INJECT_FALLBACK_TEXT_APPLIED',
  injectedProbe !== probeSrc && injectedSend !== sendSrc
    && /:\s*row\.rx;/.test(injectedProbe) && /:\s*p\.rx;/.test(injectedSend),
  `probeChanged=${injectedProbe !== probeSrc} sendChanged=${injectedSend !== sendSrc}`);

const injected = await honestyCheck(injectedProbe, injectedSend);
const redNames = injected.checks.filter((c) => !c.ok).map((c) => c.name);
ck('INJECT_STATIC_RX_FALLBACK_TURNS_GATE_RED',
  redNames.includes('PROBE_NO_STATIC_RX_FALLBACK')
    && redNames.includes('BIND_NO_STATIC_RX_FALLBACK')
    && injected.ok === false,
  `failed=${redNames.length} names=${redNames.join(',')}`);
ck('INJECT_BEHAVIOR_TURNS_GATE_RED',
  redNames.includes('PROBE_BODY_WITHOUT_FRAME_ID_FAILS')
    && redNames.includes('BIND_BODY_WITHOUT_FRAME_ID_FAILCLOSED'),
  `failed=${redNames.length}`);
{
  // 被注入的版本在「有 body 无帧 ID」下确实伪造出 uxth=1/frameId=row.rx —— 证明场景可判伪。
  clear();
  const fake = await makeProbe(injectedProbe, RAW_NO_ID)(ROW);
  ck('INJECT_FAKE_NATIVE_REPORT_REPRODUCED',
    fake?.uxth === 1 && fake?.frameId === ROW.rx,
    `uxth=${fake?.uxth ?? '-'} frameId=${hex(fake?.frameId ?? -1)}`);
}

/* ───────────────── 阶段 B 边界不被回拉 ───────────────── */
ck('SIM_MODE_STILL_ISOLATED',
  /function simAddrEvidence\(row, detail\)[\s\S]{0,500}state:\s*'sim'[\s\S]{0,200}provable:\s*'sim'/.test(APP_SRC)
    && APP_SRC.includes('阶段 B 短路点'),
  '模拟仍标 state/provable=sim，不进真车 R 级 gate');
ck('NO_OTHER_FRAMEID_FALLBACK_IN_APP',
  !/frameId\s*=[^\n;]*\?[^\n;]*:\s*(?:row|p)\.rx\b/.test(APP_SRC)
    && !/frameId\s*:\s*(?:row|p)\.rx\b/.test(APP_SRC),
  'src/app.js 全文无静态 rx 冒充 frameId 的写法');

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `NATIVE_REPORT_HONESTY_FAIL failed=${failed} total=${results.length}`
  : `NATIVE_REPORT_HONESTY_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
