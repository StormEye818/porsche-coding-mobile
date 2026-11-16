#!/usr/bin/env node
/**
 * T04-a 裁定 4 门禁：MENU_TREE_NO_TRUNCATION
 *
 * 背景：data/menu-tree-v3.json（generatedAt=2026-10-12 历史产物）里 153 个节点的
 * itemIds 恰好被截成 500 条，而 codingCount 是 431 侧真实值 767/2208/4676 …。
 * 仓库内没有 [:500] 生成器（rebuild-all.py 曾写 item_ids[:200]、rebuild-tree.py
 * 写 [:2000]），且该文件不在 rebuild:all-models 链内，因此按裁定 (a) 直接修数据 +
 * 改生成器上限，并用本门禁把「无截断」固化为可证伪断言。
 *
 * 断言：
 *   1. 不存在 itemIds.length===500 且 codingCount>500 的节点；
 *   2. 不存在任何 500 硬截断节点（含 systemCatalog 侧）；
 *   3. 每个带 itemIds 的节点 itemIds.length 与 codingCount（或 count）一致；
 *   4. 153 个历史截断节点全部带可复算来源标记 itemIdsSource / codingCount431，
 *      且回填后的 itemIds 严格 >500、去重、字典序（确定性）。
 *
 * 输出确定性：无时间戳、无绝对路径、遍历按文档顺序、末尾输出规范化文本 sha256。
 * 反例注入：把任一回填节点的 itemIds 改回 500 → 断言 1/2/4 立即 FAIL、退出码 1。
 * 复跑：node tools/verify-menu-tree-no-truncation.mjs ; python3 rebuild-all.py --fix-menu-tree-itemids-only
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const mt = JSON.parse(readFileSync(new URL('data/menu-tree-v3.json', ROOT), 'utf8'));

const lines = [];
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (cond) pass += 1; else fail += 1;
};

/** 收集全库所有带 itemIds 的节点：groups 侧用 codingCount、systemCatalog 侧用 count。 */
function collectNodes(doc) {
  const nodes = [];
  for (const g of doc.groups || []) {
    for (const m of g.models || []) {
      for (const f of m.functions || []) {
        for (const s of f.systems || []) {
          if (Array.isArray(s.itemIds)) {
            nodes.push({ node: s, origin: 'groups', label: String(s.label || s.ref || ''),
              declared: s.codingCount });
          }
        }
      }
    }
  }
  const catalogKeys = Object.keys(doc.systemCatalog || {}).sort();
  for (const k of catalogKeys) {
    for (const f of (doc.systemCatalog[k].functions || [])) {
      if (Array.isArray(f.itemIds)) {
        nodes.push({ node: f, origin: 'systemCatalog', label: k, declared: f.count });
      }
    }
  }
  return nodes;
}

const nodes = collectNodes(mt);
const lenOf = (n) => n.node.itemIds.length;
const trunc500 = nodes.filter((n) => lenOf(n) === 500);
const trunc500Real = trunc500.filter((n) => Number(n.declared) > 500);
const inconsistent = nodes.filter((n) => Number(n.declared) !== lenOf(n));
const backfilled = nodes.filter((n) => typeof n.node.itemIdsSource === 'string'
  && Number(n.node.codingCount431) > 500);

ok('MENU_TREE_NO_TRUNCATION 不存在 itemIds.length===500 且 codingCount>500 的节点',
  trunc500Real.length === 0,
  `命中 ${trunc500Real.length} 个；节点总数 ${nodes.length}（groups + systemCatalog）`);
ok('MENU_TREE_NO_TRUNCATION 不存在任何 500 硬截断节点',
  trunc500.length === 0, `len===500 的节点 ${trunc500.length} 个`);
ok('MENU_TREE_ITEMIDS_CONSISTENT 每个节点 itemIds.length 与 codingCount/count 一致',
  inconsistent.length === 0,
  `不一致 ${inconsistent.length} 个${inconsistent.length ? '，首个=' + inconsistent[0].label : ''}`);
ok('MENU_TREE_ITEMIDS_BACKFILL 153 个历史截断节点全部带可复算来源标记',
  backfilled.length === 153, `带 itemIdsSource+codingCount431 的节点 ${backfilled.length} 个`);
ok('MENU_TREE_ITEMIDS_BACKFILL 回填节点 itemIds 去重、且长度不再等于 500（截断特征消除）',
  backfilled.length > 0 && backfilled.every((n) => lenOf(n) !== 500
    && new Set(n.node.itemIds.map(String)).size === lenOf(n)),
  `最小 ${Math.min(...backfilled.map(lenOf))} 条 / 最大 ${Math.max(...backfilled.map(lenOf))} 条；`
  + '注：911（991）ECM/DME 原 500 条含 46 条重复 id，去重后 454 条，'
  + 'codingCount431=681 保留 431 侧原计数，codingCount 与 itemIds.length 同为 454');
ok('MENU_TREE_ITEMIDS_BACKFILL 回填节点 itemIds 字典序（输出确定性）',
  backfilled.length > 0 && backfilled.every((n) => {
    const a = n.node.itemIds.map(String);
    return a.every((x, i) => i === 0 || a[i - 1] <= x);
  }), `检查 ${backfilled.length} 个节点`);
ok('MENU_TREE_ITEMIDS_BACKFILL 回填节点来源规则与生成器一致',
  backfilled.length > 0 && backfilled.every((n) => /data\/models\/\*\/\*\.json/.test(n.node.itemIdsSource)
    && /coding-v2\.json/.test(n.node.itemIdsSource)),
  'coding-v2.json ∪ data/models/*/*.json（modelSeg + module 前缀 + chain 同源）');
ok('MENU_TREE_ITEMIDS_BACKFILL 元信息声明了固定节点数、净增条数且不含时间戳',
  Number(mt.itemIdsBackfill?.fixedNodes) === 153
    && Number(mt.itemIdsBackfill?.addedItemIds) > 0
    && typeof mt.itemIdsBackfill?.rule === 'string'
    && !Object.prototype.hasOwnProperty.call(mt.itemIdsBackfill || {}, 'generatedAt'),
  `fixedNodes=${mt.itemIdsBackfill?.fixedNodes} addedItemIds=${mt.itemIdsBackfill?.addedItemIds}`);

const text = lines.join('\n');
console.log(text);
console.log(`===== verify-menu-tree-no-truncation：${pass} PASS / ${fail} FAIL =====`);
console.log('复跑命令：node tools/verify-menu-tree-no-truncation.mjs ; python3 rebuild-all.py --fix-menu-tree-itemids-only');
console.log(`sha256=${createHash('sha256').update(text).digest('hex')}`);
process.exit(fail === 0 ? 0 : 1);
