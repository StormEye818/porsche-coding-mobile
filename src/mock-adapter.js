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
    // ⚠️ 严格模式钩子（2026-10-18 加）。默认**全关** —— 模拟车保持原来的宽容行为，
    //    免得老流程/演示被卡住。要验真实链路时显式打开，见 tools/walkthrough.mjs。
    //    · seedBytes        0x27 取 seed 时发的字节（默认 12 34）
    //    · keyVerifier      (seedBytes, level) => 期望 key(Uint8Array) | null。
    //                       给了就**逐字节校验**工具发来的 key，不对回 NRC 0x35。
    //    · routinePending   第几次 31 01 才成功（先回 NRC 0x78，验跟随轮询）
    //    · writeVerify      (lid, data) => true/false —— false 就当成「写不进去」，
    //                       用来验「回读不一致 → 恢复备份」这条路径
    this.seedBytes = opts.seedBytes || [0x12, 0x34];
    this.keyVerifier = opts.keyVerifier || null;
    this.routinePending = opts.routinePending || 0;
    this.writeVerify = opts.writeVerify || null;
    this.hooks = opts.hooks || {};
    // 观测用计数器（演练脚本断言）
    this.stats = { keyTries: 0, keyRejects: 0, routineCalls: 0, nrc78: 0, writes: 0, writeRejects: 0 };
    this.lastSeed = null;
    this.txLog = [];
    this.at = { echo: false, headers: true, protocol: 6 };
    this.address = { tx: 0x7E0, rx: 0x7E8 };
    // ★ 2026-10-29：默认按真车行为（ATCAF1：适配器自动加/剥 PCI）。
    //   caf=0 保留旧的「带 PCI」输出，供 parseResp(CAF0) 的回归用。
    this.caf = opts.caf ?? 1;
    // 严格地址拓扑：给了 ecus 就只回应表里的 tx（真车上不存在的地址就是 NO DATA）。
    //   ecus = { 0x7E0: { name:'DME', dsn:'P200', kwp:false }, ... }
    this.strictAddress = !!opts.strictAddress;
    this.ecus = opts.ecus || null;
    this.name = 'vLinker MS (模拟)';
  }

  // ---- PortLike ----
  write(data) {
    const cmd = String(data).replace(/\r/g, '').trim();
    this.txLog.push(cmd);
    setTimeout(() => {
      // ⚠️⚠️ 无论 #handle 返回什么，都**必须**回一个 prompt ——
      //    静默不回会让 elm.cmd 永远等不到 → enterSession 挂死 → 转圈停不下来
      //    （2026-10-17 实测「进模块一直转圈」）。宁可回 NO DATA，也不能不回。
      let out;
      try {
        out = this.#handle(cmd);
      } catch (e) {
        out = 'NO DATA';
      }
      if (out === null || out === undefined) out = 'NO DATA';
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
    // 外部钩子可接管任意请求（返回 undefined = 走下面的默认实现）
    const hooked = this.hooks.uds ? this.hooks.uds(cmd) : undefined;
    if (hooked !== undefined && hooked !== null) return hooked;
    return this.#uds(cmd);
  }

  // ---- 伪造 UDS/KWP ----
  #uds(hex) {
    const clean = hex.replace(/\s+/g, '').toUpperCase();
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
    if (!bytes.length) return 'NO DATA';
    const sid = bytes[0];

    // ── 地址拓扑（真车只有装了的 ECU 才应答）──
    const ecu = this.ecus ? this.ecus[this.address.tx] : null;
    if (this.ecus && this.strictAddress && !ecu) return '';   // 这个 tx 上没有模块
    if (ecu) {
      // 协议族不匹配 → 服务不支持（真车就是这样回 NRC 0x11）
      const kwpSids = [0x21, 0x3B, 0x17, 0x1A];
      const udsSids = [0x22, 0x2E, 0x27, 0x2F, 0x19, 0x18, 0x14];
      if (ecu.kwp === true && udsSids.includes(sid) && sid !== 0x14) {
        return this.#frame([0x7F, sid, 0x11]);
      }
      if (ecu.kwp === false && kwpSids.includes(sid) && sid !== 0x1A) {
        return this.#frame([0x7F, sid, 0x11]);
      }
      // 1A9F 回该模块自己的 DSN（用于身份验证/探测归属）
      if (sid === 0x1A && bytes[1] === 0x9F && ecu.dsn) {
        const asc = [...ecu.dsn].map((c) => c.charCodeAt(0) & 0xff);
        return this.#frame([0x5A, 0x9F, ...asc]);
      }
    }

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
      case 0x1A: { // ReadECUIdentification —— 真实应答是 **ASCII 字符串**（零件号/版本号），
        // 不是随机二进制。此前 mock 造 32 字节假块 → 界面全是乱码（2026-10-16 实测）。
        const kid = bytes[1];
        const IDENT = {
          0x9F: '5A9F5750305A5A5A3939314753',   // 5A 9F "WP0ZZZ991GS"
          0x87: '5A873030303030303030303030',   // 5A 87 "000000000000"（序列号）
          0x84: '5A843939313634363030313030',   // 5A 84 "99164600100"（零件号）
          0x91: '5A913030303030303030303030',   // 5A 91 "000000000000"（图号）
          0x92: '5A923939313634363030313030',   // 5A 92 "99164600100"（硬件号）
          0x93: '5A933035',                     // 5A 93 "05"（硬件版本）
          0x94: '5A943939313634363030313030',   // 5A 94 "99164600100"（软件号）
          0x95: '5A9531322E322E31',             // 5A 95 "12.2.1"（软件版本）
          0x96: '5A963030303030303030303030',   // 5A 96 "000000000000"（认证号）
          0x97: '5A97393931',                   // 5A 97 "991"（ECU ISO 码）
          0x9A: '5A9A426F736368',               // 5A 9A "Bosch"（系统供应商）
        };
        const hex = IDENT[kid] || '5A' + kid.toString(16).padStart(2, '0') + '2D2D';  // "--"
        return this.#frame(Array.from({length: hex.length/2}, (_, i) => parseInt(hex.substr(i*2,2),16)));
      }
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
        const key = id.reduce((a, b) => a * 256 + b, 0);
        this.stats.writes++;
        // 严格模式：ECU 可以拒写（验证「写入失败」这条路径，不是「回读不一致」）
        if (this.writeVerify && !this.writeVerify(key, data)) {
          this.stats.writeRejects++;
          return this.#frame([0x7F, sid, 0x72]);   // generalProgrammingFailure
        }
        this.blocks[key] = Uint8Array.from(data);
        return this.#frame([sid + 0x40, ...id]);
      }
      case 0x27:   // SecurityAccess
        if (bytes[1] % 2 === 1) {
          // 取 seed
          this.lastSeed = Uint8Array.from(this.seedBytes);
          return this.#frame([0x67, bytes[1], ...this.seedBytes]);
        }
        // 发 key —— 严格模式（keyVerifier）下**逐字节校验**，不对回 NRC 0x35
        if (this.keyVerifier) {
          this.stats.keyTries++;
          const want = this.keyVerifier(this.lastSeed || new Uint8Array(0), bytes[1] - 1);
          const got = bytes.slice(2);
          let same = !!want && want.length === got.length;
          if (same) for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) { same = false; break; }
          if (!same) {
            this.stats.keyRejects++;
            return this.#frame([0x7F, 0x27, 0x35]);   // invalidKey
          }
        }
        return this.#frame([0x67, bytes[1]]);
      case 0x17:   // SecAccess(KWP)
        return this.#frame([0x57, bytes[1]]);
      case 0x31: { // RoutineControl
        this.stats.routineCalls++;
        // 严格模式：前 N 次例程请求回 NRC 0x78（响应待定）。
        //   ⚠️ **不限 subFunc** —— 真实 ECU 的 `31 03`（查结果）同样会 pending，
        //      只让 0x01 挂起会掩盖「跟随轮询里 31 03 自己也要重试」这一点。
        //   （想单独验「stop 不轮询」时，靠 runRoutine 的 subFunc===0x02 短路即可。）
        if (this.routinePending > 0) {
          this.routinePending--;
          this.stats.nrc78++;
          return this.#frame([0x7F, 0x31, 0x78]);
        }
        return this.#frame([0x71, bytes[1], bytes[2], bytes[3], 0x00]);
      }
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
    // VIN（0xF190）造真实值，否则「读 VIN→定车型」链路测不了
    if (key === 0xF190) {
      const vin = 'WP0ZZZ991GS123456';
      return Uint8Array.from([...vin].map((c) => c.charCodeAt(0)));
    }
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
    // 11-bit 用 3 位 CAN ID、29-bit 用 8 位 —— 与真车 ELM 的输出一致
    const id = this.address.rx.toString(16).padStart(this.address.rx > 0x7ff ? 8 : 3, '0');
    const b = (v) => (v & 0xff).toString(16).padStart(2, '0');
    const line = (arr) => id + ' ' + arr.map(b).join(' ');
    // ★ 真车 ATCAF1：适配器已剥离 PCI、自行重组，输出是「每行 ≤7 字节的纯数据」。
    //   这正是 2026-10-29 审计 P0-1 的场景：旧解析器会把数据首字节当 PCI。
    if (this.caf === 1) {
      if (!payload.length) return '';
      const rows = [];
      for (let i = 0; i < payload.length; i += 7) rows.push(line(payload.slice(i, i + 7)));
      return rows.join('\r');
    }
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
