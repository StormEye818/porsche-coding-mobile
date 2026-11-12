#!/usr/bin/env node
/**
 * sysdata-comm 门禁：SYS_DATA comm 表导出结果与实车锚点/原厂语义对账。
 *
 * 背景（2026-11-11 收口）：此前「逐 ECU 会话被加密体挡住」的结论被推翻——
 * decoded PORSCHE_SYS_DATA.BIN 全量可读，comm 记录给出每个 sysId 的
 * 进模块命令序列（经 COMMAND.GAG 解析成帧）。
 * 本测试钉住：锚点（DME 0x7E0/0x7E8 + 10 89）、会话分布、命令全解析、
 * 以及「981 大多数模块原厂会话是 10 03 而非 10 89」这一对齐事实。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('../data/sysdata-comm.json', import.meta.url), 'utf8'));
let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

// ① 覆盖面
const ecu = doc.ecu;
ok('comm 表覆盖 ≥800 个 sysId', Object.keys(ecu).length >= 800, String(Object.keys(ecu).length));
ok('comm 记录 ≥870 条', doc.stats.records >= 870, String(doc.stats.records));
ok('命令 ID 全部解析（0 缺失）', doc.stats.cmdMiss === 0, `命中 ${doc.stats.cmdHit}`);

// ② DME 实车锚点
const dme = ecu['0x0e01'];
ok('DME 0x0E01 存在且有子记录', !!dme && dme.blocks.some((b) => (b.subs || []).length));
const dmeSub = dme.blocks[0].subs[0];
ok('DME 地址对 = 0x7E0/0x7E8（实车已证）', dmeSub.tx === 0x7e0 && dmeSub.rx === 0x7e8,
  `tx=0x${dmeSub.tx.toString(16)} rx=0x${dmeSub.rx.toString(16)}`);
const dmeFrames = dme.blocks[0].frames || [];
ok('DME 命令帧含 10 89 与 1A 9F', dmeFrames.some((f) => f && f[2] === 0x10 && f[3] === 0x89)
  && dmeFrames.some((f) => f && f[2] === 0x1a && f[3] === 0x9f));

// ③ 进模块会话分布（数据驱动事实）
const sess = doc.stats.sessionFrames;
ok('会话帧以 10 03 为主、10 89 次之（原厂非一律 10 89）',
  Number(sess['0x03'] || 0) > 500 && Number(sess['0x89'] || 0) > 100,
  JSON.stringify(sess));

// ④ 981 模块会话表：32×10 03 / 16×10 89（对齐缺口的量化证据）
const j981 = JSON.parse(readFileSync(new URL('../data/981-sysids.json', import.meta.url), 'utf8')).modules;
const firstSession = (e) => {
  for (const blk of e.blocks) {
    for (const f of blk.frames || []) {
      if (f && f.length >= 4 && f[2] === 0x10) return f[3];
    }
  }
  return null;
};
let s03 = 0, s89 = 0, missing = [];
for (const [name, info] of Object.entries(j981)) {
  const e = ecu[String(info.sysId).toLowerCase()];
  const s = e ? firstSession(e) : null;
  if (s === 0x03) s03++;
  else if (s === 0x89) s89++;
  else missing.push(name);
}
ok('981 模块会话全部可查（0 缺）', missing.length === 0, missing.join(','));
ok('981 会话分布 = 32×10 03 + 16×10 89', s03 === 32 && s89 === 16, `03=${s03} 89=${s89}`);

// ⑤ 家族默认地址只作参考：PASM 记录值 0x755 不在 981 真实地址集合（0x7D0）
const pasm = ecu['0x0e13'];
const pasmSub = (pasm.blocks[0].subs || [{}])[0];
ok('PASM 家族默认 0x755 ≠ 981 实测 0x7D0（地址表须按车型，不能拿 comm 默认值）',
  pasmSub.tx === 0x755, `tx=0x${(pasmSub.tx || 0).toString(16)}`);

// ⑥ 2026-11-12：新代 0x14-0x16 的 comm cat=0x10 地址对接入 bind-plan
//   推翻「0x14-0x16 路由 owner 0 行 = 无地址证据」：证据在 comm 子表内嵌地址对里。
const bind = JSON.parse(readFileSync(new URL('../data/bind-plan.json', import.meta.url), 'utf8'));
const commPairs = new Map();
for (const [sid, e] of Object.entries(ecu)) {
  if (!['0x14', '0x15', '0x16'].includes(sid.slice(0, 4))) continue;
  for (const blk of e.blocks) {
    if (blk.cat !== 0x10) continue;
    for (const s of blk.subs || []) {
      if (s.tx <= 0x7f7 && s.rx <= 0x7ff && s.tx > 0 && s.rx > 0) {
        commPairs.set(sid, { tx: s.tx, rx: s.rx });
      }
    }
  }
}
ok('新代 comm 地址对 = 112 个 sysId', commPairs.size === 112, String(commPairs.size));
let wired = 0, badFirst = [], badRx = [];
for (const [sid, want] of commPairs) {
  const rec = bind.ecu?.[sid];
  const first = rec?.pairs?.[0];
  if (!first) { badFirst.push(sid); continue; }
  if (Number.parseInt(first.tx, 16) !== want.tx) { badFirst.push(sid); continue; }
  if (Number.parseInt(first.rx, 16) !== want.rx) badRx.push(sid);
  const prov = (rec.provenance || []).some((p) => (p.sources || []).includes('commCat10'));
  if (prov) wired++;
}
ok('112 个新代 sysId 首选候选 = comm 本代地址对', badFirst.length === 0,
  badFirst.slice(0, 5).join(','));
ok('112 个新代 sysId 的 rx 取记录自带值（非 tx+8 猜）', badRx.length === 0,
  badRx.slice(0, 5).join(','));
ok('112 个新代 sysId 的 provenance 标 commCat10', wired === 112, String(wired));
ok('新代地址接入不设免探针直绑', [...commPairs.keys()].every((sid) => !bind.ecu?.[sid]?.bindDirect));
ok('981 不受影响：0x0E01 首选仍是 0x7E0/0x7E8',
  bind.ecu?.['0x0e01']?.pairs?.[0]?.tx === '0x07E0'
  && bind.ecu?.['0x0e01']?.pairs?.[0]?.rx === '0x07E8',
  JSON.stringify(bind.ecu?.['0x0e01']?.pairs?.[0]));

console.log(`\n===== sysdata-comm 门禁：${pass} 通过 / 0 失败 =====`);
