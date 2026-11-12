#!/usr/bin/env node
/**
 * verify-oem-frames.mjs — 原厂进模块帧序列落地门禁（2026-11-12 全量收口）。
 *
 * 上一阶段把「逐 ECU 会话号」接进协议层，但进模块仍按族流猜帧序，只在日志里
 * 打印原厂序列。本轮把 SYS_DATA comm 子表的逐帧序列真正编译进运行时并发帧，
 * 本测试钉住：
 *   ① 生成的静态表与 comm 数据逐帧字节级一致（1005 序列 / 3350 帧）
 *   ② 68 个「无会话」sysId 全是老代 KWP（81 + 1A），原厂不建 UDS 会话
 *   ③ 序列选择规则（绑定地址 > 会话号匹配 > 含会话帧 > 记录顺序）
 *   ④ Coder 行为：按序发帧、flag 容错、非 UDS/复合脚本帧跳过、
 *      显式会话与无上下文仍走既有族流、换模块清证据
 *   ⑤ 全车型运行时 sysId 序列覆盖、写闸门按对齐矩阵判定
 *
 * 跑法：node tools/verify-oem-frames.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import {
  OEM_ENTER_SEQS, OEM_SESSIONLESS_SYSIDS_SET, OEM_ENTER_STATS,
  oemEnterSequences, oemIsSessionless, selectOemSequence,
} from '../src/oem-enter-frames.js';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const comm = readJson('../data/sysdata-comm.json');
const s981 = readJson('../data/981-sysids.json');
const allModels = readJson('../data/all-model-sysids.json');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const coderSrc = readFileSync(new URL('../src/coder.js', import.meta.url), 'utf8');

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
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const frameHex = (f) => f.slice(2).map(hex).join('');

// ── ① 静态表与 comm 数据逐帧字节一致 ──────────────────────────
console.log('\n[1] 静态表 ↔ comm 数据逐帧字节一致');
function rebuild(sid) {
  const e = comm.ecu[sid];
  if (!e) return [];
  const out = [];
  for (const blk of e.blocks || []) {
    const subs = blk.subs || [];
    let off = 0;
    const groups = subs.length
      ? subs.map((s) => {
          const fs = (blk.frames || []).slice(off, off + (s.cmds || []).length);
          off += (s.cmds || []).length;
          return { tx: s.tx, rx: s.rx, frames: fs };
        })
      : [{ tx: null, rx: null, frames: blk.frames || [] }];
    for (const g of groups) {
      const frames = [];
      for (const f of g.frames) {
        if (!Array.isArray(f) || f.length < 3) continue;
        frames.push({ flag: Number.parseInt(String(f[0]), 10) || 0, script: f[0] === 3, hex: frameHex(f) });
      }
      if (frames.length) out.push({ cat: blk.cat, tx: g.tx ?? null, rx: g.rx ?? null, frames });
    }
  }
  return out;
}
{
  let mismatches = 0, checkedSeq = 0, checkedFrame = 0;
  for (const sid of Object.keys(OEM_ENTER_SEQS)) {
    const want = rebuild(sid), got = oemEnterSequences(sid);
    if (want.length !== got.length) { mismatches++; continue; }
    for (let i = 0; i < want.length; i++) {
      checkedSeq++;
      const a = want[i], b = got[i];
      if (a.cat !== b.cat || a.tx !== b.tx || a.rx !== b.rx
        || a.frames.length !== b.frames.length) { mismatches++; continue; }
      for (let j = 0; j < a.frames.length; j++) {
        checkedFrame++;
        if (a.frames[j].flag !== b.frames[j].flag
          || a.frames[j].script !== b.frames[j].script
          || a.frames[j].hex !== b.frames[j].hex) mismatches++;
      }
    }
  }
  ok('803 sysId 的 1005 条序列与 comm 表逐条一致', mismatches === 0 && checkedSeq === 1005,
    `checkedSeq=${checkedSeq} mismatches=${mismatches}`);
  ok('3350 帧的 flag/HEX 逐帧一致', checkedFrame === OEM_ENTER_STATS.frames,
    `checkedFrame=${checkedFrame} stats=${OEM_ENTER_STATS.frames}`);
  ok('多序列 ECU 统计与数据一致（107）', OEM_ENTER_STATS.multiSequence === 107);
  ok('跳过帧统计与数据一致（220 条非 UDS/脚本帧）', OEM_ENTER_STATS.skippedFrames === 220,
    `skipped=${OEM_ENTER_STATS.skippedFrames}`);
}

// ── ② 68 个原厂不建会话的 sysId ────────────────────────────────
console.log('\n[2] 老代 KWP：原厂不建 UDS 会话');
{
  const ids = Object.keys(OEM_SESSIONLESS_SYSIDS_SET);
  ok('恰好 68 个 sysId 原厂无 10 xx 会话帧', ids.length === 68, `${ids.length}`);
  const gens = ids.map((k) => k.slice(0, 4));
  ok('全部落在老代 type 0x01-0x0A（不是证据缺失）',
    gens.every((g) => Number.parseInt(g, 16) <= 0x0a), [...new Set(gens)].join(' '));
  const has81 = ids.filter((k) => oemEnterSequences(k).some((s) => s.frames.some((f) => f.hex === '81')));
  ok('54 个带 81 快初始化帧（其余是 cat=1/4/0x20 或空记录）', has81.length === 54,
    `${has81.length}/68`);
  const rest = ids.filter((k) => !has81.includes(k));
  ok('其余 14 个也全无 10 xx（不是漏解析的会话帧）', rest.every((k) => !oemEnterSequences(k)
    .some((s) => s.frames.some((f) => !f.script && f.hex.startsWith('10')))), `${rest.length}`);
  const noSessionAnywhere = ids.every((k) => !oemEnterSequences(k)
    .some((s) => s.frames.some((f) => !f.script && f.hex.startsWith('10'))));
  ok('这 68 个 sysId 的全部序列都无 10 xx', noSessionAnywhere);
  ok('981 的 48 个模块没有一个被误判为不建会话',
    Object.values(s981.modules).every((v) => !oemIsSessionless(String(v.sysId).toLowerCase())));
}

// ── ③ 序列选择规则 ─────────────────────────────────────────────
console.log('\n[3] 序列选择（地址 > 会话号 > 含会话 > 记录顺序）');
{
  const all = oemEnterSequences('0x0e01');
  ok('DME 0x0e01 有 2 条功能序列（编码 / 识别）', all.length === 2);
  const coding = selectOemSequence('0x0e01', 0x7e0, 0x89);
  ok('目标会话 0x89 → 选编码序列 1089 1A9F 1089',
    coding.frames.map((f) => f.hex).join(' ') === '1089 1A9F 1089',
    coding.frames.map((f) => f.hex).join(' '));
  const ident = selectOemSequence('0x0e01', 0x7e0, 0x03);
  ok('目标会话 0x03 → 选识别序列 3E00 22F19E 22F1A2 1003',
    ident.frames.map((f) => f.hex).join(' ') === '3E00 22F19E 22F1A2 1003',
    ident.frames.map((f) => f.hex).join(' '));
  ok('单序列 ECU（PASM 0x0e13）取自身序列',
    selectOemSequence('0x0e13', 0x755, 0x03).frames.map((f) => f.hex).join(' ')
      === '3E00 22F19E 22F1A2 22F1DF 1003');
  ok('未知 sysId 返回空序列 / null', oemEnterSequences('0xdead').length === 0
    && selectOemSequence('0xdead') === null);
}

// ── ④ Coder 行为 ───────────────────────────────────────────────
console.log('\n[4] Coder 按原厂序列发帧');
{
  const { m, c } = mk([]);
  c.setOemContext('0x0e13', 0x755);
  await c.enterSession(undefined, { oemSequence: true, skipIdent: true });
  const want = ['3E00', '22F19E', '22F1A2', '22F1DF', '1003'];
  ok('PASM 逐帧按原厂序列发（顺序/数量全等）',
    JSON.stringify(framesOf(m)) === JSON.stringify(want), framesOf(m).join(','));
  ok('flag=0 的会话 1003 无正响应仍不抛（不卡死）', c.oemSequenceUsed.includes('0:1003'));
}
{
  // 会话帧 flag=1 且等于目标会话 → 硬要求正响应；两条 1089 各给一条 50 89。
  const { m, c } = mk([
    { req: '1089', resp: '7E8 02 50 89' },
    { req: '1089', resp: '7E8 02 50 89' },
  ]);
  c.setOemContext('0x0e01', 0x7e0);
  await c.enterSession(undefined, { oemSequence: true, skipIdent: true });
  ok('DME 编码序列 1089 1A9F 1089 按序执行',
    JSON.stringify(framesOf(m)) === JSON.stringify(['1089', '1A9F', '1089']), framesOf(m).join(','));
}
{
  const { m, c } = mk([]);
  c.setOemContext('0x0e01', 0x7e0);
  let threw = false;
  try { await c.enterSession(undefined, { oemSequence: true, skipIdent: true }); } catch { threw = true; }
  ok('flag=1 会话无正响应 → 仍硬报错（原厂要求）', threw);
}
{
  const { m, c } = mk([]);
  c.setOemContext('0x0101');
  await c.enterSession(undefined, { oemSequence: true, skipIdent: true });
  ok('老代 0x0101 不发任何 10 xx 会话帧',
    !framesOf(m).some((f) => f.startsWith('10')), framesOf(m).join(','));
  ok('81 快初始化帧跳过、1A9A 识别帧照发',
    JSON.stringify(framesOf(m)) === JSON.stringify(['1A9A']), framesOf(m).join(','));
  ok('coder 标记 sessionless（不再回退 10 89）', c.oemSessionless === true);
}
{
  // 找一个含 flag=3 复合脚本帧的 sysId，验证跳过且不误发
  const withScript = Object.keys(OEM_ENTER_SEQS).find((k) => oemEnterSequences(k)
    .some((s) => s.frames.some((f) => f.script)));
  ok('包内存在 flag=3 复合脚本帧记录', !!withScript, withScript || '—');
  if (withScript) {
    const seq = oemEnterSequences(withScript).find((s) => s.frames.some((f) => f.script));
    const scriptHex = seq.frames.find((f) => f.script).hex;
    const { m, c } = mk([]);
    c.setOemContext(withScript);
    await c.enterSession(undefined, { oemSequence: true, skipIdent: true });
    ok('复合脚本帧不进模块发送', !framesOf(m).includes(scriptHex), scriptHex.slice(0, 20));
  }
}
{
  const { m, c } = mk([{ req: '1089', resp: '7E8 02 50 89' }]);
  c.setOemContext('0x0e13', 0x755);
  await c.enterSession(0x89, { oemSequence: true, skipIdent: true });
  ok('显式给 session（服务专属流程）仍走既有族流',
    framesOf(m).includes('1089') && !framesOf(m).includes('22F1DF'), framesOf(m).join(','));
}
{
  const { m, c } = mk([{ req: '1089', resp: '7E8 02 50 89' }]);
  await c.enterSession(undefined, { oemSequence: true, skipIdent: true });
  ok('无上下文时 oemSequence=true 也不臆造序列',
    framesOf(m).includes('1089') && !framesOf(m).includes('22F19E'), framesOf(m).join(','));
}
{
  const { c } = mk();
  c.setOemContext('0x0e13', 0x755);
  await c.setAddress(0x7e0, 0x7e8, '另一个模块');
  ok('换模块清空序列证据', c.oemSequences.length === 0 && c.oemSessionless === false
    && c.oemSequenceUsed === '');
}

// ── ⑤ 全车型覆盖 / 写流程不卡 ──────────────────────────────────
console.log('\n[5] 全车型覆盖与写流程');
{
  const used = new Set();
  for (const v of Object.values(s981.modules || {})) {
    used.add(String(v.sysId).toLowerCase());
    for (const s of v.sysIds || []) used.add(String(s).toLowerCase());
  }
  for (const p of Object.values(allModels.platforms || {})) {
    for (const m of Object.values(p.modules || {})) used.add(String(m.sysId).toLowerCase());
  }
  const covered = [...used].filter((k) => oemEnterSequences(k).length > 0);
  ok(`运行时 ${used.size} 个 sysId 全部有原厂帧序列`, covered.length === used.size,
    `covered=${covered.length}/${used.size}`);
  ok('app 进模块显式开启原厂序列模式',
    /enterSession\(undefined, \{ family: enterFamily, oemSequence: true \}\)/.test(app));
  ok('app 绑定当前地址用于挑序列', /setOemContext\(oemSid, coder\.tx\)/.test(app));
  ok('app 区分「原厂不建会话」与「无证据回退」', /coder\.oemSessionless/.test(app));
  ok('协议层保留族流回退分支', /oemSequence !== false|oemSequence: false/.test(coderSrc)
    || /if \(opts\.oemSequence === true/.test(coderSrc));
}
{
  const { c } = mk();
  c.setOemContext('0x1401', 0x7e0);
  c.diagProfile = { verified: false, reason: '未证 ECU 默认只读' };
  const p = { id: 'x', name: '测试项', lid: 0x01, readSid: 0x22, writeSid: 0x2e,
    byte: 0, bit: 0, bitsize: 1, risk: 'low' };
  let msg = '';
  try { await c.applyChange(p, 1, { dryRun: false }); } catch (e) { msg = String(e.message); }
  ok('显式只读闸仍生效（对齐闸门由 app 层单独判定）', /写流未验证|只读/.test(msg), msg);
  ok('拒写原因与原厂序列无关（不是帧序卡点）', !/原厂进模块序列|会话响应异常/.test(msg), msg);
}

console.log(`\n===== 原厂进模块帧序列门禁：${pass} 通过 / 0 失败 =====`);
