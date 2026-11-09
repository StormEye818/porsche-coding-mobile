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
 * @param {{partNumber?:string, partTokens?:string[], hwPartNo?:string, hwVersion?:string, module?:string, variants?:string[]}} want
 * @returns {{name:string, how:string, ambiguous?:string[]}|null}
 */
export function pickVariantByPart(byPart, byHwPart, want) {
  // ★ 2026-11-05 比对语义照抄 参考诊断仪（GetCodeCfgNameByVerInfor 逐指令实证）：
  //   全部值比较 = `strcmp` 字节精确、零规范化调用；键构造（MakeMAndPrNumber）=
  //   片段原样拼接、无补齐/无大小写/无 trim。故此处**不做任何 normalize**，
  //   按原始字节精确比对 —— 行为与 参考诊断仪 逐字节一致（格式问题不存在）。
  //   带尾空格的源键（如 '7PP907357K '）需同形态输入才命中，与 参考诊断仪 同规则；
  //   不命中走调用方兜底（默认变体，不拒写）。
  // ★ 2026-11-08 件号 token 逐个全等查（任务清单④ / RE-MODELADDR §3.3-3.4）：
  //   1A 87/94 应答按 0x20 分词（checkPartNumber 语义）逐 token 查 byPart，
  //   全等命中即用；1A84 采得的 partNumber 排最前（保留优先）。
  const norm = (x) => String(x ?? '');
  const pnTokens = [...(norm(want.partNumber) ? [norm(want.partNumber)] : []),
    ...((want.partTokens || []).map(norm).filter(Boolean))];
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
  // ① PARTNUMBER 精确（会话库里一一对应，最可靠）；token 逐个全等命中即用
  for (const pn of pnTokens) {
    if (!byPart[pn]) continue;
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

/**
 * 应答文本 → 车型（trim 落定，RE-MODELADDR §1.4/§1.5④ + 任务清单①）。
 *
 * 参考诊断仪 语义：22 11 02/22 11 01 应答文本（车上识别串）与 24 键表（SYSP:0x5E42C）
 * 各键文本 strcmp —— strcmp 语义下 **显示文本 == 应答文本**；981 Cayman 应答含 "Cayman"
 * ⇒ 显示 Cayman。此处以「应答文本 ∈ 车型名」为可观测等价（目录名含 trim 词）。
 *
 * @param {string[]} models   候选车型目录名（如 ['Boxster（981）','Cayman（981）']）
 * @param {string} nameText   链上应答文本（如 "Cayman"）
 * @returns {{name:string, how:string}|null}  null=文本未命中（调用方走双候选合并，须注明）
 */
export function pickModelByName(models, nameText) {
  const t = String(nameText || '').trim();
  if (!t || !models || !models.length) return null;
  // 长词优先（"Cayman" 先于 "981" 这类短词），逐词命中即取首个含该词的车型
  const words = t.split(/[^A-Za-z0-9一-龥]+/).filter((w) => w.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const w of words) {
    const hit = models.find((m) => String(m).includes(w));
    if (hit) return { name: hit, how: `应答文本「${t}」命中车型名` };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// ★ 2026-11-09 车辆证据→数据家族/变体选择层（真车二连败修复，规则级禁特判）
//   证据优先级（任务口径）：① 识别串 ② 件号 ③ 协议族 KWP/UDS 兜底。
//   识别串注册表 = data/ident-registry.json（DSN.BIN 挖掘：模块索引@105358 →
//   模块记录[SID/ID 身份记录] → 变体表 → 变体识别串集；DME 族身份记录=1A 9F，
//   与真车日志 `7E8 06 5A 9F 50 32 30 30`「P200」逐字互证）。
//   件号 = data/ecu-part-map.json（JOB.BIN PARTNUMBER→ECU-REFS 一一对应，
//   比对语义 strcmp/memcmp 全等 = IsMatchName ACTF:0x5f8ba / checkPartNumber ACTF:0x4e00c）。
//   出处矩阵：RE-TRACEABILITY-20261109.md。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 显示名构造（RE-MODELADDR §1.5：「yy款 + 应答名」，如「14款 Cayman」）。
 * app 与 fixture 共用，保证验收测的是真代码路径。
 */
export function designationFrom(year, nameText) {
  const yy = year != null ? String(year % 100).padStart(2, '0') : '??';
  const nm = String(nameText || '').trim();
  return nm ? `${yy}款 ${nm}` : '';
}

/**
 * 防御层（自创，矩阵标注「防御层(自创)·不计入对齐」）：
 * 件号形态（纯数字 11-12 位）永不作显示名 —— 参考诊断仪侧同效由分支丢弃应答实现
 * （1A 87/1A 9B/21 50 等 fire-and-forget），此处冗余兜底防解析层漏网。
 */
export function looksLikePartNumber(text) {
  const t = String(text || '').trim();
  return /^[0-9]{11,12}$/.test(t);
}

/**
 * 车辆证据→数据家族选择（菜单模块候选 entries 里挑数据家族）。
 *
 * @param {Array<{mod:string, mi:object}>} entries  菜单模块候选（数据家族 + 目录记录）
 * @param {object} ev
 *   identTokens   识别串集（1A 9F / 22 F1 A2 等应答文本，空格分词）
 *   partTokens    件号 token 集（1A 84/87/94 按 0x20 分词）
 *   partNo        1A 84 件号（优先 token）
 *   registry      data/ident-registry.json
 *   byPart        ecu-part-map.json 的 byPart
 *   moduleFamily  data/module-family.json（模块记录 SID 统计 {kwp,uds}）
 *   observedFamily  实测协议族 'kwp' | 'uds' | null（识别/会话流证据）
 * @returns {{mod:string, variant:string|null, how:string, evidence:string[]}}
 */
export function pickFamilyByEvidence(entries, ev = {}) {
  const evidence = [];
  if (!entries || !entries.length) return { mod: '', variant: null, how: '无候选', evidence };
  const reg = ev.registry || {};
  const identToVariant = reg.identToVariant || {};
  const byPart = ev.byPart || {};
  const moduleFamily = ev.moduleFamily || null;
  let pool = entries.slice();

  // ① 识别串（DSN.BIN 注册表，名字注册表 strcmp 同构：精确键查找）
  let identHits = null;
  const tokens = (ev.identTokens || []).map((t) => String(t || '').trim()).filter(Boolean);
  for (const tok of tokens) {
    const hits = identToVariant[tok];
    if (!hits || !hits.length) continue;
    const narrowed = pool.filter((e) => hits.some((h) => h.module === e.mod));
    if (narrowed.length) {
      evidence.push(`识别串「${tok}」→ ${narrowed.map((e) => e.mod).join('/')}`);
      pool = narrowed;
      identHits = hits;
      break;   // 识别串优先：首个命中 token 定界
    }
  }

  // ② 件号（JOB.BIN 会话库，memcmp 全等）
  let partHit = null;
  const pnTokens = [...(ev.partNo ? [ev.partNo] : []), ...(ev.partTokens || [])]
    .map((t) => String(t || '')).filter(Boolean);
  for (const pn of pnTokens) {
    const hits = byPart[pn];
    if (!hits || !hits.length) continue;
    const narrowed = pool.filter((e) => hits.some((h) => h.module === e.mod
      && (!h.platform || h.platform === (ev.platform || h.platform))));
    if (narrowed.length) {
      evidence.push(`件号「${pn}」→ ${narrowed.map((e) => e.mod).join('/')}`);
      pool = narrowed;
      partHit = hits.find((h) => h.module === pool[0].mod) || hits[0];
      break;
    }
  }

  // ③ 协议族兜底（模块记录 SID 统计 vs 实测协议族）
  if (pool.length > 1 && moduleFamily && ev.observedFamily) {
    const dom = (m) => {
      const st = moduleFamily[m];
      if (!st) return null;
      return st.kwp > st.uds ? 'kwp' : st.uds > st.kwp ? 'uds' : null;
    };
    const narrowed = pool.filter((e) => dom(e.mod) === ev.observedFamily);
    if (narrowed.length && narrowed.length < pool.length) {
      evidence.push(`协议族 ${ev.observedFamily} 兜底 → ${narrowed.map((e) => e.mod).join('/')}`);
      pool = narrowed;
    }
  }

  const chosen = pool[0];
  // 变体：识别串注册表 > 件号表 > null（调用方回落 autoPickVariant）
  let variant = null, how = '';
  const names = (chosen?.mi?.variants || []).map((v) => v.name || String(v.file || '').replace(/\.json$/i, ''));
  const identVariant = (identHits || []).find((h) => h.module === chosen.mod && names.includes(h.variant)) || null;
  if (identVariant) {
    variant = identVariant.variant;
    how = `识别串注册表（DSN.BIN）→ ${variant}`;
  } else if (partHit && partHit.module === chosen.mod && names.includes(partHit.variant)) {
    variant = String(partHit.variant).split(',')[0];
    how = `件号表（JOB.BIN）→ ${variant}`;
  }
  const steps = evidence.length ? evidence.join('；') : '无识别串/件号命中，取首候选';
  return {
    mod: chosen.mod,
    variant,
    how: `家族 ${chosen.mod}（${steps}）${variant ? ' · ' + how : ''}`,
    evidence,
  };
}
