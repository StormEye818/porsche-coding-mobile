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

// 保时捷 981 已知地址（实测 + 参考实现 拓扑）
export const KNOWN_ADDRS = [
  { name: 'Gateway 网关', tx: 0x710, rx: 0x77A, note: '实测 710/77A，rx≠tx+8' },
  { name: 'DME 发动机',   tx: 0x7E0, rx: 0x7E8, note: '实测 7E0/7E8' },
];

// KWP-2000 风格识别探针（保时捷实际用的服务，不是 UDS 22）
export const KWP_PROBES = [
  { hex: '1A9F', label: 'DSN',         positive: '5A9F' },
  { hex: '1A95', label: '软件版本',     positive: '5A95' },
  { hex: '1A93', label: '硬件版本',     positive: '5A93' },
  { hex: '1A87', label: '零件号',       positive: '5A87' },
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
    await this.elm.cmd('ATH0', 1500);   // 干净格式便于解析
    await this.elm.cmd('ATS1', 1500);
    await this.elm.cmd('ATSH7DF', 1500); // OBD 功能寻址（不是 ATSH000！）
    await this.elm.cmd('ATCRA000', 1500);

    const tries = [];
    for (const p of [6, 7, 8, 9]) {
      await this.elm.cmd(`ATSP${p}`, 2500);
      const r = (await this.elm.cmd('0100', 8000) || '').trim();
      const hit = /\b41\b/.test(r) || /\b49\b/.test(r);
      tries.push(`ATSP${p}→${r.slice(0, 24) || '空'}`);
      if (hit) {
        await this.elm.cmd('ATH1', 1500);  // 恢复 CAN 头给模块扫描用
        await this.elm.cmd('ATS0', 1500);
        this._ok('L4', '协议锁定', `ATSP${p}（CAN ${p === 6 ? '11bit/500k' : p === 7 ? '29bit/500k' : p === 8 ? '29bit/250k' : '11bit/250k'}）已锁定`);
        return `ATSP${p}`;
      }
    }
    // 诊断：NO DATA = 协议对但无 ECU；CAN ERROR = 波特率错
    const allNodata = tries.every((t) => /NO DATA/i.test(t));
    this._fail('L4', '协议锁定', tries.join('  '),
      allNodata
        ? '全部 NO DATA：协议层通但无 ECU 应答。检查点火 ON、电压 >12.4V、发动机是否真启动。'
        : '出现 CAN ERROR：波特率不对。981 应为 ATSP6（11bit/500k）。');
    return null;
  }

  /** L5 —— 模块可达（KWP 1A9F 读 DSN） */
  async probeModules() {
    const found = [];
    for (const a of KNOWN_ADDRS) {
      await this.elm.cmd(`ATSH${a.tx.toString(16).toUpperCase()}`, 1500);
      await this.elm.cmd(`ATCRA${a.rx.toString(16).toUpperCase()}`, 1500);
      const row = { ...a, idents: {} };
      for (const pr of KWP_PROBES) {
        const r = (await this.elm.cmd(pr.hex, 4500) || '').trim();
        const clean = r.replace(/\s+/g, '');
        if (clean.toUpperCase().startsWith(pr.positive)) {
          row.idents[pr.label] = clean.slice(0, 48);
        }
      }
      const n = Object.keys(row.idents).length;
      if (n) {
        found.push(row);
        this._ok('L5', `模块 ${a.name}`,
          `${a.tx.toString(16).toUpperCase()}/${a.rx.toString(16).toUpperCase()} → ` +
          Object.entries(row.idents).map(([k, v]) => `${k}=${v}`).join('  '));
      } else {
        this._fail('L5', `模块 ${a.name}`, '无 KWP 应答',
          '该模块不在诊断 CAN 上（五条主 CAN 在网关后面），或地址需调整。');
      }
    }
    return found;
  }

  /** 全流程 */
  async run() {
    this.steps = [];
    const dev = await this.checkAccessory();
    if (!dev) return this.result();
    if (!(await this.openSession(dev))) return this.result();
    if (!(await this.checkElm())) return this.result();
    if (!(await this.lockProtocol())) return this.result();
    const mods = await this.probeModules();
    if (!mods.length) {
      this._fail('L6', '总结', '无模块可达', '记录完整日志发回分析，可能是网关路由问题。');
    } else {
      this._ok('L6', '总结', `${mods.length} 个模块可达`);
    }
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
  const RX_OFFS = [0x08, 0x6A, 0x00];
  for (let tx = 0x700; tx <= 0x7F0; tx += 1) {
    // 只试常见的步进，避免扫太久
    if (!((tx & 0x0F) === 0 || (tx & 0x0F) === 1 || (tx & 0x0F) === 2)) continue;
    for (const off of RX_OFFS) {
      const rx = tx + off;
      await elm.cmd(`ATSH${tx.toString(16).toUpperCase()}`, 800);
      await elm.cmd(`ATCRA${rx.toString(16).toUpperCase()}`, 800);
      // 用 1A 9F 探（KWP 识别，多数 ECU 都回）
      const r = (await elm.cmd('1A9F', 1200) || '').trim();
      const ok = /\b5A\b/i.test(r) && !/NO DATA|ERROR|STOPPED/i.test(r);
      if (ok) {
        found.push({ tx, rx, sid: '1A9F', raw: r.slice(0, 60) });
        onLog(`  ✅ 0x${tx.toString(16).toUpperCase()}/0x${rx.toString(16).toUpperCase()} → ${r.slice(0, 40)}`);
      }
    }
    if ((tx & 0x0F) === 0) onLog(`  … 扫到 0x${tx.toString(16).toUpperCase()}，已发现 ${found.length} 个`);
  }
  return found;
}
