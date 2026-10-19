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
 * @param {number[]|Uint8Array} body  正响应 body（已剥掉 CAN 头/ISO-TP PCI）
 * @returns {{protocol:'uds'|'kwp'|'unknown', dtcs:Array<{code:string,status:number}>, raw:number[]}}
 */
export function parseDtcPayload(body) {
  const b = Array.from(body || []);
  if (!b.length) return { protocol: 'unknown', dtcs: [], raw: b };

  // UDS ReadDTCInformation 0x59：59 <sub> <statusAvailabilityMask> + 3 字节/条
  if (b[0] === 0x59 && b.length >= 3) {
    const data = b.slice(3);
    const dtcs = [];
    for (let i = 0; i + 2 < data.length; i += 3) {
      dtcs.push({
        code: dtcCodeFromBytes(data[i], data[i + 1]),
        status: data[i + 2],
      });
    }
    return { protocol: 'uds', dtcs, raw: b };
  }

  // KWP ReadDTCByStatus 0x58：58 <count> + 3 字节/条
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
    return { protocol: 'kwp', dtcs, raw: b };
  }

  return { protocol: 'unknown', dtcs: [], raw: b };
}
