/**
 * addr.js — 手工 CAN 地址覆盖的纯函数（与 DOM/localStorage 解耦，便于回归）。
 *
 * 背景：ECU_ADDR 目前只实测了 DME / 网关，其余模块多为候选或未知。
 * 地址扫描能发现「车上有哪些地址」，但**没有模块名 → 地址的映射表**，
 * 所以扫描结果不能自动归属到某个系统。这里提供手工输入 tx/rx 的通道：
 * 用户从扫描日志/参考诊断仪 上抄一对地址后，可保存到 localStorage，下次进模块直接使用。
 *
 * ⚠️ 绝不猜地址：解析失败必须返回 null，由调用方拒绝进入模块。
 */

/** 解析 `7E0/7E8`、`0x7E0 0x7E8`、`7E0,7E8` 三种写法；非法返回 null */
export function parseAddrPair(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const toks = s.split(/[\s,;/]+/).filter(Boolean);
  if (toks.length !== 2) return null;
  const nums = [];
  for (const t of toks) {
    const h = t.replace(/^0x/i, '');
    if (!/^[0-9A-Fa-f]{1,8}$/.test(h)) return null;
    const n = parseInt(h, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0x1fffffff) return null;
    nums.push(n);
  }
  const [tx, rx] = nums;
  // 11-bit 诊断地址实测只在 0x700–0x7FF；29-bit 也允许（>0x7FF）。
  if (tx > 0x7ff) {
    if (tx < 0x18000000 || tx > 0x1fffffff) return null;
  } else if (tx < 0x700) {
    return null;
  }
  if (rx === tx) return null;
  return { tx, rx };
}

/** 从覆盖表里取某个模块的地址；表项格式 { [label]: {tx,rx} } */
export function overrideFor(label, overrides) {
  const rec = overrides && overrides[label];
  if (!rec || !Number.isFinite(rec.tx) || !Number.isFinite(rec.rx)) return null;
  if (rec.tx === rec.rx) return null;
  return { tx: rec.tx, rx: rec.rx, state: 'manual', note: '手工输入/已保存' };
}
