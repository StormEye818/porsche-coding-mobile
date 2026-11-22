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
import { RAW_IDENTITY_COLLISIONS } from './sweep.js';

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
 * UDS 身份裁决禁止掺入的 KWP 专用帧（PE-20 反例：1A9B 不是 UDS 身份帧）。
 * T04 注入自检「身份掺 1A9B」按本常量翻红。
 */
export const IDENTITY_FORBIDDEN_UDS_FRAMES = Object.freeze(['1A9B']);

/**
 * 只有识别 DID 的应答才是身份串（E0 逐行账本 · 缺陷2）。
 *
 * 允许取身份文本的 SID：0x1A 族（1A9F/1A90/1A87/1A94…）、0x21、0x22 族
 * （22F19E/22F1A2/22F189/22F1DF/22F190… 及 22 F1 40 9）。
 * 会话（0x10）、保活（0x3E）、安全（0x27）、写（0x2E/0x3B）、例程（0x31）
 * 的应答**一律不是身份串**：1003 的正响应 `50 03 00 32 01 F4` 剥头后会得到「2」，
 * 旧实现把它塞进身份通道，就是真车日志「身份文本「2」」的根因。
 * KWP 81 快初始化不进本函数（sessionless 分支），不受此白名单影响。
 */
export const IDENTITY_TEXT_SIDS = Object.freeze([0x1A, 0x21, 0x22]);

/** 身份帧集合法性：UDS 四帧不得含 KWP 专用帧；KWP 不得发 0x22。 */
export function validateIdentityFrames(family, frames) {
  const list = (frames || []).map((x) => String(x).replace(/[^0-9A-Fa-f]/g, '').toUpperCase());
  if (family === 'uds' && list.some((f) => IDENTITY_FORBIDDEN_UDS_FRAMES.includes(f))) {
    return { ok: false, frame: list.find((f) => IDENTITY_FORBIDDEN_UDS_FRAMES.includes(f)) };
  }
  if (family === 'kwp' && list.some((f) => f.startsWith('22'))) {
    return { ok: false, frame: list.find((f) => f.startsWith('22')) };
  }
  return { ok: true, frame: null };
}

/**
 * PE-21：KWP 识别链固定顺序（9F/87/84/91/92/93/94/95/97/9A），
 * 连续 3 次无数据即截断，不重试、不自定义容错。
 * 1A 链只用于 KWP 身份裁决；UDS 四帧里绝不掺 1A9B/1A9F。
 */
export const IDENT_1A_CHAIN = Object.freeze([
  '1A9F', '1A87', '1A84', '1A91', '1A92', '1A93', '1A94', '1A95', '1A97', '1A9A',
]);
export const IDENT_1A_MAX_MISS = 3;

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
 * @param {{frames?:string[], moduleIdent?:object|null, identToVariant?:object|null,
 *   partNumber?:string}} [opts]
 *   identToVariant —— DSN 串精确查表（data/ident-registry.json）；命中则 verdict='match'
 *   并带 {variant, matchedModule, dsn}；不传时 DSN 串一律不识别，绝不走名字键近似。
 */
export async function identityAdjudicate(cmdFn, p, fam, expect, opts = {}) {
  const supplied = Array.isArray(opts.frames) && opts.frames.length
    ? opts.frames.slice() : identityFramesFor(fam);
  // 只有显式传入生产帧集（opts.frames）时才做禁止帧校验；
  // 旧 4 参回归用例走 identityFramesFor('uds') = ['22F19E','1A9B']，逐字节行为不变。
  const explicitFrames = Array.isArray(opts.frames) && opts.frames.length > 0;
  const validity = explicitFrames ? validateIdentityFrames(fam, supplied) : { ok: true, frame: null };
  if (!validity.ok) {
    // 注入自检锚点：UDS 帧集掺 1A9B（或 KWP 掺 0x22）必须红，不静默放行。
    return {
      verdict: 'invalid-frames', text: '', texts: [], frames: supplied,
      invalidFrame: validity.frame,
      note: `身份帧集合法性失败：${fam} 不得发 ${validity.frame}`,
    };
  }
  // PE-21：KWP 身份阶段以 1A9F 起链时，按固定链跑并在 3 miss 处截断。
  // 兼容入口 identityFramesFor('uds') 含 1A9B 但不含 1A9F，旧回归用例帧序逐字节不变。
  const expand1A = supplied.some((f) => String(f).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() === '1A9F');
  const frames = expand1A
    ? [...IDENT_1A_CHAIN, ...supplied.filter((f) =>
        String(f).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() !== '1A9F')]
    : supplied.slice();
  const moduleIdent = opts.moduleIdent || null;
  const texts = [];
  const textsByCmd = {};
  let miss = 0;
  for (const cmd of frames) {
    let r = '';
    try { r = String(await cmdFn(cmd, 800) || '').trim(); } catch { miss++; if (expand1A && miss >= IDENT_1A_MAX_MISS) break; continue; }
    if (!r) { miss++; if (expand1A && miss >= IDENT_1A_MAX_MISS) break; continue; }
    // R4：回帧 ID 不符 = 不是它回的，丢弃（该帧不参与裁决）
    try {
      const ids = [...new Set(frameIdsOf(r))];
      if (ids.length && p && !ids.includes(p.rx)) {
        miss++;
        if (expand1A && miss >= IDENT_1A_MAX_MISS) break;
        continue;
      }
    } catch { /* 解析不出 ID 时按内容裁决 */ }
    const req = String(cmd).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const sid = parseInt(req.slice(0, 2), 16) & 0xff;
    // ★ E0 缺陷2：非识别 DID 的应答不产生身份文本。白名单放在取文本之前，
    //   1003 的 `50 03 …` 即使留在 oemIdentityResponses 里也不会变成「2」。
    if (!IDENTITY_TEXT_SIDS.includes(sid)) {
      miss++;
      if (expand1A && miss >= IDENT_1A_MAX_MISS) break;
      continue;
    }
    const pr = parseRespAuto(r, req, sid);
    const body = Array.from(pr.body || []);
    // NRC（7F xx nn）/ 截断 / 空应答都不是身份串（PE-08 / PE-21 / PE-54）。
    if (!body.length || pr.kind === 'nrc' || pr.kind === 'truncated'
        || body[0] === 0x7f || body[0] !== ((sid + 0x40) & 0xff)) {
      miss++;
      if (expand1A && miss >= IDENT_1A_MAX_MISS) break;
      continue;
    }
    const skip = sid === 0x22 ? 3 : 2;             // 62 <DID16> / 5A <LID8>
    const did = parseInt(req.slice(2), 16);
    const echo = sid === 0x22
      ? (((body[1] || 0) << 8) | (body[2] || 0))
      : (body[1] || 0);
    if (body.length <= skip || (Number.isFinite(did) && echo !== did)) {
      miss++;
      if (expand1A && miss >= IDENT_1A_MAX_MISS) break;
      continue;
    }
    const text = body.slice(skip)
      .filter((c) => c >= 0x20 && c < 0x7f)
      .map((c) => String.fromCharCode(c)).join('').trim();
    // 可打印占位（如 5A 9B 2D 2D → "--"）不构成可裁决身份串。
    if (!text || !normIdent(text)) {
      miss++;
      if (expand1A && miss >= IDENT_1A_MAX_MISS) break;
      continue;
    }
    miss = 0;
    texts.push(text);
    textsByCmd[req] = text;
  }
  // ★ E0 缺陷1：身份文本分两类，判据绝不混用。
  //   · DSN 数字串（22F1A2 应答，如 050018）→ identToVariant 精确查表；
  //   · 名字串（P200 / 模块名 / ASAMODXFileVersi_* identName）→ 原有 identMatch 原语。
  //   moduleIdent 的 12 个键全是名字键，拿它去比 DSN 必然 mismatch；
  //   而「公共前缀≥4」会把 ISO-TP 半包 '050' 误配到 '050018'，是明确的错判。
  const isDsnText = (t) => /^\d+$/.test(String(t ?? '').trim());
  const nameTexts = [];
  const dsnTexts = [];
  for (const t of texts) {
    if (isDsnText(t)) dsnTexts.push(t);
    else nameTexts.push(t);
  }
  const table = (opts.identToVariant && typeof opts.identToVariant === 'object')
    ? opts.identToVariant : null;
  const expectNames = ((expect && expect.keys) || []).map((k) => normIdent(k));
  let dsn = null;
  let dsnUnresolved = false;
  for (const t of dsnTexts) {
    const key = String(t).trim();
    const hit = table ? table[key] : null;     // ★ 精确查表（非前缀 / 非包含）
    if (!hit) { dsnUnresolved = true; continue; }
    const cands = (Array.isArray(hit) ? hit : [hit])
      .filter((h) => h && h.module && h.variant)
      .map((h) => ({ module: String(h.module), variant: String(h.variant) }));
    if (!cands.length) { dsnUnresolved = true; continue; }
    // 多候选（050018 → BCM_hinten + BCM_vorne）按期望模块名消歧，不按侧别/顺序猜。
    const expected = cands.find((h) => expectNames.includes(normIdent(h.module)));
    const chosen = expected || cands[0];
    dsn = {
      text: key,
      module: chosen.module,
      variant: chosen.variant,
      candidates: cands,
      disambiguated: Boolean(expected),
    };
    break;
  }
  const verdict = identityVerdict(nameTexts, expect, moduleIdent);
  // PE-31 / E-14：名字串按名字 + 件号；raw 相同的 0x0f4d(SWA2) / 0x0e5f(BV_*) 不合并。
  const partNumber = opts.partNumber || expect?.partNumber
    || textsByCmd['1A84'] || textsByCmd['1A94'] || '';
  const fourTuple = adjudicateFourTuple(nameTexts, expect, { moduleIdent, partNumber });
  const finalVerdict = dsn ? 'match'
    : (dsnTexts.length && !nameTexts.length) ? 'mismatch'
      : (fourTuple.verdict === 'mismatch' ? 'mismatch' : verdict.verdict);
  return {
    ...verdict,
    verdict: finalVerdict,
    text: dsn ? dsn.text : (verdict.text || dsnTexts.join(' | ')),
    texts, frames, textsByCmd,
    dsn, dsnTexts, nameTexts, dsnUnresolved,
    variant: dsn ? dsn.variant : '',
    matchedModule: dsn ? dsn.module : '',
    partNumber: String(partNumber || ''),
    rawCollision: fourTuple.rawCollision,
    identityRule: dsn
      ? `identToVariant 精确命中 ${dsn.text} → ${dsn.module}/${dsn.variant}`
      : fourTuple.identityRule,
  };
}

/**
 * 四元身份裁决（名字串 + 件号），禁止用 sysId 数值或 CAN raw 单一判身份。
 * 同 raw 异名条目（0x0f4d / 0x0e5f）必须分开，未给件号时只裁到名字命中。
 */
export function adjudicateFourTuple(texts, expect, opts = {}) {
  const ex = expect || { keys: [] };
  const keys = (ex.keys || []).slice();
  const mi = opts.moduleIdent
    ? identityKeysFromModuleIdent(opts.moduleIdent) : null;
  if (mi) for (const k of mi.keys) if (!keys.includes(k)) keys.push(k);
  const raw = (texts || []).map((t) => String(t ?? '')).filter((t) => normIdent(t));
  if (!raw.length) return { verdict: 'unknown', rawCollision: null, identityRule: 'nameVariant + PARTNUMBER memcmp' };
  const nameHit = raw.some((t) => identMatch(t, keys));
  const pn = String(opts.partNumber || '').trim();
  const collisionNames = (RAW_IDENTITY_COLLISIONS[0]?.entries || []).map((e) => e.name);
  const hitCollision = keys.filter((k) => collisionNames.includes(k));
  if (!nameHit) return { verdict: 'mismatch', rawCollision: null, identityRule: 'nameVariant + PARTNUMBER memcmp' };
  return {
    verdict: 'match',
    rawCollision: hitCollision.length > 1 ? (RAW_IDENTITY_COLLISIONS[0]?.raw || null) : null,
    identityRule: hitCollision.length > 1
      ? 'raw 相同不合并：按名字串+件号裁决' : 'nameVariant + PARTNUMBER memcmp',
    partNumber: pn || null,
  };
}
