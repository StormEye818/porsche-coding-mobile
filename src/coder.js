/**
 * coder.js — 编码执行引擎。
 *
 * 流程（全部可审查、可回滚）：
 *   1. 备份原值      readBlock(lid, readSid) → 持久化
 *   2. 建会话        10 89（保时捷专用，不是 10 03）
 *   3. 安全访问      27 09 拿 seed → SeedKeyProvider 算 key → 27 0A
 *                    （协议抓包 实测：01 04 27 09 01 00，level=0x09）
 *   4. 写入          <writeSid> <lid> <payload>   ← SID 与读成对，不写死
 *   5. 回读          <readSid>  <lid>  → 比对
 *   6. 恢复（失败时）写回备份
 *
 * ⚠️ 读写 SID 必须成对（请求模板 + 协议抓包 实测）：
 *      0x21 ↔ 0x3B   KWP  ReadDataByLID / WriteDataByLID
 *      0x22 ↔ 0x2E   UDS  RDBI          / WriteDataByDID
 *      0x1A ↔ 0x3B   KWP  ReadECUIdentification / WriteDataByLID
 *    写 3B 就必须读 21，跨协议混用会 NRC 或读错块。
 *
 * ⚠️ LID 来自参数条目（请求模板 / 参数表），绝不硬编码。
 *    猜 DID 会写坏别的块。
 *
 * ⚠️ seed/key 算法缺失时**拒绝写入**，绝不猜、不试、不穷举。
 *    （参考实现 路线图明确：不猜测密钥或对车穷举）
 *
 * ⚠️ 每次只改一项。多项同时改出问题无法归因。
 *
 * ⚠️ 超时 ≠ 未执行。结果不明时先重连核验，禁止自动重试写入。
 */

import { extractField, injectField, decodeValue, encodeValue, canWrite } from './schema.js';

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
export function parseResp(hexStr) {
  // ELM327 cmd() 已把 \r 去掉、末尾 trim；这里按空白切帧，
  // 兼容「一行多帧」和「多行多帧」两种输出。
  const cleaned = String(hexStr || '')
    .replace(/searching\.*/gi, ' ')
    .replace(/\b(AT|ST|OK|RV)\b/gi, ' ')
    .replace(/[>]/g, ' ');
  const lines = cleaned.split(/[\r\n]+/).filter((l) => l.trim());
  const frames = [];
  for (const ln of lines) {
    // 一行可能含多帧（空格分隔），按 CAN 头 + PCI 启发式切
    const toks = ln.trim().split(/\s+/).filter((x) => /^[0-9A-Fa-f]+$/.test(x));
    if (!toks.length) continue;
    // 首 token 若是 3/8 位 CAN ID 就去掉
    if ((toks[0].length === 3 || toks[0].length === 8) && /^[0-9A-Fa-f]+$/.test(toks[0])) toks.shift();
    const b = toks.filter((x) => x.length === 2).map((x) => parseInt(x, 16));
    if (b.length) frames.push(b);
  }
  if (!frames.length) return { kind: 'empty', body: [] };

  // ISO-TP 重组
  let body = [];
  let expected = 0;
  let sawFirstFrame = false;
  for (const f of frames) {
    const pci = f[0];
    const type = pci & 0xf0;
    if (type === 0x00) {                       // 单帧
      const n = pci & 0x0f;
      if (n > 0 && n <= f.length - 1) {
        body = f.slice(1, 1 + n);
        expected = body.length;
      } else {
        body = body.concat(f.slice(1));
      }
    } else if (type === 0x10) {                // 首帧
      expected = ((pci & 0x0f) << 8) | f[1];
      body = f.slice(2);
      sawFirstFrame = true;
    } else if (type === 0x20) {                // 连续帧
      body = body.concat(f.slice(1));
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

export class Coder {
  /**
   * @param {Elm327} elm   已锁定协议的 ELM327
   * @param {object} opts  { tx, rx, ecuName }
   */
  constructor(elm, { tx, rx, ecuName = 'ECU', verbose = true } = {}) {
    this.elm = elm;
    this.tx = tx;
    this.rx = rx;
    this.ecuName = ecuName;
    this.verbose = verbose;        // ← 打印每条收发，方便 debug
    this.seedKeyProvider = null;   // ← 算法插槽
    this.backups = [];
    this.log = [];
  }

  _say(m) {
    this.log.push(m);
    if (this.onProgress) this.onProgress(m);
  }

  /** 设定物理寻址 */
  async address() {
    await this.elm.cmd(`ATSH${this.tx.toString(16).toUpperCase()}`, 2000);
    await this.elm.cmd(`ATCRA${this.rx.toString(16).toUpperCase()}`, 2000);
    // 流控头随模块地址走：多帧读写时适配器内建 FC 要用**当前模块的请求 ID**。
    // （只在 init 里设一次不够 —— 换模块后 FC 头是上一个模块的）
    await this.elm.cmd(`ATFCSH${this.tx.toString(16).toUpperCase()}`, 1500).catch(() => {});
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
  async enterSession(session = 0x89) {
    await this.address();
    // ① UDS 扩展会话
    await this.uds('1003');
    // ② TesterPresent（有些 ECU 不回，允许空）
    await this.uds('3E00', 2000, { allowEmpty: true }).catch(() => {});
    // ③ 识别 ECU（失败不致命，只记日志）
    try {
      const id = await this.uds('1A9F', 3000, { allowEmpty: true });
      this._say(`  识别 1A 9F → ${id.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    } catch (e) {
      this._say(`  (识别 1A 9F：${e.message})`);
    }
    // ④ 保时捷专用会话
    await this.uds(`10${session.toString(16).toUpperCase().padStart(2, '0')}`);
    this._say(`  ✅ 会话 10 ${session.toString(16)} 就绪`);
    return true;
  }

  /**
   * 切换到某个 ECU 的物理地址。
   * ⚠️ 每个 ECU 的 tx/rx 不同 —— 硬编码一个地址读所有模块是读不到的（实车教训）。
   */
  setAddress(tx, rx, name = '') {
    this.tx = tx;
    this.rx = rx;
    if (name) this.ecuName = name;
    this._say(`  寻址 → ${name || 'ECU'}  tx=0x${tx.toString(16)} rx=0x${rx.toString(16)}`);
  }

  /**
   * 发 UDS/KWP 请求并解析。
   *
   * ⚠️ 空响应必须报错 —— 早先不报，导致「会话就绪」是假成功，
   *    后面读出空块也看不出问题（实车日志教训）。
   *
   * @param {boolean} allowEmpty  允许空响应（如 TesterPresent）
   */
  async uds(payloadHex, timeoutMs = 6000, { allowEmpty = false } = {}) {
    const raw = (await this.elm.cmd(payloadHex, timeoutMs) || '').trim();
    // 调试：原始收发都记下来
    this._trace(`  >> ${payloadHex}`);
    this._trace(`  << ${raw || '(空)'}`);
    const p = parseResp(raw);
    if (p.kind === 'nrc') {
      throw new CodingError(`服务 0x${p.service?.toString(16)} 被拒`, p.code);
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
    await this.address();
    const idBytes = (readSid === 0x22) ? 4 : 2;    // ← 位宽随 SID
    const idHex = id.toString(16).toUpperCase().padStart(idBytes, '0');
    const sid = readSid.toString(16).toUpperCase().padStart(2, '0');
    const r = await this.uds(`${sid}${idHex}`);

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
    const data = r.body.slice(hdrLen);
    if (!data.length) {
      throw new CodingError(`读 0x${idHex} 返回 0 字节数据（响应 ${r.body.length}B）`);
    }
    return data;
  }

  /**
   * 安全访问（0x27 09/0A）
   * @throws MissingSeedKeyError  未配置算法时
   */
  async securityAccess(level = 0x09) {
    if (!this.seedKeyProvider) throw new MissingSeedKeyError(this.ecuName);
    await this.address();
    // 27 09 取 seed（UDS 规则：seed=奇数 level，key=level+1）
    const s = await this.uds(`27${level.toString(16).padStart(2, '0')}`, 5000);
    const seed = s.body.slice(2);
    this._say(`  seed = ${seed.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    if (seed.every((b) => b === 0)) {
      this._say('  seed 全零 = 该 ECU 无需解锁，跳过');
      return true;
    }
    // 插槽算 key
    const key = this.seedKeyProvider.calc(seed, level);
    this._say(`  key  = ${key.map((b) => b.toString(16).padStart(2, '0')).join(' ')}` +
              `（算法 ${this.seedKeyProvider.name}）`);
    // 27 0A 发 key
    const kHex = key.map((b) => b.toString(16).padStart(2, '0')).join('');
    await this.uds(`27${(level + 1).toString(16).padStart(2, '0')}${kHex}`, 6000);
    this._say('  ✅ 已解锁');
    return true;
  }

  /**
   * 执行一次单项编码变更（完整闭环）
   *
   * @param {object} p        参数条目（schema，须含 lid / readSid / writeSid）
   * @param {number} value    目标字段值
   * @param {object} opts     { session=0x89, dryRun=true, secLevel=0x09 }
   */
  async applyChange(p, value, opts = {}) {
    const {
      session = 0x89,        // 保时捷专用会话（参考诊断仪实测 10 89）
      dryRun = true,
      secLevel = 0x09,       // 参考诊断仪实测 SecurityAccess level
    } = opts;

    // ★ LID 来自参数条目，绝不硬编码 —— 猜错 DID 会写坏别的块。
    const lid = p.lid ?? p.did;
    const readSid = p.readSid ?? 0x21;
    const writeSid = p.writeSid ?? 0x3B;
    if (lid == null) {
      throw new CodingError(
        `参数 ${p.name} 缺 LID/DID，拒绝写入。`);
    }
    // 读写 SID 必须是已知成对
    const PAIRS = { 0x21: 0x3B, 0x22: 0x2E, 0x1A: 0x3B };
    if (PAIRS[readSid] !== writeSid) {
      throw new CodingError(
        `读写 SID 不配对：读 0x${readSid.toString(16)} / 写 0x${writeSid.toString(16)}。` +
        `合法对：21↔3B、22↔2E、1A↔3B。`);
    }
    // 只读项（源数据无写服务）明确拒绝
    if (p.sidPairOk === false) {
      throw new CodingError(
        `${p.name} 是只读项（${p.writeBlockedReason || '源数据无写服务'}），禁止写入。`);
    }

    this._say(`\n=== ${p.name} → ${decodeValue(p, value)} ===`);
    this._say(`  位置: byte ${p.byte} bit ${p.bit}（宽 ${p.bitsize}）  风险: ${p.risk}`);
    this._say(`  服务: 读 ${readSid.toString(16)} / 写 ${writeSid.toString(16)}  LID=0x${lid.toString(16)}`);

    // 1. 备份原值
    await this.address();
    const before = await this.readBlock(lid, readSid);
    this.backups.push({
      id: p.id, lid, readSid, writeSid, time: new Date().toISOString(),
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
    if (outOfRange.length) {
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

    // 4. 进会话（参考诊断仪序列：10 03 → 3E → 1A 9F → 10 89）
    this._say(`  进会话 …`);
    await this.enterSession(session);

    // 5. 安全访问（参考诊断仪实测 UDS 用 27 09 / 27 0A）
    //    ⚠️ level 是 0x09，不是 0x01。发错会 NRC 0x12/0x7F，或吃满尝试次数锁死（0x36）
    //    ⚠️ **SID 要跟协议族走**：UDS 用 `27`，KWP 用 `17`。
    //       判据 = 读 SID：`22`→UDS、`21`/`1A`→KWP（55 条 21↔3B 项是 KWP 设备）。
    //       此前写死 27，KWP 项会 NRC 或吃满尝试计数（2026-10-16 复查 P6）。
    const isKwp = (p.readSid ?? 0x22) !== 0x22;
    await this.securityAccessEx({ level: secLevel, kwp: isKwp });

    // 6. 写入（SID 与读成对，不再写死 3B）
    const hex = after.map((b) => b.toString(16).padStart(2, '0')).join('');
    this._say(`  写入 ${writeSid.toString(16).toUpperCase()} 0x${lid.toString(16)} …`);
    // ⚠️ LID 位宽随 SID（抓包实测）：0x3B 用 1 字节 LID，0x2E 用 2 字节 DID
    const lidBytes = (writeSid === 0x2E) ? 4 : 2;
    await this.uds(
      `${writeSid.toString(16).toUpperCase().padStart(2, '0')}` +
      `${lid.toString(16).toUpperCase().padStart(lidBytes, '0')}${hex}`, 8000);

    // 7. 回读校验
    this._say('  回读校验 …');
    const readback = await this.readBlock(lid, readSid);
    const match = readback.length === after.length &&
      readback.every((b, i) => b === after[i]);
    if (!match) {
      this._say('  ❌ 回读不一致，尝试恢复备份');
      await this._restore(this.backups[this.backups.length - 1]);
      throw new CodingError('回读不一致，已尝试恢复原值');
    }
    this._say('  ✅ 回读一致');
    return { dryRun: false, before, after, readback, diffs };
  }

  /** 恢复备份（用备份里记录的 LID/SID，不猜） */
  async _restore(bk) {
    const bytes = bk.raw.match(/.{2}/g).map((h) => parseInt(h, 16));
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    const sid = (bk.writeSid ?? 0x3B).toString(16).toUpperCase().padStart(2, '0');
    const idHex = (bk.lid ?? 0).toString(16).toUpperCase().padStart((bk.writeSid === 0x2E) ? 4 : 2, '0');
    await this.uds(`${sid}${idHex}${hex}`, 8000);
    this._say('  已写回备份值');
  }

  /** 导出备份 */
  exportBackups() {
    return {
      time: new Date().toISOString(),
      ecu: this.ecuName,
      tx: this.tx, rx: this.rx,
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
  const rid = routineId.toString(16).toUpperCase().padStart(4, '0');
  const sf = subFunc.toString(16).toUpperCase().padStart(2, '0');
  return this.uds(`31${sf}${rid}${params}`, timeoutMs);
}

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
  const d = did.toString(16).toUpperCase().padStart(4, '0');
  const co = controlOption.toString(16).toUpperCase().padStart(2, '0');
  return this.uds(`2F${d}${co}${state}`, timeoutMs);
}

/**
 * 读故障码。
 *   UDS `19 <subFunc> <mask>`     实测 19 02 89 / 19 06 00 00 00 FF
 *   KWP `18 <group> <...>`        实测 18 00 40 00 / 18 FF FF 01
 */
async function readDtc(subFunc = 0x02, mask = 0x89, timeoutMs = 10000) {
  return this.uds(`19${subFunc.toString(16).padStart(2, '0')}${mask.toString(16).padStart(2, '0')}`, timeoutMs);
}

/** 清故障码 `14 <group>` 实测 14 FF FF / 14 00 00 */
async function clearDtc(group = 0xFF, timeoutMs = 15000) {
  return this.uds(`14${group.toString(16).padStart(2, '0')}${group.toString(16).padStart(2, '0')}`, timeoutMs);
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
async function securityAccessEx({ level = 0x09, keyBytes = 2, kwp = false, key = null } = {}) {
  if (!this.seedKeyProvider && key == null) throw new MissingSeedKeyError(this.ecuName);
  await this.address();
  const lv = level.toString(16).toUpperCase().padStart(2, '0');
  const reqSid = kwp ? '17' : '27';
  // 取 seed
  const s = await this.uds(`${reqSid}${lv}`, 5000, { allowEmpty: true });
  const seed = s.body.slice(kwp ? 1 : 2);
  this._say(`  seed = ${seed.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  if (seed.every((b) => b === 0)) {
    this._say('  seed 全零 = 无需解锁');
    return true;
  }
  const k = key ?? this.seedKeyProvider.calc(seed, level);
  const kHex = (k instanceof Uint8Array ? Array.from(k) : k)
    .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, keyBytes * 2);
  await this.uds(`${reqSid}${(level + 1).toString(16).toUpperCase().padStart(2, '0')}${kHex}`, 6000);
  this._say('  ✅ 已解锁');
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
  routine: 0x86,    // 例程 / 特殊功能
  io: 0x85,         // IOControl / 执行器
  ident: 0x03,      // 识别 / 读
  // 数据流/测量属于「读」，走扩展会话 10 03，不是 10 89。
  // 此前无 measure 键，静默落 0x89（2026-10-16 复查 P13）
  measure: 0x03,    // 数据流 / 测量
  reset: 0x81,      // ECUReset
};

/** 按服务类型进对会话 */
Coder.prototype.enterSessionFor = async function (kind) {
  const sess = SESSION_FOR_SERVICE[kind] ?? 0x89;
  return this.enterSession(sess);
};

// ═══════════════════════════════════════════════════════════════
//  写前编排 / 安全配置 —— 全部从 COMMAND.GAG 3,139 条实测解出
// ═══════════════════════════════════════════════════════════════

/**
 * 写前编排 —— 4 种完整模式（抓包实测，每种都有完整序列）：
 *
 * A) `18 18 17 17 → 3B`   读故障码 → KWP 安全访问 → 写
 *    18 00 FF 00 / 18 02 FF 00 / 17 / 17 00 → 3B
 *
 * B) `1A ×6 → 3B`          读识别 → 直接写
 *    1A 95 1A 92 1A 9B 1A 90 1A 93 1A 84 → 3B
 *
 * C) `30 ×3 → 31 → 32 ×2 → 3B`   写前握手
 *    30 25 / 30 26 / 30 2C / 31 B9 00 01 / 32 B8 01 03 / 32 B8 00 01 → 3B
 *
 * D) `21 ×6 → 3B`          读 KWP → 写
 *    21 08 08 01 … 21 0A 07 01 → 3B
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
