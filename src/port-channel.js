/**
 * port-channel.js — 通道分流（平台 × 接头类型 → 传输通道）。
 *
 * 背景（2026-11-18 安卓实测 bug）：自检 L1/L2 曾直连 MfiPort（registerPlugin('MfiSerial')），
 * 安卓上必炸「"MfiSerial" plugin is not implemented on android」。
 * MFi 是**苹果**外部配件协议（iOS 系统持经典蓝牙链路走 EA），安卓走常规蓝牙，
 * 任何平台守卫不通过的路径都不得触达 MfiSerial。
 *
 * 通道矩阵（README「适配器支持」同源）：
 *   iOS   × vLinker/自动    → mfi（MFi 外部配件，EA session）
 *   iOS   × ELM327/OBDKey  → bt（非 MFi：BLE；iOS WKWebView 无 Web Bluetooth 时
 *                             给明确人话提示，绝不抛 plugin not implemented 裸错）
 *   安卓  × 任意            → bt（经典 SPP 主通路 + BLE 备通路，永不走 MFi）
 *   web   × 任意            → bt（开发/预览：BLE 可用则用，否则人话提示）
 *
 * 测试注入：globalThis.__PORT_PLATFORM__ = 'ios'|'android'|'web'（verify-channel-gate 用）。
 */
import { Capacitor } from '@capacitor/core';

/** 传输通道错误 —— message 说现象，fix 给可操作的人话，永不裸抛插件错误。 */
export class PortError extends Error {
  constructor(message, fix = '', code = 'PORT') {
    super(message);
    this.name = 'PortError';
    this.fix = fix;
    this.code = code;
  }
}

/** 当前平台：'ios' | 'android' | 'web'（测试可用 __PORT_PLATFORM__ 强制） */
export function detectPlatform() {
  const forced = globalThis.__PORT_PLATFORM__;
  if (forced === 'ios' || forced === 'android' || forced === 'web') return forced;
  try {
    const p = Capacitor?.getPlatform?.();
    if (p === 'ios' || p === 'android') return p;
  } catch { /* 非 Capacitor 环境 */ }
  return 'web';
}

/**
 * 接头类型（首页「选择接头类型」下拉）× 平台 → 通道。
 * @param {{platform?:string, adapterKind?:string}} o adapterKind: auto|vlinker|elm|obdkey
 * @returns {'mfi'|'bt'}
 */
export function pickChannel({ platform = detectPlatform(), adapterKind = 'auto' } = {}) {
  const kind = String(adapterKind || 'auto');
  // ★ 平台守卫（铁律）：安卓任何路径不得触达 MfiSerial。
  if (platform === 'android') return 'bt';
  if (platform === 'ios') {
    // MFi 外部配件（vLinker MS 系列）走 EA；普通 ELM327/OBDKey 是非 MFi 设备 → 蓝牙通道。
    return (kind === 'auto' || kind === 'vlinker') ? 'mfi' : 'bt';
  }
  return 'bt';
}

/** 通道人话名（日志/toast 用） */
export function channelLabel(channel) {
  return channel === 'mfi' ? 'MFi 外部配件' : '蓝牙';
}

/**
 * 自检失败的可操作提示 —— 按「通道 × 平台 × 层级」给，不给裸错误。
 * @param {'mfi'|'bt'} channel
 * @param {'ios'|'android'|'web'} platform
 * @param {'L1'|'L2'} level
 */
export function fixHint(channel, platform, level) {
  if (channel === 'mfi') {
    return level === 'L1'
      ? '先到「设置 → 蓝牙」确认 vLinker 显示【已连接】。MFi 链路由 iOS 系统持，App 不能代替。'
      : 'EA 会话开失败：拔插 vLinker → 回设置重连 → 再试。别在 App 里反复点，会形成僵尸会话。';
  }
  if (platform === 'ios') {
    return level === 'L1'
      ? '此接头是非 MFi 设备（通用 ELM327/OBDKey），需蓝牙 BLE 通道。iOS 未开放 Web Bluetooth 时请改用 MFi 版接头（vLinker 系列），或在安卓端使用。'
      : 'BLE 会话开失败：确认接头在系统蓝牙里可发现；此接头需 BLE 通道，若为经典蓝牙接头请换 MFi 版接头或用安卓端。';
  }
  return level === 'L1'
    ? '请打开系统蓝牙并在系统设置里配对接头（指示灯常亮）；点火 ON 给接头供电；再点「连接自检」。'
    : '蓝牙会话开失败：确认接头没被别的 App 占用；不行就取消配对后重新配对、靠近接头再试。';
}
