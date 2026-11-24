/**
 * dtc.js — 故障码应答解析（UDS 0x59 / KWP 0x58）。
 *
 * 为什么单独抽出来：
 *   项目里同时存在 UDS（`19 02 89`）和 KWP（`18 00 40 00`）两条读码路径，
 *   两者的应答头不同。早先 `app.js` 只按 UDS 解析（`59 02 mask` 后每 3 字节一组），
 *   一旦 `readDtc()` 回退到 KWP，`58 ...` 会被整体错位，显示出一堆垃圾码。
 *   这里把两种格式分开解析，未知格式原样返回，绝不猜。
 *
 * 格式（实测 + ISO 14229 / KWP2000）：
 *   UDS: `59 <sub> <mask> [DTC_hi DTC_lo status]...`
 *   KWP: `58 <count> [DTC_hi DTC_lo status]...`（部分 ECU 的 count 不可靠，按长度兜底）
 *
 * ★ v0.8.4：参考诊断仪应答层条长是**运行时描述符**，不是写死的 3。
 *   取证（DTCF）：`PorscheReadDtc@0x15f7c` 用 `0x15f80 uxtb r8,r4` 取条长、
 *   `0x15f86 blx 0x14090` 做整数除法、`0x15fda add r1,r8` 按条长步进；
 *   `PorscheCalcDtcCount@0x17dfc` 同模式 `(长度-头长)/条长`。
 *   因此下面的 3B/条路径仅为兼容旧的 59/58 调用点（`descriptorUsed:false`），
 *   **不是参考诊断仪的做法**，不得据此声称已按其条长解析。
 */

/** 2 字节 DTC → `P/C/B/U` + 4 位十六进制（与 UDS 的 3 字节 DTC 前两字节同构） */
export function dtcCodeFromBytes(b1, b2) {
  const typeChar = ['P', 'C', 'B', 'U'][(b1 >> 6) & 3];
  const d1 = ((b1 >> 4) & 3).toString(16).toUpperCase();
  const d2 = (b1 & 0xf).toString(16).toUpperCase();
  const d3 = (b2 >> 4).toString(16).toUpperCase();
  const d4 = (b2 & 0xf).toString(16).toUpperCase();
  return `${typeChar}${d1}${d2}${d3}${d4}`;
}

/**
 * 把 1/2/3 字节 DTC 标识渲染成码。
 *   1 字节：高 2 位给 P/C/B/U、低 6 位给码 → `P00xx`；
 *   2 字节：沿用 `dtcCodeFromBytes` → `Pxxxx`；
 *   3 字节：前两字节给 5 位码，第三字节追加 2 位十六进制（failure type）→ `Pxxxxxx`。
 * @param {number[]} bytes DTC 标识字节（1–3 个）
 * @returns {string} DTC 码
 */
function dtcCodeFromWidth(bytes) {
  if (bytes.length === 1) {
    const b = bytes[0];
    const typeChar = ['P', 'C', 'B', 'U'][(b >> 6) & 3];
    return `${typeChar}00${(b & 0x3f).toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (bytes.length === 2) return dtcCodeFromBytes(bytes[0], bytes[1]);
  return `${dtcCodeFromBytes(bytes[0], bytes[1])}${bytes[2].toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * 解析故障码应答。参考诊断仪路径必须给 descriptor；不给则是旧 3B 兼容回退。
 *
 * descriptor 字段：
 *   - `entryLen`  : 每条字节数（正整数），按它步进（参考诊断仪 `add r1,r8`）；
 *   - `headerLen` : 应答头字节数（非负整数），按它跳头；
 *   - `format`    : 1/2/3 = DTC 标识字节数的上限；status 恒取该条**最后一字节**。
 *                   （UDS 常见 3 字节条目 = format:3 + entryLen:3 → 2B DTC + 1B status。）
 *   - `count`     : 优先采用的条数；null/缺省 = `floor(data.length / entryLen)`，
 *                   与参考诊断仪整数除法一致；给得超出可容纳条数时截断，不越界读。
 *
 * 未知 format / 非法 descriptor → `protocol:'unknown'` + 原始 hex，fail-closed，不猜。
 *
 * @param {number[]|Uint8Array} body 正响应 body（已剥掉 CAN 头/ISO-TP PCI）
 * @param {{entryLen:number, headerLen:number, format:1|2|3, count:number|null}|null} descriptor
 *        参考诊断仪应答层条长描述符；null = 旧 3B 兼容回退（`descriptorUsed:false`）
 * @returns {{protocol:'uds'|'kwp'|'descriptor'|'unknown',
 *            dtcs:Array<{code:string,status:number}>, raw:number[], descriptorUsed:boolean}}
 */
export function parseDtcPayload(body, descriptor = null) {
  const b = Array.from(body || []);
  const unknown = (descriptorUsed = false) => ({ protocol: 'unknown', dtcs: [], raw: b, descriptorUsed });
  if (!b.length) return unknown();

  // ★ 参考诊断仪描述符路径：条长/头长/count 全部来自调用点的显式参数，不再写死 3。
  if (descriptor !== null && descriptor !== undefined) {
    const d = descriptor;
    const entryLen = Number.isInteger(d.entryLen) && d.entryLen > 0 ? d.entryLen : 0;
    const headerLen = Number.isInteger(d.headerLen) && d.headerLen >= 0 ? d.headerLen : -1;
    const fmt = d.format;
    const hasCount = Number.isInteger(d.count) && d.count >= 0;
    if (!entryLen || headerLen < 0 || headerLen > b.length || ![1, 2, 3].includes(fmt)) {
      return unknown(false);
    }
    const data = b.slice(headerLen);
    const byLen = Math.floor(data.length / entryLen);
    const count = hasCount ? Math.min(d.count, byLen) : byLen;
    // format 是 DTC 标识字节数的上限，status 取条目末字节；两者都只由显式 descriptor 决定。
    const codeLen = Math.min(fmt, entryLen - 1);
    if (codeLen < 1) return unknown(false);
    const dtcs = [];
    for (let i = 0; i < count; i++) {
      const off = i * entryLen;
      dtcs.push({
        code: dtcCodeFromWidth(data.slice(off, off + codeLen)),
        status: data[off + entryLen - 1],
      });
    }
    const protocol = b[0] === 0x58 ? 'kwp' : b[0] === 0x59 ? 'uds' : 'descriptor';
    return { protocol, dtcs, raw: b, descriptorUsed: true };
  }

  // UDS ReadDTCInformation 0x59：59 <sub> <statusAvailabilityMask> + 3 字节/条
  // （无 descriptor 的兼容回退路径，不是参考诊断仪的做法）
  if (b[0] === 0x59 && b.length >= 3) {
    const data = b.slice(3);
    const dtcs = [];
    for (let i = 0; i + 2 < data.length; i += 3) {
      dtcs.push({
        code: dtcCodeFromBytes(data[i], data[i + 1]),
        status: data[i + 2],
      });
    }
    return { protocol: 'uds', dtcs, raw: b, descriptorUsed: false };
  }

  // KWP ReadDTCByStatus 0x58：58 <count> + 3 字节/条（兼容回退）
  if (b[0] === 0x58 && b.length >= 2) {
    const data = b.slice(2);
    const byLen = Math.floor(data.length / 3);
    const count = Number.isFinite(b[1]) && b[1] > 0 ? Math.min(b[1], byLen) : byLen;
    const dtcs = [];
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      dtcs.push({
        code: dtcCodeFromBytes(data[o], data[o + 1]),
        status: data[o + 2],
      });
    }
    return { protocol: 'kwp', dtcs, raw: b, descriptorUsed: false };
  }

  return unknown(false);
}
