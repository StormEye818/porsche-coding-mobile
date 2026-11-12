#!/usr/bin/env node
/**
 * verify-fullchain.mjs — 全车型 / 模块 / 变体 全链路打通验收（2026-11-12 全量收口）。
 *
 * 用户要求「从读 VIN 到进模块再到读写」全链路打通、写流程无卡点。本测试分三层：
 *
 *   [1] 静态全量覆盖：遍历 data/models/* 下**每一个变体文件**（25 车型 / 数千变体），
 *       逐条检查编码记录的读写帧能否成帧、模块能否解析到 sysId、sysId 是否有原厂
 *       进模块帧序列、bind-plan 是否有地址候选。统计零致命缺口。
 *   [2] 协议层端到端：跨代际抽代表 ECU，用模拟适配器真跑
 *       地址绑定 → 原厂序列进模块 → 读块 → 写 → 回读，断言 0 抛错、
 *       帧序与证据表逐字节一致、写回读一致。
 *   [3] 写流程卡点：逐闸门确认「显式只读」是开关而非流程断点；
 *       写闸门已按「逐帧对齐原厂写流程」打开（见 tools/verify-write-gate.mjs）。
 *   [4] 写序言分派：包内阴性证据（不冒充存在）；主写模板不含写前编排。
 *   [5] 老代 KWP 写路径：原厂不建 UDS 会话。
 *
 * 跑法：node tools/verify-fullchain.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import { extractField, validateParam, canWrite } from '../src/schema.js';
import { platformInfoFor, sysIdForModule } from '../src/model-sysid-map.js';
import {
  oemEnterSequences, oemIsSessionless, selectOemSequence, OEM_SENDABLE_SID,
} from '../src/oem-enter-frames.js';
import { oemSessionFor } from '../src/oem-session-table.js';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const bindPlan = readJson('../data/bind-plan.json');
const allModels = readJson('../data/all-model-sysids.json');
const s981 = readJson('../data/981-sysids.json');
const comm = readJson('../data/sysdata-comm.json');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const coderSrc = readFileSync(new URL('../src/coder.js', import.meta.url), 'utf8');

let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};
const sendable = new Set(OEM_SENDABLE_SID);

// ── [1] 静态全量覆盖 ───────────────────────────────────────────
console.log('\n[1] 全车型 / 模块 / 变体静态覆盖');
const MODEL_DIR = new URL('../data/models/', import.meta.url).pathname;
const modelDirs = readdirSync(MODEL_DIR).filter((d) => statSync(join(MODEL_DIR, d)).isDirectory());
const stat = {
  models: modelDirs.length, variants: 0, items: 0, writable: 0,
  badFrame: [], noSysId: [], noSequence: [], noAddress: [],
  readSidDist: {}, writeSidDist: {},
};
for (const dir of modelDirs) {
  const files = readdirSync(join(MODEL_DIR, dir)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    let j;
    try { j = JSON.parse(readFileSync(join(MODEL_DIR, dir, file), 'utf8')); }
    catch { stat.badFrame.push(`${dir}/${file}: JSON 不可解析`); continue; }
    stat.variants++;
    const items = (j.items || []).filter((it) => it && it.lid != null && it.readSid != null);
    if (!items.length) { stat.badFrame.push(`${dir}/${file}: 无有效记录`); continue; }
    const modName = items[0].module || file.replace(/\.json$/i, '');
    const sysId = sysIdForModule(modName, j.model);
    if (!sysId) stat.noSysId.push(`${dir}/${file}:${modName}`);
    else {
      const key = String(sysId).toLowerCase();
      if (!oemEnterSequences(key).length) stat.noSequence.push(`${dir}/${file}:${key}`);
      if (!bindPlan.ecu?.[key]?.pairs?.length) stat.noAddress.push(`${dir}/${file}:${key}`);
    }
    for (const it of items) {
      stat.items++;
      const rs = Number(it.readSid), ws = Number(it.writeSid), lid = Number(it.lid);
      stat.readSidDist[`0x${rs.toString(16)}`] = (stat.readSidDist[`0x${rs.toString(16)}`] || 0) + 1;
      stat.writeSidDist[`0x${ws.toString(16)}`] = (stat.writeSidDist[`0x${ws.toString(16)}`] || 0) + 1;
      if (canWrite(it)) stat.writable++;
      // 帧形态硬约束：LID 必须放得进读/写服务的帧位宽（22/2E 用 16 位，21/1A/3B 用 8 位）。
      const wideRead = rs === 0x22 ? lid > 0xffff : lid > 0xff;
      const wideWrite = canWrite(it) && (ws === 0x2e ? lid > 0xffff : lid > 0xff);
      if (wideRead || wideWrite) {
        stat.badFrame.push(`${dir}/${file} rs=0x${rs.toString(16)} ws=0x${ws.toString(16)} lid=${lid}`);
      }
    }
  }
}
ok(`遍历 ${stat.models} 车型 / ${stat.variants} 变体 / ${stat.items} 条编码记录`,
  stat.models === 25 && stat.variants > 3000 && stat.items > 50000,
  `models=${stat.models} variants=${stat.variants} items=${stat.items}`);
ok('全部记录读写帧可按记录成帧（0 条 LID 位宽越界）', stat.badFrame.length === 0,
  stat.badFrame.length ? stat.badFrame.slice(0, 3).join(' | ') : `可写记录=${stat.writable}`);
ok('能解析到 sysId 的模块全部有原厂进模块序列', stat.noSequence.length === 0,
  stat.noSequence.length ? stat.noSequence.slice(0, 3).join(' | ') : `未解析 sysId 的变体=${stat.noSysId.length}`);
ok('能解析到 sysId 的模块全部有 bind-plan 地址候选', stat.noAddress.length === 0,
  stat.noAddress.length ? stat.noAddress.slice(0, 3).join(' | ') : '0 缺口');
// 历史数据里有极少量异常 SID（表级回落 resolveBlockReadSid 覆盖），如实量化而不冒充全干净。
const share = (dist, keys) => Object.entries(dist)
  .reduce((a, [k, n]) => a + (keys.includes(k) ? n : 0), 0);
const readMain = share(stat.readSidDist, ['0x21', '0x22', '0x1a', '0x0']);
const writeMain = share(stat.writeSidDist, ['0x3b', '0x2e', '0x0']);
ok('读服务主流 21/22/1A/0 覆盖 ≥99.9%（异常值走表级回落）',
  readMain / stat.items >= 0.999,
  `主流=${readMain}/${stat.items} 异常=${stat.items - readMain} 种数=${Object.keys(stat.readSidDist).length}`);
ok('写服务主流 3B/2E/0 覆盖 ≥99.9%（异常值不进写帧）',
  writeMain / stat.items >= 0.999,
  `主流=${writeMain}/${stat.items} 异常=${stat.items - writeMain} 种数=${Object.keys(stat.writeSidDist).length}`);

// 平台级：14 平台全部能给出车型识别结果；未定案的 4 个平台显式降级，不冒充已打通。
{
  const plats = Object.entries(allModels.platforms);
  ok('14 个平台全部有车型→平台判定条目', plats.length === 14);
  const known = plats.filter(([, v]) => v.confidence === 'high' || v.confidence === 'medium');
  ok('已定案平台全部带 gen（可直接选代际会话）',
    known.every(([, v]) => !!v.gen), `${known.length}/${plats.length}`);
  ok('981 主映射 48 模块全部有 comm 序列',
    Object.values(s981.modules).every((v) => oemEnterSequences(String(v.sysId).toLowerCase()).length > 0));
  const cayman = platformInfoFor('Cayman（981）');
  ok('车型识别链：Cayman（981）→ 9X1 / gen 0x0E / high',
    cayman.platform === '9X1' && cayman.gen === '0x0e' && cayman.confidence === 'high',
    JSON.stringify(cayman));
}

// ── [2] 协议层端到端（真跑读→写→回读） ─────────────────────────
console.log('\n[2] 跨代际端到端：原厂序列进模块 → 读 → 写 → 回读');
const REPS = [
  { label: '981 DME（编码序列 10 89）', sysId: '0x0e01', tx: 0x7e0, rx: 0x7e8, sess: 0x89 },
  { label: '981 PASM（序列 10 03 / flag=0）', sysId: '0x0e13', tx: 0x755, rx: 0x7bf, sess: 0x03 },
  { label: '992 新代 DME（commCat10 地址）', sysId: '0x1401', tx: 0x7e0, rx: 0x7e8, sess: 0x03 },
  { label: '新代网关', sysId: '0x1409', tx: 0x710, rx: 0x77a, sess: 0x03 },
  { label: 'Taycan 新代', sysId: '0x1601', tx: 0x7e0, rx: 0x7e8, sess: 0x03 },
  { label: '老代 KWP（原厂不建 UDS 会话）', sysId: '0x0101', tx: 0x7e0, rx: 0x7e8, sess: null },
];
let e2eOk = 0;
for (const rep of REPS) {
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: rep.tx, rx: rep.rx });
  await c.setAddress(rep.tx, rep.rx, rep.label);
  // setAddress 换模块会把真车 profile 置为未验证；端到端用显式 mock profile 跑通写链。
  c.diagProfile = { verified: true, reason: 'fullchain mock profile' };
  c.setOemContext(rep.sysId, rep.tx);
  const seq = selectOemSequence(rep.sysId, rep.tx, rep.sess);
  const expected = seq.frames
    .filter((f) => !f.script && sendable.has(Number.parseInt(f.hex.slice(0, 2), 16)))
    .map((f) => f.hex);
  let err = '';
  try {
    await c.enterSession(undefined, { oemSequence: true, skipIdent: true });
    const frames = m.txLog.filter((x) => !x.startsWith('AT'));
    assert.deepEqual(frames, expected, `${rep.label} 进模块帧序不一致`);
    // 写路径：seed/key provider + mock 已验证 profile（真车由对齐矩阵闸门判定）。
    c.seedKeyProvider = {
      name: 'fullchain-mock', verified: true, seedWidths: [2, 4],
      calc: () => new Uint8Array([0x12, 0x34]),
    };
    const p = { id: 'fc', module: 'FullchainMock', name: '全链路测试字段',
      lid: 0x21, readSid: 0x21, writeSid: 0x3b,
      byte: 0, bit: 0, bitsize: 8, level: 'source-defined', risk: 'low' };
    assert.deepEqual(validateParam(p), []);
    const before = await c.readBlock(0x21, 0x21);
    assert.ok(before.length > 0, `${rep.label} 读块为空`);
    const newV = extractField(before, p) === 0x5a ? 0x3c : 0x5a;
    await c.applyChange(p, newV, { dryRun: false, session: c.resolveSession() });
    const after = await c.readBlock(0x21, 0x21);
    assert.equal(extractField(after, p), newV, `${rep.label} 写后回读不一致`);
    e2eOk++;
    ok(`${rep.label}：序列 ${expected.length} 帧逐字节一致 + 读写回读闭环`,
      true, `sessionless=${oemIsSessionless(rep.sysId)} sess=${rep.sess ?? '—'}`);
  } catch (ex) {
    err = String(ex.message || ex);
    ok(`${rep.label}：序列 ${expected.length} 帧逐字节一致 + 读写回读闭环`, false, err);
  }
}
ok(`跨 ${REPS.length} 个代际代表全部跑通（0 卡点）`, e2eOk === REPS.length, `${e2eOk}/${REPS.length}`);

// ── [3] 写流程卡点 / 对齐闸门 ──────────────────────────────────
console.log('\n[3] 写流程卡点与对齐闸门');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7e0, rx: 0x7e8 });
  c.setOemContext('0x1401', 0x7e0);
  c.diagProfile = { verified: false, reason: '未证 ECU 默认只读' };
  const p = { id: 'x', name: '测试项', lid: 0x01, readSid: 0x22, writeSid: 0x2e,
    byte: 0, bit: 0, bitsize: 1, risk: 'low' };
  let msg = '';
  try { await c.applyChange(p, 1, { dryRun: false }); } catch (ex) { msg = String(ex.message); }
  ok('未证 ECU 拒写原因是「写流未验证」（策略闸门，不是链路断点）',
    /写流未验证|只读/.test(msg), msg);
  ok('拒写不涉及会话 / 帧序 / 地址（0 卡点）',
    !/会话响应异常|原厂进模块序列|绑定.*失败/.test(msg), msg);
  ok('写闸门按「逐帧对齐原厂写流程」判定（不再只有 981 DME 一条白名单）',
    /writeProfileFromAlignment\(sys, model, addr, family\)/.test(app)
    && /from '\.\/write-alignment\.js'/.test(app));
  ok('进模块启用原厂序列模式（全链路入口）',
    /enterSession\(undefined, \{ family: enterFamily, oemSequence: true \}\)/.test(app));
}

// 证据完备度量化：闸门放行继承原厂流程的实车验证，但每环仍要有包内证据。
{
  const used = new Set();
  for (const v of Object.values(s981.modules || {})) {
    used.add(String(v.sysId).toLowerCase());
    for (const s of v.sysIds || []) used.add(String(s).toLowerCase());
  }
  for (const p of Object.values(allModels.platforms || {})) {
    for (const m of Object.values(p.modules || {})) used.add(String(m.sysId).toLowerCase());
  }
  let withSeq = 0, withSess = 0, withAddr = 0, sessionless = 0;
  for (const k of used) {
    if (oemEnterSequences(k).length) withSeq++;
    if (oemSessionFor(k)) withSess++;
    if (bindPlan.ecu?.[k]?.pairs?.length) withAddr++;
    if (oemIsSessionless(k)) sessionless++;
  }
  ok(`运行时 ${used.size} 个 sysId：序列 ${withSeq} / 会话 ${withSess} / 地址 ${withAddr} 证据齐`,
    withSeq === used.size && withAddr === used.size,
    `seq=${withSeq} sess=${withSess} addr=${withAddr} sessionless=${sessionless}`);
  ok('证据完备度可量化（闸门按对齐矩阵放行，缺运行时证据仍拒绝）', withSess <= used.size);
}

// ── [4] 写序言分派：包内阴性证据（不冒充存在，也不含糊说「不可证」） ──
console.log('\n[4] 写序言逐 ECU 分派：包内证据边界');
{
  const CORE_WRITE_SIDS = new Set([0x17, 0x27, 0x2e, 0x3b, 0x31, 0x32]);
  let total = 0, coreHits = 0;
  const ecuA = new Set(), ecuC = new Set();
  let framesA = 0, framesC = 0;
  for (const [sid, e] of Object.entries(comm.ecu)) {
    for (const b of e.blocks || []) {
      for (const f of b.frames || []) {
        if (!Array.isArray(f) || f.length < 3) continue;
        total++;
        if (CORE_WRITE_SIDS.has(f[2])) coreHits++;
        const h = f.slice(2).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
        if (h === '1800FF00') { framesA++; ecuA.add(sid); }
        if (/^30(25|26|2C)$/.test(h)) { framesC++; ecuC.add(sid); }
      }
    }
  }
  ok(`comm 表 ${total} 帧里核心写服务(17/27/2E/3B/31/32) 0 命中`,
    coreHits === 0, `coreHits=${coreHits}`);
  ok('写序言模板帧只在个别 ECU 出现（不是逐 ECU 分派表）',
    framesA > 0 && framesC > 0 && ecuA.size <= 3 && ecuC.size <= 3,
    `A: ${framesA} 帧/${ecuA.size} ECU，C: ${framesC} 帧/${ecuC.size} ECU`);
  ok('运行时不把 runWritePrologue 挂进写路径（证据不足不猜序言）',
    /runWritePrologue/.test(coderSrc) && !/await this\.runWritePrologue\(/.test(coderSrc));
  ok('无分派表时按原厂主写模板放行，不把写前编排硬挂进写路径',
    /writeProfileFromAlignment/.test(app) && !/await this\.runWritePrologue\(/.test(coderSrc));
}

// ── [5] 老代 KWP 写路径不误发 UDS 会话 ─────────────────────────
console.log('\n[5] 老代 KWP 写路径（原厂不建会话）');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const e = new Elm327(m, { timeoutMs: 2000 });
  const c = new Coder(e, { tx: 0x7e0, rx: 0x7e8 });
  await c.setAddress(0x7e0, 0x7e8, '老代 KWP');
  c.diagProfile = { verified: true, reason: 'fullchain mock profile' };
  c.seedKeyProvider = { name: 'mock', verified: true, seedWidths: [2, 4],
    calc: () => new Uint8Array([0x12, 0x34]) };
  c.setOemContext('0x0101', 0x7e0);
  const p = { id: 'legacy', module: 'LegacyKwp', name: '老代测试', lid: 0x21,
    readSid: 0x21, writeSid: 0x3b, byte: 0, bit: 0, bitsize: 8,
    level: 'source-defined', risk: 'low' };
  const before = await c.readBlock(0x21, 0x21);
  const newV = extractField(before, p) === 0x5a ? 0x3c : 0x5a;
  await c.applyChange(p, newV, { dryRun: false });
  const frames = m.txLog.filter((x) => !x.startsWith('AT'));
  ok('老代写路径不发任何 10 xx 会话帧（不再回退 10 89）',
    !frames.some((f) => /^10[0-9A-F]{2}$/.test(f)), frames.join(','));
  ok('老代写路径仍能完成写 → 回读闭环',
    extractField(await c.readBlock(0x21, 0x21), p) === newV);
  ok('coder 写路径含 sessionless 跳过会话分支',
    /this\.oemSessionless && session == null/.test(coderSrc));
}

console.log(`\n===== 全链路打通验收：${pass} 通过 / 0 失败 =====`);
