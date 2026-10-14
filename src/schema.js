/**
 * schema.js — 编码参数数据模型（对照表的结构化表示）。
 *
 * 记录格式来自 参考实现 对 诊断仪数据包 的离线解析（已验收）：
 *
 *   设码记录：ID 链 + 8 字节后缀
 *            链名来自 名称库，后缀最后四字节 = 值换算 ID（值编码公式）
 *
 *   设码定义：chain + byteOffset + bitOffset + TEXTTABLE 枚举
 *
 * 验证等级（决定 app 能不能写）：
 *   source-defined   —— 只有静态定义，无实车证据 → **只读显示，禁止写**
 *   read-confirmed   —— 实车读回验证过 → 允许读，写需二次确认
 *   write-confirmed  —— 实车写入+回读验证过 → 允许写
 */

export const LEVELS = ['source-defined', 'read-confirmed', 'write-confirmed'];

export const LEVEL_LABEL = {
  'source-defined': '仅源定义（未实车验证）',
  'read-confirmed': '读回已验证',
  'write-confirmed': '写入已验证',
};

/**
 * 参数条目 schema
 * {
 *   id:        string    唯一标识，建议 9x1:{module}:{variant}:{name}
 *   module:    string    模块名，如 DME_BDE_Continental
 *   profile:   string    变体 profile，如 9x1:DME_BDE_Continental:SDI9_1_981_3_4L_EU5
 *   variant:   string    变体名，如 SDI9_1_981_3_4L_EU5
 *   name:      string    功能名（名称库 里的名字）
 *   nameId:    string    名称库 的 ID，如 F001E2D8
 *   chain:     string    ID 链，如 0xF001E2D8$0xF001A305$0xA0000968
 *   byte:      number    字节偏移（0 起）
 *   bit:       number    位偏移（LSB 起，0-7）
 *   bitsize:   number    位宽，默认 1
 *   enum:      object    TEXTTABLE 枚举 { 值: 含义 } 或 null
 *   formula:   string    值换算 公式 ID，如 F000449D
 *   level:     string    验证等级
 *   risk:      string    low | medium | high
 *   source:    string    依据来源
 * }
 */

/** 校验一条参数是否合法 */
export function validateParam(p) {
  const errs = [];
  if (!p.id) errs.push('缺 id');
  if (!p.module) errs.push('缺 module');
  if (typeof p.byte !== 'number' || p.byte < 0) errs.push('byte 必须是 >=0 的数字');
  if (typeof p.bit !== 'number' || p.bit < 0 || p.bit > 7) errs.push('bit 必须是 0-7');
  // ★ bitsize 可 >8：曲线值、多字节数据在 EXPRESS 里 BitLength=16/24/32 …
  //   extractField/injectField 已支持跨字节，这里只挡不合理的值。
  if (typeof p.bitsize !== 'number' || p.bitsize < 1 || p.bitsize > 256) {
    errs.push(`bitsize 必须 1-256（实际 ${p.bitsize}）`);
  }
  if (typeof p.bit === 'number' && typeof p.bitsize === 'number'
      && p.bitsize >= 1 && p.bit + p.bitsize > 256) {
    errs.push(`bit(${p.bit}) + bitsize(${p.bitsize}) 过大`);
  }
  if (!LEVELS.includes(p.level)) errs.push(`level 必须是 ${LEVELS.join('/')}`);
  // ★ 写入必需：LID + 配对的读写 SID（见 coder.js）
  if (p.lid == null && p.did == null) {
    errs.push('缺 lid（写入必需；来源 请求模板 / 参数表）');
  }
  if (p.readSid != null && p.writeSid != null) {
    const PAIRS = { 0x21: 0x3B, 0x22: 0x2E, 0x1A: 0x3B };
    if (PAIRS[p.readSid] !== p.writeSid) {
      errs.push(`读写 SID 不配对：${p.readSid}↔${p.writeSid}（合法 21↔3B / 22↔2E / 1A↔3B）`);
    }
  }
  return errs;
}

/**
 * 从原始值里取该参数的字段值。
 * 位域按 LSB 起、可跨字节（bit + bitsize > 8 时进位到下字节）。
 * 返回 null 表示越界。
 */
export function extractField(rawBytes, p) {
  const bit = p.bit | 0;
  const size = p.bitsize | 0;
  if (size < 1) return null;
  const need = p.byte + Math.floor((bit + size - 1) / 8);
  if (p.byte < 0 || need >= rawBytes.length) return null;

  let v = 0;
  for (let i = 0; i < size; i++) {
    const abs = bit + i;                 // 从字段起点算的绝对位
    const bi = p.byte + (abs >> 3);      // 所在字节
    const bb = abs & 7;                  // 字节内位
    if ((rawBytes[bi] >> bb) & 1) v |= (1 << i);
  }
  return v;
}

/**
 * 把字段值写回原始值（返回新数组，不改原）。
 * 与 extractField 位序一致（LSB 起，可跨字节）。越界返回 null。
 */
export function injectField(rawBytes, p, value) {
  const bit = p.bit | 0;
  const size = p.bitsize | 0;
  if (size < 1) return null;
  const need = p.byte + Math.floor((bit + size - 1) / 8);
  if (p.byte < 0 || need >= rawBytes.length) return null;

  const out = rawBytes.slice();
  const mask = size >= 32 ? 0xffffffff : (1 << size) - 1;
  const v = (value >>> 0) & mask;
  for (let i = 0; i < size; i++) {
    const abs = bit + i;
    const bi = p.byte + (abs >> 3);
    const bb = abs & 7;
    const m = 1 << bb;
    if ((v >> i) & 1) out[bi] |= m;
    else out[bi] &= ~m & 0xff;
  }
  return out;
}

/** 枚举值 → 显示文本 */
export function decodeValue(p, raw) {
  if (p.enum) {
    // enum key 可能是 "0x00" 或 "0"，raw 是数字
    const rawStr = String(raw);
    const rawHex = '0x' + Number(raw).toString(16).toUpperCase().padStart(2, '0');
    const rawHexLower = '0x' + Number(raw).toString(16).padStart(2, '0');
    return p.enum[rawStr] ?? p.enum[rawHex] ?? p.enum[rawHexLower] ?? String(raw);
  }
  // switch 类型
  if (p.kind === 'switch') {
    return raw === 0 || raw === '0' ? '关' : '开';
  }
  return String(raw);
}

/** 显示文本 → 枚举值 */
export function encodeValue(p, text) {
  if (p.enum) {
    for (const [k, v] of Object.entries(p.enum)) {
      if (v === text) return Number(k);
    }
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** 能否写入（等级 + 风险） */
/**
 * 能否写入。
 *
 * ⚠️ 策略变更（对齐 431）：对照表数据已离线全量核验
 *   （byte/bit 锚点对照、LID/SID 99.9% 配对、口令算法逐位校验、请求格式实测），
 *   `level` 改为**验证状态标注**，不再作为写入门禁。
 *   真正拦住错误写入的是 coder.js 里的结构性闸门：
 *     缺 LID / SID 不配对 / 只读项 / 变更越界 / 回读不一致。
 *
 * 想恢复严格门禁：把 WRITE_ENABLED 改 false，会回到「必须 write-confirmed 才能写」。
 */
export const WRITE_ENABLED = true;

export function canWrite(p) {
  if (p.sidPairOk === false) return false;        // 只读项永远不给写
  if (p.lid == null && p.did == null) return false; // 无 LID 不能写
  if (!WRITE_ENABLED) return p.level === 'write-confirmed';
  return true;
}

export function riskLabel(r) {
  return { low: '低', medium: '中', high: '高' }[r] || r || '未知';
}
