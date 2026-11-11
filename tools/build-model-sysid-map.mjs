#!/usr/bin/env node
/**
 * build-model-sysid-map.mjs — 把 data/all-model-sysids.json 编译成 src/model-sysid-map.js。
 *
 * 为什么编译而不是 fetch：app.js 的地址解析是同步链（addrEntryFor/ecuAddrFromTable），
 * 引入异步 fetch 会破坏 981 已验收的确定性行为；编译成静态 ES module 零网络、零竞态。
 *
 * 生成内容：
 *   MODEL_SYSID_INDEX  车型 label → {platform,gen,confidence,apply}
 *   PLATFORM_MODULES   平台 → {gen, modules:{模块名: sysId}}（只含 high/medium）
 *   SYSTEM_LABEL_BASE  中文菜单标签 → 981 全局 sysId（编译自 module-ecu-map.js）
 *   sysIdForModule(name, modelLabel)      平台专属 sysId（无证据 → null，绝不猜）
 *   modulesForSysId(sysId, modelLabel)     平台专属 sysId 反查模块名（统计/日志用）
 *
 * 跑法： node tools/build-model-sysid-map.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(readFileSync(path.join(ROOT, 'data/all-model-sysids.json'), 'utf8'));
// 中文菜单标签 → 全局 sysId（编译自 src/module-ecu-map.js 的 SYSTEM_TO_ECUID 块）
const ecuSrc = readFileSync(path.join(ROOT, 'src/module-ecu-map.js'), 'utf8');
const sysBlock = ecuSrc.slice(ecuSrc.indexOf('export const SYSTEM_TO_ECUID'));
const labelBase = {};
for (const m of sysBlock.matchAll(/"([^"]+)"\s*:\s*"(0x[0-9a-fA-F]{4})"/g)) labelBase[m[1]] = m[2];

const index = {};
for (const [model, e] of Object.entries(doc.models || {})) {
  index[model] = {
    platform: e.platform, gen: e.gen, confidence: e.confidence,
    apply: !!e.applyPlatformSysIds,
  };
}
const plat = {};
for (const [p, e] of Object.entries(doc.platforms || {})) {
  if (!['high', 'medium'].includes(e.confidence)) continue;
  const modules = {};
  for (const [name, m] of Object.entries(e.modules || {})) if (m.sysId) modules[name] = m.sysId;
  plat[p] = { gen: e.gen, confidence: e.confidence, modules };
}

const body = `// ⚠️ 自动生成，勿手改。源：data/all-model-sysids.json（tools/export-all-model-sysids.py）
// 编译：node tools/build-model-sysid-map.mjs
// RE-CODINGADDR-20261110 §6 步骤1-3 在全量车型的落地：25 车型 / ${Object.keys(plat).length} 平台定案。
export const MODEL_SYSID_INDEX = ${JSON.stringify(index, null, 1)};
export const PLATFORM_MODULES = ${JSON.stringify(plat, null, 1)};
export const SYSTEM_LABEL_BASE = ${JSON.stringify(labelBase, null, 1)};

const norm = (x) => String(x ?? '').toLowerCase();
const lowByte = (hex) => parseInt(hex, 16) & 0xff;

/** 车型 label → 平台信息；未定案/低置信平台返回 null（调用方回退全局表，不猜）。 */
export function platformInfoFor(modelLabel) {
  const i = MODEL_SYSID_INDEX[String(modelLabel ?? '').trim()];
  return i && i.apply ? i : null;
}

/** 模块名 → 当前平台专属 sysId；无证据返回 null。 */
export function sysIdForModule(name, modelLabel) {
  const i = platformInfoFor(modelLabel);
  if (!i) return null;
  return PLATFORM_MODULES[i.platform]?.modules?.[name] ?? null;
}

/** sysId → 模块名（平台专属优先，全局表兜底）。 */
export function modulesForSysId(sysId, modelLabel) {
  const i = platformInfoFor(modelLabel);
  const out = [];
  if (i) {
    const mods = PLATFORM_MODULES[i.platform]?.modules || {};
    for (const [n, s] of Object.entries(mods)) if (norm(s) === norm(sysId)) out.push(n);
  }
  return out;
}

/**
 * ★ 2026-11-11 全链路审计 P0 修复：bind-plan 的键必须按「当前车型平台 sysId」直查。
 * 旧链路 addrEntryFor() 只在 ecu-addresses.json（209 条旧代表A 条目）里找 sysId，
 * 新代 0x10/0x12/0x14/0x15/0x16 的 sysId 全部不在该表 → entry=null →
 * bindPlanFor(null) 拿不到计划 → 本轮生成的 191 个新代静态候选运行时不可达，
 * 还会经 aliasEntryFor 回退到旧代地址（错代）。此函数用平台映射直接给出键。
 * 顺序与 addrEntryFor 一致：①中文菜单标签 ②模块名 ③旧表条目 sysId（兜底）。
 */
/**
 * ★ 2026-11-11 431 对齐（CODE-AUDIT §4.2 偏离⑧）：bind-plan 键只按
 * ①**模块名精确查**平台映射（all-model-sysids 的精确 join）② 981 全局标签基值
 * ③旧地址表实际命中的 sysId 兜底。删除「家族低字节跨代平移」自创推断。
 * 顺序与 addrEntryFor 一致：模块名 → 中文标签（仅 981）→ 旧表条目 sysId。
 */
export function planSysIdFor(label, modules, modelLabel, entrySysId) {
  for (const m of modules || []) {
    const s = sysIdForModule(m, modelLabel);
    if (s) return s;
  }
  const info = platformInfoFor(modelLabel);
  const g = SYSTEM_LABEL_BASE[String(label ?? '')] || null;
  if (info && info.gen === '0x0e') return g || entrySysId || null;
  return entrySysId || null;
}
`;
const out = path.join(ROOT, 'src/model-sysid-map.js');
writeFileSync(out, body, 'utf8');
console.log(`写出 src/model-sysid-map.js: ${Object.keys(index).length} 车型 / ${Object.keys(plat).length} 平台 / ${Object.values(plat).reduce((a, p) => a + Object.keys(p.modules).length, 0)} 模块映射`);
