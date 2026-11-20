#!/usr/bin/env node
/**
 * verify-live-map-failclosed.mjs — T03 运行时 live map「fail-closed + 单帧绑定」真执行门禁。
 *
 * T01 架构承诺但一直缺失的真执行 gate：直接 import src/live-map.js 与 src/sweep.js，
 * 全部用 in-memory 断言，**不调用真串口、不依赖 data 重生、不读 cwd / 绝对路径 / Date / random**。
 *
 * 钉住的口径（E-01 / E-05 / E-07 / E-19 / E-20）：
 *   ① 无原生上报 → lookup / bindByRequestKey 一律 fail-closed（reason + nextCarrier + R 级），
 *      且不写缓存；
 *   ② reportNative 后按 requestKey 查到 CAN tx/rx 与 frameId；
 *   ③ bindByRequestKey 每候选恰好 1 帧 221409，绑定入参是请求键（数值形态 CAN 必拒），
 *      只有 uxth===1 且原生回帧 ID==can.rx 才成功；
 *   ④ 四类反例注入（上报缺失仍 bound / 发 9 帧 / 请求键改 CAN / 回帧 ID 错）全部翻红。
 *
 * stdout 每行机器可读：`PASS <ASSERT_NAME> <detail>` / `FAIL ...`；
 * 末行 `LIVE_MAP_FAIL_CLOSED_PASS count=N` 或 `LIVE_MAP_FAIL_CLOSED_FAIL failed=N`；退出码 0 / 1。
 *
 * 用法：node tools/verify-live-map-failclosed.mjs
 */
import {
  FAIL_CLOSED_REASON,
  GRADE_R,
  PROVABLE_RUNTIME,
  PROBE_FRAME,
  clear,
  reportNative,
  lookup,
  bindByRequestKey,
  snapshot,
} from '../src/live-map.js';
import {
  PROBE_FRAME as SWEEP_PROBE_FRAME,
  PROBE_FRAMES_PER_CANDIDATE,
} from '../src/sweep.js';

const results = [];
const ck = (name, pass, detail = '') => {
  const good = Boolean(pass);
  results.push({ name, ok: good });
  console.log(`${good ? 'PASS' : 'FAIL'} ${name} ${detail}`.trimEnd());
};

/** 统一的 fail-closed 形状校验：state/provable/grade/reason/nextCarrier 缺一不可。 */
const isFailClosed = (res, code) => !!res
  && res.ok === false
  && res.state === 'fail-closed'
  && res.provable === PROVABLE_RUNTIME
  && res.grade === GRADE_R
  && res.code === code
  && typeof res.reason === 'string' && res.reason.length > 0
  && typeof res.nextCarrier === 'string' && res.nextCarrier.length > 0
  && Array.isArray(res.evidenceIds) && res.evidenceIds.length > 0;

// 固定 in-memory 真值：请求键空间 0x0030xxxx 与 CAN 11-bit 是两个键空间。
const RK = '0x003006CC';
const CAN = Object.freeze({ tx: 0x0714, rx: 0x077e });
const FRAME = CAN.rx; // 原生观察到的回帧 ID，必须 == can.rx
const hex = (n) => `0x${Number(n).toString(16)}`;

// ── ① 无原生上报：lookup / bindByRequestKey 都 fail-closed，不写缓存 ──────────
clear();
{
  const r = lookup(RK);
  ck('FAILCLOSED_LOOKUP_NO_NATIVE_REPORT',
    isFailClosed(r, FAIL_CLOSED_REASON.NO_NATIVE_REPORT) && snapshot().size === 0,
    `code=${r.code} size=${snapshot().size}`);
  ck('FAILCLOSED_CARRIES_REASON_NEXT_CARRIER_GRADE_R',
    /NO_NATIVE_REPORT/.test(r.reason) && r.nextCarrier.length > 0
      && r.grade === GRADE_R && r.provable === PROVABLE_RUNTIME
      && r.evidenceIds.includes('E-05'),
    `grade=${r.grade} provable=${r.provable} evidence=${r.evidenceIds.length}`);

  // 数值形态 CAN（0x7cf，3 位十六进制）当请求键 → 入口即拒。
  const c = lookup(0x7cf);
  ck('FAILCLOSED_LOOKUP_CAN_NOT_REQUEST_KEY',
    isFailClosed(c, FAIL_CLOSED_REASON.REQUEST_KEY_REQUIRED) && snapshot().size === 0,
    `code=${c.code} size=${snapshot().size}`);

  // 绑定侧：sendFn 只回 uxth 没有原生 report → fail-closed 且不写表。
  const b = await bindByRequestKey(RK, async () => ({ uxth: 1 }));
  ck('FAILCLOSED_BIND_NO_NATIVE_REPORT',
    isFailClosed(b, FAIL_CLOSED_REASON.NATIVE_REPORT_MISSING) && snapshot().size === 0,
    `code=${b.code} size=${snapshot().size}`);

  // 传输层缺失同样 fail-closed。
  const t = await bindByRequestKey(RK, null);
  ck('FAILCLOSED_BIND_NO_TRANSPORT',
    isFailClosed(t, FAIL_CLOSED_REASON.PROBE_TRANSPORT_ERROR) && snapshot().size === 0,
    `code=${t.code} size=${snapshot().size}`);
}

// ── ② reportNative 后按 requestKey 可查到 CAN / frameId ───────────────────────
{
  const r = reportNative({ requestKey: RK, can: CAN, frameId: FRAME, source: 'native' });
  ck('REPORT_NATIVE_BOUND',
    r.ok === true && r.state === 'bound' && r.grade === GRADE_R
      && r.provable === PROVABLE_RUNTIME && snapshot().size === 1,
    `state=${r.state} size=${snapshot().size}`);
  const l = lookup(RK);
  ck('LOOKUP_AFTER_REPORT_RETURNS_CAN_AND_FRAME',
    l.ok === true && l.state === 'bound' && l.grade === GRADE_R
      && l.binding.tx === CAN.tx && l.binding.rx === CAN.rx
      && l.binding.frameId === FRAME && l.binding.requestKey === RK,
    `tx=${hex(CAN.tx)} rx=${hex(CAN.rx)} frameId=${hex(FRAME)}`);
}

// ── ③ bindByRequestKey：单帧 221409 / 入参请求键 / uxth==1 / 回帧 ID 匹配 ─────
clear();
{
  const calls = [];
  const send = async (ctx) => {
    calls.push(Object.freeze({ ...ctx }));
    return { uxth: 1, report: { can: CAN, frameId: FRAME, source: 'native' } };
  };
  const b = await bindByRequestKey(RK, send);
  ck('BIND_OK_UXTH1_FRAME_MATCH',
    b.ok === true && b.state === 'bound' && b.grade === GRADE_R
      && b.binding.tx === CAN.tx && b.binding.rx === CAN.rx && b.binding.frameId === CAN.rx
      && b.probe.frame === PROBE_FRAME && b.probe.uxth === 1,
    `state=${b.state} frameId=${hex(b.binding?.frameId ?? -1)}`);

  ck('BIND_SINGLE_PROBE_FRAME_221409',
    calls.length === 1 && calls[0].probeFrame === PROBE_FRAME && PROBE_FRAME === '221409'
      && PROBE_FRAMES_PER_CANDIDATE === 1 && SWEEP_PROBE_FRAME === PROBE_FRAME,
    `calls=${calls.length} frame=${calls[0]?.probeFrame ?? '-'} ppc=${PROBE_FRAMES_PER_CANDIDATE}`);

  ck('BIND_INPUT_IS_REQUEST_KEY_NOT_CAN',
    calls.length === 1 && calls[0].requestKey === RK && calls[0].requestKey !== hex(CAN.tx),
    `requestKey=${calls[0]?.requestKey ?? '-'}`);

  const l = lookup(RK);
  ck('BIND_WRITES_SAME_LIVE_MAP_TABLE',
    l.ok === true && l.binding.frameId === FRAME && snapshot().size === 1,
    `size=${snapshot().size}`);
}

// ── ④ 四类反例注入：每一种都必须 fail-closed 且不写缓存 ───────────────────────
// 注入一：回执声称已 bound（uxth=1/state=bound），但没有原生 report。
clear();
{
  const r = await bindByRequestKey(RK, async () => ({ uxth: 1, ok: true, state: 'bound' }));
  ck('INJECT_REPORT_MISSING_STILL_BOUND',
    isFailClosed(r, FAIL_CLOSED_REASON.NATIVE_REPORT_MISSING) && snapshot().size === 0,
    `code=${r.code} size=${snapshot().size}`);
}

// 注入二：旧 D 级「发 9 帧全段枚举」回执（数组，无 uxth===1 绑定回执）。
clear();
{
  const nine = Array.from({ length: 9 }, () => ({
    uxth: 1, probeFrame: PROBE_FRAME, report: { can: CAN, frameId: FRAME },
  }));
  const r = await bindByRequestKey(RK, async () => nine);
  ck('INJECT_NINE_FRAMES_REJECTED',
    isFailClosed(r, FAIL_CLOSED_REASON.PROBE_UXTH_NOT_ONE) && snapshot().size === 0,
    `code=${r.code} frames=${nine.length} size=${snapshot().size}`);
}

// uxth !== 1（DriveLinksMode_1001 @0x18f00 cmp #1）单独具名钉住。
clear();
{
  const r = await bindByRequestKey(RK, async () => ({
    uxth: 2, report: { can: CAN, frameId: FRAME, source: 'native' },
  }));
  ck('BIND_UXTH_NOT_ONE_REJECTED',
    isFailClosed(r, FAIL_CLOSED_REASON.PROBE_UXTH_NOT_ONE) && snapshot().size === 0,
    `code=${r.code} size=${snapshot().size}`);
}

// 注入三：绑定入参从请求键改成 CAN 数值形态 → 入口拒。
clear();
{
  const r = await bindByRequestKey(0x7cf, async () => ({
    uxth: 1, report: { can: CAN, frameId: FRAME, source: 'native' },
  }));
  ck('INJECT_CAN_AS_REQUEST_KEY_REJECTED',
    isFailClosed(r, FAIL_CLOSED_REASON.REQUEST_KEY_REQUIRED) && snapshot().size === 0,
    `code=${r.code} size=${snapshot().size}`);
}

// 注入四：原生回帧 ID 错（!= can.rx）→ 拒绑。
clear();
{
  const badFrame = CAN.rx + 1;
  const r = await bindByRequestKey(RK, async () => ({
    uxth: 1, report: { can: CAN, frameId: badFrame, source: 'native' },
  }));
  ck('INJECT_WRONG_FRAME_ID_REJECTED',
    isFailClosed(r, FAIL_CLOSED_REASON.NATIVE_REPORT_INVALID) && snapshot().size === 0,
    `code=${r.code} frameId=${hex(badFrame)} size=${snapshot().size}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `LIVE_MAP_FAIL_CLOSED_FAIL failed=${failed} total=${results.length}`
  : `LIVE_MAP_FAIL_CLOSED_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
