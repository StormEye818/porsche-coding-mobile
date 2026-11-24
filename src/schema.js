/**
 * schema.js — 编码参数数据模型（对照表的结构化表示）。
 *
 * 记录格式来自 参考实现 对 诊断仪数据包 的离线解析（已验收）：
 *
 *   设码记录：ID 链 + 8 字节后缀
 *            链名来自 名称库，后缀最后四字节 = 值换算 ID（值编码公式）
 *
 *   设码定义：chain + byteOffset + bitOffset + TEXTTABLE 枚举
 *
 * 验证等级（决定 app 能不能写）：
 *   source-defined   —— 只有静态定义，无逐项实车证据
 *   read-confirmed   —— 实车读回验证过
 *   write-confirmed  —— 实车写入+回读验证过
 *
 * ⚠️ 当前政策（2026-11-11 原厂对齐）：默认按原厂行为 —— `level` 只是**验证状态标注**，
 *    不是写入门禁；值域/地址态/自动回滚等保护全部收敛到下方 `SAFETY` 开关（默认全关）。
 *    需要严格模式时：`setSafety({ level:true, range:true, addrState:true, autoRestore:true })`
 *    （`level:true` 且 `WRITE_ENABLED=false` 才要求 write-confirmed）。
 */

export const LEVELS = ['source-defined', 'read-confirmed', 'write-confirmed'];

export const LEVEL_LABEL = {
  'source-defined': '仅源定义（未实车验证）',
  'read-confirmed': '读回已验证',
  'write-confirmed': '写入已验证',
};

/**
 * 参数条目 schema
 * {
 *   id:        string    唯一标识，建议 9x1:{module}:{variant}:{name}
 *   module:    string    模块名，如 DME_BDE_Continental
 *   profile:   string    变体 profile，如 9x1:DME_BDE_Continental:SDI9_1_981_3_4L_EU5
 *   variant:   string    变体名，如 SDI9_1_981_3_4L_EU5
 *   name:      string    功能名（名称库 里的名字）
 *   nameId:    string    名称库 的 ID，如 F001E2D8
 *   chain:     string    ID 链，如 0xF001E2D8$0xF001A305$0xA0000968
 *   byte:      number    字节偏移（0 起）
 *   bit:       number    位偏移（LSB 起，0-7）
 *   bitsize:   number    位宽，默认 1
 *   enum:      object    TEXTTABLE 枚举 { 值: 含义 } 或 null
 *   formula:   string    值换算 公式 ID，如 F000449D
 *   level:     string    验证等级
 *   risk:      string    low | medium | high
 *   source:    string    依据来源
 * }
 */

/** 校验一条参数是否合法 */
export function validateParam(p) {
  const errs = [];
  if (!p.id) errs.push('缺 id');
  if (!p.module) errs.push('缺 module');
  if (typeof p.byte !== 'number' || p.byte < 0) errs.push('byte 必须是 >=0 的数字');
  if (typeof p.bit !== 'number' || p.bit < 0 || p.bit > 7) errs.push('bit 必须是 0-7');
  // ★ bitsize 可 >8：曲线值、多字节数据在 EXPRESS 里 BitLength=16/24/32 …
  //   extractField/injectField 已支持跨字节，这里只挡不合理的值。
  if (typeof p.bitsize !== 'number' || p.bitsize < 1 || p.bitsize > 256) {
    errs.push(`bitsize 必须 1-256（实际 ${p.bitsize}）`);
  }
  if (typeof p.bit === 'number' && typeof p.bitsize === 'number'
      && p.bitsize >= 1 && p.bit + p.bitsize > 256) {
    errs.push(`bit(${p.bit}) + bitsize(${p.bitsize}) 过大`);
  }
  if (!LEVELS.includes(p.level)) errs.push(`level 必须是 ${LEVELS.join('/')}`);
  // ★ 写入必需：LID（来源 请求模板 / 参数表）。
  //   ⚠️ 读写 SID 配对表已拆（2026-11-08 覆盖审计②）：参考诊断仪 无配对闸，
  //   直接用记录自带 readSid/writeSid 发帧（RE-FLOWSPEC §3.1，同 ECU 混族常态）。
  if (p.lid == null && p.did == null) {
    errs.push('缺 lid（写入必需；来源 请求模板 / 参数表）');
  }
  return errs;
}

/**
 * 读写 SID 服务集（参考诊断仪 实证，禁自创）：
 * - 读帧只有 0x21/0x22/0x1A 三种 —— 参考诊断仪 读包装
 *   （参考诊断仪 读包装实现）只对这三种打包 `21/1A <LID8>`、`22 <DID16be>`，
 *   其余 SID 跳过打包不发（readSid=0 的记录 参考诊断仪 不发读帧）。
 * - 写帧只有 0x3B/0x2E 两种 —— 参考诊断仪 写包装（同库 0xFDED4）只对这两种打包
 *   `3B <LID8> <data>`、`2E <DID16be> <data>`，其余 SID 不打包（记录无写服务=只读项）。
 * GAG 佐证：全库写服务仅 3B×14 / 2E×3 条（RE-FLOWSPEC §4.4/4.5）。
 */
export const READ_SIDS = Object.freeze([0x21, 0x22, 0x1A]);
export const WRITE_SIDS = Object.freeze([0x3B, 0x2E]);

/** 记录自带读服务是否可发读帧 */
export function hasReadService(p) {
  return READ_SIDS.includes(Number(p && p.readSid));
}

/** 记录自带写服务是否可发写帧（0/缺 = 无写服务） */
export function hasWriteService(p) {
  return WRITE_SIDS.includes(Number(p && p.writeSid));
}

/** 只读项判定（参考诊断仪 同款闸：记录无写服务 → 只读） */
export function isReadOnlyItem(p) {
  return !hasWriteService(p);
}

/** 只读原因（给 UI/日志） */
export function readOnlyReason(p) {
  const ws = Number(p && p.writeSid);
  if (!Number.isFinite(ws) || ws === 0) return p?.writeBlockedReason || '源数据无写服务，只能读';
  return `记录 writeSid=0x${ws.toString(16)} 非写服务（参考诊断仪 写帧仅 0x3B/0x2E），只能读`;
}

/**
 * 记录集（同变体）的回落读服务。
 * 参考诊断仪 备份/读码是表级读：参考诊断仪 备份读（参考诊断仪 备份读）取
 * 首记录 readSid 对整个 PID map 发读（代码实证）；readSid=0 的记录
 * 自身无读服务（参考诊断仪 读包装 不打包），值经同表回落读得到。
 * 同表无任何读服务 → null（读不到=不写，RE-FLOWSPEC §4.1）。
 */
export function resolveBlockReadSid(items) {
  for (const it of items || []) {
    if (hasReadService(it)) return Number(it.readSid);
  }
  return null;
}

/**
 * 从原始值里取该参数的字段值。
 * 位域按 LSB 起、可跨字节（bit + bitsize > 8 时进位到下字节）。
 * 返回 null 表示越界。
 *
 * ⚠️ **必须用 BigInt**：JS 的 `1 << i` / `v >> i` 是 32 位运算，i≥32 时按 mod 32 折回。
 * 数据里有 bitsize 40/48/56/64 共 20 条、bitsize=32 且最高位为 1 的 89 条 ——
 * 用 32 位运算会把宽字段的字节打乱（复现：48 位字段从 `01 02 03 04 05 06`
 * 提出 `0x4030605`，应为 `0x060504030201`），且写回时把邻居字节写坏。
 * 返回值：bitsize ≤ 53 时是 Number（保持向后兼容），更大时是 BigInt。
 */
export function extractField(rawBytes, p) {
  const bit = p.bit | 0;
  const size = p.bitsize | 0;
  if (size < 1) return null;
  const need = p.byte + Math.floor((bit + size - 1) / 8);
  if (p.byte < 0 || need >= rawBytes.length) return null;

  let v = 0n;
  for (let i = 0; i < size; i++) {
    const abs = bit + i;                 // 从字段起点算的绝对位
    const bi = p.byte + (abs >> 3);      // 所在字节
    const bb = abs & 7;                  // 字节内位
    if ((rawBytes[bi] >> bb) & 1) v |= (1n << BigInt(i));
  }
  return size <= 53 ? Number(v) : v;
}

/**
 * 把字段值写回原始值（返回新数组，不改原）。
 * 与 extractField 位序一致（LSB 起，可跨字节）。越界返回 null。
 * 同样用 BigInt，避免 bitsize≥32 时写坏字节。
 */
export function injectField(rawBytes, p, value) {
  const bit = p.bit | 0;
  const size = p.bitsize | 0;
  if (size < 1) return null;
  const need = p.byte + Math.floor((bit + size - 1) / 8);
  if (p.byte < 0 || need >= rawBytes.length) return null;

  const out = rawBytes.slice();
  const mask = (1n << BigInt(size)) - 1n;
  let v;
  try {
    v = BigInt(value ?? 0);
  } catch {
    return null;
  }
  if (v < 0n) v = -v & mask;             // 容错负数（bit32 取负的情况）
  v &= mask;
  for (let i = 0; i < size; i++) {
    const abs = bit + i;
    const bi = p.byte + (abs >> 3);
    const bb = abs & 7;
    const m = 1 << bb;
    if ((v >> BigInt(i)) & 1n) out[bi] |= m;
    else out[bi] &= ~m & 0xff;
  }
  return out;
}

/** 枚举值 → 显示文本 */
export function decodeValue(p, raw) {
  if (p.enum) {
    // enum key 可能是 "0x00" 或 "0"，raw 是数字（宽字段可能是 BigInt）
    const rawStr = String(raw);
    let hex;
    try { hex = (typeof raw === 'bigint' ? raw : BigInt(raw)).toString(16).toUpperCase(); }
    catch { hex = Number(raw).toString(16).toUpperCase(); }
    const rawHex = '0x' + hex.padStart(2, '0');
    const rawHexLower = '0x' + hex.toLowerCase().padStart(2, '0');
    return p.enum[rawStr] ?? p.enum[rawHex] ?? p.enum[rawHexLower] ?? String(raw);
  }
  // switch 类型
  if (p.kind === 'switch') {
    return raw === 0 || raw === '0' || raw === 0n ? '关' : '开';
  }
  return String(raw);
}

/** 显示文本 → 枚举值 */
export function encodeValue(p, text) {
  if (p.enum) {
    for (const [k, v] of Object.entries(p.enum)) {
      if (v === text) return Number(k);
    }
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * 输入框文本 → 字段值。
 *
 * ⚠️ bitsize > 53 必须用 BigInt（2026-10-18 审计）：`extractField` 对 40/48/56/64 位
 *    字段返回 BigInt，但 UI 一直用 `Number(input.value)` —— 超过 2^53 会被舍入，
 *    写回时 `injectField` 拿到的就是错值（大字段会写坏相邻位）。
 *    这里按 bitsize 选 Number/BigInt，解析失败返回 null（调用方拒绝写入）。
 */
export function parseFieldInput(p, text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if ((p.bitsize | 0) > 53) {
    try { return BigInt(s); } catch { return null; }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 字段值是否在 min/max 内（兼容 BigInt 与 Number 混用） */
export function fieldInRange(p, v) {
  if (v == null) return false;
  const big = typeof v === 'bigint';
  const lo = p.min == null ? null : (big ? BigInt(p.min) : p.min);
  const hi = p.max == null ? null : (big ? BigInt(p.max) : p.max);
  if (lo != null && v < lo) return false;
  if (hi != null && v > hi) return false;
  return true;
}

/**
 * ★ 2026-11-11 原厂对齐（CODE-AUDIT §5.2 偏离①）：**安全增强开关，默认全关 = 原厂原行为**。
 *
 * 原厂侧（RE-FLOWSPEC §4.0/§4.1 逐指令）的写政策是「备份 →（安全访问）→ 单项写 → 回读」，
 * **没有**值域门禁、没有 level/地址态拒写、没有回读不一致自动回滚（不一致 = 记录失败）。
 * 这些能力是本项目为防止写坏车加的自创保护，现全部改为显式 opt-in：
 *   默认 `false` → 运行时逐帧、逐判定与 原厂一致（验收矩阵「有意偏离 原厂」单列说明）。
 *   打开对应开关才会启用保护（测试/高风险场景可显式 `setSafety({range:true,...})`）。
 *
 * 注意：`hasWriteService`（记录只认 3B/2E）与 LID 位宽校验**不在此列** ——
 *   它们有 原厂证据（写包装只打包 3B/2E；标识符位宽按记录），属于对齐本身，永远生效。
 */
export const SAFETY = {
  range: false,        // 值域门禁（fieldInRange）—— 原厂无
  level: false,        // level/WRITE_ENABLED 严格门禁 —— 原厂无
  addrState: false,    // 地址态拒写（addrSafeForAction）—— 原厂无
  autoRestore: false,  // 回读不一致自动回滚 —— 原厂只记失败
  span: false,         // 变更字节越界检查 —— 原厂无
};

/** 显式开启/关闭安全增强（测试与高风险场景用；默认不调用 = 原厂行为）。 */
export function setSafety(overrides = {}) {
  Object.assign(SAFETY, overrides);
  return { ...SAFETY };
}

/** 严格门禁开关：只在 `SAFETY.level=true` 时参与判定（默认不参与 = 原厂行为）。 */
export const WRITE_ENABLED = true;

export function canWrite(p) {
  if (!hasWriteService(p)) return false;            // 原厂写包装只打包 3B/2E —— 对齐，永远生效
  if (p.lid == null && p.did == null) return false; // 无 LID 无法构帧 —— 对齐，永远生效
  // v0.8.4 批次2 数据门禁：记录自带「写服务/DID 高字节不可证」标注时一律拒写；
  // 只有补齐 7B prefix 证据并撤掉标注后才放行（coding-v2 545 条 v2-only 项）。
  if (p.writeBlockedReason || p.sidPairOk === false) return false;
  if (!SAFETY.level) return true;                   // 原厂：有写服务 + 有 LID 即可写（无 level 门禁）
  if (!WRITE_ENABLED) return p.level === 'write-confirmed';
  return true;
}

export function riskLabel(r) {
  return { low: '低', medium: '中', high: '高' }[r] || r || '未知';
}

/* ──────────────────────────────────────────────────────────────────
 * ★ 2026-11-15 T04-c 裁定 B：功能全集分页枚举（放在 app.js 已 import 的模块里）
 *
 * src/app.js:16 `import { ... } from './schema.js'` —— 本模块确实在 app 的
 * import 图里（esbuild 入口 src/app.js 会把它打进 www/app.bundle.js），
 * 所以 enumeratePages() 不是「只在测试里 import」的死代码。
 *
 * 数据层 data/measure.json / data/actuator.json 的 view.pages[] 按 app.js
 * 现有分组键切组，每组 ≤ app.js 现有渲染上限（30 / 40），不自创新上限；
 * 767 只是 MENU.BIN:0x4C 的条目计数证据，不是分页规则。
 * 运行时消费者 = www/index.html 的 feature-catalog bootstrap（scripts/sync.mjs 注入）。
 * ────────────────────────────────────────────────────────────────── */

/**
 * 按数据层 view.pages 枚举全量条目（差集=0）。
 * 支持两种页码描述：新版 `itemIdx[]`（原数组下标，可跨模块分组、不改动数组顺序）
 * 与旧版 `start/end` 连续区间（向后兼容）。
 * @param {object} doc measure.json / actuator.json
 * @param {string} arrayKey 'params' | 'items'
 * @returns {{total:number,items:object[],diff:number,pages:number,groupsWithinCap:number}}
 */
export function enumeratePages(doc, arrayKey) {
  const arr = Array.isArray(doc?.[arrayKey]) ? doc[arrayKey] : [];
  const pages = Array.isArray(doc?.view?.pages) ? doc.view.pages : [];
  const cap = Number(doc?.view?.groupCap) || Infinity;
  if (!pages.length) return { total: arr.length, items: arr.slice(), diff: 0, pages: 0, groupsWithinCap: 0 };
  const items = [];
  const seen = new Set();
  let groupsWithinCap = 0;
  for (const p of pages) {
    if (Number(p.count) <= cap) groupsWithinCap += 1;
    const idxs = Array.isArray(p.itemIdx)
      ? p.itemIdx
      : Array.from({ length: Math.max(0, Number(p.end) - Number(p.start)) }, (_, k) => Number(p.start) + k);
    for (const i of idxs) {
      if (!Number.isInteger(i) || i < 0 || i >= arr.length || seen.has(i)) continue;
      seen.add(i);
      items.push(arr[i]);
    }
  }
  return { total: arr.length, items, diff: Math.abs(items.length - arr.length),
    pages: pages.length, groupsWithinCap };
}

/* ──────────────────────────────────────────────────────────────────
 * ★ 2026-11-13 UDS 构帧：catalog/枚举路径的**单一来源**（缺陷修复）
 *
 * 背景（复核过的缺陷，不是推测）：
 *   旧 `featureFramesFor('actuator')` 对 `form:'2f'` 构出 `2F<DID4><state>` = **7 字节**，
 *   而原厂实测帧是 **8 字节** `2F 01 01 03 FF 00 00 00`：
 *   UDS 0x2F（InputOutputControlByIdentifier）报文结构是
 *     `2F <DID hi> <DID lo> <controlOption 1B> <controlState …>`
 *   —— **controlOption 是必需字节**（原厂用 0x03 = shortTermAdjustment），旧构帧把它省了，
 *   等于把 state 的第一个字节当成 controlOption 发出去，语义是错的。
 *   同理 `31` 例程帧旧构帧是 `3101<RID4>` = 4 字节，丢了 `sub`（写死 01）与 `params`，
 *   而记录/实测是 `31 <sub> <RID2B> <params…>`（例：`31 01 0005 01 00` = 6 字节）。
 *
 * 证据与校准（2026-11-16 数据层重建后的口径，条数由门禁现算，不写死在这里）：
 *   · 命令块布局 = `[0]变体 [1]类别(2F→01/31→10/容器→FF) [2]controlOption|sub [3]SID
 *     [4:6]==00 00 [6:8]逐项地址 u16 **LE** [8:10]==00 00 [10]选择器`，
 *     `entry.ctrlBytes` 就是整条命令块（典型 11 字节）；
 *   · `form:'2f'` 的逐项 DID = 命令块 +6 的 u16 LE（31 的 RID 同一槽位同一端序）；
 *   · `data/gag-actuators.json`（GAG 实测 2F 帧，71 DID）逐 DID 给出 drive/release
 *     与 observedStates：did 命中实测集的条目 `stateSrc='measured'`，
 *     其余是记录默认 `FF 00 00 00`（`stateSrc='default'`，不冒充实测）；
 *   · `0x31` 的 params 取两个源：GAG 实测例程库（`paramsSrc='gag-lib'`）与包内
 *     `function-sequences.json` 的 31 模板（`paramsSrc='specf-seq' / 'specf-seq-empty'`）；
 *     两表都没有模板时 `paramsSrc='no-template'`（**不等于**「不需要参数」）——
 *     未解决条数见 `source.paramsUnresolved`，六桶分解见 `source.paramsStats`；
 *     记录尾字节是变体选择器，不是载荷；
 *   · 逐项地址的确定性用**结构标签**表达（`didResolve` / `ridResolve`：
 *     `single-address` / `multi-resolved-by-module` / `ambiguous-in-module` / `multi-address`；
 *     多址另带 `multiAddressBasis`，只有 `high-byte-differs` / `high-byte-same` 两个取值）。
 *     `high-byte-differs` 只是「两个候选的高字节不同」这一数值事实，**不声称**分属不同
 *     功能域/模块 —— 实测高字节不是模块族，所以不做 `cross-family` 这种结论式命名；
 *   · 同一 chain 若还有一种 27 字节记录在 `+6` 给出不同地址，条目带
 *     `rawLayoutConflict` / `cmdRaw` / `rawLayoutCandidates`，**取值不取舍**（只并列）。
 *     ⚠️ 另一种形态的读数**不进** `didCandidates`/`ridCandidates`：候选列表的语义是
 *     「规范 11 字节形态下多个 ECU 各有一份同名功能」，与「同一 ECU 的另一种记录写法」
 *     是两件事，混标会把两个事实压成一个数字；
 *   · `driveDisabled === true`（参数多候选 / 两表无模板 / 地址在模块内歧义）时
 *     `featureFramesFor` 一律返回 `[]`：**不发帧**比"发一个猜的帧"安全，理由在
 *     `driveDisabledReason` 里，界面必须显式说出来。
 *   逐条逐字节校准见门禁 `tools/verify-catalog-frame-bytes.mjs`
 *   （stdout 打印的断言名以 `CATALOG_FRAME_BYTE_EQUAL_` 开头，审计器按它判定）。
 *
 * 与生产路径的关系（本次**不改** src/coder.js）：
 *   coder.js:1826 `ioControl()` 构 `2F${did}${co}${state}`（8 字节，正确）；
 *   coder.js:1716 `routineControl()` 构 `31${sf}${rid}${params}`（带 params，正确）。
 *   本模块与它们**同构**，消掉「同一件事两套实现」。
 * ────────────────────────────────────────────────────────────────── */

/** 0x2F 的 controlOption 默认值 = 0x03（shortTermAdjustment；原厂实测值）。 */
export const IO_CONTROL_DEFAULT_OPTION = 0x03;

/** 0x31 的 sub-function 默认值 = 0x01（startRoutine；记录缺 sub 时用）。 */
export const ROUTINE_DEFAULT_SUB = 0x01;

/* 0x2F controlOption 语义（ISO 14229，coder.js:1817-1822 同口径）：
 *   0x00 returnControlToECU / 0x01 resetToDefault
 *   0x02 freezeCurrentState / 0x03 shortTermAdjustment
 * ⚠️ 构帧不把值域卡在 0..3：GAG 实测 observedCtrls 里出现过 0x04（did 0x0110），
 *    卡值域会把实测形态丢掉。值域校验归调用方/门禁，构帧只保证字节形态。 */

/**
 * 把数字/数字串转成整数。`'0x..'` 按 16 进制，纯数字串按 10 进制（与数据文件写法一致）。
 * @param {*} v
 * @returns {number} 非整数返回 NaN
 */
function toIntStrict(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (!s) return NaN;
  if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s.slice(2), 16);
  if (/^[0-9]+$/.test(s)) return Number.parseInt(s, 10);
  return NaN;
}

/** 数字 → 定宽大写 hex（不截断；调用方保证在范围内）。 */
function hexPad(value, width) {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

/**
 * 例程模板字段（`'0x0404'` / `'0404'` / `1028`）一律按 **16 进制** 解析 ——
 * data/routine-templates.json 的 routineId/sub 全部是 0x 前缀 hex 串
 * （139/139），与 coder.js:1723 `routineId.toString(16)` 同口径。
 * @param {*} v
 * @returns {number} 非法返回 NaN
 */
function parseHexNumber(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().replace(/^0x/i, '');
  if (!s || !/^[0-9a-f]+$/i.test(s)) return NaN;
  return Number.parseInt(s, 16);
}

/**
 * 把数据文件里的字节串（`'FF 00 00 00'` / `'FF000000'` / `'0x0B'`）规范化成
 * **大写、无分隔符、长度为偶数**的 hex 串。
 * @param {*} v
 * @returns {string|null} 非法返回 null（调用方拒绝构帧），空值返回 ''
 */
function normalizeHexBytes(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if (!s) return '';
  s = s.replace(/0x/gi, ' ');
  const tokens = s.split(/[^0-9A-Fa-f]+/).filter(Boolean);
  let out = '';
  for (const t of tokens) {
    if (t.length > 2) {
      if (t.length % 2) return null;      // 连写且奇数长度 = 半个字节，拒绝
      out += t.toUpperCase();
    } else {
      out += t.toUpperCase().padStart(2, '0');
    }
  }
  return out.length % 2 === 0 ? out : null;
}

/**
 * 构造 UDS 0x2F（InputOutputControlByIdentifier）请求帧。
 *   `2F <DID 2B> <controlOption 1B> <controlState …>`
 * controlOption 是**必需字节**，不接受「缺失即当作没有」：缺省时显式回落到
 * `IO_CONTROL_DEFAULT_OPTION`（0x03），并把回落依据交给 `resolveIoControlDrive()`
 * / `explainActuatorFrame()` 留痕。
 * @param {number|string} did 标识符 0..0xFFFF
 * @param {number|string} [controlOption] 0..0xFF，缺省 0x03
 * @param {string} [state] 控制状态字节串，如 `'FF 00 00 00'`
 * @returns {string} 大写无空格 hex；参数非法返回 ''
 */
export function buildIoControlFrame(did, controlOption = IO_CONTROL_DEFAULT_OPTION, state = '') {
  const d = toIntStrict(did);
  if (!Number.isInteger(d) || d < 0 || d > 0xffff) return '';
  const co = (controlOption == null || controlOption === '')
    ? IO_CONTROL_DEFAULT_OPTION
    : toIntStrict(controlOption);
  if (!Number.isInteger(co) || co < 0 || co > 0xff) return '';
  const st = normalizeHexBytes(state);
  if (st === null) return '';
  return `2F${hexPad(d, 4)}${hexPad(co, 2)}${st}`;
}

/**
 * 构造 UDS 0x31（RoutineControl）请求帧。
 *   `31 <sub-function 1B> <routineIdentifier 2B> <routineControlOptionRecord …>`
 * params 为请求参数记录（记录字段/模板原样），无则空串（不发明参数）。
 * @param {number|string} [sub] 0..0xFF，缺省 0x01
 * @param {number|string} rid 例程 ID 0..0xFFFF
 * @param {string} [params] 参数字节串，如 `'01 00'`
 * @returns {string} 大写无空格 hex；参数非法返回 ''
 */
export function buildRoutineFrame(sub = ROUTINE_DEFAULT_SUB, rid, params = '') {
  const s = (sub == null || sub === '') ? ROUTINE_DEFAULT_SUB : toIntStrict(sub);
  const r = toIntStrict(rid);
  if (!Number.isInteger(s) || s < 0 || s > 0xff) return '';
  if (!Number.isInteger(r) || r < 0 || r > 0xffff) return '';
  const p = normalizeHexBytes(params);
  if (p === null) return '';
  return `31${hexPad(s, 2)}${hexPad(r, 4)}${p}`;
}

/**
 * drive.state 缺失时的兜底状态（GAG 实测全族 drive 态都是 FF 00 00 00；保留旧行为并留痕）。
 */
const FALLBACK_IO_STATE = 'FF 00 00 00';

/**
 * 从执行器条目解析 0x2F 的 drive 形态，并给出**来源痕迹**（不用默认值掩盖数据缺失）。
 * 旧实现在 drive 缺失时静默回落 `'FF 00 00 00'`，看不出是数据缺还是记录本来如此；
 * 这里把回落显式标成 `fallback-*`。
 * @param {object} entry data/actuator.json 条目
 * @returns {{controlOption:number, controlOptionSource:string, state:string, stateSource:string}}
 */
export function resolveIoControlDrive(entry) {
  const e = entry || {};
  const drive = (e.drive && typeof e.drive === 'object') ? e.drive : {};
  const rawCo = drive.controlOption;
  const co = (rawCo == null || rawCo === '') ? IO_CONTROL_DEFAULT_OPTION : toIntStrict(rawCo);
  const coOk = Number.isInteger(co) && co >= 0 && co <= 0xff;
  const rawState = drive.state;
  const stateEmpty = rawState == null || String(rawState).trim() === '';
  return {
    controlOption: coOk ? co : IO_CONTROL_DEFAULT_OPTION,
    controlOptionSource: coOk
      ? ((rawCo == null || rawCo === '') ? 'default-0x03（entry.drive.controlOption 缺失）' : 'entry.drive.controlOption')
      : `default-0x03（entry.drive.controlOption 非法：${String(rawCo)}）`,
    state: stateEmpty ? FALLBACK_IO_STATE : String(rawState),
    stateSource: stateEmpty ? `fallback-${FALLBACK_IO_STATE.replace(/ /g, '')}（entry.drive.state 缺失）` : 'entry.drive.state',
  };
}

/**
 * 从执行器条目解析 0x31 的 sub/RID/params，并给出参数来源痕迹。
 * `form:'31'` 条目字段为 `sub` / `rid` / `params`（见 tools/build-actuators.py）。
 * @param {object} entry
 * @returns {{sub:number, rid:number, params:string, paramsSource:string, ok:boolean}}
 */
export function resolveRoutineFields(entry) {
  const e = entry || {};
  const sub = (e.sub == null || e.sub === '') ? ROUTINE_DEFAULT_SUB : toIntStrict(e.sub);
  const rid = toIntStrict(e.rid);
  const params = normalizeHexBytes(e.params);
  const ok = Number.isInteger(sub) && sub >= 0 && sub <= 0xff
    && Number.isInteger(rid) && rid >= 0 && rid <= 0xffff
    && params !== null;
  return {
    sub: Number.isInteger(sub) ? sub : ROUTINE_DEFAULT_SUB,
    rid: Number.isInteger(rid) ? rid : NaN,
    params: params == null ? '' : params,
    paramsSource: (e.params == null || String(e.params).trim() === '')
      ? 'empty（记录无参数）'
      : (e.paramsSrc ? String(e.paramsSrc) : 'entry.params'),
    ok,
  };
}

/**
 * 驱动闸的**唯一策略源**（DOM 与执行层共用，不许各抄一份）。
 *
 * `featureFramesFor('actuator')` 只挡 catalog/0x2F 路径；`.actRun → runRoutine`
 * 根本不经过它。因此这里把「能不能驱动」抽成纯函数，执行层在发帧前必须问它。
 *
 * @param {'actuator'|'routine'} kind 策略类别，写错按拒绝处理（不许默认放行）
 * @param {object|null} entry `data/actuator.json` 的条目；查不到时传 null
 * @returns {string|null} null=允许；字符串=禁止理由（优先取数据里的 driveDisabledReason）
 */
export function drivableReason(kind, entry) {
  const k = String(kind || '');
  if (k !== 'actuator' && k !== 'routine') {
    return `驱动策略类别无效（${k || '空'}）：按安全策略拒绝`;
  }
  const e = entry || {};
  if (e.driveDisabled === true) {
    const why = String(e.driveDisabledReason || '').trim();
    return why || '数据标记 driveDisabled 但未写理由（数据缺陷，按禁用处理）';
  }
  return null;
}

/**
 * 从 `data/actuator.json` 的 items 建 rid → 条目索引（执行层反查用）。
 * 同一 rid 有多条时**保守合并**：只要有一条 driveDisabled=true 就禁用整个 rid ——
 * 执行层没有模块上下文，无法在多条之间做选择，猜一条等于赌。
 *
 * @param {Array<object>} items actuator.json 的 items
 * @returns {Map<number, object>} 十进制 rid → 条目
 */
export function buildActuatorRoutineIndex(items) {
  const idx = new Map();
  for (const e of (Array.isArray(items) ? items : [])) {
    if (String(e.form || '').toLowerCase() !== '31') continue;
    const rid = toIntStrict(e.rid);
    if (!Number.isInteger(rid)) continue;
    const prev = idx.get(rid);
    if (!prev || (e.driveDisabled === true && prev.driveDisabled !== true)) idx.set(rid, e);
  }
  return idx;
}

/**
 * 执行器条目的构帧 + 调试痕迹（catalog 路径的**唯一**构帧入口）。
 * `featureFramesFor('actuator', …)` 内部只调本函数，返回值里的 trace 字段说明
 * controlOption/state/params 各自来自记录还是回落，**并原样带出地址确定性的结构标签**
 * （`didResolve` / `ridResolve` / `multiAddressBasis` / `rawLayoutConflict`）——
 * 构帧不因地址有多个候选而改变，歧义只在痕迹与 UI 上显式暴露。
 * @param {object} entry
 * @returns {{form:string, frame:string, byteLen:number, controlOption:number|null,
 *   controlOptionSource:string, state:string, stateSource:string,
 *   sub:number|null, rid:number|null, params:string, paramsSource:string,
 *   didResolve:string|null, ridResolve:string|null, multiAddressBasis:string|null,
 *   rawLayoutConflict:boolean}}
 */
export function explainActuatorFrame(entry) {
  const e = entry || {};
  const form = String(e.form || '').toLowerCase();
  // 地址确定性：数据层给的**结构标签**，这里只透传（不重新判定、不改变构帧结果）
  const addrTrace = {
    didResolve: e.didResolve == null ? null : String(e.didResolve),
    ridResolve: e.ridResolve == null ? null : String(e.ridResolve),
    multiAddressBasis: e.multiAddressBasis == null ? null : String(e.multiAddressBasis),
    rawLayoutConflict: e.rawLayoutConflict === true,
    moduleResolution: e.moduleResolution == null ? null : String(e.moduleResolution),
    // 驱动闸：数据层判定"不能安全驱动"时，构帧结果仍给出，但 UI/调用方应拦下
    driveDisabled: e.driveDisabled === true,
    driveDisabledReason: e.driveDisabledReason == null ? '' : String(e.driveDisabledReason),
  };
  if (form === '2f') {
    const dr = resolveIoControlDrive(e);
    const frame = buildIoControlFrame(e.did, dr.controlOption, dr.state);
    return {
      form, frame, byteLen: frame.length / 2,
      controlOption: dr.controlOption, controlOptionSource: dr.controlOptionSource,
      state: dr.state, stateSource: dr.stateSource,
      sub: null, rid: null, params: '', paramsSource: '',
      ...addrTrace,
    };
  }
  if (form === '31') {
    const rf = resolveRoutineFields(e);
    const frame = rf.ok ? buildRoutineFrame(rf.sub, rf.rid, rf.params) : '';
    return {
      form, frame, byteLen: frame.length / 2,
      controlOption: null, controlOptionSource: '',
      state: '', stateSource: '',
      sub: rf.sub, rid: rf.rid, params: rf.params, paramsSource: rf.paramsSource,
      ...addrTrace,
    };
  }
  return {
    form, frame: '', byteLen: 0,
    controlOption: null, controlOptionSource: '', state: '', stateSource: '',
    sub: null, rid: null, params: '', paramsSource: '',
    ...addrTrace,
  };
}

/**
 * 执行器卡片的**渲染模型**（纯函数，UI 与测试共用同一份，避免"测试断言渲染字符串"）。
 *
 * 三条已确证的 UI 缺陷在这里收口：
 *   ① RID 在数据里是**十进制数字**（`rid: 53250` 实际是 RID 0xD002），旧实现
 *      `String(a.rid).padStart(4,'0')` 直接把十进制当十六进制印出来 → 用户看到
 *      「例程 31 01 53250」。本函数一律走 `ridHex`（缺字段时才用 16 进制补零现算）。
 *   ② 同名多址条目（`didResolve`/`ridResolve` ≠ `single-address`，即候选地址 > 1）**不是多条记录**，
 *      而是同一功能在本目录里有多个候选地址：把候选全列出来并注明本卡片用的是哪个，
 *      避免用户以为看到的是两个不同执行器。
 *   ③ `unverified` / `rawLayoutConflict` 必须有可见标记，不许静默当成可信地址。
 *   ④ `driveDisabled` 必须在卡片上说出来（理由来自数据），否则用户只会看到"点了没反应"。
 *
 * @param {object} entry data/actuator.json 的条目
 * @returns {{form:string, line:string, notes:string[], warn:boolean, usedHex:string}}
 *   `line` = 主行（形态 + 地址 + 平台块/链），`notes` = 需要显式说清的附加事实，
 *   `warn` = 是否该高亮（notes 非空即 true）。
 */
export function describeActuatorCard(entry) {
  const e = entry || {};
  const form = String(e.form || '').toLowerCase();
  const didNum = toIntStrict(e.did);
  const ridNum = toIntStrict(e.rid);
  const lidNum = toIntStrict(e.lid);

  let line = '';
  let usedHex = '';
  if (form === '2f' && Number.isInteger(didNum)) {
    usedHex = String(e.didHex || `0x${hexPad(didNum, 4)}`);
    line = `驱动 2F ${usedHex} · 回位 ctrl 0x00`;
  } else if (form === '31' && e.rid != null) {
    // ★ 必须用 ridHex：rid 是十进制数，直接 padStart 会把 53250 显示成「53250」
    usedHex = String(e.ridHex || (Number.isInteger(ridNum) ? `0x${hexPad(ridNum, 4)}` : ''));
    line = `例程 31 01 ${usedHex}（执行=启动+轮询 31 03）`;
  } else if (form === '30' && Number.isInteger(lidNum)) {
    usedHex = `0x${hexPad(lidNum, 2)}`;
    line = `本地标识符 ${usedHex}（KWP 0x30，本目录不构帧）`;
  } else {
    line = '状态 / 信息项（目录项）';
  }
  // 平台块 / chain：给的是"这条记录在哪"，不声称能区分同名条目
  // （同名多址条目常常同 chain 同 block，见 notes 里的候选清单）。
  if (e.block && e.chain) line += ` · ${e.block} / ${e.chain}`;

  const notes = [];
  const cands = form === '2f' ? e.didCandidates : (form === '31' ? e.ridCandidates : null);
  const resolve = form === '2f' ? e.didResolve : (form === '31' ? e.ridResolve : '');
  // 多候选（multi-resolved-by-module / ambiguous-in-module / multi-address）都要列候选：
  // 判"能不能按模块拆开"是**数据层**的事，用户要看的始终是"这个功能在本目录有几个地址、
  // 本卡片用的是哪个"。只认 multi-address 会让 18 条里的 13 条在界面上无声消失。
  const multiCand = resolve !== 'single-address' && resolve !== 'unverified' && !!resolve;
  if (multiCand && Array.isArray(cands) && cands.length > 1) {
    const list = cands
      .map((c) => String(c.didHex || c.ridHex || ''))
      .filter(Boolean)
      .join(' / ');
    notes.push(`该功能在本目录有 ${cands.length} 个候选地址：${list}（本卡片用 ${usedHex || '?'}）`);
  }
  if (resolve === 'unverified') {
    notes.push(`地址待验证（${usedHex || '?'} 低于命名空间底线 0x0100，且无实测背书）`);
  }
  if (e.rawLayoutConflict === true && Array.isArray(e.rawLayoutCandidates)) {
    const list = e.rawLayoutCandidates
      .map((c) => `${String(c.valueHex)}（${c.layout === 'cmd-block-11B' ? '11 字节规范块' : '27 字节块'}）`)
      .join(' / ');
    notes.push(`记录存在两种布局：${list}；本卡片按 11 字节规范块取值`);
  }
  if (e.driveDisabled === true) {
    // 理由必须是数据给的（数据没写就如实说"没写"，不许在这里编一个）
    const why = String(e.driveDisabledReason || '').trim();
    notes.push(`本卡片已禁用驱动${why ? `：${why}` : '（数据未写理由 —— 视为数据缺陷）'}`);
  }
  return { form, line, notes, warn: notes.length > 0, usedHex };
}

/**
 * 由静态记录生成 elm.cmd 帧（记录驱动，不替记录发明默认值）。
 * @param {'measure'|'actuator'|'routine'} kind
 * @param {object} entry
 * @returns {string[]} 大写无空格 hex 帧
 */
export function featureFramesFor(kind, entry) {
  const e = entry || {};
  if (kind === 'measure') {
    const sid = Number(e.readSid ?? 0x22);
    const pid = Number(e.pid ?? e.lid);
    if (!Number.isInteger(sid) || !Number.isInteger(pid)) return [];
    const width = sid === 0x22 ? 4 : 2;   // 22 <DID2B> / 21|1A <LID1B>
    return [`${sid.toString(16).toUpperCase().padStart(2, '0')}`
      + `${pid.toString(16).toUpperCase().padStart(width, '0')}`];
  }
  if (kind === 'actuator') {
    // ★ 单一来源：0x2F / 0x31 都走 explainActuatorFrame（内部调 build* 纯函数）
    // ★ 数据层说这条不能安全驱动（参数多候选 / 无模板 / 模块级地址歧义）时**不出帧**：
    //   给 UI 一个"看起来能发"的帧，比不给帧危险得多（标定值猜错等于写坏 ECU）。
    if (e.driveDisabled === true) return [];
    const r = explainActuatorFrame(e);
    return r.frame ? [r.frame] : [];
  }
  if (kind === 'routine') {
    // 例程模板（data/routine-templates.json）：routineId/sub/params 原样构帧，
    // 与 coder.js:1725 `31${sf}${rid}${params}` 同构；模板无参数时就是 `31<sub><RID2B>`。
    const rid = parseHexNumber(e.routineId);
    const sub = (e.sub == null || e.sub === '')
      ? ROUTINE_DEFAULT_SUB
      : parseHexNumber(e.sub);
    const frame = buildRoutineFrame(sub, rid, e.params);
    return frame ? [frame] : [];
  }
  return [];
}

// ★ T04-c 裁定 B：把枚举/构帧能力挂到 app 运行时全局。
//   app.js:16 已 import 本模块，这段模块级副作用会在 app 启动时执行，
//   esbuild 不会把「未被 app.js 具名 import 的纯 export」tree-shake 掉，
//   因此 enumeratePages/featureFramesFor 确实存在于 www/app.bundle.js 的
//   运行时里，而不是只在测试里 import 的死代码。
//   www/index.html 的 feature-catalog bootstrap 直接消费这两个全局函数。
//   与 app.js:829 的 `globalThis.setWriteGateMode` 是同一种生产接线方式。
if (typeof globalThis !== 'undefined') {
  globalThis.__pcEnumeratePages = enumeratePages;
  globalThis.__pcFeatureFramesFor = featureFramesFor;
  // ★ 2026-11-13 构帧单一来源：把纯构帧函数与调试痕迹也挂出来，
  //   门禁/审计脚本可在浏览器控制台里直接复算 2F/31 帧（不必再抄一遍构帧逻辑）。
  globalThis.__pcBuildIoControlFrame = buildIoControlFrame;
  globalThis.__pcBuildRoutineFrame = buildRoutineFrame;
  globalThis.__pcExplainActuatorFrame = explainActuatorFrame;
  // 卡片渲染模型：UI 与 e2e 共用同一份，测试断言的是**函数返回值**而不是渲染字符串/正则
  globalThis.__pcDescribeActuatorCard = describeActuatorCard;
}
