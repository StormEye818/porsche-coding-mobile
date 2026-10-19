/**
 * seedkey.js — Porsche seed/key 算法实现。
 *
 * 来源：安全模块 逐条还原
 *   算法 A: 算法变体 A 
 *   算法 B: （另一变体）
 *
 * ⚠️ 注意：`口令位构造` 是误导（位域插入，构造命令字节），
 *   不是安全密钥计算。真算法在这里。
 *
 * 性质：纯 16 位位运算，无 AES、无查表、无大常量。
 * 用法：  coder.seedKeyProvider = { name, calc(seed, level) }
 *
 * ✅ **已通过 离线校验 验证**（离线校验）。实现可信。
 */

/** 16 位符号扩展 */
function sxth(x) {
  x &= 0xffff;
  return x & 0x8000 ? x - 0x10000 : x;
}
const uxth = (x) => x & 0xffff;
const bit = (x, n) => (x >>> n) & 1;

/** 算法 A：算法变体 A  */
export function algoA(r0) {
  r0 >>>= 0;
  const lr = sxth(r0);

  // 控制位 → 迭代次数
  const ip = 2;
  let n = (ip & (r0 >>> 3)) | bit(r0, 14);
  n |= 8 & (r0 >>> 2);
  n |= lr & 4;

  let r3 = r0;
  const pathB = (r0 & 0x200) !== 0;      // bit9 选路径
  for (let i = 0; i < n; i++) {
    if (pathB) {
      // 路径 B ：16 位右旋 1
      let r7 = (r3 >>> 1) & 0x7fff;
      if (r3 & 1) {
        r3 = (r7 | 0x8000) & 0xffff;
        r7 = r3;
      }
      r3 = sxth(r7);
    } else {
      // 路径 A：左移 / 左旋
      if (sxth(r3) < 0) {
        r3 = (r3 << 17) >>> 0;
        r3 = 1 | (r3 >>> 16);
      } else {
        r3 = (r3 << 1) & 0x1fffe;
      }
      r3 = sxth(r3);
    }
  }

  // 模式合并
  const mode = (ip & (r0 >>> 6)) | bit(r0, 11);
  // ⚠️ 实测：mode==3 时汇编直接跳过（itt ne / andne），r3 不变
  if (mode === 1) r3 = (r3 & 0xffff) | lr;
  else if (mode === 2) r3 = (r3 & 0xffff) ^ lr;
  else if (mode === 3) { /* 恒等 */ }
  else r3 = lr & r3;
  return sxth(r3);
}

/** 算法 B： */
export function algoB(r0) {
  r0 >>>= 0;
  const ip0 = 2;
  // r1 = bit3 | (r0 & 4) | (2 & (r0>>8))
  let r1 = bit(r0, 3) | (r0 & 4) | (ip0 & (r0 >>> 8));
  // n = (8 & (r0>>4)) | r1
  const n = (8 & (r0 >>> 4)) | r1;
  // ip = (2 & (r0>>5)) | bit13   ← bit13 归 ip
  const ip = (2 & (r0 >>> 5)) | bit(r0, 13);

  let r = r0;
  if (n !== 0) {
    for (let i = 0; i < n; i++) {
      if ((r0 & 0x1000) === 0) {
        // path A: 左移带进位
        r = (bit(r, 15) | ((r << 1) >>> 0)) >>> 0;
      } else {
        // path B: 右旋 1
        r = ((((r << 15) & 0xffff) | (r >>> 1)) >>> 0);
      }
    }
    r = uxth(r);
  }
  const mode = ip & 3;
  if (mode === 1) return sxth((r0 ^ r) >>> 0);
  if (mode === 2) return sxth(r0 & r);
  if (mode === 3) return sxth((r0 | r) >>> 0);
  // mode 0：用 32 位 r（未 uxth），再截 16
  return sxth((r0 + r) >>> 0);
}

/**
 * SeedKeyProvider 插槽实现。
 * @param {Uint8Array} seed  车发来的种子（通常 2 或 4 字节）
 * @param {number} level     访问等级（0x01 / 0x03 …）
 * @param {string} variant   可选：ECU 变体名（决定用 A 还是 B）
 */
/**
 * ECU 家族 → seed/key 变体。
 *
 * ⚠️ 算法按 **ECU 家族**选，不是全局一个（FINDINGS.md：143 密钥符号 / 93 类函数体指纹，
 *    最大簇 10 个同构 = 同一算法的不同 ECU 封装；家族分布 E3(20)/G2(7)/918(5)/PDK(2)…)。
 *    对非该家族的 ECU 算出的 key 是错的 → NRC 0x35 → 反复重试 → **0x36 锁死**。
 *
 * 目前只确认了 `9x7GW`（`algo-9x7` @两个 16 位位运算例程。
 * 其余家族的映射**尚未逐一确认**，不要瞎填。
 */
export const VARIANT_BY_ECU = {
  '9x7GW': { algo: 'A', seedBytes: 2, verified: true },
  // SO-EXPORTS 的具名 ECU 变体。⚠️ verified:false = 未逐位验证。
  //    指纹聚类显示多数变体是**独立算法**（不是换壳），用前必须 对拍 校验。
  '918Aero': { algo: 'A', seedBytes: 2, verified: false },
  '918BKV': { algo: 'A', seedBytes: 2, verified: false },
  '918EPB': { algo: 'A', seedBytes: 2, verified: false },
  '918Lenk2': { algo: 'A', seedBytes: 2, verified: false },
  '918TBF': { algo: 'A', seedBytes: 2, verified: false },
  'Actuator_for_Exterior_Noise_UDS': { algo: 'A', seedBytes: 2, verified: false },
  'Allrad_Gen1': { algo: 'A', seedBytes: 2, verified: false },
  'BMS2': { algo: 'A', seedBytes: 2, verified: false },
  'BatteCM': { algo: 'A', seedBytes: 2, verified: false },
  'BatteCM_OBC72': { algo: 'A', seedBytes: 2, verified: false },
  'BedienSG_vo_MSB_21': { algo: 'A', seedBytes: 2, verified: false },
  'BedienSG_vo_MSB_3': { algo: 'A', seedBytes: 2, verified: false },
  'CamerSysteRearView_MODE1': { algo: 'A', seedBytes: 2, verified: false },
  'CamerSysteRearView_MODE2': { algo: 'A', seedBytes: 2, verified: false },
  'CamerSysteRearView_NightVisio': { algo: 'A', seedBytes: 2, verified: false },
  'CentrModulComfoSysteUDS_BCM2': { algo: 'A', seedBytes: 2, verified: false },
  'CentralElectricsUDS_BCM1': { algo: 'A', seedBytes: 2, verified: false },
  'DME_TDI_V8': { algo: 'A', seedBytes: 2, verified: false },
  'DriveMotorContrModul': { algo: 'A', seedBytes: 2, verified: false },
  'E2_RDK3_3': { algo: 'A', seedBytes: 2, verified: false },
  'E3_Airbag': { algo: 'A', seedBytes: 2, verified: false },
  'E3_Climatronic': { algo: 'A', seedBytes: 2, verified: false },
  'E3_EBKV': { algo: 'A', seedBytes: 2, verified: false },
  'E3_EFP': { algo: 'A', seedBytes: 2, verified: false },
  'E3_ICM_Mode1': { algo: 'A', seedBytes: 2, verified: false },
  'E3_ICM_Mode1_1': { algo: 'A', seedBytes: 2, verified: false },
  'E3_ICM_Mode2': { algo: 'A', seedBytes: 2, verified: false },
  'E3_ICM_Mode2_1': { algo: 'A', seedBytes: 2, verified: false },
  'E3_MASG1': { algo: 'A', seedBytes: 2, verified: false },
  'E3_MASG2': { algo: 'A', seedBytes: 2, verified: false },
  'E3_OBC1': { algo: 'A', seedBytes: 2, verified: false },
  'E3_OBC2': { algo: 'A', seedBytes: 2, verified: false },
  'E3_PACCh': { algo: 'A', seedBytes: 2, verified: false },
  'E3_PDCC': { algo: 'A', seedBytes: 2, verified: false },
  'E3_PSM': { algo: 'A', seedBytes: 2, verified: false },
  'E3_PTM': { algo: 'A', seedBytes: 2, verified: false },
  'E3_RDK': { algo: 'A', seedBytes: 2, verified: false },
  'E3_hi_MSB': { algo: 'A', seedBytes: 2, verified: false },
  'E3_hi_MSB2': { algo: 'A', seedBytes: 2, verified: false },
  'E3_vo_MSB': { algo: 'A', seedBytes: 2, verified: false },
  'ECM_UDS': { algo: 'A', seedBytes: 2, verified: false },
  'EPB': { algo: 'A', seedBytes: 2, verified: false },
  'EPS': { algo: 'A', seedBytes: 2, verified: false },
  'Frontkamera_1': { algo: 'A', seedBytes: 2, verified: false },
  'Frontkamera_Others': { algo: 'A', seedBytes: 2, verified: false },
  'G2_BVS': { algo: 'A', seedBytes: 2, verified: false },
  'G2_EPS': { algo: 'A', seedBytes: 2, verified: false },
  'G2_GQS_ZF_21': { algo: 'A', seedBytes: 2, verified: false },
  'G2_RearAxleSteer': { algo: 'A', seedBytes: 2, verified: false },
  'G2_SoundMLB': { algo: 'A', seedBytes: 2, verified: false },
  'G2_VTS': { algo: 'A', seedBytes: 2, verified: false },
  'G2_vo_MSB_3': { algo: 'A', seedBytes: 2, verified: false },
  'J1_BMS_800V_DRX_21': { algo: 'A', seedBytes: 2, verified: false },
  'OverTheAir_21': { algo: 'A', seedBytes: 2, verified: false },
  'PDK2_21': { algo: 'A', seedBytes: 2, verified: false },
  'PDK2_21_TOP': { algo: 'A', seedBytes: 2, verified: false },
  'RealTopview': { algo: 'A', seedBytes: 2, verified: false },
  'ThermManagUDS': { algo: 'A', seedBytes: 2, verified: false },
  '_NEW9x1BKE': { algo: 'A', seedBytes: 2, verified: false },
};

/** 按 ECU 名/家族挑变体；不认识返回 null（调用方必须拒绝写入，不要回退默认） */
/**
 * 按 ECU 名挑 seed/key 变体。
 *
 * ⚠️ **不要瞎猜**：指纹聚类显示多数变体是**独立算法**（不是换壳），
 *    用错变体 = 算错 key = NRC 0x35 → 反复重试 → **0x36 锁死**。
 *    因此：① 精确匹配优先 ② 变体名是模块名子串才认 ③ 都不中 → 返回 null，调用方必须拒写。
 *    `verified:false` 的变体写入前还要人工确认（见 app.js doWrite）。
 */
const ECU_ALIAS = {
  // 明确同源（模块名是变体名的组成部分，非猜测）
  'EPB': 'EPB', 'EPS': 'EPS', 'BMS2': 'BMS2', 'ECM_UDS': 'ECM_UDS',
  'DME_TDI_V8': 'DME_TDI_V8', 'Allrad': 'Allrad_Gen1', 'ThermManag': 'ThermManagUDS',
  'RealTopview': 'RealTopview', 'Frontkamera': 'Frontkamera_1',
  'DriveMotorContrModul': 'DriveMotorContrModul', 'BatteCM': 'BatteCM',
};

export function pickVariant(ecuName = '') {
  const n = String(ecuName).toUpperCase();
  // ① 精确
  for (const [k, v] of Object.entries(VARIANT_BY_ECU)) {
    if (n === k.toUpperCase()) return { variant: k, ...v };
  }
  // ② 显式别名
  for (const [alias, k] of Object.entries(ECU_ALIAS)) {
    if (n.includes(alias.toUpperCase()) && VARIANT_BY_ECU[k]) {
      return { variant: k, ...VARIANT_BY_ECU[k] };
    }
  }
  // ③ 变体名是模块名子串（要求变体名 >=3 字符，避免 'EPS' 之类短名误配）
  for (const [k, v] of Object.entries(VARIANT_BY_ECU)) {
    const kk = k.toUpperCase();
    if (kk.length >= 3 && n.includes(kk)) return { variant: k, ...v };
  }
  return null;
}

/**
 * 造 seed/key provider（`coder.seedKeyProvider` 的插槽值）。
 *
 * ⚠️ 2026-10-17 回归修复：这个函数曾从源码里丢失，导致 `src/app.js` 的
 *    `import { makeProvider }` 直接炸、只能靠旧 bundle 撑着。
 *    从 `www/app.bundle.js` 反推恢复，并修掉旧实现的一个 bug：
 *    **`verified` 原来写死 `true`**，会把 `VARIANT_BY_ECU` 里 `verified:false`
 *    的 58 个变体也当成已验证放行 —— 现在如实传递。
 *
 * @param {{variant?:string, algo?:'A'|'B', seedBytes?:number, verified?:boolean}} opt
 * @returns {{name:string, verified:boolean, calc(seed:number[], level:number):Uint8Array}}
 */
export function makeProvider({ variant = '9x7GW', algo = 'A', seedBytes = 2, verified = true } = {}) {
  const fn = algo === 'B' ? algoB : algoA;
  return {
    name: `Porsche-${algo}(${variant})`,
    verified,
    calc(a, _level) {
      if (a.length !== seedBytes) {
        // ⚠️ 长度不符**绝不静默截断/补零**（2026-10-16 审计）——算错 key = NRC 0x35
        //    → 反复重试 → 0x36 锁死。宁可拒算，让人去核对该 ECU 的 seed 长度。
        throw new Error(
          `seed 长度 ${a.length} ≠ 期望 ${seedBytes}（variant=${variant}），拒绝计算。` +
          `请核对该 ECU 的 seed 长度后显式配置 seedBytes —— 绝不静默截断/补零。`);
      }
      // 16 位小端打包 seed → 例程入口字
      const r0 = (a[0] | (a[1] << 8)) & 0xffff;
      const out = fn(r0) & 0xffff;
      return new Uint8Array([out & 0xff, (out >>> 8) & 0xff]);
    },
  };
}
