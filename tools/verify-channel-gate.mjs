#!/usr/bin/env node
/**
 * verify-channel-gate.mjs — 通道分流门禁（平台 × 接头类型 → 传输通道）。
 *
 * 背景（2026-11-18 安卓实测 bug）：自检 L1/L2 曾直连 MfiPort（MfiSerial 插件），
 * 安卓必炸「"MfiSerial" plugin is not implemented on android」。
 * 本门禁钉死四件事：
 *   ① 分流矩阵：iOS×vLinker→MFi；iOS×ELM327/OBDKey→bt；安卓×任意→bt（永不 MFi）。
 *   ② 平台守卫：安卓任何路径零触达 MfiSerial（运行时 spy 计数 0 + 源码守卫断言）。
 *   ③ 人话文案：任何失败给可操作提示，绝不裸抛 plugin not implemented。
 *   ④ BT 通道 mock 回归：发现→连接→串口读写全链（真 BtPort + 真 LinkDoctor）。
 *
 * 跑法：node tools/verify-channel-gate.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickChannel, detectPlatform, fixHint, PortError } from '../src/port-channel.js';
import { MfiPort } from '../src/mfi-port.js';
import { BtPort } from '../src/bt-port.js';
import { LinkDoctor } from '../src/link-doctor.js';

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const setPlatform = (p) => {
  if (p) globalThis.__PORT_PLATFORM__ = p;
  else delete globalThis.__PORT_PLATFORM__;
};
// 最小 ELM327 仿真应答（让 L3/L4 复用现有 ELM327 层走通）
const cannedElm = (cmd) => {
  const c = String(cmd).replace(/\r/g, '').trim();
  if (c === 'ATI' || c === 'ATZ') return 'ELM327 v2.3';
  if (c === 'ATRV') return '12.6V';
  if (c === '1A9F') return '7E8 06 5A 9F 45 43 4D';
  return 'OK';
};

// ── ① 分流矩阵 ──
{
  const m = [];
  for (const kind of ['auto', 'vlinker', 'elm', 'obdkey']) {
    m.push(`android/${kind}=${pickChannel({ platform: 'android', adapterKind: kind })}`);
    m.push(`ios/${kind}=${pickChannel({ platform: 'ios', adapterKind: kind })}`);
    m.push(`web/${kind}=${pickChannel({ platform: 'web', adapterKind: kind })}`);
  }
  ok('安卓 × 任意接头 → bt（永不 MFi）',
    ['auto', 'vlinker', 'elm', 'obdkey'].every((k) => pickChannel({ platform: 'android', adapterKind: k }) === 'bt'),
    m.filter((s) => s.startsWith('android')).join(' '));
  ok('iOS × vlinker/auto → mfi',
    pickChannel({ platform: 'ios', adapterKind: 'vlinker' }) === 'mfi'
    && pickChannel({ platform: 'ios', adapterKind: 'auto' }) === 'mfi');
  ok('iOS × elm/obdkey → bt（非 MFi 分流）',
    pickChannel({ platform: 'ios', adapterKind: 'elm' }) === 'bt'
    && pickChannel({ platform: 'ios', adapterKind: 'obdkey' }) === 'bt');
  ok('web × 任意 → bt', ['auto', 'vlinker', 'elm', 'obdkey'].every((k) => pickChannel({ platform: 'web', adapterKind: k }) === 'bt'));
  ok('detectPlatform 可注入（测试缝）',
    (setPlatform('android'), detectPlatform() === 'android')
    && (setPlatform('ios'), detectPlatform() === 'ios')
    && (setPlatform(null), detectPlatform() === 'web'));
}

// ── ② 安卓平台零触达 MfiSerial（运行时 spy） ──
const mfiCalls = [];
const mfiSpy = {
  list: async () => { mfiCalls.push('list'); return { devices: [] }; },
  open: async () => { mfiCalls.push('open'); },
  addListener: async () => { mfiCalls.push('addListener'); return { remove: async () => {} }; },
  write: async () => { mfiCalls.push('write'); return { wrote: 1 }; },
  close: async () => { mfiCalls.push('close'); },
};
{
  setPlatform('android');
  MfiPort._setPluginForTest(mfiSpy);
  let err = null;
  try { await MfiPort.list(); } catch (e) { err = e; }
  ok('安卓 MfiPort.list → PortError(MFI_ON_ANDROID) 且 spy 零调用',
    err instanceof PortError && err.code === 'MFI_ON_ANDROID' && mfiCalls.length === 0,
    `${err?.code || '无异常'} · spy=${mfiCalls.length}`);
  ok('守卫文案是人话（提示走蓝牙通道）',
    String(err?.message || '').includes('MFi') && String(err?.fix || '').includes('蓝牙'));

  const doctor = new LinkDoctor({ platform: 'android', adapterKind: 'vlinker' });
  const r = await doctor.run();
  ok('安卓 × vLinker 自检：L1 分流拦截，零 MfiSerial 触达',
    r.fail > 0 && mfiCalls.length === 0 && r.channel === 'bt',
    `fail=${r.fail} · spy=${mfiCalls.length} · channel=${r.channel}`);
  ok('安卓自检失败步骤带可操作提示（蓝牙/配对）',
    r.steps.every((s) => s.ok || (s.fix && /蓝牙|配对/.test(s.fix))),
    r.steps.filter((s) => !s.ok).map((s) => `${s.id}:${s.fix}`).join(' | '));

  // 即使错误地强制 mfi 通道，守卫也必须拦下（断言/门禁）
  const d2 = new LinkDoctor({ platform: 'android', channel: 'mfi', adapters: { mfi: MfiPort, bt: BtPort } });
  const r2 = await d2.run();
  ok('安卓强制 mfi 通道 → 分流断言拦截，零 MfiSerial 触达',
    r2.steps[0]?.id === 'L1' && !r2.steps[0].ok && /MFi/.test(r2.steps[0].detail) && mfiCalls.length === 0,
    r2.steps[0]?.detail);
  setPlatform(null);
  MfiPort._setPluginForTest(null);
}

// ── ③ iOS 路径：MFi 正常可用；非 MFi / 插件缺失给人话，不裸抛 ──
{
  setPlatform('ios');
  const calls = [];
  let iosDataCb = null;
  const iosSpy = {
    list: async () => {
      calls.push('list');
      return { devices: [{ name: 'vLinker MS', serial: 'SN1', protocolStrings: ['com.vlinker'], connectionId: 'c1' }] };
    },
    open: async () => { calls.push('open'); },
    addListener: async (evt, cb) => {
      calls.push(`addListener:${evt}`);
      if (evt === 'data') iosDataCb = cb;
      return { remove: async () => {} };
    },
    write: async ({ data }) => {
      calls.push('write');
      const cmd = atob(data);
      setTimeout(() => iosDataCb && iosDataCb({ data: btoa(cannedElm(cmd) + '\r>') }), 0);
      return { wrote: 1 };
    },
    close: async () => {},
  };
  MfiPort._setPluginForTest(iosSpy);
  const dev = await MfiPort.list();
  ok('iOS MFi 配件发现正常（走 EA）', dev.length === 1 && dev[0].name === 'vLinker MS');

  const doctor = new LinkDoctor({ platform: 'ios', adapterKind: 'vlinker' });
  const r = await doctor.run();
  ok('iOS × vLinker：L1-L4 走 MFi 通道全绿',
    r.fail === 0 && r.channel === 'mfi',
    r.steps.map((s) => `${s.id}${s.ok ? '✓' : '✗'}`).join(' '));

  // 插件缺失（模拟器/缺构建）：不得裸抛 plugin not implemented
  const brokenSpy = { list: async () => { throw new Error('MfiSerial plugin is not implemented on ios'); } };
  MfiPort._setPluginForTest(brokenSpy);
  const d3 = new LinkDoctor({ platform: 'ios', adapterKind: 'vlinker' });
  const r3 = await d3.run();
  const flat = r3.steps.map((s) => `${s.detail} ${s.fix}`).join(' ');
  ok('iOS MFi 插件缺失 → 人话 PortError，无裸 plugin 错误',
    r3.steps[0] && !r3.steps[0].ok && !/is not implemented/i.test(flat) && /MFi/.test(flat),
    r3.steps[0]?.detail);
  MfiPort._setPluginForTest(null);

  // iOS 非 MFi（普通 ELM327）：Node 无 Web Bluetooth → 明确提示，不触达 MfiSerial
  mfiCalls.length = 0;
  MfiPort._setPluginForTest(mfiSpy);
  const d4 = new LinkDoctor({ platform: 'ios', adapterKind: 'elm' });
  const r4 = await d4.run();
  const flat4 = r4.steps.map((s) => `${s.detail} ${s.fix}`).join(' ');
  ok('iOS × ELM327（非 MFi）→ BLE 通道提示，零 MfiSerial 触达',
    r4.channel === 'bt' && r4.steps[0] && !r4.steps[0].ok && /BLE|接头/.test(flat4) && mfiCalls.length === 0,
    r4.steps[0]?.fix);
  ok('iOS 非 MFi 失败文案无裸 plugin 错误', !/is not implemented/i.test(flat4));
  MfiPort._setPluginForTest(null);
  setPlatform(null);
}

// ── ④ BT 通道 mock 回归：发现→连接→串口读写（真 BtPort + 真 LinkDoctor） ──
{
  setPlatform('android');
  const writes = [];
  let engineClosed = false;
  const fakeEngine = {
    kind: 'spp',
    async connect() { this.connected = true; },
    async write(bytes) {
      const cmd = new TextDecoder().decode(bytes).replace(/\r/g, '').trim();
      writes.push(cmd);
      setTimeout(() => this._onData(new TextEncoder().encode(cannedElm(cmd) + '\r>')), 0);
      return bytes.length;
    },
    async close() { engineClosed = true; },
    _onData: null,
    _onClosed: null,
  };
  class FakeBt extends BtPort {
    static async discover() {
      return { engine: 'spp', devices: [{ name: 'vLinker MS (BT mock)', address: 'AA:BB:CC:DD:EE:FF', engine: fakeEngine }] };
    }
  }
  // 把 BtPort 的事件钩子接到 fake engine（覆盖 connect 里的引擎构造）
  const origConnect = BtPort.prototype.connect;
  BtPort.prototype.connect = async function () {
    this._engine = fakeEngine;
    this.engineKind = 'fake';
    fakeEngine._onData = (b) => this._emitData(b);
    fakeEngine._onClosed = () => this._emitClosed();
    await fakeEngine.connect();
    return this;
  };
  const mfiGuardSpy = { list: async () => { mfiCalls.push('list'); return { devices: [] }; } };
  MfiPort._setPluginForTest(mfiGuardSpy);
  const doctor = new LinkDoctor({ platform: 'android', adapterKind: 'vlinker', adapters: { mfi: MfiPort, bt: FakeBt } });
  const r = await doctor.run();
  BtPort.prototype.connect = origConnect;

  ok('BT mock：自检 L1-L4 全绿走蓝牙通道',
    r.fail === 0 && r.channel === 'bt', r.steps.map((s) => `${s.id}${s.ok ? '✓' : '✗'}${s.title}`).join(' '));
  ok('BT mock：串口真写入（发现→连接→ATI/协议锁定帧都出线）',
    writes.includes('ATI') && writes.some((w) => w.startsWith('ATSP')) && writes.includes('1A9F'),
    writes.slice(0, 8).join(','));
  ok('BT mock：L3/L5 既有 ELM327 层复用（ATI 回 ELM327、KWP 1A9F 有正响应）',
    r.steps.some((s) => s.id === 'L3' && s.ok && /ELM327/.test(s.detail))
    && r.steps.some((s) => s.id === 'L4' && s.ok), r.steps.find((s) => s.id === 'L4')?.detail);
  ok('BT mock：零 MfiSerial 触达', mfiCalls.length === 0, `spy=${mfiCalls.length}`);
  await doctor.close();
  ok('BT mock：close 释放引擎', engineClosed === true);
  MfiPort._setPluginForTest(null);
  setPlatform(null);
}

// ── ⑤ BtPort SPP 引擎（插件 spy：发现→连接→读写→关闭） ──
{
  const calls = [];
  let onReadCb = null;
  const pluginSpy = {
    isEnabled: async () => { calls.push('isEnabled'); return { enabled: true }; },
    scan: async () => { calls.push('scan'); return { devices: [{ name: 'vLinker MS', address: 'AA:BB:CC:DD:EE:FF' }] }; },
    connect: async ({ address }) => { calls.push(`connect:${address}`); },
    addListener: async (evt, cb) => { calls.push(`addListener:${evt}`); onReadCb = cb; return { remove: async () => calls.push('listener.remove') }; },
    startNotifications: async () => { calls.push('startNotifications'); },
    write: async ({ value }) => { calls.push(`write:${value}`); },
    stopNotifications: async () => { calls.push('stopNotifications'); },
    disconnect: async () => { calls.push('disconnect'); },
  };
  BtPort._setPluginForTest(pluginSpy);
  setPlatform('android');
  const found = await BtPort.discover({});
  ok('BtPort SPP：discover 扫描出设备（auto→spp 优先）',
    found.engine === 'spp' && found.devices[0]?.address === 'AA:BB:CC:DD:EE:FF');
  const port = new BtPort({ engine: 'spp', device: found.devices[0], platform: 'android' });
  const got = [];
  port.on('data', (b) => got.push(new TextDecoder().decode(b)));
  await port.connect();
  await port.write('ATI\r');
  onReadCb({ value: 'ELM327 v2.3\r>' });
  await port.close();
  ok('BtPort SPP：写入出线 + onRead 进数据 + close 收尾',
    calls.some((c) => c.startsWith('write:ATI')) && got.join('').includes('ELM327')
    && calls.includes('stopNotifications') && calls.includes('disconnect'),
    calls.join(' '));
  BtPort._setPluginForTest(null);

  // 插件缺失 → 人话降级（不裸抛）
  const missing = { isEnabled: async () => { throw new Error('BluetoothSerial plugin is not implemented on web'); } };
  BtPort._setPluginForTest(missing);
  setPlatform('web');
  let err = null;
  try { await BtPort.discover({ engine: 'spp' }); } catch (e) { err = e; }
  ok('BtPort SPP 插件缺失 → PortError 人话，无裸 plugin 错误',
    err instanceof PortError && !/is not implemented/i.test(String(err.message)) && err.fix.length > 0,
    `${err?.code} · ${err?.message}`);
  BtPort._setPluginForTest(null);
  setPlatform(null);
}

// ── ⑥ 文案门禁：每条通道的失败提示可操作 ──
{
  ok('fixHint 三通道都有可操作提示',
    [/蓝牙|配对/.test(fixHint('bt', 'android', 'L1')), /蓝牙|配对/.test(fixHint('bt', 'android', 'L2')),
      /MFi|设置/.test(fixHint('mfi', 'ios', 'L1')), /MFi|接头|安卓/.test(fixHint('bt', 'ios', 'L1'))]
      .every(Boolean));
}

// ── ⑦ 源码守卫静态断言（防回退） ──
{
  const mfi = readFileSync(new URL('../src/mfi-port.js', import.meta.url), 'utf8');
  ok('mfi-port.js 含平台守卫（guardMfi 先于插件调用）',
    mfi.includes('MFI_ON_ANDROID') && mfi.includes('guardMfi()') && mfi.includes("detectPlatform() === 'android'"));
  const doctor = readFileSync(new URL('../src/link-doctor.js', import.meta.url), 'utf8');
  ok('link-doctor.js L1/L2 按通道分流且带安卓断言',
    doctor.includes("platform === 'android' && ch === 'mfi'")
    && doctor.includes('./bt-port.js') && doctor.includes('pickChannel'));
  ok('link-doctor.js 不再无守卫直连 MfiPort.list',
    !/[^.]MfiPort\.list\(/.test(doctor) && !/[^.]MfiPort\(\{/.test(doctor.replace(/new this\.adapters\.mfi\(/g, '')));
  const bt = readFileSync(new URL('../src/bt-port.js', import.meta.url), 'utf8');
  ok('bt-port.js 双通路就位（SPP 插件契约 + BLE FFE0/FFE1）',
    bt.includes("registerPlugin('BluetoothSerial')") && bt.includes("'ffe0'") && bt.includes("'ffe1'"));
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  ok('app.js 把「选择接头类型」接进通道分流', app.includes('adapterKind'));
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  ok('SPP 插件依赖已记版本（MIT，@ascentio-it/capacitor-bluetooth-serial@8.0.1）',
    pkg.includes('"@ascentio-it/capacitor-bluetooth-serial": "8.0.1"'));
}

console.log(`\n===== 通道分流门禁：${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
