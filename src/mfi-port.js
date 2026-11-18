/**
 * mfi-port.js — vLinker MS 的 iOS MFi 串口通道（复用 alfaproxi 真机验证方案）。
 *
 * 背景（2026-09-30 真机打通，vLinker MS 验证）：
 *   MFi 适配器由 iOS 系统持有经典蓝牙链路（设置里常驻「已连接」），
 *   CoreBluetooth 扫描永远看不见它 —— 必须走 External Accessory (EA)。
 *   前提：Info.plist 的 UISupportedExternalAccessoryProtocols 声明协议串。
 *
 * ⚠️ 平台守卫（2026-11-18 安卓实测 bug）：MFi 是**苹果**外部配件协议，
 *    安卓平台任何调用都不得触达 MfiSerial —— guardMfi() 先于插件调用执行，
 *    安卓上抛人话 PortError（走 bt-port.js 蓝牙通道），
 *    绝不裸抛「"MfiSerial" plugin is not implemented on android」。
 *    插件未注册（模拟器/缺构建）同样转成人话，不漏原始插件错误。
 *
 * 已踩过的坑（务必别改回去）：
 *   ① EA 流/Timer 必须挂主 RunLoop，否则定时器永不触发、读循环饿死，
 *      表现为「端口打开但 ATZ 无应答」—— 这条在 MfiSerialPlugin.swift 里处理。
 *   ② Capacitor 插件方法跑后台队列，所以写也在主线程做。
 *   ③ 「识别为 ELM327」是兼容指令集，自动切总线由接口类型决定，与识别串无关。
 *
 * 契约（PortLike）：write(bytes|string) + on('data', cb) + on('closed', cb)
 */
import { registerPlugin } from '@capacitor/core';
import { PortError, detectPlatform } from './port-channel.js';

let _pluginOverride = null;
let _pluginCache = null;

/** 平台守卫：安卓零触达 MfiSerial（先于任何插件调用） */
function guardMfi() {
  if (detectPlatform() === 'android') {
    throw new PortError(
      'MFi 是苹果外部配件协议，安卓平台没有 MfiSerial 通道',
      '安卓请走蓝牙通道：接头类型选 vLinker/ELM327 后点「连接自检」，会自动用蓝牙 SPP/BLE 连接。',
      'MFI_ON_ANDROID');
  }
}

/** MfiSerial 插件句柄（懒注册；guardMfi 先行） */
function plugin() {
  guardMfi();
  if (_pluginOverride) return _pluginOverride;
  if (!_pluginCache) _pluginCache = registerPlugin('MfiSerial');
  return _pluginCache;
}

/** 插件层错误转人话 —— 「plugin is not implemented」绝不裸抛 */
function wrapMfiError(e, what) {
  const msg = String(e?.message || e);
  if (/not implemented/i.test(msg)) {
    return new PortError(
      `MFi 插件不可用（${what}）`,
      'MFi 链路只在 iOS 真机完整构建里可用：请用 ios:run 安装真机包；模拟器/安卓请走蓝牙通道。',
      'MFI_PLUGIN_MISSING');
  }
  return new PortError(`${what}失败：${msg}`,
    'EA 会话异常：拔插 vLinker → 回系统设置重连 → 再试。', 'MFI');
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data;
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class MfiPort {
  /** opts: { connectionId, protocol?, name? } */
  constructor(opts) {
    this.opts = opts;
    this._dataCbs = [];
    this._closeCbs = [];
    this._listeners = [];
    this._buf = new Uint8Array(0);
  }

  /** 列出系统已连接的 MFi 配件（iOS EA；安卓被 guardMfi 拦下） */
  static async list() {
    try {
      const r = await plugin().list();
      return r.devices || [];
    } catch (e) {
      if (e instanceof PortError) throw e;
      throw wrapMfiError(e, 'MFi 配件发现');
    }
  }

  on(evt, cb) {
    if (evt === 'data') this._dataCbs.push(cb);
    else if (evt === 'closed') this._closeCbs.push(cb);
    return this;
  }

  async connect() {
    try {
      await plugin().open({
        connectionId: this.opts.connectionId,
        protocol: this.opts.protocol || null,
      });
      this._listeners.push(await plugin().addListener('data', (r) => {
        const bytes = base64ToBytes(r.data);
        for (const cb of this._dataCbs) cb(bytes);
      }));
      this._listeners.push(await plugin().addListener('closed', () => {
        for (const cb of this._closeCbs) cb();
      }));
    } catch (e) {
      if (e instanceof PortError) throw e;
      throw wrapMfiError(e, 'EA 会话');
    }
    return this;
  }

  /** PortLike: write(string|Uint8Array) */
  write(data) {
    const bytes = toBytes(data);
    return plugin().write({ data: bytesToBase64(bytes) })
      .then((r) => r.wrote ?? bytes.length)
      .catch((e) => {
        if (e instanceof PortError) throw e;
        const err = wrapMfiError(e, 'MFi 写入');
        console.error('[MfiPort] write 失败', err);
        throw err;
      });
  }

  async close() {
    for (const h of this._listeners.splice(0)) {
      try { await h.remove(); } catch { /* 已移除/插件不可用 */ }
    }
    this._dataCbs = [];
    this._closeCbs = [];
    try { await plugin().close(); } catch { /* 已关/安卓守卫下不触达 */ }
  }

  /** 测试缝：注入插件替身（验「安卓零触达」） */
  static _setPluginForTest(p) { _pluginOverride = p; _pluginCache = null; }
}
