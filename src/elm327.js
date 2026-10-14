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

  /** 发一条命令，读到 '>' 或超时 */
  async cmd(at, timeoutMs = this.timeoutMs) {
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
    const out = this._drain();
    this.log.push([at, out]);
    await new Promise((r) => setTimeout(r, 120));
    return out.replace(/\s*>$/, '').replace(/\r/g, '').trim();
  }

  /** 初始化 ELM327 */
  async init({ protocol = 0 } = {}) {
    const info = {};
    info.reset = await this.cmd('ATZ', 5000);
    await new Promise((r) => setTimeout(r, 400));
    for (const a of ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATSTFF', 'ATFC0']) {
      await this.cmd(a, 2000);
    }
    this.echo = false;
    info.id = await this.cmd('ATI');
    info.volt = await this.cmd('ATRV');
    await this.cmd(`ATSP${protocol}`, 2500);   // 0 = 自动
    info.proto = await this.cmd('ATDPN');
    info.desc = await this.cmd('ATDP');
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
