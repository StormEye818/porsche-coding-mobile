/**
 * coder.js — 编码执行引擎。
 *
 * 写序列（原厂 RE-FLOWSPEC §4.0/§4.1：会话 → 备份 →（安全访问）→ 单项写 → 回读）：
 *   1. 建会话        10 89（保时捷专用主会话）；UDS 流另含 10 03
 *   2. 备份原值      readBlock(lid, readSid) → 持久化（读不到=不写）
 *   3. 安全访问      27 09 拿 seed → SeedKeyProvider 算 key → 27 0A
 *                    （抓包实测：27 09 01 00，level=0x09；KWP 为 17 00 / 17 40）
 *   4. 写入          <writeSid> <lid> <payload>（SID/位宽均由记录自带字段决定）
 *   5. 回读          <readSid>  <lid>  → 逐字节比对；不一致 = **记录失败**
 *   6. 恢复（可选）  仅当 SAFETY.autoRestore=true 才写回备份（安全增强；原厂不自动回滚）
 *
 * ⚠️ 读写 SID **由编码记录自带**（原厂写包装只打包 3B/2E、读包装只打包 21/22/1A）：
 *      记录 readSid ∈ {0x21,0x22,0x1A}；writeSid ∈ {0x3B,0x2E}；LID 位宽随 SID。
 *    同 ECU 混族是常态（981 DME 同模块 21/3B + 22/2E + 1A/2E 并存，RE-FLOWSPEC §3.1）——
 *    **不存在**「3B 必须配 21」的配对闸；旧注释的配对表只作数据侧参考，不参与发帧。
 *
 * ⚠️ LID 来自参数条目（请求模板 / 参数表），绝不硬编码。
 *    猜 DID 会写坏别的块。
 *
 * ⚠️ seed/key 算法缺失时：写入路径 `securityAccessEx` **拒绝写入**（不猜、不试、不穷举）；
 *    只读不受影响。`securityAccess` 的 needsKey:false「不发 key 继续写」仅用于恢复/兼容路径，
 *    新写入请走 applyChange（内部用 securityAccessEx）。
 *
 * ⚠️ 每次 `applyChange` 只改一项；批量路径逐项串行调用 applyChange（单项失败不中断后续，
 *    车上可能留下部分变更 —— 属批量语义，UI 会汇总失败项）。
 *
 * ⚠️ 超时 ≠ 未执行。结果不明时先重连核验，**禁止自动重试写入**（代码不自动重试；
 *    当前无自动重连，需人工确认后重进模块）。
 */

import { extractField, injectField, decodeValue, encodeValue, canWrite, fieldInRange, READ_SIDS, WRITE_SIDS, SAFETY } from './schema.js';
import { oemSessionFor } from './oem-session-table.js';
import {
  oemEnterSequences, oemIsSessionless, selectOemSequence, OEM_SENDABLE_SID,
} from './oem-enter-frames.js';

// ★ 2026-11-06 绑定期连接码计算 —— 代码级复刻 参考诊断仪 绑定期换算（其
//   CAN/连接码互逆翻译函数 64B 本体逐指令读毕：CAN = (lo|(idx<<8)) ^ 表2[idx]，
//   idx=连接码高字节在表1 的位置；8 族互逆双射，锚点 7/7 双向唯一咬合
//   （GW 0x710↔0x003E、PASM 0x7D0↔0x00FE、DME 0x7E0↔0x00CE、IC 0x7C0↔0x00EE 等）。
//   表2=8 字节混淆串（其 rodata 常量），表1=族序置换表。绑定参数由此计算而得、
//   非查表注入——本函数与 参考诊断仪 逐字同源，供绑定一致性校验/日志。
const _TC_T1 = [0x05, 0x07, 0x03, 0x02, 0x04, 0x06, 0x01, 0x00];
const _TC_T2 = [0x46, 0x75, 0x63, 0x6b, 0x55, 0x53, 0x41, 0x2e];
function calcLinkCode(can) {
  for (let idx = 0; idx < 8; idx++) {
    const x = ((can & 0xffff) ^ _TC_T2[idx]) >>> 0;
    if ((x & 0xff00) === (idx << 8)) return ((_TC_T1[idx] << 8) | (x & 0xff));
  }
  return null;
}

/**
 * 字段占用的字节闭区间 [lo, hi]。
 * 位域可能跨字节（bit + bitsize > 8），变更闸门要按区间判，不是"恰好 1 字节"。
 */
function fieldByteSpan(p) {
  const bit = p.bit | 0;
  const size = Math.max(1, p.bitsize | 0);
  const lo = p.byte;
  const hi = p.byte + Math.floor((bit + size - 1) / 8);
  return [lo, hi];
}

/**
 * 会话流家族 —— 通用规则（任务清单⑤ / RE-FLOWSPEC §6，零特判）：
 *   记录 SID 字段（prefix[0]/[1]、尾[7]/[11]）是分派键：21/1A→KWP 流，22→UDS 流。
 */
export function familyOfReadSid(readSid) {
  return readSid === 0x22 ? 'uds' : (readSid === 0x21 || readSid === 0x1A) ? 'kwp' : null;
}

/** 记录集 → 家族（多数 readSid；混族时 KWP 优先 —— 10 89 主会话两族通用零错，§1.3） */
export function familyOfItems(items) {
  let kwp = 0, uds = 0;
  for (const it of items || []) {
    const f = familyOfReadSid(it && it.readSid);
    if (f === 'kwp') kwp++;
    else if (f === 'uds') uds++;
  }
  if (!kwp && !uds) return null;
  return kwp >= uds ? 'kwp' : 'uds';
}

/** NRC（负响应码）中文 */
export const NRC = {
  0x10: '通用拒绝',
  0x11: '服务不支持',
  0x12: '子功能不支持',
  0x13: '请求长度/格式错误',
  0x21: '请求太频繁',
  0x22: '条件不满足（点火/车速/电压）',
  0x24: '请求顺序错误',
  0x31: '请求超出范围',
  0x33: '安全访问被拒',
  0x35: '密钥无效',
  0x36: '尝试次数超限',
  0x37: '需等待延时',
  0x72: '通用编程失败',
  0x78: '响应挂起',
  0x7E: '当前会话不支持该子功能',
  0x7F: '当前会话不支持该服务',
};

/**
 * SeedKeyProvider —— seed/key 算法插槽。
 *
 * 用法：拿到算法后
 *   coder.seedKeyProvider = {
 *     name: '算法变体',
 *     calc(seed: Uint8Array, level: number): Uint8Array
 *   };
 *
 * 在此之前 seedKeyProvider = null，写入会明确拒绝。
 */
export class MissingSeedKeyError extends Error {
  constructor(ecu) {
    super(`缺少 ${ecu || ''} 的 seed/key 算法变体，无法解锁写入。` +
          '算法 A/B 已在 seedkey.js 实现并经 离线逐位校验；' +
          '但各 ECU 用哪个变体需按 ECU 家族选择（见 seedkey.js makeProvider）。');
    this.name = 'MissingSeedKeyError';
    this.ecu = ecu;
  }
}

export class CodingError extends Error {
  constructor(msg, nrc) {
    super(nrc != null ? `${msg}（NRC 0x${nrc.toString(16)} ${NRC[nrc] || '未知'}）` : msg);
    this.name = 'CodingError';
    this.nrc = nrc;
    // ★ 2026-10-29 审计：CodingError 一直只有 .nrc，但 readBlock 的 SID 回退
    //   写的是 `e.code === 0x12` —— 条件永远不成立，回退从未生效。
    //   两个名字都留着，避免再踩。
    this.code = nrc;
  }
}

/**
 * 解析 UDS/KWP 应答：正响应 / 负响应(NRC)。
 *
 * ⚠️ ELM327 开 ATH1 后应答带 CAN 头，且大块数据走 ISO-TP 多帧。
 *    早先只剥单帧（`07 E?`）会把首帧/连续帧的 PCI 当数据，读出的块长度错、
 *    回读比对必失败。这里做完整重组：
 *      单帧   PCI 0x0N       → N 字节载荷
 *      首帧   PCI 0x1N NN    → 载荷长 = (N<<8)|NN，取本帧 6 字节
 *      连续帧 PCI 0x2N       → 取本帧 7 字节，按序号拼
 *    CAN 头按 11 位（3 hex）或 29 位（8 hex）剥离。
 */
export function parseResp(hexStr, reqEcho = '') {
  // ELM327 cmd() 已把 \r 去掉、末尾 trim；这里按空白切帧，
  // 兼容「一行多帧」和「多行多帧」两种输出。
  const cleaned = String(hexStr || '')
    .replace(/searching\.*/gi, ' ')
    .replace(/\b(AT|ST|OK|RV)\b/gi, ' ')
    .replace(/[>]/g, ' ');
  const lines = cleaned.split(/[\r\n]+/).filter((l) => l.trim());
  const frames = [];
  for (const ln of lines) {
    // ⚠️ 回显行剔除（2026-10-17 审计 P0）：ELM327 默认 ATE1，会把请求原样回显。
    //    回显的 `210A`/`1003` 会被当成 ISO-TP 帧（`10` 判成首帧、`21` 判成连续帧），
    //    污染多帧重组 → body[0] 不是正响应 SID → 误报「响应异常」。
    //    与 link-doctor 的 ATE0 互补（双保险）。
    const bare = ln.replace(/[^0-9A-Fa-f]/g, '');
    if (bare && bare === reqEcho) { continue; }
    // ⚠️ ELM327 的 `ATS0`（关空格）会输出**无空格**的 `7E8037F1012`（CAN ID + 字节连写）。
    //    参考实现的初始化模板 `ATE0 ATL0 ATH0 ATS0 ATAL ATCP18 ATCRA` 同样用 ATS0，
    //    所以这不是适配器/协议差异 —— 是解析器必须两种都认（2026-10-17 实车日志）。
    //    此前只认空格分隔的 2 字符 token，整条帧会被判成一个 token 丢掉 → 误报「无应答」。
    const rawToks = ln.trim().split(/\s+/).filter((x) => /^[0-9A-Fa-f]+$/.test(x));
    if (!rawToks.length) continue;
    const toks = [];
    for (const t of rawToks) {
      if (t.length === 2) { toks.push(t); continue; }
      // 独立的 CAN ID token（11bit=3 hex / 29bit=8 hex）→ 丢弃，不是载荷
      if (t.length === 3 || t.length === 8) { continue; }
      // 长 token = CAN ID + 字节连写（ATS0 无空格输出）
      let rest = t, idLen = 0;
      if ((t.length - 8) % 2 === 0 && (t.length - 8) >= 2) idLen = 8;      // 29 位 ID
      else if ((t.length - 3) % 2 === 0 && (t.length - 3) >= 2) idLen = 3;  // 11 位 ID
      if (idLen) rest = t.slice(idLen);
      for (let i = 0; i + 1 < rest.length; i += 2) toks.push(rest.substr(i, 2));
    }
    if (!toks.length) continue;
    const b = toks.map((x) => parseInt(x, 16));
    if (b.length) frames.push(b);
  }
  if (!frames.length) return { kind: 'empty', body: [] };

  // ISO-TP 重组
  let body = [];
  let expected = 0;
  let sawFirstFrame = false;
  let expectedSeq = null;
  for (const f of frames) {
    const pci = f[0];
    const type = pci & 0xf0;
    if (type === 0x00) {                       // 单帧
      // 新单帧必须重置多帧状态；否则前面的重组结果会被覆盖，
      // 或后续迟到连续帧被拼到这段单帧载荷后面。
      sawFirstFrame = false;
      expectedSeq = null;
      const n = pci & 0x0f;
      if (n === 0) {
        // ISO-TP SF_DL=0 非法（CAN FD 除外）；不猜，按空处理。
        body = [];
        expected = 0;
      } else if (n <= f.length - 1) {
        body = f.slice(1, 1 + n);
        expected = body.length;
      } else {
        // ⚠️ 声明 n 字节但实际更少 —— 不能把短包当成功（2026-10-18 审计）。
        //    旧代码走 `body.concat(f.slice(1))`，短包会被当成完整载荷交给上层。
        return {
          kind: 'truncated', body: f.slice(1), expected: n, received: f.length - 1,
          reason: `单帧声明 ${n} 字节，实收 ${f.length - 1} 字节`,
        };
      }
    } else if (type === 0x10) {                // 首帧
      expected = ((pci & 0x0f) << 8) | f[1];
      body = f.slice(2);
      sawFirstFrame = true;
      expectedSeq = 1;                        // 首帧后的第一个连续帧序号必须是 1
    } else if (type === 0x20) {                // 连续帧
      // 没有首帧的连续帧是垃圾/迟到帧，不能拼进 body。
      if (!sawFirstFrame) continue;
      // ⚠️ 0x30-0x3F 是**流控帧**，不是数据帧 —— 必须在类型分派**之前**拦掉。
      //    （早先把 `pci >= 0x30 && pci <= 0x32` 写在 0x20 分支里，永远不成立 = 死代码，
      //      流控帧会掉进「无 PCI」分支被当载荷拼进 body。）
      //    连续帧序号（PCI 低 4 位）也要校验，跳号说明丢帧（2026-10-16 审计 #17）。
      const seq = pci & 0x0f;
      if (sawFirstFrame && expectedSeq != null && seq !== expectedSeq) {
        return { kind: 'truncated', body, expected, received: body.length,
                 reason: `连续帧序号跳变（期望 ${expectedSeq}，实收 ${seq}）` };
      }
      expectedSeq = (seq + 1) & 0x0f;
      body = body.concat(f.slice(1));
    } else if (type === 0x30) {
      continue;                                 // 流控帧（FC），跳过
    } else {
      // 无 PCI（ATH0 或纯载荷）：整帧即载荷
      body = body.concat(f);
    }
  }
  if (expected && body.length > expected) body = body.slice(0, expected);

  // ⚠️ 多帧截断必须报错，不能当成功返回。
  // 此前不校验 `body.length === expected`，大块读到半包照样 kind:'ok'，
  // 上层用短块算 after 再写回 ECU —— 会把截断块写进车里，且回读比对同样截断故"成功"。
  if (sawFirstFrame && expected && body.length < expected) {
    return { kind: 'truncated', body, expected, received: body.length };
  }

  if (!body.length) return { kind: 'empty', body };
  if (body[0] === 0x7f) {
    return { kind: 'nrc', body, service: body[1], code: body[2] };
  }
  return { kind: 'ok', body };
}

/**
 * CAF1 应答解析 —— 适配器已自动加/剥 PCI 并自行重组多帧，输出是**纯数据**。
 *
 * ⚠️ 不能复用 parseResp 的 ISO-TP 分派（2026-10-29 审计 P0-1）：
 *    ATCAF1 后数据行首字节可能正好是 0x10/0x20/0x30，会被误判成首帧/
 *    连续帧/流控 —— 连续帧因「无首帧」被整行丢弃，首帧则算错长度。
 *    27 字节实测只解析出 5 字节。这里按原样拼接，只保留 NRC 判定。
 */
export function parseRespCaf1(hexStr, reqEcho = '') {
  const raw = String(hexStr || '');
  // 适配器明确报错 = 数据不完整。CAF1 下没有 PCI 长度可核对，
  // 只能靠这些状态字兜底，绝不能把半截块当成功交给上层（会被写回 ECU）。
  if (/STOPPED|BUFFER FULL|UNABLE TO CONNECT|\bERROR\b/i.test(raw)) {
    return {
      kind: 'truncated', body: [], expected: 0, received: 0,
      reason: raw.trim().slice(0, 60),
    };
  }
  const cleaned = raw
    .replace(/searching\.*/gi, ' ')
    .replace(/\b(AT|ST|OK|RV)\b/gi, ' ')
    .replace(/[>]/g, ' ');
  const lines = cleaned.split(/[\r\n]+/).filter((l) => l.trim());
  const body = [];
  for (const ln of lines) {
    const bare = ln.replace(/[^0-9A-Fa-f]/g, '');
    if (bare && bare === reqEcho) continue;          // 回显行
    const rawToks = ln.trim().split(/\s+/).filter((x) => /^[0-9A-Fa-f]+$/.test(x));
    if (!rawToks.length) continue;
    for (const t of rawToks) {
      if (t.length === 2) { body.push(parseInt(t, 16)); continue; }
      // 独立 CAN ID（11bit=3hex / 29bit=8hex）：不是载荷
      if (t.length === 3 || t.length === 8) continue;
      // 无空格连写（ATS0）：剥掉前缀 ID 再按字节切
      let rest = t, idLen = 0;
      if ((t.length - 8) % 2 === 0 && (t.length - 8) >= 2) idLen = 8;
      else if ((t.length - 3) % 2 === 0 && (t.length - 3) >= 2) idLen = 3;
      if (idLen) rest = t.slice(idLen);
      for (let i = 0; i + 1 < rest.length; i += 2) body.push(parseInt(rest.substr(i, 2), 16));
    }
  }
  if (!body.length) return { kind: 'empty', body };
  if (body[0] === 0x7f) {
    return { kind: 'nrc', body, service: body[1], code: body[2] };
  }
  return { kind: 'ok', body };
}

/**
 * 自适应解析 —— 兼容两种适配器输出（2026-11-04 实车定根因）：
 *
 *   ① 裸 ISO-TP（CAF0）：vLinker MS 经 EA 通道**不执行 ATCAF1**，输出带
 *      PCI 的原始帧（`7E8 10 13 5A 90 …` / `7E8 21 …`）→ 走 parseResp 完整重组；
 *   ② 纯数据（CAF1）：合规适配器已剥 PCI 自行重组 → 走 parseRespCaf1。
 *
 * 之前 uds() 固定用 parseRespCaf1 解析裸帧输出：PCI 当数据留在 body 里，
 * 识别串脏（"ZWP0A!B2983EK\"190083"）、NRC 识别不出（body[0]=03≠7F）、
 * VIN/变体识别/读码回退/SID 回退全部级联失败。真机 7 连坑的总根。
 *
 * 判定：按请求 SID 期望的正响应（req+0x40）或 NRC(0x7F) 落在 body[0] 为准，
 * 两种解释都像时优先 ISO-TP（长度可核对）。
 */
/**
 * 发送 AT 命令并要求回执（对没有 cmdOk 的旧桩/裸适配器退回裸 cmd）。
 * 只有 Elm327 才实现 cmdOk —— 测试桩、第三方 port 不该被迫实现它。
 */
export async function atCmdOk(elm, at, timeoutMs, opts = {}) {
  // ⚠️ 2026-11-10 审计：opts 之前没透传 —— 扫描时传 { noDelay:true } 被静默丢弃，
  //    每条 ATSH/ATCRA 仍然等 120ms，256 个地址白等 60s（扫完 70s 而不是 10–15s）。
  if (elm && typeof elm.cmdOk === 'function') return elm.cmdOk(at, timeoutMs, opts);
  return elm.cmd(at, timeoutMs, opts);
}

/**
 * 抽取应答里每一帧的 CAN ID（11 位 3 hex / 29 位 8 hex）。
 *
 * ⚠️ 2026-11-10 审计 R4：`parseResp` 把 CAN ID 当噪声丢掉，于是"这帧是谁回的"
 *    在整条链路上不可见。真车日志里探 0x7F1/0x7F9 却回帧头 `7E8` —— 要么 ATSH 没落地，
 *    要么应答方不是该候选。两种都必须当场判死，不能当"该候选回了个 NRC"。
 *
 * 只做识别、不改解析：调用方拿它和期望 rx 比对，不符即丢弃该帧。
 */
export function frameIdsOf(text) {
  const out = [];
  for (const ln of String(text || '').split(/[\r\n]+/)) {
    const line = ln.replace(/searching\.*/gi, '').trim();
    if (!line) continue;
    const toks = line.split(/\s+/).filter((t) => /^[0-9A-Fa-f]+$/.test(t));
    if (!toks.length) continue;
    const t0 = toks[0];
    // 空格分隔：首个 token 就是 ID
    if (toks.length > 1 && (t0.length === 3 || t0.length === 8)) {
      out.push(parseInt(t0, 16));
      continue;
    }
    // ATS0 连写：ID + 载荷（11 位 ⇒ 总长奇数；29 位 ⇒ 总长偶数且 ≥10）
    if (toks.length === 1 && t0.length >= 5) {
      const idLen = ((t0.length - 8) % 2 === 0 && t0.length >= 10) ? 8
        : (((t0.length - 3) % 2 === 0) ? 3 : 0);
      if (idLen) out.push(parseInt(t0.slice(0, idLen), 16));
    }
  }
  return out;
}

export function parseRespAuto(hexStr, reqEcho = '', reqSid = null) {
  const iso = parseResp(hexStr, reqEcho);
  const caf = parseRespCaf1(hexStr, reqEcho);
  const want = reqSid == null ? null : ((reqSid + 0x40) & 0xFF);
  const matches = (p) => {
    if (!p.body || !p.body.length) return false;
    return want == null ? p.body[0] === 0x7f : (p.body[0] === want || p.body[0] === 0x7f);
  };
  const isoOk = matches(iso), cafOk = matches(caf);
  if (isoOk && !cafOk) return iso;
  if (cafOk && !isoOk) return caf;
  if (isoOk && cafOk) {
    // 都像：① 截断互斥时取未截断；② CAF1 多行时 ISO 解释会丢「无首帧的连续行」，
    //    取载荷更完整的解释（CAF0 场景 caf 的 body[0] 是 PCI，匹配不上，不会走到这里）
    if (iso.kind === 'truncated' && caf.kind !== 'truncated') return caf;
    return caf.body.length > iso.body.length ? caf : iso;
  }
  // 都不像：保留更有诊断价值的结果（截断 > 有数据 > 空）
  if (iso.kind === 'truncated') return iso;
  if (caf.kind === 'truncated') return caf;
  return (iso.kind === 'empty' && caf.kind !== 'empty') ? caf : iso;
}

export class Coder {
  /**
   * @param {Elm327} elm   已锁定协议的 ELM327
   * @param {object} opts  { tx, rx, ecuName }
   */
  constructor(elm, { tx, rx, ecuName = 'ECU', verbose = true, family = null, identRequests = null } = {}) {
    this.elm = elm;
    this.tx = tx;
    this.rx = rx;
    this.ecuName = ecuName;
    this.verbose = verbose;        // ← 打印每条收发，方便 debug
    this.seedKeyProvider = null;   // ← 算法插槽
    this.protocol = 6;             // CAN 11bit/500k（保时捷实证）。link-doctor 锁定后可覆盖
    this.backups = [];
    this.lastIdent = '';          // 1A 9F/1A 94/1A 92 的 ASCII 识别串（自动选变体用）
    this.identByCmd = {};         // ★ 2026-11-09 逐识别命令应答文本（识别串注册表精确键查找用）
    // ★ 附加识别请求 = DSN.BIN 身份记录 SID/ID 集（data/ident-registry.json moduleIdent 的
    //   request 字段；KWP 族=1A 9F 已在基础链，UDS 族=22 F1 A2）。可经 opts.identRequests 覆盖。
    this.identRequests = identRequests || ['22F1A2'];
    this.lastPartNo = '';         // 1A 84 ECU 零件号（参考诊断仪 同款变体落定键，2026-11-05）
    this.lastPartTokens = [];     // 件号 ASCII token 集（1A 87/91/92/94 + 1A84，按 0x20 分词）
    this.lastHwPart = '';         // 1A 92/1A 91 硬件件号（多市场共用件收窄用）
    this.lastSwNo = '';           // 1A 94 软件号（SWINFO 消歧键，2026-11-05）
    // ★ 会话流家族（RE-FLOWSPEC §6/§7 + 任务清单⑤）：KWP 流=10 89 直接建会话（不发 10 03），
    //   UDS 流=10 03。分派键=编码记录 SID 对/ECU 模板（非识别串）。null=家族未证（按规格未覆盖）。
    this.family = family;         // 'kwp' | 'uds' | null
    const mock = !!(elm && (elm.mock || elm.port?.mock));
    // 真车默认只读：没有「车型+模块+地址+会话/序言」完整证据时不开放写入。
    // mock 用于协议测试，可由测试显式覆盖为未验证来测试门禁。
    this.diagProfile = mock
      ? { verified: true, reason: 'mock profile' }
      : { verified: false, reason: '当前 ECU 写流未验证' };
    this._addressReady = false;   // 当前 ATSP/ATSH/ATCRA 是否已下发到适配器
    this._writeBusy = false;   // 写事务排他（审计 #20）
    // ★ 2026-11-12 逐 ECU 原厂会话上下文（data/sysdata-comm.json → src/oem-session-table.js）：
    //   原厂并非一律 10 89（981 实测 32 个模块是 10 03）。未设置上下文时 oemSession=null，
    //   enterSession 回退主会话 0x89 —— 不改变既有帧序门禁，也不猜。
    this.oemSysId = null;
    this.oemSession = null;
    this.oemSessionStrict = null;   // GAG 帧 flag：true=原厂要求正响应，false=尽力而为
    this.oemEnterSeq = '';          // 原厂进模块命令序列（证据展示/审计用）
    // ★ 2026-11-12 全量收口：逐 ECU 逐地址的原厂**帧序列组**（src/oem-enter-frames.js）。
    //   68 个老代 sysId 的序列只有 81 + 1A 识别、没有 10 xx —— 原厂不建 UDS 会话。
    this.oemSequences = [];
    this.oemSessionless = false;
    this.oemSequenceUsed = '';     // 本次进模块实际执行的原厂序列（审计用）
    this.log = [];
  }

  _say(m) {
    this.log.push(m);
    if (this.onProgress) this.onProgress(m);
  }

  /**
   * 绑定当前 ECU 的原厂会话上下文（sysId → SYS_DATA comm 子表证据）。
   *
   * ★ 2026-11-12：上一阶段把「逐 ECU 会话」逆出来了（874 条 comm 记录 / 805 sysId /
   *   981 的 48 模块全可查），但运行时仍一律发 10 89，只在日志里提示「未对齐」。
   *   这里把它真正接进协议层：enterSession / enterSessionFor('coding'|'ident') /
   *   applyChange 未显式给 session 时都取证据值。
   *
   * requireResponse 来自 GAG 帧 flag：10 89 是 flag=1（要正响应），
   * 10 03 / 3E 00 是 flag=0（尽力而为）。会话号换掉之后仍按原厂容错分级，
   * 否则把尽力而为的 10 03 当成硬要求会在无应答 ECU 上卡死写流程。
   *
   * 查不到证据（sysId 不在表 / 无会话帧）→ 全部置 null，回退主会话 0x89。
   */
  setOemContext(sysId, tx = null) {
    const key = sysId == null ? null : String(sysId).toLowerCase();
    let hit = oemSessionFor(sysId);
    // 防错代护栏：comm 表的 type 必须等于 sysId 高字节（全表 805 条只有 2 条跨代别名，
    // 运行时实际用到的 468 个 sysId 零错配）。不一致就当无证据，绝不拿别代会话来发帧。
    if (hit && key && hit.gen) {
      const hi = Number.parseInt(key.slice(2, 4), 16);
      const gen = Number.parseInt(hit.gen, 16);
      if (Number.isFinite(hi) && Number.isFinite(gen) && hi !== gen) {
        this._say(`  (sysId ${key} 与 comm type ${hit.gen} 错代，会话证据不采用)`);
        hit = null;
      }
    }
    this.oemSysId = key;
    this.oemSession = hit ? hit.session : null;
    this.oemSessionStrict = hit ? hit.requireResponse : null;
    this.oemEnterSeq = hit ? hit.seq : '';
    // 逐 ECU 逐地址的帧序列证据（1005 条序列 / 803 sysId）。tx 用于挑与当前绑定
    // 地址一致的那条；同 ECU 多条功能序列时，按「地址匹配 > 会话号匹配」择一。
    this.oemSequences = key ? oemEnterSequences(key) : [];
    this.oemSessionless = key ? oemIsSessionless(key) : false;
    this.oemSequenceUsed = '';
    // 调用方（app 进模块日志）用 coder.oemSessionless 区分「无证据=回退」与「原厂不建会话」。
    return hit;
  }

  /** 当前 ECU 的会话号：证据优先，调用方显式值优先于它，最后才回退主会话 0x89。 */
  resolveSession(explicit = undefined) {
    return explicit ?? this.oemSession ?? 0x89;
  }

  /** 设定物理寻址 */
  async address() {
    // 同一地址/协议已经下发过就不要再发 4 条 AT 命令 —— 逐块读 55 块时
    // 这是主要延迟来源（每次读块都重复 ATSP/ATSH/ATCRA/ATFCSH）。
    if (this._addressReady) return;
    // ⚠️ 每次寻址都显式固定协议 —— 不能依赖 link-doctor L4 留下的状态。
    //    2026-10-17 真车实测：L4 试完 ATSP6/7/8/9 失败后停在 ATSP9（250k），
    //    保时捷是 500k，之后所有请求全是 CAN ERROR。参考诊断仪 能连、我们连不上就是这个。
    //    协议码：6=11bit/500k  7=29bit/500k  8=11bit/250k  9=29bit/250k
    await atCmdOk(this.elm, `ATSP${this.protocol ?? 6}`, 2500);
    // ★ 绑定期换算同款（2026-11-06）：参考诊断仪 绑定参数=连接码（CAN 的纯函数），
    //   这里同步计算出同源连接码留档校验；适配器侧 ATSH/ATCRA 直接吃 CAN（等价其 SetAddress/FilterId）。
    this.linkCodeTx = calcLinkCode(this.tx);
    this.linkCodeRx = calcLinkCode(this.rx);
    this._say(`  绑定换算 tx=0x${this.tx.toString(16).toUpperCase()}→码${this.linkCodeTx != null ? '0x' + this.linkCodeTx.toString(16).toUpperCase() : '?'}`
      + ` rx=0x${this.rx.toString(16).toUpperCase()}→码${this.linkCodeRx != null ? '0x' + this.linkCodeRx.toString(16).toUpperCase() : '?'}`);
    // ⚠️ 2026-11-10 审计 R4：绑定三件套必须**回执确认**。此前 cmd() 的返回值被丢掉，
    //    适配器回 `?`/空行也照发，请求其实还打在上一个地址上 —— 真车日志里探 0x7F1
    //    回帧头是 7E8 就是这个症状。宁可当场报错，不要带着错地址往下跑。
    try {
      await atCmdOk(this.elm, `ATSH${this.tx.toString(16).toUpperCase()}`, 2000);
      await atCmdOk(this.elm, `ATCRA${this.rx.toString(16).toUpperCase()}`, 2000);
    } catch (e) {
      throw new CodingError(
        `绑定 0x${this.tx.toString(16).toUpperCase()}/0x${this.rx.toString(16).toUpperCase()} 失败：${e.message}` +
        '（适配器没有确认 ATSH/ATCRA —— 检查 EA 通道/固件是否支持该命令）');
    }
    // 流控头随模块地址走：多帧读写时适配器内建 FC 要用**当前模块的请求 ID**。
    // （只在 init 里设一次不够 —— 换模块后 FC 头是上一个模块的）
    await this.elm.cmd(`ATFCSH${this.tx.toString(16).toUpperCase()}`, 1500).catch(() => {});
    this._addressReady = true;
  }

  /**
   * 进诊断会话 —— 按 参考诊断仪对保时捷的标准序列，不照搬其他车系。
   *
   * 参考诊断仪实测编排（抓包 3,139 条请求）：
   *   10 03   →  进 UDS 扩展会话
   *   3E      →  TesterPresent
   *   1A 9F   →  读 ECU 识别（确认在正确模块上）
   *   10 89   →  进保时捷专用会话
   * 之后才做读写。
   *
   * ⚠️ `10 89` 不是通用扩展会话 —— 部分服务只在 89 下开放。
   * ⚠️ 不同 ECU 会用别的会话号（实测还有 10 85/86/81/4F），
   *    走不通时按 `session` 参数换，别硬试。
   */
  /**
   * 进诊断会话 —— 按 参考诊断仪 实测编排，但**分级容错**。
   *
   * COMMAND.GAG 3139 条实测的会话 ID 分布：
   *   10 89 (×6) · 10 03 (×3) · 10 86 (×3) · 10 85 · 10 81 · 10 C0 · 10 00 · 10 4F
   *   → `10 03` 只在部分 ECU 上有效，`10 89` 才是保时捷主力。
   *
   * ⚠️ 实车日志（2026-10-17）：DME 对 `10 03` 回 `7F 10 12`（subFunctionNotSupported），
   *    而旧实现把这当成致命错误直接抛出 —— 后面的 `1A 9F` / `10 89` 根本没机会发。
   *    现改为：`10 03` **尽力而为**（失败只记日志），`10 <session>` 才是硬要求。
   */
  /**
   * ★ 2026-11-12 全量收口：按 SYS_DATA comm 子表的**逐帧原厂序列**进模块。
   *
   * 证据链：data/sysdata-comm.json → COMMAND.GAG 解帧 → src/oem-enter-frames.js
   * （803 sysId / 1005 条序列 / 3350 帧）。每层规则都有包内出处，不靠猜：
   *   - 序列按 cat/地址分组；同一 ECU 有多条功能序列时，选与当前绑定地址、
   *     目标会话号最吻合的一条（selectOemSequence）。
   *   - flag=1 → 原厂要求正响应；flag=0 → 尽力而为（会话/保活帧容忍无应答）。
   *   - flag=3 复合脚本帧、81 快初始化、1800FF00 / 3070 / A00F00FF00FF 等
   *     链路层或服务声明帧**不进模块发送**，只留痕（220 帧）。
   *   - 68 个老代 sysId 的序列只有 81 + 1A 识别、没有 10 xx：原厂不建 UDS 会话，
   *     不再错误回退 `10 89`（旧行为会给老 KWP ECU 发 UDS 帧）。
   *
   * 仅当调用方传 `opts.oemSequence === true` 且未显式指定会话时启用；
   * 服务专属会话、无证据上下文仍走既有族流，避免改变已验证的写入路径。
   */
  async _enterByOemFrames(sess, opts = {}) {
    await this.address();
    const seq = selectOemSequence(this.oemSysId, this.tx, sess) || this.oemSequences[0];
    if (!seq) return this.enterSession(sess, { ...opts, oemSequence: false });
    const sendable = new Set(OEM_SENDABLE_SID);
    this.oemSequenceUsed = seq.frames
      .map((f) => `${f.flag}${f.script ? '!' : ''}:${f.hex}`).join(' ');
    this._say(`  ✅ 原厂进模块序列（${this.oemSysId} · cat ${seq.cat} · `
      + `${seq.frames.length} 帧${seq.tx != null ? ` · 0x${seq.tx.toString(16)}/0x${seq.rx.toString(16)}` : ''}）：`
      + this.oemSequenceUsed);
    if (this.oemSessionless) {
      this._say('  ⓘ 老代 KWP 序列无 10 xx 会话帧 —— 原厂不建 UDS 会话（不再回退 10 89）');
    }

    // 识别证据随进模块重采（与族流识别链同语义：5A/62 剥离、0x20 分词、按应答形态定 SID）。
    this.lastIdent = '';
    this.identByCmd = {};
    this.lastPartNo = '';
    this.lastPartTokens = [];
    this.lastHwPart = '';
    this.lastSwNo = '';
    const identParts = [];
    let sawUdsIdent = false;
    let sent = 0, skipped = 0;

    for (const f of seq.frames) {
      const sid = Number.parseInt(f.hex.slice(0, 2), 16);
      if (f.script || f.flag === 3 || !sendable.has(sid)) {
        skipped++;
        this._say(`  (跳过 ${f.flag}${f.script ? '!' : ''}:${f.hex} —— 链路层/服务声明/复合脚本，不进模块发送)`);
        continue;
      }
      const soft = f.flag === 0;
      const isSession = sid === 0x10;
      const sessByte = isSession ? Number.parseInt(f.hex.slice(2, 4), 16) : null;
      // 只有「本次目标会话」且 flag=1 的会话帧才是硬要求；写路径 strictSession 一律硬要求。
      const hard = isSession && !soft && (opts.strictSession === true || sessByte === sess);
      try {
        const r = await this.uds(f.hex, sid === 0x3e ? 2000 : 3000,
          { allowEmpty: soft || sid === 0x3e });
        sent++;
        if (isSession) {
          if (hard) this._expectSession(r, sessByte);
          else this._say(`  (会话 ${f.hex} flag=0 —— 原厂尽力而为，不硬等 50 xx)`);
        } else if (sid === 0x1a || sid === 0x22 || sid === 0x21) {
          let b = Array.from(r?.body || []);
          if (b[0] === 0x5a) b = b.slice(2);
          else if (b[0] === 0x62) { b = b.slice(3); sawUdsIdent = true; }
          const txtRaw = b.filter((c) => c >= 0x20 && c < 0x7f)
            .map((c) => String.fromCharCode(c)).join('');
          const txt = txtRaw.trim();
          this._say(`  识别 ${f.hex} → ${(r?.body || []).map((x) => x.toString(16).padStart(2, '0')).join(' ')}`
            + (txt ? `  「${txt}」` : ''));
          if (txt) {
            identParts.push(txt);
            if (!this.identByCmd[f.hex]) this.identByCmd[f.hex] = txt;
            for (const tok of String(txtRaw).split(/ +/).filter(Boolean)) {
              if (tok.length >= 6 && !this.lastPartTokens.includes(tok)) this.lastPartTokens.push(tok);
            }
            const partTok = String(txtRaw).split(/ +/).filter((x) => x.length >= 6)[0]
              || String(txtRaw).split(/ +/)[0] || '';
            if (f.hex.startsWith('1A84')) this.lastPartNo = partTok;
            else if (!this.lastPartNo && /^1A(87|94)/.test(f.hex)) this.lastPartNo = partTok;
            if (f.hex.startsWith('1A92')) this.lastHwPart = txtRaw;
            else if (f.hex.startsWith('1A91') && !this.lastHwPart) this.lastHwPart = txtRaw;
            else if (f.hex.startsWith('1A94')) this.lastSwNo = txtRaw;
          }
        }
      } catch (e) {
        if (hard) throw e;
        this._say(`  (${f.hex} 无正响应：${e.message} —— flag=${f.flag} 按原厂容错继续)`);
      }
    }
    this.lastIdent = identParts.join(' ').trim();
    if (sawUdsIdent) this.lastReadSid = 0x22;
    else if (identParts.length) this.lastReadSid = 0x1A;

    // 序列内识别帧全部无应答时补两条最小识别，保证变体选择仍有证据（不影响有应答时的帧序）。
    if (!opts.skipIdent && !this.lastIdent) {
      this._say('  (原厂序列未取到识别文本 —— 补采 1A9F / 22F1A2)');
      for (const cmd of ['1A9F', '22F1A2']) {
        try {
          const r = await this.uds(cmd, 3000, { allowEmpty: true });
          let b = Array.from(r?.body || []);
          if (b[0] === 0x5a) b = b.slice(2);
          else if (b[0] === 0x62) { b = b.slice(3); sawUdsIdent = true; }
          const txt = b.filter((c) => c >= 0x20 && c < 0x7f)
            .map((c) => String.fromCharCode(c)).join('').trim();
          if (txt) {
            identParts.push(txt);
            this.identByCmd[cmd] = txt;
            for (const tok of txt.split(/ +/).filter((x) => x.length >= 6)) {
              if (!this.lastPartTokens.includes(tok)) this.lastPartTokens.push(tok);
            }
          }
        } catch (e) { this._say(`  (补采 ${cmd}：${e.message})`); }
      }
      this.lastIdent = identParts.join(' ').trim();
      if (sawUdsIdent) this.lastReadSid = 0x22;
      else if (identParts.length) this.lastReadSid = 0x1A;
    }
    this._say(`  ✅ 原厂序列执行完毕：发送 ${sent} 帧 / 跳过 ${skipped} 帧`
      + `${this.lastIdent ? ` / 识别「${this.lastIdent}」` : ' / 无识别文本'}`);
    return true;
  }

  _expectSession(r, session) {
    const body = Array.from(r?.body || []);
    if (body.length < 2 || body[0] !== 0x50 || body[1] !== (session & 0xff)) {
      throw new CodingError(`会话响应异常：期望 50 ${session.toString(16).padStart(2, '0').toUpperCase()}，`
        + `实得 ${body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
    }
    return r;
  }

  async enterSession(session, opts = {}) {
    // ★ 2026-11-12 全量收口：上层按证据开启「原厂序列模式」时，逐帧按 comm 记录发帧，
    //   不再靠族流猜帧序。显式给 session（服务专属流程）或无证据序列时保持既有族流，
    //   因此所有既有帧序门禁不受影响。
    if (opts.oemSequence === true && session == null && this.oemSequences?.length) {
      return this._enterByOemFrames(this.resolveSession(), opts);
    }
    // ★ 2026-11-12 逐 ECU 原厂会话：未显式给 session 时取 setOemContext 绑定的证据值。
    //   无上下文（单测/自动搜索/未定案车型）→ 0x89，既有帧序门禁不受影响。
    const sess = this.resolveSession(session);
    const family = opts.family ?? this.family ?? null;
    // GAG 帧 flag=0 的会话（10 03 / 3E 00）原厂是尽力而为；写路径 strictSession 仍硬要求。
    // 只在「本次目标会话确实来自该 ECU 的 flag=0 证据」时才放宽，
    // 服务专属会话（10 40/10 85…）与调用方显式给的会话一律保持硬要求。
    const oemSoft = this.oemSession != null && sess === this.oemSession
      && this.oemSessionStrict === false;
    const requirePositive = opts.strictSession === true || !oemSoft;
    await this.address();
    const sessHex = `10${sess.toString(16).toUpperCase().padStart(2, '0')}`;
    // ★ 会话流（任务清单⑤ / RE-FLOWSPEC §1.3·§7，零特判）：
    //   KWP 流 = **10 89 直接建会话**（GAG rec#42，不发 10 03 —— KWP ECU 拒 10 03 即实车断点）；
    //   UDS 流 = 10 03（标准扩展会话，§1.3「UDS ECU 流另含」）后进目标会话；
    //   家族未证（null）= 按规格未覆盖（ODX SESSIONS 未提取）→ 走 KWP 流同形
    //   （10 89 = 保时捷编码主会话，全库×4 模板，两族通用零错）。
    if (family !== 'uds') {
      // KWP 流 / 未证家族：目标会话直接建；正响应 SID 与会话号必须同时匹配。
      // 仅当原厂帧 flag=0 时容忍无正响应（与 10 03 同级的尽力而为）。
      try {
        const sr = await this.uds(sessHex);
        this._expectSession(sr, sess);
        this._say(`  ✅ 会话 ${sessHex} 就绪（${family === 'kwp' ? 'KWP 流直接建会话' : '家族未证·按规格未覆盖，走主会话同形'}）`);
      } catch (e) {
        if (requirePositive) throw e;
        this._say(`  (会话 ${sessHex} 无正响应：${e.message} —— 原厂 flag=0 尽力而为，继续)`);
      }
    } else {
      // UDS 扩展会话：普通读取可容忍不支持；写路径 strictSession 必须拿正响应。
      // ★ 2026-11-12 逐 ECU 会话去重：目标会话本身就是 0x03 时（981 有 32 个模块），
      //   不再单独发「扩展会话」步 —— 否则同一帧 `10 03` 在首尾各发一次。
      //   由末尾的目标会话帧一次完成，也与原厂 comm 序列（10 03 在序列末）更接近。
      if (sess !== 0x03) {
        try {
          const sr = await this.uds('1003');
          this._expectSession(sr, 0x03);
        } catch (e) {
          if (opts.strictSession) throw e;
          this._say(`  (10 03 未支持：${e.message} —— 继续)`);
        }
      }
    }
    // ② TesterPresent 保活 —— 一律 `3E 00`（GAG rec#35；全包无 3E 80 模板）。
    //   会话建立后发送（实车断点：会话前 3E 00 被拒）。
    await this.uds('3E00', 2000, { allowEmpty: true }).catch(() => {});
    // ③ 识别 ECU（失败不致命，只记日志）
    // ★ 2026-10-18：把 1A 9F/94/92 的 ASCII 文本留下来，用于自动选变体。
    //   参考诊断仪 不弹变体选择，它是按 ECU 识别/ODX 变体名自动进模块的；我们之前
    //   只看十六进制、然后 prompt 让用户选，方向反了。
    this.lastIdent = '';
    this.identByCmd = {};
    this.lastPartNo = '';
    this.lastPartTokens = [];
    this.lastHwPart = '';
    this.lastSwNo = '';
    const identParts = [];
    // ★ 2026-11-09 识别请求集 = DSN.BIN 身份记录 SID/ID（识别串注册表 moduleIdent，
    //   DME 族=1A 9F（真车日志 5A 9F"P200"互证）、PSM/BCM 族=22 F1 A2）。
    //   UDS 族模块不答 1A xx —— 注册表请求紧跟 1A9F 后插入（连续 3 miss 早停前可达）。
    //   ⚠️ KWP 族绝不发 0x22（RE-FLOWSPEC §2.3：KWP 车请求集只有 1A xx/21 xx，
    //   实车 22 全拒断点）—— 注册表 22 xx 请求只进非 KWP 链。
    // ★ 2026-11-11 原厂对齐（CODE-AUDIT §5.2 偏离②）：`skipIdent` 用于**写路径**——
    //   原厂写序列不含识别链（会话 → 备份 → 安全访问 → 写 → 回读），且识别链会清空
    //   lastIdent/lastPartNo 等变体证据。进模块路径仍走完整识别链（默认 false）。
    if (!opts.skipIdent) {
    const identChain = ['1A9F',
      ...(family === 'kwp' ? [] : (this.identRequests || [])).filter((x) => x && x !== '1A9F'),
      '1A87', '1A84', '1A91', '1A92', '1A93', '1A94', '1A95', '1A97', '1A9A'];
    // 参考诊断仪 用版本信息识别变体；9F 可能是零件号，94 才是软件/变体，两条都读。
    // ★ 2026-10-28：全套 1A xx 识别（对齐 参考诊断仪 ODX 识别链）。
    //   此前只读 9F(DSN)+94(软件号)，识别串太短匹配不上变体名。
    //   ★ 2026-11-08 帧序对齐 RE-FLOWSPEC §2.1：1A 9F→87→84→91→92→93→94→95→97→9A（连续 3 miss 早停）。
    // 连续 3 条没有任何数据就提前收手：老 ECU 只支持 9F/94，
    // 挨个等 3s 超时会把「进模块」拖到 30 秒（2026-10-29 审计 P2-4）。
    let identMiss = 0;
    let sawUdsIdent = false;   // 62 F1 A2 → UDS 模块（lastReadSid 不能记成 1A）
    for (const cmd of identChain) {
      try {
        const id = await this.uds(cmd, 3000, { allowEmpty: true });
        let b = Array.from(id.body || []);
        if (b[0] === 0x5a) b = b.slice(2);           // 5A 9F / 5A 94 / 5A 92
        else if (b[0] === 0x62) { b = b.slice(3); sawUdsIdent = true; }   // 62 F1 A2（UDS 族识别，DSN.BIN 身份记录）
        const txtRaw = b.filter((c) => c >= 0x20 && c < 0x7f)
          .map((c) => String.fromCharCode(c)).join('');
        const txt = txtRaw.trim();   // 仅显示用；键留存用原样字节（strcmp 语义）
        this._say(`  识别 ${cmd} → ${id.body.map((x) => x.toString(16).padStart(2, '0')).join(' ')}`
          + (txt ? `  「${txt}」` : ''));
        if (txt) {
          identParts.push(txt); identMiss = 0;
          if (!this.identByCmd[cmd]) this.identByCmd[cmd] = txt;   // ★ 识别串注册表键查找用
          // ★ 2026-11-08 件号采集扩到 1A 87/91/92/94（任务清单④ / RE-MODELADDR §3.3-3.4）：
          //   本车实证件号 98161864015 出现在 1A 87/94（不只 1A84）；按 0x20 分词逐 token 入集，
          //   供 pickVariantByPart 全等查表（checkPartNumber 分词语义）。
          for (const tok of String(txtRaw).split(/ +/).filter(Boolean)) {
            if (tok.length >= 6 && !this.lastPartTokens.includes(tok)) this.lastPartTokens.push(tok);
          }
          // ★ 2026-11-05：件号单独留存（参考诊断仪 同款变体落定键）。
          //   1A 84=零件号（会话库 PARTNUMBER 一一对应）；1A 92 硬件号、1A 91 零件图号做收窄。
          // ★ 2026-11-11 原厂对齐（CODE-AUDIT §3.1 偏离③）：件号按 **0x20 分词**取单词 token
          //   （checkPartNumber @ACTF:0x4e00c 分词语义、byPart 字节精确全等查）。
          //   旧实现把 1A87/1A94 的**整串** txtRaw 赋给 lastPartNo，多 token 串在 byPart
          //   全等查里几乎必然不命中 → 变体落定退化。
          const partTok = String(txtRaw).split(/ +/).filter((x) => x.length >= 6)[0]
            || String(txtRaw).split(/ +/)[0] || '';
          if (cmd === '1A84') this.lastPartNo = partTok;
          else if (!this.lastPartNo && (cmd === '1A87' || cmd === '1A94')) this.lastPartNo = partTok;  // 兜底采（保留 1A84 优先）
          if (cmd === '1A92') this.lastHwPart = txtRaw;
          else if (cmd === '1A91' && !this.lastHwPart) this.lastHwPart = txtRaw;
          else if (cmd === '1A94') this.lastSwNo = txtRaw;
        } else { identMiss++; }
      } catch (e) {
        identMiss++;
        this._say(`  (识别 ${cmd}：${e.message})`);
      }
      if (identMiss >= 3) {
        this._say('  (连续 3 条识别无数据，提前结束识别)');
        break;
      }
    }
    this.lastIdent = identParts.join(' ').trim();
    // ★ 2026-10-29 审计 P1-3：这一轮读的全是 1A（KWP 识别服务），
    //   记下来供例程/特殊功能判断 KWP(21/1A) 还是 UDS(22)。
    //   此前只靠 readBlock 赋值，进模块后直接点例程时 lastReadSid 仍是 null，
    //   KWP 模块会被发成 27 09（应为 17 00）→ NRC。
    // ★ 2026-11-10 修：此前只要有识别文本就记 1A —— UDS 模块答的是 `62 F1 A2`，
    //   却被记成 KWP（1A），随后例程/特殊功能会发 17/21 族帧 → NRC。
    //   现在按实际应答形态记：62 → 0x22；5A → 0x1A。
    if (sawUdsIdent) this.lastReadSid = 0x22;
    else if (identParts.length) this.lastReadSid = 0x1A;
    }   // ← if (!opts.skipIdent) 识别链结束（写路径不重跑识别）
    // ④ 目标会话（UDS 流）—— **硬要求**，失败才报错。
    //   KWP 流/未证家族已在开头直接建会话，此处不再重复发。
    if (family === 'uds') {
      try {
        const sr = await this.uds(sessHex);
        this._expectSession(sr, sess);
        this._say(`  ✅ 会话 ${sessHex} 就绪`);
      } catch (e) {
        if (requirePositive) throw e;
        this._say(`  (会话 ${sessHex} 无正响应：${e.message} —— 原厂 flag=0 尽力而为，继续)`);
      }
    }
    return true;
  }

  /**
   * 自动搜索链（★ 2026-11-09 按参考诊断仪分支代码逐字转写，RE-TRACEABILITY-20261109.md §车名链）：
   *   ① 主/备双请求 `22 11 02`（0xff001102）→ `22 11 01`（0xff001101）——
   *      PorscheReadVinAndGetVehicleID（SYSP:0x29fb8）内三处 `ShowMessageBoxID(0xff001102,0xff001101,5)`；
   *      应答文本=车上识别串（trim 名源，RE-MODELID strcmp 语义）。
   *   ② VIN/车名路径 = SYSP:0x56a66 模板表的可复现子集：
   *      原厂模板不是八帧顺跑，0x55/0xAA/0x608/0x101 是互斥运行时分支；
   *      本地无法安全复现 FUN_0x22450 的分支选择，因此只在上一读取未得到证据时继续，
   *      保留 22 F1 90 / 1A 90 / 21 51 的实际读取，不把 1A 87/1A 9B/21 50/1A 9A 当默认遍历。
   *      这属于明确标注的适配层保守路径，不宣称覆盖原厂全部分支。
   *   ⚠️ `22 14 0A` 支链触发条件按规格未覆盖 —— 不发。
   */
  /**
   * fresh 自动搜索的适配层定族前言（不是原厂额外帧序）：
   * 只在当前已验证地址上尝试 1A90，失败后尝试 1003→22F190；
   * 只接受匹配 rx 的 5A90/5003+62F190，NRC/NO DATA/错 ID 均不定族。
   */
  async detectIdentityFamily() {
    const out = { family: null, vin: '', vinSrc: '', steps: [] };
    const ascii = (arr) => arr.filter((c) => c !== 0)
      .map((c) => String.fromCharCode(c)).join('');
    const rxOk = (raw) => {
      if (this.elm?.mock || this.elm?.port?.mock) return true;
      const ids = [...new Set(frameIdsOf(raw || ''))];
      return !ids.length || ids.every((id) => id === this.rx);
    };
    const vinOf = (body, start) => {
      const v = ascii(Array.from(body || []).slice(start, start + 17));
      return v.length >= 11 ? v : '';
    };
    try {
      const r = await this.uds('1A90', 3000);
      const b = Array.from(r.body || []);
      out.steps.push(`1A90 → ${b.map((x) => x.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
      if (rxOk(r.raw) && b[0] === 0x5a && b[1] === 0x90) {
        const vin = vinOf(b, 2);
        if (vin) return { ...out, family: 'kwp', vin, vinSrc: '1A90' };
      }
    } catch (e) { out.steps.push(`1A90 → ${e.message}`); }
    try {
      const s = await this.uds('1003', 3000);
      const sb = Array.from(s.body || []);
      out.steps.push(`1003 → ${sb.map((x) => x.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
      if (!rxOk(s.raw) || sb[0] !== 0x50 || sb[1] !== 0x03) return out;
      const r = await this.uds('22F190', 3000);
      const b = Array.from(r.body || []);
      out.steps.push(`22F190 → ${b.map((x) => x.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
      if (rxOk(r.raw) && b[0] === 0x62 && b[1] === 0xf1 && b[2] === 0x90) {
        const vin = vinOf(b, 3);
        if (vin) return { ...out, family: 'uds', vin, vinSrc: '22F190' };
      }
    } catch (e) { out.steps.push(`UDS 定族 → ${e.message}`); }
    return out;
  }

  async readVehicleIdentity(family = this.family, preflight = null) {
    const out = { name: '', vin: preflight?.vin || '', nameSrc: '', vinSrc: preflight?.vinSrc || '', steps: [...(preflight?.steps || [])] };
    const asciiOf = (body, skip) => Array.from(body || [])
      .slice(skip)
      .filter((c) => c >= 0x20 && c < 0x7f)
      .map((c) => String.fromCharCode(c)).join('').replace(/[\u0000\u0020]+$/g, '').trim();
    // ★ 2026-11-11 原厂对齐（CODE-AUDIT §2.1 偏离①）：删除自创的 looksVin / looksLikePartNo
    //   形态防御层。原厂（PorscheReadVehicleVin @SYSP:0x2a4b4 逐指令）对留存键按
    //   **固定偏移 + 固定长度**取值，不做 VIN 形态猜测：
    //     22 F1 90 (+2, UDS) → 17 字节 VIN（写 0x11 到 param_2 并 Strcpy 到文本库）
    //     1A 90    (+1, KWP) → 17 字节 VIN
    //     21 51    (+3)      → 车名（strcmp 用）
    //   其余键（10 03 / 1A 87 / 1A 9B / 21 50 / 1A 9A）应答发后即清（fire-and-forget）。
    const VIN_KEYS = new Set(['22F190', '1A90']);
    const NAME_KEYS = new Set(['221102', '221101', '2151']);
    const RETAIN = new Set([...VIN_KEYS, ...NAME_KEYS]);
    const step = async (req, { retain = false } = {}) => {
      try {
        const r = await this.uds(req, 3000, { allowEmpty: true });
        const body = Array.from(r.body || []);
        // 5A xx / 61 xx / 62 xx xx 头剥离：1A=5A+1B、21=61+1B、22=62+2B
        let skip = 2;
        if (body[0] === 0x62) skip = 3;
        const txt = asciiOf(body, skip);
        out.steps.push(`${req} → ${(body || []).map((x) => x.toString(16).padStart(2, '0')).join(' ') || '(空)'}`
          + (retain ? '' : '（fire-and-forget，应答不取）'));
        if (!retain || !txt) return;
        // 原厂固定长度取值：VIN 键取 **原始字节** 17 字节（memcpy 语义，不做形态过滤）；
        //   车名键取可打印串（原厂 strcmp 用）。
        // ★ 2026-11-11 二次审计修：旧写法取 `asciiOf`（已过滤非打印并 trim）后再 slice，
        //   会把 VIN 中的分隔字节吃掉导致长度不足；现按 body 原始偏移取。
        const val = VIN_KEYS.has(req)
          ? Array.from(body.slice(skip, skip + 17))
            .filter((c) => c !== 0).map((c) => String.fromCharCode(c)).join('')
          : txt.slice(0, 32);
        if (!out.vin && VIN_KEYS.has(req) && val.length >= 11) {
          out.vin = val; out.vinSrc = req;
        } else if (!out.name && NAME_KEYS.has(req) && val !== out.vin) {
          // 车名键：若与已取 VIN 同串（部分 ECU 对 22 11 02 回 VIN）则不重复记名
          out.name = val; out.nameSrc = req;
        }
      } catch (e) {
        out.steps.push(`${req} → ${e.message}`);
      }
    };
    // ① 主/备双请求（PorscheReadVinAndGetVehicleID @SYSP:0x29fb8：0xff001102 / 0xff001101）
    await step('221102', { retain: true });
    if (!out.name) await step('221101', { retain: true });
    // ② 保守备选路径：FUN_0x22450 的运行时分支无法离线复现，
    // 不把模板表当成八帧顺跑；每个分支只在上一读取未得到所需证据时继续。
    const chain = family === 'uds'
      ? ['1003', '22F190', '1A90', '2151']
      : ['1A90', '2151'];
    for (const req of chain) {
      if (out.name && out.vin) break;
      if (out.vin && VIN_KEYS.has(req)) continue;
      if (req === '1003' && preflight?.family === 'uds') continue;
      await step(req, { retain: RETAIN.has(req) });
    }
    // 22 11 02/01 在某些 ECU 上回的是 VIN 而不是车名；同串不得进入车型显示。
    if (out.name && out.vin && out.name === out.vin) {
      out.steps.push('车名应答与 VIN 同串，丢弃车名');
      out.name = '';
      out.nameSrc = '';
    }
    return out;
  }

  /**
   * OBD 通道读 VIN（`21 09 05`，备选 `09 02`）。
   *
   * 逆取结论（2026-11-11 复核更新）：
   *   - 原厂 `DiagnoseService.open_readVinByObd()` **零参数**，把 `21 09 05` 交给
   *     「一对多发送」(ONE_TO_MORE) 的 VCI 盒；目的 CAN ID 不在 APK 字面量里。
   *   - 但**链路描述字在包内有硬编码**：`PorscheReadVehicleVin` 先写
   *     `token+0x65c = 0xFBE0FD00` —— 按 comm 记录同款编码（(tx<<5)<<16|(rx<<5)）解出
   *     **tx=0x7DF（功能广播）rx=0x7E8**；失败再写 `0xE200EF40` = tx=0x710 rx=0x77A（网关，
   *     实车已证）。即原厂读 VIN 的首选链路就是 **0x7DF 广播、期望 0x7E8 回帧**。
   *   - `21 09 01` 是应答确认（回空），不带 VIN；官方 OBD VIN 库（libReadOBDVIN）
   *     自身用 `09 02`。
   *
   * 因此本方法用 ISO 15765-4 的 OBD 功能地址 `0x7DF`（与原厂首选链路同值），
   * 并且**只认严格正响应**：`61 09 05` + 17 位 VIN 字母表字符；或 `49 02` + 17 位。
   * NRC / 空 / 错长度 / 非法字符一律判负，不猜、不扫描。广播应答方不唯一（多个
   * ECU 可回），故回帧 ID 不做单值硬校验，由内容校验兜底。
   *
   * 读失败不会影响任何写入（本方法只读），结束后恢复原物理寻址。
   * @returns {Promise<{vin:string,src:string,tried:string[]}>}
   */
  async readVinByObd({ timeoutMs = 1500 } = {}) {
    const prev = { tx: this.tx, rx: this.rx, protocol: this.protocol, ready: this._addressReady };
    const tried = [];
    const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/;      // ISO 3779：无 I/O/Q
    const vinOf = (body, hdr) => {
      const b = Array.from(body || []);
      for (let i = 0; i + hdr.length <= b.length; i++) {
        // 头部必须逐字节相符（不做「包含」匹配，避免把别的服务当 VIN）
        if (hdr.some((v, k) => b[i + k] !== v)) continue;
        const txt = b.slice(i + hdr.length)
          .map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' '))
          .join('')
          .replace(/\s+/g, '');
        const m = txt.match(VIN_RE);
        if (m) return m[0];
      }
      return '';
    };
    try {
      // 功能寻址：11 位 500k + 广播头 + 清接收过滤（广播会有多个应答方）
      await atCmdOk(this.elm, 'ATSP6', 2000).catch(() => {});
      await atCmdOk(this.elm, 'ATSH7DF', 2000).catch(() => {});
      await this.elm.cmd('ATCRA', 1500).catch(() => {});
      this._addressReady = false;
      // ① 原厂 APK 同款请求
      tried.push('210905');
      try {
        const r = await this.uds('210905', timeoutMs, { anyRx: true });
        const vin = vinOf(r.body, [0x61, 0x09, 0x05]);
        if (vin) return { vin, src: '21 09 05@0x7DF', tried };
      } catch (e) {
        this._say(`  (OBD 21 09 05 未取到：${e.message})`);
      }
      // ② 官方 OBD VIN 库同款（09 02，PID 01 的 VIN 计数 + 17 字节）
      tried.push('0902');
      try {
        const r = await this.uds('0902', timeoutMs, { anyRx: true });
        const vin = vinOf(r.body, [0x49, 0x02]);
        if (vin) return { vin, src: '09 02@0x7DF', tried };
      } catch (e) {
        this._say(`  (OBD 09 02 未取到：${e.message})`);
      }
      return { vin: '', src: '', tried };
    } finally {
      // 恢复原寻址（即使失败也不能把后续读写留在 7DF 广播上）
      this.tx = prev.tx;
      this.rx = prev.rx;
      this.protocol = prev.protocol;
      this._addressReady = false;
      if (prev.tx != null && prev.rx != null) {
        await this.address().catch(() => {});
      }
    }
  }

  /**
   * 切换到某个 ECU 的物理地址。
   * ⚠️ 每个 ECU 的 tx/rx 不同 —— 硬编码一个地址读所有模块是读不到的（实车教训）。
   */
  /**
   * 设定物理寻址并**立即下发** AT 命令。
   *
   * ⚠️ 2026-10-29 审计 P0-2：此前只改 this.tx/rx/protocol 三个属性，
   *    真正发 ATSP/ATSH/ATCRA 的是 address()。调用方 setAddress 后直接发
   *    uds()，请求其实还打在**上一个模块/探测遗留地址**上 —— 身份验证因此
   *    永远读到别的 ECU，误判后还会清掉正确地址。
   *    现在 setAddress 内部就把寻址落实，调用方必须 await。
   */
  async setAddress(tx, rx, name = '', opts = {}) {
    const isMock = !!(this.elm && (this.elm.mock || this.elm.port?.mock));
    const changed = this.tx !== tx || this.rx !== rx || (name && this.ecuName !== name) || isMock;
    this.tx = tx;
    this.rx = rx;
    // 29-bit 必须切 ATSP7；否则仍按 11-bit/500k 发帧。
    this.protocol = tx > 0x7ff ? 7 : 6;
    this._addressReady = false;
    this.lastReadSid = null;   // 换模块后不能沿用上一个模块的读服务
    if (changed) {
      // 地址/模块变化后，旧算法与旧身份证据全部失效。此前只清 lastReadSid，
      // 会把 A 模块 provider/lastIdent 用到 B 模块，可能算错 key。
      this.seedKeyProvider = null;
      this.lastIdent = '';
      this.identByCmd = {};
      this.lastPartNo = '';
      this.lastPartTokens = [];
      this.lastHwPart = '';
      this.lastSwNo = '';
      this.diagProfile = { verified: false, reason: '地址或模块已变化，需重新验证写流' };
      // 换模块后旧 ECU 的原厂会话不得沿用（981 里 10 03 / 10 89 混用）。
      this.oemSysId = null;
      this.oemSession = null;
      this.oemSessionStrict = null;
      this.oemEnterSeq = '';
      this.oemSequences = [];
      this.oemSessionless = false;
      this.oemSequenceUsed = '';
    }
    if (opts.family !== undefined) this.family = opts.family;   // 会话流家族（kwp/uds/null）
    if (name) this.ecuName = name;
    this._say(`  寻址 → ${name || 'ECU'}  tx=0x${tx.toString(16)} rx=0x${rx.toString(16)}`);
    await this.address();
  }

  /**
   * 发 UDS/KWP 请求并解析。
   *
   * ⚠️ 空响应必须报错 —— 早先不报，导致「会话就绪」是假成功，
   *    后面读出空块也看不出问题（实车日志教训）。
   *
   * @param {boolean} allowEmpty  允许空响应（如 TesterPresent）
   */
  async uds(payloadHex, timeoutMs = 6000, { allowEmpty = false, pendingWait = false, anyRx = false } = {}) {
    // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑨）：回帧 ID 硬校验。
    //   原厂的链路层用 SetAddress/UpdateCanFilterId 做 CAN 过滤，**只可能收到该 ECU 的帧**；
    //   ELM 的 ATCRA 在 EA 通道可能不生效（真车探 0x7F1 回帧头 7E8 即此）。
    //   这里按回帧 ID 比对期望 rx，等价于 原厂的 FilterId 语义 —— 不符即判死，
    //   避免把别的 ECU 的块读出来再写回。mock 适配器不模拟 ATCRA 过滤 → 跳过校验。
    //   `anyRx` 只给**功能寻址广播**（OBD 0x7DF）用：此时本来就没有唯一应答方，
    //   调用方必须自己做更严的内容校验（见 readVinByObd）。
    const isMock = !!(this.elm && (this.elm.mock || this.elm.port?.mock));
    const checkRx = (raw) => {
      if (anyRx || isMock || this.rx == null || !raw) return;
      // frameIdsOf 是逐帧数组；必须先按不同 ID 去重。只要混入一个非期望 ID，
      // 就不能把整段原始文本交给 parseRespAuto（它不会按 CAN ID 过滤）。
      const ids = [...new Set(frameIdsOf(raw))];
      if (!ids.length) return;                        // 适配器不带 ID（ATH0）：无法判，交给解析层
      const wrong = ids.filter((id) => id !== this.rx);
      if (wrong.length) {
        throw new CodingError(
          `回帧包含非期望 CAN ID ${wrong.map((x) => '0x' + x.toString(16).toUpperCase()).join('/')}`
          + `（期望仅 0x${this.rx.toString(16).toUpperCase()}；按 FilterId 语义拒绝解析，防止跨 ECU 读写）`);
      }
    };
    // ★ NRC `7F xx 78`（responsePending）= **续等**直至正响应或超时（RE-FLOWSPEC §5 /
    //   Set7F78Ctrl 语义，证据锚=读写包装）；其余 NRC 单发即败（不重试不换 SID，错误上浮）。
    //   重发帧与原帧逐字节一致（同 payloadHex）。
    //   ⚠️ 仅读写包装（readBlock/写入帧）传 pendingWait —— 例程层（31）的 78 必须上浮给
    //   pollRoutineResults 的 31 03 跟随轮询（REA 执行流语义），吞掉会杀掉轮询。
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    for (;;) {
    const raw = (await this.elm.cmd(payloadHex, Math.min(timeoutMs, Math.max(500, deadline - Date.now()))) || '').trim();
    checkRx(raw);
    // 调试：原始收发都记下来
    this._trace(`  >> ${payloadHex}`);
    this._trace(`  << ${raw || '(空)'}`);
    // ★ 2026-11-04：自适应解析（裸 ISO-TP / 纯数据两种适配器输出通吃）
    const reqSid = parseInt(String(payloadHex).replace(/[^0-9A-Fa-f]/g, '').slice(0, 2), 16) & 0xff;
    const p = parseRespAuto(raw, String(payloadHex || '').replace(/[^0-9A-Fa-f]/g, ''), reqSid);
    if (p.kind === 'nrc') {
      if (pendingWait && (p.code || 0) === 0x78 && Date.now() < deadline) {
        this._trace('  (7F 78 响应挂起 —— 续等重发原帧)');
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw new CodingError(`服务 0x${p.service?.toString(16)} 被拒（NRC 0x${(p.code||0).toString(16)}）`, p.code);
    }
    // 多帧截断：宁可报错也不能把短块交出去（会被写回 ECU）
    if (p.kind === 'truncated') {
      throw new CodingError(
        `服务 ${payloadHex} 多帧应答被截断：声明 ${p.expected} 字节，实收 ${p.received} 字节。` +
        `可能是超时 / 假提示符 / 流控异常 —— 不能拿短块继续，更不能写回。`);
    }
    if (p.kind === 'empty' && !allowEmpty) {
      throw new CodingError(
        `服务 ${payloadHex} 无应答 —— ECU 未响应。` +
        `可能：地址不对 / ECU 不在该 CAN 上 / 未点火 / 需先换会话`);
    }
    return { raw, ...p };
    }
  }

  /** 调试轨迹（可关） */
  _trace(m) {
    if (this.verbose) this._say(m);
  }

  /**
   * 读编码块 —— 与参考诊断仪 请求格式 1:1 对齐。
   *
   * ⚠️ 标识符位宽因 SID 而异（抓包实测，COMMAND.GAG 3139 条）：
   *   `21 <1字节 LID>`   KWP ReadDataByLocalIdentifier    ← len=2
   *   `22 <2字节 DID>`   UDS ReadDataByIdentifier         ← len=3（主力，2050 条）
   *   `1A <1字节 LID>`   KWP ReadECUIdentification        ← len=2
   *   `3B <1字节 LID> <data>`  KWP WriteDataByLocalIdentifier
   *   `2E <2字节 DID> <data>`  UDS WriteDataByIdentifier
   *
   * ⚠️ 早先用 padStart(4) 发 2 字节 ID，ECU 收到畸形请求，回 NO DATA —— 实车读不出来的直接原因。
   *
   * @param {number} id      LID(1字节) 或 DID(2字节)
   * @param {number} readSid 读服务
   */
  async readBlock(id, readSid = 0x21) {
    // ★ 2026-11-05 错误恢复定案：**SID 0x12 换 SID 重试已删**（自创恢复，无 参考诊断仪 取证）。
    //   参考诊断仪 读包装（参考诊断仪 读包装）逐指令无 NRC 0x12 重试逻辑：
    //   SID 由记录自带（readSid），发一次、被拒即失败，结果由 ECU 裁决。
    //   22↔21 按族选择是数据驱动（GAG 取证），不是运行时回退。
    return await this._readBlockImpl(id, readSid);
  }

  /** readBlock 的实际实现 */
  async _readBlockImpl(id, readSid = 0x21) {
    // ⚠️ 标识符位宽必须校验（2026-10-18 审计）：0x21/0x1A 是 1 字节 LID，
    //    0x22 是 2 字节 DID。传超宽会 padStart 出畸形请求（如 0x1234 发给 0x21）。
    if (!Number.isInteger(id) || id < 0) throw new CodingError(`非法标识符 ${id}（必须为整数）`);
    // ★ 读帧服务集闸（2026-11-08 覆盖审计②）：参考诊断仪 读包装
    //   （参考诊断仪 读包装）只打包 21/1A/22 三种读帧，其余 SID（含 0x00）不发。
    //   记录 readSid=0 的块读走回落读服务（schema.resolveBlockReadSid），不发 00 帧。
    if (!READ_SIDS.includes(readSid)) {
      throw new CodingError(
        `读服务 0x${Number(readSid).toString(16)} 非读帧服务（参考诊断仪 读帧仅 0x21/0x22/0x1A），不发帧`);
    }
    if (readSid === 0x22) {
      if (id > 0xffff) throw new CodingError(`UDS DID 0x${id.toString(16)} 超出 2 字节`);
    } else if (id > 0xff) {
      throw new CodingError(`KWP LID 0x${id.toString(16)} 超出 1 字节（readSid=0x${readSid.toString(16)}）`);
    }
    await this.address();
    const idBytes = (readSid === 0x22) ? 4 : 2;    // ← 位宽随 SID
    const idHex = id.toString(16).toUpperCase().padStart(idBytes, '0');
    const sid = readSid.toString(16).toUpperCase().padStart(2, '0');
    const r = await this.uds(`${sid}${idHex}`, 6000, { pendingWait: true });

    // 校验正响应 SID（request SID + 0x40）
    const wantResp = (readSid + 0x40) & 0xFF;
    if (!r.body.length || r.body[0] !== wantResp) {
      throw new CodingError(
        `读 ${sid} ${idHex} 响应异常：期望 SID 0x${wantResp.toString(16)}，` +
        `实得 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
    }
    // 头长按 SID：
    //   0x22 → 62 <DID_hi> <DID_lo> <data>   slice(3)
    //   0x21 → 61 <LID>     <data>           slice(2)
    //   0x1A → 5A <LID>     <data>           slice(2)
    const hdrLen = readSid === 0x22 ? 3 : 2;
    if (r.body.length < hdrLen) {
      throw new CodingError(`读 ${sid} ${idHex} 响应头不完整`);
    }
    const idEchoOk = readSid === 0x22
      ? (r.body[1] === ((id >> 8) & 0xff) && r.body[2] === (id & 0xff))
      : (r.body[1] === (id & 0xff));
    if (!idEchoOk) {
      throw new CodingError(
        `读 ${sid} ${idHex} 回显标识符不符：实得 `
        + `${r.body.slice(0, hdrLen).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    const data = r.body.slice(hdrLen);
    if (!data.length) {
      throw new CodingError(`读 0x${idHex} 返回 0 字节数据（响应 ${r.body.length}B）`);
    }
    // 记住最近一次读服务，供例程/特殊功能判断 KWP(21/1A) 还是 UDS(22)。
    this.lastReadSid = readSid;
    return data;
  }

  /**
   * 安全访问（0x27 09/0A）
   * @throws MissingSeedKeyError  未配置算法时
   */
  async securityAccess(level = 0x09, kwp = false) {
    if (!this.seedKeyProvider) throw new MissingSeedKeyError(this.ecuName);
    await this.address();
    // ⚠️ SID 跟协议族走：UDS 用 27，KWP 用 17（审计 #25 —— 此前写死 27）
    const sidHex = kwp ? '17' : '27';
    // ⚠️ KWP 的 level 与 UDS 不同（2026-10-17 审计 D2）：GAG 实测 0x17 只有
    //    `17` / `17 40` / `17 00` / `17 00 00` / `17 40 00`，**没有 17 09**。
    //    此前 KWP 也发 0x09 → NRC 0x12/0x13 或吃满安全尝试计数。
    const lv = kwp ? 0x00 : level;
    // 取 seed（UDS 规则：seed=奇数 level，key=level+1）
    // ⚠️ 实测取 seed 是 `27 09 01 00` 带 2 字节尾参（审计 D3，GAG 3139 条里 2 条 27 全带尾参）。
    //    裸 `27 09` 可能吃 NRC 0x13。与 securityAccessEx 保持同一口径：
    //    KWP `17 00 00`；UDS level 0x09 带 `0100`；其他 level 无实测证据→裸发。
    const seedTail = kwp ? '00' : (level === 0x09 ? '0100' : '');
    const s = await this.uds(`${sidHex}${lv.toString(16).padStart(2, '0')}${seedTail}`, 5000);
    // ⚠️ 先校验正响应 SID，再切 seed（与 securityAccessEx 同口径）：
    //    地址错/串线时可能拿到别的正响应，直接 slice 会把垃圾当 seed。
    const wantSeedSid = kwp ? 0x57 : 0x67;
    if (s.body.length && s.body[0] !== wantSeedSid) {
      throw new CodingError(
        `取 seed 响应异常：期望 SID 0x${wantSeedSid.toString(16)}，` +
        `实得 ${s.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    // ⚠️ KWP `17` 的正响应是 `57 <seed...>`（不回显子功能），UDS `27` 是 `67 <level> <seed...>`。
    //    早先两种都 slice(2) → KWP 会吃掉一个 seed 字节，算出的 key 必错。
    const seed = s.body.slice(kwp ? 1 : 2);
    this._say(`  seed = ${seed.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    if (!seed.length) {
      // ⚠️ 空 seed 不等于「无需解锁」（2026-10-17 审计 D4）：此前 `.every()` 对空数组
      //    返回 true → 记「无需解锁」跳过 → 写入吃 NRC 0x33 或状态混乱。
      throw new CodingError('取 seed 返回空 —— 不能当作「无需解锁」，中止写入');
    }
    if (seed.every((b) => b === 0)) {
      this._say('  seed 全零 = 该 ECU 无需解锁，跳过');
      return true;
    }
    // 插槽算 key
    const key = this.seedKeyProvider.calc(seed, level);
    const kArr = Array.from(key instanceof Uint8Array ? key : key);
    // ⚠️ 空 key 绝不能发（与 securityAccessEx 同口径）：`27 0A` 不带 key 会吃 NRC 0x35，
    //    重试吃满 → 0x36 锁死。needsKey=false 要给出「原厂无 case」的针对性报错。
    if (!kArr.length) {
      const noAlgo = this.seedKeyProvider && this.seedKeyProvider.needsKey === false;
      if (noAlgo) {
        // ★ 2026-11-05 对齐 参考诊断仪：原厂该 mode 无 case = **不发 key**，
        //   直接继续写入流程（备份→写→回读），结果由 ECU 裁决 —— 不发 key 不会
        //   触发 0x35/0x36 安全计数（那只有发错 key 才会）。此处不再拒写。
        this._say('  原厂无 case 不发 key —— 继续写入（结果由 ECU 裁决）', 'warn');
        return true;
      }
      throw new CodingError('算法返回空 key —— 拒绝发送（会吃 NRC 0x35）');
    }
    this._say(`  key  = ${kArr.map((b) => b.toString(16).padStart(2, '0')).join(' ')}` +
              `（算法 ${this.seedKeyProvider.name}）`);
    // 发 key —— ⚠️ KWP 的 key 子功能是 **0x40**（实测 `17 40` / `17 40 00`），
    //    不是 `lv+1`（那会发成 `17 01`，必然 NRC）。UDS 才是 level+1（09→0A）。
    //    这条在 securityAccess()/securityAccessEx() 两处都必须一致。
    const keySub = kwp ? 0x40 : (lv + 1);
    const kHex = kArr.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const kr = await this.uds(`${sidHex}${keySub.toString(16).padStart(2, '0')}${kHex}`, 6000);
    const wantKeySid = kwp ? 0x57 : 0x67;
    if (!kr.body.length || kr.body[0] !== wantKeySid) {
      throw new CodingError(
        `发 key 响应异常：期望 SID 0x${wantKeySid.toString(16)}，` +
        `实得 ${kr.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
    }
    this._say('  ✅ 已解锁');
    return true;
  }

  /**
   * 执行一次单项编码变更（完整闭环）
   *
   * @param {object} p        参数条目（schema，须含 lid / readSid / writeSid）
   * @param {number} value    目标字段值
   * @param {object} opts     { session=逐ECU原厂会话/0x89, dryRun=true, secLevel=0x09 }
   */
  async applyChange(p, value, opts = {}) {
    // ⚠️ 写事务整体排他（审计 #20）：双击写入/批量与单项交叉会在 await 点交错。
    if (this._writeBusy) throw new CodingError('已有写入在进行中，请等待完成');
    this._writeBusy = true;
    try {
      return await this._applyChangeInner(p, value, opts);
    } finally {
      this._writeBusy = false;
    }
  }

  async _applyChangeInner(p, value, opts = {}) {
    const {
      session,              // 未给 → resolveSession()：逐 ECU 原厂会话，无证据回退 0x89
      dryRun = true,
      secLevel = 0x09,       // 参考诊断仪实测 SecurityAccess level
    } = opts;
    const sess = this.resolveSession(session);

    if (!dryRun && !this.diagProfile?.verified) {
      throw new CodingError(`当前 ECU 写流未验证，保持只读：${this.diagProfile?.reason || '缺少诊断 profile 证据'}`);
    }

    // ★ LID 来自参数条目，绝不硬编码 —— 猜错 DID 会写坏别的块。
    const lidRaw = p.lid ?? p.did;
    if (lidRaw == null) {
      throw new CodingError(`参数 ${p.name} 缺 LID/DID，拒绝写入。`);
    }
    const lid = Number(lidRaw);
    if (!Number.isInteger(lid) || lid < 0) {
      throw new CodingError(`参数 ${p.name} 的 LID/DID 不是非负整数（${lidRaw}），拒绝写入。`);
    }
    // 读写 SID 必须来自记录/表级读服务，公共 API 不得替记录发明默认 21/3B。
    const readSidRaw = p.readSid;
    const writeSid = p.writeSid;
    // ★ 参考诊断仪 同款闸（2026-11-08 覆盖审计②）：写走记录 writeSid 帧，
    //   无配对表（参考诊断仪 用记录自带 readSid/writeSid 发帧，RE-FLOWSPEC §3.1）。
    //   参考诊断仪 写包装（参考诊断仪 写包装）只打包 3B/2E 两种写帧：
    //     3B <LID8> <data> / 2E <DID16be> <data>；其余 writeSid 不发（=只读项）。
    if (!WRITE_SIDS.includes(writeSid)) {
      throw new CodingError(
        `${p.name} 是只读项（记录 writeSid=${writeSid == null ? '缺失' : '0x' + Number(writeSid).toString(16)} 非写服务）：` +
        `参考诊断仪 写帧仅 0x3B/0x2E，禁止写入。`);
    }
    // 标识符位宽校验（与 readBlock 同一口径，避免拼出畸形写请求）
    if (writeSid === 0x2E) {
      if (!Number.isFinite(lid) || lid < 0 || lid > 0xffff) {
        throw new CodingError(`UDS DID 0x${Number(lid).toString(16)} 超出 2 字节`);
      }
    } else if (!Number.isFinite(lid) || lid < 0 || lid > 0xff) {
      throw new CodingError(`KWP LID 0x${Number(lid).toString(16)} 超出 1 字节`);
    }
    // 读服务解析（参考诊断仪 记录语义）：
    //   readSid∈{21,22,1A} → 按记录发读帧；readSid=0/其他 → 记录无读服务，
    //   参考诊断仪 不发 0x00 读帧（参考诊断仪 读包装 只打包 1A/21/22），回落表级读服务
    //   （参考诊断仪 备份读 用表首记录 SID 读整个 PID map，代码实证）。
    //   表内无任何读服务 → 读不到=不写（RE-FLOWSPEC §4.1 / McrCodeChileWrite 读失败即中止）。
    let readSid;
    if (READ_SIDS.includes(Number(readSidRaw))) {
      readSid = Number(readSidRaw);
    } else if (READ_SIDS.includes(Number(p.blockReadSid))) {
      readSid = Number(p.blockReadSid);
    } else {
      throw new CodingError(
        `${p.name} 无读服务（记录 readSid=0x${Number(readSidRaw).toString(16)}，` +
        `表内无回落读服务）：参考诊断仪 读不到=不写，禁止写入。`);
    }
    // ★ 2026-11-11 原厂对齐：值域闸门改为 opt-in（SAFETY.range，默认关）。
    //   原厂写政策无值域门禁（RE-FLOWSPEC §4.0/§4.1），默认路径不拦。
    if (SAFETY.range && !fieldInRange(p, value)) {
      throw new CodingError(
        `${p.name} 的目标值 ${value} 超出范围 ${p.min ?? 0}…${p.max ?? '?'}，拒绝写入（安全增强已开启）。`);
    }

    this._say(`\n=== ${p.name} → ${decodeValue(p, value)} ===`);
    this._say(`  位置: byte ${p.byte} bit ${p.bit}（宽 ${p.bitsize}）  风险: ${p.risk}`);
    this._say(`  服务: 读 ${readSid.toString(16)} / 写 ${writeSid.toString(16)}  LID=0x${lid.toString(16)}`);

    // 1. 进会话 + 备份原值
    //   ⚠️ 2026-11-10 修：此前是「先读备份、后进会话」—— 注释自己写的序列是
    //   `10 03 → 3E → 识别 → 10 89 → 读写`，但代码把读放在会话之前。
    //   依赖「进模块时碰巧还在 10 89」这个隐含状态；一旦中途被 10 03/其他模块切走，
    //   备份读会拿 NRC，写入直接中止（或更糟：读到别的会话下的默认值）。
    //   现按 参考诊断仪 的写序列：**会话 → 读备份 → 安全访问 → 写 → 回读**。
    // ★ 2026-11-11 原厂对齐（CODE-AUDIT §5.2 偏离②）：写序列**不重跑识别链**。
    //   原厂写序列（RE-FLOWSPEC §4.0/§4.1）只有「会话 → 备份 →（安全访问）→ 单项写 → 回读」，
    //   没有 1A 9F/87/84/91/92/93/94/95/97/9A 十帧识别。旧实现每次写都经 enterSession
    //   重跑整套识别链（最多 +9s，还会清空 lastIdent/lastPartNo 等变体证据）。
    this._say('  进会话 …');
    if (this.oemSessionless && session == null) {
      // ★ 2026-11-12 全量收口：68 个老代 sysId 的原厂序列是 81 快初始化 + 1A 识别，
      //   **没有 10 xx 会话帧**。写路径不能沿用 resolveSession() 的 0x89 回退，
      //   否则会给 KWP ECU 发 UDS 帧吃 NRC 0x12，把写流程卡在会话步。
      await this.address();
      this._say('  ⓘ 原厂老代 KWP 不建 UDS 会话 —— 写序列跳过会话建立（不回退 10 89）');
    } else {
      await this.enterSession(sess, { skipIdent: true, strictSession: true });
    }
    const before = await this.readBlock(lid, readSid);
    this.backups.push({
      id: p.id, lid, readSid, writeSid, session: sess, time: new Date().toISOString(),
      model: this.modelLabel || p.model || null,
      module: p.module || null,
      sysLabel: this.ecuName || null,
      tx: this.tx, rx: this.rx,
      raw: before.map((b) => b.toString(16).padStart(2, '0')).join(''),
      name: p.name,
    });
    this._say(`  原值: ${before.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    const oldField = extractField(before, p);
    this._say(`  原字段值: ${decodeValue(p, oldField)}`);

    // 2. 计算新块
    const after = injectField(before, p, value);
    if (!after) throw new CodingError('参数超出编码块长度');
    if (after.length !== before.length) throw new CodingError('长度变化异常');

    // 3. 变更摘要：变更字节必须落在该字段占用的字节范围内
    //    （不再要求"恰好 1 字节"——bitsize>8 或跨字节字段会改 2 字节，那是正常的）
    const diffs = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        diffs.push({ byte: i, from: before[i], to: after[i] });
      }
    }
    this._say(`  变更: ${diffs.map((d) => `byte${d.byte}: 0x${d.from.toString(16)}→0x${d.to.toString(16)}`).join(', ') || '（无变化）'}`);
    const span = fieldByteSpan(p);          // [lo, hi] 闭区间
    const outOfRange = diffs.filter((d) => d.byte < span[0] || d.byte > span[1]);
    // ★ 2026-11-11 原厂对齐：变更越界检查是安全增强（原厂无），默认关。
    if (SAFETY.span && outOfRange.length) {
      this._say(`  ⚠️ 变更越出字段占用字节 [${span[0]}..${span[1]}]：` +
                `${outOfRange.map((d) => d.byte).join(',')} —— 中止`);
      throw new CodingError(`变更扩散到字段外字节，为安全中止`);
    }
    if (!diffs.length) {
      throw new CodingError('新旧值相同，无需写入');
    }

    if (dryRun) {
      this._say('  [dry-run] 未发送写入');
      return { dryRun: true, before, after, diffs };
    }

    // 4. 会话已在步骤 1 建立（会话 → 读备份 → 安全访问 → 写 → 回读）

    // 5. 安全访问（参考诊断仪实测 UDS 用 27 09 / 27 0A）
    //    ⚠️ level 是 0x09，不是 0x01。发错会 NRC 0x12/0x7F，或吃满尝试次数锁死（0x36）
    //    ⚠️ **SID 要跟协议族走**：UDS 用 `27`，KWP 用 `17`。
    //       判据 = 读 SID：`22`→UDS、`21`/`1A`→KWP（55 条 21↔3B 项是 KWP 设备）。
    //       此前写死 27，KWP 项会 NRC 或吃满尝试计数（2026-10-16 复查 P6）。
    const isKwp = readSid !== 0x22;   // 22 = UDS；21 / 1A = KWP
    await this.securityAccessEx({ level: secLevel, kwp: isKwp });

    // 6. 写入（SID 与读成对，不再写死 3B）
    const hex = after.map((b) => b.toString(16).padStart(2, '0')).join('');
    this._say(`  写入 ${writeSid.toString(16).toUpperCase()} 0x${lid.toString(16)} …`);
    // ⚠️ LID 位宽随 SID（抓包实测）：0x3B 用 1 字节 LID，0x2E 用 2 字节 DID
    const lidBytes = (writeSid === 0x2E) ? 4 : 2;
    const wr = await this.uds(
      `${writeSid.toString(16).toUpperCase().padStart(2, '0')}` +
      `${lid.toString(16).toUpperCase().padStart(lidBytes, '0')}${hex}`, 8000, { pendingWait: true });
    // 正响应 SID = 写 SID + 0x40（3B→7B / 2E→6E）。地址错/串线时不能拿别的正响应当写成功。
    const wantWriteSid = (writeSid + 0x40) & 0xff;
    if (!wr.body.length || wr.body[0] !== wantWriteSid) {
      throw new CodingError(
        `写服务 ${writeSid.toString(16)} 响应异常：期望 ${wantWriteSid.toString(16)}，` +
        `实得 ${wr.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
    }
    const wrHdr = writeSid === 0x2E ? 3 : 2;
    const wrIdOk = wr.body.length >= wrHdr && (writeSid === 0x2E
      ? (wr.body[1] === ((lid >> 8) & 0xff) && wr.body[2] === (lid & 0xff))
      : (wr.body[1] === (lid & 0xff)));
    if (!wrIdOk) {
      throw new CodingError(`写 ${lid.toString(16)} 回显标识符不符：`
        + `${wr.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    // 7. 回读校验
    this._say('  回读校验 …');
    const readback = await this.readBlock(lid, readSid);
    const match = readback.length === after.length &&
      readback.every((b, i) => b === after[i]);
    if (!match) {
      // ★ 2026-11-11 原厂对齐（CODE-AUDIT §5.2 偏离③）：原厂的回读不一致 = **记录失败**，
      //   不自动回滚（RE-FLOWSPEC §4.7「回读=重读该 LID 整块与写入值比对，不一致=记录失败」）。
      //   自动 _restore 是自创安全增强，默认关；需要时 setSafety({autoRestore:true})。
      if (!SAFETY.autoRestore) {
        throw new CodingError(
          `回读不一致（原厂语义：记录失败，不自动回滚）`
          + `（期望 ${after.map((x) => x.toString(16).padStart(2, '0')).join('')}，`
          + `实读 ${readback.map((x) => x.toString(16).padStart(2, '0')).join('')}）`);
      }
      this._say('  ❌ 回读不一致，尝试恢复备份（安全增强已开启）');
      // ⚠️ 恢复失败不能把「回读不一致」这个**首要故障**顶掉（2026-10-18 审计）：
      //    此前 _restore 自己抛错（多数是解锁失败）会替换掉原异常，
      //    用户只看到「恢复后回读与备份不一致」，看不出真正的问题是写入没生效。
      try {
        await this._restore(this.backups[this.backups.length - 1]);
      } catch (re) {
        throw new CodingError(
          `回读不一致，且恢复备份失败：${re.message}` +
          `（原块 ${after.map((x) => x.toString(16)).join('')}，` +
          `实读 ${readback.map((x) => x.toString(16)).join('')}）`);
      }
      throw new CodingError('回读不一致，已尝试恢复原值');
    }
    this._say('  ✅ 回读一致');
    return { dryRun: false, before, after, readback, diffs };
  }

  /** 恢复备份（用备份里记录的 LID/SID，不猜） */
  async _restore(bk) {
    // ⚠️ 恢复也要走完整写入序列（审计 #18）：进会话 + 安全访问 + 回读校验。
    if (!bk || typeof bk.raw !== 'string' || !bk.raw.length
        || bk.raw.length % 2 || !/^[0-9a-fA-F]+$/.test(bk.raw)) {
      throw new CodingError('备份原始块为空或不是偶数位十六进制，无法恢复');
    }
    if (!Number.isInteger(bk.lid) || bk.lid < 0) throw new CodingError('备份缺合法 LID/DID，拒绝恢复');
    if (!WRITE_SIDS.includes(bk.writeSid)) throw new CodingError('备份无 3B/2E 写服务，拒绝恢复');
    if (!READ_SIDS.includes(bk.readSid)) throw new CodingError('备份无实际读服务，拒绝恢复');
    if (bk.tx != null && bk.rx != null && (bk.tx !== this.tx || bk.rx !== this.rx)) {
      throw new CodingError(`备份属于其他地址 0x${bk.tx.toString(16)}/0x${bk.rx.toString(16)}，拒绝跨 ECU 恢复`);
    }
    const bytes = bk.raw.match(/.{2}/g).map((h) => parseInt(h, 16));
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    const sid = bk.writeSid.toString(16).toUpperCase().padStart(2, '0');
    const idHex = bk.lid.toString(16).toUpperCase().padStart((bk.writeSid === 0x2E) ? 4 : 2, '0');
    await this.enterSession(bk.session ?? 0x89, { skipIdent: true });
    const kwpRestore = bk.readSid !== 0x22;
    await this.securityAccessEx({ level: kwpRestore ? 0x00 : 0x09, kwp: kwpRestore });
    const wr = await this.uds(`${sid}${idHex}${hex}`, 8000, { pendingWait: true });
    const want = (Number.parseInt(sid, 16) + 0x40) & 0xff;
    if (!wr.body.length || wr.body[0] !== want) {
      throw new CodingError(
        `恢复写 ${sid} 响应异常：期望 ${want.toString(16)}，` +
        `实得 ${wr.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
    }
    const restoreHdr = bk.writeSid === 0x2E ? 3 : 2;
    const restoreIdOk = wr.body.length >= restoreHdr && (bk.writeSid === 0x2E
      ? (wr.body[1] === ((bk.lid >> 8) & 0xff) && wr.body[2] === (bk.lid & 0xff))
      : (wr.body[1] === (bk.lid & 0xff)));
    if (!restoreIdOk) throw new CodingError('恢复写回显标识符不符');
    // 回读校验
    const back = await this.readBlock(bk.lid, bk.readSid);
    const same = back.length === bytes.length && back.every((x, i) => x === bytes[i]);
    if (!same) throw new CodingError('恢复后回读与备份不一致');
    this._say('  已写回备份值并回读校验通过');
  }

  /** 导出备份 */
  exportBackups() {
    return {
      time: new Date().toISOString(),
      exportedFrom: { ecu: this.ecuName, model: this.modelLabel || null, tx: this.tx, rx: this.rx },
      // 每项备份自带 model/module/sysLabel/tx/rx；不能用当前 ECU 给混合历史统一贴标签。
      backups: this.backups,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
//  特殊功能 / 例程 / 执行器 / 故障码 —— 与参考诊断仪 服务集 1:1
//  服务形态全部来自 COMMAND.GAG 3,139 条实测请求
// ═══════════════════════════════════════════════════════════════

/**
 * 例程控制 0x31 —— 特殊功能的主力（参考诊断仪用了 252 次）。
 *
 * 形态：`31 <subFunc> <routineId 2B> <params>`
 *   subFunc: 01=startRoutine 02=stopRoutine 03=requestRoutineResults
 *   实测还有 0xB8/0xB9/0xBA/0xBB/0x10 等厂商扩展子功能
 * routineId 常见：0x0107(×69) 0x0103(×35) 0x0466 0x0005 0x0400 0x06F6 0x0DD4 …
 *
 * 会话：实测多在 `10 86` / `10 4F` 下执行。
 */
async function routineControl(subFunc, routineId, params = '', timeoutMs = 15000) {
  if (!Number.isFinite(subFunc) || subFunc < 0 || subFunc > 0xff) {
    throw new CodingError(`例程子功能 0x${Number(subFunc).toString(16)} 超出 1 字节`);
  }
  if (!Number.isFinite(routineId) || routineId < 0 || routineId > 0xffff) {
    throw new CodingError(`例程 RID 0x${Number(routineId).toString(16)} 超出 2 字节`);
  }
  const rid = routineId.toString(16).toUpperCase().padStart(4, '0');
  const sf = subFunc.toString(16).toUpperCase().padStart(2, '0');
  const r = await this.uds(`31${sf}${rid}${params}`, timeoutMs);
  // 正响应 SID 必须是 71（31 + 0x40）；串线/错地址时可能拿到别的正响应。
  if (!r.body.length || r.body[0] !== 0x71) {
    throw new CodingError(
      `例程 31 ${sf} ${rid} 响应异常：期望 71，` +
      `实得 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
  }
  return r;
}

/**
 * 例程结果轮询「跟随服务」—— `31 03 <rid>`（requestRoutineResults）。
 *
 * 依据（离线实证，证据档 REAUDIT-20261017 §其他定论）：
 *   FUNC 族发 `02 33 00` 跟随服务（KWP 风格，UDS 侧对应 `31 03`），
 *   **轮询直到响应不是 NRC 21 / 23 / 78**（= 例程还在跑）。
 *
 * ⚠️ 这是此前**完全缺失**的一条：原实现 `31 01` 发完一次就判成败。
 *    长例程（排气 / 校准 / 匹配 / 初始化）ECU 会先回 `7F 31 78`（响应挂起）
 *    或 `7F 31 21`（忙），我们直接 toast「失败」—— 而例程其实正在跑。
 *
 * @returns {Promise<{done:boolean, result:object|null, nrc:number|null, polls:number}>}
 */
async function pollRoutineResults(routineId, {
  maxMs = 30000, intervalMs = 1500, allowNrc = [0x21, 0x23, 0x24, 0x78],
  onPoll = null, shouldStop = null,
} = {}) {
  const deadline = Date.now() + maxMs;
  let polls = 0;
  let last = null;
  for (;;) {
    if (shouldStop && shouldStop()) return { done: false, result: null, nrc: last, polls, aborted: true };
    polls += 1;
    try {
      const r = await this.uds(`3103${routineId.toString(16).toUpperCase().padStart(4, '0')}`, 6000);
      if (!r.body.length || r.body[0] !== 0x71) {
        throw new CodingError(
          `例程结果 31 03 响应异常：期望 71，` +
          `实得 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
      }
      if (onPoll) onPoll({ polls, ok: true, body: r.body });
      return { done: true, result: r, nrc: null, polls };
    } catch (e) {
      const nrc = e instanceof CodingError ? e.nrc : null;
      last = nrc;
      if (onPoll) onPoll({ polls, ok: false, nrc, message: e.message });
      // 只有「例程未完成」类 NRC 才继续等；别的（33/35/22/31…）是真失败，立刻抛
      if (nrc == null || !allowNrc.includes(nrc)) throw e;
      if (Date.now() >= deadline) {
        throw new CodingError(
          `例程 0x${routineId.toString(16).toUpperCase()} 在 ${Math.round(maxMs / 1000)}s 内未完成` +
          `（轮询 ${polls} 次，最后 NRC 0x${nrc.toString(16)}）。` +
          `可点「查结果」继续查询，不要重复点「执行」—— 重复 startRoutine 会重启例程。`, nrc);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/**
 * 执行例程并在必要时自动轮询到完成。
 *
 * @param {number} subFunc   01=start 02=stop 03=requestResults
 * @param {number} routineId
 * @param {string} params
 * @param {object} opts  { poll=false, maxMs, intervalMs, onPoll, shouldStop }
 */
async function runRoutine(subFunc, routineId, params = '', opts = {}) {
  const { poll = true, ...pollOpts } = opts;
  try {
    const r = await this.routineControl(subFunc, routineId, params);
    return { result: r, polled: 0 };
  } catch (e) {
    const nrc = e instanceof CodingError ? e.nrc : null;
    // ⛔ 只有 stopRoutine(0x02) 不轮询 —— 它是「取消」，等下去没有意义。
    //    startRoutine(0x01) 和 requestResults(0x03) 都可能回「未完成」，都要轮询。
    if (!poll || subFunc === 0x02 || nrc == null ||
        ![0x21, 0x23, 0x24, 0x78].includes(nrc)) {
      throw e;
    }
    this._say(`  例程未完成（NRC 0x${nrc.toString(16)}）→ 转 31 03 跟随轮询`);
    const p = await this.pollRoutineResults(routineId, pollOpts);
    if (!p.done) throw new CodingError('例程轮询被中止', p.nrc ?? undefined);
    return { result: p.result, polled: p.polls };
  }
}

Object.assign(Coder.prototype, { pollRoutineResults, runRoutine });

/**
 * IOControl 0x2F —— 执行器测试 / 短时调节（参考诊断仪用了 154 次）。
 *
 * 形态：`2F <DID 2B> <controlOption> <controlState>`
 *   controlOption: 00=returnControlToECU 01=resetToDefault
 *                  02=freezeCurrentState 03=shortTermAdjustment
 * 实测样例：
 *   2f 04 5b 03 ff 00 00 00   shortTermAdjustment, DID=0x045B
 *   2f 04 5b 00               returnControlToECU
 *   2f 80 01 00
 * 会话：实测多在 `10 85` 下执行。
 */
async function ioControl(did, controlOption = 0x03, state = '', timeoutMs = 8000) {
  if (!Number.isFinite(did) || did < 0 || did > 0xffff) {
    throw new CodingError(`执行器 DID 0x${Number(did).toString(16)} 超出 2 字节`);
  }
  if (![0, 1, 2, 3].includes(controlOption)) {
    throw new CodingError(`IOControl controlOption 必须是 0..3（收到 ${controlOption}）`);
  }
  const d = did.toString(16).toUpperCase().padStart(4, '0');
  const co = controlOption.toString(16).toUpperCase().padStart(2, '0');
  const r = await this.uds(`2F${d}${co}${state}`, timeoutMs);
  if (!r.body.length || r.body[0] !== 0x6f) {
    throw new CodingError(
      `执行器 2F ${d} 响应异常：期望 6F，` +
      `实得 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
  }
  return r;
}

/**
 * 读故障码。
 *   UDS `19 <subFunc> <mask>`     实测 19 02 89 / 19 06 00 00 00 FF
 *   KWP `18 <group> <...>`        实测 18 00 40 00 / 18 FF FF 01
 */
async function readDtc(subFunc = 0x02, mask = 0x89, timeoutMs = 10000) {
  if (!Number.isFinite(subFunc) || subFunc < 0 || subFunc > 0xff
      || !Number.isFinite(mask) || mask < 0 || mask > 0xff) {
    throw new CodingError(`DTC 参数非法：subFunc=${subFunc} mask=${mask}`);
  }
  // ⚠️ UDS 19 失败要回退 KWP 18（2026-10-17 审计 F6）：GAG 实测 18×10 比 19×5 更常用，
  //    KWP 模块只发 19 会 NRC。实测形态：`18 00 40 00` / `18 00 FF 00`
  // ★ 2026-11-05 DTC 服务定案（有据，换族回退已删）：
  //    参考诊断仪 的 18/19 选取 = **每模块记录字段驱动的请求 ID/模板分派**
  //    （PorscheReadDtc：0xff001407/0xff000619 族请求 ID + SearchID 模板，
  //      记录字段 cmp 门槛；全文无硬编码 18/19 分支）；NRC 7F = 结果置空、
  //    **零换族**（0x16710 逐指令实证）——原「19 失败换 18」是自创恢复，已删。
  //    模板绑定数据（每 ECU ODX 记录）不在提取包 → 按族单发（数据定替代）：
  //    KWP 族（1A/21 识别）→ 18 族，UDS 族 → 19 族（服务对 18↔58 / 19↔59，
  //    ISO 14229 / KWP2000，src/dtc.js 应答解析同口径）。
  // ⚠️ mask 默认 0x89 —— **参考诊断仪 真机序列 GAG 里是 `19 02 89` / `19 02 AD`，没有 `19 02 08`**
  //    （2026-10-18 R3 复核）。此前按 REA 的 protocol_native 改成 0x08，反而偏离 参考诊断仪 实例；
  //    0x08 不是错值，但默认必须跟 参考诊断仪 真车证据走。
  // 按族单发（换族回退已删）：KWP 族 → 18 族，UDS 族 → 19 族。
  const kwpFamily = this.lastReadSid === 0x1A || this.lastReadSid === 0x21;
  if (kwpFamily) {
    const r = await this.uds('18004000', timeoutMs, { allowEmpty: true });
    return { ...r, dtcProtocol: 'kwp' };
  }
  const r = await this.uds(`19${subFunc.toString(16).padStart(2, '0')}${mask.toString(16).padStart(2, '0')}`, timeoutMs);
  return { ...r, dtcProtocol: 'uds' };
}

/** 清故障码 `14 <group>` 实测 14 FF FF / 14 00 00 */
async function clearDtc(group = 0xFF00, timeoutMs = 15000) {
  // ⚠️ 2026-10-18 R3：参考诊断仪 真机 GAG 的清码请求是 `14 FF 00` / `14 40 00` / `14 00 00`…
  //    **没有 `14 FF FF`**；默认改成 参考诊断仪 实测的 `14 FF 00`。
  //    同时修掉旧实现把 group 拼两遍（只有 0xFF 恰好拼对）的问题：现在就是 2 字节组号。
  if (!Number.isFinite(group) || group < 0 || group > 0xffff) {
    throw new CodingError(`清码组号 0x${Number(group).toString(16)} 超出 2 字节`);
  }
  // 兼容旧调用 `clearDtc(0xFF)`：按 参考诊断仪 的 `FF 00` 解释，而不是发成 `00 FF`。
  const gval = group === 0xFF ? 0xFF00 : group;
  const g = gval.toString(16).toUpperCase().padStart(4, '0');
  const r = await this.uds(`14${g}`, timeoutMs);
  if (!r.body.length || r.body[0] !== 0x54) {
    throw new CodingError(
      `清码 14 ${g} 响应异常：期望 54，` +
      `实得 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
  }
  return r;
}

/**
 * 安全访问 —— level 和 key 长度按 ECU 配（实测多种）。
 *   27 09 + 2B key   （DME 类，我们默认）
 *   27 04 + 4B key
 *   27 02 + 2B key
 *   27 0A + 4B key
 *   27 B6 + 1B key
 *   17 xx            （KWP）
 */
async function securityAccessEx({ level = 0x09, keyBytes = null, kwp = false, key = null } = {}) {
  if (!this.seedKeyProvider && key == null) throw new MissingSeedKeyError(this.ecuName);
  await this.address();
  // ⚠️ KWP 的 level 和 UDS 不是一套（GAG 实测只有 17 / 17 00 / 17 40 / 17 00 00 / 17 40 00，
  //    **没有 17 09**）。`securityAccess()` 里早做了这个归一，`securityAccessEx()` 之前漏了 ——
  //    结果 KWP 模块被发 `17 09` → NRC，还白吃一次安全尝试计数（2026-10-18 审计）。
  //    上层调用点统一传 secLevel=0x09，这里按协议族归一，避免每处都记得改。
  const lv = kwp ? (level === 0x09 ? 0x00 : level) : level;
  const lvHex = lv.toString(16).toUpperCase().padStart(2, '0');
  const reqSid = kwp ? '17' : '27';
  // ⚠️ 取 seed 的命令形态（2026-10-18 审计）：
  //    - KWP 实测 `17 00 00`（securityAccess() 早就这么发）；
  //    - UDS level 0x09 实测 `27 09 01 00` 带 2 字节尾参（GAG 3139 条里 2 条 27 全带尾参）。
  //    此前 securityAccessEx 裸发 `27 09`，与 securityAccess 不一致；部分 ECU 会回 NRC 0x13，
  //    而这条又是**实际写入路径**（applyChange → securityAccessEx），所以必须对齐实测形态。
  //    其他 level（0x04/0x02/0xB6…）没有实测尾参证据，保持裸发，不猜。
  const seedTail = kwp ? '00' : (level === 0x09 ? '0100' : '');
  // 取 seed
  const s = await this.uds(`${reqSid}${lvHex}${seedTail}`, 5000, { allowEmpty: true });
  // ⚠️ 校验取 seed 的正响应 SID（57 = KWP / 67 = UDS）。
  //    此前不校验：地址错、模块串线、回显没剔干净时，拿到的「seed」其实是别的报文，
  //    照样拿去算 key 并发出去 —— 白吃一次安全尝试计数，还看不出根因。
  const wantSeedSid = kwp ? 0x57 : 0x67;
  if (s.body.length && s.body[0] !== wantSeedSid) {
    throw new CodingError(
      `取 seed 响应异常：期望 SID 0x${wantSeedSid.toString(16)}，` +
      `实得 ${s.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  const seed = s.body.slice(kwp ? 1 : 2);
  this._say(`  seed = ${seed.map((b) => b.toString(16).padStart(2, '0')).join(' ')}（${seed.length} 字节）`);
  // ⚠️ 空 seed 绝不能当「无需解锁」（2026-10-17 D4 的同类坑，这里之前漏了）：
  //    取 seed 请求本身可能回空（地址错 / 未进对会话 / 超时），而 `.every()` 对空数组返回 true。
  //    静默跳过解锁 → 写入必吃 NRC 0x33/0x35，甚至吃满尝试计数。
  if (!seed.length) {
    throw new CodingError('取 seed 返回空 —— 不能当作「无需解锁」，中止');
  }
  if (seed.every((b) => b === 0)) {
    this._say('  seed 全零 = 无需解锁');
    return true;
  }
  // ★ seed 宽度闸门（2026-11-11 逆取）：原厂 `PORSCHESecurityModel(seedFamily, mode)`
  //   的第一参数是 **seed 族**（0/1/2/3/4/6/8），它决定取 seed 命令与 seed **宽度**
  //   （2/3/4 字节，见 seedkey-pswcalc.js 头表）。
  //   现有算法里 2 字节与 4 字节都有真值校验过的实现，所以不能按宽度一刀切拒绝；
  //   但**未声明支持**的 provider 拿到非常规宽度时要留痕，避免错 key 静默发出。
  //   provider 可声明 `seedWidths:[2,4]` —— 声明后即为硬闸门（不在列表里直接拒发）。
  const seedWidths = this.seedKeyProvider && this.seedKeyProvider.seedWidths;
  if (Array.isArray(seedWidths) && seedWidths.length) {
    if (!seedWidths.includes(seed.length)) {
      throw new CodingError(
        `seed 宽度 ${seed.length} 字节不在该算法已声明支持的宽度 [${seedWidths.join(',')}] 内 ——` +
        `拒绝用错宽度算 key（会吃 NRC 0x35 → 0x36 锁死）。`);
    }
  } else if (![2, 3, 4, 6, 8].includes(seed.length)) {
    throw new CodingError(
      `seed 宽度 ${seed.length} 字节不是原厂 seed 族已知宽度（2/3/4/6/8）—— 拒绝计算。`);
  } else if (seed.length !== 2) {
    this._say(`  ⚠️ seed 宽度 ${seed.length} 字节（原厂 seed 族变体）：`
      + `该 mode 未声明宽度支持，key 正确性无法离线保证`);
  }
  const k = key ?? this.seedKeyProvider.calc(seed, level);
  const kArr = Array.from(k instanceof Uint8Array ? k : k);
  // ⚠️ 空 key 必须区分两种成因（2026-10-18）：
  //    A) `needsKey:false` —— 该 mode 在原厂seed/key 表里**没有 case**（2026-11-12 复核：drivelinks 1072 条里 104 条 mode 0x00；旧注释 342/980 为早期口径作废）。needsKey:false 生产路径不可达，此分支仅在测试/历史数据里出现。
  //       ECU 若仍回非零 seed，说明我们对模块的判断不对，**拒写**，但报错要指向「模块/会话/寻址」，
  //       而不是让人去查算法。
  //    B) 算法真返回空 —— 算法实现有问题，拒写并指向算法。
  //   两者都不能发 `00 00 00 00` 出去：那会吃 NRC 0x35，重试吃满 → 0x36 锁死。
  if (!kArr.length) {
    const noAlgo = this.seedKeyProvider && this.seedKeyProvider.needsKey === false;
    throw new CodingError(noAlgo
      ? `该模块（mode 0x${(this.seedKeyProvider.mode ?? 0).toString(16)}）在原厂seed/key 表里没有对应的算法分支` +
        `（原本不需要密钥），但 ECU 仍返回了非零 seed —— 拒绝猜测 key。` +
        `请先核对：模块选对了吗 / 会话对吗 / 是不是串到了别的 ECU。`
      : '算法返回空 key —— 拒绝发送（会吃 NRC 0x35）');
  }
  let kHex = kArr.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  // ⚠️ **默认不截断**：key 长度由算法自己的 outlen 决定（2 或 4 字节）。
  //    早先写死 `keyBytes=2` 会把 4 字节 key 砍成 2 字节 → 发错 key
  //    → NRC 0x35 → 重试吃满 → **0x36 锁死**（2026-10-18 修）。
  //    确需截断时显式传 keyBytes。
  // ⚠️ keyBytes=0 表示「由算法决定」而不是「截成 0 字节」——
  //    SEC_PROFILES 里 KWP 项就是 0，照字面 slice(0,0) 会发出**空 key**（2026-10-18 审计）。
  if (keyBytes != null && keyBytes > 0) kHex = kHex.slice(0, keyBytes * 2);
  // ⚠️ KWP 的 key 子功能是 0x40（实测 `17 40` / `17 40 00`），不是 lv+1（`17 01`）。
  //    与 securityAccess() 保持一致；UDS 才是 level+1。
  const keySub = kwp ? 0x40 : (lv + 1);
  const kr = await this.uds(`${reqSid}${keySub.toString(16).toUpperCase().padStart(2, '0')}${kHex}`, 6000);
  // 发 key 也要校验正响应 SID（2026-10-18 审计）：地址错/串线时可能拿到别的正响应，
  // 不能仅凭「没抛 NRC」就宣布解锁成功。
  const wantKeySid = kwp ? 0x57 : 0x67;
  if (!kr.body.length || kr.body[0] !== wantKeySid) {
    throw new CodingError(
      `发 key 响应异常：期望 SID 0x${wantKeySid.toString(16)}，` +
      `实得 ${kr.body.map((b) => b.toString(16).padStart(2, '0')).join(' ') || '(空)'}`);
  }
  this._say(`  ✅ 已解锁（key ${kHex.length / 2} 字节）`);
  return true;
}

// 挂到 Coder 原型上
Object.assign(Coder.prototype, {
  routineControl, ioControl, readDtc, clearDtc, securityAccessEx,
});

/**
 * 会话号 → 服务类型（抓包实测编排）：
 *   10 89  → 22/21/3B      读写编码
 *   10 86  → 31 31 31      例程（特殊功能）
 *   10 85  → 2F 2F 2F      IOControl（执行器测试）
 *   10 4F  → 31 31 22      例程
 *   10 81  → 11            ECUReset
 *   10 03  → 3E/22/1A      扩展会话（识别、读）
 */
export const SESSION_FOR_SERVICE = {
  coding: 0x89,     // 读写编码
  routine: 0x40,    // 例程 / 特殊功能 —— ★ 2026-11-06 代码级对齐：.so 执行流实证
  //   31 01 前会话字节分布（data/function-sequences.json 全平台族）：10 40 × 202 主导
  //   （P997/P9x1/P992/Macan/Cayenne/E1/E3/BV/DME 全族一致），10 4F × 48 次之（= routine2）。
  //   此前用 0x86（10 86）是弱证据选择，已纠。
  io: 0x85,         // IOControl / 执行器
  ident: 0x03,      // 识别 / 读
  // 数据流/测量属于「读」，走扩展会话 10 03，不是 10 89。
  // 此前无 measure 键，静默落 0x89（2026-10-16 复查 P13）
  measure: 0x03,    // 数据流 / 测量
  reset: 0x81,      // ECUReset
  // GAG 实测还有 0x4F（31 31 22 场景）/ 0xC0 / 0x00 —— 语义未全明，先给入口
  routine2: 0x4F,   // 例程（另一会话）
};

/** 按服务类型进对会话 */
Coder.prototype.enterSessionFor = async function (kind, opts = {}) {
  // ★ 2026-11-12 逐 ECU 原厂会话：读写类服务按当前 ECU 证据取值；
  //   例程/IO/复位/测量仍按服务专属会话（原厂按服务切会话，不被 ECU 会话覆盖）。
  const oemDriven = (kind === 'coding' || kind === 'ident') && this.oemSession != null;
  const sess = oemDriven ? this.oemSession : (SESSION_FOR_SERVICE[kind] ?? 0x89);
  // 写/恢复路径传 {skipIdent:true}，不重跑识别链；opts 原样透传。
  return this.enterSession(opts.session ?? sess, opts);
};

// ═══════════════════════════════════════════════════════════════
//  写前编排 / 安全配置（历史取证，★ 非运行时分派表）
// ═══════════════════════════════════════════════════════════════

/**
 * ⚠️ 2026-11-12 收口：下面 4 组**不是** 4 个可选的写前模式，而是
 * COMMAND.GAG 连续命令 ID 段的**滑动窗口伪影**（AUDIT-PROTOCOL §12.1 早期已疑）：
 *   - 0x00000005..0x0D 是 9 条连续 `1A <LID>` 记录；从 0x05 起取 6 条就是「B」，
 *     其后紧跟 0x0000000E = `3B` 写帧，于是看起来像「1A ×6 → 3B」。
 *   - 0x0000170B..0x0F 是 5 条连续 `3B <LID>` 写帧；C 的 31/32 序列之后紧接它们，
 *     于是看起来像「30 ×3 → 31 → 32 ×2 → 3B」。
 *   - A 的 18/17、D 的 21 ×6 同理，都是同一段 ID 表的不同窗口。
 *
 * 真正的分派键是**逐条编码记录的 (readSid, writeSid)**：
 *   readSid ∈ {21,22,1A}、writeSid ∈ {3B,2E}，由 data/models/* 记录驱动；
 *   同一个模块内常同时存在多个 SID 对（多数模块是混协议族），因此
 *   「按 ECU 选一个写前模式」在概念上就不成立，包内也不存在这种分派表。
 *
 * `runWritePrologue` 因此保持无调用方；`applyChange` 直接按记录发读写帧、
 * 写入后回读校验、结果由 ECU 裁决 —— 这才是与原厂主写模板一致的做法。
 * 下面 4 组仅保留为历史取证样本，不参与运行时判定。
 */
export const WRITE_PROLOGUES = {
  /** A：读故障码 + KWP 安全访问 */
  kwpSec: [
    '1800FF00', '1802FF00', '17', '1700',
  ],
  /** B：读识别 ×6 */
  ident: ['1A95', '1A92', '1A9B', '1A90', '1A93', '1A84'],
  /** C：写前握手 30→31→32 */
  handshake: ['3025', '3026', '302C', '31B90001', '32B80103', '32B80001'],
  /** D：读 KWP ×6 */
  readKwp: ['21080801', '21081101', '21090701', '21090801', '21091101', '210A0701'],
};

/**
 * 安全访问配置 —— level 与 key 长度成组出现（抓包实测 9 种）：
 *   0x09+2B  0x04+4B  0x02+2B  0x02+4B  0x0A+4B  0xB6+1B  0xFF+1B  0x03+0B  0x01+0B
 * KWP 变体：17 / 17 00 / 17 40 / 17 00 00 / 17 40 00
 */
export const SEC_PROFILES = [
  { name: 'UDS level 0x09', sid: 0x27, level: 0x09, keyBytes: 2 },
  { name: 'UDS level 0x04', sid: 0x27, level: 0x04, keyBytes: 4 },
  { name: 'UDS level 0x02', sid: 0x27, level: 0x02, keyBytes: 2 },
  { name: 'UDS level 0x02 4B', sid: 0x27, level: 0x02, keyBytes: 4 },
  { name: 'UDS level 0x0A', sid: 0x27, level: 0x0A, keyBytes: 4 },
  { name: 'UDS level 0xB6', sid: 0x27, level: 0xB6, keyBytes: 1 },
  { name: 'UDS level 0xFF', sid: 0x27, level: 0xFF, keyBytes: 1 },
  { name: 'KWP 17', sid: 0x17, level: 0x00, keyBytes: 0, kwp: true },
  { name: 'KWP 17 40', sid: 0x17, level: 0x40, keyBytes: 0, kwp: true },
];

/**
 * 按模式跑写前编排。
 * @param {'kwpSec'|'ident'|'handshake'|'readKwp'} mode
 */
Coder.prototype.runWritePrologue = async function (mode = 'ident') {
  const seq = WRITE_PROLOGUES[mode];
  if (!seq) throw new CodingError(`未知写前编排模式 ${mode}`);
  this._say(`  写前编排 [${mode}] ${seq.length} 步`);
  for (const cmd of seq) {
    try {
      await this.uds(cmd, 5000, { allowEmpty: true });
    } catch (e) {
      this._say(`    ⚠️ ${cmd} → ${e.message}`);
    }
  }
};

/**
 * 按安全配置表试解锁（哪个 level 成功就用哪个）。
 * 实测不同 ECU 用不同 level，这里按表逐个试，不猜。
 */
/**
 * ⛔ 已禁用逐级试错。
 *
 * 原实现按 SEC_PROFILES 连试 7 个 level（0x09→0x04→0x02…）。每个错误 level
 * 会计入 ECU 的**安全尝试计数**，试满即 NRC 0x36 锁死 —— 与项目红线
 * 「不猜测、不穷举」直接抵触（2026-10-16 复查 P12）。
 *
 * 现在：只接受**显式指定**的 profile；不传就报错，绝不自己试。
 * 真要恢复试错（例如在台架上对已知 ECU），必须显式传 `allowBrute: true`
 * 并自行承担锁死风险。
 */
Coder.prototype.securityAccessAuto = async function ({ profile = null, kwp = false, allowBrute = false } = {}) {
  if (profile) {
    await this.securityAccessEx(profile);
    return profile;
  }
  if (!allowBrute) {
    throw new CodingError(
      '安全访问需要显式指定 profile（level/keyBytes/kwp）。' +
      '自动试错已禁用：错误 level 会计入 ECU 安全尝试计数，试满即 0x36 锁死。');
  }
  const list = SEC_PROFILES.filter((p) => (kwp ? p.kwp : !p.kwp));
  let tries = 0;
  for (const prof of list) {
    if (++tries > 2) {
      throw new CodingError('安全访问尝试次数已达上限 2 —— 继续试会锁死 ECU，中止');
    }
    try {
      this._say(`  尝试安全访问 ${prof.name} …`);
      await this.securityAccessEx({
        level: prof.level, keyBytes: prof.keyBytes, kwp: prof.kwp,
      });
      this._say(`  ✅ 用 ${prof.name} 解锁`);
      return prof;
    } catch (e) {
      this._say(`    ${prof.name} → ${e.message}`);
    }
  }
  throw new CodingError('所有安全访问配置都失败');
};
