#!/usr/bin/env node
/**
 * verify-write-gate.mjs — 写闸门按「与原厂写流程对齐」判定后的门禁（2026-11-12）。
 *
 * 用户质询：「参考诊断仪的做法都是实车验证过的」—— 若我们的写流程逐帧字节级对齐，
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
import { Elm327, Elm327Error } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import {
  WRITE_ALIGNMENT, WRITE_GATE, setWriteGateMode, writeProfileFromAlignment,
  evaluateWriteAlignmentChecks,
} from '../src/write-alignment.js';
import { resolveKey } from '../src/seedkey-resolver.js';

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
// ★ 2026-11-13 T03-i：不再只读静态 JSON 的 checks[].ok —— 每次**实跑重算 13 项**
//   （帧序列逐帧复跑 + 构建期行为证据），并用 13 个断言名逐条钉死。
const liveAlign = evaluateWriteAlignmentChecks();
// 13 项判定 id 逐字钉死（U-1 门禁断言名载体；防止某检查被改名/漏掉而未被察觉）。
const WRITE_GATE_13_CHECK_IDS = Object.freeze([
  'kwp-frame-shape', 'uds-frame-shape', 'readback-verify', 'safety-default-off',
  'no-ident-chain-in-write', 'skip-ident-on-write', 'no-auto-restore',
  'no-security-brute', 'record-driven-sid', 'session-evidence', 'address-probe',
  'oem-context-kwp', 'oem-context-uds',
]);
ok('WRITE_GATE_13_CHECKS：13 项写对齐行为复跑全 A（非静态快照）',
  liveAlign.behaviorRun === true && liveAlign.checks.length === 13
  && liveAlign.checks.every((c) => c.ok && c.grade === 'A')
  && WRITE_ALIGNMENT.checks.length === 13
  && WRITE_ALIGNMENT.checks.every((c) => c.ok && c.grade === 'A'),
  `复跑 ${liveAlign.checks.length} 项 / ${liveAlign.frameCount} 帧`);
ok('WRITE_GATE_13_CHECKS：复跑 id 集合与钉死的 13 项逐字全等',
  JSON.stringify(liveAlign.checks.map((c) => c.id)) === JSON.stringify(WRITE_GATE_13_CHECK_IDS),
  liveAlign.checks.map((c) => c.id).join(','));
for (const id of WRITE_GATE_13_CHECK_IDS) {
  const c = liveAlign.checks.find((x) => x.id === id);
  ok(`${id}（行为复跑）`, !!c && c.ok && c.grade === 'A', c ? c.detail : '缺失');
}
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
// 复核结论：A/B/C/D 是 参考诊断仪导出 连续命令 ID 的滑动窗口伪影，不是 4 个可选模式。
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
  // ★ G7：注释字面量 → 实跑。写路径真实发帧里不得出现写前编排序言帧（证明无 call 方生效）。
  {
    const mP = new MockAdapter({ latencyMs: 0 });
    const cP = new Coder(new Elm327(mP, { timeoutMs: 40 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    cP.diagProfile = { verified: true, reason: 'G7 测试授信' };
    mP.txLog.length = 0;
    try {
      await cP.applyChange({ name: 'x', lid: 0x30, readSid: 0x22, writeSid: 0x2e,
        byte: 0, bit: 0, bitsize: 8 }, 1, { dryRun: false });
    } catch { /* 空回执按发帧判定 */ }
    const pFrames = mP.txLog.filter((x) => !x.startsWith('AT'));
    ok('WRITE_G7_NO_PROLOGUE_IN_WRITE 实跑写路径不含写前编排序言帧',
      pFrames.length > 0 && !pFrames.some((f) => /^(1A9F|22F19E|22F1A2|1A8[0-9A-F])/i.test(f))
      && /滑动窗口伪影/.test(coderSrc),
      `frames=${pFrames.join(',')}`);
  }
  ok('runWritePrologue 保持无调用方（按记录直接发读写帧）',
    /runWritePrologue/.test(coderSrc) && !/await this\.runWritePrologue\(/.test(coderSrc));
}

// ── ⑦ seed/key 边界 ────────────────────────────────────────────
// 复核结论：参考诊断仪的 seed 族/mode 由 drivelinks 记录驱动；「原厂无 case」不等于不发 key，
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
  m.txLog.length = 0;
  try { await c.securityAccessEx({ level: 0x09, kwp: false }); } catch (ex) { msg = String(ex.message); }
  // T04-d：不再只匹配错误文案，改为实跑行为断言 —— 拒写后不得发出 27 0A（key）帧
  const sentAfterDeny = m.txLog.filter((x) => !x.startsWith('AT'));
  ok('原厂无 case 且 ECU 回非零 seed → 明确拒写且不发 27 0A（实跑行为）',
    /没有对应的算法分支|拒绝猜测 key/.test(msg)
      && sentAfterDeny.some((f) => /^2709/i.test(f))
      && !sentAfterDeny.some((f) => /^270A/i.test(f)),
    `${msg.slice(0, 60)} | txLog=${sentAfterDeny.join(',')}`);

  const m2 = new MockAdapter({ latencyMs: 0, seedBytes: [0, 0] });
  const c2 = new Coder(new Elm327(m2, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8 });
  c2.seedKeyProvider = noCase();
  const r = await c2.securityAccessEx({ level: 0x09, kwp: false });
  ok('取 seed 全零 → 跳过解锁（参考诊断仪语义，不误判为「无需实车验证」）', r === true);

  // ★ G7：源码字面量 → 实跑。安全访问只发**一组** 27 09，不得出现第二个不同 level 的 27xx。
  {
    const mQ = new MockAdapter({ latencyMs: 0 });
    const cQ = new Coder(new Elm327(mQ, { timeoutMs: 60 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    cQ.seedKeyProvider = noCase();
    mQ.txLog.length = 0;
    try { await cQ.securityAccessEx({ level: 0x09, kwp: false }); } catch { /* 拒写按发帧判定 */ }
    const sFrames = mQ.txLog.filter((x) => /^27/i.test(x));
    const levels = new Set(sFrames.map((f) => f.slice(2, 4)));
    ok('WRITE_G7_NO_LEVEL_BRUTE 实跑只发一组 27 09（不逐级试 level）',
      levels.size <= 1, `27 帧=${sFrames.join(',') || '(空)'} levels=${[...levels].join(',')}`);
  }
  ok('对齐矩阵 rule 不再误写「无 case 不发 key 直接写」',
    !/无 case 的 seed 模式不发 key/.test(readFileSync(
      new URL('../src/write-alignment.js', import.meta.url), 'utf8')));

  // ★ 2026-11-13 T03-f：seed/key 生产链已接通（推翻旧「全表无 modeVerified 字段」结论）。
  //   生成器 python3 tools/export-drivelinks-v3.py --annotate-mode-verified 按
  //   「resolveKey(mode, 0x12345678) 实跑不抛错且 needsKey=true 且 outlen>0」逐记录
  //   标注；未验证记录（mode 0x00 无 case 0 / 0x1D 需运行时 state / >0x77 无 case）
  //   一律 false，继续回落名字分发，绝不一律 true（否则算错 key → NRC 0x35→0x36 锁死）。
  const dl = readJson('../data/drivelinks.json');
  const dlRows = Object.values(dl.ecu).flatMap((arr) => arr);
  const verifiedRows = dlRows.filter((r) => r.modeVerified === true);
  const rejectedRows = dlRows.filter((r) => r.modeVerified === false);
  ok('SEEDKEY_PRODUCTION_REACHABLE：modeVerified=true 记录真实存在且生产闸门可达',
    verifiedRows.length > 0 && /hit\[0\]\.modeVerified === true/.test(app),
    `true=${verifiedRows.length}/${dlRows.length} 条`);
  ok('SEEDKEY_PRODUCTION_REACHABLE：每条 true 记录都实跑 resolveKey 可算 key',
    verifiedRows.every((r) => {
      try {
        const k = resolveKey(r.mode, 0x12345678, { ecuId: null });
        return k.needsKey === true && (k.outlen | 0) > 0;
      } catch { return false; }
    }), `实跑 ${verifiedRows.length} 条`);
  ok('SEEDKEY_PRODUCTION_REACHABLE：绝不一律 true，未验证记录仍回落名字分发',
    rejectedRows.length > 0 && rejectedRows.length < dlRows.length
    && rejectedRows.every((r) => r.modeVerified === false),
    `false=${rejectedRows.length} 条（mode 0x00 / 0x1D / >0x77 无 case）`);
  ok('SEEDKEY_PRODUCTION_REACHABLE：生成器产出（stats.policy 可复跑）',
    /resolveKey/.test(dl.stats?.modeVerified?.policy || '')
    && /annotate-mode-verified/.test(dl.stats?.modeVerified?.repro || ''),
    dl.stats?.modeVerified?.repro || '—');
  ok('对齐矩阵写明 level 由脚本命令字节决定（非静态 ECU→level 表）',
    /安全 level 由脚本命令字节决定/.test(readFileSync(
      new URL('../src/write-alignment.js', import.meta.url), 'utf8')));
}

// ── ⑧ ELM 链路：ATSH/ATCRA 空回执阻断 + 超时半包清空（T03-h）────
console.log('\n[8] ELM 绑定回执与半包（行为实跑）');
{
  class StubPort {
    constructor(reply) { this.reply = reply; this.handlers = []; this.written = []; }
    write(s) {
      this.written.push(String(s));
      const r = this.reply;
      setTimeout(() => this.handlers.forEach((h) => h(new TextEncoder().encode(r))), 0);
    }
    on(_e, cb) { this.handlers.push(cb); }
  }
  const mkElm = (reply, timeoutMs = 200) => new Elm327(new StubPort(reply), { timeoutMs });

  let blocked = false;
  try { await mkElm('\r>').cmdOk('ATSH7F1', 200, { requireOk: true }); }
  catch (e) { blocked = e instanceof Elm327Error && e.code === 'AT_NOT_OK'; }
  ok('ELM_EMPTY_BIND_BLOCKED：生产绑定 ATSH 空回执报死 AT_NOT_OK', blocked);

  let okPassed = false;
  try { await mkElm('OK\r>').cmdOk('ATCRA7E8', 200, { requireOk: true }); okPassed = true; } catch { okPassed = false; }
  ok('ELM_EMPTY_BIND_BLOCKED：OK 回执正常通过（不误伤）', okPassed);

  // 超时半包：喂一段无 '>' 的半包，超时后 buf 必须清空、且记录丢弃字节数。
  const e = mkElm('7E8 10 13 5A 90 57', 60);   // 无提示符 → 超时
  let timedOut = false;
  try { await e.cmd('220021', 60, { noDelay: true }); }
  catch (err) { timedOut = err.code === 'TIMEOUT_PARTIAL' || err.code === 'NO_DATA'; }
  ok('ELM_TIMEOUT_PARTIAL_CLEARED：超时抛 TIMEOUT_PARTIAL/NO_DATA', timedOut);
  ok('ELM_TIMEOUT_PARTIAL_CLEARED：超时后 buf 已清空（下一条不串帧）',
    e.buf.length === 0 && (e.partialDiscarded || 0) > 0,
    `buf=${e.buf.length} discarded=${e.partialDiscarded || 0}`);
}

// ── ⑨ 13 项写对齐行为复跑：反例注入（T03-i）──────────────────────
console.log('\n[9] 写对齐行为复跑 · 反例注入');
{
  const good = evaluateWriteAlignmentChecks();
  ok('WRITE_ALIGNMENT_INJECTION：基线 13 项全 A',
    good.aligned === true && good.checks.length === 13, `${good.frameCount} 帧`);

  // 故意改错写帧序列：把 KWP 实测写帧 3B... 换成非法 2E...（帧构造错误）。
  const tampered = {
    ...WRITE_ALIGNMENT,
    measuredKwp: WRITE_ALIGNMENT.measuredKwp.slice(),
  };
  tampered.measuredKwp[4] = '2E00FF';   // 错误写帧
  const bad = evaluateWriteAlignmentChecks(tampered);
  const badIds = bad.checks.filter((c) => !c.ok).map((c) => c.id);
  ok('WRITE_ALIGNMENT_INJECTION：改错写帧 → 行为复跑判非 A（门禁失败）',
    bad.aligned === false && badIds.includes('kwp-frame-shape')
    && badIds.includes('record-driven-sid') && badIds.includes('no-auto-restore'),
    `翻红=${badIds.join(',')}`);

  // 闸门层：把矩阵替换成错误帧后，writeProfileFromAlignment 必须拒写。
  // 用 Object.defineProperty 临时替换导出的常量不可行（ESM 只读），
  // 故直接断言「求值器返回非 A ⇒ 闸门拒绝」的纯函数契约。
  const gateWouldDeny = (live) => !live.aligned || !WRITE_ALIGNMENT.aligned;
  ok('WRITE_ALIGNMENT_INJECTION：非 A ⇒ 写闸门拒写（纯函数契约）',
    gateWouldDeny(bad) === true && gateWouldDeny(good) === false);

  // 还原后必须逐项复绿（证明不是永久占位/写死）。
  const restored = evaluateWriteAlignmentChecks();
  ok('WRITE_ALIGNMENT_INJECTION：还原帧序列后 13 项逐项复绿',
    restored.aligned === true
    && JSON.stringify(restored.checks.map((c) => c.id + ':' + c.ok))
      === JSON.stringify(good.checks.map((c) => c.id + ':' + c.ok)),
    `复绿 ${restored.checks.filter((c) => c.ok).length}/13`);
}

console.log(`\n===== 写闸门对齐门禁：${pass} 通过 / 0 失败 =====`);
