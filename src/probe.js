/**
 * 识别串原语 + 候选族生成 + 绑定后身份裁决（2026-11-12 修复②）。
 *
 * ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑤）：本文件原来的 `probeDecision`
 *   （「NRC 不算候选 / 识别串匹配才算候选」）是 2026-11-09 RE-ICADDR 阶段的旧模型，
 *   已被 2026-11-10 `RE-DISCOVERY-20261110 §1` 的 **DriveLinksMode_1001 @LINK:0x18f00
 *   逐指令** 推翻并删除：
 *     · 原厂发现阶段对每个候选只发 1 帧 `22 14 09`，**只看有没有回来**（含 NRC = 该地址
 *       有 ECU 应答），不看识别串；
 *     · 身份裁决在**进模块后的真实读帧**（首参数 DID/LID）+ `GetSubSysDataAddr` 名字表。
 *   现保留的 `identMatch` 只服务于「进模块后身份文本匹配」（430 原语：strcmp /
 *   前缀 memcmp≥4 / strstr≥4；来源 GetSubSysDataAddr @FILE.so:0x15c18）。
 *
 * 候选族生成（通用规则，零特判）：
 *   - 主候选 = 表行序（ecu-addresses cands，GetDriveLinksAddress 行序）；
 *   - 兜底族 = DRIVELINKS 14B 记录族（GetDriveLinksData FILE:0x18b74 mode 0x1001/0x1002
 *     循环 @0x18d9a 的记录 u16，见 export-ecu-address.py extract_families）。
 *   ⚠️ 2026-11-11：`joinState='unresolved'` 的「全库族并集」兜底已由 app.js 删除
 *     （2026-11-10 真车 IC 事故根因：扫全库族会拿车门/PDC 地址扫 32 个必然全灭）。
 *     本函数仍接受 globalFamilies 参数，但 app.js 传空数组。
 */
import { parseRespAuto, frameIdsOf } from './coder.js';

/** 归一化：大写 + 去非字母数字（与 autoPickVariant 同口径）。 */
export function normIdent(x) {
  return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 识别串匹配（参考诊断仪 原语组合，非自创）：
 *   ① strcmp 全等；② 前缀 memcmp（公共前缀 ≥4 归一字符）；③ strstr 包含（≥4）。
 * 短键（<4，如 "IC"）只接受全等 —— 防任意串误命中。
 * 语义要求：命中串须含目标模块语义（如 IC=Kombi/仪表 → 命中 Kombiinstrument 前缀）。
 */
export function identMatch(text, keys) {
  const N = normIdent(text);
  if (!N) return false;
  for (const k0 of keys || []) {
    const k = normIdent(k0);
    if (!k) continue;
    if (N === k) return true;
    if (k.length >= 4 && N.length >= 4) {
      let cp = 0;
      while (cp < k.length && cp < N.length && k[cp] === N[cp]) cp++;
      if (cp >= 4) return true;               // 前缀 memcmp（0x1d9808 语义）
      if (N.includes(k) || k.includes(N)) return true;   // strstr（0x1d96d4 语义）
    }
  }
  return false;
}

/**
 * 单候选探测判定（纯函数，wire 无关）。
 * @param {string} bodyHex  响应体 hex（剥 ISO-TP 后，如 '7F2212' / '621102…'）
 * @param {string} text     响应体 ASCII 可打印段
 * @param {object} opts     { label, variantNames, moduleKeys, modRecords, autoPick, otherLabels }
 * @returns {{verdict:'accept'|'nrc-reject'|'other-module'|'no-match'|'no-answer', ident?:string}}
 */
/**
 * ★ 2026-11-11 原厂对齐：`probeDecision` 已删除（2026-11-09 旧模型，零调用）。
 *   - 旧语义「NRC→nrc-reject、识别串不匹配→no-match，都不算候选」与 原厂
 *     `DriveLinksMode_1001` 的「有回来即绑定（含 NRC）」冲突；
 *   - 身份裁决位置也不同：原厂在进模块后的真实读帧，而旧模型在发现阶段。
 *   发现阶段的判定现在只有 app.js `probeAddressFor.tryAddr` 一处（回帧 ID + body）。
 *   如需按识别串拒候选（安全增强），请用 `identMatch` 显式实现，不要恢复本函数。
 */

/**
 * 候选族生成（通用，DRIVELINKS tx 表族规则，零特判）：
 *   entry.family（本模块 14B 记录族）；
 *   模块 join 有未决（joinUnresolved/joinState:unresolved，如 KWP IC 0x02F9 无精确表A 行）
 *   时再并入 globalFamilies（全库 14B 记录族并集）做运行时身份探测兜底 —— 判据=join 证据，
 *   与模块身份无关（不为 IC 或任何模块单开规则）。识别串匹配才算命中，真车自证。
 * 去重保序（record 序 = 表行序口径）。
 */
export function familyCandidates(entry, globalFamilies = []) {
  const out = [];
  const seen = new Set();
  const push = (f) => {
    const tx = typeof f.tx === 'number' ? f.tx : parseInt(f.tx, 16);
    if (!Number.isFinite(tx) || seen.has(tx)) return;
    if (tx < 0x100 || tx > 0x7FF) return;
    seen.add(tx);
    out.push({ tx, rx: (typeof f.rx === 'number' ? f.rx : parseInt(f.rx || '0', 16)) || tx + 8,
      proto: f.proto ?? null, src: 'family', recOff: f.recOff, keyD: f.keyD, tag: f.tag });
  };
  for (const f of entry?.family || []) push(f);
  const hasUnresolved = entry?.joinState === 'unresolved' || (entry?.joinUnresolved || []).length > 0;
  if (hasUnresolved) {
    for (const f of globalFamilies) push(f);
  }
  return out;
}

/**
 * 探测顺序表（app.probeAddressFor 与模拟车「族中位」目标共用，保序一致）：
 *   表行序 cands（11 位诊断段 0x700-0x7FF，变体选行收窄后的顺序传 preferTx）→ 兜底族。
 * 返回 [{tx, rx, proto, src}]。
 */
export function probeList(entry, globalFamilies = [], prefer = null) {
  const out = [];
  const seen = new Set();
  const add = (tx, rx, proto, src) => {
    if (!Number.isFinite(tx) || !Number.isFinite(rx)) return;
    // ★ 2026-11-12 全量审计修不一致：旧实现把 tx/rx 下界卡在 0x600，会静默丢掉
    //   bind-plan 里来自 comm cat=0x10 的**本 ECU 老代 KWP 地址**（如 0x05CA/0x06CA）。
    //   这些是 11 位合法且有包内证据的地址，生成器/app 都放行，只有这里丢弃 → 口径冲突。
    //   统一为「合法 11 位请求/应答段」：0<tx≤0x7F7、0<rx≤0x7FF、rx≠tx。
    if (tx <= 0 || tx > 0x7F7) return;
    if (rx <= 0 || rx > 0x7FF || rx === tx) return;
    if (seen.has(tx)) return;
    seen.add(tx);
    out.push({ tx, rx, proto: proto ?? null, src });
  };
  const cands = ((entry?.cands || []).concat(entry?.candsAux || [])).slice();
  if (prefer && typeof prefer.has === 'function') {
    cands.sort((a, b) => (prefer.has(String(a.internal || '').toUpperCase()) ? 0 : 1)
      - (prefer.has(String(b.internal || '').toUpperCase()) ? 0 : 1));
  }
  for (const c of cands) {
    add(typeof c.tx === 'number' ? c.tx : parseInt(c.tx, 16),
        typeof c.rx === 'number' ? c.rx : parseInt(c.rx, 16), Number(c.proto) || null, 'table');
  }
  for (const f of familyCandidates(entry, globalFamilies)) add(f.tx, f.rx, f.proto, 'family');
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * ★ 2026-11-12 修复②（RE-GAPVERIFY 落地）：绑定后身份裁决。
 *
 * 参考诊断仪 语义（DriveLinksMode_1000/1001 逐指令已证）= **应答即绑 + 进模块后身份裁决**。
 * 落地同语义：绑定候选后读身份帧（cat=0x60 模板：22F19E 回 ODX 文件标识、
 * 1A9B 回系统名）→ 用 identMatch（GetSubSysDataAddr 名字表）比对模块名 →
 * 不匹配换下一候选。
 *
 * 6 对孪生（数据互换/镜像，侧别审计「侧条目互为镜像」实证）显式标注：
 * **不承诺左右** —— 孪生对进哪个都过，身份裁决不裁侧别。
 * ──────────────────────────────────────────────────────────────── */

/** 身份帧（cat=0x60 模板）：22F19E=ODX 文件标识、1A9B=系统名。KWP 车绝不发 0x22。 */
export function identityFramesFor(family) {
  return (family === 'kwp' ? ['1A9B'] : ['22F19E', '1A9B']).slice();
}

/**
 * 6 对孪生（数据互换）——显式标注「不承诺左右」。
 * 证据：侧别审计 §B3（981 门 632 条全同 / 992 门前部 1499 条全同 / 座椅 1638 条全同 /
 * 前照灯 1438 条全同 / 变道主=从同模块同条数）+ 影响面「车门 4、座椅 2+、前照灯 2、
 * 变道 2、后桥转向 2 侧条目互为镜像」。孪生组内身份数据互换 → 裁决只裁到组，不裁侧。
 */
export const TWIN_GROUPS = Object.freeze([
  { pair: '前车门（驾驶员侧↔乘客侧）',
    names: ['BV_DoorElectDriveSideUDS', 'BV_DoorElectPasseSideUDS', 'TUER_VORNE', 'TUER_HINTEN'],
    evidence: '981 632 条全同 / 992 1499 条全同（侧别审计 §B3）',
    note: '数据互换（镜像）· 不承诺左右' },
  { pair: '后车门（驾驶员侧后↔乘客侧后）',
    names: ['BV_DoorElectRearDriveSideUDS', 'BV_DoorElectRearPasseSideUDS'],
    evidence: '侧别审计 影响面：车门 4 分列 2 对，侧条目互为镜像',
    note: '数据互换（镜像）· 不承诺左右' },
  { pair: '座椅（驾驶员侧↔乘客侧）',
    names: ['BV_SeatAdjusDriveSideUDS', 'BV_SeatAdjusPasseSideUDS'],
    evidence: '992 1638 条全同（侧别审计 §B3）',
    note: '数据互换（镜像）· 不承诺左右' },
  { pair: '前照灯（左↔右）',
    names: ['SCHEINWERFER', 'SCHEINWERFER_LED', 'SWSG', 'SWSG_mit_AFS_ALWR'],
    evidence: '981 左=右=中央 1438 条全同（侧别审计 §B3）',
    note: '数据互换（镜像）· 不承诺左右' },
  { pair: '变道辅助（右主↔左从）',
    names: ['BV_ContrUnitLaneChangAssis2UDS', 'BV_LaneChangAssisUDS'],
    evidence: '981/992 右（主）=左（从）同模块同条数（侧别审计 §B3）',
    note: '数据互换（镜像）· 不承诺左右' },
  { pair: '后桥转向（左主↔右从）',
    names: ['Hinterachslenkung'],
    evidence: '参考诊断仪 分列 2 系统（左主/右从），数据镜像合并（侧别审计 影响面）',
    note: '数据互换（镜像）· 不承诺左右' },
]);

/** 目标模块名 → 期望身份键（含孪生组合并键）；非孪生返回 {twin:false}。 */
export function twinKeysFor(names) {
  const ns = (names || []).map((x) => String(x || '').trim()).filter(Boolean);
  for (const g of TWIN_GROUPS) {
    const hit = ns.some((n) => g.names.includes(n));
    if (hit) {
      return { keys: [...new Set([...ns, ...g.names])], twin: true, pair: g.pair, note: g.note };
    }
  }
  return { keys: ns, twin: false, pair: null, note: null };
}

/**
 * 身份裁决（纯函数）：身份帧文本 × 期望键（GetSubSysDataAddr 名字表语义）。
 * @param {string[]} texts  身份帧应答 ASCII 文本（22F19E ODX 文件标识 / 1A9B 系统名）
 * @param {{keys:string[], twin?:boolean, note?:string}} expect
 * @returns {{verdict:'match'|'twin-match'|'mismatch'|'unknown', text:string, note?:string}}
 *   unknown = 身份帧无可裁决文本（无应答/非识别文本）→ 不裁决，参考诊断仪 应答即绑口径；
 *   mismatch = 有身份文本但不匹配名字表 → 调用方换下一候选；
 *   twin-match = 孪生组命中（含组内互换身份）→ 接受，显式标注「不承诺左右」。
 */
export function identityVerdict(texts, expect) {
  const ex = expect || { keys: [] };
  const raw = (texts || []).map((t) => String(t ?? '')).filter((t) => normIdent(t));
  if (!raw.length) return { verdict: 'unknown', text: '', note: '身份帧无可裁决文本，不裁决' };
  const text = raw.join(' | ');
  for (const t of raw) {
    if (identMatch(t, ex.keys || [])) {
      return ex.twin
        ? { verdict: 'twin-match', text, note: ex.note || '不承诺左右' }
        : { verdict: 'match', text };
    }
  }
  return { verdict: 'mismatch', text };
}

/**
 * 绑定后身份读（wire 注入：cmdFn(hex, ms) → 原始应答串）。
 * 逐帧：回帧 ID 必须来自该候选 rx（R4）；文本提取与 app 探测同口径。
 * 返回 identityVerdict 结果 + 各帧原始文本。
 */
export async function identityAdjudicate(cmdFn, p, fam, expect) {
  const texts = [];
  for (const cmd of identityFramesFor(fam)) {
    let r = '';
    try { r = String(await cmdFn(cmd, 800) || '').trim(); } catch { continue; }
    if (!r) continue;
    // R4：回帧 ID 不符 = 不是它回的，丢弃（该帧不参与裁决）
    try {
      const ids = [...new Set(frameIdsOf(r))];
      if (ids.length && p && !ids.includes(p.rx)) continue;
    } catch { /* 解析不出 ID 时按内容裁决 */ }
    const sid = parseInt(String(cmd).slice(0, 2), 16) & 0xff;
    const pr = parseRespAuto(r, String(cmd).replace(/[^0-9A-Fa-f]/g, ''), sid);
    const text = Array.from(pr.body || [])
      .filter((c) => c >= 0x20 && c < 0x7f)
      .map((c) => String.fromCharCode(c)).join('').trim();
    if (text) texts.push(text);
  }
  return { ...identityVerdict(texts, expect), texts };
}
