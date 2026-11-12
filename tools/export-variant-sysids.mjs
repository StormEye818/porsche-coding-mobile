#!/usr/bin/env node
/**
 * export-variant-sysids.mjs — 扫描 data/models/* 下所有变体，导出运行时真正会用到的 sysId 集。
 *
 * 背景（2026-11-12 全链路打通验收发现）：25 车型 / 4588 变体里，有 126 个 sysId
 * 被 sysIdForModule() 解析到，却不在 data/bind-plan.json 里 —— 进模块时没有地址候选，
 * 只能靠枚举兜底，是链路上的真实断点。本工具把「变体文件实际用到的 sysId」显式导出，
 * 供 tools/export-bind-plan.py 纳入目标集合并用 comm 子表地址证据补齐。
 *
 * 产物：data/variant-sysids.json
 *   { sysIds: [...], byModel: { 车型: [sysId...] }, unresolved: [ "...", ... ], stats }
 *
 * 跑法：node tools/export-variant-sysids.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sysIdForModule } from '../src/model-sysid-map.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'data', 'models');
const OUT = path.join(ROOT, 'data', 'variant-sysids.json');

const sysIds = new Set();
const byModel = {};
const unresolved = [];
let variants = 0, resolved = 0;

for (const dir of fs.readdirSync(MODELS)) {
  const dirPath = path.join(MODELS, dir);
  if (!fs.statSync(dirPath).isDirectory()) continue;
  for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8')); }
    catch { continue; }
    variants++;
    const items = (j.items || []).filter((it) => it && it.lid != null && it.readSid != null);
    if (!items.length) continue;
    const modName = items[0].module || file.replace(/\.json$/i, '');
    const sid = sysIdForModule(modName, j.model);
    if (!sid) { unresolved.push(`${dir}/${file}:${modName}`); continue; }
    resolved++;
    const key = String(sid).toLowerCase();
    sysIds.add(key);
    (byModel[j.model] ||= new Set()).add(key);
  }
}

const payload = {
  schemaVersion: 1,
  source: 'data/models/*/*.json + src/model-sysid-map.js sysIdForModule()',
  note: '运行时变体文件实际解析到的 sysId 全集；bind-plan 的目标集合应覆盖它',
  sysIds: [...sysIds].sort(),
  byModel: Object.fromEntries(Object.entries(byModel)
    .map(([k, v]) => [k, [...v].sort()]).sort((a, b) => a[0].localeCompare(b[0]))),
  unresolved: unresolved.slice(0, 200),
  stats: {
    models: fs.readdirSync(MODELS).filter((d) => fs.statSync(path.join(MODELS, d)).isDirectory()).length,
    variants, resolved, unresolved: unresolved.length,
    sysIds: sysIds.size,
  },
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`写出 data/variant-sysids.json：${payload.stats.models} 车型 / `
  + `${variants} 变体 / ${sysIds.size} 个 sysId（未解析 ${unresolved.length} 变体）`);
