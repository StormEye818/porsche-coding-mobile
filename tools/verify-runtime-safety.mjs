#!/usr/bin/env node
/**
 * 真实运行时安全回归：只调用生产 Coder/数据，不用旧的 bindDirect 假设。
 * 覆盖 fresh 定族、VIN 同串车名清理、错 CAN ID、默认只读、跨 ECU 恢复和混合 n。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Coder } from '../src/coder.js';

let pass = 0;
const ok = (name, condition, detail = '') => {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};
const vin = 'WP0AB2983EK190083';
const vinHex = [...vin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
const nameHex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
const bytesOf = (s) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const isoTp = (can, payloadHex) => {
  const b = bytesOf(payloadHex);
  const h = (x) => x.toString(16).padStart(2, '0');
  if (b.length <= 7) return `${can} ${h(b.length)} ${b.map(h).join(' ')}`;
  const out = [`${can} 10 ${h(b.length)} ${b.slice(0, 4).map(h).join(' ')}`];
  for (let i = 4, seq = 1; i < b.length; i += 7, seq = (seq + 1) & 0xf) {
    out.push(`${can} ${h(0x20 | seq)} ${b.slice(i, i + 7).map(h).join(' ')}`);
  }
  return out.join('\r');
};
const fakeElm = (responses, { mock = true } = {}) => {
  const calls = [];
  return {
    mock,
    calls,
    async cmd(hex) {
      calls.push(hex);
      const r = responses[hex];
      if (typeof r === 'function') return r(hex);
      if (r !== undefined) return r;
      // 适配器 AT 命令统一回 OK：本套件断言的是业务帧，不是适配器回执形态
      // （回执失败分支由 test-align431 [B] 单独覆盖）。
      return /^AT/i.test(hex) ? 'OK' : 'NO DATA';
    },
  };
};
const coderFor = (responses, opts = {}) => new Coder(fakeElm(responses, opts), {
  tx: 0x7e0, rx: 0x7e8, ecuName: 'DME', verbose: false,
});

// fresh KWP：1A90 的正响应必须能定族并保留 VIN。
{
  const c = coderFor({ '1A90': isoTp('7E8', `5A 90 ${vinHex}`) });
  const r = await c.detectIdentityFamily();
  ok('fresh KWP 由 5A90 定族并读取 VIN', r.family === 'kwp' && r.vin === vin, r.vinSrc);
}

// fresh UDS：KWP 失败后，必须严格按 1003→22F190 定族。
{
  const c = coderFor({
    '1A90': '7E8 03 7F 1A 11',
    '1003': '7E8 02 50 03',
    '22F190': isoTp('7E8', `62 F1 90 ${vinHex}`),
  });
  const r = await c.detectIdentityFamily();
  ok('fresh UDS 由 5003+62F190 定族', r.family === 'uds' && r.vin === vin);
  ok('fresh UDS 探测顺序为 1A90→1003→22F190',
    c.elm.calls.join(',') === '1A90,1003,22F190', c.elm.calls.join(','));
}

// 错 CAN ID 即使内容像 VIN，也不能定族。
{
  const c = coderFor({ '1A90': isoTp('7E9', `5A 90 ${vinHex}`) }, { mock: false });
  const r = await c.detectIdentityFamily();
  ok('错 CAN ID 不得定族', r.family === null && !r.vin);
}

// preflight 已读 VIN 时，不重复发 VIN 请求；221102 同串 VIN 不得当车名。
{
  const c = coderFor({
    '221102': isoTp('7E8', `62 11 02 ${vinHex}`),
    '221101': 'NO DATA',
    '2151': isoTp('7E8', `61 51 ${nameHex('Cayman')}`),
  });
  const r = await c.readVehicleIdentity('kwp', {
    family: 'kwp', vin, vinSrc: '1A90', steps: ['preflight 1A90'],
  });
  ok('VIN 同串应答不污染车名', r.name === 'Cayman' && r.vin === vin, `${r.name}/${r.nameSrc}`);
  ok('preflight 后不重复发送 1A90', !c.elm.calls.includes('1A90'), c.elm.calls.join(','));
}

// 会话 SID/会话号不匹配不得报成功；enterSessionFor 必须走真实 Coder 方法。
{
  const bad = coderFor({ '1089': '7E8 02 50 03' });
  await assert.rejects(bad.enterSession(0x89), /会话响应异常/);
  const good = coderFor({ '1089': '7E8 02 50 89' });
  ok('enterSessionFor(coding) 走真实 Coder 会话方法', await good.enterSessionFor('coding') === true);
}

// 真车没有验证 profile 时，公共写 API 必须在任何发帧前拒绝。
{
  const c = coderFor({}, { mock: false });
  await assert.rejects(
    c.applyChange({ name: 'x', lid: 1, readSid: 0x21, writeSid: 0x3b }, 1, { dryRun: false }),
    /写流未验证/,
  );
  ok('未验证 profile 写入前置拒绝且零发帧', c.elm.calls.length === 0);
}

// 备份的地址与当前 ECU 不同，必须在恢复前置拒绝。
{
  const c = coderFor({}, { mock: false });
  c.diagProfile = { verified: true, reason: 'test' };
  await assert.rejects(c._restore({
    raw: '01', lid: 1, readSid: 0x21, writeSid: 0x3b, tx: 0x7e1, rx: 0x7e9,
  }), /跨 ECU/);
  ok('跨 ECU 备份恢复前置拒绝且零发帧', c.elm.calls.length === 0);
}

// 数据层：混合 n 不得再被解释成直绑。
{
  const plan = JSON.parse(readFileSync(new URL('../data/bind-plan.json', import.meta.url), 'utf8'));
  const ic = plan.ecu['0x0b08'];
  ok('混合 n 的 IC 条目保持非直绑', ic.nMixed === true && ic.bindDirect === false);
  ok('所有 bindDirect 条目均为全行 n=0 且唯一合法地址',
    Object.values(plan.ecu).filter((e) => e.bindDirect)
      .every((e) => e.n === 0 && e.nMixed === false && e.pairs.length === 1));
}

// OBD 通道读 VIN：只认 61 09 05 + 17 位 VIN，且必须恢复原寻址。
{
  const c = coderFor({ '210905': isoTp('7E8', `61 09 05 ${vinHex}`) });
  const r = await c.readVinByObd();
  ok('OBD 210905 严格正响应可读出 VIN', r.vin === vin && /21 09 05/.test(r.src), r.src);
  ok('OBD 读取后恢复原物理寻址', c.tx === 0x7e0 && c.rx === 0x7e8
    && c.elm.calls.filter((x) => /^ATSH/i.test(x)).slice(-1)[0] === 'ATSH7E0');
}
{
  const c = coderFor({ '210905': '7E8 03 7F 21 12', '0902': '7E8 03 7F 09 11' });
  const r = await c.readVinByObd();
  ok('OBD NRC 不得被当成 VIN', r.vin === '' && r.tried.length === 2);
}

// 车型名表：原厂 24 条 strcmp 全等；通用名不猜代际。
{
  const { pickModelByName } = await import('../src/variant.js');
  const e = pickModelByName(['Cayman（981）'], 'Cayman/Boxster（981）');
  ok('车型名表全等命中并给出 vehicleId', e?.exact === true && e.vid === 31 && e.name === 'Cayman（981）');
  ok('通用名 Cayman 不猜代际（多候选返回 null）',
    pickModelByName(['Boxster（981）', 'Cayman（981）'], 'Cayman') === null
    || pickModelByName(['Boxster（981）', 'Cayman（981）'], 'Cayman')?.exact !== true);
  ok('VIN 串不会被当车型名', pickModelByName(['Cayman（981）'], vin) === null);
}

// 绑定计划：0x7F8-0x7FF 属应答段，绝不能当请求 tx；越界值只留证。
{
  const plan = JSON.parse(readFileSync(new URL('../data/bind-plan.json', import.meta.url), 'utf8'));
  const bad = [];
  for (const [sid, e] of Object.entries(plan.ecu)) {
    for (const p of e.pairs || []) {
      const tx = parseInt(p.tx, 16); const rx = parseInt(p.rx, 16);
      if (tx > 0x7f7 || rx > 0x7ff) bad.push(`${sid}:${p.tx}/${p.rx}`);
    }
  }
  ok('pairs 里没有应答段/越界地址', bad.length === 0, bad.slice(0, 3).join(','));
  const rej = plan.ecu['0x0c01']?.rejectedPairs || [];
  ok('12 位路由值进 rejectedPairs 而不是回绕成 0x0004',
    rej.some((p) => p.tx === '0x07FC' && p.reason === 'tx-in-response-range'));
}

// seed 宽度：provider 声明后是硬闸门；未知宽度拒绝计算（防 0x35 → 0x36）。
{
  const c = coderFor({ '270901 00': '7E8 06 67 09 01 02 03 04', '27090100': '7E8 06 67 09 01 02 03 04' });
  c.seedKeyProvider = { calc: () => [0, 0], seedWidths: [2], needsKey: true };
  await assert.rejects(c.securityAccessEx({ level: 0x09, kwp: false }), /不在该算法已声明支持的宽度/);
  ok('声明的 seed 宽度不符 → 拒发 key', !c.elm.calls.some((x) => /^270A/i.test(x)));
}
{
  const c = coderFor({ '27090100': '7E8 07 67 09 01 02 03 04 05' });
  c.seedKeyProvider = { calc: () => [0, 0], needsKey: true };
  await assert.rejects(c.securityAccessEx({ level: 0x09, kwp: false }), /原厂 seed 族已知宽度/);
  ok('未知 seed 宽度 → 拒发 key', !c.elm.calls.some((x) => /^270A/i.test(x)));
}

console.log(`\n===== 运行时安全回归：${pass} 通过 / 0 失败 =====`);
