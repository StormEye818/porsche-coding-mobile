/**
 * 非 ASAP1A 入口的 seed/key 分发。
 *
 * 🔑 2026-10-17 · 映射**全部从二进制读出**，没造一条别名。
 *
 * ## 证据链（原厂口令算法库 + 原厂特殊功能库）
 *
 * 1. 5 个函数是**导出符号**（mangled `_Z25SecurityAccess_9x7_ALLRADPhtS_tPt` …），
 *    只经 PLT/GOT 被**按名**调用 —— 不在 `securityModel` 的 mode switch 里。
 * 2. 名字在 **300 字节/条 的 nameTable** 里（文件偏移差恒为 0x12C），
 *    记录尾部全零 → 名字是逗号别名串，算法由**同索引 switch** 决定。
 * 3. 对这 5 条，**名字 == 函数名**（恒等映射），不需要变体 ID 中转。
 * 4. SPECF 里变体名紧挨 seedkey 函数名（`EV_EPSFSBASMMBw` /
 *    `EV_EPSBOPO68X` → `SecurityAccess_BV_SteerAssisUDS_992`），
 *    且车数据里这两个变体的 `module` 都是 `BV_SteerAssisUDS` ——
 *    **函数名 = 前缀 + 模块名 + 平台限定**。
 *
 * ## 匹配策略（⚠️ 别做偏）
 *
 * - **只做精确函数名匹配** + **一条已证实的模块别名**（`BV_SteerAssisUDS`）。
 * - 绝不做模糊匹配：`Allrad` / `PSM` / `Airbag` 在 ASAP1A 名字表里
 *   **已有正解**（如 `Allrad` → `Allrad_Gen1`），模糊抢会把对的算成错的。
 * - 平台限定（`_9x7` / `_992`）没逆清的部分**明确拒写**，绝不猜 ——
 *   猜错 key = NRC 0x35 → 0x36 锁死。
 */

import { MODE_9X7_ALLRAD, MODE_9X7_PCMKEY, MODE_9X7_PSM8, airbagUploadKey } from './seedkey-pswcalc.js';
import { computeKey as sa2ComputeKey } from './seedkey-sa2.js';

/**
 * SecurityAccess_BV_SteerAssisUDS_992 的 **SA2 VM 程序**（50 字节）。
 *
 * ⚠️ 这是**从静态分析的内联表逐字节抄出来的**（`local_58[0..0x31]`），
 *    不是猜的。结构解析：
 *      93 0055AAFF   ADD 0x0055AAFF
 *      68 07         FOR 7
 *      93 98765432   ADD
 *      81            SHL1
 *      4A 15         JNZ
 *      87 AFBECD0BC  XOR
 *      68 05         FOR 5
 *      93 01113161   ADD
 *      4A 05         JNZ
 *      87 15071108   XOR
 *      82            SHR1
 *      49            FOR-END
 *      84 9BCF3027   SUB
 *      4A 05         JNZ
 *      87 A4B91C27   XOR
 *      49            FOR-END
 *      4C            HALT
 *    seed 是 **BE32**，输出也是 **BE32**（C 里 param_3[0]=MSB）。
 *
 * ✅ 仿真 真值对拍 4/4：12345678→317a1a3d · ffffffff→03be78ea
 *                          80000000→18c2fc5c · 01020304→01d62038
 */
export const SA2_PROG_992_STEERASSIS =
  '930055aaff68079398765432814a1587afbecdbc680593011131614a0587150711088249849bcf30274a0587a4b91c27494c';

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

// ─────────────────────────────────────────────────────────────────────────────
// 16 位 rotate+combine 规格执行器（9x7 族共用骨架，位布局各自不同）
//    ⚠️ 工作字要用 spec.pack 取（BE16 = 高 16 位），不是 s & 0xffff
// ─────────────────────────────────────────────────────────────────────────────
function runSpec(spec, s0, s1) {
  const p = ((s0 & 0xff) << 24) | ((s1 & 0xff) << 16);
  const x = (spec.pack ? spec.pack(p >>> 0) : p & 0xffff) & 0xffff;
  const n = spec.n(p >>> 0) & 15;
  const left = spec.left(p >>> 0);
  const r = left
    ? (((x << n) | (x >>> (16 - n))) & 0xffff)
    : (((x >>> n) | (x << (16 - n))) & 0xffff);
  const f = spec.modeMap[spec.mode(p >>> 0) & 3];
  // C 里 mode==3 之类未定义分支：uVar2 不变 = 旋转结果
  return (f ? f(x, r, p >>> 0) : r) & 0xffff;
}

/** 2 字节大端 */
const be2 = (v) => Uint8Array.of((v >>> 8) & 0xff, v & 0xff);

/**
 * ⚠️ PSM8 是 `sprintf("%02X%02X", hi, lo)` —— **大写** hex。
 *    2026-10-17 补漏：上一轮用 `.toString(16)` 得到小写，和 真值对拍 的 'FFFF'
 *    在 ffffffff 这个点上悄悄错开（其余用例不含字母所以看不出来）。
 */
const hexUpper2 = (v) => Uint8Array.from(
  (((v >>> 8) & 0xff).toString(16).padStart(2, '0') + (v & 0xff).toString(16).padStart(2, '0'))
    .toUpperCase().split('').map((c) => c.charCodeAt(0)));

// ─────────────────────────────────────────────────────────────────────────────
// 名字 → 算法（名字即函数名，恒等映射）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每条：
 *   seedLen  该函数真正读的 seed 字节数（不足/超出都拒算）
 *   keyLen   输出字节数
 *   calc     (seedBytes) => Uint8Array
 */
export const NON_ASAP_BY_NAME = {
  /** SecurityAccess_9x7_ALLRAD  */
  SecurityAccess_9x7_ALLRAD: {
    seedLen: 2, keyLen: 2,
    algo: 'rotate+combine16/9x7_ALLRAD',
    calc: (s) => be2(runSpec(MODE_9X7_ALLRAD, s[0], s[1])),
  },

  /** SecM_9x7_PCMKey  —— C 只读 param_1[0..1] */
  SecM_9x7_PCMKey: {
    seedLen: 2, keyLen: 2,
    algo: 'rotate+combine16/9x7_PCMKey',
    calc: (s) => be2(runSpec(MODE_9X7_PCMKEY, s[0], s[1])),
  },

  /**
   * SeedAndKeyPag_9x7_SK_PSM8 
   * ⚠️ C 里 `if (param_2 == 2) … if (param_4 == 2)` —— **seedLen 和 keyLen
   *    都必须是 2**，否则直接返回失败。输出是 4 个 ASCII 大写 hex 字符。
   */
  SeedAndKeyPag_9x7_SK_PSM8: {
    seedLen: 2, keyLen: 4, rawKeyLen: 2,
    algo: 'rotate+combine16/9x7_PSM8(hex)',
    calc: (s) => hexUpper2(runSpec(MODE_9X7_PSM8, s[0], s[1])),
  },

  /** ASAM_seedkey_Airbag_Upload_CONFIDENTIAL  —— 26 轮 ARX */
  ASAM_seedkey_Airbag_Upload_CONFIDENTIAL: {
    seedLen: 4, keyLen: 4,
    algo: 'ARX26/Airbag_Upload',
    calc: (s) => airbagUploadKey(s),
  },

  /**
   * SecurityAccess_BV_SteerAssisUDS_992 
   * —— **SA2 VM 程序**（50 字节内联表，已抽 + 真值对拍 4/4）。
   *    seed BE32 → key BE32，outLen=4。
   */
  SecurityAccess_BV_SteerAssisUDS_992: {
    seedLen: 4, keyLen: 4,
    algo: 'SA2/992_SteerAssisUDS',
    calc: (s) => sa2ComputeKey(s, hexToBytes(SA2_PROG_992_STEERASSIS)),
  },
};

/**
 * 车型 label → 平台码。
 * ⚠️ 从 **车数据 ground truth** 抄的（`data/models/*.json` 的 `items[].platform`），
 *    不是猜的。有测试 `smoke-fixes.mjs` 对照数据校验，数据变了测试会红。
 *    用途：`BV_SteerAssisUDS` 这类**跨平台同名模块**必须按平台分算法。
 */
export const MODEL_PLATFORM = {
  '911（964/993）': '9X6',
  '911（991）': '9X1',
  '911（992）': '992',
  '911（996）': '9X6',
  '911（997）': '9X7',
  '918 Spyder': '918S',
  'Boxster（981）': '9X1',
  'Boxster（982）': '9X1',
  'Boxster（986）': '9X6',
  'Boxster（987）': '9X7',
  'Carrera GT': 'CS1',
  'Cayenne-92A（2011 - 2017）': 'G2',
  'Cayenne-9PA（至2010年款止）': 'G1',
  'Cayenne-9YA（自2018年款起）': 'G3',
  'Cayman GT4 Clubsport': '9X1',
  'Cayman（981）': '9X1',
  'Cayman（982）': '9X1',
  'Cayman（987）': '9X7',
  'GT2（996）': '9X1',
  'GT3（996）': '9X1',
  'Macan': 'CAJUN',
  'Panamera-970（至2016年款止）': 'E1',
  'Panamera-971（2017-2024）': 'E2',
  'Panamera-YA（自2024年款起）': 'E3',
  'Taycan': 'J1',
};

/** 车型 label → 平台码；查不到返回 null（调用方不得猜） */
export function platformForModel(modelLabel) {
  const n = String(modelLabel ?? '').trim();
  return MODEL_PLATFORM[n] ?? null;
}

/**
 * 模块 → 函数名，**按平台限定**。
 *
 * ⚠️ 推导规则（**只放能从函数名推出来的**）：
 *    函数名 = 前缀 + 模块关键字 + 平台码
 *      `SecurityAccess_BV_SteerAssisUDS_992` = … + `BV_SteerAssisUDS` + `_992`
 *      `SeedAndKeyPag_9x7_SK_PSM8`          = … + `PSM` + `9x7`
 *      `SecM_9x7_PCMKey`                    = … + `PCM` + `9x7`
 *
 * ⚠️ **必须平台限定**：`BV_SteerAssisUDS` 跨 992/E3/G2/G3/J1 五个平台，
 *    只有 992 上用 `…_992` 这个算法。不分平台会把 E3/G2 算错 → NRC 0x35 锁死。
 *
 * ⚠️ **不放**（推不出来，宁可拒写）：
 *    `SecurityAccess_9x7_ALLRAD` —— 9X7 平台**没有** allrad 模块（41 个模块里没有），
 *      `_9x7_ptm`/`_9x7_aws` 是不是它属猜测，不做。
 *    `ASAM_seedkey_Airbag_Upload_CONFIDENTIAL` —— 名字里是 **Upload 操作**不是模块，
 *      和 `_9x7_airbag`/`Airbag`/`BV_AirbaUDS` 的对应关系没证据。
 *
 * key = `${platform}:${MODULE}`（两边都大写）
 */
export const NON_ASAP_BY_MODULE = {
  // 证据：SPECF  `EV_EPSBOPO68X` /  `EV_EPSFSBASMMBw`
  //       紧挨  `SecurityAccess_BV_SteerAssisUDS_992`，
  //       而车数据里这两个变体 module 均为 `BV_SteerAssisUDS`、platform 均为 992
  '992:BV_STEERASSISUDS': 'SecurityAccess_BV_SteerAssisUDS_992',

  // 9X7 平台：函数名带 `9x7`，模块名带 `_9x7_`，关键字对得上。
  // `_9x7_psm` 是 9X7 上唯一的 PSM 模块；`_9x7_pcm2_*` 是唯一的 PCM 模块族。
  '9X7:_9X7_PSM': 'SeedAndKeyPag_9x7_SK_PSM8',
  '9X7:_9X7_PCM2_AMP': 'SecM_9x7_PCMKey',
  '9X7:_9X7_PCM2_CDC': 'SecM_9x7_PCMKey',
  '9X7:_9X7_PCM2_GW': 'SecM_9x7_PCMKey',
  '9X7:_9X7_PCM2_MMI': 'SecM_9x7_PCMKey',
  '9X7:_9X7_PCM2_NAVI': 'SecM_9x7_PCMKey',
  '9X7:_9X7_PCM2_TEL': 'SecM_9x7_PCMKey',
};

/**
 * 函数名 → 算法（**只做精确匹配**，不模糊）。
 * ⚠️ 模糊匹配会把 `ASAM_seedkey_Airbag`（ASAP1A 正解）误配到
 *    `ASAM_seedkey_Airbag_Upload_CONFIDENTIAL`。原厂 `PorscheGetAsapCalcType`
 *    也是补逗号做**精确 token** 匹配，不是子串。
 */
export function nonAsapForName(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  if (NON_ASAP_BY_NAME[n]) return { name: n, ...NON_ASAP_BY_NAME[n] };
  const up = n.toUpperCase();
  for (const k of Object.keys(NON_ASAP_BY_NAME)) {
    if (k.toUpperCase() === up) return { name: k, ...NON_ASAP_BY_NAME[k] };
  }
  return null;
}

/**
 * 模块 → 算法，**按平台限定**。
 *
 * @param {string|null} platform  平台码（'992' / '9X7' …），来自 platformForModel
 * @param {string} moduleName     车数据的 module 名（'BV_SteerAssisUDS' / '_9x7_psm'）
 * @returns {object|null}
 */
export function nonAsapForModule(platform, moduleName) {
  const p = String(platform ?? '').trim().toUpperCase();
  const m = String(moduleName ?? '').trim().toUpperCase();
  if (!p || !m) return null;
  const fn = NON_ASAP_BY_MODULE[`${p}:${m}`];
  return fn && NON_ASAP_BY_NAME[fn] ? { name: fn, ...NON_ASAP_BY_NAME[fn] } : null;
}

/**
 * 名字或（平台+模块）→ 算法描述；查不到返回 null。
 * 顺序：精确函数名 → 平台限定模块名。**都不模糊匹配**。
 */
export function nonAsapResolve(name, platform, moduleName) {
  return nonAsapForName(name) || nonAsapForModule(platform, moduleName);
}

/**
 * 算 key。算不出 / 未实现 → 抛错（调用方必须拒写）。
 *
 * @param {string} name   函数名或已证实的模块名
 * @param {Uint8Array|number[]} seed
 * @returns {{key: Uint8Array, algo: string, name: string}}
 */
export function computeNonAsapKey(name, seed) {
  const e = nonAsapForName(name);
  if (!e) throw new Error(`非 ASAP1A 名字「${name}」不在已证实表里，拒算`);
  if (e.pending) {
    throw new Error(`「${name}」的算法（${e.algo}）尚未实现，拒算（绝不猜 key）`);
  }
  const s = seed instanceof Uint8Array ? seed : Uint8Array.from(seed);
  if (s.length !== e.seedLen) {
    // ⚠️ 长度不符绝不静默截断/补零 —— 算错 key = NRC 0x35 → 0x36 锁死
    throw new Error(`「${name}」seed 长度 ${s.length} ≠ 期望 ${e.seedLen}，拒算`);
  }
  const key = e.calc(s);
  if (key.length !== e.keyLen) {
    throw new Error(`「${name}」输出长度 ${key.length} ≠ 期望 ${e.keyLen}，拒算`);
  }
  return { key, algo: e.algo, name: e.name };
}
