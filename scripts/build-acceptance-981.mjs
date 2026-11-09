#!/usr/bin/env node
/**
 * data/acceptance-981-modules.tsv —— 981 菜单可达模块逐个地址列（RE-ICADDR-20261109 通用口径）。
 *
 * 四元组表（模块 | 家族 | 变体 | 地址）：家族/变体列由另一 agent 合并填写，本工具只产地址列。
 * 地址列口径（通用 internal→tx/rx join，零特判、零近似）：
 *   - join 键 = SYS_DATA 表B 行 f1（routing internal，精确）；
 *   - tx/rx = 表A 行（f0=tx）按 **精确 internal join**；每行给 表A 行偏移 证据；
 *   - 无精确表A 行 → state=unresolved（未决，如 KWP IC 0x02F9），不出地址不猜；
 *   - proven 锚点标 proven；family 列给 DRIVELINKS 14B 记录族（运行时身份探测候选）。
 *
 * 跑法: node scripts/build-acceptance-981.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MODULE_TO_ECUID, SYSTEM_TO_ECUID } from '../src/module-ecu-map.js';

const cat = JSON.parse(readFileSync(new URL('../data/models-catalog.json', import.meta.url), 'utf8'));
const ea = JSON.parse(readFileSync(new URL('../data/ecu-addresses.json', import.meta.url), 'utf8'));

const entryBy = new Map();
for (const e of ea.entries || []) entryBy.set(String(e.sysId).toLowerCase(), e);

const rows = [];
const seen = new Set();
for (const key of ['Cayman（981）', 'Boxster（981）']) {
  const m = cat.models[key];
  if (!m) continue;
  for (const mod of m.modules || []) {
    const name = mod.module;
    if (seen.has(name)) continue;
    seen.add(name);
    const sysId = (MODULE_TO_ECUID[name] || SYSTEM_TO_ECUID[name] || '').toLowerCase();
    const e = sysId ? entryBy.get(sysId) : null;
    let joinKey = '', txs = '', rxs = '', state = '', evidence = '', fam = '';
    if (!e) {
      state = 'no-entry';
      evidence = 'module-ecu-map 无 sysId 或 sysId 不在 DRIVELINKS 目录';
    } else {
      // join 键 = internals（表B f1 精确键集合）
      joinKey = (e.internals || []).join(';');
      const cands = e.cands || [];
      if (e.confidence === 'proven') state = 'proven';
      else if (cands.length) state = 'exact-join';
      else if (e.joinUnresolved?.length) state = 'unresolved';
      else state = 'no-exact-row';
      txs = cands.map((c) => c.tx).join(';') || '未决';
      rxs = cands.map((c) => c.rx).join(';') || '未决';
      evidence = [
        ...(e.joinUnresolved || []).map((u) =>
          `joinUnresolved:${u.internal}/proto${u.proto ?? '?'}@${(u.tabBRows || []).join(',')}`),
        ...cands.map((c) => `${c.tx}@${c.rowOff || '?'}`),
      ].join(' | ');
      if (e.family?.length) {
        fam = e.family.map((f) => `${f.tx}@${f.recOff}`).join(';');
      }
    }
    rows.push([
      name,
      '', // family —— 另一 agent 填
      '', // variant —— 另一 agent 填
      sysId || '未映射',
      joinKey || '未决',
      txs,
      rxs,
      state,
      fam || '无',
      evidence || '-',
    ].join('\t'));
  }
}

const header = [
  'module', 'family', 'variant', 'sysId', 'joinKey', 'tx', 'rx', 'state',
  'familyCandidates', 'addrEvidence',
].join('\t');
const out = header + '\n' + rows.join('\n') + '\n';
writeFileSync(new URL('../data/acceptance-981-modules.tsv', import.meta.url), out);
const st = {};
for (const r of rows) {
  const s = r.split('\t')[7];
  st[s] = (st[s] || 0) + 1;
}
console.log(`acceptance-981-modules.tsv · ${rows.length} 模块 · ${JSON.stringify(st)}`);
