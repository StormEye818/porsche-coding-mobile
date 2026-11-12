#!/usr/bin/env node
/**
 * verify-oem-session.mjs — 逐 ECU 原厂会话落地门禁（2026-11-12）。
 *
 * 上一阶段把 SYS_DATA comm 表全量解出（874 记录 / 805 sysId），但运行时仍一律
 * 发 `10 89`，只在日志里提示「未对齐」。本轮把它接进协议层，本测试钉住：
 *   ① 证据表覆盖与 981 分布（32×10 03 + 16×10 89）
 *   ② 运行时实际用到的 sysId 全部有证据、且代际零错配
 *   ③ GAG 帧 flag 语义（逐帧属性，与协议层容错分级一致）
 *   ④ Coder 行为：有/无上下文、flag=0 尽力而为、服务专属会话不被覆盖、
 *      UDS 目标会话=0x03 时不重复发帧、换模块清上下文
 *   ⑤ 写流程不卡：显式只读闸仍生效（写闸门已按对齐矩阵打开）
 *
 * 跑法：node tools/verify-oem-session.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import {
  OEM_SESSION_BY_SYSID, OEM_ENTER_SEQ_BY_SYSID, OEM_GEN_BY_SYSID, oemSessionFor,
} from '../src/oem-session-table.js';
import { oemIsSessionless, oemEnterSequences } from '../src/oem-enter-frames.js';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};
const mk = (replay = null) => {
  const m = new MockAdapter({ latencyMs: 0, replay });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7e0, rx: 0x7e8 });
  return { m, e, c };
};
const framesOf = (m) => m.txLog.filter((x) => !x.startsWith('AT'));

// ── ① 证据表覆盖 ──────────────────────────────────────────────
console.log('\n[1] 证据表覆盖');
ok('会话表 ≥730 条 sysId', Object.keys(OEM_SESSION_BY_SYSID).length >= 730,
  String(Object.keys(OEM_SESSION_BY_SYSID).length));
ok('进模块序列表 ≥800 条 sysId', Object.keys(OEM_ENTER_SEQ_BY_SYSID).length >= 800,
  String(Object.keys(OEM_ENTER_SEQ_BY_SYSID).length));
const comm = readJson('../data/sysdata-comm.json');
ok('源 comm 表 805 sysId / 874 记录 / 0 命令缺失',
  Object.keys(comm.ecu).length === 805 && comm.stats.records === 874 && comm.stats.cmdMiss === 0,
  `${Object.keys(comm.ecu).length}/${comm.stats.records}/${comm.stats.cmdMiss}`);

// ── ② 981 与运行时 sysId ───────────────────────────────────────
console.log('\n[2] 981 分布 + 运行时 sysId 全覆盖');
const j981 = readJson('../data/981-sysids.json').modules;
let s03 = 0, s89 = 0, miss981 = [];
for (const [name, info] of Object.entries(j981)) {
  const hit = oemSessionFor(info.sysId);
  if (!hit) { miss981.push(name); continue; }
  if (hit.session === 0x03) s03++;
  else if (hit.session === 0x89) s89++;
  else miss981.push(name);
}
ok('981 48 模块全部有原厂会话证据', miss981.length === 0, miss981.join(','));
ok('981 会话分布 = 32×10 03 + 16×10 89', s03 === 32 && s89 === 16, `03=${s03} 89=${s89}`);

const allModels = readJson('../data/all-model-sysids.json');
const used = new Set();
for (const v of Object.values(j981)) {
  used.add(String(v.sysId).toLowerCase());
  for (const s of v.sysIds || []) used.add(String(s).toLowerCase());
}
for (const p of Object.values(allModels.platforms)) {
  for (const m of Object.values(p.modules || {})) used.add(String(m.sysId).toLowerCase());
}
// ★ 2026-11-12 第十阶段收口：E1（type 0x03）接入 DSN 模块表后，运行时多出 24 个
//   老代 KWP sysId。它们原厂序列是 `81` 快初始化 + `1A` 识别、**根本不建 UDS 会话**
//   （第十阶段已坐实 68 个 sessionless sysId），不得算作「会话证据缺口」；
//   但必须逐一确认它们确实在 sessionless 集合里、且有原厂进模块序列。
const noEvidence = [...used].filter((k) => !oemSessionFor(k));
const sessionlessNoSession = noEvidence.filter((k) => oemIsSessionless(k));
const realGap = noEvidence.filter((k) => !oemIsSessionless(k));
ok('运行时 sysId 零会话证据缺口（sessionless 老代 KWP 除外）', realGap.length === 0,
  `${used.size} 个 sysId；真缺口 ${realGap.length}，原厂不建会话 ${sessionlessNoSession.length}`);
ok('所有无会话 sysId 都是原厂 sessionless 且有进模块序列',
  sessionlessNoSession.every((k) => oemEnterSequences(k).length > 0),
  `${sessionlessNoSession.length} 个`);
const genMismatch = [...used].filter((k) => {
  const g = OEM_GEN_BY_SYSID[k];
  if (!g) return false;
  return Number.parseInt(k.slice(2, 4), 16) !== Number.parseInt(g, 16);
});
ok('运行时 sysId 与 comm type 代际零错配', genMismatch.length === 0,
  `错配 ${genMismatch.length}`);
ok('防错代护栏生效：错代别名不返回会话', !oemSessionFor('0x0105')?.session
  || oemSessionFor('0x0105')?.gen === '0x05');  // 全表仅 2 条跨代别名，运行时不触及

// 关键锚点
const dme = oemSessionFor('0x0e01');
const pasm = oemSessionFor('0x0e13');
ok('DME 0x0E01 → 10 89 / 要求正响应', dme?.session === 0x89 && dme.requireResponse === true,
  JSON.stringify(dme && { s: dme.session, r: dme.requireResponse }));
ok('PASM 0x0E13 → 10 03 / 尽力而为', pasm?.session === 0x03 && pasm.requireResponse === false,
  JSON.stringify(pasm && { s: pasm.session, r: pasm.requireResponse }));

// ── ③ GAG flag 语义（逐帧属性） ──────────────────────────────
console.log('\n[3] GAG 帧 flag 语义');
const flagStat = {};
for (const e of Object.values(comm.ecu)) {
  for (const b of e.blocks || []) {
    for (const f of b.frames || []) {
      if (!Array.isArray(f) || f.length < 4 || f[2] !== 0x10) continue;
      const k = `0x${f[3].toString(16).padStart(2, '0')}`;
      (flagStat[k] ||= {})[f[0]] = ((flagStat[k] || {})[f[0]] || 0) + 1;
    }
  }
}
let tp = { 0: 0, 1: 0 };
for (const e of Object.values(comm.ecu)) {
  for (const b of e.blocks || []) {
    for (const f of b.frames || []) {
      if (Array.isArray(f) && f.length >= 4 && f[2] === 0x3e && f[3] === 0x00) tp[f[0]]++;
    }
  }
}
ok('3E 00 全部 flag=0（与 coder 保活尽力而为一致）', tp[0] > 400 && tp[1] === 0,
  `flag0=${tp[0]} flag1=${tp[1]}`);
ok('flag 是逐帧属性：10 89 / 10 03 两种 flag 并存',
  (flagStat['0x89']?.[1] || 0) > 0 && (flagStat['0x89']?.[0] || 0) > 0
  && (flagStat['0x03']?.[0] || 0) > 0 && (flagStat['0x03']?.[1] || 0) > 0,
  JSON.stringify({ s89: flagStat['0x89'], s03: flagStat['0x03'] }));
const sessFlags = new Set(Object.values(flagStat).flatMap((o) => Object.keys(o).map(Number)));
ok('全部会话帧 flag 只有 0/1（flag=3 复合脚本帧不参与会话判定）',
  [...sessFlags].every((f) => f === 0 || f === 1), [...sessFlags].join(','));
const allSeq = Object.values(OEM_ENTER_SEQ_BY_SYSID).join(' ');
ok('22 条 flag=3 复合脚本帧全部标记 3!（不被当成可发帧）',
  (allSeq.match(/3!:/g) || []).length === 22 && !/(^|\s)3:/.test(allSeq));

// ── ④ 协议层行为 ──────────────────────────────────────────────
console.log('\n[4] Coder 逐 ECU 会话行为');
{
  const { m, c } = mk();
  await c.enterSession(undefined, { family: 'kwp', skipIdent: true });
  ok('无上下文 → 回退主会话 10 89（既有帧序门禁不破）', framesOf(m).includes('1089'),
    framesOf(m).join(','));
  ok('无上下文 resolveSession() = 0x89', c.resolveSession() === 0x89);
}
{
  // replay 不含会话应答 → NO DATA
  const { m, c } = mk([]);
  const hit = c.setOemContext('0x0e13');
  ok('setOemContext 绑定 PASM 证据', hit?.session === 0x03 && c.oemSessionStrict === false);
  let threw = false;
  try { await c.enterSession(undefined, { family: 'kwp', skipIdent: true }); } catch { threw = true; }
  ok('flag=0 会话无正响应 → 容忍继续（不卡死写流程）', !threw);
  ok('按证据发 10 03，不再发 10 89', framesOf(m).includes('1003')
    && !framesOf(m).includes('1089'), framesOf(m).join(','));
}
{
  const { m, c } = mk([]);
  c.setOemContext('0x0e01');
  let threw = false;
  try { await c.enterSession(undefined, { family: 'kwp', skipIdent: true }); } catch { threw = true; }
  ok('flag=1 会话无正响应 → 仍硬报错（原厂要求正响应）', threw, framesOf(m).join(','));
}
{
  const { m, c } = mk([{ req: '1089', resp: '7E8 02 50 89' }]);
  c.setOemContext('0x0e01');
  await c.enterSession(undefined, { family: 'kwp', skipIdent: true });
  ok('正响应 50 89 到位时会话成功', framesOf(m).includes('1089'));
}
{
  const { m, c } = mk([{ req: '1003', resp: '7E8 02 50 03' }]);
  c.setOemContext('0x0e13');
  await c.enterSessionFor('coding', { family: 'kwp', skipIdent: true });
  ok("enterSessionFor('coding') 取证据会话 10 03", framesOf(m).includes('1003')
    && !framesOf(m).includes('1089'), framesOf(m).join(','));
}
{
  const { m, c } = mk([{ req: '1040', resp: '7E8 02 50 40' }]);
  c.setOemContext('0x0e13');
  await c.enterSessionFor('routine', { family: 'kwp', skipIdent: true });
  ok("服务专属会话（10 40）不被 ECU 会话覆盖", framesOf(m).includes('1040')
    && !framesOf(m).includes('1003'), framesOf(m).join(','));
}
{
  const { m, c } = mk([{ req: '1003', resp: '7E8 02 50 03' }]);
  c.setOemContext('0x0e13');
  await c.enterSession(undefined, { family: 'uds', skipIdent: true });
  const n1003 = framesOf(m).filter((f) => f === '1003').length;
  ok('UDS 目标会话=10 03 时只发一次（不重复扩展会话步）', n1003 === 1,
    `${framesOf(m).join(',')} / 1003×${n1003}`);
}
{
  const { c } = mk();
  c.setOemContext('0x0e13');
  await c.setAddress(0x7e0, 0x7e8, '另一个模块', { family: 'kwp' });
  ok('换模块清证据上下文 → resolveSession() 回退 0x89',
    c.oemSession === null && c.resolveSession() === 0x89);
}

// ── ⑤ 写流程不卡 / 显式只读闸 ─────────────────────────────────
console.log('\n[5] 写流程卡点与显式只读闸');
{
  const { c } = mk();
  c.setOemContext('0x0e13');
  c.diagProfile = { verified: false, reason: '未证 ECU 默认只读' };
  const p = { id: 'x', name: '测试项', lid: 0x01, readSid: 0x21, writeSid: 0x3b,
    byte: 0, bit: 0, bitsize: 1, risk: 'low' };
  let msg = '';
  try { await c.applyChange(p, 1, { dryRun: false }); } catch (e) { msg = String(e.message); }
  ok('显式 diagProfile.verified=false 仍拒写（保守模式可随时切回）', /写流未验证|只读/.test(msg), msg);
  ok('拒写原因与会话号无关（不是会话卡点）', !/会话响应异常/.test(msg), msg);
}
{
  const { c } = mk();
  c.setOemContext('0x0e01');
  ok('981 DME 会话仍是 10 89（完整实车写序列标注保留）',
    c.resolveSession() === 0x89 && c.oemSessionStrict === true);
}

console.log(`\n===== 逐 ECU 原厂会话门禁：${pass} 通过 / 0 失败 =====`);
