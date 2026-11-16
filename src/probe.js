/**
 * 识别串原语 + 候选族生成 + 进模块后身份裁决（2026-11-13 T03 阶段对齐）。
 *
 * ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑤）：本文件原来的 `probeDecision`
 *   （「NRC 不算候选 / 识别串匹配才算候选」）是 2026-11-09 RE-ICADDR 阶段的旧模型，
 *   已被 2026-11-10 `RE-DISCOVERY-20261110 §1` 的 **DriveLinksMode_1001 @LINK:0x18f00
 *   逐指令** 推翻并删除：
 *     · 原厂发现阶段对每个候选只发 1 帧 `22 14 09`，**只看有没有回来**（含 NRC = 该地址
 *       有 ECU 应答），不看识别串；
 *     · 身份裁决在**进模块后的真实读帧**（cat=0x60 四帧）+ `GetSubSysDataAddr` 名字表。
 *   现保留的 `identMatch` 只服务于「进模块后身份文本匹配」（原厂原语：strcmp /
 *   前缀 memcmp≥4 / strstr≥4；来源 GetSubSysDataAddr @FILE.so:0x15c18）。
 *
 * ★ 2026-11-13 T03-a/T03-b 阶段拆分（R4 逐帧取证）：
 *   ②-a 探针阶段 = 每候选 1 帧（UDS 221409 / KWP 1A9F），应答即绑，**不发身份帧**；
 *   ②-b 身份裁决阶段 = 进模块后按 SYS_DATA comm cat=0x60 四帧模板
 *     `3E00 → 22F19E → 22F1A2 → 1003`（185/185 逐字节全同）的应答文本裁决，
 *     判据源 = `data/ident-registry.json` 的 `moduleIdent`（12 键对象）的
 *     `{request, identName, suffixHex}`。UDS 身份裁决不再发 KWP 专用的 `1A9B`。
 *   见 `identityPhaseFrames()` / `identityKeysFromModuleIdent()`；`identityFramesFor()`
 *   仅为旧探针阶段纯函数回归用例保留的兼容入口，生产链路不再调用。
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

/**
 * 身份裁决阶段（进模块后）实发帧 —— SYS_DATA comm cat=0x60 四帧模板。
 *
 * 原厂侧证据：data/comm-addr-table.json `probeSequence.frames`，185/185 个
 * cat=0x60 block 的四帧逐字节全同；`verify-oem-frames.mjs` 亦钉死
 * `selectOemSequence('0x0e01', 0x7e0, 0x03)` = `3E00 22F19E 22F1A2 1003`。
 * KWP 老代绝不发 0x22，识别请求用有实车证据的 1A 9F。
 *
 * ⚠️ 这是**生产链路**的身份帧集；`identityFramesFor()` 是旧探针阶段纯函数回归用例
 *   的兼容入口（verify-fullchain-audit.mjs 逐字节钉死其返回值），生产不再调用。
 *
 * @param {'kwp'|'uds'|null} family
 * @returns {string[]} 进模块后身份裁决帧序
 */
export function identityPhaseFrames(family) {
  return (family === 'kwp' ? ['1A9F'] : ['3E00', '22F19E', '22F1A2', '1003']);
}

/**
 * 判据源 = data/ident-registry.json 的 `moduleIdent`（12 键**对象**，不是数组）。
 *
 * 用 Object.entries() 逐条取 {request, identName, suffixHex}：
 *   · request   —— 该模块身份请求帧（1A9F ×6 / 22F1A2 ×6），作为帧序证据；
 *   · identName —— ASAM ODX 文件标识名，作为 identMatch 的期望键；
 *   · suffixHex —— 记录复合字节串，作为字节级证据坐标（不参与文本匹配）。
 * 返回去重后的键集与请求集，供 identityVerdict / identityAdjudicate 使用。
 *
 * @param {Record<string, {request?:string, identName?:string, suffixHex?:string}>|null} moduleIdent
 * @returns {{count:number, keys:string[], requests:string[], suffixes:string[]}}
 */
export function identityKeysFromModuleIdent(moduleIdent) {
  const keys = [];
  const requests = [];
  const suffixes = [];
  const entries = Object.entries(moduleIdent || {});
  for (const [moduleName, rec] of entries) {
    keys.push(String(moduleName));
    if (!rec || typeof rec !== 'object') continue;
    if (rec.request) requests.push(String(rec.request).toUpperCase());
    if (rec.identName) keys.push(String(rec.identName));
    if (rec.suffixHex) suffixes.push(String(rec.suffixHex));
  }
  return {
    count: entries.length,
    keys: [...new Set(keys)],
    requests: [...new Set(requests)],
    suffixes: [...new Set(suffixes)],
  };
}

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
 * ★ 2026-11-13 T03-a：`probeDecision` 永久删除（2026-11-09 旧模型，零调用）。
 *   - 旧语义「NRC→nrc-reject、识别串不匹配→no-match，都不算候选」与 原厂
 *     `DriveLinksMode_1001` 的「有回来即绑定（含 NRC）」冲突；
 *   - 身份裁决位置也不同：原厂在进模块后的 cat=0x60 四帧真实读帧，旧模型在发现阶段。
 *   发现阶段的判定现在只有 app.js `probeAddressFor.tryAddr` 一处：回帧 ID + body →
 *   应答即绑，**不再调用身份裁决函数**（②-a 每候选 1 帧，帧数差 = 0）。
 *   身份裁决统一由 enterSystem 之后的 `identityAdjudicate(..., {frames, moduleIdent})`
 *   执行；如需按识别串拒候选，请用 `identMatch` 显式实现，不要恢复本函数。
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
 * ★ 2026-11-13 T03-b：进模块后身份裁决。
 *
 * 参考诊断仪 语义（DriveLinksMode_1000/1001 逐指令已证）
 *   = **探针阶段应答即绑（每候选 1 帧）+ 进模块后 cat=0x60 四帧身份裁决**。
 * 落地：进模块后按 `identityPhaseFrames()` 的 3E00→22F19E→22F1A2→1003 四帧
 *   应答文本，用 identMatch（GetSubSysDataAddr 名字表 + moduleIdent 12 键静态判据源）
 *   比对模块名；不匹配换下一候选，孪生组命中接受并标注「不承诺左右」。
 *
 * 6 对孪生（数据互换/镜像，侧别审计「侧条目互为镜像」实证）显式标注：
 * **不承诺左右** —— 孪生对进哪个都过，身份裁决不裁侧别。
 * ──────────────────────────────────────────────────────────────── */

/**
 * ⚠️ 兼容入口（旧探针阶段帧集），**生产链路已不用**。
 * verify-fullchain-audit.mjs 的回归用例按 `identityAdjudicate()` 4 参调用逐字节
 * 依赖本函数返回 `['22F19E','1A9B'] / ['1A9B']`，故保留原值不动。
 * 生产身份帧集见文件顶部 `identityPhaseFrames()`：UDS 四帧无 1A9B。
 * @deprecated 仅用于旧回归用例；新代码一律用 identityPhaseFrames(family)。
 */
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
 * 身份裁决（纯函数）：身份帧文本 × 期望键（名字表 + moduleIdent 静态判据源）。
 * @param {string[]} texts  身份帧应答 ASCII 文本（cat=0x60 四帧 22F19E / 22F1A2 等）
 * @param {{keys:string[], twin?:boolean, note?:string}} expect
 * @param {Record<string, {request?:string, identName?:string, suffixHex?:string}>|null} [moduleIdent]
 *   data/ident-registry.json 的 12 键对象；传入时把 identName/模块名并入期望键。
 *   ★ 省略（旧回归用例的 2 参调用）时行为逐字节不变。
 * @returns {{verdict:'match'|'twin-match'|'mismatch'|'unknown', text:string, note?:string}}
 *   unknown = 身份帧无可裁决文本（无应答/非识别文本）→ 不裁决，参考诊断仪 应答即绑口径；
 *   mismatch = 有身份文本但不匹配名字表 → 调用方换下一候选；
 *   twin-match = 孪生组命中（含组内互换身份）→ 接受，显式标注「不承诺左右」。
 */
export function identityVerdict(texts, expect, moduleIdent = null) {
  const ex = expect || { keys: [] };
  const keys = (ex.keys || []).slice();
  let registryCount = 0;
  if (moduleIdent && typeof moduleIdent === 'object' && !Array.isArray(moduleIdent)) {
    const mi = identityKeysFromModuleIdent(moduleIdent);
    registryCount = mi.count;
    for (const k of mi.keys) if (!keys.includes(k)) keys.push(k);
  }
  const raw = (texts || []).map((t) => String(t ?? '')).filter((t) => normIdent(t));
  if (!raw.length) return { verdict: 'unknown', text: '', note: '身份帧无可裁决文本，不裁决', registryCount };
  const text = raw.join(' | ');
  for (const t of raw) {
    if (identMatch(t, keys)) {
      return ex.twin
        ? { verdict: 'twin-match', text, note: ex.note || '不承诺左右', registryCount }
        : { verdict: 'match', text, registryCount };
    }
  }
  return { verdict: 'mismatch', text, registryCount };
}

/**
 * 进模块后身份读（wire 注入：cmdFn(hex, ms) → 原始应答串）。
 * 逐帧：回帧 ID 必须来自该候选 rx（R4）；文本提取与 app 探测同口径。
 * 返回 identityVerdict 结果 + 各帧原始文本。
 *
 * ★ 2026-11-13 修复（真车同链）：身份文本必须**剥掉正响应头**再取，不能对整条 body
 *   做可打印字符过滤。5A='Z' / 62='b'（正响应 SID 回显）+ DID/LID 回显混进文本后，
 *   · 占位应答「--」会被读成「Z--」→ 有身份文本但不匹配 → 误杀候选（模拟车 IC 三候选全灭）；
 *   · 短键（'IC'/'DME'，仅 strcmp 全等）永远命中不了带前缀的身份串；
 *   · NRC（7F 22 31）会被读成 '"1' → 伪身份文本 → 真车上把「不支持该 DID」的 ECU 也误杀。
 *   现按 coder.readVehicleIdentity 同口径：只认本请求的正响应，按 1A→2B / 22→3B 剥头，
 *   并核对 DID/LID 回显；NRC / 空 / 截断 / 回显不符一律不产生身份文本 → unknown 不裁决。
 *
 * ★ 2026-11-13 T03-b：帧集与判据源可注入（生产链路接 cat=0x60 四帧 + moduleIdent）：
 *   opts.frames        —— 缺省 identityFramesFor(fam)（旧回归用例逐字节不变）；
 *   opts.moduleIdent   —— ident-registry.json 的 12 键对象，传给 identityVerdict。
 * 旧 4 参调用（verify-fullchain-audit.mjs 的 mock 用例）行为完全不变。
 *
 * @param {(hex:string, ms:number)=>Promise<string>|string} cmdFn
 * @param {{tx:number, rx:number}} p
 * @param {'kwp'|'uds'|null} fam
 * @param {{keys:string[], twin?:boolean, note?:string}} expect
 * @param {{frames?:string[], moduleIdent?:object|null}} [opts]
 */
export async function identityAdjudicate(cmdFn, p, fam, expect, opts = {}) {
  const frames = Array.isArray(opts.frames) && opts.frames.length
    ? opts.frames.slice() : identityFramesFor(fam);
  const moduleIdent = opts.moduleIdent || null;
  const texts = [];
  for (const cmd of frames) {
    let r = '';
    try { r = String(await cmdFn(cmd, 800) || '').trim(); } catch { continue; }
    if (!r) continue;
    // R4：回帧 ID 不符 = 不是它回的，丢弃（该帧不参与裁决）
    try {
      const ids = [...new Set(frameIdsOf(r))];
      if (ids.length && p && !ids.includes(p.rx)) continue;
    } catch { /* 解析不出 ID 时按内容裁决 */ }
    const req = String(cmd).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const sid = parseInt(req.slice(0, 2), 16) & 0xff;
    const pr = parseRespAuto(r, req, sid);
    const body = Array.from(pr.body || []);
    if (!body.length || pr.kind === 'nrc' || pr.kind === 'truncated'
        || body[0] !== ((sid + 0x40) & 0xff)) continue;
    const skip = sid === 0x22 ? 3 : 2;             // 62 <DID16> / 5A <LID8>
    const did = parseInt(req.slice(2), 16);
    const echo = sid === 0x22
      ? (((body[1] || 0) << 8) | (body[2] || 0))
      : (body[1] || 0);
    if (body.length <= skip || (Number.isFinite(did) && echo !== did)) continue;
    const text = body.slice(skip)
      .filter((c) => c >= 0x20 && c < 0x7f)
      .map((c) => String.fromCharCode(c)).join('').trim();
    if (text) texts.push(text);
  }
  return { ...identityVerdict(texts, expect, moduleIdent), texts, frames };
}
