/**
 * link-doctor.js — 连接自检（VLinker MS 专用）。
 *
 * 目的：上车前把链路的**每一层**都验一遍，失败时明确指出卡在哪。
 *       不做任何写操作。
 *
 * 分层（任何一层断了都要能报出来）：
 *   L1  EA 配件可见     MfiSerial.list() 有 vLinker
 *   L2  EA 会话打开     MfiSerial.open() 成功
 *   L3  ELM327 活着     ATI 回 ELM327
 *   L4  协议锁定        ATSP6 + 0100/0902 有实质应答
 *   L5  模块可达        KWP 1A9F 对某个地址有响应
 *
 * 2026-10 实测教训（全部在本文件里固化）：
 *   · ATSP0 自动探测必失败 → 用 ATSP6 显式锁定
 *   · ATSH7DF 才是 OBD 功能寻址；ATSH000 发进空气
 *   · rx ≠ tx+8（网关 710/77A）
 *   · 保时捷走 KWP 1A 9F/95/93，不是 UDS 22
 *   · 7F 是负响应(NRC)不算数据；62/5A 才是正响应
 *   · 命令间 120ms 间隔，否则 SEARCHING→STOPPED
 */

import { MfiPort } from './mfi-port.js';
import { Elm327 } from './elm327.js';
import { parseResp } from './coder.js';

// 保时捷 981 已知地址 —— 6 条 proven（431 锚点验证，见 ECU-ADDRESSING-20261019.md §2）
export const KNOWN_ADDRS = [
  { name: 'Gateway 网关', tx: 0x710, rx: 0x77A, note: '实测 710/77A，rx≠tx+8' },
  { name: 'DME 发动机',   tx: 0x7E0, rx: 0x7E8, note: '实测 7E0/7E8' },
  { name: 'PDC 驻车',     tx: 0x7CF, rx: 0x7D7, note: '431 proven' },
  { name: 'PASM 悬架',    tx: 0x7D0, rx: 0x7D8, note: '431 proven' },
  { name: '前端电子',     tx: 0x7D1, rx: 0x7D9, note: '431 proven BCM_vorne' },
  { name: '后端电子',     tx: 0x74F, rx: 0x757, note: '431 proven BCM_hinten' },
];

// 识别探针：KWP + UDS 双栈（431 主力是 UDS 22，GAG 2050 条 vs KWP 1A 只 55 条）
// 判定放宽：正响应 OR 负响应(7F) 都算「模块在」—— 7F=模块活着但不支持该服务
export const KWP_PROBES = [
  { hex: '1A9F', label: 'DSN',         positive: '5A9F' },
  { hex: '1A95', label: '软件版本',     positive: '5A95' },
  { hex: '1A93', label: '硬件版本',     positive: '5A93' },
  { hex: '1A87', label: '零件号',       positive: '5A87' },
];
export const UDS_PROBES = [
  { hex: '22F190', label: 'VIN',       positive: '62F190' },
  { hex: '22F187', label: '零件号',     positive: '62F187' },
  { hex: '22F189', label: '软件版本',   positive: '62F189' },
  { hex: '22F180', label: 'BootSW',    positive: '62F180' },
];

export class LinkDoctor {
  constructor() {
    this.steps = [];
    this.port = null;
    this.elm = null;
    this.onStep = null;
  }

  _ok(id, title, detail) {
    const s = { id, title, ok: true, detail };
    this.steps.push(s);
    if (this.onStep) this.onStep(s);
    return s;
  }
  _fail(id, title, detail, fix) {
    const s = { id, title, ok: false, detail, fix };
    this.steps.push(s);
    if (this.onStep) this.onStep(s);
    return s;
  }

  /** L1 —— EA 配件可见 */
  async checkAccessory() {
    const devices = await MfiPort.list();
    const vlink = devices.find((d) =>
      /vlink/i.test(d.name || '') || /vlink/i.test(d.model || '')) || devices[0];
    if (!vlink) {
      this._fail('L1', 'EA 配件', `发现 ${devices.length} 个配件，无 vLinker`,
        '先到「设置 → 蓝牙」确认 vLinker 显示【已连接】。MFi 链路由 iOS 系统持，App 不能代替。');
      return null;
    }
    this._ok('L1', 'EA 配件',
      `${vlink.name} · SN ${vlink.serial} · 协议 ${JSON.stringify(vlink.protocolStrings)}`);
    return vlink;
  }

  /** L2 —— EA 会话打开 */
  async openSession(device) {
    const proto = (device.protocolStrings || [])[0] || null;
    this.port = new MfiPort({
      connectionId: device.connectionId,
      protocol: proto,
      name: device.name,
    });
    try {
      await this.port.connect();
    } catch (e) {
      this._fail('L2', 'EA 会话', String(e?.message || e),
        'EA 会话开失败：拔插 vLinker → 回设置重连 → 再试。别在 App 里反复点，会形成僵尸会话。');
      return false;
    }
    this.elm = new Elm327(this.port);
    this._ok('L2', 'EA 会话', `已打开，协议串 ${proto}`);
    return true;
  }

  /** L3 —— ELM327 活着 */
  async checkElm() {
    const id = await this.elm.cmd('ATI', 4000);
    if (!/ELM327/i.test(id || '')) {
      this._fail('L3', 'ELM327', `ATI 返回 ${JSON.stringify(id)}`,
        '适配器无响应：确认 vLinker 已上电（点火 ON）、手机没被别的 App 占用蓝牙。');
      return false;
    }
    const volt = await this.elm.cmd('ATRV', 3000);
    this._ok('L3', 'ELM327', `${id} · 电压 ${volt || '?'}`);
    return true;
  }

  /**
   * L4 —— 协议锁定
   * ATSP0 自动探测必失败，必须显式试 ATSP6/7/8/9。
   * 判据：0100/0902 有 41/49 正响应。NO DATA vs CAN ERROR 要分开报。
   */
  async lockProtocol() {
    // ⚠️ P0（2026-10-17 审计）：真机路径从不发 `ATE0` —— elm327.init() 里的完整配方
    //    (`ATE0 ATL0 ATS0 ATH1 ATCAF0 ATSTFF`) 全工程无一处调用，ELM327 上电默认
    //    **ATE1（回显开）**。回显行会被 parseResp 当成 ISO-TP 帧（如 `210A` 被判成 CF），
    //    导致多帧读全灭 / body[0] 不是正响应 SID → 「响应异常」。
    //    实车日志 `>> 1003 << 1003` 里的第二个 1003 就是回显。
    //    此处补发初始化配方；同时 parseResp 里再做一道回显行剔除（双保险）。
    // ✅ 2026-10-18 审计：这里改成调用 `Elm327.prepareLink()` —— 与 `init()` 同一套配方，
    //    包含 ATE0/ATL0/ATS0/ATAL/ATH1/ATCAF0/ATSTFF/ATAT0 + 流控三件套。
    //    此前真机路径只手动发了 ATE0/ATL0/ATS0/ATCAF0/ATH0/ATS1，**ATAL 和流控配方都没发**，
    //    `init()` 却全工程无人调用 —— 多帧读写在真车上缺少必要配置。
    await this.elm.prepareLink();
    await this.elm.cmd('ATH0', 1500);   // 探测阶段用干净格式便于解析
    await this.elm.cmd('ATS1', 1500);
    await this.elm.cmd('ATSH7DF', 1500); // OBD 功能寻址（不是 ATSH000！）
    await this.elm.cmd('ATCRA000', 1500);

    // ⚠️⚠️ 2026-10-17 真车实测修的两个 bug（参考诊断仪 能连、我们连不上）：
    //   ① 探测用 `0100`（OBD-II PID）问 0x7DF 广播 —— 保时捷走 **KWP `1A 9F`**，
    //      即使总线通了 0100 也只会 NO DATA，判据对保时捷无效。
    //   ② 试完 6/7/8/9 全失败后**没有把协议设回去**，停在 ATSP9（11bit/250k）。
    //      保时捷是 500k，之后 enterSession 寻址 0x7E0 用错波特率 → 全是 CAN ERROR。
    //      日志里「L4 是 NO DATA、后面全是 CAN ERROR」就是这么来的。
    //   改法：用 KWP 1A9F @ DME 0x7E0 探测；结束时**无条件恢复 ATSP6**。
    const PROTOS = [
      [6, '11bit/500k'], [7, '29bit/500k'], [8, '11bit/250k'], [9, '29bit/250k'],
    ];
    const tries = [];
    let locked = null;
    for (const [p, desc] of PROTOS) {
      await this.elm.cmd(`ATSP${p}`, 2500);
      // 保时捷用 KWP 读标识（HANDOFF 实证：1A 9F/95/93/87），不是 OBD-II 0100
      await this.elm.cmd('ATSH7E0', 1500);
      await this.elm.cmd('ATCRA7E8', 1500);
      const r = (await this.elm.cmd('1A9F', 8000) || '').trim();
      // KWP 正响应 `5A`；UDS 正响应 `62`/`49`；负响应 `7F` 也算协议通（ECU 活着）
      const hit = /\b5A\b/i.test(r) || /\b62\b/i.test(r) || /\b49\b/i.test(r) || /\b7F\b/i.test(r);
      tries.push(`ATSP${p}(${desc})→${r.slice(0, 24) || '空'}`);
      if (hit) { locked = p; break; }
    }
    // ⚠️ 无论成败，**必须**把协议固定下来 —— 绝不能停在试到一半的波特率上。
    await this.elm.cmd(`ATSP${locked ?? 6}`, 2500);
    await this.elm.cmd('ATH1', 1500);   // 恢复 CAN 头给模块扫描用
    await this.elm.cmd('ATS0', 1500);

    if (locked) {
      const desc = PROTOS.find(([p]) => p === locked)[1];
      this._ok('L4', '协议锁定', `ATSP${locked}（CAN ${desc}）已锁定 · KWP 1A9F 有应答`);
      return `ATSP${locked}`;
    }
    // 诊断：NO DATA = 协议对但无 ECU；CAN ERROR = 波特率错
    const allNodata = tries.every((t) => /NO DATA/i.test(t));
    this._fail('L4', '协议锁定', tries.join('  '),
      allNodata
        ? '全部 NO DATA：波特率可能对但无 ECU 应答。检查点火 ON、电压 >12.4V、OBD 口 CAN 线是否接上。'
        : '出现 CAN ERROR：波特率不对。已强制回 ATSP6（11bit/500k）。请重试连接。');
    return null;
  }

  /** L5 —— 模块可达（KWP 1A9F 读 DSN） */
  async probeModules() {
    const found = [];
    const allProbes = [...KWP_PROBES, ...UDS_PROBES];
    for (const a of KNOWN_ADDRS) {
      try {
        await this.elm.cmd(`ATSH${a.tx.toString(16).toUpperCase()}`, 2500);
        await this.elm.cmd(`ATCRA${a.rx.toString(16).toUpperCase()}`, 2500);
      } catch (e) { continue; }
      const row = { ...a, idents: {}, alive: false };
      for (const pr of allProbes) {
        let r = '';
        try { r = (await this.elm.cmd(pr.hex, 6000) || '').trim(); } catch (e) { continue; }
        // ⚠️ ATS0（无空格）时应答是 `7E8035A9F…` 连写 —— 必须先剥 CAN ID 再判前缀，
        //    否则 startsWith('5A9F') 永远不命中 → 误报「无 KWP 应答」（2026-10-17 实车日志）
        // 用 parseResp 统一剥 CAN ID + ISO-TP PCI（ATS0/ATS1 两种格式都认）
        const p2 = parseResp(r);
        const body = Array.from(p2.body || [])
          .map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
        // 正响应 → 记录识别信息
        if (body.startsWith(pr.positive)) {
          row.idents[pr.label] = body.slice(0, 48);
          row.alive = true;
        }
        // ⚠️ 负响应 7F 也算「模块在」（2026-10-22 对齐 431）：
        //    7F <SID> <NRC> = 模块活着但不支持该服务（如 Gateway 不支持 KWP 1A），
        //    此前只认正响应导致 Gateway/PDC/PASM 等全误报「无应答」。
        if (p2.kind === 'nrc' || body.startsWith('7F')) {
          row.alive = true;
        }
        // parseResp 的 kind 非 empty 也说明有字节回来
        if (p2.kind === 'ok' && body.length) {
          row.alive = true;
        }
      }
      const n = Object.keys(row.idents).length;
      if (n) {
        found.push(row);
        this._ok('L5', `模块 ${a.name}`,
          `${a.tx.toString(16).toUpperCase()}/${a.rx.toString(16).toUpperCase()} → ` +
          Object.entries(row.idents).map(([k, v]) => `${k}=${v}`).join('  '));
      } else if (row.alive) {
        // 模块活着但没采到识别信息（全 NRC）—— 不算失败
        found.push(row);
        this._ok('L5', `模块 ${a.name}`,
          `${a.tx.toString(16).toUpperCase()}/${a.rx.toString(16).toUpperCase()} → 有应答（NRC），无识别数据`);
      } else {
        this._fail('L5', `模块 ${a.name}`, '无应答',
          '该模块不在诊断 CAN 上（五条主 CAN 在网关后面），或地址需调整。');
      }
    }
    return found;
  }

  /**
   * 全流程 —— 只做 L1-L4（验链路）。
   * ⚠️ L5 模块探测不再跑在自检里（2026-10-22）：
   *   ① 自检拖太长（扫 6 个模块 × 8 个探针）
   *   ② coder 要等 L5 完才赋值 → 自检中点自动搜索必报「未连接」
   *   ③ 模块触达移到 enterSystem（地址查表 + 自动探测），按需才做
   */
  async run() {
    this.steps = [];
    const dev = await this.checkAccessory();
    if (!dev) return this.result();
    if (!(await this.openSession(dev))) return this.result();
    if (!(await this.checkElm())) return this.result();
    if (!(await this.lockProtocol())) return this.result();
    return this.result();
  }

  result() {
    return {
      ok: this.steps.filter((s) => s.ok).length,
      fail: this.steps.filter((s) => !s.ok).length,
      steps: this.steps,
      port: this.port,
      elm: this.elm,
    };
  }

  async close() {
    if (this.port) await this.port.close();
  }
}

/**
 * ECU 物理地址扫描 —— 逐个试 0x7XX，看哪个有应答。
 * 比查表猜靠谱：车上有哪些 ECU、地址是多少，实测说了算。
 *
 * @param {Elm327} elm
 * @param {(msg:string)=>void} onLog
 * @returns {Promise<Array<{tx:number,rx:number,sid:string,raw:string}>>}
 */
export async function scanEcuAddresses(elm, onLog = () => {}) {
  const found = [];
  // 保时捷 981 常见请求 ID 段；应答多为 +8，网关例外
  // ⚠️ 扫描结果要**持久化回填 ECU_ADDR**（2026-10-17 审计 A2）：此前只 toast，
  //    扫到也进不了模块，每次都要手改源码 —— 「上车即用」断在这里。
  const RX_OFFS = [0x08, 0x6A];   // 0x00 = rx===tx，parseAddrPair 明确拒绝，不能扫
  for (let tx = 0x700; tx <= 0x7F0; tx += 1) {
    // 全 0x700–0x7F0 覆盖：PDC=7CF、后 BCM=74F 的低 4 位是 F，
    // 旧步进 0/1/2 永远扫不到它们。
    for (const off of RX_OFFS) {
      const rx = tx + off;
      // 11-bit CAN 应答 ID 不能超过 0x7FF（0x7F0 + 0x6A 会溢出）。
      if (rx > 0x7ff) continue;
      // ⚠️ 三处实车问题（2026-10-17 真车日志）：
      //   ① 800ms 太短 —— 真车 ATSH 就超时，扫描一开头就中断
      //   ② 单次超时会让整个扫描抛错退出 —— 无应答是常态，必须吞掉继续
      //   ③ /\b5A\b/i 检测应答在 ATS0（无空格）下永远不命中 ——
      //      应答是 `7E8035A9F…` 连写，5A 没有词边界
      try {
        await elm.cmd(`ATSH${tx.toString(16).toUpperCase()}`, 2500);
        await elm.cmd(`ATCRA${rx.toString(16).toUpperCase()}`, 2500);
      } catch (e) { continue; }
      let r = '';
      try { r = (await elm.cmd('1A9F', 3000) || '').trim(); } catch (e) { continue; }
      if (!r) continue;
      // 用 parseResp 统一剥 CAN ID + ISO-TP PCI（ATS0/ATS1 都认，见审计 A2）
      const pr = parseResp(r);
      const body = Array.from(pr.body || []).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
      if (body.startsWith('5A') && !/NO DATA|ERROR|STOPPED|UNABLE/i.test(r)) {
        // 同一 tx 可能被多个 rx 偏移命中（测试/网关回显）；只保留第一条。
        if (!found.some((x) => x.tx === tx)) {
          found.push({ tx, rx, sid: '1A9F', raw: r.slice(0, 60) });
          onLog(`  ✅ 0x${tx.toString(16).toUpperCase()}/0x${rx.toString(16).toUpperCase()} → ${body.slice(0, 32)}`);
        }
      }
    }
    if ((tx & 0x0F) === 0) onLog(`  … 扫到 0x${tx.toString(16).toUpperCase()}，已发现 ${found.length} 个`);
  }
  return found;
}
