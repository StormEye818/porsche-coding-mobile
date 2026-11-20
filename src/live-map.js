/**
 * live-map.js — E0 证据包连接期 live map（E0 账本 E-01 / E-05 / E-07 / E-19 / E-20）。
 *
 * ★ 关键口径（禁止回归）：
 *   - 请求键空间 `0x0030xxxx` / `0xFF60xxxx`（DRIVELINKS addrBlock 行键 A）
 *     与 CAN 空间（11-bit 请求/应答 ID）是**两个键空间**，不可互取低 16 位。
 *   - 「哪条 CAN 真的应答了、请求键最终绑到哪条 CAN」在 E0 证据包内三次负扫描 0 命中，
 *     只有 R 级原生发现上报（showAddress 族回调）能给真值。Java/JS 层不生成地址。
 *   - 拿不到原生上报 → fail-closed：带 reason + nextCarrier + R 级标注；
 *     禁止静态写死 CAN、禁止把 D 级「0x700–0x7FF / 200ms 全段枚举」当参考诊断仪做法。
 *   - 绑定只认 `uxth == 1`（DriveLinksMode_1001 @LINK:0x18f00 `cmp #1`），
 *     每候选只 1 帧 `22 14 09`（`0xFF001409`），n==0 跳过探针循环；
 *     NRC / 无名应答都不算绑定成功。
 *
 * 本模块只描述「上报进来怎么存、查不到怎么失败」；候选行的静态选取在 sweep.js。
 */

/** 证据分级 / provable 标注（R 级：机制 S 可证，真值需车上应答）。 */
export const GRADE_R = 'R';
export const PROVABLE_RUNTIME = 'runtime';
export const LIVE_MAP_EVIDENCE_IDS = Object.freeze(['E-01', 'E-05', 'E-07', 'E-19', 'E-20']);

/** 参考诊断仪发现循环常量（E-01 / PE-01 / PE-02；不是 CAN 地址）。 */
export const PROBE_FRAME = '221409';
export const PROBE_REQUEST_ID = 0xff001409;
export const BIND_REQUEST_ID = 0x10000359;
export const BIND_COMPLETE_FRAME = '221102';
export const BIND_UXTH_OK = 1;

/** 请求键空间标志（E-06）。 */
export const REQUEST_KEY_FLAG_PRIMARY = 0x00300000;
export const REQUEST_KEY_FLAG_ALT = 0xff600000;

/** fail-closed 文案锚点（T04 注入自检按这些名字 grep）。 */
export const FAIL_CLOSED_REASON = Object.freeze({
  NO_NATIVE_REPORT: 'LIVE_MAP_NO_NATIVE_REPORT',
  REQUEST_KEY_REQUIRED: 'LIVE_MAP_REQUEST_KEY_REQUIRED',
  PROBE_TRANSPORT_ERROR: 'LIVE_MAP_PROBE_TRANSPORT_ERROR',
  PROBE_UXTH_NOT_ONE: 'LIVE_MAP_PROBE_UXTH_NOT_ONE',
  NATIVE_REPORT_MISSING: 'LIVE_MAP_NATIVE_REPORT_MISSING',
  NATIVE_REPORT_INVALID: 'LIVE_MAP_NATIVE_REPORT_INVALID',
  FRAME_ID_MISMATCH: 'LIVE_MAP_FRAME_ID_MISMATCH',
});
export const NEXT_CARRIER =
  '原生诊断地址上报接口未就绪（请求键→已应答 CAN 的运行时映射）；'
  + '请按 E-05 / E-19 / E-20 证据载体检查连接期地址发现上报';
export const SCAN_COMMAND =
  "grep -n 'E-05\\|E-19\\|E-20' docs/evidence/*linkmap*.md";

/** 模块级 live map：requestKey(canonical) → {tx, rx, frameId, ...}。 */
const bindings = new Map();

/**
 * 生成 fail-closed 结果。任何失败分支都必须经这里，绝不返回 ok:true。
 *
 * @param {string} code FAIL_CLOSED_REASON 中的具名原因
 * @param {object} [extra] 追加的机器可读字段（不改变 state/provable）
 * @returns {{ok:false, state:'fail-closed', provable:'runtime', grade:'R',
 *            reason:string, code:string, nextCarrier:string, scanCommand:string,
 *            evidenceIds:readonly string[]}}
 */
export function failClosed(code, extra = {}) {
  const reasonCode = FAIL_CLOSED_REASON[code] || String(code || 'LIVE_MAP_UNSPECIFIED');
  return {
    ok: false,
    state: 'fail-closed',
    provable: PROVABLE_RUNTIME,
    grade: GRADE_R,
    code: reasonCode,
    reason: `${reasonCode}：无 R 级原生发现上报，请求键→CAN 绑定不成立；`
      + '不静态写死 CAN、不标 A、不执行全段枚举。',
    nextCarrier: NEXT_CARRIER,
    scanCommand: SCAN_COMMAND,
    evidenceIds: LIVE_MAP_EVIDENCE_IDS,
    ...extra,
  };
}

/**
 * 请求键归一：只认请求键空间或未省略标志的低 16 位请求键。
 *
 * 低 16 位形态必须显式声明 `kind:'request-key'`（或 `rk:` 前缀），
 * 这样「把 CAN 低 16 位当请求键」在入口即被拒绝——CAN 11-bit 最大 0x7FF，
 * 请求键低 16 位必须补足 4 位十六进制（如 0x06CC）。
 *
 * @param {number|string|{kind:string,value:number|string}} raw
 * @returns {string|null} canonical `0x0030xxxx` / `0xFF60xxxx`，非法返回 null
 */
export function canonicalRequestKey(raw) {
  let value = raw;
  let declared = false;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    declared = String(raw.kind || '') === 'request-key';
    value = raw.value;
  }
  let text = typeof value === 'number' ? value : String(value ?? '').trim();
  if (typeof text === 'string' && text.toLowerCase().startsWith('rk:')) {
    declared = true;
    text = text.slice(3);
  }
  let n = NaN;
  if (typeof text === 'number') n = text;
  else if (/^0x[0-9a-fA-F]+$/.test(text)) n = Number.parseInt(text, 16);
  else if (/^[0-9a-fA-F]{4,8}$/.test(text)) n = Number.parseInt(text, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;

  const high = (n >>> 16) & 0xffff;
  // 带 0x0030/0xFF60 标志的完整请求键可直接识别（数值或字符串均可）。
  if (n >= REQUEST_KEY_FLAG_PRIMARY && n <= (REQUEST_KEY_FLAG_PRIMARY | 0xffff)) {
    return `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  if (n >= REQUEST_KEY_FLAG_ALT && n <= (REQUEST_KEY_FLAG_ALT | 0xffff)) {
    return `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  // 低 16 位请求键：必须显式声明 kind，且必须是**4 位十六进制字符串**。
  // 11-bit CAN（如 0x7E0）只有 3 位，数值形态不可判；这里直接拒绝，
  // 使「把 CAN 当请求键入参」在入口翻红（T04 注入自检）。
  if (high !== 0 || !declared || typeof text !== 'string'
      || !(/^0x[0-9a-fA-F]{4}$/.test(text) || /^[0-9a-fA-F]{4}$/.test(text))) return null;
  return `0x${(REQUEST_KEY_FLAG_PRIMARY | n).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** 只暴露只读快照，调用方不能绕过 reportNative 写表。 */
export function snapshot() {
  const out = new Map();
  for (const [key, rec] of bindings) out.set(key, Object.freeze({ ...rec }));
  return out;
}

/** 清空 live map（仅用于车型切换 / 自检重置）。 */
export function clear() {
  bindings.clear();
  return { ok: true, state: 'unavailable', provable: PROVABLE_RUNTIME, grade: GRADE_R, size: 0 };
}

/**
 * 原生发现上报入口。只有收到这条上报，请求键→CAN 的绑定才成立。
 *
 * @param {{requestKey:number|string|object, can:{tx:number,rx:number},
 *          frameId:number, source?:string}} report
 * @returns {object} LiveMapResult
 */
export function reportNative(report) {
  if (!report || typeof report !== 'object') return failClosed(FAIL_CLOSED_REASON.NATIVE_REPORT_MISSING);
  if (report.source != null && String(report.source) !== 'native') {
    return failClosed(FAIL_CLOSED_REASON.NATIVE_REPORT_INVALID, { source: String(report.source) });
  }
  const key = canonicalRequestKey(report.requestKey);
  if (!key) return failClosed(FAIL_CLOSED_REASON.REQUEST_KEY_REQUIRED,
    { requestKey: String(report.requestKey ?? '') });
  const can = report.can;
  const tx = Number(can?.tx);
  const rx = Number(can?.rx);
  const frameId = Number(report.frameId);
  // 11-bit 合法性检查只做结构校验，不生成任何地址；CAN 真值必须来自上报实参。
  if (!Number.isInteger(tx) || tx <= 0 || tx > 0x7ff
      || !Number.isInteger(rx) || rx <= 0 || rx > 0x7ff
      || !Number.isInteger(frameId) || frameId <= 0 || frameId > 0x7ff
      || frameId !== rx) {
    return failClosed(FAIL_CLOSED_REASON.NATIVE_REPORT_INVALID,
      { requestKey: key, tx, rx, frameId });
  }
  const rec = Object.freeze({
    tx,
    rx,
    frameId,
    requestKey: key,
    can: Object.freeze({ tx, rx, provable: PROVABLE_RUNTIME }),
  });
  bindings.set(key, rec);
  return {
    ok: true,
    state: 'bound',
    provable: PROVABLE_RUNTIME,
    grade: GRADE_R,
    map: snapshot(),
    binding: rec,
    evidenceIds: LIVE_MAP_EVIDENCE_IDS,
  };
}

/**
 * 按请求键查 live map。查不到（含上报缺失）一律 fail-closed。
 *
 * @param {number|string|object} requestKey 请求键（不是 CAN）
 * @returns {object} LiveMapResult
 */
export function lookup(requestKey) {
  const key = canonicalRequestKey(requestKey);
  if (!key) return failClosed(FAIL_CLOSED_REASON.REQUEST_KEY_REQUIRED,
    { requestKey: String(requestKey ?? '') });
  const binding = bindings.get(key);
  if (!binding) return failClosed(FAIL_CLOSED_REASON.NO_NATIVE_REPORT, { requestKey: key });
  return {
    ok: true,
    state: 'bound',
    provable: PROVABLE_RUNTIME,
    grade: GRADE_R,
    map: snapshot(),
    binding,
    evidenceIds: LIVE_MAP_EVIDENCE_IDS,
  };
}

/**
 * 每候选 1 帧探针 + 请求键绑定（E-01：send(0x10000359, A, 2)，uxth==1 才绑）。
 *
 * `sendFn` 是原生链路边界：入参只有请求键与探针帧，返回值必须带
 * `uxth`（回执码）以及原生观察到的 `{can:{tx,rx}, frameId}`；
 * 缺任一项都不能绑（JS 不生成 CAN）。
 *
 * 成功路径内部调用 reportNative()，因此绑定记录与直接上报共用同一张表。
 *
 * @param {number|string|object} requestKey 请求键（低 16 位须显式声明）
 * @param {(ctx:object)=>Promise<object>|object} sendFn 原生发送函数
 * @returns {Promise<object>} LiveMapResult
 */
export async function bindByRequestKey(requestKey, sendFn) {
  const key = canonicalRequestKey(requestKey);
  if (!key) return failClosed(FAIL_CLOSED_REASON.REQUEST_KEY_REQUIRED,
    { requestKey: String(requestKey ?? '') });
  if (typeof sendFn !== 'function') return failClosed(FAIL_CLOSED_REASON.PROBE_TRANSPORT_ERROR,
    { requestKey: key });

  let res = null;
  try {
    // ★ 每候选恰好 1 帧；不重试、不补帧枚举、不发身份帧。
    res = await sendFn({
      requestKey: key,
      probeFrame: PROBE_FRAME,
      probeRequestId: PROBE_REQUEST_ID,
      bindRequestId: BIND_REQUEST_ID,
    });
  } catch (e) {
    return failClosed(FAIL_CLOSED_REASON.PROBE_TRANSPORT_ERROR,
      { requestKey: key, error: String(e?.message || e) });
  }
  if (!res || res.uxth !== BIND_UXTH_OK) {
    return failClosed(FAIL_CLOSED_REASON.PROBE_UXTH_NOT_ONE,
      { requestKey: key, uxth: res?.uxth ?? null });
  }
  const report = res.report || res;
  if (!report.can || report.frameId == null || (report.source != null && report.source !== 'native')) {
    return failClosed(FAIL_CLOSED_REASON.NATIVE_REPORT_MISSING, { requestKey: key });
  }
  const bound = reportNative({ ...report, requestKey: key, source: 'native' });
  if (!bound.ok) return bound;
  return {
    ...bound,
    probe: Object.freeze({ frame: PROBE_FRAME, uxth: BIND_UXTH_OK }),
  };
}

/** 供原生层安装的回调桥（只转发，不生成地址）。 */
export function nativeReporter() {
  return (report) => reportNative(report && typeof report === 'object'
    ? { ...report, source: 'native' } : report);
}
