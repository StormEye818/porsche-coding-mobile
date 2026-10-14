/**
 * mfi-port.js — vLinker MS 的 iOS MFi 串口通道（复用 alfaproxi 真机验证方案）。
 *
 * 背景（2026-09-30 真机打通，vLinker MS 验证）：
 *   MFi 适配器由 iOS 系统持有经典蓝牙链路（设置里常驻「已连接」），
 *   CoreBluetooth 扫描永远看不见它 —— 必须走 External Accessory (EA)。
 *   前提：Info.plist 的 UISupportedExternalAccessoryProtocols 声明协议串。
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

const MfiSerial = registerPlugin('MfiSerial');

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
    this._buf = new Uint8Array(0);
  }

  /** 列出系统已连接的 MFi 配件 */
  static async list() {
    const r = await MfiSerial.list();
    return r.devices || [];
  }

  on(evt, cb) {
    if (evt === 'data') this._dataCbs.push(cb);
    else if (evt === 'closed') this._closeCbs.push(cb);
    return this;
  }

  async connect() {
    await MfiSerial.open({
      connectionId: this.opts.connectionId,
      protocol: this.opts.protocol || null,
    });
    await MfiSerial.addListener('data', (r) => {
      const bytes = base64ToBytes(r.data);
      for (const cb of this._dataCbs) cb(bytes);
    });
    await MfiSerial.addListener('closed', () => {
      for (const cb of this._closeCbs) cb();
    });
    return this;
  }

  /** PortLike: write(string|Uint8Array) */
  write(data) {
    const bytes = toBytes(data);
    return MfiSerial.write({ data: bytesToBase64(bytes) })
      .then((r) => r.wrote ?? bytes.length)
      .catch((e) => {
        console.error('[MfiPort] write 失败', e);
        throw e;
      });
  }

  async close() {
    try { await MfiSerial.close(); } catch {}
  }
}
