/**
 * elm327.js — ELM327 v2.3 AT 命令层（vLinker MS）。
 *
 * 与 Mac 版 porsche-mapper/elm_link.py 逻辑对齐，便于结果对照。
 * 传输靠 PortLike：write(bytes|string) + on('data')。
 *
 * 实测（vLinker MS）：ELM327 v2.3，应答带命令回显，直到 '>' 提示符结束。
 *
 * ⚠️ 多帧发送（`sendIsoTp`）刻意**不**引用 `comm-timeouts.js`：
 *    `timeoutFor` 的档位是「ECU 请求-应答截止时间」语义（category ①），
 *    适配器层窗口属 category ③，两者不能混用（门禁 `COMM_TIMEOUT_*_STATIC`
 *    的第 ⑦ 条断言就在钉这条）。FC 等待窗口因此**继承调用方传入的 `timeoutMs`**
 *    （即 `coder.uds` 那条请求自己的截止时间），必要时用
 *    `opts.fcWaitMs` / `opts.fcRetryMs` / `opts.cfWindowMs` 覆盖。
 */
import { needsSegmentation, segmentPayload, parseFlowControl } from './isotp-tx.js';

/**
 * 去掉 ELM 提示符噪声，只留数据行。
 *
 * 为什么需要：多帧发送时一次 `_cmdLocked` 的返回里可能出现**两个** prompt ——
 * 先是「这一帧没有业务应答」的空 prompt，随后异步到达的流控帧又带一个 prompt
 * （真车同样如此：FC 是接收方自己上总线的，落在一个命令窗口内）。
 * 若只剥末尾一个 `>`，行首会留下 `\r\r>`，把 `30 00 00` 污染成 `>7e8 30 00 00`。
 *
 * @param {string} text
 * @returns {string} 逐行 trim、去空行、`>` 变空格后的文本
 */
function stripPrompts(text) {
  return String(text == null ? '' : text)
    .replace(/>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

export class Elm327Error extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

export class Elm327 {
  constructor(port, { timeoutMs = 4000 } = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.buf = new Uint8Array(0);
    this.echo = true;
    this.log = [];
    // 请求串行锁：串口半双工，任何并发 cmd 都会串帧
    // （同类真机问题；那边 readProxiAll 并发读曾差点把垃圾写进 ECU）
    this.reqChain = Promise.resolve();
    port.on('data', (bytes) => this._feed(bytes));
  }

  _feed(bytes) {
    const n = new Uint8Array(this.buf.length + bytes.length);
    n.set(this.buf, 0);
    n.set(bytes, this.buf.length);
    this.buf = n;
  }

  _drain() {
    const s = new TextDecoder('latin1').decode(this.buf);
    this.buf = new Uint8Array(0);
    return s;
  }

  /** 发一条命令，读到 '>' 或超时（已串行化，可安全并发调用） */
  async cmd(at, timeoutMs = this.timeoutMs, opts = {}) {
    const run = this.reqChain.then(() => this._cmdLocked(at, timeoutMs, opts));
    this.reqChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 发一条 AT 命令并**要求回执 OK**。
   *
   * ⚠️ 2026-11-10 审计 R4：ATSH/ATCRA 的返回值从来没校验过。
   *    适配器回 `?`（不支持）或空行时，代码照样往下发请求 —— 实际还在上一个地址上，
   *    随后所有「NRC / NO DATA」判定都是对着错地址做的（真车日志里探 0x7F1 回帧头是 7E8
   *    就是这个症状）。绑定类命令必须断言 OK，失败即报错，不许静默。
   */
  async cmdOk(at, timeoutMs = this.timeoutMs, opts = {}) {
    const r = await this.cmd(at, timeoutMs, opts);
    const s = String(r || '').trim();
    if (/\bOK\b/i.test(s)) return r;
    // 明确的"不支持"回执：`?` / ERROR —— 这是唯一能确定"命令没落地"的信号，必须报死。
    if (/^\s*\?|error/i.test(s)) {
      throw new Elm327Error(
        `${at} 被拒绝（回「${s.slice(0, 24)}」）—— 适配器不支持该命令，寻址/协议没落地`,
        'AT_NOT_OK');
    }
    // ★ 2026-11-13 T03-h：绑定类 ATSH/ATCRA 空回执不得静默返回（须阻断）。
    //   绑定成功后才发 UDS 请求，若 ATSH/ATCRA 回了空/回显而非 OK，请求会打在
    //   上一个 ECU 地址上（真车日志探 0x7F1 回帧头 7E8 即此症状）。
    //   生产绑定调用一律传 `requireOk:true`（见 coder.address() / app.probeAddressFor），
    //   空回执直接报死 AT_NOT_OK；裸/旧桩调用（无 cmdOk 或 legacy 包装）保留
    //   「留痕不阻断」以兼容既有扫描路径与对齐基础设施单测的裸适配器用例。
    this.log.push([at, `${s || '(空)'} (非 OK 回执)`]);
    // 「空回执」= 适配器回了提示符但没有任何数据（超时/静默）：这时无法确认
    // ATSH/ATCRA 是否落地，必须阻断。非空但非 OK 的回执（回显/数据）只留痕，
    // 由上层 frameIdsOf 回帧 ID 校验兜底，避免误伤合法的诊断数据应答。
    if (opts.requireOk === true && !s) {
      throw new Elm327Error(
        `${at} 空回执 —— 绑定类命令未落地，禁止继续发帧；`
        + '检查适配器 EA 通道/固件是否支持 ATSH/ATCRA',
        'AT_NOT_OK');
    }
    return r;
  }

  async _cmdLocked(at, timeoutMs, opts = {}) {
    await this.port.write(at + '\r');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = new TextDecoder('latin1').decode(this.buf);
      if (s.includes('>')) {
        const out = this._drain();
        this.log.push([at, out]);
        // 命令间隔：SEARCHING... 期间连发会打断成 STOPPED（2026-10-01 实测）
        // 扫描类调用传 { noDelay: true } 跳过 —— 256 地址 × 120ms 就是 30s 纯等待。
        if (!opts.noDelay) await new Promise((r) => setTimeout(r, 120));
        // ⚠️ 必须保留帧分隔符（2026-10-17 实测）：`.replace(/\r/g,'')` 会把 ISO-TP 的
        //    多帧边界删掉 → FF 末字节粘到下一个 CAN ID 被丢、CF 的 PCI(0x21) 反被当数据。
        //    现归一为 \n，parseResp 按 [\r\n]+ 切帧。
        return out.replace(/\s*>$/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    // ⚠️ 超时不能把半包当成功返回 —— 多帧应答被截断时上层会拿到短块，
    //    算完 after 再写回 ECU 就是把截断块写进车里（2026-10-16 复查 P2）。
    // ★ 2026-11-13 T03-h：超时后**半包必须清空**，否则下一条 cmd 会把残留字节
    //    拼到新应答前面串帧（ISO-TP 多帧半包尤其致命）。_drain() 已清 buf，
    //    这里再显式清空并留痕丢弃字节数，保证任何后续命令都从干净缓冲起读。
    const out = this._drain();
    this.buf = new Uint8Array(0);
    this.partialDiscarded = (this.partialDiscarded || 0) + out.length;
    this.log.push([at, out]);
    if (!opts.noDelay) await new Promise((r) => setTimeout(r, 120));
    // 等间隔期间适配器可能又吐迟到字节 —— 再次清空，杜绝串帧。
    this.buf = new Uint8Array(0);
    const trimmed = out.replace(/\s*>$/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    throw new Elm327Error(
      `命令超时（${timeoutMs}ms）：${at}${trimmed ? '，已收半包 ' + trimmed.slice(0, 40) + '（已丢弃）' : '，无应答'}`,
      trimmed ? 'TIMEOUT_PARTIAL' : 'NO_DATA');
  }

  /**
   * CAN 链路公共配方（ELM 初始化 / 连接自检共用）。
   *
   * ⚠️ 2026-10-18 审计：`init()` 里的 `ATAL/ATSTFF/ATCFC1/ATFCSD/ATFCSM0`
   *    此前**只有 init() 会发**，而真机路径（LinkDoctor）从不调用 init()，
   *    只手动发了 ATE0/ATL0/ATS0/ATCAF0/ATH0/ATS1 —— 也就是说：
   *    - ATAL（长消息）没发；
   *    - 适配器内建流控三件套没配，只有 coder.address() 发了 ATFCSH；
   *    - ATSTFF 也没发。
   *    多帧读/写在真车上因此缺少必要配置。这个函数是真机路径与 init() 的唯一配方源。
   */
  async prepareLink() {
    for (const a of ['ATE0', 'ATL0', 'ATS0', 'ATAL', 'ATH1', 'ATCAF1', 'ATSTFF', 'ATAT0']) {
      await this.cmd(a, 2000);
    }
    // 流控走适配器内建（ATCFC1 + FC 配方）——手动注入会在收应答窗口触发 STOPPED。
    await this.cmd('ATCFC1', 1500);
    await this.cmd('ATFCSD 30 00 00 00 00 00 00 00', 1500);
    await this.cmd('ATFCSM0', 1500);
  }

  /**
   * 初始化 ELM327。
   *
   * ⚠️ 2026-10-15 全量修复（对齐参考诊断仪的协议事实）：
   *   - `ATSP` 默认 **6**（ISO 15765-4 CAN 11bit/500k）。
   *     原默认 `0`（自动探测）**必失败**：`ATDPN` 恒返回 `A0`，见协议笔记与 link-doctor.js L4。
   *   - `ATFC0` 是**臆造命令**（只有 ATCFC0/1 + ATFCSH/ATFCSD/ATFCSM）。
   *     山寨适配器对任何命令都回 OK，会把臆造命令「洗」成看似正常 —— 已删。
   *   - 补 `ATCAF` / `ATCFC` / `ATFCSH`/`ATFCSD`/`ATFCSM`：
   *     ⚠️ 2026-10-22 修：改用 `ATCAF1`（收发都自动加/剥 PCI）。
   *     此前用 ATCAF0 但请求没手动补 PCI —— `1A9F` 裸发被 ECU 当成首帧（长度0xA9F），
   *     回流控帧 `32 00 02`（溢出），L4 判不出正响应 → 协议锁定失败 → 连不上车。
   *     ATCAF1 下 ELM327 自动加 SF PCI，应答剥 PCI 后 SID(≥0x50) 落进 parseResp
   *     的「无 PCI」分支，整帧即载荷 —— 单帧/多帧都正确。
   *     流控走适配器内建（ATCFC1 + FC 配方）——手动注入会在收应答窗口触发 STOPPED。
   *
   * @param {number} protocol  ELM327 协议号；保时捷 981/718/991/Macan = 6（11bit/500k）
   */
  async init({ protocol = 6 } = {}) {
    const info = {};
    info.reset = await this.cmd('ATZ', 5000);
    await new Promise((r) => setTimeout(r, 400));
    await this.prepareLink();
    this.echo = false;
    info.id = await this.cmd('ATI');
    info.volt = await this.cmd('ATRV');
    // 显式锁定协议（不要用 ATSP0 自动探测）
    await this.cmd(`ATSP${protocol}`, 2500);
    info.proto = await this.cmd('ATDPN');
    info.desc = await this.cmd('ATDP');
    // FC 头在 setAddress/address() 里按模块地址再设一次。
    return info;
  }

  /** 发一帧 UDS/ISO-TP 十六进制，返回去空白的应答文本 */
  async request(hexStr, timeoutMs = 5000) {
    return this.cmd(hexStr, timeoutMs);
  }

  /**
   * 发一条业务载荷，**需要时自行做 ISO-TP 分段**（ATCAF0 + 自拼 PCI）。
   *
   * 为什么必须自己做（不是「也可以自己做」）：
   *   vLinker MS 经 EA 通道**不执行 ATCAF1**（`coder.js` 有实车记录：CAF1 下 RX 仍带 PCI），
   *   把加 PCI / 分段委托给适配器固件在这条路上不成立；而原厂自带 COMM 层
   *   （`libCOMM_ABSTRACT_LAYER.so`）本来就是自己拼 PCI 的。要对齐原厂线上字节，只能自己拼。
   *
   * 行为（严格）：
   *   · 载荷 ≤ 7 字节 → **直接走现有 `cmd`**，行为零变化（SF 路径一个字没动）；
   *   · 载荷 ≥ 8 字节 →
   *       1. `ATCAF0`：回执非 OK 立即抛 `ISO_TP_TX_UNSUPPORTED`，**一条业务帧都不发**；
   *       2. 发 FF，等 FC（`parseFlowControl` 逐帧找）；找不到再等一轮，
   *          仍无 → `ISO_TP_TX_FC_TIMEOUT`（**重发 FF 等于重复提交，绝对禁止**）；
   *       3. 按 `blockSize` / `stMinMs` 发 CF；每发完一个 block 必须再等一次 FC；
   *          FC 状态 2（overflow）→ `ISO_TP_TX_OVERFLOW` 并**立即停发**；
   *          FC 状态 1（WAIT）→ 不推进，继续等下一帧 FC；
   *       4. `finally` 里恢复 `ATCAF1`（恢复失败也留痕到 `this.log`），保证后续读路径不受影响。
   *
   * @param {string} payloadHex 业务载荷（可带空格）
   * @param {number} timeoutMs  FC 等待/CF 窗口基准（继承自调用方的请求截止时间）
   * @param {object} opts  `{ fcWaitMs, fcRetryMs, cfWindowMs }` 覆盖上面三个窗口
   * @returns {Promise<string>} 最后一轮 `cmd` 的原始文本（让 `Coder.uds` 的解析层完全不用改）
   */
  async sendIsoTp(payloadHex, timeoutMs = this.timeoutMs, opts = {}) {
    // SF 路径：不加 PCI、不改 caf，原样交给 cmd。
    if (!needsSegmentation(payloadHex)) return this.cmd(payloadHex, timeoutMs, opts);
    // 整段发送必须独占串口（半双工）：用既有 reqChain 串行锁把它锁住。
    const run = this.reqChain.then(() => this._sendIsoTpLocked(payloadHex, timeoutMs, opts));
    this.reqChain = run.then(() => {}, () => {});
    return run;
  }

  /** `sendIsoTp` 的锁定实现（内部只用 `_cmdLocked`，不能再走 `cmd` 以免自锁）。 */
  async _sendIsoTpLocked(payloadHex, timeoutMs, opts = {}) {
    const seg = segmentPayload(payloadHex);
    const base = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
    const fcWaitMs = Number(opts.fcWaitMs) > 0 ? Number(opts.fcWaitMs) : base;
    const fcRetryMs = Number(opts.fcRetryMs) > 0 ? Number(opts.fcRetryMs) : base;
    const cfWindowMs = Number(opts.cfWindowMs) > 0 ? Number(opts.cfWindowMs) : base;
    const atWindowMs = Math.min(fcWaitMs, 2000);

    // ── 1) 交出 PCI 控制权：ATCAF0 必须回 OK ──
    const ack = await this._cmdLocked('ATCAF0', atWindowMs, { noDelay: true });
    if (!/\bOK\b/i.test(String(ack || ''))) {
      throw new Elm327Error(
        `ATCAF0 未被接受（回「${String(ack || '(空)').trim().slice(0, 24)}」）—— `
        + '适配器不肯交出 PCI 控制权时，多帧请求无法自行拼装；拒绝发送（宁可拒发，不发垃圾）',
        'ISO_TP_TX_UNSUPPORTED');
    }

    let restored = false;
    /** 恢复 ATCAF1；失败不抛（`finally` 里抛会盖掉真正的错误），但必须留痕。 */
    const restoreCaf1 = async () => {
      if (restored) return;
      restored = true;
      try {
        const r = await this._cmdLocked('ATCAF1', atWindowMs, { noDelay: true });
        if (!/\bOK\b/i.test(String(r || ''))) {
          this.log.push(['ATCAF1', `${String(r || '(空)').trim()} (恢复非 OK 回执)`]);
        }
      } catch (e) {
        this.log.push(['ATCAF1', `恢复失败：${e.message}`]);
      }
    };

    try {
      // ── 2) FF + 第一个 FC ──
      this.log.push(['TX-SEG', seg.frames[0]]);
      let text = await this._cmdLocked(seg.frames[0], fcWaitMs, { noDelay: true });
      let fc = this._findFlowControl(text);
      if (!fc) {
        // 再等一轮：只等，不重发 FF（重发 = 再提交一次）
        text = await this._readPending(fcRetryMs);
        fc = this._findFlowControl(text);
      }
      if (!fc) {
        throw new Elm327Error(
          `ISO-TP 首帧后未收到流控帧（等 ${fcWaitMs + fcRetryMs}ms）—— `
          + '不重发首帧（重发等于把同一份数据再提交一次）', 'ISO_TP_TX_FC_TIMEOUT');
      }
      this._assertNotOverflow(fc);

      // ── 3) 按 blockSize / stMin 发 CF ──
      let idx = 1;
      while (idx < seg.frames.length) {
        // WAIT（status=1）：不推进，继续等下一帧 FC
        if (fc.status === 1) {
          const t = await this._readPending(fcRetryMs);
          const f2 = this._findFlowControl(t);
          if (!f2) {
            throw new Elm327Error(
              `ECU 回 WAIT 流控后未再给 FC（等 ${fcRetryMs}ms）—— 停发，不硬着头皮发完`,
              'ISO_TP_TX_FC_TIMEOUT');
          }
          this._assertNotOverflow(f2);
          fc = f2;
          continue;
        }
        const blockLen = fc.blockSize === 0
          ? seg.frames.length - idx
          : Math.min(fc.blockSize, seg.frames.length - idx);
        for (let k = 0; k < blockLen; k += 1) {
          const frame = seg.frames[idx];
          idx += 1;
          this.log.push(['TX-SEG', frame]);
          text = await this._cmdLocked(frame, cfWindowMs, { noDelay: true });
          if (fc.stMinMs > 0 && idx < seg.frames.length) {
            await new Promise((r) => setTimeout(r, Math.ceil(fc.stMinMs)));
          }
        }
        if (idx >= seg.frames.length) break;      // 末帧发完 → 不需要再要 FC
        // 一个 block 发完：必须再拿一个 FC 才继续
        let f2 = this._findFlowControl(text);
        if (!f2) f2 = this._findFlowControl(await this._readPending(fcRetryMs));
        if (!f2) {
          throw new Elm327Error(
            `已发 ${idx - 1} 个连续帧后未收到后续流控帧 —— 停发，不硬着头皮发完`,
            'ISO_TP_TX_FC_TIMEOUT');
        }
        this._assertNotOverflow(f2);
        fc = f2;
      }
      return stripPrompts(text);
    } finally {
      await restoreCaf1();
    }
  }

  /** FC 状态 2 = overflow：立即停发，未发出的 CF 一律丢弃。 */
  _assertNotOverflow(fc) {
    if (fc && fc.status === 2) {
      throw new Elm327Error(
        'ECU 回流控溢出（FC status=2 / 0x32）—— 立即停发；'
        + '说明它没准备好接这么多数据，继续发只会把已收的部分也毁掉',
        'ISO_TP_TX_OVERFLOW');
    }
  }

  /** 在一段应答文本里找第一个流控帧（逐行，容忍行首 CAN ID）。 */
  _findFlowControl(text) {
    for (const line of stripPrompts(text).split(/\n+/)) {
      const fc = parseFlowControl(line);
      if (fc) return fc;
    }
    return null;
  }

  /**
   * 只等不发的读（用于「等 ECU 主动送来的 FC」）。
   *
   * ⚠️ 为什么需要一个「不发命令的读」：ISO-TP 的 FC 是接收方**主动**上总线的，
   *    不是对某条请求的应答。此时再发一帧去「催」FC，等于往总线上塞业务帧，
   *    会把 FF/CF 序列打断（真车直接 STOPPED）。
   */
  async _readPending(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = new TextDecoder('latin1').decode(this.buf);
      if (s.includes('>')) {
        const out = this._drain();
        this.log.push(['WAIT-FC', out]);
        return stripPrompts(out);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const out = this._drain();
    this.buf = new Uint8Array(0);
    this.log.push(['WAIT-FC', out || '(超时)']);
    return stripPrompts(out);
  }

  /** 把 ELM 应答文本里的 hex 字节抽出来 */
  static parseHex(text) {
    const clean = text
      .replace(/searching\.*/gi, ' ')
      .replace(/^\s*(AT|ST)[A-Z0-9]*.*$/gim, ' ');
    return (clean.match(/\b[0-9A-Fa-f]{2}\b/g) || []).map((h) => parseInt(h, 16));
  }
}
