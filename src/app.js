/**
 * app.js — 对齐参考诊断仪 的层级交互。
 *
 * 层级（参考诊断仪真实菜单）：
 *   L0 请选择车型 → 自动搜索 / 手动选择 / 特殊功能 / 在线功能 / ADAS 校准 / 防盗功能 / 安全网关
 *   L1 车系组（9 个）
 *   L2 车型（21 个）
 *   L3 快速测试 / 系统扫描 / 系统选择
 *   L4 系统列表（带 ECU 号）
 *   L5 功能（设码 / 编程 / 特殊功能 …）
 *   L6 条目 / 子功能
 *
 * 连接与适配器通信参考同门工具；车上的读写走本项目协议层（coder.js）。
 */
import { Coder, CodingError, MissingSeedKeyError, parseResp, parseRespCaf1, parseRespAuto, frameIdsOf, atCmdOk, familyOfReadSid, familyOfItems } from './coder.js';
import { canWrite, riskLabel, extractField, decodeValue, validateParam, parseFieldInput, fieldInRange, hasReadService, hasWriteService, isReadOnlyItem, readOnlyReason, resolveBlockReadSid, WRITE_SIDS, READ_SIDS, SAFETY } from './schema.js';
import { makeProvider, pickVariant } from './seedkey.js';
import { autoPickVariant, pickVariantByPart, pickModelByName, pickFamilyByEvidence, designationFrom } from './variant.js';
import { MODULE_TO_ECUID as MODULE_TO_ECUID_MAP, MODULE_TO_ECUID_LEGACY, SYSTEM_TO_ECUID } from './module-ecu-map.js';
import { sysIdForModule, modulesForSysId, planSysIdFor, platformInfoFor } from './model-sysid-map.js';

// 地址探测指令（已逆，见 ECU-ADDRESSING-20261019.md §8）
// sel=blockKey → 探测命令，用响应 flags 消歧候选地址
// ★ 2026-11-05 终审②：PROBE_CMD_BY_ECU/DEFAULT_PROBE_CMD 随手工猜测桥退役（探测族报文走 blockKey 映射）。
import { makeResolverProvider, SeedKeyUnresolvedError, resolveKeyByName, resolveKey } from './seedkey-resolver.js';
import { nonAsapForName, nonAsapForModule, platformForModel } from './seedkey-nonasap.js';
import { variantForName, NAME_TO_VARIANT } from './seedkey-name-map.js';
/** DRIVELINKS：ECU_ID → 条目数组（原厂权威）。
 *  ★ 2026-11-09 mode 收口：条目 = {t,bk,recOff,recOffsetLo,recOffsetHi,mode,family,session[,state]}；
 *    mode/family/session = 记录 u32 复合真值（mode=低字节=securityModel mode）；
 *    recOffsetLo/Hi = 记录偏移拆字节（旧 m/l 改名，禁当 mode/LID 用）。 */
let drivelinks = null;
/** ECU 寻址表（2026-10-19 RE 实证）：sysId → {tx,rx,confidence,...} */
let ecuAddrTable = undefined;
/** 进模块绑定计划（data/bind-plan.json，来自 drivelinks-v3）：n=0 → 直接绑定（参考诊断仪 cbz 分支） */
let bindPlan = undefined;
async function ensureBindPlan() {
  if (bindPlan !== undefined) return bindPlan;
  try {
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 1500) : null;
    const r = await fetch('data/bind-plan.json', ctl ? { signal: ctl.signal } : {});
    if (timer) clearTimeout(timer);
    bindPlan = r.ok ? await r.json() : null;
  } catch { bindPlan = null; }
  return bindPlan;
}
function bindPlanFor(sysId) {
  if (!bindPlan || !sysId) return null;
  return bindPlan.ecu?.[String(sysId).toLowerCase()] || null;
}

/**
 * 模块记录家族统计（data/module-family.json）。
 *
 * ⚠️ 2026-11-10：此前三处各自内联加载，且 `familyFor()` 在**加载之前**就被调用 →
 *    首次进模块时 family 恒为 null，UDS 模块被当成「族未证」走 KWP 会话流（不发 10 03）。
 *    统一成一个限时加载器，并在定族之前显式 await。
 */
async function ensureModuleFamily() {
  if (moduleFamily !== undefined) return moduleFamily;
  try {
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 1500) : null;
    const r = await fetch('data/module-family.json', ctl ? { signal: ctl.signal } : {});
    if (timer) clearTimeout(timer);
    moduleFamily = r.ok ? await r.json() : null;
  } catch { moduleFamily = null; }
  return moduleFamily;
}

/**
 * 诊断段枚举 + 身份映射（data/bind-plan 里没有候选的模块走这条）。
 *
 * 依据：参考诊断仪的绑定入参是请求键、地址由链路层解析；我们没有那一层，
 * 只能靠运行时候选。做法 = 逐地址 1 帧 + 回帧 ID 校验，再按识别码归模块。
 */
const LIVE_KEY = 'pc_live_map_v1';
let liveMap;                       // { vin, ts, live:[{tx,rx,ident}], map:{module:{tx,rx,ident}} }

function loadLiveCache() {
  try { const raw = localStorage.getItem(LIVE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveLiveCache(v) {
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(v)); } catch { /* 隐私模式/配额：忽略 */ }
}

const hx = (n) => n.toString(16).toUpperCase();

async function sweepAndMap(vin, menuModules) {
  const elm = coder && coder.elm;
  if (!elm) return null;
  const t0 = Date.now();
  await atCmdOk(elm, 'ATSP6', 1500).catch(() => {});
  // 放开接收过滤（ATAR=auto receive，等价"收全部"），并把 ELM 超时压到 32ms ——
  //   否则 256 地址每个等 1s。注意不要用 ATCRA000：那是把过滤设成 ID 0，会一帧都收不到。
  await elm.cmd('ATAR', 800, { noDelay: true }).catch(() => {});
  await elm.cmd('ATST08', 800, { noDelay: true }).catch(() => {});
  const found = [];
  // ⚠️ 2026-11-10：showLoading 放到循环外。此前每扫一个地址就重建/重写一次遮罩
  //   （256 次 DOM 写入 + 取消回调重绑），本身就是扫描耗时的一部分。
  if (typeof showLoading === 'function') {
    showLoading('正在枚举诊断地址', '0 个活地址', () => { probeAbort = true; });
  }
  for (const c of sweepPlan()) {
    if (probeAbort) break;
    if (typeof updateLoading === 'function') {
      updateLoading('正在枚举诊断地址', `${found.length} 个活地址 · 0x${hx(c.tx)}`);
    }
    try { await atCmdOk(elm, `ATSH${hx(c.tx)}`, 600, { noDelay: true }); } catch { continue; }
    let r = '';
    try { r = await elm.cmd('221409', 400, { noDelay: true }) || ''; } catch { r = ''; }
    const ids = frameIdsOf(r);
    const body = Array.from(parseRespAuto(r, '221409', 0x22).body || [])
      .map((x) => x.toString(16).padStart(2, '0')).join('');
    if (classifyProbe(c, ids, body) === 'alive') found.push({ tx: c.tx, rx: c.rx });
  }
  // 身份：活地址逐个读 22 F1 A2（识别串），归到模块
  const reg = await ensureIdentRegistry();
  const live = [];
  for (const f of found) {
    try { await atCmdOk(elm, `ATSH${hx(f.tx)}`, 600, { noDelay: true }); } catch { continue; }
    let r = '';
    try { r = await elm.cmd('22F1A2', 600, { noDelay: true }) || ''; } catch { r = ''; }
    // 只认该地址自己回的帧（ATAR 关掉了接收过滤，总线上别的帧也会进来）
    const ids = frameIdsOf(r);
    if (ids.length && !ids.includes(f.rx)) continue;
    const b = Array.from(parseRespAuto(r, '22F1A2', 0x22).body || []);
    const txt = b[0] === 0x62
      ? b.slice(3).filter((c) => c >= 0x20 && c < 0x7f).map((c) => String.fromCharCode(c)).join('').trim()
      : '';
    live.push({ ...f, ident: txt, modules: moduleFromIdent(txt, reg && reg.identToVariant) });
  }
  await elm.cmd('ATSTFF', 800, { noDelay: true }).catch(() => {});
  if (typeof hideLoading === 'function') hideLoading();
  const map = buildModuleMap(live, menuModules || []);
  liveMap = { vin: vin || '', model: currentModel || '', ts: Date.now(), live, map };
  // ⚠️ 取消 / 零结果**不写缓存**：中断的扫描和「当时连不上」都会被当成 24h 内的真相，
  //    下次进模块直接命中空表 → 永远进不去（还得清 localStorage 才能救）。
  if (!probeAbort && found.length) saveLiveCache(liveMap);
  log(`  · 枚举完成：${found.length} 个活地址 · 识别出 ${Object.keys(map).length} 个模块`
    + ` · ${((Date.now() - t0) / 1000).toFixed(1)}s`, found.length ? 'ok' : 'warn');
  for (const l of live) {
    log(`    0x${hx(l.tx)}/0x${hx(l.rx)}${l.ident ? `「${l.ident.slice(0, 20)}」` : ''}`
      + `${l.modules && l.modules.length ? ' → ' + l.modules.join('/') : ''}`, 'info');
  }
  return liveMap;
}

async function ensureLiveMap(vin, menuModules) {
  // 内存缓存也必须校验 VIN；否则同一会话换车后仍会沿用上一辆车的地址表。
  if (liveMap !== undefined) {
    if (vin && cacheFresh(liveMap, vin) && liveMap.model === currentModel) return liveMap;
    if (!vin && !liveMap.vin && liveMap.model === currentModel) return liveMap;
  }
  const c = loadLiveCache();
  // ⚠️ 没有 VIN（手动选车型/读 VIN 失败）时**不许用磁盘缓存** ——
  //    缓存是按 VIN 键控的，空 VIN 会让 cacheFresh 跳过比对，直接把上一台车的地址表用上来。
  if (vin && cacheFresh(c, vin) && c.model === currentModel) {
    liveMap = c;
    log(`  · 活地址表：缓存命中（${(c.live || []).length} 个地址，${new Date(c.ts).toLocaleString()}）`, 'info');
    return liveMap;
  }
  liveMap = await sweepAndMap(vin, menuModules);
  return liveMap;
}
let moduleFamily = undefined;   // 模块记录家族统计（data/module-family.json，通用规则信号②）
// ★ 2026-11-05：零件号→(模块,变体) 会话库映射（参考诊断仪 同款变体落定，懒加载）。
let ecuPartMap = undefined;
async function ensureEcuPartMap() {
  if (ecuPartMap !== undefined) return ecuPartMap;
  try {
    const r = await fetch('data/ecu-part-map.json');
    ecuPartMap = r.ok ? await r.json() : null;
  } catch { ecuPartMap = null; }
  return ecuPartMap;
}
// ★ 2026-11-09：识别串→家族/变体注册表（DSN.BIN 挖掘，data/ident-registry.json，懒加载）。
//   DME 族身份记录=1A 9F（真车日志 5A 9F"P200"互证）、PSM/BCM 族=22 F1 A2。
let identRegistry = undefined;
async function ensureIdentRegistry() {
  if (identRegistry !== undefined) return identRegistry;
  try {
    const r = await fetch('data/ident-registry.json');
    identRegistry = r.ok ? await r.json() : null;
  } catch { identRegistry = null; }
  return identRegistry;
}

/**
 * 模块名 → DRIVELINKS 的 ECU_ID（0x0bXX）。
 *
 * 2026-11-09：归属表已建（src/module-ecu-map.js，SYS_DATA 名字记录 name-9 / 同组证据），
 *    DRIVELINKS 条目已带记录真值 mode —— 「照抄 securityModel 的 mode 表」路径可达。
 */
const MODULE_TO_ECUID = MODULE_TO_ECUID_MAP;

/**
 * ★ 2026-11-11 全车型推广（RE-CODINGADDR-20261110 §6 步骤1-3）：sysId 按当前车型平台解析。
 *   - 981（9X1/0x0E）解析结果与全局表逐键相同 → 已验收行为零变化；
 *   - 其它 high/medium 平台（Macan 0x0F、Cayenne 9PA 0x0C、992 0x14、Taycan 0x15…）
 *     用平台专属 sysId（精确交集定代际 + name-9/comm 子表精确 join），
 *     中文菜单标签按「系统家族低字节跨代不变」精确平移（IC 0x0?08、ACC3 0x0?40 …）；
 *   - low/unresolved 平台（986/996/987/Carrera GT/Panamera 970）返回 null → 回退全局表，
 *     **宁可不覆盖也不猜**。
 *   - currentModel 未选（null / 测试环境）时同样回退全局表，保持确定性。
 */
const moduleFallbackSysId = (m) => platformInfoFor(currentModel)
  ? (MODULE_TO_ECUID[m] || null)
  : (MODULE_TO_ECUID_LEGACY[m] || MODULE_TO_ECUID[m] || null);

const sysIdForLabel = (label) => {
  // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑧）：只做**精确键**。
  //   删除「家族低字节跨代平移」（platformSysIdByLowByte）—— 那是自创推断
  //   （IC 0x0E08 → Macan 0x0F08 靠低字节猜），原厂无此语义。
  //   平台专属 sysId 只按**模块名精确查**（sysIdForMod，数据源 all-model-sysids 精确 join）；
  //   中文标签仅在 981（0x0E 全局表）有效，其它平台返回 null 让上层用 sys.modules。
  const g = SYSTEM_TO_ECUID[label] || moduleFallbackSysId(label);
  if (!g) return null;
  const info = platformInfoFor(currentModel);
  if (info && info.gen && info.gen !== '0x0e') return null;
  return g;
};
const sysIdForMod = (m) => platformInfoFor(currentModel)
  ? sysIdForModule(m, currentModel)   // 已定案平台缺证据就缺证据，不回退到其它代际
  : moduleFallbackSysId(m);           // 未定案/未选车型使用独立旧代表，避免覆盖 981 主表
const sysIdForModules = (modules) => {
  const sids = [...new Set((modules || []).map((m) => sysIdForMod(m)).filter(Boolean))];
  // 多候选模块映射到不同 sysId 时身份未定，不能取首模块冒充当前 ECU。
  return sids.length === 1 ? sids[0] : null;
};
const modsForSysId = (sysId) => {
  const hit = modulesForSysId(sysId, currentModel);
  if (hit.length || platformInfoFor(currentModel)) return hit;
  return [...new Set([...Object.keys(MODULE_TO_ECUID), ...Object.keys(MODULE_TO_ECUID_LEGACY)])]
    .filter((m) => moduleFallbackSysId(m) === sysId);
};

import { LinkDoctor } from './link-doctor.js';
import { parseDtcPayload } from './dtc.js';
import { MockAdapter } from './mock-adapter.js';
import { Elm327 } from './elm327.js';
import { probeList, identMatch } from './probe.js';
import { sweepPlan, classifyProbe, moduleFromIdent, buildModuleMap, cacheFresh } from './sweep.js';

/**
 * ECU 物理地址表（CAN 请求/应答 ID）。
 *
 * ⚠️ 地址是上车实测出来的，**猜不得** —— 硬编码一个地址读所有模块是读不到的（实车教训）。
 * 每条带 `state`：
 *   'measured'  实测确认
 *   'candidate' 按 OBD-II 物理寻址规律（0x7E0-0x7E7 请求 / +8 应答）推测，**未验证**
 *   'unknown'   猜不出来，必须先跑 link-doctor.js L5「地址扫描」实测再填
 *
 * ⚠️ 0x7E0-0x7E7 只有 **8 个槽位**，应答占 0x7E8-0x7EF。
 *   所以「IC(仪表) = 0x7E8」是**错的**：0x7E8 已经是 DME 的应答 ID，
 *   拿它当请求 ID 会和 DME 应答撞。仪表在保时捷上多半在 0x7E0 系之外
 *   （网关就是 0x710/0x77A，应答≠请求+8）。
 *   → 已改为 unknown，等地址扫描实测。
 *
 * 验证方法：连接自检 L5 会逐个地址发 KWP 1A 9F，有应答的就是实测值，回填到这里并标 'measured'。
 */
const ECU_ADDR = {
  'ECM/DME(发动机控制模块)': { tx: 0x7E0, rx: 0x7E8, state: 'measured', note: '实测' },
  '网关':                  { tx: 0x710, rx: 0x77A, state: 'measured', note: '实测（rx≠tx+8）' },
  // 981/718/991 的 CAN 诊断地址按 ECU 顺序：7E0 DME、7E1 PDK、7E2 PSM、
  // 7E3 Airbag、7E4 IC、7E5 AC、7E6 PASM、7E7 TPM。此前 7E2/7E4/7E5/7E6 整体错位，
  // 会把 AC 当 PASM、PSM 当 IC；2026-10-18 按 参考诊断仪 可进模块 + 该顺序修正。
  '安全气囊':               { tx: 0x7E3, rx: 0x7EB, state: 'candidate', note: '标准 7E3；可进入' },
  'SRS(安全气囊)':          { tx: 0x7E3, rx: 0x7EB, state: 'candidate', note: '标准 7E3；可进入' },
  'ESP/PSM(电控稳定系统)':   { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: '标准 7E2；可进入' },
  'PSM':                    { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: '标准 7E2；可进入' },
  'AC(空调系统)':           { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '标准 7E5；可进入' },
  '空调':                   { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '标准 7E5；可进入' },
  '空调压缩机':              { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '标准 7E5；可进入' },
  // ★ 2026-11-08 IC 寻址改走**寻址表链**（任务清单② 零特判）：候选由 ecu-addresses.json
  //   解析（代际同名合并 R1 + KWP 代缺口低字节补 join R2，见 tools/export-ecu-address.py），
  //   内置表不再给猜测对（旧 0x7E4/0x7E8 与 internal 0x0117 UDS 簇短名单同为猜测/错误）。
  //   rx=tx+8 惯例（GW=710/77A 实证 rx 可≠+8，运行时以应答为准）。
  'IC(仪表)':               { tx: null, rx: null, state: 'unknown', note: '寻址表链解析（RE-MODELADDR §2.2 R1/R2）' },
  '组合仪表':               { tx: null, rx: null, state: 'unknown', note: '寻址表链解析（RE-MODELADDR §2.2 R1/R2）' },
  'EPS(电动助力转向系统)':   { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  '电动转向':               { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  '动力转向':               { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  'Tiptronic 变速器控制':    { tx: 0x7E1, rx: 0x7E9, state: 'candidate', note: '标准 7E1；可进入' },
  'TCM/PDK(自动变速箱控制模块)': { tx: 0x7E1, rx: 0x7E9, state: 'candidate', note: '标准 7E1；可进入' },
  '驻车制动器':             { tx: null, rx: null, state: 'unknown', note: '7E3 与安全气囊冲突，待 CAN 表/扫描；不能猜' },
  // 由 PORSCHE_SYS_DATA 的 CAN/internal 表得：PASM internal 0x1CB → CAN 0x7D0；
  // BCM_hinten internal 0x1C6 → 0x74F；BCM_vorne internal 0x1C7 → 0x7D1。
  '水平高度控制/PASM':      { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  'PASM（保时捷主动悬架管理系统）': { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  'PASM(水平高度控制)':     { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  'PASM':                   { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  '后端电子设备':            { tx: 0x74F, rx: 0x757, state: 'candidate', note: 'PORSCHE_SYS_DATA 1C6→74F' },
  '前端电子设备':            { tx: 0x7D1, rx: 0x7D9, state: 'candidate', note: 'PORSCHE_SYS_DATA 1C7→7D1' },
  // 'PDC' 死键已删（2026-10-19）：菜单标签是「驻车辅助系统」，同址 0x7CF/0x7D7，
  // 留着会和 measured 冲突（smoke: candidates do not clash with measured ids）。
  '驾驶员侧座椅存储器':      { tx: 0x7D9, rx: 0x7E1, state: 'candidate', note: 'CAN 表 1CF 候选 7D9' },
  '乘客侧座椅存储器':        { tx: 0x7DA, rx: 0x7E2, state: 'candidate', note: 'CAN 表 1CF 候选 7DA' },
  '前摄像头':                { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: 'CAN 表 1CE→7E2' },
  '倒车摄像头':              { tx: 0x76D, rx: 0x775, state: 'candidate', note: 'CAN 表 1D0 候选 76D' },
  '左侧前照灯':              { tx: 0x719, rx: 0x721, state: 'candidate', note: 'CAN 表 110 候选 719' },
  '右侧前照灯':              { tx: 0x71A, rx: 0x722, state: 'candidate', note: 'CAN 表 110 候选 71A' },
  '中央前照灯':              { tx: 0x719, rx: 0x721, state: 'candidate', note: 'CAN 表 110 候选 719' },

  '轮胎压力监控 （TPM）':    { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
  '轮胎压力监控':            { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
  'TPM':                    { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
  // ── 2026-10-19 审计：菜单实际标签别名（原键在菜单里不存在，成死键）──
  '驻车辅助系统':            { tx: 0x7CF, rx: 0x7D7, state: 'measured', note: 'RE 锚点 0x0B12→7CF/7D7（ECU-ADDRESSING §2）' },
  '右前照灯':                { tx: 0x71A, rx: 0x722, state: 'candidate', note: 'CAN 表 110 候选 71A' },
  'TPMS/TPM(胎压监控系统)':  { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
};

/**
 * 会话流家族 —— 通用规则（任务清单⑤ / RE-FLOWSPEC §6，零特判）：
 *   KWP 流=10 89 直接建会话（不发 10 03）；UDS 流=10 03（§1.3「另含」）。
 *   信号（全部数据驱动，按优先级收集）：
 *     ① 记录 SID 字段（readSid / 记录集多数）—— §6 分派键；
 *     ② 目标模块记录统计（data/module-family.json，由 data/models 全量记录生成）；
 *     ③ 寻址表行 proto（SYS_DATA proto 0x01=KWP 0x03=UDS，RE-MODELADDR §2.1）。
 *   合并：任一信号=KWP → 'kwp'（10 89 主会话全库×4 两族通用零错，§1.3）；
 *   全部信号=UDS → 'uds'；无信号 → null（按规格未覆盖，走 10 89 同形）。
 */
function familyFor(label, tx = null, { readSid = null, items = null, modules = null } = {}) {
  const signals = [];
  const push = (f) => { if (f) signals.push(f); };
  if (readSid != null) push(familyOfReadSid(readSid));
  if (items && items.length) push(familyOfItems(items));
  // ② 模块记录统计：优先显式模块集（进模块流），无则按 label→sysId→模块反查
  // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离④）：删除 `N.includes(k)||k.includes(N)` 的
  //   模糊键查找（与「禁止近似 join / 不猜」纪律冲突，且模糊结果会决定发不发 10 03）。
  //   现在只做**精确键**：label 精确命中 SYSTEM_TO_ECUID / MODULE_TO_ECUID / 平台映射。
  let mods = (modules || []).filter(Boolean);
  if (!mods.length && label) {
    let sysId = sysIdForLabel(label);
    if (!sysId) sysId = sysIdForMod(label);
    if (sysId) {
      mods = modsForSysId(sysId);
    }
  }
  if (mods.length && typeof moduleFamily !== 'undefined' && moduleFamily) {
    let kwp = 0, uds = 0;
    for (const m of mods) {
      const st = moduleFamily[m];
      if (!st) continue;
      kwp += st.kwp || 0; uds += st.uds || 0;
    }
    if (kwp || uds) push(kwp >= uds ? 'kwp' : 'uds');
  }
  // ③ 【2026-11-10 删除】原「按 tx 查寻址表行的 proto」信号。
  //    证据：真车日志里连接阶段对 DME(0x7E0) 发了 `1003`（=判成 uds），
  //    但 DME 是 KWP —— coding-v2 里 DME_BDE_Continental 39 条全是 readSid=0x21/0x3B，
  //    module-family.json 也是 kwp 4104 : uds 324。说明表 A 行的 proto 字段不可靠：
  //    同一 tx 会命中多行、proto 混杂，先命中的那条就决定了结果。
  //    删掉后：连接阶段无信号 → family=null → 走 10 89（对 DME 正确）；
  //    进模块阶段由 ②（模块记录统计，43/47 模块有确定答案）定族。
  void tx;
  if (signals.includes('kwp')) return 'kwp';
  if (signals.includes('uds')) return 'uds';
  return null;
}

// ★ 2026-11-05 终审③：地址缓存/手工兜底退役 —— 参考诊断仪 每次进模块新鲜解析
//   （表+运行时绑定），解析失败=物理下限终态，不再手工救。

/**
 * 从 RE 实证地址表查 sysId（2026-10-19）。
 * proven 条目直接返回 tx/rx；candidate 只返回候选提示，不瞎猜。
 */
function ecuAddrFromTable(label, sys) {
  if (!ecuAddrTable) return null;
  // ① 精确 label ② label 的模块名走 MODULE_TO_ECUID ③ sys.modules 兜底
  //   （2026-10-19 审计：只查 SYSTEM_TO_ECUID 会漏「停车辅助」→PDC、「RTM Gateway」→CAN_CAN_Gateway）
  let sysId = sysIdForLabel(label);
  if (!sysId) sysId = sysIdForMod(label);
  if (!sysId && sys?.modules?.length) sysId = sysIdForModules(sys.modules);
  if (!sysId) return null;
  const key = sysId.toLowerCase();
  const hit = (ecuAddrTable.entries || []).find(
    (e) => e.sysId && e.sysId.toLowerCase() === key);
  if (!hit) return null;
  if (hit.confidence === 'proven' && hit.tx != null && hit.rx != null) {
    return {
      tx: parseInt(hit.tx, 16), rx: parseInt(hit.rx, 16),
      state: 'measured',
      note: `RE 锚点（${hit.source || 'ECU-ADDRESSING-20261019'}）`,
    };
  }
  if (hit.needsProbe && hit.probeCmd?.length) {
    return {
      tx: null, rx: null, state: 'needs-probe',
      note: `需探测 sysId=${hit.sysId} blockKeys=${hit.blockKeys?.join(',') || '?'}`,
      probeCmd: hit.probeCmd[0],
    };
  }
  return null;
}

// ★ 2026-11-05 终审②：ECU_NUM_TO_ADDR/ecuAddrFromNum 手工猜测桥整体退役 —— v5 表+探针覆盖。

/**
 * 地址探测指令：对候选 CAN 地址逐个发识别探针，找模块地址。
 * 对齐参考诊断仪的运行时探测逻辑（ECU-ADDRESSING-20261019.md §8）。
 * 探测顺序：先试标准 OBD 范围（7E0-7E7），再试保时捷扩展范围（700-7EF）。
 * 返回 {tx, rx} 或 null。
 */
// ★ 2026-11-05 终审①：EXT_ADDRS 手工地址表退役 —— 候选序=表行序（cands/candsAux）+探测族序。

/**
 * 候选地址的探测帧（按协议族）—— **每候选 1 帧**，与 原厂`DriveLinksMode_1001` 一致。
 *
 * 依据（.so 逐指令，RE-DISCOVERY-20261110 §1）：
 *   `0x18f4c/0x18f52 movw sl,#0x1409; movt sl,#0xff00` → 发现帧 `0xFF001409`(22 14 09)；
 *   `0x18f8c blx r3` 对**每个候选只发 1 帧**（mode=1）；`0x18fa2..0x18fbc` 才是
 *   `send(0x10000359,A,2)` 绑定；`0x18fe2 movw r0,#0x1102` = 绑定失败补帧 `22 11 02`。
 *
 * ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.1 偏离②）：删除 2026-11-10 的自创扩展
 *   （每族 2–3 帧：`221409`+`221102`、`1A9F`+`3E`、族未证三帧）。原厂每候选只 1 帧；
 *   补帧 `22 11 02` 只发生在 **n=0 链路绑定失败**（见 probeAddressFor 的 bindDirect 分支）。
 *   KWP 族的 1A 9F 有实车证据（DME 回 `5A 9F …`，且拒绝 `22 F1 A2`/`3E 00` 子功能）。
 *
 * @param {'kwp'|'uds'|null} family
 * @returns {string[]} 单帧数组（保持数组形状，调用方按顺序发）
 */
function probeChainFor(family) {
  if (family === 'kwp') return ['1A9F'];
  return ['221409'];   // UDS 与族未证：原厂的全车系统一发现帧
}

let probeAbort = false;

/**
 * 表驱动定向探测短名单（2026-11-04）：ecu-addresses.json 的 cands
 * （SYS_DATA 候选集收敛到 11 位诊断段，锚点 attr 组排序）。
 * 参考诊断仪 的做法就是候选集探测裁剪，不是全网段盲扫。
 */
function addrEntryFor(label, sys = null) {
  try {
    if (!ecuAddrTable) return null;
    let sysId = sysIdForLabel(label);
    if (!sysId) sysId = sysIdForMod(label);
    if (!sysId && sys?.modules?.length) {
      for (const m of sys.modules) {
        const k = sysIdForMod(m);
        if (k) { sysId = k; break; }
      }
    }
    if (!sysId) return null;
    return (ecuAddrTable.entries || []).find(
      (e) => e.sysId && e.sysId.toLowerCase() === sysId.toLowerCase()) || null;
  } catch { return null; }
}

function addrCandsFor(label, sys = null) {
  const hit = addrEntryFor(label, sys);
  return (hit?.cands || [])
    .map((c) => ({ tx: parseInt(c.tx, 16), rx: parseInt(c.rx, 16) }))
    .filter((c) => Number.isFinite(c.tx) && Number.isFinite(c.rx));
}

/**
 * ★ 2026-11-11 原厂对齐：`aliasEntryFor`（同义 sysId 回退）已**整体删除**。
 *   原厂没有 alias 概念 —— 地址由链路层按请求键解析（RE-DISCOVERY §3），离线无候选就交给
 *   运行时枚举（ensureLiveMap）。原函数用 `startsWith/endsWith` 近似 join 把 PASM(0x0e13)
 *   回退到旧代 0x0b13 的候选，属自创跨代推断，已从 probeAddressFor 一并移除。
 */

/**
 * 文档 §5 三级寻址（2026-11-04 收官）：
 *   proven / table-unique（唯一候选）→ 直接进，零探测；
 *   candidate（多候选）→ 定向探测（原厂发现帧 + 回帧 ID 校验）；
 *   歧义/无候选 → 运行时枚举（ensureLiveMap），**不猜地址**；
 *   写入闸门：默认按原厂（无地址态闸门）；`setSafety({addrState:true})` 才启用严格拒写。
 */
function addrTableUnique(label, sys = null) {
  const cs = addrCandsFor(label, sys);
  return cs.length === 1 ? cs[0] : null;
}

/**
 * 变体匹配选行（2026-11-05，对齐 参考诊断仪 行=变体）：addrBlock 行的 cmdptr 是名字池游标，
 * 行尾名字与本模块已知变体名比对 → 命中行的 internal 并入优先集。
 * ⚠️ 保守用法：只做探测短名单**排序**，不删候选（行→名字映射是指针游标索引，
 *    跨模块名可见、语义未实证——见 HANDOFF 2026-11-05(8)）。
 */
function variantMatchedInternals(label, sys, variantNames) {
  const out = new Set();
  if (!variantNames || !variantNames.length) return out;
  const entry = addrEntryFor(label, sys);
  const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const want = variantNames.map(norm).filter(Boolean);
  for (const row of entry?.rows || []) {
    const v = norm(row.variant);
    if (!v || !row.internal) continue;
    // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑦）：只做**全等**（原厂IsMatchName memcmp 语义）。
    //   旧实现 `v.includes(w) || w.includes(v)` 是近似匹配（仅用于排序，但会让错的 internal
    //   排到前面）；删除。
    if (want.some((w) => v === w)) out.add(String(row.internal).toUpperCase());
  }
  return out;
}

/**
 * 运行时文本匹配（2026-11-05 终审④⑤，0 自创）：识别串 ↔ 名字注册表，
 * 与 参考诊断仪 GetSubSysDataAddr 的 strcmp/strstr/前缀原语同款（autoPickVariant ①②③ 同源）。
 * ⚠️ 无默认兜底：默认变体不算命中（命中=how 含「命中」）。
 */
function identTextMatch(text, label, variantNames, modRecs, moduleKeys) {
  if (!String(text || '').trim()) return false;
  // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑤）：改用 原厂原语组合
  //   （probe.identMatch：strcmp 全等 / 前缀 memcmp≥4 / strstr≥4；短键只全等），
  //   删除自创的双向 `includes` 无长度下限匹配（`IC`/`PDC` 等短键会误命中任意应答）。
  const keys = [label, ...(moduleKeys || []), ...(variantNames || [])].filter(Boolean);
  if (identMatch(text, keys)) return true;
  // 变体名命中（原厂用变体名做 IsMatchName memcmp 全等；autoPickVariant 的 how 已含命中判定）
  for (const mi of modRecs || []) {
    const r = autoPickVariant(mi, text);
    if (r && String(r.how || '').includes('命中')) return true;
  }
  return false;
}

/**
 * 探测模块地址（2026-11-09 RE-ICADDR：判定转写 参考诊断仪，RE-FLOWSPEC §1.6/2.3）。
 *
 * 候选序 = **表行序**（cands 行序 + 变体选行收窄）→ candsAux → **DRIVELINKS 14B 记录族**
 *   （通用兜底族：entry.family；joinState=unresolved 模块扫全库族并集 —— 真车自证）。
 * 绑定判据（2026-11-10 对齐）：**帧来自该候选的 rx 且有 body**（正响应或 NRC 都算）即绑定；
 *   身份不在这一步裁决，交给进入模块后的首个参数读帧（DID/LID）。
 *   回帧 ID 不符 = 不是它回的，按无应答处理（旧 0x7F1 事故的真实起因）。
 *   无应答 = 候选死，换下一候选。全失败 → null（调用方按「通讯失败」报错）。
 * 返回 { tx, rx, cmd, ident, confidence:'probed' } 或 null。
 */
async function probeAddressFor(label, probeCmd, opts = {}) {
  if (!coder) return null;
  // ⚠️ 必须在这里复位：上一次「取消」会把 probeAbort 留成 true，
  //    而下面的枚举（sweepPlan 循环）在旧代码里跑在复位之前 → 一进循环就 break，
  //    活地址表永远是空的（还得重启 App 才能救）。
  probeAbort = false;

  // ★ 2026-11-10 重写（RE-DISCOVERY）：候选 = 本模块自己的诊断段地址，**不再用全库族并集**。
  //   历史：joinState 未决时并入全库 43 个族地址 → IC 拿车门/PDC 的地址扫 32 个，必然全灭。
  //   现在：优先 bind-plan（由 drivelinks-v3 的「行→记录→候选数」生成），没有再退回表 A 行。
  await ensureBindPlan();
  const prefer = variantMatchedInternals(label, null, opts && opts.variantNames);
  let entry = addrEntryFor(label, opts && opts.sys);
  // ★ 2026-11-11 全链路审计 P0 修复：bind-plan 键按当前车型平台 sysId 直查，
  //   不再依赖 ecu-addresses.json 的条目（新代 0x10/0x12/0x14-0x16 sysId 不在旧表，
  //   旧写法 entry=null → plan=null → 191 个新代静态候选不可达且错误 alias 回退旧代）。
  const planSysId = planSysIdFor(label, opts.modules, currentModel, entry?.sysId);
  let plan = bindPlanFor(planSysId) || bindPlanFor(entry?.sysId);
  let all = [];
  const fromPairs = (p) => p.pairs.map((c) => ({
    tx: parseInt(c.tx, 16), rx: parseInt(c.rx, 16), proto: null, src: 'plan',
  })).filter((c) => Number.isInteger(c.tx) && Number.isInteger(c.rx)
    && ((c.tx <= 0x7ff && c.rx <= 0x7ff) || (c.tx > 0x7ff && c.rx <= 0x1fffffff)));
  const validDirect = (p) => !!(p && p.bindDirect && !p.nMixed
    && Array.isArray(p.pairs) && p.pairs.length === 1);
  if (plan && Array.isArray(plan.pairs) && plan.pairs.length) {
    // pairs 保留表里的原始 rx（存在 rx≠tx+8：0x7FC→0x804、网关 0x710→0x77A）
    all = fromPairs(plan);
  } else if (plan && Array.isArray(plan.cands) && plan.cands.length) {
    all = plan.cands.map((t) => parseInt(t, 16))
      .filter((tx) => Number.isInteger(tx) && tx + 8 <= 0x7ff)
      .map((tx) => ({ tx, rx: tx + 8, proto: null, src: 'plan' }));
  } else {
    all = probeList(entry, [], prefer);
  }
  // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑥）：删除「同义系统名 alias 回退」。
  //   原厂没有 alias 概念 —— 地址由链路层按请求键解析（RE-DISCOVERY §3），
  //   离线没有候选就是没有，运行时走枚举（sweepAndMap）。旧 alias 用
  //   `startsWith/endsWith` 近似 join 把 PASM(0x0e13) 回退到旧代 0x0b13 的候选，
  //   属自创跨代推断；已删除（PASM 仍可由枚举兜底覆盖）。
  const bindDirect = validDirect(plan) && all.length === 1;
  // ★ 无候选 → 枚举一次（每 VIN 缓存 24h），按识别码找到本模块的地址
  if (!all.length) {
    const menu = (modelsCatalog?.models?.[currentModel]?.modules || []).map((m) => m.module);
    const lm = await ensureLiveMap(state.vin || '', menu).catch(() => null);
    const hits = (opts.modules || []).map((m) => ({ module: m, hit: lm?.map?.[m] })).filter((x) => x.hit);
    const hit = hits.length === 1 ? hits[0].hit : null;
    if (hit) {
      all = [{ tx: hit.tx, rx: hit.rx, proto: null, src: 'live' }];
      log(`  ${label} 无静态候选 → 用枚举结果 0x${hx(hit.tx)}/0x${hx(hit.rx)}`
        + (hit.ident ? `（识别串「${hit.ident.slice(0, 16)}」）` : ''), 'ok');
    } else if (hits.length > 1) {
      log(`  ${label} 枚举命中多个候选模块（${hits.map((x) => x.module).join('/')}），身份不唯一，不取首`, 'warn');
      return null;
    } else {
      log(`  ${label} 无静态候选，枚举表里也没有识别到该模块（需人工映射）`, 'warn');
      return null;
    }
  }

  const hex = (n) => n.toString(16).toUpperCase();

  const tryAddr = async (p) => {
    const note = (s) => log(`  · 探 0x${hex(p.tx)}/0x${hex(p.rx)}: ${s}`, 'info');
    try {
      // ⚠️ 2026-11-10 审计 R4：绑定必须回执确认。回 `?`/空行时说明请求还打在上一个地址上，
      //    继续发帧只会得到「别人的 NRC」—— 真车 0x7F1 回帧头 7E8 就是这个症状。
      try {
        await atCmdOk(coder.elm, `ATSH${hex(p.tx)}`, 1200);
        await atCmdOk(coder.elm, `ATCRA${hex(p.rx)}`, 1200);
      } catch (e) {
        note(`绑定失败，跳过：${e.message}`);
        return null;
      }
      // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.1 偏离①）：n=0（bindDirect）**不发任何探针帧**。
      //   原厂`DriveLinksMode_1001 @LINK:0x18f00` 的 `cbz r1,#0x18f9e` 分支：候选数 0 →
      //   整个探针循环跳过，直接 `send(0x10000359,A,2)` 做**链路层绑定**。
      //   ELM 的等价物 = ATSH/ATCRA 且回执 OK（上面 611-616 已断言）→ 绑定完成，直接返回。
      //   只有 ATSH/ATCRA 回 `?`（适配器拒绝）时才按 原厂的「绑定失败补帧」发一帧 22 11 02。
      const fam = opts.family || familyFor(label, p.tx, { modules: opts.modules });
      if (bindDirect) {
        note(`ATSH/ATCRA OK → n=0 链路绑定（0 探针帧，原厂cbz 分支）`);
        return { tx: p.tx, rx: p.rx, cmd: '', ident: '', confidence: 'bound', family: fam || null };
      }
      // ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.1 偏离②）：n>0 **每候选只发 1 帧**
      //   `0xFF001409`（22 14 09）；KWP 族用实车自证的 1A 9F。失败不再追加 3E/firstRead/
      //   多帧族链（那些是 2026-11-10 的自创恢复，原厂无）。
      //   `probeChainFor` 已收窄为每族单帧（见函数注释）。
      void probeCmd;
      const cmds = probeChainFor(fam);
      for (let ci = 0; ci < cmds.length; ci++) {
        const cmd = cmds[ci];
        let r = '';
        try { r = (await coder.elm.cmd(cmd, 2000) || '').trim(); } catch { note(`${cmd} → 超时/无应答`); continue; }
        // ★ 2026-11-10 审计 R4：先认「这帧是谁回的」，再谈内容。
        //   帧 ID ≠ 候选 rx（例：探 0x7F1 却回 7E8）→ 该帧不属于本候选，按无应答处理。
        //   此前直接拿 body 判定，会把别的 ECU 的 NRC 记成这个候选的「身份不符」。
        const ids = frameIdsOf(r);
        if (ids.length && !ids.includes(p.rx)) {
          note(`${cmd} → 回帧 ID ${ids.map((x) => '0x' + x.toString(16).toUpperCase()).join('/')}`
            + ` ≠ 0x${hex(p.rx)}（应答方不是该候选，丢弃）`);
          continue;
        }
        const pr = parseRespAuto(r, String(cmd).replace(/[^0-9A-Fa-f]/g, ''),
          parseInt(String(cmd).slice(0, 2), 16) & 0xff);
        const body = Array.from(pr.body || [])
          .map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
        // ⚠️ 必须以 **body** 为准，不能看原始文本是否非空：
        //   探测期 ATST 压到 60ms 后，安静 ECU 会快速回 `NO DATA`（不是超时异常），
        //   旧判断 `!body && !r` 会把 `NO DATA` 当成"有应答"→ 每个候选都绑定成功。
        if (!body) { note(`${cmd} → 无应答${r ? `（${r.slice(0, 16)}）` : ''}`); continue; }
        const text = Array.from(pr.body || [])
          .filter((c) => c >= 0x20 && c < 0x7f)
          .map((c) => String.fromCharCode(c)).join('').trim();
        note(`${cmd} → ${ids.length ? '[' + ids.map((x) => hex(x)).join('/') + '] ' : ''}`
          + `${body.slice(0, 24) || r.slice(0, 24) || '(空)'}`);
        // 判定：帧来自该 rx 且有 body（正响应或 NRC 都算）→ 该地址活着，绑定。
        // 身份不在这里裁决 —— 由进入模块后的真实读帧（首参数 DID/LID）裁决。
        return { tx: p.tx, rx: p.rx, cmd, ident: text.slice(0, 32), confidence: 'bound' };
      }
    } catch (e) { note(`异常 ${e.message || e}`); }
    return null;
  };

  probeAbort = false;
  try {
    // 上一个模块可能是 29-bit，先切回 11bit/500k
    await coder.elm.cmd('ATSP6', 1500).catch(() => {});
    // ⚠️ 探测窗口压到 60ms（ATST 单位 4ms）。参考诊断仪对每个候选只发一帧就换下一个，
    //   我们此前用 2s 的 JS 超时 —— 14 个候选的 PASM 光等超时就是 28s，
    //   这正是「进模块 10 分钟」的另一半原因。60ms 覆盖 ISO P2_server(50ms)；
    //   进模块后立刻恢复 ATSTFF，否则多帧读/7F78 会被适配器提前截断。
    await coder.elm.cmd('ATST0F', 800).catch(() => {});
    for (let i = 0; i < all.length; i++) {
      if (probeAbort) return null;
      showLoading(`正在探测 ${label}`, `候选 ${i + 1}/${all.length} · 0x${hex(all[i].tx)}`,
        () => { probeAbort = true; });
      const hit = await tryAddr(all[i]);
      // 判定在 tryAddr 内：帧来自该 rx 且有 body（正响应或 NRC）即绑定；身份交给读帧裁决。
      if (hit) return hit;
    }
    log(`  · 候选 ${all.length} 个全部无应答（来源 ${plan ? 'bind-plan' : '表 A 行'}`
      + `${bindDirect ? ' · n=0 直绑' : ''}），通讯失败`, 'warn');
    return null;
  } finally {
    await coder.elm.cmd('ATSTFF', 800, { noDelay: true }).catch(() => {});
    hideLoading();
    probeAbort = false;
  }
}

function addrFor(label, model = currentModel, sys = null) {
  // ★ 终审③（2026-11-05）：无缓存/无手工覆盖 —— 每次进模块新鲜解析（表 + 运行时绑定）。
  const fromRe = ecuAddrFromTable(label, sys);
  if (fromRe && fromRe.state === 'measured') return fromRe;
  const builtin = ECU_ADDR[label];
  if (builtin && builtin.state === 'measured') return builtin;
  // 参考表明确要求探测的 sysId，必须走 probe。
  if (fromRe && fromRe.state === 'needs-probe') return fromRe;
  return builtin || fromRe || null;
}

/**
 * 写 profile 白名单。只有车型、模块、物理地址、协议族均有完整证据时才返回 verified。
 * 其它模块默认只读；不能用固定 10 89 或一次 NRC 去推断可写。
 */
function writeProfileFor(sys, model, addr, family) {
  const modules = sys?.modules || [];
  const is981CaymanDme = model === 'Cayman（981）'
    && sys?.label === 'ECM/DME(发动机控制模块)'
    && modules.includes('DME_BDE_Continental')
    && addr?.tx === 0x7e0 && addr?.rx === 0x7e8 && family === 'kwp';
  if (is981CaymanDme) {
    return {
      verified: true,
      reason: '981 Cayman DME_BDE_Continental · 0x7E0/0x7E8 · KWP 21/3B · 10 89 正响应实证',
      profile: '981-cayman-dme-kwp-21-3b',
    };
  }
  return {
    verified: false,
    reason: '缺少当前车型/模块/地址的完整会话→序言→安全→写→回读证据，默认只读',
    profile: null,
  };
}

import { registerPlugin } from '@capacitor/core';

// 安全区留白全部走 CSS 的 env(safe-area-inset-*)（见 index.html），不再用 JS 量/猜。
// 旧实现两处都错，2026-10-25 真机 iPhone Duo 内屏横屏截图实测：
//   ① 用 innerHeight/innerWidth > 2.0 判刘海——Duo 封面 466×678(1.46)、内屏 669×951(1.42)
//      比 iPhone 8(1.78) 还矮胖，被判成「无刘海」只留 22px；
//   ② 只让 top，没让左右——Duo 内屏横屏传感器区在角落，水平 inset 是常驻的，
//      header 右侧徽标顶进状态栏。
// env() 随折叠/旋转/换屏自动跟随，不需要 resize 监听，也没有缓存失效问题。
//
// ⚠️ 不要再调 StatusBar.setOverlaysWebView({overlay:false})：
//    它把 webview 从状态栏下方起排，会让 env() 全变 0，页面反而没法量安全区；
//    而且它只改 frame.origin.y，横屏时状态栏高度常为 0，等于没让开。
//    保持默认（overlay=true，webview 满屏）+ env() 让位，是本项目验证过可用的组合。
const StatusBar = registerPlugin('StatusBar');
(async () => {
  try {
    await StatusBar.setStyle({ style: 'DARK' });
    await StatusBar.setBackgroundColor({ color: '#0e1116' });
  } catch (e) {
    console.warn('StatusBar 配置失败', e);
  }
})();

function $(id) {
  var el = document.getElementById(id);
  if (el !== null && el !== undefined) return el;
  var cache = globalThis.__nsCache = globalThis.__nsCache || {};
  if (!cache[id]) {
    var d = {};
    d.style = {};
    d.classList = { add: function(){}, remove: function(){}, toggle: function(){}, contains: function(){ return false; } };
    d.querySelectorAll = function() { return []; };
    d.querySelector = function() { return d; };
    d.addEventListener = function() {};
    d.appendChild = function() {};
    d.insertAdjacentHTML = function() {};
    d.scrollIntoView = function() {};
    cache[id] = d;
  }
  return cache[id];
}
const logEl = $('log');
const log = (m, cls = 'info') => {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
};

/**
 * 浮层反馈 —— 每个操作都要让用户看到结果（成功/失败/为什么）。
 * @param {'ok'|'err'|'warn'|'info'} kind
 * @param {string} title  一句话结论
 * @param {string} [detail]  原因 / 下一步
 */
function toast(kind, title, detail = '') {
  const w = $('toastWrap');
  const d = document.createElement('div');
  d.className = 'toast ' + (kind === 'info' ? '' : kind);
  d.innerHTML = `<div class="t"></div>${detail ? '<div class="d"></div>' : ''}`;
  d.querySelector('.t').textContent = title;
  if (detail) d.querySelector('.d').textContent = detail;
  w.appendChild(d);
  // 自动消失（错误多留一会）
  const ms = kind === 'err' ? 5200 : kind === 'warn' ? 4000 : 2600;
  setTimeout(() => {
    d.classList.add('out');
    setTimeout(() => d.remove(), 240);
  }, ms);
  // 同时记日志（保留可复制的完整轨迹）
  log((kind === 'ok' ? '✅ ' : kind === 'err' ? '❌ ' : kind === 'warn' ? '⚠️ ' : '') + title +
      (detail ? ` —— ${detail}` : ''), kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'info');
}

/** 未连接时的统一拦截提示 */
function needLink() {
  if (coder) return true;
  toast('err', '未连接适配器', '请先选接头类型并点「连接自检」，接上 OBD 接头后再操作');
  return false;
}

// ---------- 全屏加载遮罩（读取期间锁定操作） ----------
let _loadingCancel = null;
function showLoading(title, detail = '', onCancel = null) {
  // 必须用真实 DOM 判断：$() 的 headless fallback 是普通对象，没有 querySelector。
  let el = document.getElementById('loadingMask');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingMask';
    el.innerHTML = `
      <div class="lmBox">
        <div class="lmSpinner"></div>
        <div class="lmTitle"></div>
        <div class="lmDetail"></div>
        <button type="button" class="lmCancel">取消</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.lmCancel').addEventListener('click', () => {
      if (_loadingCancel) _loadingCancel();
    });
  }
  _loadingCancel = onCancel;
  const btn = el.querySelector('.lmCancel');
  if (btn) {
    btn.style.display = onCancel ? 'inline-block' : 'none';
    btn.style.cssText = 'margin-top:12px;padding:8px 20px;border-radius:10px;'
      + 'border:1px solid #2a3140;background:#21262d;color:#e6edf3;font-size:14px';
  }
  el.querySelector('.lmTitle').textContent = title;
  el.querySelector('.lmDetail').textContent = detail;
  el.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function hideLoading() {
  _loadingCancel = null;
  const el = document.getElementById('loadingMask');
  if (el) el.style.display = 'none';
  document.body.style.overflow = '';
}

/**
 * 更新已有 loading 的文案（不重建 DOM），可同时挂取消回调。
 * ⚠️ 2026-10-29：这个函数在 5637dad 之后就被调用、却从未定义 ——
 *    enterSystem 一进模块就 ReferenceError（被 catch 吞掉后返回 false），
 *    runSequence 执行到第一个命令也断。必须存在。
 */
function updateLoading(title, detail = '', onCancel = null) {
  const el = document.getElementById('loadingMask');
  if (!el) { showLoading(title, detail, onCancel); return; }
  _loadingCancel = onCancel;
  const btn = el.querySelector('.lmCancel');
  if (btn) btn.style.display = onCancel ? 'inline-block' : 'none';
  el.querySelector('.lmTitle').textContent = title;
  el.querySelector('.lmDetail').textContent = detail;
  el.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

// ---------- 状态 ----------
// ⚠️ 2026-10-29：这一整块声明在重写 loading 时被误删。ESM 是严格模式，
//    给未声明变量赋值会直接抛 `Can't find variable: xxx` —— 表现就是
//    启动即「载入失败: Can't find variable: tree」。新增模块级状态一律加在这里。
let doctor = null, elm = null, coder = null;
let tree = null;          // menu-tree-v3.json
let coding = [];          // coding-v2.json params
let stack = [];           // 导航栈 [{level, title, data}]
let _navLockTs = 0;       // 程序化导航后短窗口内吞掉 ghost-click（2026-11-04）
let _lastPointerTs = 0;   // ★ 2026-11-07：真点击带 pointerdown；iOS confirm 穿透的合成 click 没有
try {
  window.addEventListener('pointerdown', () => { _lastPointerTs = Date.now(); }, true);
  window.addEventListener('mousedown', () => { _lastPointerTs = Date.now(); }, true);
  window.addEventListener('touchstart', () => { _lastPointerTs = Date.now(); }, true);
} catch {}
let currentParam = null;
let simMode = false;
let simMock = null;   // 模拟适配器（进模块时喂识别串用，2026-11-04）
let modelsCatalog = null;
let currentModel = null;
const loadedVariants = new Map();   // 缓存已加载的变体
// 运行期状态（此前也随声明块一起被删，`state.xxx` 会直接 ReferenceError）
const state = {
  multiVariantModules: new Set(),
  selectedVariant: {},        // { [module]: 变体名 }
  vin: '',                    // 实测 VIN（地址缓存按车键控用，2026-11-04）
  currentAddr: null,          // 当前进入模块的地址证据
};

// ---------- ① 连接 ----------
$('btnDoctor').onclick = async () => {;
  $('btnDoctor').disabled = true;
  // ⚠️ 自检期间屏蔽其它操作（2026-10-22）：此前用户在自检中点「自动搜索」，
  //    coder 还没建（doctor.run() 才返回），误报「未连接适配器」——
  //    日志里「自动搜索」夹在 L3✅ 和 L4❌ 中间就是这个时序。
  $('btnDisc').disabled = true;
  $('btnScan').disabled = true;
  toast('info', '开始连接自检', '配件发现 → 会话 → 协议锁定 → 模块探测');
  try {
    // ⚠️ 重连前必须先关掉上一个 EA 会话 —— 否则 EASession 创建失败（僵尸会话）。
    //    实车日志：第一次能开、第二次必失败。此前每次点都 new LinkDoctor() 而不 close。
    if (doctor) {
      try { await doctor.close(); } catch (e) { /* 忽略 */ }
      doctor = null;
    }
    if (elm && typeof elm.close === 'function') {
      try { await elm.close(); } catch (e) { /* 忽略 */ }
      elm = null;
    }
    coder = null;
    simMode = false;
    await new Promise((r) => setTimeout(r, 400));   // 给 EA 栈一点释放时间
    doctor = new LinkDoctor();
    doctor.onStep = (s) => {
      log(`${s.ok ? '✅' : '❌'} ${s.title}: ${s.detail || ''}`, s.ok ? 'ok' : 'err');
      if (!s.ok) toast('err', `${s.title} 失败`, s.detail || s.fix || '');
    };
    const r = await doctor.run();
    // ⚠️ 从模拟模式切到真车时必须清 simMode（2026-10-18 审计）：
    //    否则 enterSystem 仍走「模拟地址 0x7E0」，所有模块都被当成 DME。
    simMode = false;
    elm = doctor.elm;
    if (elm) {
      coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: 'DME' });
      coder.identityBootstrap = doctor.identityBootstrap || null;
      coder.onProgress = (m) => log(m, 'info');
      // ★ 2026-11-05：seed/key 在**进模块时**按模块解析（mode 表→名字分发，参考诊断仪 同款），
      //   连接阶段只放 DME 预置，解析不到不做拒写宣称（此前那句「写入会被拒绝」是误报）。
      const _vk = pickVariant('DME');
      coder.seedKeyProvider = _vk ? makeProvider(_vk) : null;
      if (_vk) log(`seed/key 变体：${_vk.variant}/${_vk.algo}（seed ${_vk.seedBytes}B）`, 'info');
      else log('seed/key 将在进模块时按模块解析（mode 表→名字分发）', 'info');
    }
    $('linkBadge').textContent = r.fail === 0 ? '已连接' : `${r.fail} 层失败`;
    $('linkBadge').className = 'badge ' + (r.fail === 0 ? 'ok' : 'warn');
    $('btnDisc').disabled = false;
    $('btnScan').disabled = false;
    if (r.fail === 0) {
      toast('ok', '连接就绪', '可以选模块读写了');
    } else {
      toast('warn', `连接完成，但 ${r.fail} 层失败`,
        '看下方日志逐层排查；协议锁定失败就无法读写');
    }
  } catch (e) {
    toast('err', '自检异常', e.message);
  }
  $('btnDoctor').disabled = false;
  if (coder) { $('btnDisc').disabled = false; $('btnScan').disabled = false; }
};

// ★ 系统扫描（2026-11-05 终审：「地址扫描」→ 参考诊断仪「系统扫描」法，TEXT_CN UI 文本库实证：
//   「扫描中... / 扫描已完成：/ 扫描系统：/ 未扫描到系统请确保点火开关在打开状态」——
//   按当前车型的系统清单逐个走「表候选+探测+文本匹配」解析，**不做地址盲扫（网段逐地址试）**；
//   结果只报不缓存（终审③：每次进模块新鲜解析）。
$('btnScan').onclick = async () => {
  if (!needLink()) return;
  const cat = modelsCatalog?.models?.[currentModel];
  const sysList = (cat?.modules || []).map((m) => m.module).filter(Boolean);
  if (!sysList.length) {
    toast('warn', '请先选择车型', '系统扫描按当前车型的系统清单逐个解析');
    return;
  }
  toast('info', '扫描中...', `扫描系统：0/${sysList.length}`);
  $('btnScan').disabled = true;
  const found = [];
  try {
    for (let i = 0; i < sysList.length; i++) {
      const label = sysList[i];
      toast('info', '扫描中...', `扫描系统：${i + 1}/${sysList.length} · ${label}`);
      const hit = await probeAddressFor(label, null, { modules: [label] });
      if (hit) {
        found.push({ label, tx: hit.tx, rx: hit.rx, ident: hit.ident });
        log(`  ✅ ${label} -> 0x${hit.tx.toString(16).toUpperCase()}/0x${hit.rx.toString(16).toUpperCase()}`
          + (hit.ident ? ` (识别串「${hit.ident}」)` : ''), 'ok');
      }
      if (probeAbort) break;
    }
    if (coder) coder._addressReady = false;
    if (found.length) {
      const s = found.map((f) => `${f.label} 0x${f.tx.toString(16).toUpperCase()}`).join(' ');
      toast('ok', `扫描已完成：发现 ${found.length} 个系统`, s);
    } else {
      toast('err', '未扫描到系统', '请确保点火开关在打开状态');
    }
  } catch (e) {
    toast('err', '扫描失败', e.message);
  }
  $('btnScan').disabled = false;
};

// 模拟模式：没接头也能完整体验（读写走模拟车，不碰真车）
$('btnSim').onclick = async () => {;
  if (coder && simMode) {
    // 已在模拟 → 退出
    doctor = elm = coder = null; simMode = false; simMock = null;
    $('linkBadge').textContent = '未连接';
    $('linkBadge').className = 'badge';
    $('btnDisc').disabled = true; $('btnScan').disabled = true;
    $('btnSim').textContent = '模拟模式';
    $('btnSim').classList.remove('primary');
    toast('info', '已退出模拟模式', '接上 vLinker 后点「连接自检」用真车');
    return;
  }
  // ⚠️ 真车 → 模拟 前必须释放真实 EA 会话（2026-10-18 审计）：
  //    此前直接覆盖 elm/coder，真实串口一直挂着，下一次连接会创建失败（僵尸会话）。
  if (doctor) { try { await doctor.close(); } catch {} doctor = null; }
  if (elm && typeof elm.close === 'function') { try { await elm.close(); } catch {} }
  elm = null; coder = null;
  // ★ 2026-11-07 wire 级仿真拓扑（治本：测试必须走真探测路径，不再占位直进）：
  //   DME@0x7E0 回识别文本；IC@0x7C0 **不回 1A9F**（真车 KWP 静默模块）但回 22 14 09/22 11 02；
  //   邻居 BCM 各回各的文本（防误认）；未列地址=NO DATA。
  const SIM_ECUS = {
    0x7E0: { name: 'DME', dsn: 'ECM_DME_BDE_Continental_BaseSys', ident22: 'ECM_DME_BDE_Continental_BaseSys' },
    0x7C0: { name: 'IC', noIdent1A: true, ident22: 'Kombi_IC_9x1', ident22b: 'Kombi_IC_9x1' },
    0x7D1: { name: 'BCM_vorne', dsn: 'BCM_vorne_9x1_Basis', ident22: 'BCM_vorne_9x1_Basis' },
    0x74F: { name: 'BCM_hinten', dsn: 'BCM_hinten_9x1', ident22: 'BCM_hinten_9x1' },
  };
  // ★ 2026-11-08（任务清单3 ui-sim 遍历）：strictAddress 关闭 —— 模拟车对任意探测地址应答
  //   （SIM_ECUS 4 拓扑只覆盖 DME/IC/BCM，其余模块进不去，「任意车型→任意模块」遍历无法成立）。
  //   4 ECU 箩笆仍生效（noIdent1A/ident22 等按地址特例），识别串按 identTextTx 定点喂。
  const mock = new MockAdapter({ latencyMs: 30, strictAddress: false, ecus: SIM_ECUS });
  simMock = mock;
  elm = new Elm327(mock, { timeoutMs: 2000 });   // ← MockAdapter 是 PortLike，包进 Elm327
  simMode = true;
  coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: '模拟ECU' });
  coder.onProgress = (m) => log(m, 'info');
  // 模拟模式固定用已确认变体（保证离线回归可跑）；真车按 ECU 家族选
  coder.seedKeyProvider = makeProvider({ variant: '9x7GW', algo: 'A' });
  $('linkBadge').textContent = '模拟中';
  $('linkBadge').className = 'badge warn';
  $('btnDisc').disabled = false; $('btnScan').disabled = true;
  $('btnSim').textContent = '退出模拟';
  $('btnSim').classList.add('primary');
  toast('ok', '模拟模式已开启', '所有车型/功能都能点，读写走模拟车 —— 不碰真车');
  // ★ 2026-11-06 用户实测：点模拟模式**不应自动读 VIN** —— 只进模拟态，
  //   读 VIN/选车型由用户点「自动搜索」或「手动选择」驱动（与真车操作一致）。
};

// 返回上一级（二级菜单也能退出来）
try { const _bb = $('btnBack'); if (_bb) _bb.onclick = () => goBack(); } catch {}

$('btnDisc').onclick = async () => {;
  if (doctor) { try { await doctor.close(); } catch {} }
  if (elm && typeof elm.close === 'function') { try { await elm.close(); } catch {} }
  doctor = elm = coder = null;
  simMode = false;
  $('linkBadge').textContent = '未连接';
  $('linkBadge').className = 'badge';
  $('btnDisc').disabled = true;
  $('btnSim').textContent = '模拟模式';
  $('btnSim').classList.remove('primary');
  log('已断开', 'info');
};

/**
 * VIN 校验 —— ISO 3779 / NHTSA：17 位，字母数字，**排除 I、O、Q**。
 * 不校验就读会把二进制垃圾当 VIN，进而猜错车型、按错车型读编码。
 */
function isValidVin(v) {
  return typeof v === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
}

/**
 * VIN 第 10 位（下标 9）= 年款码。**原厂三档基数**（PorscheGetYearByModel @SYSP:0x261a8
 * 指令 0x261c8-0x261e4，RE-MODELADDR §1.2 逐指令表）：
 *   modelId ≤ 10 且 char∈'E'..'Y' → idx + 1971（'A'→1980 老车系）
 *   modelId ≤ 10 其余（'1'..'9'）  → idx + 2001
 *   modelId > 10 且 char∈'A'..'Y'  → idx + 2001（新平台）
 *   modelId > 10 其余（'1'..'9'）  → idx + 2031（下轮 2031+）
 * idx = 字符在 30 字符表中的位置（'1'..'9'=0..8、A..Y 跳过 I/O/Q/U/Z=9..29）。
 * ⚠️ 2026-11-11 原厂对齐（CODE-AUDIT §3.1 偏离）：旧实现只有 `i<9?2001+i:2010+(i-9)` 一档，
 *    1980–2000 与 2031+ 年款全错；且 modelId 未知时不能猜 → 返回 null。
 */
function decodeVinYear(vin, modelId = null) {
  const c = (vin[9] || '').toUpperCase();
  if (!c) return null;
  const alpha = '123456789ABCDEFGHJKLMNPRSTVWXY';
  const i = alpha.indexOf(c);
  if (i < 0) return null;
  const id = (modelId == null || !Number.isFinite(Number(modelId))) ? null : Number(modelId);
  if (id == null) return null;              // 原厂：年款表按 modelId 分档，无 modelId 不落到任何一档
  const isLetter = c >= 'A' && c <= 'Z';
  if (id <= 10) return (isLetter && c >= 'E') ? i + 1971 : i + 2001;
  return isLetter ? i + 2001 : i + 2031;
}

// ---------- 自动搜索（读 VIN / 车名 判车型年款）----------
async function autoSearch(opts = {}) {
  log('—— 自动搜索：读 VIN / 车名 ——', 'info');
  if (!coder) {
    toast('err', '未连接适配器', '请先点「连接自检」，接上 vLinker 后再自动搜索');
    return;
  }
  try {
    // 自动搜索 = 主/备车名请求（0xff001102/0xff001101）+ VIN 路径。
    // 原厂主备对先于 PorscheReadVehicleVin；模板不是八帧顺跑。
    // fresh 未知族只能由适配层有界探测确定，不能把 null 默认当 KWP；
    // 地址使用自检保存的身份证据，不能沿用进过的任意模块地址。
    // 身份读取地址必须来自自检证据；进过其它模块后不能沿用其地址。
    const bootstrap = coder.identityBootstrap;
    if (bootstrap && Number.isInteger(bootstrap.tx) && Number.isInteger(bootstrap.rx)) {
      await coder.setAddress(bootstrap.tx, bootstrap.rx, 'DME', { family: bootstrap.family || null });
    } else {
      if (coder.hasModuleAddress && !simMode) {
        toast('warn', '请先重新连接自检', '当前没有保存的身份读取地址，不能沿用其它 ECU 的地址读 VIN');
        return;
      }
      // fresh 默认候选仅是适配层起点，不是“原厂固定 DME”规则。
      await coder.address();
    }
    let family = bootstrap?.family || null;
    let preflight = null;
    if (!family) {
      preflight = await coder.detectIdentityFamily();
      for (const s of preflight.steps) log(`  ${s}`, 'info');
      if (!preflight.family) {
        toast('warn', '无法确定诊断协议族', '1A90 与 1003→22F190 均未得到匹配正响应；请手动选择车型');
        return;
      }
      family = preflight.family;
    }
    coder.family = family;
    const idn = await coder.readVehicleIdentity(family, preflight);
    for (const s of idn.steps) log('  ' + s, 'info');
    let vin = idn.vin || '';
    // 主链读不到 VIN 时，补一条 OBD 广播读（21 09 05 → 09 02）。
    // 这是**适配层扩展**：原厂由 VCI 盒按「一对多」发 21 09 05，目的 CAN ID 不在包内；
    // 我方只能用标准 OBD 功能地址 0x7DF，并只认 61 09 05/49 02 + 17 位 VIN 的严格正响应。
    if (!vin) {
      const obd = await coder.readVinByObd().catch((e) => ({ vin: '', tried: [], err: e.message }));
      if (obd?.vin) {
        vin = obd.vin;
        log(`  OBD 通道读到 VIN（${obd.src}）：${vin}`, 'ok');
      } else {
        log(`  OBD 通道未取到 VIN（尝试 ${(obd?.tried || []).join(' / ') || '—'}`
          + `${obd?.err ? '；' + obd.err : ''}）`, 'info');
      }
    }
    const nameFromCar = idn.name || '';
    if (nameFromCar) state.modelDesignation = nameFromCar.slice(0, 32);

    // ★ 2026-11-11 原厂对齐（CODE-AUDIT §2.1 偏离③）：删除自创的 ISO 3779 正则校验
    //   （`/^WP[01][A-HJ-NPR-Z0-9]{8,14}$/`）。原厂（PorscheReadVehicleVin）对留存键
    //   按固定长度取值后直接使用，不做形态猜测。这里只用长度区分「完整 VIN / 前缀」，
    //   不足 11 位视为读不到（11 是 KWP 1A 90 前缀的最小可辨识长度）。
    let vinPrefix = false;
    if (!vin) {
      toast('warn', '读不到 VIN', '可能地址不对或 ECU 未响应 —— 请用手动选择车型');
      return;
    }
    if (vin.length < 11) {
      log(`  VIN 过短（${vin.length} 位）：${JSON.stringify(vin)}`, 'err');
      toast('warn', '读不到 VIN', `读到 ${JSON.stringify(vin)}，不足 11 位。请手动选择车型。`);
      return;
    }
    vinPrefix = vin.length < 17;
    if (vinPrefix) log(`  VIN 前缀 ${vin}（${vin.length} 位）—— 按前缀识别车型，不伪造完整 VIN`, 'warn');
    toast('info', `${vinPrefix ? 'VIN 前缀' : 'VIN'} = ${vin}`,
      vinPrefix ? 'KWP 1A 常只给 11 位前缀，正在按前缀匹配车型 …' : '正在匹配车型年款 …');

    // ★ 2026-11-11 原厂对齐：年款表基数依赖 modelId（PorscheGetYearByModel 三档），
    //   所以先分派 modelId，再算年款；年款只用于显示（原厂不用年款做 trim 裁决）。
    const yearCode = vin[9];
    state.vin = vin;   // 地址缓存按 VIN 键控（同型号不同车不串台）
    const modelGuess = guessModelFromVin(vin);
    const year = decodeVinYear(vin, modelGuess?.modelId ?? null);
    log(`  ${vinPrefix ? 'VIN 前缀' : 'VIN'}=${vin} · 年款码=${yearCode} → ${year ?? '?'} 年款 · 车型判断：`
      + `${modelGuess ? `${modelGuess.models.join(' / ')}（${modelGuess.how}）` : '未识别'}`
      + (nameFromCar ? ` · 应答名「${nameFromCar}」` : ' · 应答名（无）'),
      modelGuess ? 'ok' : 'info');
    if (modelGuess && modelGuess.models.length) {
      // ★ 显示（任务清单①）：= 应答文本（如「14款 Cayman」），车型条目由应答文本 strcmp 落定。
      const yy = year != null ? String(year % 100).padStart(2, '0') : '??';
      const desig = designationFrom(year, nameFromCar);
      const pick = (label, note) => {
        pushModel({ label });
        toast('ok', `已选 ${desig || label}`, note || desig || `${year ?? '?'} 年款`);
      };
      if (opts.autoAccept) {
        // 程序化调用（如测试）免确认；**模拟模式同样弹确认**（2026-11-05 用户实测）。
        const byName0 = pickModelByName(modelGuess.models, nameFromCar);
        pick(byName0 ? byName0.name : modelGuess.models[0]);
        return;
      }
      // ★ ① trim 落定：应答文本命中车型名（24 键 strcmp 可观测等价）→ 单选
      //   （981 实证：22 11 02 应答「Cayman」→ Cayman（981））。
      const byName = pickModelByName(modelGuess.models, nameFromCar);
      if (byName) {
        log(`  🚗 trim 落定：应答文本「${nameFromCar}」→ ${byName.name}（${byName.how}）`, 'ok');
        const ok = confirm(`识别为：${desig || byName.name}（${byName.name}）\n`
          + `${vinPrefix ? 'VIN 前缀' : 'VIN'}：${vin}\n年款码：${yearCode}（${year ?? '未知'} 年款）\n\n确认这个车型？`);
        if (ok) { pick(byName.name); return; }
        return;
      }
      // ★ ② 链穷尽（无应答名）才允许双候选合并，且显示必须注明（任务清单①）。
      if (!nameFromCar && modelGuess.models.length > 1 && typeof modelsCatalog !== 'undefined') {
        const chainNote = '（双候选合并·链穷尽未获应答名）';
        const sigOf = (lbl) => {
          const m = modelsCatalog?.models?.[lbl];
          return JSON.stringify((m?.modules || []).map((x) => x.module + ':' + (x.count ?? '')));
        };
        const sigs = modelGuess.models.map(sigOf);
        if (sigs[0] && sigs.every((x) => x === sigs[0])) {
          const joined = modelGuess.models.join(' / ');
          log(`  候选车型数据集相同（${joined}）——合并单确认${chainNote}`, 'info');
          const ok2 = confirm(`识别为：${joined}（数据集相同）${chainNote}\n`
            + `${vinPrefix ? 'VIN 前缀' : 'VIN'}：${vin}\n年款码：${yearCode}（${year ?? '未知'} 年款）\n\n确认？`);
          if (ok2) { pick(modelGuess.models[0], chainNote); return; }
          return;
        }
      }
      // ③ 有应答名但未命中 / 单候选：列出让用户定，不猜（应答名在标题里可见）
      const nameNote = nameFromCar ? `（应答名「${nameFromCar}」未命中候选）` : '';
      if (modelGuess.models.length === 1) {
        const ok = confirm(`识别为：${desig || modelGuess.models[0]}${nameNote}\n`
          + `${vinPrefix ? 'VIN 前缀' : 'VIN'}：${vin}\n年款码：${yearCode}（${year ?? '未知'} 年款）\n\n确认这个车型？`);
        if (ok) { pick(modelGuess.models[0], nameNote || undefined); return; }
      } else {
        const list = modelGuess.models.map((m, i) => `${i + 1}. ${m}`).join('\n');
        const raw = prompt(`识别为（${year ?? '?'} 年款）${nameNote}：\n${list}\n\n输入序号选择车型，留空取消：`);
        const idx = parseInt(raw, 10) - 1;
        if (raw && idx >= 0 && idx < modelGuess.models.length) { pick(modelGuess.models[idx], nameNote || undefined); return; }
      }
    }
    toast('info', `${year ? year + ' 年款已识别，' : ''}车型请手动选择`,
      '平台未在实证映射内（参考诊断仪 分派 id 无对应证据，不猜）');
  } catch (e) {
    toast('err', '自动搜索失败', e.message);
  }
}

/**
 * 由 VIN 推车型 —— 1:1 复刻 参考诊断仪 `PorscheGetYearAndModel` 分派
 * （参考诊断仪 库内函数，2026-11-05 指令分析逐字节转写：VIN 第 8 字节 TBB 17 槽 + 第 12/7 字节二次判定）
 * 与 `Get9x1_Cs1ForVin`（VIN 前缀库二分 + 第 8 字节判 9x1/CS1）。
 *
 * 指令分析逐字节转写（TBB 表 @0x22b08），**无自创规则**：
 *   c7=VIN[7]（第 8 位）；不在 '1'..'A' 时：'Y'→17、'P'→3、其余→0；
 *   '1'：c11='A'→21 | '8'→16 | 其余→0        '2'→11
 *   '3','4','6',':',';','<','=','>','?','@'→0  '5'→15
 *   '7'：c11='1'→18 | '0'→12 | 其余→0
 *   '8'：c11='1'→Get9x1CslForVin→13 | '2'→13 | '6'→2 | '7'→6 | 其余→0
 *   '9'：c11='1'→Get9x1CslForVin→14 | '6'→1 | '7'→5 | 其余→0（'2'/尾支路 id 名字未闭合 → 不猜）
 *   'A'：c6='X'→15 | 'Y'→22 | 其余→0
 *   Get9x1CslForVin：VIN[7]='8'→13、'9'→14（表[13]=0x3fb/[14]=0xff00000e 互证）。
 *
 * id→平台映射只采用**函数级实证**的 13→9X1、14→CS1（Get9x1_Cs1ForVin 命名+返回值+
 * 真机 981 实证+part-map 三方一致）；其余 id 的文本名在运行时文本库（键空间未打通）
 * → 一律 null 走年款+手选。平台→车型列表派生自 data/models/<slug>/*.json 的 platform 字段。
 *
 * ⚠️ 2026-11-11 注释收口（原「文档写 A、代码做 B」）：`VEH_TABLE`/`ID_MODELS` 是
 *   **内联静态表**（与原厂 `.so` 内静态表同构）。`data/vin-vehicle-map.json` 只是同一份
 *   数据的离线参考/审计产物，运行时**不 fetch**（旧注释写「数据源=该 JSON」与实现不符）。
 *   两份若不一致，以本函数内联表为准，并同步更新 JSON。
 */
function guessModelFromVin(vin) {
  // ===== 参考诊断仪 `PorscheGetYearAndModel` 分派 + `Get9x1_Cs1ForVin` 1:1 转写 =====
  // 指令分析逐字节（TBB 表 17 槽 + 第 12/7 字节二次判定），无自创规则。
  // 分派语义已全解（10+ 锚点互证）：输入为解析车辆-id 结构，offset 6/7/0xb=车型码三字符：
  //   986→('8','6') 987→('8','7') 981/982→('8','1'/'2') 996→('9','6') 997→('9','7')
  //   991→('9','1') 992→('9','2') 970→('7','0') 971→('7','1') 92A→('2') 95B→('5') …
  // 返回 id = DSN.BIN 头部 22 条名表记录号（id 13/14="9x1"、15="cajun"、16="918s"…
  // 与车型码语义逐条咬合）；id→车型列表 = DSN 名 → JOB.XML 零件号族 → catalog 车型
  // （如 G1=970 件→Panamera-970、E2=958 件→Cayenne-92A、9x1=981/982/991 件）。
  const V = String(vin || '').toUpperCase();
  // 裸 VIN 直读同偏移（idx6/7/11）；idx11 与车型码第 3 字符吻合时命中（真机 981 实证）。
  // ★ 2026-11-06 严格口径：**全 VIN（≥16 位）一律 V[11]**（参考诊断仪 指令实锤三处 ldrb，
  //   不做 ZZZ 特判——真实 ZZZ 全长 VIN 的 V[11]=车型码复位位，与 V[8] 同值；
  //   V[11] 不吻合=畸形 VIN，参考诊断仪 同样 null 兜底不猜）。
  //   **前缀（<16 位）**：V[11] 不存在，旧格式 ZZZ（WP0ZZZ…）车型码在 7-9 位
  //   （V[6..8]，VIN 布局约定）取 V[8] 补位；现代 VDS 前缀缺第三字符走 Get9x1 规则。
  const zzz = V.substring(3, 6) === 'ZZZ';
  const c6 = V[6] || '', c7 = V[7] || '';
  const c11 = (V.length >= 16 ? V[11] : (zzz ? V[8] : '')) || '';
  if (!c7) return null;
  let id = null;
  if (c7 < '1' || c7 > 'A') {
    id = c7 === 'Y' ? 17 : c7 === 'P' ? 3 : 0;
  } else if (c7 === '1') {
    id = c11 === 'A' ? 21 : c11 === '8' ? 16 : 0;
  } else if (c7 === '2') {
    id = 11;
  } else if ('346:;<=>?@'.includes(c7)) {
    id = 0;
  } else if (c7 === '5') {
    id = 15;
  } else if (c7 === '7') {
    id = c11 === '1' ? 18 : c11 === '0' ? 12 : 0;
  } else if (c7 === '8') {
    id = c11 === '1' ? 13 : c11 === '2' ? 13 : c11 === '6' ? 2 : c11 === '7' ? 6 : 0;
  } else if (c7 === '9') {
    id = c11 === '1' ? 14 : c11 === '2' ? 20 : c11 === '6' ? 1 : c11 === '7' ? 5 : 0;
  } else if (c7 === 'A') {
    id = c6 === 'X' ? 15 : c6 === 'Y' ? 22 : 0;
  }
  // ★ 前缀（<16 位）现代 VDS：TBB 第三字符缺失 → 按 Get9x1_Cs1ForVin 尾规则落平台 id
  //   （指令实锤：ldrb [sl,#7]; cmp #0x39('9') → '9'=14、其余=13）。
  if (!id && V.length < 16 && (c7 === '8' || c7 === '9')) id = c7 === '9' ? 14 : 13;
  // ★ 2026-11-06 GetVehicleForVin 车型表（参考诊断仪 读写库 0x147c80 逐指令转写，
  //   数据源 data/vin-vehicle-map.json，此处内联镜像保持同步函数）：
  //   (VIN[7],VIN[11]) → (平台名, DSN id)。主 TBB 未命中时用它补 id（('9','8')→918S/16、
  //   ('9','A')→J1/21 等分支主分派会落 0）；平台名粒度=9X1/G1/G2/…——不含车身型式
  //   （Boxster/Cayman 同 9X1，三处字面量同址 0x21bb01 实证），故不据此强拆车身。
  const VEH_TABLE = {
    '2': ['E2', 11], '5': ['CAJUN', 15], '70': ['G1', 12], '71': ['G2', 18],
    '81': ['9X1', 13], '82': ['9X1', 13], '91': ['9X1', 13], '92': ['992', 20],
    '98': ['918S', 16], '9A': ['J1', 21], '18': ['918S', 16], '1A': ['J1', 21],
    'A': ['G3', 22], 'P': ['E1', 3], 'Y': ['E3', 17],
  };
  let vehName = '';
  if (!id) {
    const hit = VEH_TABLE[c7 + (c11 || '')] || VEH_TABLE[c7];
    if (hit) { vehName = hit[0]; id = hit[1]; }
  } else {
    const hit = VEH_TABLE[c7 + (c11 || '')] || VEH_TABLE[c7];
    if (hit) vehName = hit[0];
  }
  // DSN 22 条名表（id→名，id 7-10 名="0"=保留/未用）→ catalog 车型
  // （车型归属 = DSN 名 + JOB.XML 零件号族交叉，例：id12 名 G1/970 件→Panamera-970）
  const ID_MODELS = {
    1: ['Boxster（986）', '911（996）', '911（964/993）'],           // 9x6（986/996 件）
    2: ['Boxster（986）', '911（996）', '911（964/993）'],           // 9x6
    3: ['Cayenne-9PA（至2010年款止）'],                             // E1（9PA 件）
    4: ['Boxster（987）', 'Cayman（987）', '911（997）'],            // 9x7
    5: ['Boxster（987）', 'Cayman（987）', '911（997）'],            // 9x7
    6: ['Boxster（987）', 'Cayman（987）', '911（997）'],            // 9x7
    11: ['Cayenne-92A（2011 - 2017）'],                             // E2（958 件）
    12: ['Panamera-970（至2016年款止）'],                            // G1（970 件）
    13: ['Boxster（981）', 'Cayman（981）', 'Boxster（982）', 'Cayman（982）', 'Cayman GT4 Clubsport', '911（991）'], // 9x1（981/982/991 件）
    14: ['Boxster（981）', 'Cayman（981）', 'Boxster（982）', 'Cayman（982）', 'Cayman GT4 Clubsport', '911（991）'], // 9x1
    15: ['Macan'],                                                  // cajun（95B 件）
    16: ['918 Spyder'],                                             // 918s
    17: ['Cayenne-9YA（自2018年款起）'],                             // E3（9Y0 件）
    18: ['Panamera-971（2017-2024）'],                               // G2（971/972 件）
    20: ['911（992）'],                                             // 992
    21: ['Taycan'],                                                 // J1（9J1 件）
    22: ['Panamera-YA（自2024年款起）'],                              // G3（976 件）
  };
  // id 7-10（名"0"）与 19（CS1，991/981 专属件未收敛到唯一车型）→ 不猜
  const models = ID_MODELS[id];
  if (!models || !models.length) return null;
  // ★ 2026-11-06 车型码收窄（指令级实锤：PorscheGetYearAndModel 读 VIN[6]/VIN[7]/VIN[11]
  //   三处 ldrb，拼起来=车型码本身：981/991/982/970/92A/95B/918 全咬合）：
  //   按车型码过滤车型列表 → 参考诊断仪 直接给出对应车型（991→911（991）单选），
  //   不再让用户从平台全家 6 选里手挑。旧格式前缀（WP0ZZZ…，11 位）车型码在 7-9 位
  //   （V[6..8]，VIN 布局约定）；现代 VDS 前缀缺第三字符 → 不猜走平台列表。
  let series = '';
  if (V.length >= 16) series = (c6 + c7 + c11).toUpperCase();
  else if (V.substring(3, 6) === 'ZZZ' && V.length >= 9) series = (V[6] + V[7] + V[8]).toUpperCase();
  if (series) {
    const narrowed = models.filter((m) => m.toUpperCase().includes(series));
    if (narrowed.length) {
      // ★ 2026-11-11 审计 P1-6：删除「车身型式精化」死逻辑。
      //   旧代码 `cross = narrowed.filter(m => byId.includes(m))`，而 byId=ID_MODELS[id]、
      //   narrowed 本来就是它的子集 → cross ≡ narrowed，`cross.length===1` 永不成立。
      //   原厂侧（RE-MODELADDR §1.4）明确：VIN 只能到家族（9X1），车身/trim 由 22 11 02
      //   应答文本落定 —— 故此处不猜，直接返回收窄集。
      return { models: narrowed, how: `参考诊断仪 分派 id=${id} · 车型码 ${series}${vehName ? ' · 平台 ' + vehName : ''}`, modelId: id, series, vehName: vehName || undefined };
    }
  }
  return { models, how: `参考诊断仪 分派 id=${id}${vehName ? ' · 平台 ' + vehName : ''}`, modelId: id, vehName: vehName || undefined };
}


// ===== 侧边栏布局（参考 AlfaProxi 三态 rail/dock）=====
// ★ 2026-10-31：Duo 展开 → rail（右侧竖栏）；手机/窄屏 → dock（底部横栏）。
//   所有返回操作集中到侧边栏 sbBack 按钮。
//   ⚠️ 全部防御式写法 —— $() 返回 null 时不抛异常，否则整个模块不执行。
function applySideBarMode() {
  try {
    // 原生 UITabBarController 侧栏已接管时隐藏 CSS 侧边栏
    if (window.innerWidth >= 720) {
      document.body.classList.add('native-rail');
      var sb = $('sideBar');
      if (sb) { sb.style.cssText = 'display:none !important'; }
      return;
    }
    const rail = window.innerWidth >= 720 && window.innerHeight >= 560;
    document.body.classList.toggle('sb-rail', rail);
    document.body.classList.toggle('sb-dock', !rail);
    // ★ 直接设置 display，不依赖 CSS body class 选择器（Capacitor WebView 可能缓存旧 CSS）
    // display 由 CSS class 控制，不直接设 style
  } catch {}
}
applySideBarMode();
let _sbResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_sbResizeTimer);
  _sbResizeTimer = setTimeout(applySideBarMode, 120);
});
window.addEventListener('orientationchange', () => setTimeout(applySideBarMode, 120));

// ★ 2026-10-31：接收原生 UITabBarController 侧栏事件（GlassRailPlugin）
// ★ 2026-11-01：插件桥必须走 registerPlugin('GlassRail')（同 MfiSerial 模式）。
//   window.GlassRail 是老写法，Capacitor 8 里不存在——真机实测返回键永远灰，
//   所有上报被 `if (window.GlassRail)` 静默跳过。
const GlassRail = registerPlugin('GlassRail');

window.APXRail = {
  select: (id) => {
    try {
      switch (id) {
        // === action 按钮：只触发动作，不切页、不打断当前操作 ===
        case 'back':
          goBack();
          return;
        case 'search':
          // 聚焦搜索框（不切页，不丢上下文）
          const si = document.getElementById('searchIn');
          if (si) { si.focus(); si.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          return;
        case 'log':
          // 滚到日志区（不切页）
          const logEl = document.querySelector('.log') || document.getElementById('log');
          if (logEl) logEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        // === 导航 tab：正常切页 ===
        case 'home':
          stack = [];
          try { if (typeof exitSystem === 'function') exitSystem(); } catch {}
          renderNav();
          return;
        case 'select':
          stack = [];
          renderNav();
          return;
        case 'doctor':
          try { $('btnDoctor')?.click(); } catch {}
          return;
        case 'sim':
          try { $('btnSim')?.click(); } catch {}
          return;
      }
    } catch {}
  }
};

// 网页导航栈变化时同步原生返回按钮可用性
function syncRailBackState() {
  try {
    if (GlassRail && GlassRail.setCanGoBack) {
      GlassRail.setCanGoBack({ canGoBack: stack.length > 0 }).catch(() => {});
    }
  } catch {}
}

// 网页切页时通知原生侧栏高亮
function syncNativeRail(id) {
  try {
    if (GlassRail && GlassRail.setActive) {
      GlassRail.setActive({ id }).catch(() => {});
    }
  } catch {}
}

// ★ 原生侧栏检测：宽屏（≥720px）= Duo/iPad → 原生 UITabBarController 侧栏
function detectNativeRail() {
  try {
    // Duo 合盖时窗口只有 466pt，但系统仍然渲染右侧原生 side rail。
    // 只要 Capacitor 的 GlassRail 插件存在，就说明是原生侧栏设备；
    // 此时必须隐藏网页 CSS dock，否则会出现“底部按键模块 + 原生侧栏”两套。
    const cap = window.Capacitor;
    const nativeApp = !!(cap && (
      (typeof cap.isNativePlatform === 'function' && cap.isNativePlatform())
      || cap.platform === 'ios'
      || cap.getPlatform?.() === 'ios'
    ));
    // 注：历史写法是 `window.GlassRail || nativeApp`，而 window.GlassRail 恒为
    // undefined（见上方 ★ 2026-11-01），此条件实际一直等价 nativeApp，行为保持不变。
    if (nativeApp) {
      document.body.classList.add('native-rail');
      return true;
    }
    if (window.innerWidth >= 720) {
      document.body.classList.add('native-rail');
      return true;
    }
    document.body.classList.remove('native-rail');
  } catch {}
  return false;
}
detectNativeRail();
setTimeout(detectNativeRail, 500);
setTimeout(detectNativeRail, 1500);
setTimeout(detectNativeRail, 2500);
window.addEventListener('resize', detectNativeRail);

// 侧边栏按钮事件（防御式绑定，null 不抛）
function _sbBind(id, fn) {
  try { const el = $(id); if (el) el.onclick = fn; } catch {}
}
_sbBind('sbBack', () => goBack());
_sbBind('sbHome', () => {
  stack = [];
  try { if (typeof exitSystem === 'function') exitSystem(); } catch {}
  try { $('secParam').style.display = 'none'; } catch {}
  renderNav();
});
_sbBind('sbDoctor', () => { try { $('btnDoctor')?.click(); } catch {} });
_sbBind('sbSearch', () => { try { $('btnScan')?.click(); } catch {} });
_sbBind('sbLog', () => {
  try { document.querySelector('.log')?.scrollIntoView({ behavior: 'smooth' }); } catch {}
});
_sbBind('sbSim', () => { try { $('btnSim')?.click(); } catch {} });

/** 渲染侧边栏面包屑（竖排导航栈） */
function renderSideBarCrumbs() {
  try {
    const box = $('sbCrumbs');
    const back = $('sbBack');
    if (!box) return;
    if (back) back.style.display = stack.length ? '' : 'none';
    const parts = stack.map((s) => s.title || '');
    box.innerHTML = parts.map((t, i) =>
      `<button class="sb-crumb${i === parts.length - 1 ? ' active' : ''}" data-i="${i}">${t}</button>`
    ).join('');
    box.querySelectorAll('.sb-crumb').forEach((b) => {
      b.onclick = () => {
        const i = +b.dataset.i;
        const leavingSys = stack.slice(i + 1).some((s) => s.level === 'sys');
        if (leavingSys) { try { if (typeof exitSystem === 'function') exitSystem(); } catch {} }
        stack = stack.slice(0, i + 1);
        try { $('secParam').style.display = 'none'; } catch {}
        renderNav();
      };
    });
  } catch {}
}

// ---------- 导航栈 ----------
/**
 * 版本信息（读 ECU 识别）—— 对应每个模块的「读版本信息」。
 *
 * 数据源 data/identity.json：KWP `1A xx` 识别项 + ASAM ODX 标识链，已按模块/变体归属。
 * 标签映射（实测：命令 ID+4 = 显示标签）：
 *   1A 9F ECU 识别 · 1A 87 ECU 序列号 · 1A 84 ECU 零件号 · 1A 91 零件图号
 *   1A 92 硬件号 · 1A 93 硬件版本 · 1A 94 软件号 · 1A 95 软件版本
 *   1A 96 认证号 · 1A 97 ECU ISO 码 · 1A 9A 系统供应商标识
 *
 * ⚠️ 全部**只读**，不做任何写入。
 */
async function renderIdentity(sys) {
  // ★ 2026-11-06 内层页化：版本信息与设码同款渲主区（navList），不弹底部面板
  const box = $('navList');
  showLoading('正在读取版本信息…', sys.label || '');
  let ident = null;
  try {
    ident = await fetch('data/identity.json').then((r) => (r.ok ? r.json() : null));
  } catch (e) { /* ignore */ }
  hideLoading();
  if (!ident) {
    box.innerHTML = '<div class="hint">版本信息数据缺失（data/identity.json）</div>';
    return;
  }
  // 按模块名归属（identity.json 的 module 是内部名，如 DME_BDE_Continental / _9x7_kombi）
  const sysNorm = (sys.label || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const modNames = (sys.modules || []).map((m) => String(m));
  // ⚠️ 与特殊功能的 modMatch 同口径（2026-10-16 审计 ★7）：
  //    此前只做精确名 + 互含，对 1572 个系统只命中 250 个（15.9%）。
  //    现补上内部模块名（BCM_hinten 等）+ KEYMAP 同类匹配。
  const NORM = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const SYS_KEYMAP = [
    ['组合仪表', ['ic','kombi','instr']], ['发动机', ['ecm','dme','motor']],
    ['变速器', ['tiptronic','pdk','getriebe']], ['驻车制动', ['epb','bremse']],
    ['转向盘', ['lenkrad','steering','swsg','swh']], ['前端电子设备', ['bcm_vorne','vorne']],
    ['后端电子设备', ['bcm_hinten','hinten']], ['保时捷稳定', ['psm','esp']],
    ['保时捷主动悬挂', ['pasm']], ['保时捷通讯', ['pcm','cdr','head']],
    ['网关', ['gateway','gatew']], ['座椅', ['seat','sitz']],
    ['灯光电子', ['lec','lhb','rhb','fhba','headlight']],
    ['轮胎压力', ['tpm','tpms','rdk']], ['安全气囊', ['srs','airbag','pab']],
    ['全轮驱动', ['allrad','awd']], ['空调', ['ac','klima','bke','klimaanlage']],
    ['电视调谐器', ['tvtuner']], ['触摸操作面板', ['touchbedienfeld']],
    ['辅助加热', ['zusatzheizung']], ['拖车', ['anhaenger','trail']],
  ];
  const catOf = (x) => {
    const n = NORM(x); if (!n) return null;
    for (const [zh, keys] of SYS_KEYMAP) {
      const z = NORM(zh);
      if (n === z || n.includes(z) || z.includes(n)) return zh;
      if (keys.some((k) => n.includes(k))) return zh;
    }
    return null;
  };
  const sysCat = catOf(sys.label);
  const hit = (ident.items || []).filter((it) => {
    const ms = (it.modules || []).map((x) => String(x));
    if (ms.some((m) => modNames.includes(m))) return true;
    const sysNorm2 = NORM(sys.label);
    return ms.some((m) => {
      const mn = NORM(m);
      if (!mn) return false;
      if (mn === sysNorm2 || mn.includes(sysNorm2) || sysNorm2.includes(mn)) return true;
      // 内部模块名参与
      const mods = (sys.modules || []).map(NORM).filter(Boolean);
      if (mods.some((x) => mn.includes(x) || x.includes(mn))) return true;
      // 同类匹配
      return sysCat != null && catOf(m) === sysCat;
    });
  });
  // 同标签去重，保留一条
  const byLabel = new Map();
  for (const it of hit) { if (!byLabel.has(it.label)) byLabel.set(it.label, it); }
  const rows = [...byLabel.values()];

  box.innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader"><div class="pdName">版本信息</div>
        <div class="hint">KWP 1A xx 识别 · 只读 · 命中 ${rows.length} 项${hit.length !== rows.length ? `（去重前 ${hit.length} 条）` : ''}</div></div>
      <div id="idList"></div>
      <div class="acts" style="margin-top:12px"><button id="idReadAll" class="primary">全部读取</button></div>
      <div class="hint" style="margin-top:8px">
        命令族：KWP <b>1A xx</b>（ReadECUIdentification）。
        未列出的项表示该模块在源数据里没有对应标识链，可点「全部读取」按标准全套试探。
      </div>
    </div>`;

  const list = $('idList');
  if (!rows.length) {
    list.innerHTML = '<div class="hint">该模块在源数据里没有版本信息条目 —— 点「全部读取」按标准 1A xx 全套试探。</div>';
  } else {
    list.innerHTML = rows.map((it, i) => `
      <div class="ruleRow" data-i="${i}">
        <div class="lbl">${it.labelZh || it.label}<span class="hint" style="margin-left:6px">${it.kwpId}</span></div>
        <div class="meta" style="opacity:.6;font-size:11px">${it.odxId}</div>
        <div class="val" id="idv${i}" style="font-family:monospace">—</div>
        <button class="idRead" data-i="${i}" data-kwp="${it.kwpId}">读取</button>
      </div>`).join('');
  }

  /**
   * 发 KWP 1A xx / UDS 22 F1xx，返回**可读**值。
   *
   * 显示口径取自参考诊断仪的版本信息模块（VERF.so）实测 JSON schema：
   *   { sys_id, sys_name, sys_type, is_disp, grp_name,
   *     item_list[ { item_txtid, item_name, item_value, item_type } ],
   *     ver_list, VERINFO, AUTOVER }
   *   版本记录: `<iSidR=..,<iSidW=..,<iPid=..,<iCodeLen=..,<iVerValue=..`
   *   item_type 取值 **byte | int | long**（数值型），格式化 spec 实测为
   *   `%02X` / `%02X%04X` / `0x%02X` / `0x%04X` / `0x%08X` / `%04x` / `%d`
   *   名称来自 item_txtid 经 EXPRESS.GAG 查表（不是自由文本）
   *
   * 因此：**值是数值/ASCII 两种形态**，按类型格式化，不要乱猜。
   */
  async function readIdent(kwpHex, itemType) {
    const id = parseInt(String(kwpHex).replace(/^0x/i, ''), 16);
    const r = await coder.uds('1A' + id.toString(16).toUpperCase().padStart(2, '0'), 4000, { allowEmpty: true });
    let b = Array.from(r.body || []);
    if (b[0] === 0x7f) return 'NRC 0x' + (b[2] || 0).toString(16).toUpperCase();
    if (b[0] === 0x5a) b = b.slice(2);
    else if (b[0] === 0x62) b = b.slice(3);
    // 去尾部填充（参考实现对 iCodeLen 定长，尾部用 00/20/FF 填）
    while (b.length && (b[b.length - 1] === 0x00 || b[b.length - 1] === 0x20 || b[b.length - 1] === 0xff)) b.pop();
    if (!b.length) return '(空)';

    // ① 版本记录形态：`<iSidR=..,<iPid=..,<iVerValue=..` 直接原样显示
    const asAscii = b.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('');
    if (/^<i(Sid|Pid|Ver|Code)/.test(asAscii.trim())) return asAscii.trim();

    // ② item_type 驱动的数值格式化（byte/int/long）
    const n = b.length;
    const be = b.reduce((a, c) => (a * 256 + c) >>> 0, 0);
    const le = b.slice().reverse().reduce((a, c) => (a * 256 + c) >>> 0, 0);
    const numeric = (itemType || '').toLowerCase();
    if (numeric === 'byte' && n === 1) return `0x${b[0].toString(16).toUpperCase().padStart(2, '0')} (${b[0]})`;
    if (numeric === 'int' && n <= 2) return `0x${be.toString(16).toUpperCase().padStart(n * 2, '0')} (${be})`;
    if (numeric === 'long' && n <= 4) return `0x${be.toString(16).toUpperCase().padStart(n * 2, '0')} (${be})`;

    // ③ 全可打印 → ASCII（零件号/版本号/供应商名）
    const printable = b.filter((c) => c >= 0x20 && c < 0x7f).length;
    if (printable >= b.length * 0.8) {
      return b.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('').trim() || '(空)';
    }
    // ④ 混合 → 可打印段拼接
    const parts = []; let cur = '';
    for (const c of b) {
      if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
      else { if (cur) { parts.push(cur); cur = ''; } }
    }
    if (cur) parts.push(cur);
    if (parts.length) return parts.join(' · ');
    // ⑤ 全二进制 → 按数值 spec 显示（0x%08X 等）
    return `0x${be.toString(16).toUpperCase().padStart(n * 2, '0')}`;
  }

  async function doRead(i, kwpHex) {
    const el = document.getElementById('idv' + i);
    try {
      await coder.enterSessionFor('ident');
      const v = await readIdent(kwpHex);
      if (el) { el.textContent = v; el.style.color = /^NRC/.test(v) ? '#c0392b' : ''; }
      return v;
    } catch (e) {
      if (el) { el.textContent = '✗ ' + e.message; el.style.color = '#c0392b'; }
      return null;
    }
  }

  list.querySelectorAll('.idRead').forEach((b) => {
    b.onclick = () => doRead(Number(b.dataset.i), b.dataset.kwp);
  });
  $('idReadAll').onclick = async () => {
    if (!needLink()) return;
    const std = ['0x9F', '0x87', '0x84', '0x91', '0x92', '0x93', '0x94', '0x95', '0x96', '0x97', '0x9A'];
    $('idReadAll').disabled = true;
    try {
      if (!rows.length) {
        // ⚠️ 结果必须画到卡片上 —— 此前只 log()，用户点「全部读取」后什么也看不到。
        const stdZh = { '0x9F': 'ECU 识别', '0x87': 'ECU 序列号', '0x84': 'ECU 零件号',
          '0x91': '零件图号', '0x92': '硬件号', '0x93': '硬件版本', '0x94': '软件号',
          '0x95': '软件版本', '0x96': '认证号', '0x97': 'ECU ISO 码', '0x9A': '系统供应商标识' };
        await coder.enterSessionFor('ident');
        list.innerHTML = std.map((k, i) => `
          <div class="ruleRow"><div class="lbl">${stdZh[k] || k}<span class="hint" style="margin-left:6px">1A ${k.replace('0x', '')}</span></div>
          <div class="val" id="idv${i}" style="font-family:monospace">读取中…</div></div>`).join('');
        for (let i = 0; i < std.length; i++) {
          const el = document.getElementById('idv' + i);
          try {
            const v = await readIdent(std[i]);
            if (el) { el.textContent = v || '(空)'; el.style.color = /^NRC/.test(v) ? '#c0392b' : ''; }
          } catch (e) {
            if (el) { el.textContent = '✗ ' + e.message; el.style.color = '#c0392b'; }
          }
        }
        return;
      }
      for (let i = 0; i < rows.length; i++) await doRead(i, rows[i].kwpId);
    } finally {
      $('idReadAll').disabled = false;
    }
  };
}

function topLevelItems() {
  const t = tree?.topLevel || [];
  // ★ 只显示可离线的功能，移除需在线的（在线编程/编码/ADAS/防盗/安全网关）
  // ⚠️ 2026-10-18 审计：`special` 顶层入口此前会显示，但点进去只弹「本版只做设码/特殊功能」，
  //    特殊功能实际是**模块级**页面（需要模块地址/会话），顶层没有可执行的落点 —— 死入口。
  //    先不显示，等有「系统 → 模块地址」映射后再接。
  const offlineKinds = new Set(['autosearch', 'manual']);
  return t.filter((x) => offlineKinds.has(x.kind)).map((x) => ({
    kind: 'top', raw: x,
    lbl: x.label || x.id,
    meta: describeTop(x),
  }));
}

function describeTop(x) {
  switch (x.kind) {
    case 'autosearch': return '读 VIN 自动识别车型年款';
    case 'manual': return `${x.groups?.length ?? 0} 个车系组`;
    case 'special': return '独立特殊功能';
    default: return '';
  }
}

function groupItems() {
  return (tree?.groups || []).map((g) => ({
    kind: 'group', raw: g,
    lbl: g.label || g.id,
    meta: `${g.models?.length ?? 0} 个车型`,
  }));
}

function modelItems(g) {
  return (g.models || []).map((m) => ({
    kind: 'model', raw: m,
    lbl: m.label || m.id,
    meta: `${(m.functions || []).map((f) => f.id).join(' · ')}`,
  }));
}

function fnItems(m) {
  return (m.functions || []).map((f) => {
    let meta = '';
    if (f.kind === 'quicktest') meta = '全车扫故障';
    else if (f.kind === 'sysscan') meta = '逐系统探测';
    else if (f.kind === 'syssel') meta = `${f.systems?.length ?? 0} 个系统`;
    else meta = `${f.items?.length ?? f.subFunctions?.length ?? 0} 项`;
    return { kind: 'fn', raw: f, lbl: f.id, meta };
  });
}

function sysItems(f) {
  // v3 树：系统条目内联（label/ecu/modules/codingCount/itemIds）
  return (f.systems || []).map((s) => {
    const cnt = s.codingCount ?? s.count ?? 0;
    return {
      kind: 'sys',
      raw: { ...s, codingCount: cnt, label: s.label },
      lbl: s.label,
      meta: `ECU ${s.ecu ?? '—'} · ${cnt} 条${s.unmapped ? ' · 无对应数据' : ''}`,
      cnt,
    };
  });
}

/**
 * 模块下的功能列表 —— 对齐参考诊断仪：进模块后不止「设码」，还有
 *   读故障码 / 设码（刷隐藏）/ 特殊功能 / 数据流 / 执行器测试
 */
function sysFnItems(s) {
  const base = (s.functions || []).map((f) => ({
    kind: 'sysfn', raw: { ...f, _sys: s },
    lbl: f.id,
    meta: f.subFunctions ? `${f.subFunctions.length} 个子功能` : `${f.count ?? (f.itemIds || []).length} 个条目`,
    cnt: f.count ?? (f.itemIds || []).length,
  }));
  // 参考诊断仪里模块下固定有这些功能项（服务已实现，这里给入口）
  const extras = [
    { id: '读故障码', kind: 'dtc', sid: '19', meta: '读取 / 清除故障码' },
    { id: '设码', kind: 'coding', meta: '编码 / 刷隐藏（主功能）' },
    { id: '数据流', kind: 'measure', meta: '实时测量值' },
    { id: '执行器测试', kind: 'actuator', meta: 'IOControl 驱动执行器' },
    { id: '版本信息', kind: 'identity', meta: 'ECU 识别 / 硬件号 / 软件版本 …' },
    { id: '特殊功能', kind: 'special', meta: '例程控制（校准/匹配/初始化等）' },
  ];
  for (const e of extras) {
    if (base.some((b) => b.lbl === e.id)) continue;
    base.push({ kind: 'sysextra', raw: { ...e, _sys: s }, lbl: e.id, meta: e.meta, cnt: null });
  }
  return base;
}

/** 从 coding-v2 按模块取参数（树里只存 id，不存副本） */
function paramsByModules(modules, itemIds) {
  let list = coding.filter((p) => (modules || []).includes(p.module));
  if (itemIds && itemIds.length) {
    const byId = new Map(list.map((p) => [p.id, p]));
    const picked = itemIds.map((i) => byId.get(i)).filter(Boolean);
    if (picked.length) list = picked;
  }
  return list;
}

/**
 * 二级菜单：按 path[0] 分组（参考诊断仪的做法 —— 冷却液温度特性X / 转速表特性Y / 设码值 …）
 * 不再把一个模块的所有条目摊平。
 */
function groupItemsOf(f) {
  const mods = f._sys?.modules || f.modules;
  const list = f.items?.length ? f.items : paramsByModules(mods, f.itemIds);
  const byGroup = new Map();
  for (const p of list) {
    const g = (p.path && p.path[0]) || '(未命名)';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  // 多维特性组（X/Y）排前面，其余按名称
  // ★ 合并 X/Y 特性组：参考诊断仪里「冷却液温度特性」是一个入口，进去看到 X/Y 表
  //   我们数据里拆成 冷却液温度特性X / 冷却液温度特性Y 两个分组，要并起来
  const norm = (s) => s.replace(/[\s]*([XYZ])\s*$/i, '').trim();
  const merged = new Map();
  for (const [g, items] of byGroup.entries()) {
    const base = norm(g);
    if (!merged.has(base)) merged.set(base, []);
    merged.get(base).push(...items);
  }
  const entries = [...merged.entries()].map(([g, items]) => {
    const multi = items.some((p) => p.multiGroup);
    const axes = {};
    for (const p of items) {
      const leaf = (p.path || []).slice(-1)[0] || '';
      const m = /^\s*([XYZ])\s*(\d+)\s*$/.exec(leaf);
      if (m) (axes[m[1]] ||= []).push(p);
    }
    for (const k of Object.keys(axes)) axes[k].sort((a, b) => {
      const na = +(/\d+/.exec((a.path || []).slice(-1)[0] || '') || [0]);
      const nb = +(/\d+/.exec((b.path || []).slice(-1)[0] || '') || [0]);
      return na - nb;
    });
    const axDesc = Object.keys(axes).length
      ? Object.entries(axes).map(([k, v]) => `${k}${v.length}`).join(' / ')
      : `${items.length} 个条目`;
    return {
      kind: 'subgroup',      // ← 与车系组 'group' 区分（switch 同名 case 会死代码）
      raw: { name: g, items, axes, multi },
      lbl: g,
      meta: multi ? `特性曲线 · ${axDesc}` : axDesc,
      cnt: items.length,
    };
  });
  entries.sort((a, b) => (b.raw.multi - a.raw.multi) || a.lbl.localeCompare(b.lbl, 'zh'));
  return entries;
}

function paramItems(items) {
  return items.map((p) => ({
    kind: 'param', raw: p,
    lbl: p.name,
    meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}`,
    cnt: null,
  }));
}

function kindLabel(p) {
  if (p.kind === 'switch') return '开关';
  if (p.kind === 'enum') return `枚举 ${Object.keys(p.enum || {}).length} 项`;
  return '数值';
}
function rangeHint(p) {
  if (p.kind === 'switch') return '开 / 关';
  if (p.kind === 'enum') return `取值 ${(p.min ?? 0)}..${(p.max ?? 0)}`;
  const hi = p.max ?? p.maxText ?? '?';
  return `范围 ${p.min ?? 0}..${hi}`;
}

// ---------- 渲染 ----------
/** 退一级（返回按钮用） */
function goBack() {
  if (!stack.length) return;
  // ★ 2026-11-06 返回语义（用户实测步骤：设码→刷隐藏→搜索→返回）：
  //   搜索态下返回 = **先退出搜索**（清检索词回该层未搜索全量列表），再按才退层。
  //   此前直接退层 → 从搜索结果一按就跳回设码选择页（跳过"退出搜索"这一步）。
  //   两条返回路径（侧边栏 sbBack / Duo 原生 APXRail）都走这里，天然拉齐。
  const _top = stack[stack.length - 1];
  if (_top && (_top.searchQuery || '').trim()) {
    _top.searchQuery = '';
    renderNav();
    toast('info', `返回「${_top.title}」`, '已退出搜索');
    return;
  }
  // ★ 只在真正离开系统（回到系统列表以下）时才 exitSystem
  // 规则编码/设码的子级之间移动不应该断开会话
  const top = stack[stack.length - 1];
  const prev = stack.length >= 2 ? stack[stack.length - 2] : null;
  const isLeavingSystem = top.level === 'sys' && (!prev || prev.level !== 'sysfn');
  if (isLeavingSystem) exitSystem();
  stack = stack.slice(0, -1);
  $('secParam').style.display = 'none';
  renderNav();
  const newTop = stack[stack.length - 1];
  toast('info', newTop ? `返回「${newTop.title}」` : '返回首页');
}

function crumb() {
  const segs = [];
  stack.forEach((s, i) => {
    const last = i === stack.length - 1;
    segs.push(last ? `<b>${s.title}</b>` : `<button data-i="${i}">${s.title}</button>`);
    if (!last) segs.push('<span class="sep">›</span>');
  });
  if (!stack.length) segs.push('<b>请选择车型</b>');
  $('crumb').innerHTML = segs.join('');

  // 面包屑可点（跳到任意一层）
  $('crumb').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.i;
      const leavingSys = stack.slice(i + 1).some((s) => s.level === 'sys');
      if (leavingSys) exitSystem();
      stack = stack.slice(0, i + 1);
      $('secParam').style.display = 'none';
      renderNav();
    };
  });

  // 显式返回键 —— 栈里只要有东西就显示
  try { const bb = $('btnBack'); if (bb) bb.style.display = stack.length ? '' : 'none'; } catch {}
  renderSideBarCrumbs();
  syncRailBackState();
}

function renderNav() {
  crumb();
  // 默认显示常规搜索框（codgroup 会隐藏它）
  const _searchEl = $('searchIn');
  if (_searchEl) _searchEl.parentElement.style.display = '';
  const list = $('navList');
  const q = ($('searchIn').value || '').trim().toLowerCase();
  list.innerHTML = '';
  $('navEmpty').style.display = 'none';
  $('navHint').textContent = '';

  let items = [];
  let title = '请选择车型';

  if (!stack.length) {
    items = topLevelItems();
  } else {
    const top = stack[stack.length - 1];
    title = top.title;
    switch (top.level) {
      case 'top': {
        const x = top.data;
        if (x.kind === 'manual') { items = groupItems(); title = '手动选择'; }
        else if (x.kind === 'online') {
          items = (x.items || []).map((s) => ({ kind: 'onlineitem', raw: s, lbl: s, meta: '' }));
          title = '在线功能';
        } else {
          items = [];
          $('navHint').textContent = `「${x.id}」是独立功能入口，暂不展开设码列表。`;
          toast('info', `「${x.id}」暂不展开`, '这是独立功能入口，本版只做设码/特殊功能');
          title = x.id;
        }
        break;
      }
      case 'group': { items = modelItems(top.data); title = top.data.label; break; }
      case 'model': { items = fnItems(top.data); title = top.data.label; break; }
      case 'fn': {
        const f = top.data;
        if (f.kind === 'syssel') { items = sysItems(f); title = '系统选择'; }
        else if (f.kind === 'quicktest') { items = []; $('navHint').textContent = '快速测试：全车故障扫描（需连接适配器）。';
          if (!needLink()) return;
          toast('info', '快速测试', '全车故障扫描 —— 用「诊断码」页的读故障码，本项暂为入口'); }
        else if (f.kind === 'sysscan') { items = []; $('navHint').textContent = '系统扫描：逐系统探测（需连接适配器）。';
          if (!needLink()) return;
          toast('info', '系统扫描', '逐系统探测 —— 建议直接进「系统选择」逐个模块读'); }
        else { items = (f.items || []).map((p) => ({ kind: 'param', raw: p, lbl: p.name, meta: '' })); }
        break;
      }
      case 'sys': { items = sysFnItems(top.data); title = top.data.label; break; }
      case 'codsubmenu': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'ruleGroupList': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'ruleSubgroupList': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'ruleGroup': {
        // ★ 2026-11-08 规则定案（用户实测四观测，RE-CODING-TREE 终判节）：
        //   二级页行 = 组内条目**按记录序**（ALLDATA 池链顺序，= data/models JSON items 顺序）
        //   **每 50 条一页**，行名 = 组名+同名去重编号（…0/…1/…2…）；页内条目平铺（记录序，不重排）。
        //   ≤50 条组 = **进组即批量视图**（★ 2026-11-09 用户裁定，取代 11-08「条目直接行」：
        //   「应该都和有二级菜单的一样我直接能批量看见当前值和进行批量修改」）。
        //   证据：PTI 88→50+38（…0 末=N09、…1 首=N08 与用户屏吻合）；警告配置(A2_9) 306→7 行 …0-…6；
        //   菜单配置 63→50+13；显示配置出厂设置 87→50+36。旧族桶/byte 半分/模块块假说全部作废。
        const g = top.data;
        const all = g.items || [];   // ⚠️ 保持记录序（勿按 byte 排序）
        if (all.length <= 50) {
          // ★ 2026-11-09 UI 形态统一：≤50 组不再出「条目行→逐个详情页」，
          //   直接复用桶页/批量页同款 showRuleBatchEdit（数据已由 onSelect readBlocksForItems 预读），
          //   每行=名称|当前值|修改控件，直改直显；写入闸门不动（逐项 applyChange：备份→写→回读）。
          $('navTitle').textContent = g.name;   // 组页头保留组名（返回走栈/crumb）
          showRuleBatchEdit(g.name, all);
          return;
        }
        const pageRows = [];
        for (let off = 0, pi = 0; off < all.length; off += 50, pi++) {
          const page = all.slice(off, off + 50);
          pageRows.push({
            kind: 'ruleChain', minByte: pi,
            raw: { name: `${g.name}${pi}`, items: page, parentGroup: g.name, fam: `第${pi}页` },
            lbl: `${g.name}${pi}`, meta: `${page.length} 个编码项`, cnt: page.length,
          });
        }
        items = pageRows;
        title = g.name;
        break;
      }
      case 'ruleChain': {
        // 子索引链 → 该链全量编码平铺（参考诊断仪「分别进去就是全量的编码」）
        const ch = top.data;
        showRuleBatchEdit(ch.name, ch.items || []);
        return;
      }
      case 'ruleSubgroup': {
        const sg = top.data;
        showRuleBatchEdit(`${sg.parentGroup} > ${sg.name}`, sg.items);
        return;
      }
      case 'codgroup': {
        // ★ 隐藏常规搜索框，只留设码搜索
        const searchEl = $('searchIn');
        if (searchEl) searchEl.parentElement.style.display = 'none';
        items = top.data.groups || [];
        title = top.title;
        // 参考诊断仪: 设码列表第一项是搜索框，搜全量项（含二级三级内容）
        const searchHtml = `<div class="codSearch"><input id="codSearchIn" placeholder="搜索设码项（含子分组内容）..." oninput="window._codSearch(this.value)"></div>`;
        $('navList').innerHTML = searchHtml;
        window._codSearch = (q) => {
          top.searchQuery = q;   // ★ 2026-11-05：检索词挂在栈条目上，详情页返回后恢复搜索结果视图
          if (!q.trim()) { renderNav(); return; }
          const ql = q.toLowerCase();
          const allItems = top.data.allItems || [];
          const matched = allItems.filter((p) => {
            const name = (p.name || '').toLowerCase();
            const pathStr = (p.path || []).join(' ').toLowerCase();
            return name.includes(ql) || pathStr.includes(ql);
          }).map((p) => ({
            kind: 'param', raw: p,
            lbl: `${(p.path || []).join(' › ')}`,
            meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
            cnt: null,
          }));
          const list = $('navList');
          const searchBox = list.querySelector('.codSearch');
          list.innerHTML = '';
          if (searchBox) list.appendChild(searchBox);
          if (!matched.length) {
            list.insertAdjacentHTML('beforeend', '<div class="navEmpty">无匹配结果</div>');
          } else {
            matched.slice(0, 200).forEach((it) => {
              const d = document.createElement('div');
              d.className = 'item';
              d.innerHTML = `<div class="lbl">${it.lbl}</div><div class="meta">${it.meta || ''}</div>`;
              d.onclick = () => onSelect(it);
              list.appendChild(d);
            });
            if (matched.length > 200) {
              // ⚠️ 不能用 `list.innerHTML +=`：那会把上面的搜索框节点一起重建/丢掉，
              //    用户打一个字后搜索框就消失（2026-10-18 审计）。
              list.insertAdjacentHTML('beforeend',
                `<div class="hint" style="padding:10px">共 ${matched.length} 条匹配，显示前 200 条</div>`);
            }
          }
        };
        break;
      }
      case 'codsubgroup': { items = top.data.groups || []; title = top.title; break; }
      case 'codl4group': { items = top.data.groups || []; title = top.title; break; }
      case 'codelist': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'paramdetail': {
        // 参数详情独立页面
        const p = top.data;
        renderParamDetail(p);
        return;
      }
      case 'sysfn': {
        const f = top.data;
        if (f.subFunctions) {
          items = f.subFunctions.map((s) => ({ kind: 'sub', raw: s, lbl: s.label || s.id, meta: s.risk ? `风险：${riskLabel(s.risk)}` : '' }));
          title = f.id;
        } else {
          items = groupItemsOf(f);     // ← 二级菜单，不摊平
          title = f.id;
        }
        break;
      }
      case 'subgroup': {
        const g = top.data;
        if (g.multi && Object.keys(g.axes).length) {
          // 多维特性组：显示 X/Y 表格
          showMultiGroup(g);
          items = [];
          title = g.name;
          break;
        }
        items = paramItems(g.items || []);
        title = g.name;
        break;
      }
      case 'sysx': {
        // ★ 2026-11-06 功能内层页（数据流/版本信息/特殊功能/执行器/故障码/编程）：
        //   与设码同款 —— 替换主区渲染，sbBack/原生返回即回上层菜单。
        const sElx = $('searchIn');
        if (sElx) sElx.parentElement.style.display = 'none';
        $('navTitle').textContent = top.title;
        $('navEmpty').style.display = 'none';
        $('navList').innerHTML = '<div class="hint">加载中…</div>';
        showSysExtra(top.data.f);
        return;
      }
      case 'onlineitem': { items = []; $('navHint').textContent = `「${top.title}」需联网，暂未实现。`;
        toast('warn', `「${top.title}」暂未实现`, '该项需联网/需授权，本版不做'); break; }
    }
  }

  $('navTitle').textContent = title;
  if (q) items = items.filter((i) => (i.lbl || '').toLowerCase().includes(q) || (i.meta || '').toLowerCase().includes(q));

  if (!items.length) {
    $('navEmpty').style.display = '';
    const _topE = stack[stack.length - 1];
    if (_topE && _topE.level === 'codgroup' && (_topE.searchQuery || '').trim()) {
      const _inpE = $('codSearchIn');
      if (_inpE) _inpE.value = _topE.searchQuery;
      window._codSearch(_topE.searchQuery);
    }
    return;
  }
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<div class="lbl">${it.cnt != null ? `<span class="cnt">${it.cnt}</span>` : ''}${it.lbl}</div>
      ${it.meta ? `<div class="meta">${it.meta}</div>` : ''}`;
    d.onclick = () => onSelect(it);
    list.appendChild(d);
  }
  // ★ 2026-11-06 修复（用户实测 bug① 复发）：检索词恢复必须在**尾段条目渲染完之后**——
  //   此前放在 codgroup case 内，尾段的分组条目又追加进列表，返回后=搜索结果+全量混排。
  //   现在尾段收尾统一重放搜索（_codSearch 会重绘为「搜索框+匹配项」，与进入详情前一致）。
  {
    const _top = stack[stack.length - 1];
    if (_top && _top.level === 'codgroup' && (_top.searchQuery || '').trim()) {
      const _inp = $('codSearchIn');
      if (_inp) _inp.value = _top.searchQuery;
      window._codSearch(_top.searchQuery);
    }
  }
}

/**
 * 进模块：切地址 → 进会话 → 编码块按需读（打开参数/点读取时才读）。
 */


function showRuleCoding(allItems, sysLabel) {
  // ★ 参考诊断仪的做法：先显示一级分组目录（和刷隐藏一样），点进去再批量编辑
  const groups = {};
  for (const p of allItems) {
    const g = p.path?.[0] || '（未命名）';
    (groups[g] = groups[g] || []).push(p);
  }
  const groupItems = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, items]) => ({
      kind: 'ruleGroup', raw: { name, items, sysLabel },
      lbl: name, meta: `${items.length} 个参数`, cnt: items.length,
    }));
  stack.push({ level: 'ruleGroupList', title: `规则编码 · ${sysLabel}`, data: { items: groupItems, allItems, sysLabel } });
  renderNav();
}

function showRuleGroup(g) {
  // ★ 参考诊断仪的做法：有 L3 子组就先显示子组列表，没有才直接显示条目
  const hasSubgroups = g.items.some((p) => (p.path?.length || 0) >= 3);
  if (hasSubgroups) {
    // 按 L3 子分组
    const subgroups = {};
    for (const p of g.items) {
      const sg = (p.path?.length >= 3) ? p.path[1] : '（直接条目）';
      (subgroups[sg] = subgroups[sg] || []).push(p);
    }
    const sgItems = Object.entries(subgroups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, items]) => ({
        kind: 'ruleSubgroup', raw: { name, items, parentGroup: g.name },
        lbl: name, meta: `${items.length} 个参数`, cnt: items.length,
      }));
    stack.push({ level: 'ruleSubgroupList', title: g.name, data: { items: sgItems, allItems: g.items, sysLabel: g.sysLabel } });
    renderNav();
    return;
  }
  // 无子组 → 直接批量编辑
  showRuleBatchEdit(g.name, g.items);
}

function showRuleSubgroup(sg) {
  // 显示 L3 子组的批量编辑
  showRuleBatchEdit(`${sg.parentGroup} > ${sg.name}`, sg.items);
}

function enumValueEquals(key, value) {
  if (value == null) return false;
  try { return BigInt(key) === BigInt(value); } catch { return Number(key) === Number(value); }
}

function showRuleBatchEdit(title, items) {
  const rows = items.map((p, rowIdx) => {
    const curVal = p.currentValue !== undefined ? decodeValue(p, p.currentValue) : '?';
    const en = p.enum ? Object.entries(p.enum)
      : (p.kind === 'switch' ? [[0, '关'], [1, '开']] : []);
    let inputHtml;
    if (p.kind === 'switch' || p.kind === 'enum') {
      // ⚠️ enum key 是**十进制**字符串（"0".."255"/"16777215"），不是十六进制！
      // 曾用 parseInt(k,16)：`"255"→597`、`"10"→16`，3802 条枚举里 4194 个 key≥10 全写错值。
      inputHtml = `<select class="ruleVal" data-idx="${rowIdx}" data-touched="0" onchange="this.dataset.touched='1'">${en.map(([k, v]) =>
        `<option value="${k}" ${enumValueEquals(k, p.currentValue) ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    } else {
      const wide = (p.bitsize | 0) > 53;
      inputHtml = `<input class="ruleVal" data-idx="${rowIdx}" data-touched="0" oninput="this.dataset.touched='1'" type="${wide ? 'text' : 'number'}" inputmode="numeric" value="${p.currentValue ?? 0}" min="${p.min ?? 0}" max="${p.max ?? ''}" style="width:${wide ? 150 : 70}px">`;
    }
    // 显示完整路径（含 L3 上下文）
    const pathStr = (p.path || []).slice(1).join(' › ');
    return `<div class="ruleRow">
      <div class="ruleName">${p.name}<br><small>${pathStr} · byte ${p.byte} bit ${p.bit} · 当前: ${curVal}</small></div>
      <div class="ruleInput">${inputHtml}</div>
    </div>`;
  }).join('');

  $('navList').innerHTML = `
    <div class="ruleCoding">
      <div class="hint">${title}：修改后点「批量写入」一次性写入。</div>
      <div class="ruleGroup">
        ${rows}
      </div>
      <div class="acts" style="margin-top:16px">
        <button id="ruleBatchWrite" class="primary">批量写入</button>
      </div>
    </div>`;

  $('ruleBatchWrite').onclick = async () => {
    const changes = [];
    const rejected = [];
    $('navList').querySelectorAll('.ruleVal').forEach((el) => {
      const p = items[Number(el.dataset.idx)];
      if (!p) return;
      const newVal = parseFieldInput(p, el.value);
      if (newVal == null) { rejected.push(`${p.name}: 值无效（${el.value}）`); return; }
      // ⚠️ 当前值未读到时不能一律跳过（2026-10-18 审计）：此前 `currentValue===undefined`
      //    直接 return，用户明明改了值也不会进 changes，批量写入静默少项。
      //    现在只有「用户真的动过」才纳入；未动过仍跳过，避免把第一项当目标值写进去。
      if (el.dataset.touched !== '1') return;  // 未触碰行绝不写，不能由控件默认值反推用户意图
      if (p.currentValue !== undefined && newVal === p.currentValue) return;
      // ⚠️ 批量写入必须与单项写入**同一套闸门**：
      //   ① canWrite（只读项 / 无 LID / 严格门禁开关）
      //   ② min/max 范围 —— 此前批量路径不查，injectField 对越界值
      //      `& mask` 静默截断后照写（2026-10-16 复查 P11）
      if (!canWrite(p)) { rejected.push(`${p.name}: 不可写（只读/无 LID/门禁）`); return; }
      if (SAFETY.range && !fieldInRange(p, newVal)) {
        rejected.push(`${p.name}: ${newVal} 超出范围 ${p.min ?? 0}…${p.max ?? '?'}（安全增强已开启）`);
        return;
      }
      changes.push({ p, newVal });
    });
    if (rejected.length) {
      alert(`有 ${rejected.length} 项未通过校验，已跳过：\n\n${rejected.slice(0, 10).join('\n')}`);
    }
    if (!changes.length) {
      toast('info', '没有可写入的变更', rejected.length ? '全部被校验拦下' : '所有值与当前值一致');
      return;
    }
    // ★ 2026-11-05 批量写入沿用 参考诊断仪 写入确认族文案（逐项写同款确认语义，一次呈现）。
    const okBatch = confirm(
      '警告:请再次确认是否需要编此编码\n\n'
      + changes.slice(0, 8).map((c) => `· ${c.p.name} = ${decodeValue(c.p, c.newVal)}`).join('\n')
      + (changes.length > 8 ? `\n…等 ${changes.length} 项` : '')
      + '\n\n请确认信息后写入新编码值。');
    if (!okBatch) return;
    showLoading('批量写入中…', `${changes.length} 个变更`);
    let ok = 0, fail = 0;
    const failWhy = [];
    for (const { p, newVal } of changes) {
      try {
        const result = await coder.applyChange(p, newVal, { dryRun: false, session: 0x89, secLevel: 0x09 });
        p.currentValue = extractField(result.readback, p);
        if (p.lid != null) invalidateBlock(p.lid);   // 块缓存失效
        ok++;
      } catch (e) {
        fail++;
        // ⚠️ 失败原因必须留下来（2026-10-18 审计）：此前 `catch {}` 空吞，
        //    用户只看到「成功 3 / 失败 2」，不知道哪一项为什么失败、要不要重试。
        failWhy.push(`${p.name}：${e.message}`);
        log(`  ❌ ${p.name} 写入失败：${e.message}`, 'err');
      }
    }
    hideLoading();
    if (fail) alert(`批量写入：成功 ${ok} / 失败 ${fail}\n\n${failWhy.slice(0, 12).join('\n\n')}`);
    // ⚠️ 批量写入本身与「每次只改一项」的项目红线有张力：失败项之后的项会继续写，
    //    且中途失败时车上是**部分变更**状态。保留功能但明确告知（2026-10-18 审计）。
    toast(fail ? 'warn' : 'ok', '批量写入完成', `成功 ${ok} / 失败 ${fail}`);
    showRuleBatchEdit(title, items); // 刷新显示新值
  };
}


async function readBlocksForItems(items) {
  const targets = new Map();
  for (const p of items) {
    if (p.lid == null || cachedBlock(items, p) !== undefined) continue;
    const sid = blockReadSidOf(items, p);
    if (sid == null) continue;
    targets.set(blockKey(sid, p.lid), { lid: p.lid, sid });
  }
  if (!targets.size) return;
  showLoading('正在读取数据', `${targets.size} 个编码块`);
  const failed = [];
  for (const { lid, sid } of targets.values()) {
    try {
      cacheBlock(sid, lid, await coder.readBlock(lid, sid));
    } catch (e) {
      failed.push({ lid, sid, error: e.message });
    }
    updateLoading('正在读取数据', `SID 0x${sid.toString(16)} · LID 0x${lid.toString(16)}`);
  }
  for (const p of items) {
    const block = cachedBlock(items, p);
    if (block) {
      try { p.currentValue = extractField(block, p); } catch { p.currentValue = undefined; }
    }
  }
  hideLoading();
  if (failed.length) {
    toast('warn', `${failed.length}/${targets.size} 个编码块读取失败`,
      failed.slice(0, 3).map((f) => `SID 0x${f.sid.toString(16)} LID 0x${f.lid.toString(16)}: ${f.error}`).join('；'));
  }
}


/** 退出模块：回到系统列表（参考诊断仪的做法是断开模块会话） */
function exitSystem() {
  const name = coder?.ecuName || '模块';
  if (coder) {
    // 10 03 = 回默认会话；KWP 模块明确拒这个子功能（实车 7F 10 12）→ 不发，省一帧与一条 NRC。
    if (coder.family !== 'kwp') {
      // ★ 2026-11-11 审计 P2 修复：旧写法 `try { coder.uds(...) } catch {}` 缺 await，
      //   Promise 异常变成未处理拒绝（catch 根本不起作用）。本函数是同步的 → 用 .catch 链。
      coder.uds('1003', 2000, { allowEmpty: true })
        .catch((e) => log(`  (退出会话 10 03 未确认：${e.message})`, 'warn'));
    }
  }
  currentBlocks = {};
  currentParam = null;
  state.currentAddr = null;
  $('secParam').style.display = 'none';
  toast('info', `已退出 ${name}`, '回到系统列表');
}

let currentBlocks = {};

// 同 LID 可由不同服务读取（21/22/1A 的命名空间不同），缓存必须按 (readSid,lid) 隔离。
const blockKey = (readSid, lid) => `${Number(readSid).toString(16)}:${Number(lid).toString(16)}`;
function cachedBlock(items, p) {
  if (!p || p.lid == null) return undefined;
  const sid = blockReadSidOf(items, p);
  return sid == null ? undefined : currentBlocks[blockKey(sid, p.lid)];
}
function cacheBlock(readSid, lid, block) {
  currentBlocks[blockKey(readSid, lid)] = block;
}
function invalidateBlock(lid) {
  if (lid == null) return;
  const suffix = `:${Number(lid).toString(16)}`;
  for (const k of Object.keys(currentBlocks)) if (k.endsWith(suffix)) delete currentBlocks[k];
}

/** 参考诊断仪 完整命令序列（function-sequences.json，特殊功能页加载后填充） */
let fnSeqData = null;

/**
 * 进模块：切地址 → 进会话 → 编码块按需读（打开参数/点读取时才读）。
 */
/**
 * 探测命中识别串是否像目标系统（自动确认用，2026-11-04）。
 * 匹配 label / 模块名的词元；命中 → 自动接受探测地址，免二次询问。
 */
function identMatchesSys(ident, sys) {
  const t = String(ident || '').toUpperCase();
  if (!t) return false;
  const keys = new Set();
  const add = (s) => String(s || '')
    .split(/[^\w一-龥]+/)
    .filter((x) => x.length >= 2)
    .forEach((x) => keys.add(x.toUpperCase()));
  add(sys.label);
  (sys.modules || []).forEach(add);
  for (const k of keys) if (t.includes(k)) return true;
  return false;
}

async function enterSystem(sys) {
  if (!needLink()) return false;
  // ★ 模拟模式：mock 回出候选模块的默认变体识别串 —— 对齐真车 ODX 识别链，
  //   自动识别变体、进模块不弹选择（对齐 参考诊断仪 体感，2026-11-04）。
  // 本模块的目录变体名（模拟识别串 + 变体匹配选行共用，2026-11-05）
  const cat0 = modelsCatalog?.models?.[currentModel];
  const modRecs = (sys.modules || [])
    .map((mod) => (cat0?.modules || []).find((m) => m.module === mod))
    .filter(Boolean);
  const varNames = [...new Set(modRecs.map((mi) => autoPickVariant(mi, '').name))].filter(Boolean);
  if (simMode && simMock) {
    if (varNames.length) {
      simMock.identText = varNames.join(' ');
      // ★ 模拟车识别目标 = 与真车同源的候选序（2026-11-10 改）：
      //   bind-plan（本模块诊断段）→ 与 probeAddressFor 同一条数据；不再用全库族并集。
      const entrySim = addrEntryFor(sys.label, sys);
      const planSim = bindPlanFor(entrySim?.sysId);
      const listSim = (planSim && planSim.cands && planSim.cands.length)
        ? planSim.cands.map((t) => ({ tx: parseInt(t, 16) }))
        : probeList(entrySim, [], variantMatchedInternals(sys.label, null, varNames));
      simMock.identTextTx = listSim.length
        ? listSim[0].tx
        : (coder && coder.tx != null ? coder.tx : null);
      if (simMock.identTextTx != null) {
        log(`  · 模拟车识别目标 = 0x${simMock.identTextTx.toString(16).toUpperCase()}`
          + `（候选 ${listSim.length} 个，bind-plan 同源）`, 'info');
      }
    }
  }
  state.currentAddr = null;   // 进模块失败时不能沿用上一个模块的地址证据
  let addr = addrFor(sys.label, currentModel, sys);
  // ★ table-unique 直进（文档 §5 第二级），**必须在探测之前**：
  //   2026-11-04 真机事故——旧顺序先探测/兜底再查表唯一，被污染的 v4 表唯一候选
  //   （IC→0x746 脏行）抢跑直进全灭。v5 表已结构化 + 共享唯一降级，唯一才可信。
  if (!addr || addr.tx == null || addr.state === 'candidate' || addr.state === 'needs-probe') {
    const uniq = addrTableUnique(sys.label, sys);
    if (uniq) {
      addr = { ...uniq, state: 'table', note: '表唯一候选（免探测）' };
    }
  }
  // ★ 终审③⑤（2026-11-05）：新鲜解析（无缓存/无手工兜底）；探测命中=文本匹配**静默采纳**
  //   （参考诊断仪 进模块无确认弹窗，TEXT_CN UI 文本库实证）；解析失败=物理下限终态（通讯失败）。
  const entry0 = addrEntryFor(sys.label, sys);
  const hasShortlist = (entry0?.cands || []).length + (entry0?.candsAux || []).length > 1;
  const needProbe = !addr || addr.tx == null || addr.rx == null
    || (addr.state === 'candidate' && hasShortlist);
  if (needProbe) {
    {
      // ★ 2026-11-07 治本：模拟模式不再给占位地址（占位会跳过探测路径，
      //   真车探测 bug 测不出来——上轮漏检根因）。模拟车按真车拓扑走同一条探测。
      log(`  ${sys.label} 候选解析：按模块记录绑定（n=0 直绑 / n>0 单帧 22 14 09）…`, 'info');
      // 首次进模块也要先加载家族统计，再决定探针族，不能首趟 null、次趟才正确。
      await ensureModuleFamily();
      const enterFamily0 = familyFor(sys.label, null, { modules: sys.modules });
      const probed = await probeAddressFor(sys.label, addr?.probeCmd, {
        variantNames: varNames, modRecords: modRecs, modules: sys.modules, sys,
        family: enterFamily0,
        otherLabels: (modelsCatalog?.models?.[currentModel]?.modules || []).map((m) => m.module),
      });
      if (probed) {
        addr = { ...probed, state: 'probed',
          note: probed.confidence === 'bound'
            ? (probed.ident ? `单帧绑定（回帧含识别串「${String(probed.ident).slice(0, 16)}」）` : '单帧绑定（n=0 直绑，回帧来自该地址）')
            : '识别串匹配命中（静默采纳，NRC/无名应答不算候选）' };
        log(`  ✅ ${sys.label} → 0x${probed.tx.toString(16).toUpperCase()}/0x${probed.rx.toString(16).toUpperCase()}`
          + (probed.ident ? `（识别串「${probed.ident}」）` : ''), 'ok');
      } else {
        // ★ 物理下限终态（对齐 参考诊断仪「通讯失败」文案族，TEXT_CN 实证）：无地址无通道，不手工救
        hideLoading();
        toast('err', `${sys.label} 通讯失败`,
          '1. 请检查车辆电压是否在合理范围内；2. 请检查VCI与设备连接是否正常；3. 请确认该模块是否在车上');
        return false;
      }
    }
  }
  // ★ table-unique 已提前到探测之前判定（2026-11-05），这里不再重复
  state.currentAddr = addr;
  showLoading(`正在进入 ${sys.label}`, `地址 0x${addr.tx.toString(16).toUpperCase()}/0x${addr.rx.toString(16).toUpperCase()} · 建立会话中…`);
  // ⚠️⚠️ 从这里到函数末尾**整段 try/finally**：loading 必然被关掉。
  //    2026-10-17 实测「进模块一直转圈」—— 中间任何一处抛未捕获异常，
  //    hideLoading 就不执行，转圈永远停不下来。别再靠「每条错误路径手写 hideLoading」。
  try {
  // ⚠️ 候选地址（未实测）日志告知（2026-11-05 口径：无弹窗，进模块后识别串核验兜底）：
  if (addr.state === 'candidate') {
    log(`  ${sys.label} 地址 0x${addr.tx.toString(16).toUpperCase()}/0x${addr.rx.toString(16).toUpperCase()}（标准顺序；进模块后核验）`, 'info');
  }
  // ★ 2026-10-29 审计 P0-2：setAddress 内部已下发 ATSP/ATSH/ATCRA，必须 await。
  //   此前只改属性，紧接着的 1A9F 还打在上一个模块/探测遗留地址上。
  // ★ 会话流家族（任务清单⑤）：KWP=10 89 直接建会话（不发 10 03）；UDS=10 03 流。
  //   ⚠️ 2026-11-10：先确保模块记录统计已加载 —— 否则首次进模块 family 恒 null，
  //   UDS 模块会被当成「族未证」直接发 10 89（跳过 10 03），会话可能建不上。
  await ensureModuleFamily();
  const enterFamily = familyFor(sys.label, addr.tx, { modules: sys.modules });
  await coder.setAddress(addr.tx, addr.rx, sys.label, { family: enterFamily });
  coder.hasModuleAddress = true;  // 自动搜索不得把此地址误当成车辆身份读取地址
  coder.modelLabel = currentModel || null;   // 备份归属：防止跨车型恢复
  coder.diagProfile = simMode
    ? { verified: true, reason: '模拟模式（不触碰真车）' }
    : writeProfileFor(sys, currentModel, addr, enterFamily);
  // ★ 身份验证（终审④⑤：无 P200 启发式、无缓存比对）：读 1A9F 做运行时文本匹配
  //   （名字注册表原语，GetSubSysDataAddr 同款）；命中→提升 verified；不命中→保持现状。
  {
    let dsn = '';
    try {
      // 识别帧按族选：KWP=1A 9F（5A xx）、UDS=22 F1 A2（62 F1 A2）——
      // 2026-11-10：此前固定发 1A9F，UDS 模块（43/47）必然「未返回 1A9F」，身份永远验不了。
      const identCmd = enterFamily === 'kwp' ? '1A9F' : '22F1A2';
      const r = await coder.uds(identCmd, 3000, { allowEmpty: true });
      const b = Array.from(r.body || []);
      const payload = b[0] === 0x5a ? b.slice(2) : (b[0] === 0x62 ? b.slice(3) : b);
      dsn = payload.filter((c) => c >= 0x20 && c < 0x7f)
        .map((c) => String.fromCharCode(c)).join('').trim();
      if (dsn) {
        // setAddress 已清除上一模块证据；预识别命中的当前模块文本立即入账，
        // 供后面的 seed/key 名字分派使用，不能继续读旧 lastIdent。
        coder.identByCmd[identCmd] = dsn;
        coder.lastIdent = dsn;
      }
    } catch { /* 不致命 */ }
    if (dsn && identTextMatch(dsn, sys.label, varNames, modRecs, sys.modules)) {
      log(`  ✅ 身份文本匹配（识别串「${dsn.slice(0, 24)}」）`, 'ok');
      state.currentAddr = { ...addr, state: 'verified', note: '身份文本匹配' };
    } else if (dsn) {
      log(`  · 识别串「${dsn.slice(0, 24)}」未匹配名字注册表，地址证据保持 ${addr.state || 'candidate'}`, 'warn');
    } else {
      log(`  · 该模块未返回识别帧（${identCmd}），地址证据保持 ${addr.state || 'candidate'}`, 'warn');
    }
  }
  // ⚠️ 换模块必须重选 seed/key 变体（2026-10-17 审计 D1）：
  //    此前只在连接时选一次，换 ECU 后仍是旧变体 → 算错 key → NRC 0x35 → 可能锁死。
  try {
    // ⚠️ 优先走 原厂的 mode 表（securityModel），这是「和 参考诊断仪 对齐」的正解。
    //    拿不到 mode 才退回按 ECU 名猜变体（旧路径）。
    // ⚠️⚠️ 这里**绝不能阻塞**：2026-10-17 装机后实测「进模块一直转圈」，
    //    根因就是这段 `await fetch(...)` 在同步流程里 —— fetch 不 resolve 就永远 await，
    //    showLoading 的转圈停不下来。改成**限时 + 失败立刻回落旧路径**。
    let mode = null, lid = null, fam = null, hit = null;
    if (drivelinks === undefined) drivelinks = null;   // 允许 null 表示「加载过但没有」
    if (!drivelinks) {
      try {
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 1500) : null;
        const r = await fetch('data/drivelinks.json', ctl ? { signal: ctl.signal } : {});
        if (timer) clearTimeout(timer);
        drivelinks = r.ok ? await r.json() : null;
      } catch (e) {
        drivelinks = null;   // 拿不到就退回旧路径，绝不卡住
      }
    }
    // 模块记录家族统计（任务清单⑤ 信号②），限时加载，失败不阻塞
    await ensureModuleFamily();
    // 2026-10-19：RE 实证 ECU 寻址表（sysId → tx/rx），限时加载，失败不阻塞
    if (ecuAddrTable === undefined) ecuAddrTable = null;
    if (!ecuAddrTable) {
      try {
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 1500) : null;
        const r = await fetch('data/ecu-addresses.json', ctl ? { signal: ctl.signal } : {});
        if (timer) clearTimeout(timer);
        ecuAddrTable = r.ok ? await r.json() : null;
      } catch (e) {
        ecuAddrTable = null;
      }
    }
    try {
      // ⚠️ 2026-10-18 审计：这条路径**此前永远走不到**。
      //    原实现拿 `sys.label`（形如「ECM/DME(发动机控制模块)」）去匹配 `0x([0-9a-f]{3,4})`
      //    —— 中文标签里没有 hex，mode 恒为 null，于是号称「正解」的原厂mode 表
      //    一次都没用过，全部落回按名字猜变体。
      //    现在：① 优先用 `sys.ecu`（树里本就有这个字段，当前数据为 null）
      //          ② 再看 label 里的 hex
      //          ③ 都没有 → 走「模块名 → ECU_ID」映射表（目前源数据未提供，留空）
      //    拿不到 ECU_ID 时必须**明说**，别再假装走了 mode 表。
      const ecuKeyFrom = (raw) => {
        if (raw == null) return null;
        if (typeof raw === 'number') return '0x' + raw.toString(16).padStart(4, '0');
        const m = String(raw).match(/0x([0-9a-fA-F]{3,4})/);
        return m ? '0x' + m[1].toLowerCase().padStart(4, '0') : null;
      };
      for (const src of [sys.ecu, sysIdForLabel(sys.label), sys.label, ...(sys.modules || []).map((m) => sysIdForMod(m))]) {
        const k = ecuKeyFrom(src);
        if (k && drivelinks?.ecu?.[k]?.length) { hit = drivelinks.ecu[k]; break; }
      }
      // ★ 2026-11-09 mode 收口：mode 真值 = 条目所指**记录** u32 复合的低字节
      //   （SendSysSeedKey→Xml_GetDriveLinksAddress 逐指令实证：条目 6B=[u16 blockKey]
      //   [u32 recOff]，记录复合 u32@rec+0 落 TOKEN+0x360950 → PorscheKeySendCmd 低字节
      //   = PORSCHESecurityModel 的 mode）。旧 `hit[0].m` 是**记录偏移低字节**（垃圾 mode，
      //   算错 key → NRC 0x35），已改名 recOffsetLo 防再误用。行选择 hit[0] = 块首行键，
      //   与 参考诊断仪 GetSubSysDataAddr 未命中回落「组首行键」同构。
      if (hit && hit.length) {
        mode = hit[0].mode;            // rec[0]（记录复合低字节）；越界记录为 null
        lid = hit[0].session ?? null;  // 会话字（复合 u32>>16，参考诊断仪 securityModel param_1）
        fam = hit[0].family ?? null;   // 命令模板族（复合第 2 字节）
      }
      else if (drivelinks) {
        log(`  （DRIVELINKS 已加载 ${Object.keys(drivelinks.ecu).length} 个 ECU，` +
            `但「${sys.label}」没有 ECU_ID —— 缺 module→ECU_ID 映射，退回按名字选变体）`, 'warn');
      }
    } catch (e) { /* 解析失败退回旧路径 */ }

    // ⚠️ 2026-11-10 B2：drivelinks 的 mode 字段实测是**块头/字符串字节**（0x2A/0x26/0x22…
    //   全是 ASCII），不是 securityModel mode；而 resolveKey 对任意字节都会命中某个算法
    //   （0x2A→ADD、0x26→NOT_MULADD…）→ 会算出**错 key** 并发送（NRC 0x35，重试可能吃 0x36）。
    //   因此只有显式标注 modeVerified 的条目才走 mode 路径，其余回落名字分发。
    if (mode != null && hit && hit[0] && hit[0].modeVerified === true) {
      // 预检：mode 的算法在不在（不真算）。没逆出来的 mode 立刻降级成「只读」，
      // 别等到用户按写入才报错（日志里也不该显示成 ok）。
      let modeOk = true, modeWhy = '';
      try { resolveKey(mode, 0x12345678, { ecuId: null }); } catch (e) { modeOk = false; modeWhy = e.message; }
      if (modeOk) {
        coder.seedKeyProvider = makeResolverProvider(mode, { ecuId: null, name: sys.label });
        log(`  seed/key：原厂mode 0x${mode.toString(16).padStart(2, '0')}` +
            (fam != null ? ` · 模板族 0x${fam.toString(16).padStart(2, '0')}` : '') +
            (lid != null ? ` · 会话 0x${lid.toString(16).padStart(4, '0')}` : '') + '（照抄 securityModel）', 'ok');
      } else {
        // ★ 2026-11-05 对齐 参考诊断仪：mode 分支算不出（如 0x1d 运行时态）**不锁只读** ——
        //   回落名字分发（dlsym 同款：ECU 标识串 → ASAP1A 变体符号）。参考诊断仪 对这类模块
        //   就是按名字动态取算法的（`ASAP1A_CCP_ComputeKeyFromSeed_<ECU>` 符号族实证）。
        log(`  ⚠ mode 0x${mode.toString(16)} 无内联算法（${modeWhy}）—— 回落名字分发`, 'warn');
      }
    }
    if (!coder.seedKeyProvider) {
      // ⚠️ 优先走 原厂的 `nameTable` 名字表（138 条，权威），
      //    这是「和 参考诊断仪 对齐」的正解；查不到才退回旧的 pickVariant 别名表。
      const cands = [sys.label, ...(sys.modules || [])];
      let variant = null, hitName = null;
      // ⓪ 非 ASAP1A 入口先试。
      //    ① 精确函数名（如 'SecurityAccess_9x7_ALLRAD'）
      //    ② **平台限定**模块名 —— `BV_SteerAssisUDS` 跨 5 个平台，
      //       不带平台会把 E3/G2 也用上 992 的算法 → 算错 key → 0x36 锁死。
      const plat = platformForModel(currentModel);
      let naEntry = null, naKey = null;
      for (const c of cands) {
        naEntry = nonAsapForName(c);
        if (naEntry) { naKey = c; break; }
      }
      if (!naEntry) {
        for (const c of cands) {
          naEntry = nonAsapForModule(plat, c);
          if (naEntry) { naKey = c; break; }
        }
      }
      if (naEntry) {
        try {
          const ctx = { platform: plat, module: naKey };
          const chk = resolveKeyByName(naKey, null, ctx);   // 预检：算法在不在
          coder.seedKeyProvider = {
            name: `nonasap:${naEntry.algo}`,
            verified: true,
            calc(seedBytes, _lv) { return resolveKeyByName(naKey, seedBytes, ctx).key; },
          };
          log(`  seed/key：非 ASAP1A「${naKey}」${plat ? `（${plat}）` : ''}→ ${chk.algo}`, 'ok');
        } catch (e) {
          coder.seedKeyProvider = null;
          log(`  ⚠ 「${naKey}」的非 ASAP1A 算法未就绪：${e.message}`, 'warn');
        }
      } else {
      for (const c of cands) {
        variant = variantForName(c);
        if (variant) { hitName = c; break; }
      }
      if (!variant) {
        // ★ 2026-11-05 dlsym 同款：识别串 token **精确**对符号后缀
        //   `ASAP1A_CCP_ComputeKeyFromSeed_<token>`（参考诊断仪 就是按符号名动态取算法的）。
        //   只做精确键查找，不做模糊包含 —— 防短 token 误配到 MODE1 之类变体算错 key。
        for (const tok of String(coder.lastIdent || '').split(/[^A-Za-z0-9_]+/)) {
          if (tok.length < 3) continue;
          const sym = `ASAP1A_CCP_ComputeKeyFromSeed_${tok}`;
          if (NAME_TO_VARIANT[sym]) { variant = NAME_TO_VARIANT[sym]; hitName = sym; break; }
        }
      }
      if (variant) {
        // 用名字映射直接算，绕过 mode
        // ⚠️ 先做**存在性预检**（seed=null）：变体没实现时在这里就降级成「只读」，
        //    而不是等到用户按写入才抛异常。此前无条件记 ok，日志会骗人。
        let naOk = true, naWhy = '';
        try { resolveKeyByName(hitName, null); } catch (e) { naOk = false; naWhy = e.message; }
        coder.seedKeyProvider = naOk ? {
          name: `asap:${String(variant).slice(0, 16)}`,
          verified: true,
          calc(seedBytes, _lv) {
            // ⚠️ 直接传 **原始 seed 字节**：非 ASAP1A 的 seedLen 可能是 2，
            //    压成 32 位再解回来会丢字节（2026-10-17 踩过）。
            return resolveKeyByName(hitName, seedBytes).key;
          },
        } : null;
        if (naOk) log(`  seed/key：名字「${hitName}」→ 变体 ${String(variant).slice(0, 16)}（原厂权威表）`, 'ok');
        else log(`  ⚠ 「${hitName}」的变体 ${String(variant).slice(0, 16)} 尚未逆出：${naWhy} —— 只读`, 'warn');
      } else {
        const v = pickVariant(sys.label) || (sys.modules || []).map((m) => pickVariant(m)).find(Boolean) || null;
        coder.seedKeyProvider = v ? makeProvider(v) : null;
        if (v) log(`  seed/key 变体：${v.variant}${v.verified ? '' : '（未逐位验证，写入需先 校验 校验）'}`, v.verified ? 'ok' : 'warn');
        else log(`  ⚠ 「${sys.label}」不在 原厂名字表（${Object.keys(NAME_TO_VARIANT).length} 条）也无别名 —— 只读，写入会被拒`, 'warn');
      }
      }
    }
  } catch (e) {
    // 选变体失败不阻断进模块（只读仍可用）；写入时 canWrite 会再拦一次。
    // ⚠️ 这里必须兜住，否则异常会让 showLoading 的转圈永远停不下来。
    coder.seedKeyProvider = null;
    log(`  ⚠ seed/key 选择异常，已回落到无算法（只读可用）：${e.message}`, 'warn');
  }
  // ★ 2026-11-05 会话定案（有据）。★ 2026-11-11 注释收口：
  //   原厂序列 = 10 03 → 3E/识别 → 10 89 → 读写（GAG 真机序列取证）。
  //   **会话号实现为固定 `0x89`（SESSION_FOR_SERVICE.coding）** —— 抓包 10 89×6 是绝对
  //   主模板，KWP 流直接建、UDS 流在 10 03/识别后建。旧注释称「会话字节=每 ECU ODX XML
  //   SESSIONS 数据驱动」，但 ODX SESSIONS 不在提取包内、drivelinks 的 securityModel
  //   param_1（u32>>16）语义未证 → **不用于发帧**（避免发错会话号）。此处如实标注为
  //   「固定主会话模板 + 数据缺口」，不再声称数据驱动。
  //   构帧/发送方逐指令零「失败换会话」分支（PorscheSetEnterFrameInit 模板单发）——
  //   原「10 89 失败回退 10 03」是自创恢复，已删。
  //   两步是**序列步**（非重试）：各自尽力而为（NRC 容忍=序列取证行为）；写路径
  //   applyChange 仍硬要求 10 89（失败即报错）；两步都无应答=物理下限报错。
  // ★ 会话流（任务清单⑤ / RE-FLOWSPEC §1.3·§7）：一次 enterSession 完成整条流 ——
  //   KWP 流 = `10 89` 直接建会话（不发 10 03 —— 实车 `7F 10 12` 断点修）；
  //   UDS 流 = `10 03`→保活→识别→`10 89`（序列步，非重试）；家族未证=抓包序容错。
  let sessDead = 0;
  try {
    await coder.enterSession(0x89, { family: enterFamily });
  } catch (e) {
    if (/无应答|NO DATA/i.test(String(e.message))) sessDead++;
    log(`  (会话未建成：${e.message} —— ${sessDead ? '通讯失败' : '序列继续'})`, 'warn');
  }
  if (sessDead) {
    hideLoading();
    toast('err', `${sys.label} 通讯失败`, '1.车辆电压 2.VCI连接 3.固件/线路');
    return false;
  }

  // ★ 2026-10-31：只加载“当前选中的变体模块”，不再把 sys.modules 里所有候选模块/
  //   所有变体拼在一起读。参考诊断仪的做法是：识别到哪个变体，就只读这个变体的全部编码块。
  const cat = modelsCatalog?.models?.[currentModel];
  const entries = (sys.modules || [])
    .map((mod) => ({ mod, mi: (cat?.modules || []).find((m) => m.module === mod) }))
    .filter((e) => e.mi);
  if (!entries.length) {
    log(`  ${sys.label} 没有可加载的模块数据`, 'warn');
  }
  // 已有用户/自动选择 → 只认这个模块；否则按车辆证据分派（★ 2026-11-09 选择层，
  // RE-TRACEABILITY-20261109.md）：①识别串（DSN.BIN 注册表）②件号（JOB.BIN 会话库）
  // ③协议族 KWP/UDS 兜底 —— 家族选错则记录 SID 族错（22 00xx 全灭事故根因），此层优先。
  let active = entries.find((e) => state.selectedVariant[e.mod]) || null;
  let familyPick = null;
  if (!active && entries.length) {
    const reg = await ensureIdentRegistry();
    const pm = await ensureEcuPartMap();
    await ensureModuleFamily();
    const identTokens = [];
    for (const t of [coder.identByCmd?.['1A9F'], coder.identByCmd?.['22F1A2'], coder.lastIdent]) {
      for (const w of String(t || '').split(/[^A-Za-z0-9一-龥]+/).filter(Boolean)) {
        if (!identTokens.includes(w)) identTokens.push(w);
      }
    }
    familyPick = pickFamilyByEvidence(entries, {
      identTokens,
      partNo: coder.lastPartNo,
      partTokens: coder.lastPartTokens,
      registry: reg,
      byPart: pm?.byPart,
      moduleFamily,
      observedFamily: enterFamily,
      // ★ 2026-11-11 审计 P1-5：补传平台 —— 否则 variant.js:228 的平台过滤退化为
      //   `h.platform === h.platform` 恒真，跨平台同件号记录不会被收窄（E3/G2 误用 992 变体）。
      platform: platformForModel(currentModel),
    });
    active = entries.find((e) => e.mod === familyPick.mod) || null;
    if (familyPick.evidence.length) log(`  🔎 家族证据：${familyPick.evidence.join('；')}`, 'info');
    log(`  📦 数据家族分派 → ${familyPick.mod}${familyPick.variant ? ` · 变体 ${familyPick.variant}` : ''}（${familyPick.how}）`, active ? 'ok' : 'warn');
    if (familyPick.variant) state.selectedVariant[familyPick.mod] = familyPick.variant;
  }
  if (!active) {
    const recognized = [];
    for (const e of entries) {
      const a = autoPickVariant(e.mi, coder.lastIdent);
      if (!/未识别|无识别文本/.test(a.how)) recognized.push({ ...e, auto: a });
    }
    if (recognized.length > 1) {
      log(`  ${sys.label} 有 ${recognized.length} 个候选模块命中识别串，按第一个加载：${recognized[0].mod}`, 'warn');
    }
    active = recognized[0] || entries[0] || null;
  }
  let items = [];
  let activeMod = '', activeMi = null;   // 变体落定用（2026-11-04 提升作用域）
  state.multiVariantModules.clear();
  if (active) {
    const { mod, mi } = active;
    activeMod = mod; activeMi = mi;
    const catMods = mi.variants || [];
    if (catMods.length > 1) {
      state.multiVariantModules.add(mod);
      if (state.selectedVariant[mod]) {
        log(`  🧩 ${mod} 使用已选变体：${state.selectedVariant[mod]}`, 'ok');
      } else {
        // ★ 2026-11-05 变体落定对齐 参考诊断仪：进模块读件号（1A 84）查 ODX 会话库
        //   「零件号→(模块,变体)」直接落定（JOB.BIN 实证一一对应），不弹窗、不靠装备词。
        //   零件号命中且唯一 → 用它；多候选 → 按首候选落定放行（回读校验兜底，不锁写）；
        //   无件号/查不到 → 回落识别串匹配（autoPickVariant）。
        let picked = null;
        if (coder.lastPartNo || coder.lastHwPart) {
          const pm = await ensureEcuPartMap();
          if (pm) {
            const names = catMods.map((v) => v.name || String(v.file || '').replace(/\.json$/i, ''));
            picked = pickVariantByPart(pm.byPart, pm.byHwPart, {
              partNumber: coder.lastPartNo, partTokens: coder.lastPartTokens,
              hwPartNo: coder.lastHwPart,
              swText: coder.lastSwNo, swTable: pm.bySw,
              module: mod, variants: names,
            });
          }
        }
        if (picked && !picked.ambiguous) {
          state.selectedVariant[mod] = picked.name;
          log(`  🧩 ${mod} 变体（零件号命中）：${picked.name}（${picked.how}，件号 ${coder.lastPartNo || coder.lastHwPart}）`, 'ok');
        } else {
          const auto = picked
            ? { name: picked.name, how: `零件号多候选（${picked.ambiguous.join(' / ')}）——按首候选落定` }
            : autoPickVariant(mi, coder.lastIdent);
          if (/未识别|无识别文本/.test(auto.how)) {
            // ★ 2026-11-05 对齐 参考诊断仪 写政策：变体不确定用标准默认（*_BaseSys 约定）
            //   落定并**放行写入**（备份→写→回读兜底），不再锁写 —— 参考诊断仪 从不因
            //   变体未定拒写。错映射风险由回读校验兜住（参考诊断仪 同样只有这道兜底）。
            const def = autoPickVariant(mi, '').name;
            state.selectedVariant[mod] = def;
            log(`  🧩 ${mod} 变体未识别（${auto.how}）—— 按默认变体 ${def} 落定（写入由回读校验兜底）`, 'warn');
          } else {
            state.selectedVariant[mod] = auto.name;
            log(`  🧩 ${mod} 变体自动：${auto.name}（${auto.how}）`, 'ok');
          }
        }
      }
    }
    const got = await loadModuleItems(currentModel, mod);
    items = got;
  }
  items = items.filter((p) => validateParam(p).length === 0 && p.lid != null);
  coding = items;

  // ★ 2026-10-31：只读当前变体的全部编码块（参考诊断仪的做法），不读其他变体/候选模块。
  const targetMap = new Map();
  for (const p of items) {
    const sid = blockReadSidOf(items, p);
    if (sid != null) targetMap.set(blockKey(sid, p.lid), { lid: p.lid, sid });
  }
  const lids = [...targetMap.values()];
  currentBlocks = {};
  let enterAbort = false;
  let readFail = 0;
  let readDone = 0;
  if (lids.length) {
    showLoading(`正在读取 ${sys.label}`, `0/${lids.length} 个编码块…`, () => { enterAbort = true; });
    for (const { lid, sid } of lids) {
      if (enterAbort) {
        log(`  · 已取消，剩余 ${lids.length - readDone} 个块未读`, 'warn');
        break;
      }
      readDone++;
      updateLoading(`正在读取 ${sys.label}`, `${readDone}/${lids.length} 个编码块…`,
        () => { enterAbort = true; });
      try {
        cacheBlock(sid, lid, await coder.readBlock(lid, sid));
      } catch (e) {
        readFail++;
        log(`  ❌ SID 0x${sid.toString(16)} LID 0x${lid.toString(16)} 读取失败：${e.message}`, 'err');
      }
    }
  }
  if (readFail === lids.length && lids.length > 0) {
    // ★ 2026-11-04：全挂还报「✅ 就绪」是假成功（实车日志 5/5 失败仍报就绪）
    toast('err', `${sys.label} 读码失败`,
      `${readFail}/${lids.length} 个编码块没读到 —— 当前值不可用，请核对地址/协议后再读`);
    log(`  ❌ ${sys.label}：${readFail}/${lids.length} 个编码块读取失败 —— 不视为就绪`, 'err');
  } else if (readFail) {
    toast('warn', `${readFail}/${lids.length} 个编码块读取失败`,
      '对应项当前值为空 —— 请检查连接/地址，或跑地址扫描确认 ECU 可达');
  }
  for (const p of items) {
    const block = cachedBlock(items, p);
    if (block) {
      try { p.currentValue = extractField(block, p); } catch { p.currentValue = undefined; }
    }
  }
  // ★ 变体落定（2026-11-04）：名字匹配之后，用实测块做确定性确认。
  //   同构 → 默认变体即可（映射全同）；异构 → 唯一满足全部值域/枚举者才认；
  //   歧义/不适配 → 保持未确认（写入闸门 = 文档 §5「宁可拒写不猜」）。
  const mod = activeMod, mi = activeMi;
  if (mod && state.multiVariantModules?.has(mod) && !state.selectedVariant[mod]) {
    if (simMode) {
      state.selectedVariant[mod] = autoPickVariant(mi, '').name;
      log(`  🧩 ${mod} 模拟车免检落定：${state.selectedVariant[mod]}`, 'ok');
    } else if (await variantMapsIdentical(mod)) {
      state.selectedVariant[mod] = autoPickVariant(mi, '').name;
      log(`  🧩 ${mod} 各变体映射全同 —— 默认变体落定（读写一致）`, 'ok');
    } else {
      // ★ 2026-11-04 风险收口：约束拟合只做提示，**不解锁写入**（解锁仅认
      //   名字识别/映射全同两种零风险路径，其余一律宁可拒写 = 参考诊断仪 规格）。
      const fits = [];
      for (const v of (mi.variants || [])) {
        const vit = await loadVariantItems(cat.slug, v.file);
        if (vit.length && variantFitsBlocks(vit, currentBlocks)) fits.push(v.name);
      }
      // ★ 2026-11-05 对齐 参考诊断仪 写政策：约束拟合只做提示，**不锁写**。
      //   唯一拟合 → 直接落定；多/无拟合 → 默认变体落定，写入由回读校验兜底。
      if (fits.length === 1) {
        state.selectedVariant[mod] = fits[0];
        log(`  🧩 ${mod} 约束拟合落定：${fits[0]}`, 'ok');
      } else {
        const def = autoPickVariant(mi, '').name;
        state.selectedVariant[mod] = def;
        log(`  🧩 ${mod} 约束拟合 ${fits.length} 个 —— 按默认变体 ${def} 落定（写入由回读校验兜底）`, 'warn');
      }
    }
  }
  // ★ 2026-11-10：地址证据用**读成功**来升级 —— 参考诊断仪的「绑定成功」是链路层给的，
  //   我们等价的可观测事实是「进模块后整块都读出来了」。表唯一/候选态据此升为 verified，
  //   写入闸门才有真实依据（此前 'table' 直接可写，但 0x7F1 是 IC/BKE/EPB/PSM 共享的组地址）。
  if (readFail === 0 && lids.length && state.currentAddr) {
    state.currentAddr = { ...state.currentAddr, state: 'verified', note: '进模块后整块读取成功' };
  }
  hideLoading();
  if (readFail === 0) {
    toast('ok', `${sys.label} 就绪`, `${items.length} 个参数 / ${lids.length} 个编码块已读`);
  }
  return true;
  } catch (e) {
    // ⚠️ enterSystem **永不抛异常**，只返回 true/false。
    //    2026-10-17 实测：用 try/finally 时异常照样 reject，
    //    调用方 `enterSystem(...).then(ok => ...)` 没有 .catch() →
    //    转圈停了（finally 生效）但**不导航**，界面停在模块列表。
    //    这里 catch 掉返回 false，调用方才知道是失败。
    hideLoading();
    toast('err', `进入 ${sys?.label ?? '模块'} 失败`, e?.message || String(e));
    return false;
  } finally {
    hideLoading();   // 双保险：无论哪条路径，转圈一定停
  }
}




async function onSelect(it) {
  // ★ 2026-11-04：程序化导航（pushModel/confirm 收尾）后 500ms 内的点击一律吞掉。
  //   iOS 上 confirm() 的 OK 会把点击穿透进网页，砸中重绘后列表第一项
  //   （真机「自动搜索直跳快速测试」）。
  // ★ 只吞「程序化导航后 800ms 内到达且无 pointer 事件」的合成点击（ghost-click）；
  //   真点击带 pointerdown（≤300ms 前）一律放行——旧 500ms 全吞会吃掉用户/自动化的快速连点。
  if (Date.now() - _navLockTs < 800 && Date.now() - _lastPointerTs > 300) return;
  // ruleGroup: 规则编码分组点击
  if (it.kind === 'ruleGroup') {
    await readBlocksForItems(it.raw.items || []);
    stack.push({ level: 'ruleGroup', title: it.raw.name, data: it.raw });
    renderNav();
    return;
  }
  if (it.kind === 'ruleChain') {
    await readBlocksForItems(it.raw.items || []);
    stack.push({ level: 'ruleChain', title: it.raw.name, data: it.raw });
    renderNav();
    return;
  }
  // ruleSubgroup: 规则编码子组点击
  if (it.kind === 'ruleSubgroup') {
    await readBlocksForItems(it.raw.items || []);
    stack.push({ level: 'ruleSubgroup', title: it.raw.name, data: it.raw });
    renderNav();
    return;
  }
  // codop: 处理设码二级菜单操作
  if (it.kind === 'codop') {
    const op = it.raw;
    if (op.op === 'hidden' || op.op === 'noRuleCoding') {
      const allItems = op.allItems || [];
      const groups = {};
      for (const p of allItems) {
        const g = p.path?.[0] || '（未命名）';
        (groups[g] = groups[g] || []).push(p);
      }
      const groupItems = Object.entries(groups)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, items]) => {
          const isCurve = items.some((p) => /^[XY]\s*\d+$/.test(p.path?.[p.path.length - 1] || ''));
          return { kind: 'codgroup', raw: { name, items, isCurve }, lbl: name,
            meta: `${items.length} 个参数${isCurve ? ' · 特性曲线' : ''}`, cnt: items.length };
        });
      stack.push({ level: 'codgroup', title: `设码 · ${op.sysLabel}`, data: { groups: groupItems, allItems } });
      renderNav();
      return;
    }
    if (op.op === 'ruleCoding') { showRuleCoding(op.allItems || [], op.sysLabel); return; }
    if (op.op === 'backup') { await backupAllCoding(op.allItems || [], op.sysLabel); return; }
    if (op.op === 'restore') { await restoreCoding(op.sysLabel); return; }
    if (op.op === 'writeVer') { toast('info', '写版本信息', '此功能需要连接车辆后使用'); return; }
    return;
  }
  switch (it.kind) {
    case 'top':
      if (it.raw.kind === 'autosearch') { autoSearch(); return; }
      stack.push({ level: 'top', title: it.raw.id, data: it.raw });
      break;
    case 'onlineitem':
      stack.push({ level: 'onlineitem', title: it.raw, data: it.raw });
      break;
    case 'group': stack.push({ level: 'group', title: it.raw.label, data: it.raw }); break;
    case 'model': currentModel = it.raw.label; stack.push({ level: 'model', title: it.raw.label, data: it.raw }); break;
    case 'fn': stack.push({ level: 'fn', title: it.raw.id, data: it.raw }); break;
    case 'sys': {
      // 进模块：切地址 + 一次性读全部编码（对齐参考诊断仪）
      enterSystem(it.raw).then((ok) => {
        if (ok) { stack.push({ level: 'sys', title: it.raw.label, data: it.raw }); renderNav(); }
        else log(`  进入「${it.raw.label}」未完成 —— 留在当前页`, 'warn');
      }).catch((e) => {
        // 兜底：enterSystem 已保证不抛，这里只是双保险
        hideLoading();
        toast('err', `进入「${it.raw.label}」失败`, e?.message || String(e));
      });
      return;
    }
    case 'sysfn': stack.push({ level: 'sysfn', title: it.raw.id, data: it.raw }); break;
    case 'sysextra': {
      // 设码 → 按参考诊断仪 的多级菜单进：分组列表 → 子分组/条目 → 参数详情
      if (it.raw.kind === 'coding') {
        const allItems = coding || [];
        if (!allItems.length) {
          toast('warn', '无编码条目', '该模块未加载到编码数据');
          return;
        }
        // ★ 参考诊断仪 二级菜单：设码下有多种操作
        const sysLabel = it.raw._sys?.label || '';
        const submenuItems = [
          { kind: 'codop', raw: { op: 'backup', sysLabel, allItems }, lbl: '备份所有编码', meta: '读取全部编码块并保存', cnt: null },
          { kind: 'codop', raw: { op: 'writeVer', sysLabel }, lbl: '写版本信息', meta: '写入版本/识别信息', cnt: null },
          { kind: 'codop', raw: { op: 'ruleCoding', sysLabel, allItems }, lbl: '规则编码', meta: '批量查看和修改多个设码值', cnt: null },
          { kind: 'codop', raw: { op: 'noRuleCoding', sysLabel, allItems }, lbl: '无规则编码', meta: '直接逐项编辑', cnt: null },
          { kind: 'codop', raw: { op: 'hidden', sysLabel, allItems }, lbl: '刷隐藏/改装', meta: '搜索并修改单个设码项', cnt: allItems.length },
          { kind: 'codop', raw: { op: 'restore', sysLabel, allItems }, lbl: '读取备份编码', meta: '从备份恢复编码', cnt: null },
        ];
        stack.push({ level: 'codsubmenu', title: `设码 · ${sysLabel}`, data: { items: submenuItems, allItems, sysLabel } });
        renderNav();
        return;
      }
      // ★ 2026-11-06 用户指令：功能页与设码同款内层页导航（push 栈级替换主区），
      //   不再弹底部 secParam —— 数据流/版本信息/特殊功能/执行器 操作逻辑拉齐。
      stack.push({ level: 'sysx', title: it.raw.id || '功能', data: { f: it.raw } });
      renderNav();
      return;
    }
    case 'codgroup': {
      const g = it.raw;
      await readBlocksForItems(g.items || []);
      if (g.isCurve) {
        showCurveGroup(g);
        return;
      }
      // ★ 2026-11-07 二级页面全量对齐：有子分组 → 直接走 ruleGroup 页
      //   （族聚类行=组名+序 …0/…1 + 直接编码项行混排，无「直接条目」假分组）。
      //   此前这里自造 path[1] 分桶+（直接条目）页 = 用户实测差异的真源头。
      const hasSubgroups = g.items.some((p) => (p.path?.length || 0) >= 3);
      if (hasSubgroups) {
        stack.push({ level: 'ruleGroup', title: g.name,
          data: { name: g.name, items: g.items, sysLabel: g.sysLabel || '' } });
        renderNav();
        return;
      }
      // 无子分组 → 直接显示条目
      const items = g.items.map((p) => ({
        kind: 'param', raw: p,
        lbl: p.path?.length > 1 ? p.path[p.path.length - 1] : p.name,
        meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
        cnt: null,
      }));
      stack.push({ level: 'codelist', title: g.name, data: { items } });
      renderNav();
      return;
    }
    case 'codsubgroup': {
      const sg = it.raw;
      await readBlocksForItems(sg.items || []);
      // 检查是否有 4 级路径（L3 内还有子层，如 V1/V2）
      const hasL4 = sg.items.some((p) => (p.path?.length || 0) >= 4);
      if (hasL4) {
        // 按 path[2] 分组（保留 V1/V2 标识）
        const l4groups = {};
        for (const p of sg.items) {
          const l4 = (p.path?.length >= 4) ? p.path[2] : '（直接条目）';
          (l4groups[l4] = l4groups[l4] || []).push(p);
        }
        const l4Items = Object.entries(l4groups)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, items]) => ({
            kind: 'codl4group', raw: { name, items, parentPath: `${sg.parentGroup} > ${sg.name}` },
            lbl: name,
            meta: `${items.length} 个参数`,
            cnt: items.length,
          }));
        stack.push({ level: 'codl4group', title: `${sg.parentGroup} > ${sg.name}`, data: { groups: l4Items } });
        renderNav();
        return;
      }
      const items = sg.items.map((p) => ({
        kind: 'param', raw: p,
        lbl: p.path?.length > 2 ? p.path[p.path.length - 1] : p.name,
        meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
        cnt: null,
      }));
      stack.push({ level: 'codelist', title: `${sg.parentGroup} > ${sg.name}`, data: { items } });
      renderNav();
      return;
    }
    case 'codl4group': {
      const l4 = it.raw;
      await readBlocksForItems(l4.items || []);
      const items = l4.items.map((p) => ({
        kind: 'param', raw: p,
        lbl: p.path?.length > 3 ? p.path[p.path.length - 1] : p.name,
        meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
        cnt: null,
      }));
      stack.push({ level: 'codelist', title: l4.name, data: { items } });
      renderNav();
      return;
    }
    case 'param': {
      // 参数详情 → 独立页面（参考诊断仪的做法）
      stack.push({ level: 'paramdetail', title: it.raw.name, data: it.raw });
      renderNav();
      return;
    }
    case 'subgroup': stack.push({ level: 'subgroup', title: it.raw.name, data: it.raw }); break;
    case 'sub': showSub(it.raw); return;
    default: return;
  }
  $('secParam').style.display = 'none';
  renderNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pushModel(m) {
  // 自动搜索命中：直接压入该车型
  // ⚠️ 必须用**树里的真 model 对象**（带 functions/modules），不能用 VIN 码表 stub
  //    （stub 只有 {code,label}，fnItems(m) 会读 m.functions || [] → 0 项 → 进不了系统选择）。
  //    2026-10-17 审计 B1：自动搜索识别成功却走到死胡同。
  _navLockTs = Date.now();   // 短窗口吞掉弹窗穿透/重绘后的 ghost-click（2026-11-04）
  if (currentModel !== m.label) {
    state.selectedVariant = {};
    currentBlocks = {};
    liveMap = undefined;      // map 是按车型菜单白名单生成的，不能跨车型复用
    if (coder) {
      coder.modelLabel = m.label;
      coder.seedKeyProvider = null;
    }
  }
  currentModel = m.label;
  const g = (tree?.groups || []).find((x) => (x.models || []).some((y) => y.label === m.label));
  const real = g?.models?.find((y) => y.label === m.label) || m;
  stack = [{ level: 'top', title: '手动选择', data: tree?.topLevel?.find((x) => x.kind === 'manual') || {} }];
  if (g) stack.push({ level: 'group', title: g.label, data: g });
  stack.push({ level: 'model', title: m.label, data: real });
  renderNav();
}

$('searchIn').oninput = renderNav;

// ---------- 多维特性组（X/Y 曲线）----------
function showMultiGroup(g) {
  $('secParam').style.display = '';
  const axes = g.axes || {};
  const names = Object.keys(axes);
  const n = Math.max(...names.map((k) => axes[k].length), 0);
  let rows = '';
  for (let i = 0; i < n; i++) {
    const cells = names.map((k) => {
      const p = axes[k][i];
      return p ? `<td><button class="axisCell" data-id="${p.id}">${p.name}<br>
        <span class="meta">byte ${p.byte} · ${rangeHint(p)}</span></button></td>` : '<td></td>';
    }).join('');
    rows += `<tr>${cells}</tr>`;
  }
  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${g.name}<span class="tag">特性曲线</span></div>
      <div class="meta">共 ${names.join(' / ')} 各 ${n} 点。点任一格进入单项编辑。</div>
      <table class="axisTable"><thead><tr>${names.map((k) => `<th>${k} 值</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  $('paramBox').querySelectorAll('.axisCell').forEach((b) => {
    b.onclick = () => {
      const p = coding.find((x) => x.id === b.dataset.id);
      if (p) {
        stack.push({ level: 'paramdetail', title: p.name, data: p });
        renderNav();
      }
    };
  });
}

// ---------- 参数详情（独立页面） ----------
function renderParamDetail(p) {
  currentParam = p;
  // 进模块不再全量读；打开详情时按需读该 LID（只读一次，写完/读完都会缓存）。
  if (p?.lid != null && coder && cachedBlock(coding, p) === undefined) {
    setTimeout(() => { if (currentParam?.id === p.id) doRead(p); }, 0);
  }
  const ro = isReadOnlyItem(p);
  const en = p.enum ? Object.entries(p.enum) : [];
  const curVal = p.currentValue !== undefined ? decodeValue(p, p.currentValue) : null;

  // 枚举只显示人能看懂的文字
  let input = '';
  if (p.kind === 'switch' || p.kind === 'enum') {
    // 统一用下拉框，显示 enum 的实际值（参考诊断仪的做法）
    // ⚠️ enum key 是**十进制**字符串，不是 hex（见前面注释）
    // ⚠️ 必须按 currentValue 预选（2026-10-18 审计）：此前不设 selected，
    //    打开一个枚举/开关参数后直接点「写入」会写**第一个选项**（常常是 0/关），
    //    而不是当前值 —— 用户以为没改，实际把车改了。
    const opts = (en.length ? en : [[0, '关'], [1, '开']]);
    const cur = (p.currentValue == null) ? null : Number(p.currentValue);
    input = `<select id="pVal">${opts.map(([k, v]) =>
      `<option value="${Number(k)}" ${cur != null && Number(k) === cur ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    if (cur == null) input += `<div class="hint" style="color:#c0392b">当前值未读到 —— 下拉框默认是第一项，请先「读当前值」或确认目标值后再写入。</div>`;
  } else {
    // 宽字段（>53 位）用 text：HTML number input 会把 64 位值转成浮点/科学计数，
    // 提交时已经丢精度；text + inputmode=numeric 保留原始十进制串，交给 parseFieldInput 转 BigInt。
    const wide = (p.bitsize | 0) > 53;
    input = `<input id="pVal" type="${wide ? 'text' : 'number'}" inputmode="numeric"
        min="${p.min ?? 0}" max="${p.max ?? ''}" value="${p.currentValue ?? p.min ?? 0}">
      <div class="hint">验证状态：<b>${p.level || '—'}</b> · 可填范围：<b>${p.min ?? 0} … ${p.max ?? '?'}</b>
        （${p.bitsize} 位，共 ${(p.max - p.min + 1) || '?'} 个取值）</div>`;
  }

  $('navList').innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader">
        <div class="pdName">${p.name}${ro ? '<span class="tag ro">只读</span>' : ''}
          <span class="tag">${kindLabel(p)}</span></div>
        <div class="pdPath">${(p.path || []).join(' › ')}</div>
      </div>
      <div class="pdMeta">
        ${curVal !== null ? `<div class="pdRow pdCurrent"><span>当前值</span><span><b>${curVal}</b></span></div>` : ''}
        <div class="pdRow"><span>位置</span><span>byte ${p.byte} · bit ${p.bit} · 宽 ${p.bitsize}</span></div>
        <div class="pdRow"><span>服务</span><span>读 0x${(p.readSid ?? 0x21).toString(16).toUpperCase()} / 写 0x${(p.writeSid ?? 0x3B).toString(16).toUpperCase()} · LID 0x${(p.lid ?? 0).toString(16).toUpperCase()}</span></div>
        <div class="pdRow"><span>风险</span><span class="risk-${p.risk || 'low'}">${riskLabel(p.risk)}</span></div>
      </div>
      <label>目标值</label>
      ${input}
      <div class="acts">
        <button id="pRead">读当前值</button>
        <button id="pWrite" class="${ro ? '' : 'primary'}">写入</button>
      </div>
      <div class="hint">${ro ? readOnlyReason(p) : ''}</div>
    </div>`;

  $('pRead').onclick = () => doRead(p);
  $('pWrite').onclick = () => {
    if (ro) {
      toast('warn', `「${p.name}」是只读项`, readOnlyReason(p));
      return;
    }
    const raw = $('pVal')?.value ?? '0';
    const v = parseFieldInput(p, raw);
    if (v == null) {
      toast('err', '值无效', p.bitsize > 53 ? '请输入十进制或 0x 前缀的整数' : '请输入数字');
      return;
    }
    if (SAFETY.range && !fieldInRange(p, v)) {
      toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}（安全增强已开启）`);
      return;
    }
    doWrite(p, v);
  };
}

function showCurveGroup(g) {
  const items = g.items;
  const axisRe = /^([XYZ])\s*(\d+)$/;
  const axes = {};
  const others = [];
  for (const p of items) {
    const leaf = p.path?.[p.path.length - 1] || p.name;
    const m = leaf.match(axisRe);
    if (m) {
      (axes[m[1]] = axes[m[1]] || []).push(p);
    } else {
      others.push(p);
    }
  }
  for (const k of Object.keys(axes)) {
    axes[k].sort((a, b) => {
      const na = parseInt((a.path?.[a.path.length - 1] || '').match(/\d+/)?.[0] || '0');
      const nb = parseInt((b.path?.[b.path.length - 1] || '').match(/\d+/)?.[0] || '0');
      return na - nb;
    });
  }
  const axisKeys = Object.keys(axes).sort();
  const n = Math.max(...axisKeys.map((k) => axes[k].length), 0);

  // 构建曲线表
  let rows = '';
  for (let i = 0; i < n; i++) {
    const cells = axisKeys.map((k) => {
      const p = axes[k][i];
      return p ? `<td><button class="axisCell" data-id="${p.id}">
        <b>${p.path?.[p.path.length - 1] || p.name}</b>
        <span class="meta">byte ${p.byte} · ${rangeHint(p)}</span></button></td>` : '<td></td>';
    }).join('');
    rows += `<tr>${cells}</tr>`;
  }
  $('navList').innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader">
        <div class="pdName">${g.name}<span class="tag">特性曲线</span></div>
        <div class="pdPath">${axisKeys.join(' / ')} 各 ${n} 点</div>
      </div>
      <table class="axisTable"><thead><tr>${axisKeys.map((k) => `<th>${k} 值</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  $('navList').querySelectorAll('.axisCell').forEach((b) => {
    b.onclick = () => {
      const p = coding.find((x) => x.id === b.dataset.id);
      if (p) {
        stack.push({ level: 'paramdetail', title: p.name, data: p });
        renderNav();
      }
    };
  });
}

// ---------- 参数详情（旧版内嵌卡片，保留兼容） ----------
function showParam(p) {
  currentParam = p;
  $('secParam').style.display = '';
  const ro = isReadOnlyItem(p);
  const en = p.enum ? Object.entries(p.enum) : [];

  // 按 kind 给不同输入：开关 / 下拉 / 数字
  let input = '';
  if (p.kind === 'switch') {
    const on = p.currentValue === 1 || p.currentValue === '1';
    input = `<div class="switchRow">
      <button class="swBtn ${on ? '' : 'sel'}" data-v="0">关</button>
      <button class="swBtn ${on ? 'sel' : ''}" data-v="1">开</button>
    </div>`;
  } else if (p.kind === 'enum') {
    const cur = (p.currentValue == null) ? null : Number(p.currentValue);
    input = `<select id="pVal">${en.map(([k, v]) =>
      `<option value="${Number(k)}" ${cur != null && Number(k) === cur ? 'selected' : ''}>${k} = ${v}</option>`).join('')}</select>`;
  } else {
    const wide = (p.bitsize | 0) > 53;
    input = `<input id="pVal" type="${wide ? 'text' : 'number'}" inputmode="numeric"
        min="${p.min ?? 0}" max="${p.max ?? ''}" value="${p.currentValue ?? p.min ?? 0}">
      <div class="hint">验证状态：<b>${p.level || '—'}</b> · 可填范围：<b>${p.min ?? 0} … ${p.max ?? '?'}</b>
        （${p.bitsize} 位，共 ${(p.max - p.min + 1) || '?'} 个取值）</div>`;
  }
  const enHtml = en.length ? `<br>枚举：<br>${en.map(([k, v]) => `${k} = ${v}`).join('<br>')}` : '';

  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${p.name}${ro ? '<span class="tag ro">只读</span>' : ''}
        <span class="tag">${kindLabel(p)}</span></div>
      <div class="meta">
        位置：byte ${p.byte} · bit ${p.bit} · 宽 ${p.bitsize}<br>
        服务：读 0x${(p.readSid ?? 0x21).toString(16).toUpperCase()} / 写 0x${(p.writeSid ?? 0x3B).toString(16).toUpperCase()}
             · LID 0x${(p.lid ?? 0).toString(16).toUpperCase()}<br>
        风险：<span class="risk-${p.risk || 'low'}">${riskLabel(p.risk)}</span>${enHtml}
      </div>
      <label>目标值</label>
      ${input}
      <div class="acts">
        <button id="pRead">读当前值</button>
        <button id="pWrite" class="${ro ? '' : 'primary'}">写入</button>
      </div>
      <div class="hint">${ro ? readOnlyReason(p) : ''}</div>
    </div>`;

  // 开关按钮选中态
  $('paramBox').querySelectorAll('.swBtn').forEach((b) => {
    b.onclick = () => {
      $('paramBox').querySelectorAll('.swBtn').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    };
  });
  $('pRead').onclick = () => doRead(p);
  $('pWrite').onclick = () => {
    if (ro) {
      toast('warn', `「${p.name}」是只读项`, readOnlyReason(p));
      return;
    }
    const sw = $('paramBox').querySelector('.swBtn.sel');
    const raw = sw ? sw.dataset.v : ($('pVal')?.value ?? '0');
    const v = parseFieldInput(p, raw);
    if (v == null) {
      toast('err', '值无效', p.bitsize > 53 ? '请输入十进制或 0x 前缀的整数' : '请输入数字');
      return;
    }
    if (SAFETY.range && !fieldInRange(p, v)) {
      toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}（安全增强已开启）`);
      return;
    }
    doWrite(p, v);
  };
  $('secParam').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 动作前的地址证据门禁。
 *
 * 放行：measured（实测）/ probed（探测+人工确认）/ manual（手工）/ verified（身份核验通过）
 * 候选地址：放行（回读校验兜底；无确认弹窗——参考诊断仪 三路实证无确认，2026-11-05）
 * 未知地址：直接拒
 */
function addrSafeForAction() {
  // ★ 2026-11-11 原厂对齐（CODE-AUDIT §5.2 偏离④）：地址态拒写是自创闸门，原厂没有
  //   （原厂写政策只有「备份→安全访问→单项写→回读」，无地址证据门禁）。
  //   默认关；`setSafety({addrState:true})` 才启用（安全增强，验收矩阵单列）。
  if (!SAFETY.addrState) return true;
  const st = state.currentAddr?.state;
  if (!st) return true;
  // ★ 2026-11-05 修：'table'（表唯一候选直进，2026-11-05 新增态）曾被当「未知」
  //   直接拒执行 —— 表唯一 = 参考诊断仪 同款静态一选，放行。
  // ★ 2026-11-10 修：'bound'（n=0 单帧绑定，新增态）此前不在白名单 → 会被当未知**拒写**。
  //   它等价于 probed：回帧来自该 rx 且该地址有应答，风险由回读校验兜底。
  if (['measured', 'probed', 'bound', 'manual', 'verified', 'table'].includes(st)) return true;
  if (st === 'candidate' || st === 'probed-unverified') {
    // ★ 2026-11-11 注释收口：地址态在默认路径**不拦写**（原厂无地址态闸门）。
    //   `setSafety({addrState:true})` 时才会走到本函数做严格判定；此时候选态仍放行
    //   （表唯一/探测命中属静态一选，与原厂链路层绑定等价），未知态才拒。
    //   ⚠️ 写入的二次确认在 doWrite（TEXT_CN 实证），不在此处 —— 旧注释「无二次确认弹窗」
    //   只针对地址态判定，别误读为写入整体无确认。
    const a = state.currentAddr;
    const at = a?.tx != null ? `0x${a.tx.toString(16).toUpperCase()}/0x${a.rx.toString(16).toUpperCase()}` : '未定';
    log(`  · 地址 ${at} 为「${st}」候选态 —— 直接执行（写入二次确认在 doWrite）`, 'info');
    return true;
  }
  toast('err', '拒绝执行', `当前地址状态是 ${st}（未知）；先跑「系统扫描」重新解析地址`);
  return false;
}

async function doWrite(p, v) {
  if (!needLink()) return;
  if (!coder.diagProfile?.verified) {
    toast('err', '拒绝写入', coder.diagProfile?.reason || '当前 ECU 写流未验证，保持只读');
    return;
  }
  // 地址证据闸门：默认关（原厂无此闸）；`setSafety({addrState:true})` 才启用（见 addrSafeForAction）。
  if (!addrSafeForAction()) return;
  if (!coder.seedKeyProvider) {
    toast('err', '拒绝写入', '缺口令算法变体');
    return;
  }
  // 原厂写入 UX（TEXT_CN 语言库实证，文案原文照抄）：写入**有**二次确认 ——
  //   「警告:请再次确认是否需要编此编码」+「请确认信息后写入新编码值」。
  const okWrite = confirm(
    '警告:请再次确认是否需要编此编码\n\n'
    + `参数：${p.name}\n新值：${decodeValue(p, v)}\n`
    + `（当前 ${p.currentValue !== undefined ? decodeValue(p, p.currentValue) : '?'}）\n\n`
    + '请确认信息后写入新编码值。');
  if (!okWrite) return;
  // ⚠️ 变体未确认则拒绝写入（2026-10-17 审计）：多变体模块的 byte/bit 映射因变体而异，
  //    用错变体会写到错误字节。参考诊断仪靠版本信息（1A 92/94）识别变体。
  if (state.multiVariantModules?.has(p.module) && !state.selectedVariant?.[p.module]) {
    // ★ 2026-11-04：同构变体（字节映射全同）不该锁写 —— 参考诊断仪直接写。
    //   按需比对全部变体映射：一致 → 解锁（默认映射即可用）；不一致 → 保持拒绝。
    const same = await variantMapsIdentical(p.module);
    if (same) {
      log(`  🧩 ${p.module} 各变体字节映射一致 —— 解锁写入（默认变体映射即可用）`, 'ok');
    } else {
      // ★ 2026-11-05 对齐 参考诊断仪 写政策：变体未确认**不锁写** —— 按默认变体
      //   （*_BaseSys 约定）落定后放行，错映射风险由回读校验兜底（参考诊断仪 同款）。
      const mi0 = (modelsCatalog?.models?.[currentModel]?.modules || []).find((m) => m.module === p.module);
      const def = mi0 ? autoPickVariant(mi0, '').name : '';
      if (!def) {
        toast('err', `「${p.name}」变体无法落定`, `${p.module} 没有任何变体映射 —— 无法构造字节，写入中止`);
        return;
      }
      state.selectedVariant[p.module] = def;
      log(`  🧩 ${p.module} 变体未确认 —— 按默认变体 ${def} 写入（回读校验兜底）`, 'warn');
    }
  }
  // canWrite 总闸：只读项（记录无 3B/2E）+ 缺 LID —— 这两条有 原厂证据，永远生效；
  //   level/WRITE_ENABLED 只在 SAFETY.level 开启时参与（默认关 = 原厂行为）。
  if (!canWrite(p)) {
    toast('err', `「${p.name}」不可写`,
      isReadOnlyItem(p) ? readOnlyReason(p)
        : (p.lid == null && p.did == null) ? '缺 LID/DID'
          : '严格门禁未放行（SAFETY.level 已开启且未 write-confirmed）');
    return;
  }
  // 值域闸门：默认关（原厂无）；`setSafety({range:true})` 才拦。
  if (SAFETY.range && !fieldInRange(p, v)) {  // max=null 不能当 0 比较；BigInt/Number 混用由 helper 处理
    toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}（安全增强已开启）`);
    return;
  }
  toast('info', `写入 ${p.name} = ${decodeValue(p, v)}`, '进会话 → 安全访问 → 写 → 回读校验 …');
  try {
    const result = await coder.applyChange(p, v, { dryRun: false, session: 0x89, secLevel: 0x09 });
    // UI 只能显示 ECU 实际回读值，不能显示可能被 mask 截断的用户目标值。
    p.currentValue = extractField(result.readback, p);
    // ⚠️ 块缓存必须失效（2026-10-18 审计）：写入后 currentBlocks[p.lid] 还是旧字节，
    //    再点「读当前值」会拿缓存算出**写入前**的值，显示和车上实际不一致。
    if (p.lid != null) invalidateBlock(p.lid);
    if (currentParam && currentParam.id === p.id) {
      renderParamDetail(p); // 立即刷新显示
    }
    toast('ok', `${p.name} 写入成功`, `当前值已更新为 ${decodeValue(p, p.currentValue)}`);
  } catch (e) {
    const nrc = e instanceof CodingError ? e.nrc : null;
    toast('err', `${p.name} 写入失败`, e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
  }
}

function showSub(s) {
  $('secParam').style.display = '';
  const steps = (s.playbook?.steps || []).map((x, i) => `${i + 1}. ${x}`).join('<br>');
  const rid = s.routineId ?? s.id?.match(/0x[0-9A-Fa-f]+/)?.[0];
  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${s.label || s.id}<span class="tag">特殊功能</span></div>
      <div class="meta">
        风险：<span class="risk-${s.risk || 'low'}">${riskLabel(s.risk)}</span><br>
        ${steps || '（无步骤说明）'}
      </div>
      <div class="acts">
        <button id="pRun" class="primary">执行</button>
        <button id="pStop">停止</button>
        <button id="pResult">查结果</button>
      </div>
      <div class="hint">执行前确认车辆状态安全；高风险功能请先备份。</div>
    </div>`;
  // 例程轮询中止开关（点「停止」置位）—— 实证定论：用户取消时要发恢复命令，
  // 这里至少保证轮询能被打断，不会在后台继续敲 ECU。
  let routineAbort = false;
  const run = (sf, verb) => async () => {
    if (!needLink()) return;
    if (!rid) {
      // 菜单树里这类子功能只有名称，源数据没给可执行 ID —— 说清楚，并指出能用的路径。
      toast('err', `无法${verb}「${s.label || s.id}」`,
        '这条菜单没有对应的可执行例程 ID。请到「特殊功能」页执行；若仍失败，说明该菜单项在当前 ECU 上没有对应例程。');
      return;
    }
    const id = parseInt(String(rid).replace(/^0x/i, ''), 16);
    const risk = s.risk === 'high' ? '高风险功能，请确认车辆状态安全' : '';
    toast('info', `${verb}「${s.label || s.id}」`, risk || '已进入例程会话');
    try {
      await coder.enterSessionFor('routine');   // ← 10 40（执行流实证，2026-11-06 纠正）
      if (coder.seedKeyProvider) {
        // ⚠️ 2026-11-10 修：此前写死 kwp:false → KWP 模块的例程被发 `27 09`（应为 `17 00`），
        //    必然 NRC，还白吃一次安全尝试计数。按最近一次读服务判族（22=UDS / 21,1A=KWP）。
        const kwpRoutine = coder.lastReadSid != null && coder.lastReadSid !== 0x22;
        await coder.securityAccessEx({ level: 0x09, kwp: kwpRoutine });
      }
      // ⚠️ 长例程会先回 NRC 0x78（响应挂起）/ 0x21（忙），一次请求判成败会误报失败。
      //    实证定论：发跟随服务 `31 03` 轮询直到响应不是 21/23/24/78（REAUDIT-20261017）。
      routineAbort = false;
      const { result: r, polled } = await coder.runRoutine(sf, id, '', {
        maxMs: 30000, intervalMs: 1500,
        shouldStop: () => routineAbort,
        onPoll: ({ polls, nrc }) => {
          if (polls === 1) toast('info', '例程执行中', 'ECU 回「未完成」，转 31 03 轮询结果 …');
          else if (polls % 4 === 0) toast('info', '例程执行中', `已轮询 ${polls} 次（最近 NRC 0x${(nrc ?? 0).toString(16)}）`);
        },
      });
      toast('ok', `「${s.label || s.id}」${verb}成功`,
        `应答 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}` +
        (polled ? ` · 轮询 ${polled} 次后取到结果` : ''));
    } catch (e) {
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `「${s.label || s.id}」${verb}失败`,
        e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
    }
  };
  $('pRun').onclick = () => {
    // 高风险项执行前二次确认（对齐 app 里其它危险操作的闸门）
    if (s.risk === 'high' && typeof confirm === 'function'
        && !confirm(`警告:高风险特殊功能「${s.label || s.id}」\n\n`
          + '会真的让 ECU 动作（匹配/复位/学习/驱动），可能改变车辆状态。\n\n'
          + '请确定是否要继续。')) return;   // 参考诊断仪 确认族原文措辞（TEXT_CN 实证）
    run(0x01, '执行')();
  };
  $('pStop').onclick = () => {
    routineAbort = true;
    run(0x02, '停止')();                      // stopRoutine + 打断轮询
  };
  $('pResult').onclick = run(0x03, '查结果'); // requestRoutineResults
}

async function doRead(p) {
  if (p.lid == null) { toast('err', '无法读取', '该参数缺 LID（源数据未给）'); return; }
  let block = cachedBlock(null, p);
  let fromCache = true;
  if (!block) {
    if (!needLink()) return;
    toast('info', `读取 ${p.name}`, '缓存无此块，现读 …');
    fromCache = false;
    try {
      const sid = blockReadSidOf(null, p);
      block = await coder.readBlock(p.lid, sid);
      cacheBlock(sid, p.lid, block);
    } catch (e) {
      toast('err', `${p.name} 读取失败`, e.message);
      return;
    }
  }
  const v = extractField(block, p);
  // ⚠️ 必须把读到的值写回参数对象（2026-10-18 审计）：此前只 toast，详情页仍显示旧值/
  //    未读到，用户再点写入时确认框里的「当前值」也是旧的。读当前值就要真的更新状态。
  if (v != null) p.currentValue = v;
  if (currentParam && currentParam.id === p.id) renderParamDetail(p);
  toast('ok', `${p.name} = ${decodeValue(p, v)}`,
    `原始值 ${v} · ${block.length} 字节${fromCache ? ' · 用进模块时读到的块' : ''}`);
}

// ---------- 写入 ----------
let pendingParam = null;
function openValueModal(p) {
  pendingParam = p;
  $('vmTitle').textContent = `「${p.name}」目标值`;
  const opts = $('vmOpts');
  opts.innerHTML = '';
  const entries = p.enum ? Object.entries(p.enum) : [];
  const cur = (p.currentValue == null) ? null : String(p.currentValue);
  for (const [k, v] of entries) {
    const b = document.createElement('button');
    b.textContent = v;
    if (cur != null && String(Number(k)) === cur) b.classList.add('sel');
    b.onclick = () => {
      $('vmInput').value = k;
      opts.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    };
    opts.appendChild(b);
  }
  // 预填当前值而不是第一项（否则直接点确定会写错值）
  const curEntry = entries.find(([k]) => cur != null && String(Number(k)) === cur);
  $('vmInput').value = curEntry ? curEntry[0] : (entries.length ? entries[0][0] : (cur ?? '1'));
  $('vmHint').textContent = `byte ${p.byte} bit ${p.bit} · 风险 ${riskLabel(p.risk)} · ` +
    `写 0x${(p.writeSid ?? 0x3B).toString(16).toUpperCase()} LID 0x${(p.lid ?? 0).toString(16).toUpperCase()}`;
  $('valueModal').classList.add('show');
}
$('vmCancel').onclick = () => $('valueModal').classList.remove('show');
$('vmOk').onclick = async () => {
  const p = pendingParam;
  const v = Number($('vmInput').value);
  if (!Number.isFinite(v)) { log('值无效', 'err'); return; }
  $('valueModal').classList.remove('show');
  if (!coder) { log('未连接', 'err'); return; }
  if (!coder.seedKeyProvider) { log('缺口令算法，拒绝写入', 'err'); return; }
  // 2026-10-19：值弹窗此前跳过 canWrite（只查 seedKey），与 doWrite 不同口径。
  // 对齐：同一套闸门（canWrite 总闸 + 值域），与 doWrite 完全一致。
  if (!canWrite(p)) {
    log(`「${p.name}」不可写`, 'err');
    return;
  }
  if (SAFETY.range && !fieldInRange(p, v)) {
    log(`值超出范围：可填 ${p.min} … ${p.max}，当前 ${v}（安全增强已开启）`, 'err');
    return;
  }
  log(`—— 写入 ${p.name} = ${decodeValue(p, v)} ——`, 'info');
  try {
    const result = await coder.applyChange(p, v, { dryRun: false, session: 0x89, secLevel: 0x09 });
    p.currentValue = extractField(result.readback, p);
    if (p.lid != null) invalidateBlock(p.lid);   // 同上：块缓存失效
    log('✅ 写入成功，回读一致', 'ok');
  } catch (e) {
    log(`❌ ${e.message}`, 'err');
    if (e instanceof CodingError && e.nrc != null) log(`   NRC 0x${e.nrc.toString(16)}`, 'err');
  }
};

// ---------- 备份 / 导出 / 分享 ----------
// ★ 2026-11-06 全功能调用审计补：设码子菜单「备份所有编码 / 读取备份编码」在重构中
//   调用的 backupAllCoding / restoreCoding 未定义（点击即 ReferenceError）——按 参考诊断仪
//   语义补实现：备份=读取全部编码块并保存；恢复=从备份整块写回+回读校验（写政策同款）。

/** 备份所有编码：读取该模块全部 LID 编码块并存入 coder.backups */
async function backupAllCoding(allItems, sysLabel) {
  if (!needLink()) return;
  const lids = [...new Set((allItems || []).map((p) => p.lid).filter((x) => x != null))];
  if (!lids.length) { toast('warn', '无编码块', '该模块没有可备份的 LID'); return; }
  try {
    showLoading(`备份 ${sysLabel || ''}`, `0 / ${lids.length}`);
    await coder.enterSession(0x89);
    let done = 0;
    for (const lid of lids) {
      const p = allItems.find((q) => q.lid === lid) || {};
      try {
        const actualReadSid = blockReadSidOf(null, p);
        const block = await coder.readBlock(lid, actualReadSid);
        coder.backups.push({
          id: 'backup', lid, readSid: actualReadSid, blockReadSid: actualReadSid,
          writeSid: p.writeSid, session: 0x89,
          model: currentModel || null, module: p.module || null, sysLabel: coder.ecuName || sysLabel || null,
          tx: coder.tx, rx: coder.rx,
          time: new Date().toISOString(),
          raw: block.map((b) => b.toString(16).padStart(2, '0')).join(''),
          name: `${sysLabel || ''} LID 0x${lid.toString(16).toUpperCase()}`,
        });
        done++;
      } catch (e) {
        log(`  备份 LID 0x${lid.toString(16).toUpperCase()} 失败：${e.message}`, 'warn');
      }
      showLoading(`备份 ${sysLabel || ''}`, `${done} / ${lids.length}`);
    }
    hideLoading();
    toast('ok', '备份完成', `${done}/${lids.length} 块 · 共 ${coder.backups.length} 份`);
  } catch (e) { hideLoading(); toast('err', '备份失败', e.message); }
}

/** 从备份恢复编码：整块写回 + 回读校验（参考诊断仪 写政策：备份→写→回读；参考诊断仪 原文确认） */
async function restoreCoding(sysLabel) {
  if (!needLink()) return;
  if (!coder.diagProfile?.verified) {
    toast('err', '拒绝恢复', coder.diagProfile?.reason || '当前 ECU 写流未验证，保持只读');
    return;
  }
  const all = (coder?.backups || []).filter((b) => b && b.raw && b.lid != null);
  const list = all.filter((b) =>
    Number.isInteger(b.tx) && Number.isInteger(b.rx)
    && b.tx === coder.tx && b.rx === coder.rx
    && (!b.model || b.model === currentModel)
    && (!sysLabel || b.sysLabel === sysLabel));
  const skipped = all.length - list.length;
  if (skipped) log(`  已拒绝 ${skipped} 份其他车型/模块/地址的备份，禁止跨 ECU 恢复`, 'warn');
  if (!list.length) { toast('warn', '无当前 ECU 的备份', '只能恢复同车型、同系统、同地址的备份；请先重新备份'); return; }
  const okR = confirm('警告:请再次确认是否需要编此编码\n\n'
    + `恢复 ${list.length} 个编码块（从备份写回${sysLabel ? ' · ' + sysLabel : ''}）\n\n请确认信息后写入新编码值。`);
  if (!okR) return;
  showLoading(`恢复备份`, `0 / ${list.length}`);
  let done = 0, fail = 0;
  try {
    // 一次会话覆盖全部块（参考诊断仪 的写序列是「进会话 → N 块写 → 各自回读」，不是每块重进一次；
    // 此前每块都 enterSessionFor + 完整识别链，10 个块就是 10 遍识别）。
    await coder.enterSessionFor('coding', { skipIdent: true, strictSession: true });
    for (const b of list) {
      // ★ 2026-11-11 审计：位宽按写 SID（2E=2 字节 DID）、协议族按读 SID（22=UDS，其余 KWP），
      //   两者不可混用——混族记录用 writeSid 判族会给 KWP ECU 发 27 09（应为 17 00）。
      const writeSid = Number(b.writeSid);
      if (!WRITE_SIDS.includes(writeSid)) {
        fail++;
        log(`  ❌ 跳过 LID 0x${Number(b.lid).toString(16).toUpperCase()}：备份无 3B/2E 写服务（只读，不恢复）`, 'err');
        continue;
      }
      const writeWide = writeSid === 0x2E;
      // ★ 2026-11-11 原厂对齐（CODE-AUDIT §5.2 偏离⑤）：无读服务 = 读不到 = 不写
      //   （RE-FLOWSPEC §4.1 / McrCodeChileWrite「读失败即中止」）。
      //   旧实现按 writeSid 反推猜 `0x22/0x21`，1A/3B 混族记录会被当 21 读 → 回读比对失真。
      let readSid = null;
      if (READ_SIDS.includes(Number(b.readSid))) readSid = Number(b.readSid);
      else if (READ_SIDS.includes(Number(b.blockReadSid))) readSid = Number(b.blockReadSid);
      if (readSid == null) {
        fail++;
        log(`  ❌ 跳过 LID 0x${Number(b.lid).toString(16).toUpperCase()}：备份无读服务（读不到=不写）`, 'err');
        continue;
      }
      const isKwp = readSid !== 0x22;
      const sidHex = writeSid.toString(16).toUpperCase().padStart(2, '0');
      // ⚠️ 2026-11-10 修：0x2E 的 DID 是 **2 字节**，此前一律 padStart(2) →
      //    `2E 2A ...`（1 字节 DID）发出去，写的是 0x002A 之外的错地址；UDS 模块恢复必错。
      const lidHex = Number(b.lid).toString(16).toUpperCase().padStart(writeWide ? 4 : 2, '0');
      try {
        await coder.securityAccess(0x09, isKwp);
        const wr = await coder.uds(`${sidHex}${lidHex}${b.raw.toUpperCase()}`, 8000, { pendingWait: true });
        const want = (writeSid + 0x40) & 0xFF;
        if (!wr.body.length || wr.body[0] !== want) {
          throw new Error(`写响应异常：期望 ${want.toString(16)}，实得 `
            + (wr.body.map((x) => x.toString(16).padStart(2, '0')).join(' ') || '(空)'));
        }
        const idOk = writeWide
          ? (wr.body[1] === ((b.lid >> 8) & 0xff) && wr.body[2] === (b.lid & 0xff))
          : (wr.body[1] === (b.lid & 0xff));
        if (!idOk) throw new Error('写回显标识符不符');
        const back = await coder.readBlock(b.lid, readSid);
        const ok = back.map((x) => x.toString(16).padStart(2, '0')).join('') === b.raw.toUpperCase();
        if (!ok) throw new Error('回读与备份不一致');
        done++;
        log(`  ✅ 恢复 LID 0x${lidHex}（${b.raw.length / 2} 字节）回读一致`, 'ok');
      } catch (e) {
        fail++;
        log(`  ❌ 恢复 LID 0x${lidHex} 失败：${e.message}`, 'err');
      }
      showLoading(`恢复备份`, `${done + fail} / ${list.length}`);
    }
    hideLoading();
    if (fail) toast('warn', '恢复完成（部分失败）', `成功 ${done} · 失败 ${fail}（见日志）`);
    else toast('ok', '恢复完成', `${done}/${list.length} 块回读一致`);
  } catch (e) { hideLoading(); toast('err', '恢复失败', e.message); }
}

$('btnBackup').onclick = async () => {;
  if (!needLink()) return;
  const p = currentParam;
  const lid = p && (p.lid ?? p.did);
  if (lid == null) {
    toast('warn', '先选一个参数', '备份要指定编码块（需要参数的 LID）');
    return;
  }
  toast('info', `备份 ${p.name}`, `LID 0x${lid.toString(16).toUpperCase()} …`);
  try {
    await coder.enterSession(0x89);
    const actualReadSid = blockReadSidOf(null, p);
    const block = await coder.readBlock(lid, actualReadSid);
    coder.backups.push({
      id: 'backup', lid, readSid: actualReadSid, blockReadSid: actualReadSid,
      writeSid: p.writeSid, session: 0x89,
      model: currentModel || null, module: p.module || null, sysLabel: coder.ecuName || null,
      tx: coder.tx, rx: coder.rx,
      time: new Date().toISOString(),
      raw: block.map((b) => b.toString(16).padStart(2, '0')).join(''),
      name: p.name,
    });
    toast('ok', '备份完成', `${p.name} · ${block.length} 字节 · 共 ${coder.backups.length} 份`);
  } catch (e) {
    toast('err', '备份失败', e.message);
  }
};
$('btnExport').onclick = () => openShare(
  coder ? JSON.stringify(coder.exportBackups(), null, 2) : logEl.textContent);
function openShare(text) {
  $('shareTa').value = text;
  $('shareModal').classList.add('show');
}
$('mClose').onclick = () => $('shareModal').classList.remove('show');
$('mCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('shareTa').value); log('已复制', 'ok'); } catch { }
};
$('mShare').onclick = async () => {
  try { await navigator.share({ text: $('shareTa').value }); } catch { }
};
$('btnCopy').onclick = async () => {;
  try { await navigator.clipboard.writeText(logEl.textContent); log('日志已复制', 'ok'); } catch { }
};
$('btnShare').onclick = () => openShare(logEl.textContent);

// ---------- 载入 ----------
async function loadAll() {
  // ★ 按车型×模块×变体 懒加载（全量 987K 条太大，不能一次载入）
  const [t, cat, c, ea] = await Promise.all([
    fetch('data/menu-tree-v3.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/models-catalog.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/coding-v2.json').then((r) => r.ok ? r.json() : null)
      .catch(() => null)
      .then((x) => x || fetch('data/coding.json').then((r) => r.json())),
    // 2026-10-19：RE 寻址表预取（原先在 enterSystem 里懒加载 → 首次点模块必然失败）
    fetch('data/ecu-addresses.json').then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (ea) ecuAddrTable = ea;
  tree = t;
  modelsCatalog = cat;
  coding = (c.params || []).filter((p) => validateParam(p).length === 0);
  if (modelsCatalog?.models) {
    const n = Object.keys(modelsCatalog.models).length;
    const nv = Object.values(modelsCatalog.models).reduce((a, m) => a + (m.modules || []).reduce((b, x) => b + x.variants.length, 0), 0);
    log(`载入 ${n} 个车型 / ${nv} 个模块变体（按需加载）`, 'ok');
  }
  if (!tree) {
    log('⚠️ 菜单数据未就绪，用参数表兜底', 'info');
    tree = {
      topLevel: [{ id: '手动选择', kind: 'manual', label: '手动选择', groups: [] }],
      groups: [{
        id: 'fallback', label: '（未识别车型）', models: [{
          id: 'fb', label: '（未识别车型）',
          functions: [{ id: '设码', kind: 'syssel', systems: [] }],
        }],
      }],
    };
  }
  log(`载入 ${coding.length} 个参数`, 'ok');
  renderNav();
}

loadAll().then(() => { window.__appBooted = true; }).catch((e) => log('载入失败: ' + e.message, 'err'));

// ---------- 模块扩展功能（读故障码 / 数据流 / 执行器 / 特殊功能）----------
async function showSysExtra(f) {
  $('secParam').style.display = 'none';   // ★ 2026-11-06 内层页化：功能页渲主区，底部面板不再弹
  const sys = f._sys || {};
  const kind = f.kind;
  // ⚠️ 2026-10-18 审计：`esc` 原来只定义在 `kind === 'special'` 分支里，
  //    但 measure / actuator 分支也用了它 —— 那两个页面一点就 ReferenceError。
  //    提到函数作用域，所有分支共用。
  const esc = (x) => String(x ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // 版本信息页面自己渲染 paramBox，不需要先塞「暂不支持」再覆盖（会闪一下）。
  if (kind === 'identity') { await renderIdentity(sys); return; }
  let actions = '';
  if (kind === 'dtc') {
    actions = `<div class="acts">
      <button id="xReadDtc" class="primary">读故障码</button>
      <button id="xClearDtc">清故障码</button></div>
      <div id="dtcResult" class="dtcList"></div>`;
  } else if (kind === 'program') {
    // 只生成 HTML；按钮 handler 统一在 `$('paramBox').innerHTML = ...` **之后**绑定。
    // ⚠️ 2026-10-18 审计：此前 HTML 和 handler 都写在这个分支里，而 handler 在
    //    paramBox.innerHTML 赋值**之前**执行 → `$('xProgRead')` 恒为 null，
    //    点「编程」直接抛 TypeError，后面的 `$('xProgWrite')` 也不会绑定。
    //    这也是「编程」功能一直不可用的根因。
    actions = `<label>编程块 LID（十六进制）</label>
      <input id="xProgLid" placeholder="如 9A">
      <div class="acts">
      <button id="xProgRead" class="primary">读当前值</button>
      <button id="xProgWrite">写入</button>
      <button id="xProgVerify">校验</button></div>
      <div class="hint">读写 SID <b>按记录</b>（prefix[0]/[1]：KWP 21/3B · UDS 22/2E），不做协议族一刀切 ——<br>
      需先进入模块（记录自带 SID）；无记录时按规格未覆盖，拒绝操作。<br>
      编程按标准流程：<b>读当前值 → 修改 → 写入 → 回读校验</b>。高风险，请先备份。</div>`;
  } else if (kind === 'special') {
    // ★ 特殊功能（只列「本平台确认可执行」的项）
    //
    // 一条特殊功能 = 一段完整命令序列，不是单个 RID：
    //   读状态(21/22) → 启动例程(31 01) → 查结果(31 03) → 驱动/写入(2F/2E) → 停止(31 02)
    // 数据来自 special-function-map.json（功能项 → 各平台实现）
    // 与 function-sequences.json（实现函数 → 命令序列）。
    //
    // 展示口径：只显示当前车型平台有实现、且序列非空的项。
    // 其他平台有实现的、本版本没有实现的，一律不列 —— RID 与 ECU 绑定，
    // 跨平台发出去要么没响应，要么命中另一个例程。
    const [mapData, seqData] = await Promise.all([
      fetch('data/special-function-map.json').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('data/function-sequences.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    fnSeqData = seqData;

    const plat = platformForModel(currentModel);
    const nrm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const up = (x) => String(x || '').toUpperCase();
    const sysNorm = nrm(sys.label);
    const sysHay = up(sys.label) + ' ' + (sys.modules || []).map(up).join(' ');
    const sysAliases = mapData?.systemAliases || {};
    // 按词切分而不是子串包含：「ACC(巡航)」不能因为含 AC 就命中「空调」，
    // 「Frontkamera」也不能因为含 Front 就命中「前端电子设备」。
    const wordTokens = (s) => {
      const out = new Set();
      String(s || '').replace(/[^A-Za-z0-9]+/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => {
        out.add(w.toUpperCase());
        (w.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) || []).forEach((p) => out.add(p.toUpperCase()));
      });
      return out;
    };
    const sysTokens = wordTokens(sysHay);
    const sysConcat = sysHay.replace(/[^A-Z0-9]/g, '');
    const aliasHit = (a) => sysTokens.has(a)
      || (a.length >= 5 && sysConcat.includes(a))
      || [...sysTokens].some((t) => t.startsWith(a) && /^\d*$/.test(t.slice(a.length)));

    // 功能项 → 当前系统：中文名互含 / 别名表 / 拉丁代码重合
    const hitSystem = (it) => {
      const a = nrm(it.system);
      if (a && sysNorm && (a === sysNorm || a.includes(sysNorm) || sysNorm.includes(a))) return true;
      if ((sysAliases[a] || []).some(aliasHit)) return true;
      return [...wordTokens(it.system)].some((t) => sysTokens.has(t));
    };
    const implFor = (it) => it.impls.find((x) => x.platforms.includes(plat))
      || it.impls.find((x) => x.platforms.includes('ALL'));

    // 只保留「本平台有实现 + 序列非空 + 映射已确认」的项。
    // verified=false 的是语义对不上、或同一函数无法区分正反操作的（比如
    // "去标准化" 和 "标准化" 指向同一段序列），宁可不显示也不给错按钮。
    // 另外按「名称 + 实现函数」去重：左右设备两条菜单指向同一段序列时只留一条。
    const picked = [];
    const seenKey = new Set();
    for (const it of (mapData?.maps || []).filter(hitSystem)) {
      if (it.status !== 'ok' || it.verified === false) continue;
      const c = implFor(it);
      if (!c) continue;
      const key = `${it.sub}|${c.name}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      picked.push({ it, impl: c });
    }
    const items = picked.map((x) => x.it);

    let html = '';
    if (!plat) {
      html += `<div class="hint">未识别车型平台 —— 先选车型，再看该模块的特殊功能。</div>`;
    } else if (!items.length) {
      html += `<div class="hint">该模块在平台 <b>${esc(plat)}</b> 上没有可执行的特殊功能。</div>`;
    } else {
      html += `<div class="hint" style="margin-bottom:8px">
        特殊功能 · 系统 <b>${esc(sys.label)}</b> · 平台 <b>${esc(plat)}</b> · 共 <b>${items.length}</b> 项
      </div>`;
      html += `<div class="specialList">${picked.map(({ it, impl: c }) => {
        const ridText = (c.rids || []).length ? ` · 例程 ${esc(c.rids.slice(0, 3).join(' / '))}` : '';
        return `
        <div class="specialItem">
          <div class="siName">${esc(it.sub)}</div>
          <div class="siMeta">${c.cmdCount} 步命令${ridText}</div>
          <div class="siActs">
            <button class="seqRun" data-fn="${esc(c.name)}" data-label="${esc(it.sub)}">执行</button>
            <button class="seqView" data-fn="${esc(c.name)}" data-label="${esc(it.sub)}">查看步骤</button>
          </div>
        </div>`;
      }).join('')}</div>`;
      html += `<div class="hint" style="margin-top:8px">
        首次执行先点「查看步骤」核对；执行前确认车辆状态安全（熄火 / 拉手刹 / 必要时上举升机）。
      </div>`;
    }
    actions = html;
  } else if (kind === 'measure') {
    const measureData = await fetch('data/measure.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const modNamesM = (sys.modules || []).map((x) => String(x));
    const sysNormM = (sys.label || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const measures = (measureData?.params || []).filter((m) => {
      const mn = String(m.module || '');
      if (modNamesM.includes(mn)) return true;
      const n2 = mn.toLowerCase().replace(/[^a-z0-9]/g, '');
      return n2 && sysNormM && (n2.includes(sysNormM) || sysNormM.includes(n2));
    }).slice(0, 100);
    if (measures.length) {
      actions = `<div class="specialList">${measures.slice(0, 30).map((m, i) => `
        <div class="specialItem" id="meCard${i}">
          <div class="siName">${esc(m.name || '测量值 ' + i)}</div>
          <div class="siMeta">${m.kind === 'enum' ? '枚举' : m.kind === 'switch' ? '开关' : '数值'}${m.unit ? ' · 单位: ' + esc(m.unit) : ''}${m.min != null ? ' · 范围: ' + m.min + '..' + (m.max ?? '?') : ''}</div>
          <div class="siVal" id="meVal${i}" style="font-size:16px;font-weight:600;color:var(--acc);margin:6px 0">—</div>
          <div class="siActs"><button class="meRead" data-id="${esc(m.id || i)}" data-idx="${i}">读取</button></div>
        </div>`).join('')}</div>
        ${measures.length > 30 ? `<div class="hint">显示前 30 条 / 共 ${measures.length} 条</div>` : ''}`;
    } else {
      actions = `<div class="hint">暂无测量值数据</div>`;
    }
  } else if (kind === 'actuator') {
    // ★ 2026-11-06 用户实测反馈「全是我看不懂的一大串代码」——根治：
    //   参考诊断仪 执行器模块显示 = **正式项目名清单**（文本库 正式名，如「调节」「灯罩加热器」），
    //   按名称路径分组；DID 只是执行细节不是标题。ALL_ACTINFO 记录实锤两类：
    //   ① 2F 驱动项（记录 ctrl 字节含 2F 形态）= 可驱动/回位；
    //   ② 状态/信息项（其他形态）= 目录项（不发 2F）。
    //   实测 2F 快查（GAG 71 DID）折叠保留作兑底，手动 DID 保留。
    const act = await fetch('data/actuator.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const gact = await fetch('data/gag-actuators.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const all = (act?.items || []);
    const drive = all.filter((a) => a.form === '2f' && a.did);
    const info = all.filter((a) => !(a.form === '2f' && a.did));
    const grp = (list) => {
      const g = {};
      for (const a of list) {
        const k = (a.group || (a.name || '').split(' / ')[0] || '其他');
        (g[k] = g[k] || []).push(a);
      }
      return g;
    };
    const card = (a) => `
      <div class="specialItem">
        <div class="siName">${esc(a.name)}</div>
        <div class="siMeta">${a.form === '2f' && a.did
          ? `驱动 2F ${esc(a.didHex)} · 回位 ctrl 0x00`
          : a.form === '31' && a.rid != null
            ? `例程 31 01 ${esc(String(a.rid).padStart(4, '0'))}（执行=启动+轮询 31 03）`
            : '状态 / 信息项（目录项）'}</div>
        ${a.form === '2f' && a.did ? `<div class="siActs">
          <button class="actOn" data-did="${a.did}" data-state="${esc((a.drive && a.drive.state) || 'FF 00 00 00')}">驱动</button>
          <button class="actOff" data-did="${a.did}">回位</button>
        </div>` : ''}
        ${a.form === '31' && a.rid != null ? `<div class="siActs">
          <button class="actRun" data-rid="${a.rid}" data-sub="${a.sub || 1}" data-params="${esc(a.params || '')}">执行</button>
        </div>` : ''}
      </div>`;
    let actHtml = '';
    const routine = all.filter((a) => a.form === '31' && a.rid != null);
    const sect = (title, list, limit) => {
      if (!list.length) return '';
      let h = `<div class="siMeta" style="margin:10px 0 4px">${esc(title)}（${list.length} 项）</div>`;
      const g = grp(list);
      for (const k of Object.keys(g).sort()) {
        const rows = limit ? g[k].slice(0, limit) : g[k];
        h += `<div class="siMeta" style="margin:6px 0 2px">${esc(k)}</div>`;
        h += rows.map((a) => card(a)).join('');
        if (limit && g[k].length > limit) h += `<div class="hint">${esc(k)} 另有 ${g[k].length - limit} 项</div>`;
      }
      return h;
    };
    actHtml += sect('驱动项目（2F IOControl）', drive);
    actHtml += sect('例程项目（31 执行）', routine);
    actHtml += sect('状态 / 信息项目（目录项）', info, 40);
    const quick = (gact?.items || []);
    actHtml += `<details style="margin-top:12px"><summary class="hint">实测 2F 快查（GAG ${quick.length} DID）+ 手动 DID</summary>
      <div class="specialList" style="margin-top:8px">${quick.slice(0, 40).map((a) => `
        <div class="specialItem">
          <div class="siName">${esc(a.name)}</div>
          <div class="siMeta">DID ${esc(a.didHex || '0x' + Number(a.did).toString(16).toUpperCase().padStart(4, '0'))} · drive: ctrl 0x03 + ${esc(a.drive.state)}</div>
          <div class="siActs">
            <button class="actOn" data-did="${a.did}" data-state="${esc(a.drive.state)}">驱动</button>
            <button class="actOff" data-did="${a.did}">回位</button>
          </div>
        </div>`).join('')}</div>
      <div class="hint" style="margin-top:8px">手动 DID（十六进制，最多 4 位）</div>
      <div class="siActs">
        <input id="xDid" value="045B" placeholder="如 045B" style="width:96px">
        <button id="xActOn" class="primary">驱动</button>
        <button id="xActOff">回位</button>
      </div></details>`;
    actions = actHtml;
  } else {
    actions = `<div class="hint">暂不支持</div>`;
  }
  $('navList').innerHTML = `
    <div class="param">
      <div class="nm">${f.id}<span class="tag">${sys.label || ''}</span></div>
      <div class="meta">${f.meta || ''}</div>
      ${actions}
      <div class="hint">会话按 参考诊断仪服务类型切换（故障码 10 03 / 执行器 10 85 / 例程 10 40）</div>
    </div>`;
  const run = async (fn, verb) => {
    if (!needLink()) return;
    toast('info', `${verb} …`, sys.label || '');
    try {
      const r = await fn();
      toast('ok', `${verb}成功`, r || '');
    } catch (e) {
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `${verb}失败`, e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
    }
  };

  // 特殊功能按钮事件
  // ★ 例程执行统一入口 —— 全部走 runRoutine（回 NRC 78/21 时自动 31 03 轮询）。
  // ⚠️ 此前 `.spRun` 直接 `routineControl(1, rid, '')` 发一次就判成败，
  //    长例程（排气/校准/匹配）ECU 先回 7F 31 78 → 这里误报「执行失败」。
  const parseHex = (s) => {
    const t = String(s ?? '').trim().replace(/^0x/i, '');
    if (!/^[0-9A-Fa-f]+$/.test(t)) return NaN;
    return parseInt(t, 16);
  };
  const execRoutine = async ({
    rid, sub = 0x01, params = '', label = '', poll = true, confirmText = null,
  }) => {
    if (!needLink()) return;
    if (!addrSafeForAction()) return;
    if (!Number.isFinite(rid) || rid < 0 || rid > 0xffff) {
      toast('err', 'RID 无效', '请输入 0000–FFFF 的十六进制例程 ID'); return;
    }
    if (!Number.isFinite(sub) || sub < 0 || sub > 0xff) {
      toast('err', '子功能无效', '请输入 00–FF 的十六进制'); return;
    }
    if (params && (params.length % 2 || !/^[0-9A-Fa-f]+$/.test(params))) {
      toast('err', '参数无效', '参数须为偶数位十六进制（如 0100），不要带空格'); return;
    }
    if (confirmText && typeof confirm === 'function' && !confirm(confirmText)) return;
    const verb = sub === 0x01 ? '执行' : sub === 0x02 ? '停止' : sub === 0x03 ? '查结果' : `子功能 0x${sub.toString(16)}`;
    const ridHex = rid.toString(16).toUpperCase().padStart(4, '0');
    showLoading(`${verb}例程中…`, `${label ? label + ' · ' : ''}31 ${sub.toString(16).toUpperCase().padStart(2, '0')} ${ridHex}${params ? ' ' + params : ''}`);
    try {
      await coder.enterSessionFor('routine');            // 10 40（.so 执行流实证，2026-11-06 纠正）
      if (coder.seedKeyProvider && sub !== 0x02) {
        // KWP(21/1A) 与 UDS(22) 的安全访问不是一套；readBlock 已记录最近读服务。
        // ★ 2026-11-06 代码级对齐：例程安全访问 level=0x03（27 03/27 04）——
        //   参考诊断仪 执行流里 31 01 前安全访问分布 27 03 × 356 : 27 09 × 2；
        //   编码写入仍用 level 0x09（GAG 写序言实测），两处 level 各有各的实证。
        const kwp = coder.lastReadSid != null && coder.lastReadSid !== 0x22;
        await coder.securityAccessEx({ level: kwp ? 0x00 : 0x03, kwp });
      }
      const { result: r, polled } = await coder.runRoutine(sub, rid, params, {
        maxMs: 30000, intervalMs: 1500, poll,
        onPoll: ({ polls }) => {
          if (polls === 1) toast('info', '例程执行中', 'ECU 回「未完成」，转 31 03 轮询 …');
          else if (polls % 4 === 0) toast('info', '例程执行中', `已轮询 ${polls} 次`);
        },
      });
      hideLoading();
      // 2026-10-19：不向用户打原始响应字节（hex）——参考诊断仪 只显示结果状态。
      // 原始字节进日志供调试，toast 只报人话。
      const nBytes = (r?.body || []).length;
      const detail = polled ? `轮询 ${polled} 次后取到结果` : (nBytes ? `ECU 已响应（${nBytes} 字节）` : 'ECU 已确认');
      log(`  响应原文：${(r?.body || []).map((x) => x.toString(16).padStart(2, '0')).join(' ')}`, 'info');
      toast('ok', `${verb}成功`, detail);
    } catch (e) {
      hideLoading();
      const nrc = e instanceof CodingError ? e.nrc : null;
      let msg = e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : '');
      // 参考诊断仪 菜单项与 ECU 实际 RID 不一定是同一个；0x31 明确告诉用户不是“车坏了”。
      if (nrc === 0x31) msg += ' —— 当前 ECU 没有这个例程 ID；该功能项可能对应别的例程 ID。';
      toast('err', `${verb}失败`, msg);
    }
  };

  const RISK_TIP = '例程会真的让 ECU 动作（匹配/复位/学习/驱动）。\n确认车辆状态安全（熄火/拉手刹/必要时上举升机）再执行。';

  /**
   * 执行**完整命令序列**（不是只发一条 31）。
   *
   * 序列成分（实测 P9x1_TIP_Oil_Filling）：
   *   21/22 读状态 → 31 01 启动例程 → 31 03 查结果 → 2F IO 控制 → 31 02 停止
   * 安全策略：
   *   · 读命令（21/22/19/1A）失败 → 跳过继续
   *   · 例程（31 01/03）失败 → 停止
   *   · 写入（2E/3B/2F/14/11）失败 → 停止
   */
  const runSequence = async (fnName, label) => {
    const f = fnSeqData?.functions?.find((x) => x.name === fnName);
    if (!f) { toast('err', '找不到执行步骤'); return; }
    if (!needLink()) return;
    if (!addrSafeForAction()) return;
    const cmds = f.cmds || [];
    const isWrite = (c) => /^(2E|3B|2F|14|11)/i.test(c.replace(/\s/g, ''));
    const isRead = (c) => /^(21|22|19|1A)/i.test(c.replace(/\s/g, ''));
    const nWrite = cmds.filter(isWrite).length;
    if (nWrite && !coder.diagProfile?.verified) {
      toast('err', '拒绝执行写入序列', coder.diagProfile?.reason || '当前 ECU 写流未验证，保持只读');
      return;
    }
    const ok = confirm(
      `此功能用于「${label}」的完整执行流程（读状态 → 启动例程 → 查结果 → 写参数 → 停止），是否要执行此功能？\n\n`
      + `共 ${cmds.length} 条命令，其中写入类 ${nWrite} 条。\n`
      + `写入会改变 ECU 配置，请确认已备份。\n\n${RISK_TIP}`);   // 「是否要执行此功能?」= 参考诊断仪 确认族原文
    if (!ok) return;

    showLoading(`执行「${label}」`, `0 / ${cmds.length}`);
    let done = 0;
    try {
      await coder.enterSessionFor('routine');
      // ★ 2026-11-06 代码级对齐：**不再序列外无条件预解锁**——参考诊断仪 的脚本自带
      //   安全访问步（27 03×356 出现在 31 前），不带 27 的例程流（SpecFunctionByID 等
      //   100+ 条 22/10→31）就是不解锁直接跑。序列里的 27/17 由下面按命令字节原样执行。
      for (const c of cmds) {
        const raw = c.replace(/\s/g, '').toUpperCase();
        const sid = parseInt(raw.slice(0, 2), 16);
        done += 1;
        updateLoading(`执行「${label}」`, `${done} / ${cmds.length}　${raw.slice(0, 20)}`);
        try {
          if (sid === 0x31) {
            const sub = parseInt(raw.slice(2, 4), 16);
            const rid = parseInt(raw.slice(4, 8), 16);
            const params = raw.slice(8);
            if (sub === 0x01 || sub === 0x03) {
              await coder.runRoutine(sub, rid, params, { maxMs: 15000, intervalMs: 1200, poll: false });
            } else {
              await coder.routineControl(sub, rid, params);
            }
          } else if (sid === 0x27 || sid === 0x17) {
            // ★ 2026-11-06：安全访问级别**按命令字节**取（序列=GAG 原样脚本）。
            //   参考诊断仪 执行流实证：31 前 27 03 ×356 : 27 09 ×2 —— 例程解锁是 level 0x03
            //   （27 03 取 seed / 27 04 发 key），此前强制 0x09 是自创偏差。
            //   0x04=0x03 的发 key 侧，按 UDS 奇偶约定归一到奇数 level。
            const lvlByte = parseInt(raw.slice(2, 4), 16);
            const lvl = (lvlByte & 1) ? lvlByte : (lvlByte - 1);
            await coder.securityAccessEx({ level: lvl, kwp: sid === 0x17 }).catch(() => {});
          } else {
            await coder.uds(raw, 6000, { allowEmpty: isRead(raw) });
          }
          log(`  ✅ ${done}/${cmds.length} ${raw.slice(0, 24)}`, 'ok');
        } catch (e) {
          const nrc = e instanceof CodingError ? e.nrc : null;
          if (isRead(raw)) {
            log(`  （跳过读 ${raw.slice(0, 12)}：${e.message}）`, 'warn');
            continue;
          }
          throw new CodingError(
            `第 ${done}/${cmds.length} 步失败：${raw.slice(0, 24)} —— ${e.message}` +
            (nrc ? `（NRC 0x${nrc.toString(16)}）` : '') +
            `\n序列已中止（未继续后续步骤）。`, nrc);
        }
      }
      hideLoading();
      toast('ok', `「${label}」序列完成`, `${cmds.length} 条命令全部执行`);
    } catch (e) {
      hideLoading();
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `「${label}」中止`, e.message + (nrc ? '' : ''));
    }
  };
  $('navList').querySelectorAll('.seqRun').forEach((b) => {
    b.onclick = () => runSequence(b.dataset.fn, b.dataset.label || b.dataset.fn);
  });
  $('navList').querySelectorAll('.seqView').forEach((b) => {
    b.onclick = () => {
      const f = fnSeqData?.functions?.find((x) => x.name === b.dataset.fn);
      if (!f) { toast('err', '找不到执行步骤'); return; }
      const label = b.dataset.label || '特殊功能';
      log(`\n=== ${label} 执行步骤（${f.cmdCount} 步）===`, 'info');
      f.cmds.forEach((c, i) => log(`  ${String(i + 1).padStart(2)}. ${c}`, 'info'));
      toast('info', `${f.cmdCount} 步已打印到日志`, '点右上「日志」查看');
    };
  });

  $('navList').querySelectorAll('.spRun, .vRun').forEach((b) => {
    if (b.disabled) return;
    b.onclick = () => execRoutine({
      rid: parseHex(b.dataset.rid),
      sub: parseHex(b.dataset.sub || '01'),
      params: String(b.dataset.params || '').replace(/\s+/g, ''),
      label: b.dataset.name || b.dataset.rid,
      // 普通界面只显示中文功能名；RID 留在高级/调试里。
      confirmText: `确认执行「${b.dataset.name || b.dataset.rid}」？\n\n${RISK_TIP}`,
    });
  });
  $('navList').querySelectorAll('.spStop, .vStop').forEach((b) => {
    b.onclick = () => execRoutine({ rid: parseHex(b.dataset.rid), sub: 0x02, poll: false, label: b.dataset.name || b.dataset.rid });
  });
  $('navList').querySelectorAll('.spResult, .vResult').forEach((b) => {
    b.onclick = () => execRoutine({ rid: parseHex(b.dataset.rid), sub: 0x03, label: b.dataset.name || b.dataset.rid });
  });
  // 手动指定 RID
  const mRid = $('mRid'), mSub = $('mSub'), mParams = $('mParams');
  const readManual = (sub) => ({
    rid: parseHex(mRid?.value),
    sub: sub ?? (parseHex(mSub?.value) || 0x01),
    params: String(mParams?.value || '').replace(/[^0-9A-Fa-f]/g, ''),
    label: '手动 RID',
  });
  $('navList').querySelectorAll('.mRun').forEach((b) => {
    b.onclick = () => execRoutine({
      ...readManual(),
      confirmText: `确认执行手动指定的例程？\n\n${RISK_TIP}`,
    });
  });
  $('navList').querySelectorAll('.mResult').forEach((b) => {
    b.onclick = () => execRoutine({ ...readManual(0x03) });
  });

  // 数据流读取按钮
  $('navList').querySelectorAll('.meRead').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      const idx = parseInt(b.dataset.idx);
      // ⚠️ 下标必须对上**过滤后**列表（2026-10-17 审计 F4）：data-idx 是过滤后下标，
      //    之前却拿去查全量 params[idx] → 显示的名字和读的值必然不对应。
      const measureData = await fetch('data/measure.json').then(r => r.ok ? r.json() : null).catch(() => null);
      const allM = measureData?.params || [];
      const wantId = b.dataset.id;
      const m = wantId ? allM.find((x) => x.id === wantId) : allM[idx];
      if (!m) return;
      try {
        await coder.enterSessionFor('measure');
        // ⚠️ 必须用真实 pid/sid（2026-10-16 审计 ★5a）：
        //    此前 m.lid 恒 undefined → 发 `21 00`，且只取首字节 ——
        //    857/1719 条参数 bitsize>8 全部读错。现已回填 readSid/pid（1719/1719）。
        const pid = m.pid ?? m.lid;
        const sid = m.readSid ?? 0x21;
        if (pid == null) throw new Error('该测量项缺 pid，无法读取');
        const r = await coder.readBlock(pid, sid);
        if (!r || !r.length) throw new Error('空响应');
        // 多字节字段用位域提取（BigInt，支持 bitsize>32）
        // ⚠️ 一律用 extractField（2026-10-17 审计 F5）：此前 bitsize<=8 就取 r[0]，
        //    忽略 byte 偏移 —— 实测 1719 条里 489 条 bitsize<=8 且 byte>0 全部读错。
        const raw = (typeof extractField === 'function')
          ? (extractField(r, m) ?? r[0] ?? 0)
          : (r[0] ?? 0);
        // ★ 解码显示人能读懂的值
        let display = '';
        if (m.kind === 'switch' && m.enum) {
          // ⚠️ 别用 `'0x0'+raw`：raw≥16 时拼出 3 位十六进制（'0x010'），查表必失配
          display = m.enum['0x' + raw.toString(16).toUpperCase().padStart(2, '0')]
            || m.enum[String(raw)] || String(raw);
        } else if (m.kind === 'enum' && m.enum) {
          const key = '0x' + raw.toString(16).toUpperCase().padStart(2, '0');
          display = m.enum[key] || m.enum[String(raw)] || `未知(${raw})`;
        } else {
          display = String(raw) + (m.unit && m.unit.length < 5 ? ' ' + m.unit : '');
        }
        const el = document.getElementById(`meVal${idx}`);
        if (el) el.textContent = display;
        toast('ok', `${m.name} = ${display}`, '');
      } catch (e) {
        toast('err', `${m.name} 读取失败`, e.message);
      }
    };
  });

  // 执行器驱动按钮
  // ⚠️ 必须真的发 `2F` IOControl —— 此前只 enterSession 就弹「已驱动/已回位」，
  //    总线上什么都没发生，用户以为执行器动了（2026-10-16 复查 P10）。
  const runAct = async (b, controlOption, label) => {
    if (!needLink()) return;
    try {
      // ⚠️ DID 直接来自按钮 data-did（GAG 实测值），不再从 actuator.json 查（那个没 DID）
      const did = parseInt(b.dataset.did, 10);
      if (!Number.isFinite(did)) throw new Error('缺少 DID');
      const state = b.dataset.state || '';
      await coder.enterSessionFor('io');
      // 0x03 = shortTermActivate（驱动）；0x00 = returnControlToECU（回位）
      const st = controlOption === 0x03 ? (state.replace(/ /g, '') || 'FF000000') : '';
      const r = await coder.ioControl(did, controlOption, st);
      if (r?.kind === 'nrc') throw new Error(`NRC 0x${r.code?.toString(16)}`);
      toast('ok', `执行器${label}成功`, `DID 0x${Number(did).toString(16).toUpperCase()}`);
    } catch (e) {
      toast('err', `${label}失败`, e.message);
    }
  };
  $('navList').querySelectorAll('.actOn').forEach((b) => {
    b.onclick = () => runAct(b, 0x03, '驱动');
  });
  $('navList').querySelectorAll('.actOff').forEach((b) => {
    b.onclick = () => runAct(b, 0x00, '回位');
  });
  // ★ 2026-11-06 例程按钮（31 族）：记录解出 RID/参数，31 01 启动 + 31 03 轮询
  //   （例程会话 10 40 执行流实证；报文=记录字段原样，不造）。
  $('navList').querySelectorAll('.actRun').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      try {
        const rid = parseInt(b.dataset.rid, 10);
        const sub = parseInt(b.dataset.sub, 10) || 1;
        const params = (b.dataset.params || '').replace(/ /g, '');
        const ridHex = rid.toString(16).toUpperCase().padStart(4, '0');
        log(`  例程执行 31 0${sub} RID ${ridHex}${params ? ' 参数 ' + params : ''} —— 启动 → 轮询 31 03`, 'info');
        await coder.enterSessionFor('routine');
        await coder.runRoutine(sub, rid, params, { maxMs: 15000, intervalMs: 1200, poll: true });
        log(`  ✅ 例程 31 0${sub} RID ${ridHex} 执行完成`, 'ok');
        toast('ok', '例程执行完成', `31 0${sub} RID 0x${ridHex}`);
      } catch (e) {
        toast('err', '例程执行失败', e.message);
      }
    };
  });
  if (kind === 'identity') {
    await renderIdentity(sys);
    return;
  }
  if (kind === 'dtc') {
    $('xReadDtc').onclick = async () => {
      if (!needLink()) return;
      showLoading('正在读取故障码', sys.label || '');
      try {
        await coder.enterSessionFor('ident');
        const r = await coder.readDtc(0x02, 0x89);
        // ⚠️ UDS（59）和 KWP（58）的应答头不同，必须分开解析（2026-10-18 审计）。
        //    此前只按 UDS `slice(3)`，readDtc 回退到 KWP 时会整体错位 → 显示垃圾码。
        const parsed = parseDtcPayload(r.body);
        const dtcs = parsed.dtcs;
        if (parsed.protocol === 'unknown') {
          const rawHex = parsed.raw.map((x) => x.toString(16).padStart(2, '0')).join(' ');
          const el = $('dtcResult') || document.querySelector('#dtcResult');
          if (el) el.innerHTML = `<div class="dtcItem"><div class="dtcCode">未知格式</div>`
            + `<div class="dtcDesc">原始应答：${rawHex || '(空)'} —— 无法识别 59/58 头，未做猜测</div></div>`;
          hideLoading();
          toast('warn', '故障码格式未知', `原始应答：${rawHex || '(空)'}`);
          return;
        }
        // ⚠️ 接上 dtc.json 的描述（审计 #10）：4059 条里 3808 条是中文描述。
        //    码是 5 位（P00C7），库里是 7 位（P00C700，含 failure type 字节）→ 按前缀匹配。
        if (!window.__dtcTable) {
          try {
            const dj = await fetch('data/dtc.json').then((r) => (r.ok ? r.json() : null));
            const tbl = {};
            for (const plat of Object.values(dj?.platforms || {})) {
              for (const it of (plat || [])) {
                const key = String(it.code || '').slice(0, 5).toUpperCase();
                if (key && it.desc && !tbl[key]) tbl[key] = it.desc;
              }
            }
            window.__dtcTable = tbl;
          } catch (e) { window.__dtcTable = {}; }
        }
        const dtcTable = window.__dtcTable || {};
        const escD = (x) => String(x ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const el = $('dtcResult') || document.querySelector('#dtcResult');
        if (el) {
          el.innerHTML = dtcs.length
            ? dtcs.map((d) => {
                const desc = dtcTable[d.code.toUpperCase()] || '';
                return `<div class="dtcItem"><div class="dtcCode">${escD(d.code)}</div>`
                  + `<div class="dtcDesc">${desc ? escD(desc) : '(无描述)'} · 状态 0x${d.status.toString(16).padStart(2, '0')}</div></div>`;
              }).join('')
            : '<div class="dtcNone">✅ 无故障码</div>';
        }
        hideLoading();
        const protoLabel = parsed.protocol === 'kwp' ? 'KWP 18' : 'UDS 19';
        toast('ok', '故障码读取完成',
          dtcs.length ? `${dtcs.length} 个故障码 · ${protoLabel}` : `无故障码 · ${protoLabel}`);
      } catch (e) {
        hideLoading();
        toast('err', '故障码读取失败', e.message);
      }
    };
    $('xClearDtc').onclick = async () => {
      if (!needLink()) return;
      showLoading('正在清除故障码', '');
      try {
        await coder.enterSessionFor('ident');
        await coder.clearDtc();
        hideLoading();
        toast('ok', '故障码已清除', '');
        const el = $('dtcResult') || document.querySelector('#dtcResult');
        if (el) el.innerHTML = '<div class="dtcNone">✅ 已清除，无故障码</div>';
      } catch (e) {
        hideLoading();
        toast('err', '清除失败', e.message);
      }
    };
  } else if (kind === 'program') {
    // ★ 任务清单③（2026-11-08）：读写 SID 按**编码记录**（prefix[0]/[1]，同 ECU 混族），
    //   删除「按协议族一刀切」的勾选派发。无记录 = 按规格未覆盖，拒绝操作（不猜 SID）。
    //   ⚠️ 配对表补默认已删（覆盖审计②）：写 SID 只认记录 writeSid（参考诊断仪 直接用记录字段发帧）；
    //   记录缺 writeSid = 无写服务（只读），不拿配对表猜。
    const progProto = () => {
      const lidText = String($('xProgLid').value || '').trim();
      const lid = /^[0-9A-Fa-f]+$/.test(lidText) ? parseInt(lidText, 16) : NaN;
      const rec = (Array.isArray(coding) ? coding : [])
        .find((it) => it && it.lid === lid && it.readSid != null);
      if (!rec) return null;
      const readSid = Number(rec.readSid);
      const writeSid = rec.writeSid != null ? Number(rec.writeSid) : null;
      // ★ 2026-11-11 全链路审计 P0 修复：读写帧的标识符位宽**各自按自己的 SID**。
      //   旧写法 idPad 只按 readSid → 混族记录（readSid=0x21 / writeSid=0x2E）会把
      //   2 字节 DID 拼成 1 字节，写错地址。coder._readBlockImpl 已按 readSid 处理读帧，
      //   这里 readPad 仅供 UI 位宽校验，writePad 才是写帧拼装用。
      return { readSid, writeSid, readPad: readSid === 0x22 ? 4 : 2,
               writePad: writeSid === 0x2E ? 4 : 2,
               isKwp: readSid !== 0x22 };
    };
    const progRun = async (verb, fn) => {
      if (!needLink()) return;
      const lidText = String($('xProgLid').value || '').trim();
      const lid = /^[0-9A-Fa-f]+$/.test(lidText) ? parseInt(lidText, 16) : NaN;
      if (Number.isNaN(lid)) { toast('err', 'LID 无效', '请输入十六进制 LID'); return; }
      const pp0 = progProto();
      if (!pp0) {
        toast('err', '缺记录 SID', '按规格未覆盖：读写 SID 只认编码记录（prefix[0]/[1]），不做协议族一刀切 —— 请先进入模块');
        return;
      }
      const { readPad } = pp0;
      if (lid < 0 || lid > (readPad === 4 ? 0xffff : 0xff)) {
        toast('err', 'LID 超出位宽', readPad === 4 ? 'UDS DID 为 2 字节（0000–FFFF）' : 'KWP LID 为 1 字节（00–FF）');
        return;
      }
      toast('info', `${verb} …`, `LID 0x${lid.toString(16).toUpperCase()}`);
      try {
        const r = await fn(lid);
        toast('ok', `${verb}成功`, r || '');
      } catch (e) {
        const nrc = e instanceof CodingError ? e.nrc : null;
        toast('err', `${verb}失败`, e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
      }
    };
    $('xProgRead').onclick = () => progRun('读编程块', async (lid) => {
      const { readSid } = progProto() || {};
      await coder.enterSessionFor('coding', { skipIdent: true, strictSession: true });
      const blk = await coder.readBlock(lid, readSid);
      return blk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    });
    $('xProgWrite').onclick = () => progRun('写编程块', async (lid) => {
      if (!coder.diagProfile?.verified) throw new Error(coder.diagProfile?.reason || '当前 ECU 写流未验证，保持只读');
      // 必须显式给出完整块 + 长度校验 + 回读校验；不允许「读到什么就写回什么」。
      // 2026-10-19 对齐 参考诊断仪：备份 → 写入 → 回读 → 失败恢复。
      const input = prompt(
        `要写入 LID 0x${Number(lid).toString(16).toUpperCase()} 的完整块（十六进制，空格可选）：\n`
        + '留空 = 取消。请先复制当前块、改好再粘回。', '');
      if (input == null || !input.trim()) return '已取消';
      const clean = input.replace(/\s/g, '');
      if (!clean || clean.length % 2 || !/^[0-9A-Fa-f]+$/.test(clean)) {
        throw new Error('十六进制内容非法（只允许 hex 与空白，长度必须为偶数）');
      }
      const { readSid, writeSid, writePad, isKwp } = progProto() || {};
      if (!WRITE_SIDS.includes(Number(writeSid))) {
        throw new Error(`记录 writeSid=${writeSid == null ? '缺' : '0x' + Number(writeSid).toString(16)} 非写服务（参考诊断仪 写帧仅 0x3B/0x2E）—— 只读，不写`);
      }
      // 混族记录：写 SID 的标识符位宽容不下该 LID → 拒写（不猜、不截断）。
      if (lid > (writePad === 4 ? 0xffff : 0xff)) {
        throw new Error(`LID 0x${lid.toString(16)} 超出写服务 0x${Number(writeSid).toString(16)} 的标识符位宽 —— 已中止`);
      }
      await coder.enterSessionFor('coding', { skipIdent: true, strictSession: true });
      const cur = await coder.readBlock(lid, readSid);
      if (clean.length / 2 !== cur.length) {
        throw new Error(`长度不符：要写 ${clean.length / 2} 字节，块实际 ${cur.length} 字节 —— 已中止`);
      }
      // 参考诊断仪 序列：写前备份整块（回读不一致时原样写回）
      const backupHex = cur.map((b) => b.toString(16).padStart(2, '0')).join('');
      // ★ 2026-11-11 审计 P0 修复：旧写法 `!uds` 里的 uds 在本作用域**未定义** →
      //   点「写编程块」必抛 ReferenceError。族判定与 coder._applyChangeInner 同口径（读 SID）。
      await coder.securityAccess(0x09, isKwp);
      const sidHex = writeSid.toString(16).toUpperCase().padStart(2, '0');
      const lidHex = Number(lid).toString(16).toUpperCase().padStart(writePad, '0');
      try {
        const wr = await coder.uds(`${sidHex}${lidHex}${clean.toUpperCase()}`, 8000, { pendingWait: true });
        const want = (Number(writeSid) + 0x40) & 0xff;
        if (!wr.body.length || wr.body[0] !== want) throw new Error('写响应 SID 不符');
        const idOk = writeSid === 0x2E
          ? (wr.body[1] === ((lid >> 8) & 0xff) && wr.body[2] === (lid & 0xff))
          : (wr.body[1] === (lid & 0xff));
        if (!idOk) throw new Error('写回显标识符不符');
        const back = await coder.readBlock(lid, readSid);
        const ok = back.map((b) => b.toString(16).padStart(2, '0')).join('') === clean.toUpperCase();
        if (!ok) throw new Error('回读与写入不一致');
        return `已写入并回读校验通过（${cur.length} 字节）`;
      } catch (e) {
        if (!SAFETY.autoRestore) throw e;   // 默认只记录失败，不自动回滚
        // 显式开启安全增强时才恢复；写超时结果未知，也不得默认再发一帧。
        try {
          await coder.enterSessionFor('coding', { skipIdent: true, strictSession: true });
          await coder.securityAccess(0x09, isKwp);
          await coder.uds(`${sidHex}${lidHex}${backupHex.toUpperCase()}`, 8000, { pendingWait: true });
          const restored = await coder.readBlock(lid, readSid);
          const ok = restored.map((b) => b.toString(16).padStart(2, '0')).join('') === backupHex.toUpperCase();
          throw new Error(e.message + (ok ? '（已恢复原块）' : '（⚠️ 恢复也失败，请用恢复备份）'));
        } catch (e2) {
          throw new Error(e2.message.includes('已恢复') || e2.message.includes('恢复')
            ? e2.message : e.message + '（⚠️ 恢复失败，请用恢复备份）');
        }
      }
    });
    $('xProgVerify').onclick = () => progRun('回读校验', async (lid) => {
      const { readSid } = progProto();
      await coder.enterSessionFor('coding', { skipIdent: true, strictSession: true });
      const blk = await coder.readBlock(lid, readSid);
      return `块 ${blk.length} 字节已回读`;
    });
  } else if (kind === 'actuator') {
    $('xActOn').onclick = () => run(async () => {
      await coder.enterSessionFor('io');
      const did = parseInt($('xDid').value, 16);
      const r = await coder.ioControl(did, 0x03, 'FF000000');
      return r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }, '驱动执行器');
    $('xActOff').onclick = () => run(async () => {
      await coder.enterSessionFor('io');
      const did = parseInt($('xDid').value, 16);
      const r = await coder.ioControl(did, 0x00, '');
      return r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }, '执行器回位');
  }
}

/**
 * 按 (车型, 模块) 加载编码条目 —— 取该模块的默认变体（BaseSys），
 * 缓存避免重复拉。全量 987K 条太大，必须按需载。
 */
/**
 * 加载某车型×模块×变体的编码条目。
 *
 * ⚠️ **变体必须匹配**（2026-10-17 审计）：每个模块有多个变体
 *    （ACC3_BaseSys / ACC3_A2 / ACC3_A4 …），不同变体的 byte/bit 映射**可能完全不同**。
 *    旧实现只加载 `mod.default`，车上若是别的变体 → 读写到错误字节。
 *    参考诊断仪 靠 1A 9F/94/92 的识别文本匹配 ODX 变体名（变体识别），不弹窗。
 *    本实现 `autoPickVariant()` 自动匹配；匹配不到用默认变体。
 *    `state.selectedVariant[module]` 仍是写入安全闸门，但由自动选择填充。
 */
async function loadModuleItems(modelLabel, module) {
  const cat = modelsCatalog?.models?.[modelLabel];
  if (!cat) return [];
  const mod = (cat.modules || []).find((m) => m.module === module);
  if (!mod) return [];
  // state 里存的是**变体名**（如 ACC3_A2），文件名字段才是实际 URL（ACC3_A2.json）。
  const sel = state.selectedVariant?.[module];
  const selRec = sel ? (mod.variants || []).find((v) => (v.name || v.file) === sel) : null;
  if (sel && !selRec) {
    // 保存的变体名在目录里找不到（数据更新/手输错误）→ 清掉选择，回默认并保持写入锁，
    // 不能拿默认映射冒充用户选的变体。
    log(`⚠️ ${module} 保存的变体「${sel}」不在目录里，已清除选择（写入保持锁定）`, 'warn');
    delete state.selectedVariant[module];
  }
  const want = selRec?.file || mod.default;
  return await loadVariantItems(cat.slug, want);
}

/** 按 (slug, 变体文件) 加载编码条目（缓存）。 */
async function loadVariantItems(slug, file) {
  const key = `file::${slug}::${file}`;
  if (loadedVariants.has(key)) return loadedVariants.get(key);
  const url = `data/models/${slug}/${file}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    const items = j.items || [];
    // ★ 回落读服务标注（2026-11-08 覆盖审计②）：记录 readSid=0/非读服务的条目
    //   自身无读帧（参考诊断仪 参考诊断仪 读包装 只打包 21/1A/22），块读/备份走
    //   同表回落读服务（参考诊断仪 备份读 表首 SID 读整 PID map 实证）。
    // 回落读服务按**同一 LID**计算，不能让同文件其他 LID 的服务污染本块。
    const byLid = new Map();
    for (const it of items) {
      if (it.lid == null) continue;
      if (!byLid.has(it.lid)) byLid.set(it.lid, []);
      byLid.get(it.lid).push(it);
    }
    const fallbackByLid = new Map();
    for (const [lid, group] of byLid) fallbackByLid.set(lid, resolveBlockReadSid(group));
    for (const it of items) it.blockReadSid = fallbackByLid.get(it.lid) ?? null;
    loadedVariants.set(key, items);
    return items;
  } catch {
    return [];
  }
}

/** 块读服务：记录自带可发读帧用之；否则回落同表读服务（无则 null=不发帧）。 */
function blockReadSidOf(items, p) {
  if (p && hasReadService(p)) return Number(p.readSid);
  if (p && READ_SIDS.includes(Number(p.blockReadSid))) return Number(p.blockReadSid);
  const f = resolveBlockReadSid(items);
  return f;
}

/**
 * 块约束适配判定（2026-11-04，文档 §5「宁可拒写不猜」的正向应用）：
 * 变体映射的值域/枚举与实测块内容全部吻合才算适配。
 * 用于唯一适配时的确定性变体确认 —— 不猜、不唯一不认。
 */
function variantFitsBlocks(items, blocks) {
  for (const p of items) {
    const sid = blockReadSidOf(items, p);
    const b = sid == null ? undefined : blocks[blockKey(sid, p.lid)];
    if (!b) continue;
    try {
      const v = extractField(b, p);
      if (v == null) continue;
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      if (p.min != null && num < Number(p.min)) return false;
      if (p.max != null && num > Number(p.max)) return false;
      const rawKeys = Array.isArray(p.enum)
        ? p.enum.map((e) => typeof e === 'object' ? e.value : e)
        : (p.enum && typeof p.enum === 'object' ? Object.keys(p.enum) : []);
      if (rawKeys.length >= 2) {
        const hit = rawKeys.some((k) => {
          try { return BigInt(k) === BigInt(v); } catch { return Number(k) === num; }
        });
        if (!hit) return false;
      }
    } catch { return false; }
  }
  return true;
}

/**
 * 同构判定（2026-11-04）：该模块所有变体的字节映射是否完全一致。
 * 实证：BV_ECM_UDS 的 36 个变体 (lid,byte,bit,bitLength,name) 全同 —— 纯标定副本，
 * 读写与选哪个变体无关。同构 → 默认变体即可读写（解锁写入闸门）；
 * 不同构 → 保持闸门（防写错字节）。结果缓存。
 */
async function variantMapsIdentical(module) {
  const key = `sameMap::${currentModel}::${module}`;
  if (loadedVariants.has(key)) return loadedVariants.get(key);
  try {
    const cat = modelsCatalog?.models?.[currentModel];
    const mi = (cat?.modules || []).find((m) => m.module === module);
    const recs = mi?.variants || [];
    if (recs.length <= 1) { loadedVariants.set(key, true); return true; }
    const sigOf = (items) => items
      // ★ 签名必须含值域/枚举（2026-11-04）：字节位置相同但取值表不同 = 语义不同，
      //   只比位置会把 A 变体的枚举值写进 B 变体的语义里 —— 同构才许解锁写入
      .map((p) => [p.lid, p.byte, p.bit, p.bitsize, p.name, p.min, p.max,
        JSON.stringify(p.enum ?? null)].join(','))
      .sort().join(';');
    let base = null;
    for (const v of recs) {
      const items = await loadVariantItems(cat.slug, v.file);
      if (!items.length) { loadedVariants.set(key, false); return false; }
      const s = sigOf(items);
      if (base == null) base = s;
      else if (s !== base) { loadedVariants.set(key, false); return false; }
    }
    loadedVariants.set(key, true);
    return true;
  } catch {
    return false;
  }
}
