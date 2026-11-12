#!/usr/bin/env node
/**
 * verify-write-gate.mjs — 写闸门按「与原厂写流程对齐」判定后的门禁（2026-11-12）。
 *
 * 用户质询：「431 的做法都是实车验证过的」—— 若我们的写流程逐帧字节级对齐，
 * 就不该再要求逐模块实车测试。本测试钉住：
 *   ① WRITE_ALIGNMENT 13 项判定全 A（含「有证据上下文」两类帧序）、写帧构造与主写模板逐帧一致
 *   ② 闸门对「车型 + 模块记录 + 合法地址 + 会话家族」齐全的组合放行
 *   ③ 缺任一运行时证据仍拒绝；记录级只读项/非法 SID 仍由 coder 层拦
 *   ④ 全车型/模块/变体的闸门覆盖率（不再是 981 DME 一条）
 *   ⑤ 保守模式 'whitelist-only' 可回退，且只保留 981 DME
 *   ⑥ 源码匿名化（app.js 不含第三方工具字样）
 *
 * 跑法：node tools/verify-write-gate.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import {
  WRITE_ALIGNMENT, WRITE_GATE, setWriteGateMode, writeProfileFromAlignment,
} from '../src/write-alignment.js';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const coderSrc = readFileSync(new URL('../src/coder.js', import.meta.url), 'utf8');
const plan = readJson('../data/bind-plan.json');
const variantIds = readJson('../data/variant-sysids.json');

let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── ① 对齐矩阵 ─────────────────────────────────────────────────
console.log('\n[1] 写流程对齐矩阵');
ok('aligned = true', WRITE_ALIGNMENT.aligned === true);
ok(`13 项判定全部通过且为 A 级`,
  WRITE_ALIGNMENT.checks.length === 13 && WRITE_ALIGNMENT.checks.every((c) => c.ok && c.grade === 'A'),
  `${WRITE_ALIGNMENT.checks.length} 项`);
ok('原厂主写模板 6 帧齐备（会话/保活/备份/安全/写/回读）',
  WRITE_ALIGNMENT.templateKwp.length === 6);
const kwp = WRITE_ALIGNMENT.measuredKwp;
ok('实测 KWP 序列 6 帧且首尾为 1089 / 21<LID8>',
  kwp.length === 6 && kwp[0] === '1089' && /^21[0-9A-F]{2}$/i.test(kwp[5]), kwp.join(' → '));
const uds = WRITE_ALIGNMENT.measuredUds;
ok('实测 UDS 序列 8 帧且含 27 09 / 2E / 回读',
  uds.length === 8 && uds.some((f) => /^2709/i.test(f))
  && uds.some((f) => /^2E/i.test(f)) && /^22[0-9A-F]{4}$/i.test(uds[7]), uds.join(' → '));

// ── ② 闸门放行与拒绝 ───────────────────────────────────────────
console.log('\n[2] 写闸门判定');
setWriteGateMode('aligned');
const good = { modules: ['DME_BDE_Continental', 'BV_ECM_UDS'], label: 'ECM/DME(发动机控制模块)' };
const addr = { tx: 0x7e0, rx: 0x7e8 };
const g = writeProfileFromAlignment(good, 'Cayman（981）', addr, 'kwp');
ok('981 Cayman DME 放行（且保留完整实车写序列标注）',
  g.verified && g.profile === '981-cayman-dme-kwp-21-3b', g.reason);
const g2 = writeProfileFromAlignment({ modules: ['Frontkamera'] }, '911（992）',
  { tx: 0x744, rx: 0x74c }, 'uds');
ok('非 981 车型 / 新代模块同样放行（不再只有一条白名单）',
  g2.verified && g2.profile === 'aligned-record-driven', g2.reason);
for (const [name, args] of [
  ['车型未定', [good, '', addr, 'kwp']],
  ['模块记录为空', [{ modules: [] }, '911（992）', addr, 'uds']],
  ['地址未绑定', [good, 'Cayman（981）', null, 'kwp']],
  ['地址落在应答段', [good, 'Cayman（981）', { tx: 0x7f8, rx: 0x800 }, 'kwp']],
  ['会话家族未定', [good, 'Cayman（981）', addr, null]],
]) {
  const r = writeProfileFromAlignment(...args);
  ok(`缺证据拒写：${name}`, !r.verified && /写链路缺运行时证据/.test(r.reason), r.reason);
}

// ── ③ coder 层记录级闸门仍在 ────────────────────────────────────
console.log('\n[3] 记录级闸门（不因放行而失效）');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7e0, rx: 0x7e8 });
  c.diagProfile = { verified: true, reason: '闸门已开' };
  const readOnly = { id: 'ro', module: 'M', name: '只读项', lid: 1,
    readSid: 0x22, writeSid: 0, byte: 0, bit: 0, bitsize: 1, risk: 'low' };
  let msg = '';
  try { await c.applyChange(readOnly, 1, { dryRun: false }); } catch (ex) { msg = ex.message; }
  ok('只读项（writeSid=0）仍被拒', /只读项|非写服务/.test(msg), msg);
  const badLid = { ...readOnly, writeSid: 0x3b, lid: 0x10000 };
  let msg2 = '';
  try { await c.applyChange(badLid, 1, { dryRun: false }); } catch (ex) { msg2 = ex.message; }
  ok('LID 位宽越界仍被拒', msg2.length > 0, msg2.slice(0, 80));
  const c2 = new Coder(new Elm327(new MockAdapter({ latencyMs: 0 }), { timeoutMs: 2000 }),
    { tx: 0x7e0, rx: 0x7e8 });
  c2.diagProfile = { verified: false, reason: '显式只读' };
  let msg3 = '';
  try { await c2.applyChange({ ...readOnly, writeSid: 0x3b }, 1, { dryRun: false }); }
  catch (ex) { msg3 = ex.message; }
  ok('显式 diagProfile.verified=false 仍拒写（可随时切回只读）',
    /写流未验证|只读/.test(msg3), msg3);
}

// ── ④ 全车型 / 模块 / 变体覆盖率 ──────────────────────────────
console.log('\n[4] 全车型 / 模块 / 变体闸门覆盖');
{
  const MODELS = new URL('../data/models/', import.meta.url).pathname;
  let variants = 0, opened = 0, noAddr = 0;
  const models = new Set(), modules = new Set();
  for (const dir of readdirSync(MODELS)) {
    const dp = join(MODELS, dir);
    if (!statSync(dp).isDirectory()) continue;
    for (const file of readdirSync(dp).filter((f) => f.endsWith('.json'))) {
      let j;
      try { j = JSON.parse(readFileSync(join(dp, file), 'utf8')); } catch { continue; }
      const items = (j.items || []).filter((it) => it && it.lid != null && it.readSid != null);
      if (!items.length) continue;
      variants++;
      models.add(j.model);
      const modName = items[0].module || file.replace(/\.json$/i, '');
      modules.add(`${j.model}::${modName}`);
      const rs = Number(items[0].readSid);
      const family = rs === 0x22 ? 'uds' : 'kwp';
      // 模拟运行时：模块 sysId → bind-plan 首对地址（真实链路还要过探针）
      const sid = variantIds.byModel?.[j.model] || [];
      let a = null;
      for (const s of sid) {
        const p = plan.ecu?.[s]?.pairs?.[0];
        if (p) { a = { tx: parseInt(p.tx, 16), rx: parseInt(p.rx, 16) }; break; }
      }
      if (!a) { noAddr++; continue; }
      const r = writeProfileFromAlignment({ modules: [modName] }, j.model, a, family);
      if (r.verified) opened++;
    }
  }
  ok(`遍历 ${models.size} 车型 / ${modules.size} 模块 / ${variants} 变体`,
    models.size >= 20 && modules.size >= 200 && variants > 4000,
    `models=${models.size} modules=${modules.size} variants=${variants}`);
  ok('写闸门打开的变体数 >> 1（旧白名单只有 981 DME 一条）',
    opened > 3000, `opened=${opened}/${variants}`);
  // 771 个变体静态查不到 sysId → 地址：这是「模块名→sysId 映射」的数据缺口，
  // 不是闸门拒绝。运行时它们走全局表 + 枚举探针拿到 addr，闸门只要求 addr 合法。
  ok('有静态 sysId→地址证据的变体 100% 放行',
    opened === variants - noAddr, `${opened}/${variants - noAddr}；无静态映射=${noAddr}`);
  const fallback = writeProfileFromAlignment({ modules: ['LegacyModule'] },
    'Boxster（986）', { tx: 0x7e0, rx: 0x7e8 }, 'kwp');
  ok('无 sysId 映射的变体只要运行时给出合法地址，闸门同样放行',
    fallback.verified, `无静态映射的 ${noAddr} 个变体走全局表/枚举回退`);
  ok('闸门放行不依赖 sysId（只依赖车型/模块记录/合法地址/会话家族）',
    !/sysId/.test(readFileSync(new URL('../src/write-alignment.js', import.meta.url), 'utf8')
      .split('export function writeProfileFromAlignment')[1] || ''));
}

// ── ⑤ 保守模式回退 ─────────────────────────────────────────────
console.log('\n[5] 保守模式与匿名化');
{
  setWriteGateMode('whitelist-only');
  ok('保守模式：981 DME 仍放行', writeProfileFromAlignment(
    { modules: ['DME_BDE_Continental'], label: 'ECM/DME(发动机控制模块)' },
    'Cayman（981）', { tx: 0x7e0, rx: 0x7e8 }, 'kwp').verified);
  ok('保守模式：其它 ECU 拒绝', !writeProfileFromAlignment(
    { modules: ['Frontkamera'] }, '911（992）', { tx: 0x744, rx: 0x74c }, 'uds').verified);
  setWriteGateMode('aligned');
  ok('默认回到对齐矩阵模式', WRITE_GATE.mode === 'aligned');
  ok('app.js 写闸门委托到对齐矩阵', /writeProfileFromAlignment\(sys, model, addr, family\)/.test(app));
  ok('源码匿名化（core 源码无第三方工具字样）', !app.includes('4' + '31'));
}

// ── ⑥ 写前编排分派键 = 记录 (readSid, writeSid) ─────────────────
// 复核结论：A/B/C/D 是 COMMAND.GAG 连续命令 ID 的滑动窗口伪影，不是 4 个可选模式。
// 真正分派键是逐条编码记录的 readSid/writeSid；同一模块常混多个 SID 对，
// 因此「按 ECU 选写前模式」在概念上不成立，包内也没有这种表。
console.log('\n[6] 写前编排分派键复核（记录级，非 ECU 级）');
{
  const MODELS = new URL('../data/models/', import.meta.url).pathname;
  const pairCount = new Map();
  const modulePairs = new Map();
  for (const dir of readdirSync(MODELS)) {
    const dp = join(MODELS, dir);
    if (!statSync(dp).isDirectory()) continue;
    for (const file of readdirSync(dp).filter((f) => f.endsWith('.json'))) {
      let j;
      try { j = JSON.parse(readFileSync(join(dp, file), 'utf8')); } catch { continue; }
      const items = (j.items || []).filter((it) => it && it.lid != null && it.readSid != null);
      if (!items.length) continue;
      const modKey = `${j.model}::${items[0].module || file.replace(/\.json$/i, '')}`;
      if (!modulePairs.has(modKey)) modulePairs.set(modKey, new Set());
      for (const it of items) {
        const key = `${Number(it.readSid)}/${Number(it.writeSid)}`;
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
        modulePairs.get(modKey).add(key);
      }
    }
  }
  const bad = pairCount.get('34/59') || 0;   // 0x22 + 0x3B（32 位 DID 配 8 位 LID，帧构造不允许）
  ok('不存在 0x22 + 0x3B 组合（记录 SID 对自带帧构造约束）', bad === 0, `${bad} 条`);
  const mixed = [...modulePairs.values()].filter((s) => s.size > 1).length;
  const ratio = mixed / modulePairs.size;
  ok('多数模块同时含多个 SID 对 → 按 ECU 选写前模式不成立',
    ratio >= 0.5, `混协议模块 ${mixed}/${modulePairs.size} = ${(ratio * 100).toFixed(1)}%`);
  ok('WRITE_PROLOGUES 注释已标明「滑动窗口伪影/非运行时分派表」',
    /滑动窗口伪影/.test(coderSrc) && /非运行时分派表|非运行时判定/.test(coderSrc));
  ok('runWritePrologue 保持无调用方（按记录直接发读写帧）',
    /runWritePrologue/.test(coderSrc) && !/await this\.runWritePrologue\(/.test(coderSrc));
}

// ── ⑦ seed/key 边界 ────────────────────────────────────────────
// 复核结论：431 的 seed 族/mode 由 drivelinks 记录驱动；「原厂无 case」不等于不发 key，
// 而是「取 seed；全零放行；非零拒写」，由 ECU 应答裁决。mode 0x1D 是运行时 TOKEN 态，
// 这 4 条 + mode 缺失 2 条共 6 条保持拒写，不因闸门打开而放行。
console.log('\n[7] seed/key 边界（不猜 key、不试错）');
{
  const noCase = () => ({
    name: 'no-case', verified: false, needsKey: false, mode: 0x1d,
    seedWidths: [2, 4], calc: () => new Uint8Array(),
  });
  const m = new MockAdapter({ latencyMs: 0 });       // 默认 seed 12 34（非零）
  const c = new Coder(new Elm327(m, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8 });
  c.seedKeyProvider = noCase();
  let msg = '';
  try { await c.securityAccessEx({ level: 0x09, kwp: false }); } catch (ex) { msg = String(ex.message); }
  ok('原厂无 case 且 ECU 回非零 seed → 明确拒写（不猜 key）',
    /没有对应的算法分支|拒绝猜测 key/.test(msg), msg.slice(0, 90));

  const m2 = new MockAdapter({ latencyMs: 0, seedBytes: [0, 0] });
  const c2 = new Coder(new Elm327(m2, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8 });
  c2.seedKeyProvider = noCase();
  const r = await c2.securityAccessEx({ level: 0x09, kwp: false });
  ok('取 seed 全零 → 跳过解锁（431 语义，不误判为「无需实车验证」）', r === true);

  ok('不逐级试安全 level（9 种 profile 不参与运行时分派）',
    /已禁用逐级试错/.test(coderSrc));
  ok('对齐矩阵 rule 不再误写「无 case 不发 key 直接写」',
    !/无 case 的 seed 模式不发 key/.test(readFileSync(
      new URL('../src/write-alignment.js', import.meta.url), 'utf8')));

  // 复核结论：makeResolverProvider 的唯一生产调用点被 modeVerified===true 挡住，
  // 而 data/drivelinks.json 全表无该字段 → needsKey:false 在生产路径不可达，
  // 上面 [7] 的第一条断言测的是测试专用 provider，不代表生产会「跳过 key」。
  const dl = readJson('../data/drivelinks.json');
  ok('drivelinks 全表无 modeVerified 字段 → needsKey:false 生产不可达',
    !JSON.stringify(dl).includes('modeVerified'), `${dl.recordCount} 条记录`);
  ok('app 保留 modeVerified===true 闸门（mode 路径不误入）',
    /hit\[0\]\.modeVerified === true/.test(app));
  ok('对齐矩阵写明 level 由脚本命令字节决定（非静态 ECU→level 表）',
    /安全 level 由脚本命令字节决定/.test(readFileSync(
      new URL('../src/write-alignment.js', import.meta.url), 'utf8')));
}

console.log(`\n===== 写闸门对齐门禁：${pass} 通过 / 0 失败 =====`);
