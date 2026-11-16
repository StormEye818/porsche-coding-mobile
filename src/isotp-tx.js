/**
 * isotp-tx.js — ISO-TP（ISO 15765-2）**发送方向**的分段与流控解析。
 *
 * 为什么需要我们自己做
 * ────────────────────
 * 经典 CAN 的 ISO-TP 单帧（SF）数据位上限 = **7 字节**（8 字节数据域减去 1 字节 PCI）。
 * 我们的写请求几乎全部越过这条线：
 *   · 执行器 `2F`：`2F <DID2> <controlOption> <state>`，实测 **71 个 DID**（`data/gag-actuators.json`，
 *     由 `COMMAND.GAG` 里 154 条 `2F` 请求按线上 DID 去重）的帧长分布是
 *     **7B×1（`0xC000` state `0A 03 01`）/ 8B×68 / 9B×1（`0x0401`）/ 11B×1（`0x0402`）**
 *     ⇒ **70/71 必须分段**，只有 `0xC000` 落在单帧内。
 *     ⚠️ 别把 `2F` 当成固定 8 字节：原厂是按 `state` 的实际长度发的（3 / 4 / 5 / 7 字节四种都出现过），
 *     所以构帧必须走 `state` 的真长，**本模块也不做任何长度假定**（分段器只看 `hex.length`）。
 *   · 例程 `31`：原厂 155 条里 23 条 8–20B，最长 14B（`31 04 02 76 06 F6 01 01 0D D4 06 EA 01 01`）
 *   · 编码 `2E`：长度 = 3 + 回读块，6383 个字段里 4439 个（69.5%）落在第 4 字节之后，
 *     静态下界最大块 258B ⇒ 请求帧最长 261B
 * 8 字节及以上必须 FF + CF，PCI 得有人拼。
 *
 * 两条路，只有一条能用：
 *   ① 委托适配器固件（`ATCAF1`：ELM327 自动加/剥 PCI + 自行分段）
 *   ② 自己拼 PCI（`ATCAF0` + 本模块分段）
 * 我们**必须**走 ②：`src/coder.js` 有实测记录 —— vLinker MS 经 EA 通道**不执行 ATCAF1**
 * （RX 仍带 PCI，见 `parseResp` 的注释与 `parseRespAuto` 存在的原因）。
 * 而原厂自带 COMM 层（`libCOMM_ABSTRACT_LAYER.so`）自己做 ISO-TP，PCI 本来就是它自己拼的。
 * ⇒ 要让线上字节与原厂对齐，PCI 必须我们自己出。
 *
 * 本文件只放**纯函数**（无 I/O、无定时器、无状态），可在浏览器 bundle 里直接引用，
 * 也便于门禁对「分段/拼回」做逐字节算术自证。
 */

/** 经典 CAN 的 ISO-TP 单帧（SF）数据位上限（8 字节数据域 − 1 字节 PCI）。 */
export const MAX_SF_PAYLOAD = 7;

/**
 * 连续帧（CF）末帧的未用字节填充值。
 *
 * ISO 15765-2 规定经典 CAN 的未用字节填 **0x00**。这里集中成一个常量，
 * 是为了不让 `0x00` 散落在分段逻辑里 —— 若日后在原厂日志里见到非 0 填充
 * （例如某些 OEM 用 0xAA/0xCC），**以日志为准改这一个常量**，不要各处改。
 */
export const CF_PAD_BYTE = 0x00;

/** 去掉空格/分隔符并转大写（仓库既有帧写法风格：`'21A1'` / `'3E00'`）。 */
function normHex(payloadHex) {
  return String(payloadHex == null ? '' : payloadHex).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

/** hex → 字节数组；奇数长度直接抛（宁可炸，不许把半字节发出去）。 */
function toBytes(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error(`isotp-tx: 载荷 hex 长度为奇数（${hex.length} 个字符）—— 不是完整字节序列`);
  }
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16) & 0xff);
  return out;
}

/** 字节数组 → 大写无空格 hex。 */
function toHex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join('');
}

/**
 * 这个载荷需不需要分段？
 *
 * @param {string} payloadHex 业务载荷（可带空格）
 * @returns {boolean} `true` = 超过 7 字节，必须 FF + CF
 */
export function needsSegmentation(payloadHex) {
  return normHex(payloadHex).length > MAX_SF_PAYLOAD * 2;
}

/**
 * 把业务载荷切成 ISO-TP 帧序列（**含 PCI**，输出大写无空格）。
 *
 * SF（≤7 字节）：`0N <payload>`（N = 长度）
 * MF（≥8 字节）：
 *   FF = `1LLL` + 前 6 字节（12 位长度，`0x1000 | len`）
 *   CF = `2S` + 7 字节（S 从 1 起，到 0xF 回 0），末帧按 `CF_PAD_BYTE` 补满 7 字节数据位
 *
 * ⚠️ 自证：切完把「数据位」拼回去必须与输入**逐字节相等**，不等就 throw。
 *    分段器出错时宁可炸，也不许把错帧发到总线上（会被 ECU 当成合法请求执行）。
 *
 * @param {string} payloadHex
 * @returns {{mode:'sf'|'mf', frames:string[], length:number}}
 */
export function segmentPayload(payloadHex) {
  const hex = normHex(payloadHex);
  const length = hex.length / 2;
  if (!length) throw new Error('isotp-tx: 空载荷，无可发送内容');
  toBytes(hex);                                   // 奇数长度在这里抛

  if (length <= MAX_SF_PAYLOAD) {
    // SF：PCI = 0N（N ≤ 7，单 nibble）
    return { mode: 'sf', frames: [`0${length.toString(16).toUpperCase()}${hex}`], length };
  }
  if (length > 0x0fff) {
    throw new Error(`isotp-tx: 载荷 ${length} 字节超出 ISO-TP 12 位长度上限（4095）—— 需要流控分块传输，本工具不支持`);
  }

  const frames = [];
  // FF：0x1000 | len，写成 4 个 hex 字符（0x1008 → '1008'，0x1105 → '1105'）
  frames.push((0x1000 | length).toString(16).toUpperCase().padStart(4, '0') + hex.slice(0, 12));
  let seq = 1;
  for (let i = 12; i < hex.length; i += 14) {
    const chunk = hex.slice(i, i + 14);            // 最多 7 字节
    const padBytes = MAX_SF_PAYLOAD - chunk.length / 2;
    const pad = padBytes > 0 ? toHex(new Array(padBytes).fill(CF_PAD_BYTE)) : '';
    frames.push(`2${seq.toString(16).toUpperCase()}${chunk}${pad}`);
    seq = (seq + 1) & 0x0f;                        // 0xF 之后回 0
  }

  // ── 自证：数据位拼回 == 输入（按声明长度截断，去掉末帧填充） ──
  const rebuilt = [frames[0].slice(4), ...frames.slice(1).map((f) => f.slice(2))]
    .join('').slice(0, length * 2);
  if (rebuilt !== hex) {
    throw new Error(
      `isotp-tx: 分段自证失败（拼回 ${rebuilt.slice(0, 48)}… ≠ 输入 ${hex.slice(0, 48)}…）`
      + ' —— 宁可炸，不许把错帧发出去');
  }
  return { mode: 'mf', frames, length };
}

/**
 * 解析一个流控帧（FC）。
 *
 * 只认首字节高 nibble = 3 的帧；容忍行首带 CAN ID（`7E8 30 00 00`）。
 *
 * STmin 换算：
 *   0x00–0x7F → 毫秒（整数）
 *   0xF1–0xF9 → 100–900 微秒 → 毫秒（浮点，调用方上取整）
 *   其它（0x80–0xF0 / 0xFA–0xFF）→ 0（保留值，语义未定义；按「不限速」处理并留 0，不猜）
 *
 * @param {string} hexFrame 单帧原文（可为带 CAN ID 的整行）
 * @returns {null | {status:0|1|2, blockSize:number, stMinMs:number}}
 *          `null` = 这行不是流控帧（或状态码是 3–F 的保留值 —— 那不等于 CTS，
 *          必须让调用方按「没收到有效 FC」收口，绝不静默当成可以继续发）
 */
export function parseFlowControl(hexFrame) {
  const raw = String(hexFrame == null ? '' : hexFrame).trim();
  if (!raw) return null;
  let hex = normHex(raw);
  // 带分隔符的整行：首个 token 若是 3 位（11-bit）或 8 位（29-bit）hex，就当 CAN ID 剥掉
  if (/\s/.test(raw)) {
    const toks = raw.split(/\s+/).filter((t) => /^[0-9A-Fa-f]+$/.test(t));
    if (toks.length > 1 && (toks[0].length === 3 || toks[0].length === 8)) {
      hex = toks.slice(1).join('').toUpperCase();
    }
  }
  if (hex.length < 6) return null;               // FC 至少 3 字节：PCI + BS + STmin
  const b0 = parseInt(hex.slice(0, 2), 16);
  if ((b0 & 0xf0) !== 0x30) return null;
  const status = b0 & 0x0f;
  if (status > 2) return null;                   // 3–F 保留：不当作 CTS
  const blockSize = parseInt(hex.slice(2, 4), 16);
  const st = parseInt(hex.slice(4, 6), 16);
  let stMinMs = 0;
  if (st <= 0x7f) stMinMs = st;
  else if (st >= 0xf1 && st <= 0xf9) stMinMs = (st - 0xf0) / 10;
  return { status, blockSize, stMinMs };
}
