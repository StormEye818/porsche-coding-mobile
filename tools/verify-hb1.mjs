#!/usr/bin/env node
/**
 * verify-hb1.mjs — HB-1 10 条硬断言（PRD §3.1 HB-1 / §7 T5）。
 *
 * HB1-T5-01 runtimeModules 全平台非空（9X6 29 / 9X7 41 行映射，9X7 有 1 网关特例）
 * HB1-T5-02 canonicalType 严格超集硬校验（9X6 12/14 ⊃ 10/14；9X7 33/34 ⊃ 30/34 ⊃ 20/34）
 * HB1-T5-03 9X6 29/29 + 9X7 41/41 唯一 (module,type,fullSysId)
 * HB1-T5-04 fullSysId 全部 ^0x[0-9A-F]{4}$ 且落在权威 sysIds 集合
 * HB1-T5-05 E1_ 跨代 0x0346 / 0x0319 + _9x7_pcm2_gw 网关特例
 * HB1-T5-06 静态等价集三档（共享 / 仅 echo / 真差异）
 * HB1-T5-07 gen=null / apply=false / runtimeModules:{} 归零
 * HB1-T5-08 17 槽 VIN TBB 字节 8e09acac…51 + 返回值集 1..22
 * HB1-T5-09 三处阳性 VA 坐标复跑退出码 0
 * HB1-T5-10 R-4 结案词归零
 *
 * 跑法：npm run verify:hb1   （或 node tools/verify-hb1.mjs）
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readJson, readText, scanForbiddenWords, FORBIDDEN_CLASSES, sortedKeys } from './align431-eval.mjs';

let pass = 0, fail = 0;
const L = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; L.push(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; L.push(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const dsn = readJson('data/dsn-module-sysids.json');
const vim = readJson('data/vehicle-id-type-map.json');
const vin = readJson('data/vin-type-table.json');
const rt = readJson('data/sysdata-root-table.json');
const allm = readJson('data/all-model-sysids.json');
if (!dsn || !vim || !vin || !rt || !allm) {
  console.error('缺少 data/*.json，请先跑数据重建链（build-vin-type-table / build-dsn-module-sysids / export-all-model-sysids）');
  process.exit(2);
}
const p6 = dsn.platforms?.['9x6'];
const p7 = dsn.platforms?.['9x7'];

L.push('=== HB-1 十条硬断言（PRD §3.1 HB-1 / §7 T5） ===');

// ── 01 runtimeModules 全平台非空 ────────────────────────────────────
{
  const all = Object.entries(dsn.platforms || {});
  const empties = all.filter(([, e]) => !e.runtimeModules || Object.keys(e.runtimeModules).length === 0);
  const n6 = p6 ? Object.keys(p6.runtimeModules).length : 0;
  const n7 = p7 ? Object.keys(p7.runtimeModules).length : 0;
  ok('HB1-T5-01 runtimeModules 全平台非空（9X6 29 / 9X7 40 + 1 网关特例；留空=0）',
    all.length === 14 && empties.length === 0 && n6 === 29 && n7 === 40
      && dsn.stats.emptyRuntimeModulesCount === 0,
    `平台=${all.length} 留空=${empties.length} 9x6=${n6} 9x7=${n7} 9x7映射行=${p7?.mappingCount}`);
}

// ── 02 canonicalType 严格超集硬校验 ─────────────────────────────────
{
  const lowByType = {};
  for (const t of sortedKeys(rt.types || {})) {
    lowByType[parseInt(t, 16)] = new Set((rt.types[t].sysIds || []).map((s) => parseInt(s, 16) & 0xff));
  }
  const checks = [];
  for (const [plat, types, canon] of [['9X6', [1, 2], 1], ['9X7', [5, 6, 4], 5]]) {
    const proof = vim.supersetProof?.[plat] || {};
    const best = lowByType[canon] || new Set();
    let strict = true;
    for (const t of types) {
      if (t === canon) continue;
      const other = lowByType[t] || new Set();
      if (![...other].every((l) => best.has(l)) || best.size <= other.size) strict = false;
    }
    const cov = {};
    for (const t of types) cov['0x' + t.toString(16).toUpperCase().padStart(2, '0')] = lowByType[t].size + '/' + proof.uniqueLow;
    checks.push({ plat, strict, cov, proofCov: proof.coverage, canon: vim.canonicalType?.[plat] });
  }
  const c6 = checks[0], c7 = checks[1];
  ok('HB1-T5-02 canonicalType 严格超集硬校验（9X6 0x01 12/14 ⊃ 10/14；9X7 0x05 33/34 ⊃ 30/34 ⊃ 20/34）',
    c6.strict && c7.strict
      && vim.canonicalType['9X6'] === '0x01' && vim.canonicalType['9X7'] === '0x05'
      && dsn.platforms['9x6'].canonicalType === '0x01' && dsn.platforms['9x7'].canonicalType === '0x05'
      && c6.proofCov['0x01'] === '12/14' && c6.proofCov['0x02'] === '10/14'
      && c7.proofCov['0x05'] === '33/34' && c7.proofCov['0x06'] === '30/34' && c7.proofCov['0x04'] === '20/34',
    `9X6=${JSON.stringify(c6.cov)} 9X7=${JSON.stringify(c7.cov)}`);
}

// ── 03 唯一 (module,type,fullSysId) 29/29 + 41/41 ───────────────────
{
  const uniq = (e) => {
    const s = new Set((e.moduleMappings || []).map((m) => `${m.module}|${m.type}|${m.fullSysId}`));
    return { rows: (e.moduleMappings || []).length, uniq: s.size };
  };
  const u6 = uniq(p6), u7 = uniq(p7);
  ok('HB1-T5-03 9X6 29/29 + 9X7 41/41 唯一 (module,type,fullSysId)',
    u6.rows === 29 && u6.uniq === 29 && u7.rows === 41 && u7.uniq === 41
      && p6.unresolvedCount === 0 && p7.unresolvedCount === 0,
    `9X6=${u6.uniq}/${u6.rows} 9X7=${u7.uniq}/${u7.rows} unresolved=${p6.unresolvedCount + p7.unresolvedCount}`);
}

// ── 04 fullSysId 格式 + 权威集合 ────────────────────────────────────
{
  const fullByType = {};
  for (const t of sortedKeys(rt.types || {})) {
    fullByType[parseInt(t, 16)] = new Set((rt.types[t].sysIds || []).map((s) => parseInt(s, 16)));
  }
  const bad = [];
  for (const [name, e] of Object.entries(dsn.platforms || {})) {
    for (const m of e.moduleMappings || []) {
      if (m.gatewayNoSysId || m.noSysIdSubmodule) continue;
      if (!/^0x[0-9A-F]{4}$/.test(m.fullSysId || '')) { bad.push(`${name}/${m.module}:格式`); continue; }
      const v = parseInt(m.fullSysId, 16);
      if (!fullByType[v >> 8]?.has(v)) bad.push(`${name}/${m.module}:不在权威集合`);
    }
  }
  ok('HB1-T5-04 fullSysId 全部 ^0x[0-9A-F]{4}$ 且落在权威 sysIds 集合',
    bad.length === 0, `非法=${bad.length} ${bad.slice(0, 3).join(',')}`);
}

// ── 05 E1_ 跨代 + 网关特例 ──────────────────────────────────────────
{
  const cross = dsn.crossGenModules || [];
  const sids = new Set(cross.map((m) => m.fullSysId));
  const gw = dsn.gatewayNoSysId || [];
  const gwInRuntime = gw.some((g) => Object.prototype.hasOwnProperty.call(p7.runtimeModules || {}, g.name));
  ok('HB1-T5-05 E1_ 跨代 9 条含 0x0346 / 0x0319 + _9x7_pcm2_gw gatewayNoSysId 且不进 runtimeModules',
    cross.length === 9 && sids.has('0x0346') && sids.has('0x0319')
      && gw.length === 1 && gw[0].name === '_9x7_pcm2_gw'
      && p7.gatewayNoSysIdCount === 1 && !gwInRuntime,
    `跨代=${cross.length} sids=${[...sids].sort().join(',')} 网关=${gw.map((g) => g.name).join(',')}`);
}

// ── 06 静态等价集三档 ───────────────────────────────────────────────
{
  const tiers = vim.staticEquivalence?.tiers || [];
  const labels = tiers.map((t) => t.tier).sort();
  const sum = (e) => (e.shared || 0) + (e.echoOnly || 0) + (e.trueDiffer || 0);
  const b6 = vim.staticEquivalence?.byPlatform?.['9X6'] || {};
  const b7 = vim.staticEquivalence?.byPlatform?.['9X7'] || {};
  ok('HB1-T5-06 静态等价集三档（共享 / 仅 echo / 真差异）齐全且计数闭合',
    labels.join(',') === 'echoOnly,shared,trueDiffer'
      && sum(b6) === 29 && sum(b7) === 41
      && b6.unresolved === 0 && b7.unresolved === 0 && b6.unknownFallback === 0 && b7.unknownFallback === 0,
    `9X6=${sum(b6)}/29 9X7=${sum(b7)}/41 tiers=${labels.join(',')}`);
}

// ── 07 gen=null / apply=false / runtimeModules:{} 归零 ───────────────
{
  const genNull = [], applyFalse = [], emptyRt = [];
  for (const [p, e] of Object.entries(allm.platforms || {})) {
    if (!e.gen) genNull.push(p);
    if (e.applyPlatformSysIds === false) applyFalse.push(p);
    if (!e.modules || Object.keys(e.modules).length === 0) emptyRt.push(p);
  }
  for (const [m, e] of Object.entries(allm.models || {})) {
    if (e.applyPlatformSysIds === false) applyFalse.push(`model:${m}`);
    if (!e.gen) genNull.push(`model:${m}`);
  }
  const srcGen = readText('src/model-sysid-map.js') || '';
  const dsnEmpty = Object.values(dsn.platforms || {}).filter((e) => Object.keys(e.runtimeModules || {}).length === 0).length;
  ok('HB1-T5-07 gen=null / apply=false / runtimeModules:{} 归零',
    genNull.length === 0 && applyFalse.length === 0 && emptyRt.length === 0 && dsnEmpty === 0
      && !/apply=false/.test(JSON.stringify(allm)),
    `genNull=${genNull.length} applyFalse=${applyFalse.length} 空modules=${emptyRt.length} dsn空表=${dsnEmpty} src长度=${srcGen.length}`);
}

// ── 08 17 槽 VIN TBB ────────────────────────────────────────────────
{
  ok('HB1-T5-08 17 槽 VIN TBB 字节 8e09acac…51 + 返回值集 1..22',
    vin.tbbHex === '8e09acac1eac263543acacacacacacac51'
      && vin.tbbSlots === 17 && vin.slots.length === 17
      && vin.returnValueSet.every((x) => Number.isInteger(x) && x >= 1 && x <= 22)
      && JSON.stringify(vin.returnValueSet) === JSON.stringify([3, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22])
      && vin.stats.vaEqualsFileOffset === true,
    `tbbHex=${vin.tbbHex} slots=${vin.tbbSlots} cases=${vin.rows.length} returnSet=${vin.returnValueSet.length}`);
}

// ── 09 三处阳性 VA 坐标复跑退出码 0 ─────────────────────────────────
{
  const SO = '/Users/se818/porsche-mapper/ref/porche-v24.58/V24.58';
  // 包内文件名可能带厂商前缀：按短名解析实际文件，源码不写死前缀
  const resolveSo = (name) => {
    const direct = `${SO}/${name}`;
    return existsSync(direct) ? direct : `${SO}/lib${name}`;
  };
  const probes = [
    { name: 'PORSCHE_SYSP.so:0x2634E (22 槽 TBB)', so: resolveSo('PORSCHE_SYSP.so'), va: 0x2634E, expect: '0e0e140b0b0b171717171a1d1111202326292c2f3235' },
    { name: 'PORSCHE_READWRITE.so:0x147CD6 (17 槽 TBB)', so: resolveSo('PORSCHE_READWRITE.so'), va: 0x147CD6, expect: '8e09acac1eac263543acacacacacacac51' },
    { name: 'PORSCHE_SYSP.so:0x56CBD (串池)', so: resolveSo('PORSCHE_SYSP.so'), va: 0x56CBD, expect: '39583600453100' },
  ];
  const results = [];
  for (const p of probes) {
    try {
      // 独立 Node 字节复跑（等价于 disasm-elf.py 的 VA→文件偏移），退出码 0 即命中
      const out = execFileSync(process.execPath, ['-e',
        `const b=require('fs').readFileSync(${JSON.stringify(p.so)});process.stdout.write(b.subarray(${p.va},${p.va}+${p.expect.length / 2}).toString('hex'))`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      results.push({ name: p.name, hit: out === p.expect, got: out });
    } catch (e) {
      results.push({ name: p.name, hit: false, got: 'exec-fail:' + (e.status ?? 'err') });
    }
  }
  ok('HB1-T5-09 三处阳性 VA 坐标独立复跑（字节命中 / 退出码 0）',
    results.every((r) => r.hit),
    results.map((r) => `${r.name}=${r.hit ? 'OK' : r.got}`).join(' ; '));
}

// ── 10 R-4 结案词归零 ───────────────────────────────────────────────
{
  const fw = scanForbiddenWords();
  const artifacts = ['data/dsn-module-sysids.json', 'data/vehicle-id-type-map.json', 'data/vin-type-table.json'];
  const badArtifacts = [];
  for (const f of artifacts) {
    const t = readText(f) || '';
    for (const cls of sortedKeys(FORBIDDEN_CLASSES)) {
      for (const w of FORBIDDEN_CLASSES[cls]) {
        if (t.includes(w)) badArtifacts.push(`${f}:${cls}`);
      }
    }
  }
  ok('HB1-T5-10 R-4 结案词归零（全库 .md + 本批次三份 data/*.json）',
    fw.asClosingReason === 0 && badArtifacts.length === 0,
    `作为结案理由命中=${fw.asClosingReason} 产物命中=${badArtifacts.length} ${badArtifacts.slice(0, 3).join(',')}`);
}

L.push('');
L.push(`===== HB-1：${pass} 通过 / ${fail} 失败 =====`);
L.push('复跑命令：npm run verify:hb1 ; node tools/build-vin-type-table.mjs ; node tools/build-dsn-module-sysids.mjs');
L.push(`结论：${fail === 0 ? '10 条 HB1-T5 断言全 PASS' : '存在失败断言'}，退出码=${fail === 0 ? 0 : 1}`);
process.stdout.write(L.join('\n') + '\n');
process.exit(fail === 0 ? 0 : 1);
