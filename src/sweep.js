/**
 * sweep.js — 诊断段枚举 + 身份映射（补「无候选」模块）。
 *
 * 背景（RE-DISCOVERY-20261110）：
 *   参考诊断仪的绑定入参是**请求键**，地址由链路层解析；我们没有那一层，
 *   所以「表 A 没有诊断段行」的模块只能靠**运行时枚举**拿到候选。
 *
 * 两层：
 *   ① 扫：0x700–0x7FF 每地址 1 帧 `22 14 09`，只认「回帧 ID == tx+8」的应答；
 *   ② 认：对活地址读 `22 F1 A2`，用 DSN 识别串注册表（identToVariant）把它归到模块。
 *
 * 纯函数放这里（可单测），IO 在 app 侧。
 */

export const DIAG_LO = 0x700;
export const DIAG_HI = 0x7ff;

/** 11 位物理寻址：请求 ID → 应答 ID（业内惯例 +8；网关例外由回帧 ID 兜） */
export function rxFor(tx) {
  return (tx & 0x7ff) + 8;
}

/** 枚举计划：逐地址一个候选（跳过已知不必扫的） */
export function sweepPlan({ from = DIAG_LO, to = DIAG_HI, skip = [] } = {}) {
  const out = [];
  const skipSet = new Set(skip.map((x) => Number(x)));
  for (let tx = from; tx <= to; tx++) {
    if (skipSet.has(tx)) continue;
    out.push({ tx, rx: rxFor(tx) });
  }
  return out;
}

/**
 * 扫一帧的结果归类。
 * @param {{tx:number, rx:number}} cand
 * @param {number[]} ids      应答帧的 CAN ID（frameIdsOf）
 * @param {string}   body     应答体 hex（剥 PCI 后）
 * @returns {'alive'|'wrong-id'|'silent'}
 */
export function classifyProbe(cand, ids, body) {
  if (!ids.length) return body ? 'alive' : 'silent';   // 适配器没带 ID：只能按有无 body 判
  if (!ids.includes(cand.rx)) return 'wrong-id';       // 别人回的，不算
  return body ? 'alive' : 'silent';
}

/**
 * 识别串 → 模块名。
 * identToVariant 的键是码（如 "P200"），值是 [{module, variant}]；同一码可能跨平台，
 * 这里只取模块名集合，供调用方按「本车菜单里有的模块」过滤，避免跨平台误配。
 */
export function moduleFromIdent(text, identToVariant) {
  const raw = String(text || '').trim();
  if (!raw || !identToVariant) return [];
  const cands = new Set();
  const keys = [raw, raw.split(/\s+/)[0], raw.replace(/[^A-Za-z0-9]/g, '')];
  for (const k of keys) {
    if (!k) continue;
    const hit = identToVariant[k];
    if (Array.isArray(hit)) for (const h of hit) if (h && h.module) cands.add(h.module);
    else if (hit && hit.module) cands.add(hit.module);
  }
  return [...cands];
}

/**
 * 活地址 + 识别串 → { module: {tx, rx, ident} }。
 * 只保留 menuModules 里存在的模块（避免 992/718 的同码模块串进来）。
 */
export function buildModuleMap(live, menuModules = []) {
  const allow = new Set(menuModules);
  const out = {};
  for (const l of live || []) {
    const mods = l.modules && l.modules.length ? l.modules : [];
    for (const m of mods) {
      if (allow.size && !allow.has(m)) continue;
      if (!out[m]) out[m] = { tx: l.tx, rx: l.rx, ident: l.ident || '' };
    }
  }
  return out;
}

/** 缓存新鲜度：同一 VIN、24h 内有效 */
export function cacheFresh(cache, vin, now = Date.now(), ttlMs = 24 * 3600 * 1000) {
  if (!cache || !cache.ts) return false;
  if (vin && cache.vin && cache.vin !== vin) return false;
  return now - cache.ts < ttlMs;
}
