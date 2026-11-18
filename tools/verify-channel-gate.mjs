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
import { Elm327 } from '../src/elm327.js';

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

// ── ⑤ BtPort SPP 引擎（插件 spy：bonded 发现→连接→read() 轮询读写→关闭） ──
{
  setPlatform('android');
  BtPort._setSppPollMsForTest(2);
  const calls = [];
  // read({address}) 数据队列：每元素是一次 read() 原样交出的整缓冲字符串（不丢字节）
  const readQueue = [];
  const pluginSpy = {
    isEnabled: async () => { calls.push('isEnabled'); return { enabled: true }; },
    // ★ 周边扫描 tripwire：discover 自检路径一旦调 scan 就会被下面断言抓到
    scan: async () => { calls.push('scan'); return { devices: [{ name: 'FB0P-无关设备', address: 'FF:FF:FF:FF:FF:FF' }] }; },
    getPairedDevices: async () => {
      calls.push('getPairedDevices');
      return { devices: [{ name: 'OBDLink MX+ 53935', address: 'AA:BB:CC:DD:EE:FF' }] };
    },
    isConnected: async ({ address }) => { calls.push(`isConnected:${address}`); return { connected: false }; },
    connect: async ({ address }) => { calls.push(`connect:${address}`); },
    // ★ 旧回退 tripwire：一旦恢复 connectInsecure 回退就会被下面断言抓到
    connectInsecure: async () => { calls.push('connectInsecure'); },
    // ★ 旧通知数据通道 tripwire：一旦改回 startNotifications/onRead 就会被下面断言抓到
    startNotifications: async () => { calls.push('startNotifications'); },
    addListener: async (evt) => { calls.push(`addListener:${evt}`); return { remove: async () => {} }; },
    stopNotifications: async () => { calls.push('stopNotifications'); },
    read: async ({ address }) => {
      calls.push('read');
      return { value: readQueue.length ? readQueue.shift() : '' };
    },
    write: async ({ value }) => { calls.push(`write:${value}`); },
    disconnect: async () => { calls.push('disconnect'); },
  };
  BtPort._setPluginForTest(pluginSpy);
  const found = await BtPort.discover({});
  ok('BtPort SPP：discover 只列已配对（bonded）设备',
    found.engine === 'spp' && found.devices[0]?.address === 'AA:BB:CC:DD:EE:FF'
    && found.devices[0]?.name === 'OBDLink MX+ 53935');
  ok('bonded-only 默认：discover 未触发周边扫描（scan 零调用）',
    calls.includes('getPairedDevices') && !calls.includes('scan'), calls.join(' '));
  const port = new BtPort({ engine: 'spp', device: found.devices[0], platform: 'android' });
  const got = [];
  port.on('data', (b) => got.push(new TextDecoder().decode(b)));
  await port.connect();
  await port.write('ATI\r');
  readQueue.push('ELM327 v2.3\r>');
  await new Promise((r) => setTimeout(r, 60));
  await port.close();
  ok('BtPort SPP：写入出线 + read() 轮询进数据 + close 真释放端口',
    calls.some((c) => c.startsWith('write:ATI')) && got.join('').includes('ELM327')
    && calls.filter((c) => c === 'read').length > 0 && calls.includes('disconnect'),
    calls.join(' '));
  ok('BtPort SPP：数据通道零 startNotifications / onRead / connectInsecure（旧路径全封死）',
    !calls.includes('startNotifications') && !calls.some((c) => c.startsWith('addListener:onRead'))
    && !calls.includes('connectInsecure'), calls.join(' '));
  BtPort._setPluginForTest(null);
  BtPort._setSppPollMsForTest(20);

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

// ── ⑤d 真·半包分片防回归：read() 原样交出整缓冲，经真 Elm327 不丢字节、不超时 ──
// 复刻实车日志：ATI\rELM327 v1.4b\r\r> 被分片塞进 read() 队列。
// 旧路径（startNotifications + readUntil('\r') 的 delete(0,index+1) 多删 1 字符）
// 会把首字母 E 与提示符 > 吞掉 → Elm327._cmdLocked() 等 > 必超时 → 本断言转 F。
{
  setPlatform('android');
  BtPort._setSppPollMsForTest(2);
  const calls = [];
  const readQueue = [];
  const pluginSpy = {
    isEnabled: async () => ({ enabled: true }),
    isConnected: async () => ({ connected: false }),
    connect: async () => { calls.push('connect'); },
    connectInsecure: async () => { calls.push('connectInsecure'); },
    read: async () => { calls.push('read'); return { value: readQueue.length ? readQueue.shift() : '' }; },
    write: async () => { calls.push('write'); },
    disconnect: async () => { calls.push('disconnect'); },
  };
  BtPort._setPluginForTest(pluginSpy);
  const port = new BtPort({ engine: 'spp', device: { name: 'OBDLink MX+', address: 'AA:BB:CC:DD:EE:FF' }, platform: 'android' });
  await port.connect();
  const elm = new Elm327(port, { timeoutMs: 1200 });
  const frame = 'ATI\rELM327 v1.4b\r\r>';
  readQueue.push(frame.slice(0, 5), frame.slice(5, 12), frame.slice(12)); // 任意分片
  let result = null, err = null;
  try { result = await elm.cmd('ATI', 1200); } catch (e) { err = e; }
  ok('半包分片经真 Elm327：完整拿到 ELM327 v1.4b、> 被消费、不超时',
    !err && /ELM327 v1.4b/.test(String(result)) && !/>/.test(String(result)) && elm.buf.length === 0,
    `err=${err?.message || '无'} · result=${JSON.stringify(result)}`);
  ok('半包场景 read() 轮询确实发生且零 connectInsecure',
    calls.filter((c) => c === 'read').length > 0 && !calls.includes('connectInsecure'), calls.join(' '));
  await port.close();
  BtPort._setPluginForTest(null);
  BtPort._setSppPollMsForTest(20);
  setPlatform(null);
}

// ── ⑤e connect 失败不回退 connectInsecure、错误含原始原因（恢复旧回退必转 F） ──
{
  setPlatform('android');
  const calls = [];
  const originalReason = 'Connection rejected: device busy (bonded but busy)';
  const pluginSpy = {
    isEnabled: async () => ({ enabled: true }),
    isConnected: async () => ({ connected: false }),
    connect: async () => { calls.push('connect'); throw new Error(originalReason); },
    connectInsecure: async () => { calls.push('connectInsecure'); }, // tripwire：一旦回退即被抓
    read: async () => ({ value: '' }),
    write: async () => {},
    disconnect: async () => { calls.push('disconnect'); },
  };
  BtPort._setPluginForTest(pluginSpy);
  const port = new BtPort({ engine: 'spp', device: { name: 'OBDLink MX+', address: 'AA:BB:CC:DD:EE:FF' }, platform: 'android' });
  let err = null;
  try { await port.connect(); } catch (e) { err = e; }
  ok('connect 失败：零 connectInsecure 回退 + BT_SPP + 错误含原始原因（非「插件不可用」）',
    err instanceof PortError && err.code === 'BT_SPP'
    && !calls.includes('connectInsecure')
    && String(err.message).includes(originalReason)
    && !/插件不可用/.test(String(err.message))
    && /断开|占用/.test(String(err.fix || '')),
    `${err?.code} · ${err?.message} · fix=${err?.fix} · calls=${calls.join(',')}`);
  BtPort._setPluginForTest(null);
  setPlatform(null);
}

// ── ⑤f 连接状态分支：已连跳过 connect；isConnected 不可用报插件缺失 ──
{
  setPlatform('android');
  BtPort._setSppPollMsForTest(2);
  const calls = [];
  BtPort._setPluginForTest({
    isEnabled: async () => ({ enabled: true }),
    isConnected: async () => ({ connected: true }), // 上轮遗留已连
    connect: async () => { calls.push('connect'); },
    read: async () => { calls.push('read'); return { value: '' }; },
    write: async () => {},
    disconnect: async () => { calls.push('disconnect'); },
  });
  const p1 = new BtPort({ engine: 'spp', device: { name: 'x', address: 'AA:BB:CC:DD:EE:FF' }, platform: 'android' });
  await p1.connect();
  await new Promise((r) => setTimeout(r, 30));
  await p1.close();
  ok('已连接：跳过 connect 直接进入 read() 轮询、close 仍真断开',
    !calls.includes('connect') && calls.includes('read') && calls.includes('disconnect'), calls.join(','));
  BtPort._setPluginForTest(null);
  BtPort._setSppPollMsForTest(20);

  // isConnected 本身不可用（web 插件 not implemented / 接口缺失）→ 插件缺失，不伪装成连接错误
  BtPort._setPluginForTest({
    isEnabled: async () => ({ enabled: true }),
    isConnected: async () => { throw new Error('Method not implemented.'); },
    connect: async () => { throw new Error('should not reach'); },
  });
  setPlatform('web');
  let err = null;
  try {
    const p2 = new BtPort({ engine: 'spp', device: { name: 'x', address: 'AA:BB:CC:DD:EE:FF' }, platform: 'web' });
    await p2.connect();
  } catch (e) { err = e; }
  ok('isConnected 不可用（web 插件）→ BT_PLUGIN_MISSING 人话',
    err instanceof PortError && err.code === 'BT_PLUGIN_MISSING'
    && /插件不可用|完整构建/.test(String(err.message || '') + String(err.fix || '')),
    `${err?.code} · ${err?.message}`);
  BtPort._setPluginForTest(null);
  setPlatform(null);
}

// ── ⑤b 已配对列表回放 + 手动点选 + 记住→直连（用户 OBDLink MX+ 实测场景） ──
{
  setPlatform('android');
  const mem = new Map();
  BtPort._setStoreForTest({
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  });
  const fakeEngine = {
    kind: 'spp', connected: 0,
    async connect() { this.connected++; },
    async write() { return 1; },
    async close() {},
  };
  let bonded = [
    { name: 'FB0P-Speaker', address: '11:11:11:11:11:11' },
    { name: 'OBDLink MX+ 53935', address: 'AA:BB:CC:DD:EE:FF' },
    { name: 'D20-Remote', address: '22:22:22:22:22:22' },
  ];
  class BondedBt extends BtPort {
    static async discover() {
      return { engine: 'spp', devices: bonded.map((d) => ({ ...d, engine: fakeEngine })) };
    }
  }
  const pickCalls = [];
  const pickOdblink = async (devices) => {
    pickCalls.push(devices.map((d) => d.address).join(','));
    return devices.find((d) => /OBDLink/i.test(d.name || '')) || null;
  };
  const doctor = new LinkDoctor({
    platform: 'android', adapterKind: 'vlinker',
    adapters: { mfi: MfiPort, bt: BondedBt }, pickDevice: pickOdblink,
  });
  const dev = await doctor.checkAccessory();
  ok('手动点选：已配对列表弹出（名称+MAC），用户点中 OBDLink MX+ 53935',
    dev?.address === 'AA:BB:CC:DD:EE:FF' && pickCalls.length === 1
    && pickCalls[0] === '11:11:11:11:11:11,AA:BB:CC:DD:EE:FF,22:22:22:22:22:22', dev?.name);
  ok('选择已持久化（记住设备）',
    JSON.parse(mem.get('btDeviceChoice') || '{}').address === 'AA:BB:CC:DD:EE:FF');
  ok('L2 直连所选设备', (await doctor.openSession(dev)) === true && fakeEngine.connected === 1);
  await doctor.close();

  // 第二次自检：记住的设备直连，不再弹列表
  const d2 = new LinkDoctor({
    platform: 'android', adapterKind: 'vlinker',
    adapters: { mfi: MfiPort, bt: BondedBt }, pickDevice: pickOdblink,
  });
  const dev2 = await d2.checkAccessory();
  ok('记住→直连：第二次自检不再弹选择（pickDevice 零调用）',
    dev2?.address === 'AA:BB:CC:DD:EE:FF' && pickCalls.length === 1
    && /记住的设备直连/.test(d2.steps[0]?.detail || ''), d2.steps[0]?.detail);
  await d2.close();

  // 记住的设备不在已配对列表（取消配对/换机）→ 重新弹列表
  bonded = bonded.filter((d) => d.address !== 'AA:BB:CC:DD:EE:FF');
  const d3 = new LinkDoctor({
    platform: 'android', adapterKind: 'vlinker',
    adapters: { mfi: MfiPort, bt: BondedBt }, pickDevice: pickOdblink,
  });
  const dev3 = await d3.checkAccessory();
  ok('记住的设备消失（取消配对）→ 重新弹列表点选',
    pickCalls.length === 2 && dev3 === null && /未选择接头/.test(d3.steps[0]?.detail || ''),
    `pickCalls=${pickCalls.length} · ${d3.steps[0]?.detail}`);
  await d3.close();

  // 取消点选 → L1 明确失败，不连任何设备
  const d4 = new LinkDoctor({
    platform: 'android', adapterKind: 'vlinker',
    adapters: { mfi: MfiPort, bt: BondedBt }, pickDevice: async () => null,
  });
  const dev4 = await d4.checkAccessory();
  ok('取消点选 → L1 明确报「未选择接头」', dev4 === null && /未选择接头/.test(d4.steps[0]?.detail || ''),
    d4.steps[0]?.detail);

  // 空已配对列表 → 去系统蓝牙配对指引
  bonded = [];
  const d5 = new LinkDoctor({
    platform: 'android', adapterKind: 'vlinker',
    adapters: { mfi: MfiPort, bt: BondedBt }, pickDevice: pickOdblink,
  });
  const dev5 = await d5.checkAccessory();
  ok('已配对列表为空 → 指引「去系统蓝牙配对」',
    dev5 === null && /配对/.test(d5.steps[0]?.fix || '') && /没有已配对/.test(d5.steps[0]?.detail || ''),
    d5.steps[0]?.fix);
  BtPort._setStoreForTest(null);
  setPlatform(null);
}

// ── ⑤c iOS/BLE 对齐：记住→直连、手动点选、禁盲扫盲连、暂不支持标注 ──
{
  const bleCalls = [];
  const mkStore = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };
  const fakeDev = { id: 'AA:BB:CC:DD:EE:01', name: 'ELM327-BLE' };
  BtPort._setBleForTest({
    getDevices: async () => { bleCalls.push('getDevices'); return [fakeDev]; },
    requestDevice: async () => { bleCalls.push('requestDevice'); return fakeDev; },
  });

  // 记住→直连（getDevices 命中，不弹选择器）——与安卓 bonded 记住流同 UX
  const st1 = mkStore();
  st1.setItem('btDeviceChoice', JSON.stringify({ name: 'ELM327-BLE', address: 'AA:BB:CC:DD:EE:01' }));
  BtPort._setStoreForTest(st1);
  setPlatform('web');
  const f1 = await BtPort.discover({});
  ok('BLE 记住→直连（getDevices，不弹选择器）',
    f1.engine === 'ble' && f1.how === 'remembered'
    && f1.devices[0].address === 'AA:BB:CC:DD:EE:01' && !bleCalls.includes('requestDevice'),
    bleCalls.join(','));

  // 无记住 → 系统选择器手动点选；绝不盲连第一个
  BtPort._setStoreForTest(mkStore());
  const f2 = await BtPort.discover({});
  ok('BLE 无记住 → 手动点选（系统选择器），禁盲连第一个',
    f2.how === 'chooser' && bleCalls.filter((c) => c === 'requestDevice').length === 1,
    bleCalls.join(','));

  // 取消选择 → 明确失败，不连任何设备
  BtPort._setBleForTest({
    getDevices: async () => [],
    requestDevice: async () => { const e = new Error('cancelled'); e.name = 'NotFoundError'; throw e; },
  });
  let err = null;
  try { await BtPort.discover({}); } catch (e) { err = e; }
  ok('BLE 取消选择 → 明确失败，绝不盲连', err instanceof PortError && err.code === 'BT_CANCELLED', err?.code);

  // iOS 无 Web Bluetooth → 「iOS 非 MFi 暂不支持」明确标注（同类问题：无盲扫/无手选缺失/无裸插件错）
  BtPort._setBleForTest(undefined);
  setPlatform('ios');
  let err2 = null;
  try { await BtPort.discover({ platform: 'ios' }); } catch (e) { err2 = e; }
  ok('iOS 非 MFi → 明确「暂不支持」标注（BT_IOS_NON_MFI_UNSUPPORTED）',
    err2 instanceof PortError && err2.code === 'BT_IOS_NON_MFI_UNSUPPORTED'
    && /暂不支持/.test(err2.message) && /MFi|安卓/.test(err2.fix)
    && !/is not implemented/i.test(String(err2.message)),
    `${err2?.code} · ${err2?.message}`);

  // LinkDoctor iOS 非 MFi 全程：L1 带「暂不支持」人话，无盲扫/无裸插件错
  const di = new LinkDoctor({ platform: 'ios', adapterKind: 'elm', adapters: { mfi: MfiPort, bt: BtPort } });
  const ri = await di.run();
  ok('iOS×ELM 自检 L1 =「暂不支持」人话，无盲扫/无裸插件错',
    ri.steps[0] && !ri.steps[0].ok
    && /暂不支持|MFi|安卓/.test(`${ri.steps[0].detail} ${ri.steps[0].fix}`)
    && !/is not implemented/i.test(JSON.stringify(ri.steps)),
    ri.steps[0]?.fix);
  BtPort._setStoreForTest(null);
  setPlatform(null);
}

// ── ⑥ 文案门禁：每条通道的失败提示可操作 ──
{
  ok('fixHint 三通道都有可操作提示',
    [/蓝牙|配对/.test(fixHint('bt', 'android', 'L1')), /蓝牙|配对/.test(fixHint('bt', 'android', 'L2')),
      /MFi|设置/.test(fixHint('mfi', 'ios', 'L1')), /MFi|接头|安卓/.test(fixHint('bt', 'ios', 'L1'))]
      .every(Boolean));
  ok('iOS 非 MFi 文案明确「暂不支持」（无死胡同/无歧义）',
    /暂不支持/.test(fixHint('bt', 'ios', 'L1')) && /暂不支持/.test(fixHint('bt', 'ios', 'L2')));
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
  // SPP 数据通道静态防回退：作用域限定在 makeSppEngine 段（BLE 的 chr.startNotifications 不算）
  const sppSrc = bt.slice(bt.indexOf('function makeSppEngine'), bt.indexOf('function makeBleEngine'));
  ok('SPP 读通道钉死 read() 轮询：无 .read 之外的数据 API、无 connectInsecure/通知/onRead 调用',
    /\.read\(\{\s*address\s*\}\)/.test(sppSrc)
    && !/\.startNotifications\s*\(/.test(sppSrc)
    && !/\.addListener\s*\(/.test(sppSrc)
    && !/\.connectInsecure\s*\(/.test(sppSrc)
    && !/\.stopNotifications\s*\(/.test(sppSrc),
    `sppSrc=${sppSrc.length}B`);
  ok('bonded-only 源码钉死：discover 段只用 getPairedDevices、无 .scan(',
    bt.includes('getPairedDevices')
    && !bt.slice(bt.indexOf('static async discover'), bt.indexOf('static async scanNearby')).includes('.scan('));
  ok('scanNearby 是显式次要动作且 link-doctor 不调用',
    bt.includes('自检/连接流程不得调用') && !doctor.includes('scanNearby'));
  ok('手动点选 + 记住选择已接入 link-doctor',
    doctor.includes('pickDevice') && doctor.includes('getRememberedDevice') && doctor.includes('rememberDevice'));
  const chSrc = readFileSync(new URL('../src/port-channel.js', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  ok('iOS 非 MFi「暂不支持」标注同源（bt-port + port-channel）',
    bt.includes('BT_IOS_NON_MFI_UNSUPPORTED') && chSrc.includes('暂不支持'));
  ok('README 通道矩阵如实：iOS 非 MFi 暂不支持 + 两平台发现语义一致（不盲扫）',
    /暂不支持/.test(readme) && /不盲扫|不扫周围/.test(readme));
  ok('BLE 发现无盲扫（discover 里无 startDiscovery/scan 调用）',
    !bt.slice(bt.indexOf('static async discover'), bt.indexOf('static async scanNearby')).includes('scan('));
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  ok('app.js 把「选择接头类型」接进通道分流', app.includes('adapterKind'));
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  ok('SPP 插件依赖已记版本（MIT，@ascentio-it/capacitor-bluetooth-serial@8.0.1）',
    pkg.includes('"@ascentio-it/capacitor-bluetooth-serial": "8.0.1"'));
}

console.log(`\n===== 通道分流门禁：${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
