/**
 * 自动选变体 —— 对齐 参考诊断仪 的「进模块不弹变体选择」。
 *
 * 参考诊断仪 现场是按 ECU 识别（1A 9F/94/92）的 ODX 变体名/模块名自动进入；
 * 我们之前反过来让用户手选，既不像 参考诊断仪，也把多变体模块的写入锁死。
 *
 * 规则（保守、不猜）：
 *   ① 识别文本里含完整变体名 → 精确命中；
 *   ② 含模块名且存在 *_BaseSys → 参考诊断仪 标准变体 BaseSys；
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

  // ② 识别串含模块名 → BaseSys（参考诊断仪 的标准变体）
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

  return { name: names.includes(def) ? def : names[0], how: '未识别，用 参考诊断仪 默认变体' };
}

/**
 * 零件号选变体 —— 对齐 参考诊断仪 的变体落定路径（2026-11-05）。
 *
 * 参考诊断仪 不弹装备变体菜单：进模块读 ECU 零件号（1A 84 / 硬件件号），
 * 在 ODX 会话库按「零件号 → ECU-REFS(模块+变体)」查表直接落定变体。
 * 实证：会话库 ECU 记录 `PARTNUMBER="982906024CC"` ↔ `ECU-REF Value="Boxster_B4T_2_5L_USA"`
 * 一一对应（HW 件号 982907309 是多市场共用件，需 PARTNUMBER 级才唯一）。
 *
 * @param {Record<string, Array<{platform?:string, module?:string, variant?:string, hwVersion?:string}>>} byPart
 * @param {Record<string, Array<{platform?:string, module?:string, variant?:string, hwVersion?:string}>>} byHwPart
 * @param {{partNumber?:string, hwPartNo?:string, hwVersion?:string, module?:string, variants?:string[]}} want
 * @returns {{name:string, how:string, ambiguous?:string[]}|null}
 */
export function pickVariantByPart(byPart, byHwPart, want) {
  // ★ 2026-11-05 比对语义照抄 参考诊断仪（GetCodeCfgNameByVerInfor 逐指令实证）：
  //   全部值比较 = `strcmp` 字节精确、零规范化调用；键构造（MakeMAndPrNumber）=
  //   片段原样拼接、无补齐/无大小写/无 trim。故此处**不做任何 normalize**，
  //   按原始字节精确比对 —— 行为与 参考诊断仪 逐字节一致（格式问题不存在）。
  //   带尾空格的源键（如 '7PP907357K '）需同形态输入才命中，与 参考诊断仪 同规则；
  //   不命中走调用方兜底（默认变体，不拒写）。
  const norm = (x) => String(x ?? '');
  const pn = norm(want.partNumber);
  const hw = norm(want.hwPartNo);
  const hvs = norm(want.hwVersion);
  const modWant = norm(want.module);
  const allowed = new Set((want.variants || []).map((v) => String(v).toUpperCase()));
  const fit = (list) => (list || []).filter((e) =>
    (!modWant || norm(e.module) === modWant) &&
    (!allowed.size || allowed.has(String(e.variant).toUpperCase())) &&
    (!hvs || !e.hwVersion || norm(e.hwVersion) === hvs));

  // ②b SW 版本消歧（SWINFO 官方表 `(SW,PR)→Mode` 精确匹配，2026-11-05 照抄数据侧规则）：
  //    共用 HW 件号的多候选场景用 ECU 软件号落定；只做精确匹配，对不上不硬凑。
  const swHit = (() => {
    const sw = norm(want.swText);
    if (!sw || !want.swTable || !modWant) return null;
    for (const [k, variants] of Object.entries(want.swTable)) {
      const p = String(k).split('|');
      if ((p[1] || '').toUpperCase() === modWant && p[2] === sw) return variants;
    }
    return null;
  })();
  const swNarrow = (cands) => {
    if (!swHit) return cands;
    const n = cands.filter((v) => swHit.includes(v));
    return n.length ? n : cands;
  };
  // ① PARTNUMBER 精确（会话库里一一对应，最可靠）
  if (pn && byPart[pn]) {
    const hits = fit(byPart[pn]);
    const uniq = [...new Set(hits.map((e) => e.variant))];
    if (uniq.length === 1) return { name: uniq[0], how: '零件号精确命中' };
    if (uniq.length > 1) {
      const relaxed = swNarrow([...new Set((byPart[pn] || []).map((e) => e.variant))]);
      if (relaxed.length === 1) return { name: relaxed[0], how: '零件号+SW 版本消歧唯一' };
      return { name: relaxed[0] || uniq[0], how: '零件号命中（多候选取首）', ambiguous: relaxed };
    }
  }
  // ② HW 件号（多市场共用，只能收窄候选）
  if (hw && byHwPart[hw]) {
    const hits = fit(byHwPart[hw]);
    const uniq = swNarrow([...new Set(hits.map((e) => e.variant))]);
    if (uniq.length === 1) return { name: uniq[0], how: swHit ? 'HW 件号+SW 版本消歧唯一' : 'HW 件号收窄唯一' };
    if (uniq.length > 1) return { name: uniq[0], how: 'HW 件号收窄（多候选取首）', ambiguous: uniq };
  }
  return null;   // 查不到 → 调用方回落识别串匹配（autoPickVariant）
}
