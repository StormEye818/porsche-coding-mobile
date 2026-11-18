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
 * ⚠️ 发现=**已配对列表**（2026-11-18 安卓平板实测：OBDLink MX+ 已在系统配对列表，
 *   自检却去扫周边信号把 FB0P…/D20… 无关设备扫进来）。自检路径只走 getPairedDevices()
 *   （bonded）——**禁止周边扫描**；scanNearby() 保留为显式次要动作，自检流程不得调用。
 *   设备选择：手动点选（LinkDoctor.pickDevice）→ rememberBtDevice 持久化 → 之后直连。
 *
 * 契约（PortLike）：write(bytes|string) + on('data', cb) + on('closed', cb)
 * 发现→配对/连接→串口读写全链在本文件；自检 L1/L2 只经 discover()/connect() 进来。
 *
 * 测试缝：BtPort._setPluginForTest(spy)、BtPort._setStoreForTest(store)、
 *          new BtPort({ engine: fakeEngine })（BT 通道 mock 回归）。
 */
import { registerPlugin } from '@capacitor/core';
import { PortError, detectPlatform } from './port-channel.js';

// BLE UART（ELM327 BLE 克隆主流：Nordic UART 同款 FFE0/FFE1）
const BLE_SERVICE = 'ffe0';
const BLE_CHAR = 'ffe1';

let _pluginOverride = null;
let _pluginCache = null;
// SPP 读轮询间隔（默认 20ms）。插件 read() 是「整缓冲取走并清空」，短轮询不丢字节。
let _sppPollMs = 20;

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

/** 插件本身没实现 / 接口缺失（web 桩、旧构建）才归为插件缺失；其余是真实连接错误。 */
function pluginMethodMissing(e) {
  const msg = String(e?.message || e);
  return /not implemented|is not a function/i.test(msg);
}

function wrapPluginError(e, what) {
  const msg = String(e?.message || e);
  if (pluginMethodMissing(e)) {
    return new PortError(
      `蓝牙串口插件不可用（${what}）`,
      '此接头需安卓蓝牙 SPP 通道：请用完整构建安装（含蓝牙插件），或改用 BLE 接头重试。',
      'BT_PLUGIN_MISSING');
  }
  return new PortError(`${what}失败：${msg}`, '确认系统蓝牙已开、接头已配对且没被别的 App 占用。', 'BT_SPP');
}

/**
 * 连接失败专用包装。★ 不再回退 connectInsecure（插件 Java 层没有该 @PluginMethod，
 * web 桩直接抛 not implemented，旧代码把它误报成 BT_PLUGIN_MISSING，掩盖真实连接错误）。
 * 这里保留**原始原因**，只有插件本身缺失才归 BT_PLUGIN_MISSING。
 */
function wrapSppConnectError(e) {
  const msg = String(e?.message || e);
  if (pluginMethodMissing(e)) return wrapPluginError(e, '蓝牙 SPP 连接');
  return new PortError(
    `蓝牙 SPP 连接失败：${msg}`,
    '确认接头未被其它 App 占用、系统蓝牙里先断开该设备后再点「连接自检」重试。',
    'BT_SPP');
}

// ── 引擎：spp（经典蓝牙串口插件） ──
/**
 * 数据通道用插件 read({address}) 短轮询，不用 onRead 通知 + startNotifications('\r')。
 * 原因（2026-11-18 实车 bug）：插件 readUntil() 里 `readBuffer.delete(0,index+1)` 多删 1 字符，
 * 走 startNotifications(delimiter:'\r') 内部即 readUntil → `ATI\rELM327 v1.4b\r\r>` 被读成
 * `ATI\rLM327 v1.4b`（首字母 E 与提示符 > 被吞），Elm327._cmdLocked() 等 `>` 必超时。
 * read() 原生是「整缓冲 substring 后 delete(0,len)」，原样交出、不丢字节。
 */
function makeSppEngine({ address, name }, { onData, onClosed }) {
  let pollTimer = null;
  let stopped = false;

  const stopPolling = () => {
    stopped = true;
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  };

  const startPolling = () => {
    stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await sppPlugin().read({ address });
        const value = r?.value;
        if (!stopped && typeof value === 'string' && value.length) {
          onData(latin1ToBytes(value));
        }
      } catch (e) {
        // 读异常/断开：停轮询并上报关闭，绝不无限刷错
        if (stopped) return;
        stopPolling();
        onClosed();
        return;
      }
      if (!stopped) pollTimer = setTimeout(tick, _sppPollMs);
    };
    tick(); // 立即试探一次，随后按间隔续轮（不 await，避免阻塞 connect）
  };

  return {
    kind: 'spp',
    address,
    name,
    async connect() {
      const p = sppPlugin();
      // 先问连接状态：已连（上轮遗留/记住设备直连）则跳过 connect 直接进读轮询。
      // isConnected 本身不可用（web 插件 not implemented / 接口缺失）→ 插件缺失。
      let connected = false;
      try {
        const r = await p.isConnected({ address });
        connected = !!(r?.connected);
      } catch (e) {
        throw wrapPluginError(e, '蓝牙 SPP 连接状态查询');
      }
      if (!connected) {
        try {
          await p.connect({ address });
        } catch (e) {
          // 包装**原始错误**为 BT_SPP，不再回退未实现的 connectInsecure 误报插件缺失
          throw wrapSppConnectError(e);
        }
      }
      startPolling();
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
      stopPolling();
      // 真释放端口：上一轮失败后 doctor.close() 会走这里，必须真的断开；
      // 不再依赖 stopNotifications（数据通道已不用通知）。
      try { await sppPlugin().disconnect({ address }); } catch { /* 已断 */ }
    },
  };
}

// ── 引擎：ble（Web Bluetooth FFE0/FFE1） ──
let _bleOverride = undefined;
/** Web Bluetooth 句柄（测试缝：_setBleForTest） */
function bleApi() {
  if (_bleOverride !== undefined) return _bleOverride;
  return typeof globalThis.navigator !== 'undefined' ? globalThis.navigator.bluetooth : undefined;
}
/** iOS 非 MFi（BLE）不可用的人话标注 —— 三处（引擎/发现/文案）同源 */
function iosNonMfiError() {
  return new PortError(
    'iOS 非 MFi（通用 ELM327/OBDKey，BLE）暂不支持',
    'iOS 本版本只走 MFi 通道：请用 MFi 版接头（vLinker 系列），或在安卓端使用（安卓 SPP/BLE 都通）。',
    'BT_IOS_NON_MFI_UNSUPPORTED');
}

function makeBleEngine(device, { onData, onClosed }) {
  let chr = null;
  let server = null;
  const onDisconnected = () => onClosed();
  return {
    kind: 'ble',
    address: device.id || device.address,
    name: device.name || 'BLE 设备',
    async connect() {
      const ble = bleApi();
      if (!ble) {
        if (detectPlatform() === 'ios') throw iosNonMfiError();
        throw new PortError(
          'BLE 通道不可用（WebView 未开放 Web Bluetooth）',
          '此接头需 BLE 通道：请用系统 WebView 内核的完整构建，或换经典蓝牙（SPP）接头。',
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
  return !!bleApi();
}

async function sppAvailable() {
  try {
    await sppPlugin().isEnabled();
    return true;
  } catch (e) {
    return !/not implemented/i.test(String(e?.message || e));
  }
}

// ── 已配对设备记忆（手动点选 → 持久化 → 自检直连） ──
const REMEMBER_KEY = 'btDeviceChoice';
let _storeOverride = null;
function store() {
  if (_storeOverride) return _storeOverride;
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* 隐私模式/非浏览器 */ }
  if (!globalThis.__btMemStore) {
    const m = new Map();
    globalThis.__btMemStore = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
  return globalThis.__btMemStore;
}

/** 记住用户点选的接头设备（{name,address}），下次自检直连 */
export function rememberBtDevice(device) {
  try {
    store().setItem(REMEMBER_KEY, JSON.stringify({ name: device?.name || '', address: device?.address || '' }));
  } catch { /* 存储不可用不影响连接 */ }
}
export function getRememberedBtDevice() {
  try {
    const v = JSON.parse(store().getItem(REMEMBER_KEY) || 'null');
    return v && v.address ? v : null;
  } catch { return null; }
}
export function forgetBtDevice() {
  try { store().removeItem(REMEMBER_KEY); } catch { /* 无 */ }
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
   * 发现设备（自检 L1）——**只列已配对（bonded）设备**，不扫周边信号。
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
          // ★ 2026-11-18：只走 getPairedDevices（bonded）—— scan/startDiscovery 是
          //   周边扫描，会把无关设备扫进列表（用户实测 FB0P…/D20…），自检路径禁用。
          const r = await sppPlugin().getPairedDevices();
          const devices = (r?.devices || []).map((d) => ({
            name: d.name || d.address, address: d.address, engine: 'spp', raw: d,
          }));
          return { engine: 'spp', devices };
        }
        if (!bleAvailable()) {
          // ★ 2026-11-18 iOS 对齐：WKWebView 无 Web Bluetooth，本期 iOS 非 MFi 明确标注暂不支持
          lastErr = detectPlatform() === 'ios'
            ? iosNonMfiError()
            : new PortError('BLE 通道不可用', '', 'BT_BLE_UNAVAILABLE');
          continue;
        }
        // ★ 与安卓 bonded 同 UX：记住的设备直连（getDevices，不弹选择器）；
        //   没记住所选才弹系统选择器手动点选 —— **禁止盲连第一个**。
        const remembered = getRememberedBtDevice();
        const getDevices = bleApi().getDevices;
        if (remembered && typeof getDevices === 'function') {
          const known = await getDevices.call(bleApi()).catch(() => []);
          const hit = known.find((d) => (d.id || d.name) === remembered.address || (d.name && d.name === remembered.name));
          if (hit) {
            return {
              engine: 'ble',
              devices: [{ name: hit.name || remembered.name || hit.id, address: hit.id, engine: 'ble', raw: hit }],
              how: 'remembered',
            };
          }
        }
        // Web Bluetooth 系统选择器 = 手动点选（用户手势内发起，自检按钮满足）
        const dev = await bleApi().requestDevice({
          acceptAllDevices: true, optionalServices: [BLE_SERVICE],
        });
        return {
          engine: 'ble',
          devices: [{ name: dev.name || dev.id, address: dev.id, engine: 'ble', raw: dev }],
          how: 'chooser',
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
          ? 'iOS 非 MFi（BLE）暂不支持：请改用 MFi 版接头（vLinker 系列）或在安卓端使用。'
          : '请打开系统蓝牙、配对接头后重试；接头需 SPP 或 BLE 串口通道。';
      }
      return e;
    })();
  }

  /**
   * 周边扫描（显式次要动作）——**自检/连接流程不得调用**；仅供用户主动「搜新设备」时用。
   * 发现的设备仍须先到系统蓝牙设置配对，才能被 discover()（bonded）选到。
   */
  static async scanNearby() {
    const r = await sppPlugin().scan();
    return (r?.devices || []).map((d) => ({
      name: d.name || d.address, address: d.address, engine: 'spp', raw: d,
    }));
  }

  /** 记住/读取/清除用户点选的接头设备（持久化，自检 L1/L2 直连） */
  static rememberDevice(device) { rememberBtDevice(device); }
  static getRememberedDevice() { return getRememberedBtDevice(); }
  static forgetDevice() { forgetBtDevice(); }

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
  /** 测试缝：注入设备记忆存储（验「记住→直连」流） */
  static _setStoreForTest(s) { _storeOverride = s; }
  /** 测试缝：注入 Web Bluetooth 句柄（验 BLE 记住→直连/选择器流；传 undefined 恢复） */
  static _setBleForTest(b) { _bleOverride = b; }
  /** 测试缝：注入 SPP read() 轮询间隔（门禁设小值加速；默认 20ms） */
  static _setSppPollMsForTest(ms) { _sppPollMs = Math.max(1, Number(ms) || 20); }
}
