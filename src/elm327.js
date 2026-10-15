/**
 * elm327.js — ELM327 v2.3 AT 命令层（vLinker MS）。
 *
 * 与 Mac 版 porsche-mapper/elm_link.py 逻辑对齐，便于结果对照。
 * 传输靠 PortLike：write(bytes|string) + on('data')。
 *
 * 实测（vLinker MS）：ELM327 v2.3，应答带命令回显，直到 '>' 提示符结束。
 */

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
    // （与 alfaproxi/src/elm327.js 同款；那边 readProxiAll 并发读曾差点把垃圾写进 ECU）
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
  async cmd(at, timeoutMs = this.timeoutMs) {
    const run = this.reqChain.then(() => this._cmdLocked(at, timeoutMs));
    this.reqChain = run.then(() => {}, () => {});
    return run;
  }

  async _cmdLocked(at, timeoutMs) {
    await this.port.write(at + '\r');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = new TextDecoder('latin1').decode(this.buf);
      if (s.includes('>')) {
        const out = this._drain();
        this.log.push([at, out]);
        // 命令间隔：SEARCHING... 期间连发会打断成 STOPPED（2026-10-01 实测）
        await new Promise((r) => setTimeout(r, 120));
        return out.replace(/\s*>$/, '').replace(/\r/g, '').trim();
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    // ⚠️ 超时不能把半包当成功返回 —— 多帧应答被截断时上层会拿到短块，
    //    算完 after 再写回 ECU 就是把截断块写进车里（2026-10-16 复查 P2）。
    const out = this._drain();
    this.log.push([at, out]);
    await new Promise((r) => setTimeout(r, 120));
    const trimmed = out.replace(/\s*>$/, '').replace(/\r/g, '').trim();
    throw new Elm327Error(
      `命令超时（${timeoutMs}ms）：${at}${trimmed ? '，已收半包 ' + trimmed.slice(0, 40) : '，无应答'}`,
      trimmed ? 'TIMEOUT_PARTIAL' : 'NO_DATA');
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
   *     parseResp 的 ISO-TP 重组假定应答**带 PCI 字节**，因此必须 `ATCAF0`（原始）。
   *     流控走适配器内建（ATCFC1 + FC 配方）——手动注入会在收应答窗口触发 STOPPED。
   *
   * @param {number} protocol  ELM327 协议号；保时捷 981/718/991/Macan = 6（11bit/500k）
   */
  async init({ protocol = 6 } = {}) {
    const info = {};
    info.reset = await this.cmd('ATZ', 5000);
    await new Promise((r) => setTimeout(r, 400));
    // 基础链路 + 帧格式。ATCAF0 = 原始帧（带 PCI），parseResp 依赖它
    for (const a of ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATCAF0', 'ATSTFF']) {
      await this.cmd(a, 2000);
    }
    this.echo = false;
    info.id = await this.cmd('ATI');
    info.volt = await this.cmd('ATRV');
    // 显式锁定协议（不要用 ATSP0 自动探测）
    await this.cmd(`ATSP${protocol}`, 2500);
    info.proto = await this.cmd('ATDPN');
    info.desc = await this.cmd('ATDP');
    // 流控配方：适配器内建发 FC（ATCFC1）。FC 头在 setAddress 里按模块地址再设一次。
    await this.cmd('ATCFC1', 1500);
    await this.cmd('ATFCSD 30 00 00 00 00 00 00 00', 1500);
    await this.cmd('ATFCSM0', 1500);
    return info;
  }

  /** 发一帧 UDS/ISO-TP 十六进制，返回去空白的应答文本 */
  async request(hexStr, timeoutMs = 5000) {
    return this.cmd(hexStr, timeoutMs);
  }

  /** 把 ELM 应答文本里的 hex 字节抽出来 */
  static parseHex(text) {
    const clean = text
      .replace(/searching\.*/gi, ' ')
      .replace(/^\s*(AT|ST)[A-Z0-9]*.*$/gim, ' ');
    return (clean.match(/\b[0-9A-Fa-f]{2}\b/g) || []).map((h) => parseInt(h, 16));
  }
}
