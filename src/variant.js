/**
 * 自动选变体 —— 对齐 431 的「进模块不弹变体选择」。
 *
 * 431 现场是按 ECU 识别（1A 9F/94/92）的 ODX 变体名/模块名自动进入；
 * 我们之前反过来让用户手选，既不像 431，也把多变体模块的写入锁死。
 *
 * 规则（保守、不猜）：
 *   ① 识别文本里含完整变体名 → 精确命中；
 *   ② 含模块名且存在 *_BaseSys → 431 标准变体 BaseSys；
 *   ③ 识别文本是变体名前缀 → 取最短前缀；
 *   ④ 都不中 → 目录默认变体（不阻断只读，写入仍有 selectedVariant 闸门）。
 *
 * @param {{module:string, variant?:string, default?:string, variants?:Array<{name?:string,file?:string}>}} mod
 * @param {string} ident  ECU 识别文本
 * @returns {{name:string, how:string}}
 */
export function autoPickVariant(mod, ident) {
  const recs = (mod?.variants || []).map((v) => ({
    name: v.name || String(v.file || '').replace(/\.json$/i, ''),
    file: v.file,
  })).filter((v) => v.name);
  const def = mod?.variant
    || recs.find((v) => String(v.file) === String(mod?.default))?.name
    || recs[0]?.name
    || String(mod?.default || '').replace(/\.json$/i, '')
    || mod?.module
    || '';
  const names = recs.map((v) => v.name);
  if (!names.length) return { name: def, how: '目录无变体，用默认' };
  const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const N = norm(ident);
  if (!N) return { name: names.includes(def) ? def : names[0], how: '无识别文本，用默认变体' };

  // ① 识别串里直接含有完整变体名（最可靠）
  const exact = names.find((n) => N.includes(norm(n)));
  if (exact) return { name: exact, how: '1A9F/94/92 命中变体名' };

  // ② 识别串含模块名 → BaseSys（431 的标准变体）
  const base = names.find((n) => /_BaseSys$/i.test(n));
  const moduleKey = norm(mod?.module);
  if (base && moduleKey && N.includes(moduleKey)) {
    return { name: base, how: '识别串命中模块名，取 BaseSys' };
  }

  // ③ 识别串是变体名的前缀（如 Kombiinstrument / DME_BDE_Continental）
  const prefix = names
    .filter((n) => norm(n).startsWith(N) || N.startsWith(norm(n)))
    .sort((a, b) => a.length - b.length)[0];
  if (prefix) return { name: prefix, how: '识别串前缀命中变体' };

  return { name: names.includes(def) ? def : names[0], how: '未识别，用 431 默认变体' };
}
