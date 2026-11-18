/**
 * bt-port.js — 安卓/通用蓝牙串口通道（PortLike，与 MfiPort 同契约）。
 *
 * 双通路（vLinker MS 安卓侧 SPP/BLE 无实证 → 两条都留，运行时探测选择）：
 *   spp — 经典蓝牙 SPP（ELM327 v2.3 / vLinker 安卓侧主流）。
 *         依赖第三方插件 @ascentio-it/capacitor-bluetooth-serial@8.0.1（MIT），
 *         本文件只按 registerPlugin('BluetoothSerial') 契约调用、不 import 包体 ——
 *         插件未装/未注册时探测降级，不炸裸错误。
 *   ble — Web Bluetooth（BLE UART 服务 FFE0/FFE1，Android WebView/Chrome 可用；
 *         iOS WKWebView 不开放 Web Bluetooth → 上层给明确人话提示）。
 *
 * 契约（PortLike）：write(bytes|string) + on('data', cb) + on('closed', cb)
 * 发现→配对/连接→串口读写全链在本文件；自检 L1/L2 只经 discover()/connect() 进来。
 *
 * 测试缝：BtPort._setPluginForTest(spy)（验「插件零触达」）、
 *          new BtPort({ engine: fakeEngine })（BT 通道 mock 回归）。
 */
import { registerPlugin } from '@capacitor/core';
import { PortError, detectPlatform } from './port-channel.js';

// BLE UART（ELM327 BLE 克隆主流：Nordic UART 同款 FFE0/FFE1）
const BLE_SERVICE = 'ffe0';
const BLE_CHAR = 'ffe1';

let _pluginOverride = null;
let _pluginCache = null;

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data;
}
function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function bytesToLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/** BluetoothSerial 插件句柄（懒注册；未注册时调用会得到可读 PortError） */
function sppPlugin() {
  if (_pluginOverride) return _pluginOverride;
  if (!_pluginCache) _pluginCache = registerPlugin('BluetoothSerial');
  return _pluginCache;
}

function wrapPluginError(e, what) {
  const msg = String(e?.message || e);
  if (/not implemented/i.test(msg)) {
    return new PortError(
      `蓝牙串口插件不可用（${what}）`,
      '此接头需安卓蓝牙 SPP 通道：请用完整构建安装（含蓝牙插件），或改用 BLE 接头重试。',
      'BT_PLUGIN_MISSING');
  }
  return new PortError(`${what}失败：${msg}`, '确认系统蓝牙已开、接头已配对且没被别的 App 占用。', 'BT_SPP');
}

// ── 引擎：spp（经典蓝牙串口插件） ──
function makeSppEngine({ address, name }, { onData, onClosed }) {
  let readHandle = null;
  return {
    kind: 'spp',
    address,
    name,
    async connect() {
      const p = sppPlugin();
      try {
        await p.connect({ address });
      } catch (e) {
        // 有些接头只接受 insecure RFCOMM（配对码 1234/0000 的克隆头）
        try { await p.connectInsecure({ address }); }
        catch (e2) { throw wrapPluginError(e2 || e, '蓝牙 SPP 连接'); }
      }
      try {
        readHandle = await p.addListener('onRead', (r) => {
          if (r && typeof r.value === 'string') onData(latin1ToBytes(r.value));
        });
        await p.startNotifications({ address, delimiter: '\r' });
      } catch (e) {
        throw wrapPluginError(e, '蓝牙 SPP 读通道');
      }
    },
    async write(bytes) {
      try {
        await sppPlugin().write({ address, value: bytesToLatin1(bytes) });
        return bytes.length;
      } catch (e) {
        onClosed();
        throw wrapPluginError(e, '蓝牙 SPP 写入');
      }
    },
    async close() {
      try { await sppPlugin().stopNotifications({ address, delimiter: '\r' }); } catch { /* 已断 */ }
      try { if (readHandle?.remove) await readHandle.remove(); } catch { /* 已移除 */ }
      try { await sppPlugin().disconnect({ address }); } catch { /* 已断 */ }
    },
  };
}

// ── 引擎：ble（Web Bluetooth FFE0/FFE1） ──
function makeBleEngine(device, { onData, onClosed }) {
  let chr = null;
  let server = null;
  const onDisconnected = () => onClosed();
  return {
    kind: 'ble',
    address: device.id || device.address,
    name: device.name || 'BLE 设备',
    async connect() {
      const ble = globalThis.navigator?.bluetooth;
      if (!ble) {
        throw new PortError(
          'BLE 通道不可用（WebView 未开放 Web Bluetooth）',
          detectPlatform() === 'ios'
            ? '此接头是非 MFi 设备，iOS 未开放 Web Bluetooth：请改用 MFi 版接头（vLinker 系列）或在安卓端使用。'
            : '此接头需 BLE 通道：请用系统 WebView 内核的完整构建，或换经典蓝牙（SPP）接头。',
          'BT_BLE_UNAVAILABLE');
      }
      try {
        server = await device.gatt.connect();
      } catch (e) {
        throw new PortError(`BLE 连接失败：${String(e?.message || e)}`,
          '靠近接头、确认电量/点火 ON 后重试；不行就取消配对后重新配对。', 'BT_BLE');
      }
      device.addEventListener?.('gattserverdisconnected', onDisconnected);
      try {
        const svc = await server.getPrimaryService(BLE_SERVICE);
        chr = await svc.getCharacteristic(BLE_CHAR);
      } catch {
        // 兼容变体克隆：扫全部特征，选一个可写+可通知的
        for (const svc of (await server.getServices().catch(() => []))) {
          for (const c of (await svc.getCharacteristics().catch(() => []))) {
            const pr = c.properties || {};
            if ((pr.write || pr.writeWithoutResponse) && pr.notify) { chr = c; break; }
          }
          if (chr) break;
        }
      }
      if (!chr) {
        throw new PortError('BLE 设备没有串口特征（FFE0/FFE1）',
          '此接头可能不是 BLE 串口型：请换通用 ELM327（BLE）或 vLinker 系列接头。', 'BT_BLE');
      }
      try {
        await chr.startNotifications();
        chr.addEventListener('characteristicvaluechanged', (e) => {
          const v = e.target?.value;
          if (v) onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        });
      } catch (e) {
        throw new PortError(`BLE 通知开启失败：${String(e?.message || e)}`,
          '重试一次；仍失败则此接头的 BLE 固件不支持串口透传。', 'BT_BLE');
      }
    },
    async write(bytes) {
      try {
        if (chr.writeValueWithoutResponse) await chr.writeValueWithoutResponse(bytes);
        else if (chr.writeValueWithResponse) await chr.writeValueWithResponse(bytes);
        else await chr.writeValue(bytes);
        return bytes.length;
      } catch (e) {
        onClosed();
        throw new PortError(`BLE 写入失败：${String(e?.message || e)}`,
          '连接可能已断开：回首页重新「连接自检」。', 'BT_BLE');
      }
    },
    async close() {
      try { await chr?.stopNotifications(); } catch { /* 已断 */ }
      try { device.removeEventListener?.('gattserverdisconnected', onDisconnected); } catch { /* 无 */ }
      try { device.gatt?.disconnect(); } catch { /* 已断 */ }
    },
  };
}

function bleAvailable() {
  return typeof globalThis.navigator !== 'undefined' && !!globalThis.navigator.bluetooth;
}

async function sppAvailable() {
  try {
    await sppPlugin().isEnabled();
    return true;
  } catch (e) {
    return !/not implemented/i.test(String(e?.message || e));
  }
}

export class BtPort {
  /**
   * opts: { engine?: 'auto'|'spp'|'ble'|fakeEngineObject, device: {name,address,id}, platform? }
   */
  constructor(opts = {}) {
    this.opts = opts;
    this._dataCbs = [];
    this._closeCbs = [];
    this._closedFired = false;
    this._engine = null;
    this.engineKind = null;
  }

  on(evt, cb) {
    if (evt === 'data') this._dataCbs.push(cb);
    else if (evt === 'closed') this._closeCbs.push(cb);
    return this;
  }

  _emitData(bytes) { for (const cb of this._dataCbs) cb(bytes); }
  _emitClosed() {
    if (this._closedFired) return;
    this._closedFired = true;
    for (const cb of this._closeCbs) cb();
  }

  /**
   * 发现设备（自检 L1）。
   * engine='auto'：安卓优先 SPP、BLE 兜底；iOS/web 只走 BLE（SPP 插件是安卓专用）。
   * @returns {Promise<{engine:'spp'|'ble', devices:Array<{name,address,engine,raw}>}>}
   */
  static async discover({ engine = 'auto', platform = detectPlatform() } = {}) {
    const order = engine === 'auto'
      ? (platform === 'android' ? ['spp', 'ble'] : ['ble'])
      : [engine];
    let lastErr = null;
    for (const kind of order) {
      try {
        if (kind === 'spp') {
          if (!(await sppAvailable())) {
            lastErr = new PortError('蓝牙串口插件不可用', '', 'BT_PLUGIN_MISSING');
            continue;
          }
          const r = await sppPlugin().scan();
          const devices = (r?.devices || []).map((d) => ({
            name: d.name || d.address, address: d.address, engine: 'spp', raw: d,
          }));
          return { engine: 'spp', devices };
        }
        if (!bleAvailable()) {
          lastErr = new PortError('BLE 通道不可用', '', 'BT_BLE_UNAVAILABLE');
          continue;
        }
        // Web Bluetooth：系统选择器（用户手势内发起，自检按钮满足）
        const dev = await globalThis.navigator.bluetooth.requestDevice({
          acceptAllDevices: true, optionalServices: [BLE_SERVICE],
        });
        return {
          engine: 'ble',
          devices: [{ name: dev.name || dev.id, address: dev.id, engine: 'ble', raw: dev }],
        };
      } catch (e) {
        lastErr = e;
        if (e?.name === 'NotFoundError') {
          // 用户关掉了选择器
          throw new PortError('未选择蓝牙设备', '重新点「连接自检」并在系统弹窗里选中接头。', 'BT_CANCELLED');
        }
      }
    }
    throw (() => {
      const e = lastErr instanceof PortError
        ? lastErr
        : new PortError(`蓝牙发现失败：${String(lastErr?.message || lastErr)}`, '', 'BT_DISCOVER');
      if (!e.fix) {
        e.fix = detectPlatform() === 'ios'
          ? '此接头需 BLE 通道：iOS 请改用 MFi 版接头（vLinker 系列）或在安卓端使用。'
          : '请打开系统蓝牙、配对接头后重试；接头需 SPP 或 BLE 串口通道。';
      }
      return e;
    })();
  }

  async connect() {
    const device = this.opts.device || {};
    const kind = this.opts.engine && typeof this.opts.engine === 'object'
      ? 'fake'
      : (this.opts.engine && this.opts.engine !== 'auto' ? this.opts.engine
        : (device.engine || (this.opts.platform === 'android' ? 'spp' : 'ble')));
    const hooks = { onData: (b) => this._emitData(b), onClosed: () => this._emitClosed() };
    if (kind === 'fake') this._engine = this.opts.engine;
    else if (kind === 'spp') this._engine = makeSppEngine(device, hooks);
    else this._engine = makeBleEngine(device.raw || device, hooks);
    this.engineKind = this._engine.kind;
    await this._engine.connect();
    return this;
  }

  /** PortLike: write(string|Uint8Array) */
  write(data) {
    return this._engine.write(toBytes(data));
  }

  async close() {
    this._dataCbs = [];
    this._closeCbs = [];
    if (this._engine) await this._engine.close();
  }

  /** 测试缝：注入插件替身（验「安卓零触达 / 插件缺失降级」） */
  static _setPluginForTest(p) { _pluginOverride = p; _pluginCache = null; }
}
