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
  return (functions || []).filter((f) =>
    keys.includes(specialSystemKey(f.system)) && idInPlatform(f.routineId, platform));
}
