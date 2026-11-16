/**
 * 参考诊断仪 特殊功能目录过滤：只看「当前系统」的中文功能。
 *
 * 参考诊断仪 的特殊功能按系统逐级进入，不会把其它模块的例程混在一起；
 * 我们之前的 `modMatch` 用类别兜底，容易把同类但不同模块的项带进来。
 * 这里只做**已确认的系统名别名**，然后精确归一化匹配；不猜、不跨类别。
 */

const ALIAS = new Map([
  ['TCM/PDK(自动变速箱控制模块)', 'Tiptronic 变速器控制'],
  ['IC(仪表)', '组合仪表'],
  ['空调', 'AC(空调系统)'],
  ['PASM(水平高度控制)', 'PASM（保时捷主动悬架管理系统）'],
  ['PCM/CDR（通信管理/CD、收音机）', 'PCM（保时捷通信管理系统）'],
  ['水平高度控制/PASM', 'PASM（保时捷主动悬架管理系统）'],
  ['驾驶员侧座椅存储器', '驾驶员侧座椅记忆'],
  ['乘客侧座椅存储器', '乘客侧座椅位置记忆'],
  ['安全气囊', 'SRS(安全气囊)'],
  ['电动转向', 'EPS(电动助力转向系统)'],
  ['动力转向', 'EPS(电动助力转向系统)'],
  ['水平高度控制', '水平高度控制/PASM'],
].map(([k, v]) => [norm(k), norm(v)]));

function norm(x) {
  return String(x || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

/** 系统名 → 特殊功能目录 key（含 参考诊断仪 菜单别名） */
export function specialSystemKey(label) {
  const n = norm(label);
  return ALIAS.get(n) || n;
}

/**
 * 平台 → 特殊功能 ID 段。
 *
 * 参考诊断仪 981 的基准是 **14 系统 / 27 子功能**，正好落在 `0x0200–0x0314`；
 * `0x0320+` 是 992/Macan/Cayenne/Panamera 等新平台（例：0x0320 冷却系统排气_992、
 * 0x0326 全轮驱动_CAJUN、0x0327 网关匹配_Cayenne-92A、0x0337 Panamera-971）。
 * 不按平台过滤时 981 会显示 53 项，其中 26 项是别的平台 —— 这就是“看不懂的一大堆”的来源。
 */
const NEW_PLATFORMS = new Set(['992', 'CAJUN', 'G1', 'G2', 'G3', 'E1', 'E2', 'E3', 'J1', '918S']);

// 981/718/991 的「后端电子设备」尾翼/后盖/后刮水器 = 0x0340–0x0344；
// 可折叠顶篷、座椅、EPS、TPM 在 0x0348–0x034D。它们不是「新平台」，
// 旧版用 <=0x0314 一刀切把 981 的尾翼校准等全过滤掉了（用户实车对照指出）。
const OLD_EXTRA = new Set([0x0340, 0x0341, 0x0342, 0x0343, 0x0344,
  0x0348, 0x0349, 0x034A, 0x034B, 0x034D]);

// 这些不是「981 专属」，而是 PCM/座椅/PASM/网关/车道/转向盘/驻车制动 的通用功能，
// 新平台（Macan/Cayenne/Panamera/992/Taycan）也有；旧版用 `>=0x0320` 一刀切，
// 导致这些车型的「转向盘电子设备」「车道变换」特殊功能为空。
const COMMON = new Set([
  0x0200, 0x0201, 0x0202, 0x0203, 0x0204,
  0x0300, 0x0301, 0x0302, 0x0303, 0x030B, 0x030C, 0x030D, 0x030E,
  0x0310, 0x0311, 0x0312, 0x0313, 0x0314,
]);

function idInPlatform(routineId, platform) {
  if (!platform) return true;
  const n = parseInt(String(routineId || '').replace(/^0x/i, ''), 16);
  if (!Number.isFinite(n)) return false;
  if (COMMON.has(n)) return true;
  if (NEW_PLATFORMS.has(platform)) return n >= 0x0320;
  return n <= 0x0314 || OLD_EXTRA.has(n);
}

// 菜单树里有些车型只给一个泛称，但数据分成左/右两个系统。不能因为名字不精确
// 就让「车道变换/辅助系统」整块为空。
const MULTI_ALIAS = new Map([
  [norm('车道变换辅助系统'), [norm('车道变换辅助系统，右侧（主设备）'), norm('车道变换辅助系统，左侧（从动设备）')]],
  [norm('辅助系统'), [norm('车道变换辅助系统，右侧（主设备）'), norm('车道变换辅助系统，左侧（从动设备）')]],
]);

/**
 * 只返回当前系统、当前平台段的特殊功能；保持数据原顺序。
 * @param {string} sysLabel 菜单树系统名
 * @param {Array<{system:string, sub:string, routineId:string}>} functions special-functions.json.functions
 * @param {string} [platform] platformForModel() 的代号（9X1/9X7/9X6/992/CAJUN/G2/E2/J1…）
 */
export function specialFunctionsFor(sysLabel, functions, platform = '') {
  const key = specialSystemKey(sysLabel);
  if (!key) return [];
  const keys = MULTI_ALIAS.get(key) || [key];
  // ★ T04-c D-2：canonical 字段是 menuId；routineId 仅为兼容离线生成器的 deprecated 别名。
  return (functions || []).filter((f) =>
    keys.includes(specialSystemKey(f.system)) && idInPlatform(f.menuId ?? f.routineId, platform));
}

/* ──────────────────────────────────────────────────────────────────
 * ★ 2026-11-15 T04-c 裁定 B：功能全集运行时消费层（零 fetch 数据真接到 UI）
 *
 * 链路（每一环都有可证伪的运行时证据，F13/F14 逐帧断言复跑）：
 *   www/index.html（scripts/sync.mjs 注入的 bootstrap，真实 UI 入口）
 *     → import('./feature-catalog.js')（本文件的原样拷贝，纯 ESM 无裸标识符）
 *     → loadFeatureCatalog(fetch)            // 12 份数据真实 fetch
 *     → src/schema.js:enumeratePages()       // ★ app.js:16 已 import 的模块，
 *                                          //   确实在 app 的 import 图 / app.bundle.js 里
 *     → src/schema.js:featureFramesFor()     // 由静态记录生成 elm.cmd 帧
 *     → src/elm327.js:Elm327.cmd             // 真发帧（MockAdapter.txLog 命中）
 *
 * ★ 枚举/构帧实现放在 src/schema.js（app.js 已 import），本文件只 re-export，
 *   不重复实现——避免「测试 import 的模块 app 根本没引用」的死代码。
 * 767 只是 MENU.BIN:0x4C 的条目计数证据；分组上限直接取 app.js 现有
 * .slice(0,30) / sect(...,40)，不自造新上限。
 * ────────────────────────────────────────────────────────────────── */
import { enumeratePages, featureFramesFor } from './schema.js';

export { enumeratePages, featureFramesFor };

/** 运行时可达的功能全集数据源（与 scripts/sync.mjs 的 RUNTIME_REACHABLE 同源、等长）。 */
export const FEATURE_DATA_SOURCES = Object.freeze([
  'measure.json',
  'actuator.json',
  'function-sequences.json',
  'special-function-map.json',
  'special-functions.json',
  'special-functions-real.json',
  'special-functions-ext.json',
  'special-systems.json',
  'routines.json',
  'routines-verified.json',
  'routine-templates.json',
  'gag-routines.json',
]);

/** UI 入口 → 调用链（文件:符号序列），供 F13/F14 逐帧断言取用。 */
export const FEATURE_CALL_CHAIN = Object.freeze([
  'www/index.html:feature-catalog bootstrap',
  'src/special-catalog.js:loadFeatureCatalog',
  'src/schema.js:enumeratePages (app.js:16 已 import)',
  'src/schema.js:featureFramesFor',
  'src/elm327.js:Elm327.cmd',
]);

/**
 * 加载全部零 fetch 功能数据。
 * @param {(url:string)=>Promise<{ok?:boolean,json:()=>Promise<unknown>}>} [fetchImpl]
 *   可注入的 fetch（浏览器用全局 fetch，Node 测试注入本地文件 shim）。
 * @returns {Promise<{ok:boolean,missing:string[],sources:Record<string,object>,enumerated:object}>}
 */
export async function loadFeatureCatalog(fetchImpl) {
  const fn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const sources = {};
  const missing = [];
  if (typeof fn !== 'function') {
    return { ok: false, missing: FEATURE_DATA_SOURCES.slice(), sources, enumerated: {} };
  }
  for (const file of FEATURE_DATA_SOURCES) {
    try {
      const r = await fn(`data/${file}`);
      if (!r || r.ok === false) { missing.push(file); continue; }
      const j = typeof r.json === 'function' ? await r.json() : r;
      if (j && typeof j === 'object' && !Array.isArray(j)) sources[file] = j;
      else missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  // ★ 裁定 B：加载后在 UI 侧**真的枚举**全量分组，view.pages 不再是死数据。
  //   measure/actuator 各页 itemIdx 覆盖 100% 条目，并暴露给 window.__featureCatalog。
  const enumerated = {};
  for (const [file, arrayKey] of [['measure.json', 'params'], ['actuator.json', 'items']]) {
    const r = enumeratePages(sources[file], arrayKey);
    enumerated[file] = {
      total: r.total, enumeratedItems: r.items.length, diff: r.diff,
      groups: r.pages, groupsWithinCap: r.groupsWithinCap,
      items: r.items,
    };
  }
  return { ok: missing.length === 0, missing, sources, enumerated };
}

/* enumeratePages / featureFramesFor 的唯一实现在 src/schema.js（app.js:16 已 import），
 * 本文件通过顶部 `export { enumeratePages, featureFramesFor }` 原样 re-export，
 * 不存在第二份实现、不存在测试专用副本。 */
