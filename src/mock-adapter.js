/**
 * mock-adapter.js — 模拟适配器 + 模拟车。
 *
 * 用途：
 *   ① 没接头时完整体验所有车型/功能
 *   ② 离线验证读写流程、日志、反馈
 *   ③ 演示给车友看
 *
 * 仿真策略：
 *   - ELM327 AT 命令照常回（ATI 回 vLinker，ATSP/ATSH 回 OK）
 *   - UDS/KWP 请求按 SID 回正响应
 *   - 读编码块返回一份「结构正确」的假数据（按 bitsize 铺开）
 *   - 写入接受并回读一致
 *   - 可注入故障（无应答 / NRC），用来验错误反馈
 */
import { Emitter } from './emitter.js';

export class MockAdapter extends Emitter {
  /**
   * @param {{blocks?:Object<number,Uint8Array>, fail?:Object, latencyMs?:number}} opts
   *   blocks: { lid: Uint8Array }  指定某 LID 返回什么
   *   fail:   { lid: 'empty'|'nrc'|nrcCode }  注入故障
   */
  constructor(opts = {}) {
    super();
    this.blocks = opts.blocks || {};
    this.fail = opts.fail || {};
    this.latencyMs = opts.latencyMs ?? 40;
    this.txLog = [];
    this.at = { echo: false, headers: true, protocol: 6 };
    this.address = { tx: 0x7E0, rx: 0x7E8 };
    this.name = 'vLinker MS (模拟)';
  }

  // ---- PortLike ----
  write(data) {
    const cmd = String(data).replace(/\r/g, '').trim();
    this.txLog.push(cmd);
    setTimeout(() => {
      const out = this.#handle(cmd);
      if (out === null) return;
      // ⚠️ Elm327 按字节收（_feed 拼 Uint8Array），必须发 Uint8Array 不能发字符串
      const s = out + '\r\r>';
      const u8 = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
      this.emit('data', u8);
    }, this.latencyMs);
  }
  close() { }

  // ---- 伪造 ELM327 ----
  #handle(cmd) {
    const up = cmd.toUpperCase();
    if (up.startsWith('AT')) {
      if (up === 'ATZ') return 'ELM327 v2.3';
      if (up === 'ATI') return this.name;
      if (up === 'ATRV') return '12.6V';
      if (up.startsWith('ATSH')) { this.address.tx = parseInt(cmd.slice(4), 16) || 0x7E0; return 'OK'; }
      if (up.startsWith('ATCRA')) { this.address.rx = parseInt(cmd.slice(5), 16) || 0x7E8; return 'OK'; }
      if (up.startsWith('ATSP')) { this.at.protocol = +cmd.slice(4) || 6; return 'OK'; }
      if (up.startsWith('ATDPN')) return 'A6';
      if (up.startsWith('ATDP')) return 'AUTO, ISO 15765-4 (CAN 11/500)';
      return 'OK';
    }
    return this.#uds(cmd);
  }

  // ---- 伪造 UDS/KWP ----
  #uds(hex) {
    const clean = hex.replace(/\s+/g, '').toUpperCase();
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
    if (!bytes.length) return 'NO DATA';
    const sid = bytes[0];

    // 注入故障
    const lidKey = bytes.length > 1 ? bytes[1] : 0;
    const f = this.fail[lidKey];
    if (f === 'empty') return '';                       // 无应答
    if (f === 'nrc') return this.#frame([0x7F, sid, 0x31]);
    if (typeof f === 'number') return this.#frame([0x7F, sid, f]);

    switch (sid) {
      case 0x10:   // SessionControl
        return this.#frame([0x50, bytes[1], 0x00, 0x32, 0x01, 0xF4]);
      case 0x3E:   // TesterPresent
        return this.#frame([0x7E, bytes[1]]);
      case 0x1A:   // ReadECUIdentification
      case 0x21:   // ReadDataByLID
      case 0x22: { // ReadDataByIdentifier
        const id = bytes.slice(1, sid === 0x22 ? 3 : 2);
        const data = this.#readBlock(id, sid);
        return this.#frame([sid + 0x40, ...id, ...data]);
      }
      case 0x3B:   // WriteDataByLID
      case 0x2E: { // WriteDataByIdentifier
        const idLen = sid === 0x2E ? 2 : 1;
        const id = bytes.slice(1, 1 + idLen);
        const data = bytes.slice(1 + idLen);
        this.blocks[id.reduce((a, b) => a * 256 + b, 0)] = Uint8Array.from(data);
        return this.#frame([sid + 0x40, ...id]);
      }
      case 0x27:   // SecurityAccess
        if (bytes[1] % 2 === 1) return this.#frame([0x67, bytes[1], 0x12, 0x34]);   // seed
        return this.#frame([0x67, bytes[1]]);                                       // key ok
      case 0x17:   // SecAccess(KWP)
        return this.#frame([0x57, bytes[1]]);
      case 0x31:   // RoutineControl
        return this.#frame([0x71, bytes[1], bytes[2], bytes[3], 0x00]);
      case 0x2F:   // IOControl
        return this.#frame([0x6F, bytes[1], bytes[2], bytes[3], ...(bytes.slice(4))]);
      case 0x19:   // ReadDTC
        return this.#frame([0x59, bytes[1], 0x08, 0x01, 0x23, 0x45, 0x2F]);
      case 0x18:
        return this.#frame([0x58, bytes[1]]);
      case 0x14:   // ClearDTC
        return this.#frame([0x54]);
      case 0x11:   // ECUReset
        return this.#frame([0x51, bytes[1]]);
      case 0x30:
      case 0x32:
      case 0x33:
        return this.#frame([sid + 0x40, ...(bytes.slice(1, 3))]);
      default:
        return this.#frame([0x7F, sid, 0x11]);   // 服务不支持
    }
  }

  /** 取编码块：优先用注入的，否则造一份结构正确的假数据 */
  #readBlock(id, sid) {
    const key = id.reduce((a, b) => a * 256 + b, 0);
    if (this.blocks[key]) return this.blocks[key];
    // 造 32 字节假块，bit 模式按 lid 分布，看起来像真的
    const n = 32;
    const b = new Uint8Array(n);
    let seed = key * 2654435761 % 251;
    for (let i = 0; i < n; i++) {
      seed = (seed * 31 + 7) & 0xff;
      b[i] = seed;
    }
    this.blocks[key] = b;
    return b;
  }

  /**
   * 打 ISO-TP 帧 —— 字节之间**必须空格分隔**（parseResp 按空白切 token）。
   * 单帧 ≤7 字节；更长走首帧 + 连续帧。
   */
  #frame(payload) {
    const id = this.address.rx.toString(16).padStart(8, '0');
    const b = (v) => (v & 0xff).toString(16).padStart(2, '0');
    const line = (arr) => id + ' ' + arr.map(b).join(' ');
    if (payload.length <= 7) {
      return line([payload.length, ...payload]);
    }
    const lines = [line([0x10 | ((payload.length >> 8) & 0x0f), payload.length & 0xff,
                        ...payload.slice(0, 6)])];
    let idx = 1, p = 6;
    while (p < payload.length) {
      lines.push(line([0x20 | (idx & 0x0f), ...payload.slice(p, p + 7)]));
      p += 7; idx++;
    }
    return lines.join('\r');
  }
}

/** 造一个默认的模拟适配器（可指定故障注入） */
export function makeMock(opts) {
  return new MockAdapter(opts);
}
