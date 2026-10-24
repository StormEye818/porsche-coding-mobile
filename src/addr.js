/**
 * addr.js — 手工 CAN 地址覆盖的纯函数（与 DOM/localStorage 解耦，便于回归）。
 *
 * 11-bit 诊断地址实测只在 0x700–0x7FF；29-bit 允许 0x18000000–0x1FFFFFFF。
 * tx/rx 必须分别合法，绝不能让 7E0/1、7E0/0 这种写进 localStorage。
 */

function validId(n) {
  if (!Number.isFinite(n) || n < 0) return false;
  if (n <= 0x7ff) return n >= 0x700;
  return n >= 0x18000000 && n <= 0x1fffffff;
}

/** 校验一对已解析的数字地址；非法返回 null */
export function validatePair(tx, rx) {
  if (!validId(tx) || !validId(rx)) return null;
  if (tx === rx) return null;
  return { tx, rx };
}

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
  return validatePair(nums[0], nums[1]);
}

/** 从覆盖表里取某个模块的地址；表项格式 { [label]: {tx,rx} } */
export function overrideFor(label, overrides) {
  const rec = overrides && overrides[label];
  if (!rec) return null;
  const pair = validatePair(Number(rec.tx), Number(rec.rx));
  if (!pair) return null;
  return { ...pair, state: 'manual', note: '手工输入/已保存' };
}
