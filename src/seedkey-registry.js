/**
 * Porsche seed/key 变体注册表 —— core.so
 *
 * 🔑 2026-10-17 · 工具链 解析 + 模拟器 对拍 全量验证
 *    ⚠️ 由 tools/gen-seedkey-registry.py 生成，**别手改**（程序表是完整十六进制）。
 *
 * 全库 135 个 `ASAP1A_CCP_*` 变体：
 *
 *   SA2 虚拟机       50 个  1 个解释器 + 每变体一张 VM 程序表  ✅ 对拍 对拍通过
 *   内联 ADD         44 个  key = BE{n}((BE32(seed) + C) >>> 0)  ✅
 *   内联特殊          3 个  EMPTY / NOT_TOP / BYTES_NOT            ✅
 *   内联 OTHER       38 个  rotate+combine 家族，待逐个拆位布局   ⏳
 *
 * ⚠️ `outLen` 是**变体相关**的：多数 4 字节，少数 2/3 字节，还有 1 个 outLen=0 的空壳。
 *    变体签名：`ASAP1A_CCP_*(uchar *seed, ushort seedLen, uchar *key, ushort keyLen, ushort *outLen)`
 *    seed 按 **4 字节大端** 解成 u32，key 也按大端写出（BYTES_NOT 例外，按字节）。
 *
 * ⚠️ 同一算法多名（按常数去重）：
 *    0x00004E87 ← Frontkamera_1, DDF82664AD7BBFD89D6469978F70B32D
 *    0x000054A9 ← 918EPB, 8349C602556708ED4601B6F624D9CFA3
 *    0x00006D43 ← DME_TDI_V8, D692D19211C8FF8C4D62DAABBDF800EB
 *    0x00009CE8 ← 918Lenk2, 814487F8B49583427CE98A0D557FB1EE
 *    0x00011170 ← 95D9783BEB5C788B4358E063576B17B9, 9C8A2A7F4221D3D683D2E222E3C7A040
 */

import { computeKey } from './seedkey-sa2.js';
import { inlineVmRun } from './seedkey-inlinevm.js';

/**
 * 内联 VM 家族（2026-10-18 收编）—— 变体 ID → 40 字节程序（十六进制）
 *
 * ⚠️ 与 `SA2_PROGRAMS` **不是同一套解释器**，别混用：
 *    SA2 调独立函数 `sa2ExecuteCommand`（）；这一族是编译器把解释器
 *    **内联进变体函数体**（栈上 `local_50[40]` + do-while switch）。助记符相同，
 *    但 FOR 机制不同（见 `seedkey-inlinevm.js` 文件头）。
 *    这里 4 个程序两套解释器都能算对（程序没有跨循环跳转、count>0），
 *    但**回归里有断言卡住两套不许合并**，防止后来的程序踩到分叉语义。
 *
 * 程序来源：rodata，由 `tools/extract-inlinevm.py` 提取；
 *   提取器在 `9E95AD47` 上与 静态分析 静态分析的 `local_50[0..0x27]` 逐字节吻合。
 * 真值对拍 32 点 × 4 = 128 点全过。
 */
export const INLINE_VM_PROGRAMS = {
  //  —— ASAM_seedkey_BDE_DL；= DRIVELINKS mode 0xb1 的落点
  '3D5365460CB39FEFC14651DF5075A1B8':
    '6803824a10680484121019734a05872506200382499319111974824a058717062006824a0181494c',
  //  —— 静态分析完整（decompiled.txt [29]），本族语义的**权威参照**
  '9E95AD479750DBABF9068A886EC37CE7':
    '6803814a10680284121019734a05872506200382499322121954824a058717062006824a0181494c',
  // 
  '91C0B71C660408DF11A4C211006FB913':
    '6805824a10680484121019734a05872506200382499319111974824a058701012008824a0181494c',
  // 
  'ED8524ED02C73B97FF5D4E4DED031495':
    '6804814a10680384121019734a05872506200382499319111974814a058712082001814a0181494c',
};

/** SA2 家族：变体 ID → { prog: VM 程序十六进制, outlen } */
export const SA2_PROGRAMS = {
  '918Aero': { prog: '87deadbeef6807824a0584230291c04987000000014c', outlen: 4 },
  '918BKV': { prog: '6809824a0593289115096803814987071220124a058425088519494c', outlen: 4 },
  '918TBF': { prog: '680884564b7c9e824a026b05871b22aa83494c', outlen: 4 },
  'ASAP1A_CCP_AerodContrUnitUDS_Marquardt_3': { prog: '8187528ad2e36805849483a42c824a0587612241ab8193a231c866824a05847469acb84987550022004c', outlen: 4 },
  'ASAP1A_CCP_BV_TirePressMonit1UDS_RDKHUF_21': { prog: '6804814a058724ce370549930007dc2a4c', outlen: 4 },
  'ASAP1A_CCP_DashBoardUDS_LGE_21': { prog: '680593310351154a05872409311182494c', outlen: 4 },
  'ASAP1A_CCP_MUTI001_Delphi_21': { prog: '931350070068078705031966842101a8e04a03816b018249824c', outlen: 4 },
  'Actuator_for_Exterior_Noise_UDS': { prog: '680684a06c90ee814a05871bf91adf494c', outlen: 4 },
  'Allrad_Gen1': { prog: '680787251a71cb814a0584c8a50f6b494c', outlen: 4 },
  'BMS2': { prog: '680a874f5cf49c93d13246124a03826b06819371bafe308438f452b4494c', outlen: 4 },
  'BatteCM': { prog: '6807871e06135393040b13524a03826b068193190914068410041351494c', outlen: 4 },
  'BatteCM_OBC72': { prog: '828282680787def5da85814a059355ea847d494c', outlen: 4 },
  'BedienSG_vo_MSB_21': { prog: '68058293b3d17a29814a05877d123a9e841c7b3d17494c', outlen: 4 },
  'BedienSG_vo_MSB_3': { prog: '6803814a10680384020919634a05872806192482499389111975824a058712082001824a0181494c', outlen: 4 },
  'CentrModulComfoSysteUDS_BCM2': { prog: '8193a57203df8733dc901293d3a08eaf4a1b680484142938464a068293f1d974028772d9ca3881498747d9b2a684cc216fe982680787167df230824a0a844490fd2387c359acfe8193297fab3c814987ee2312544c', outlen: 4 },
  'CentralElectricsUDS_BCM1': { prog: '680793419166684a0b680a824987127741186b09680d814987869056684984103712294c', outlen: 4 },
  'E2_RDK3_3': { prog: '6805814a05870a22128949930002997f4c', outlen: 4 },
  'E3_Airbag': { prog: '68059398453267824a05875107bea4494c', outlen: 4 },
  'E3_Climatronic': { prog: '6803824a10680584090263194a05870628241982499311897519824a058708122001824a0181494c', outlen: 4 },
  'E3_EBKV': { prog: '6809824a059328911509680381498707122012494c', outlen: 4 },
  'E3_EFP': { prog: '87188510286809824a0584240191f04987c05ecacc4c', outlen: 4 },
  'E3_ICM_Mode1': { prog: '6805814a10680284100519704a05872013112981499308196803824a058712112011824a0181494c', outlen: 4 },
  'E3_ICM_Mode1_1': { prog: '6805814a10680284100519704a05872013112981499308196803824a058712112011824a0181494c', outlen: 4 },
  'E3_ICM_Mode2': { prog: '6805934a2d61c54a0c6803814a0587e3b728968249814a0c6803824a0587a5791db28249847d39c1434a0181494c', outlen: 4 },
  'E3_ICM_Mode2_1': { prog: '6805934a2d61c54a0c6803814a0587e3b728968249814a0c6803824a0587a5791db28249847d39c1434a0181494c', outlen: 4 },
  'E3_MASG1': { prog: '8187528ad2e36805849483a42c824a0587612241ab8193a231c866824a05847469acb84987550022004c', outlen: 4 },
  'E3_MASG2': { prog: '68069357263594824a05878599122468039377284019814a05877583858368049373558563824a0587637854738187657367434949494c', outlen: 4 },
  'E3_OBC1': { prog: '6807871e06135393040b13524a03826b068193190914068410041351494c', outlen: 4 },
  'E3_OBC2': { prog: '828282680787def5da85814a059355ea847d494c', outlen: 4 },
  'E3_PACCh': { prog: '6805824a0b87587964238425896752829382203765814a058742682482824a0181494c', outlen: 4 },
  'E3_PDCC': { prog: '680684a76d90ee824a05871bf91adf494c', outlen: 4 },
  'E3_PSM': { prog: '6808814a059302051087680382498704032014494c', outlen: 4 },
  'E3_PTM': { prog: '68078193500308824a06931337800b818756070323842022025482494c', outlen: 4 },
  'E3_RDK': { prog: '6804814a058724ce370549930007dc2a4c', outlen: 4 },
  'E3_hi_MSB': { prog: '68068293123a9e84814a0587d17a298184814a0587494c', outlen: 4 },
  'E3_hi_MSB2': { prog: '6804824a10680484020919634a05872806192482499313072014814a058712082005824a0181494c', outlen: 4 },
  'E3_vo_MSB': { prog: '930055aaff68079398765432814a1587afbecdbc680593011131614a0587150711088249849bcf30274a0587a4b91c27494c', outlen: 4 },
  'Frontkamera_Others': { prog: '680893529177684a0b6809824987127741186b09680d814987869056684984214823384c', outlen: 4 },
  'G2_BVS': { prog: '68078293f9e8d7c64a0587a1b2c3d4494c', outlen: 4 },
  'G2_EPS': { prog: '930055aaff68079398765432814a1587afbecdbc680593011131614a0587150711088249849bcf30274a0587a4b91c27494c', outlen: 4 },
  'G2_GQS_ZF_21': { prog: '6809814a10680687537448614a0593c386a928824984d314e862814a058750655061824a0182494c', outlen: 4 },
  'G2_RearAxleSteer': { prog: '938a0c95fb68079379fa14dc814a1f87deadbeef680593019917c14a10680693d1d3ff5a4a058715071108824949849bcf3027814a15680387acdc1024814a058735004f1c499304baa3d987a4b91c27494c', outlen: 4 },
  'G2_SoundMLB': { prog: '680684a16d91ef814a05871bf91adf494c', outlen: 4 },
  'G2_VTS': { prog: '6805824a0c84921019734a058712082001494c', outlen: 4 },
  'G2_vo_MSB_3': { prog: '6803814a10680384020919634a05872806192482499389111975824a058712082001824a0181494c', outlen: 4 },
  'J1_BMS_800V_DRX_21': { prog: '6805814a0587cafeaffe494c', outlen: 4 },
  'OverTheAir_21': { prog: '6807841a6d95ef814a05871bf91adf494c', outlen: 4 },
  'PDK2_21': { prog: '84370284fa680693323b0137824a1f87ab231255680993082245de4a10680684229ab1fd4a05875aaffea58149499312a20433494c', outlen: 4 },
  'PDK2_21_TOP': { prog: '84370284fa93323b0137824a1c87ab231255680993082245de4a0d84229ab1fd4a05875aaffea581499312a20433824a15680587c2327d24824a05874527120549934554669687233727104c', outlen: 4 },
  '9E95AD479750DBABF9068A886EC37CE7': { prog: '6803814a10680284121019734a05872506200382499322121954824a058717062006824a0181494c', outlen: 4 },
  '91C0B71C660408DF11A4C211006FB913': { prog: '6805824a10680484121019734a05872506200382499319111974824a058701012008824a0181494c', outlen: 4 },
  'ED8524ED02C73B97FF5D4E4DED031495': { prog: '6804814a10680384121019734a05872506200382499319111974814a058712082001814a0181494c', outlen: 4 },
  'RealTopview': { prog: '93130120126807814a05870b22aa89494c', outlen: 4 },
};

/**
 * 内联 ADD：`key = BE{outlen}((BE32(seed) + C) >>> 0)`
 * ✅ 44 个，6 点探针判定 delta 恒定。
 */
export const INLINE_ADD = {
  '01EA0D371104956F002D33636F6CD69B': { c: 0x00008465, outlen: 4 },
  '0604347974DF663819D78E3091A2922A': { c: 0x000030D7, outlen: 4 },
  '116584177CB5049F8ACBC375CC2B7562': { c: 0x42514251, outlen: 4 },
  '13AF8A4F5869A6FA45E4FD900835FFED': { c: 0x00005A10, outlen: 4 },
  '15F9E74D33216FE9F3C65ECBAC9AA093': { c: 0x00003496, outlen: 4 },
  '185AC67DC95CC0167762F31598FA1BEA': { c: 0x00017F12, outlen: 4 },
  '26700ADDEE7A49BA9857EC124977AC93': { c: 0x0000000B, outlen: 4 },
  '2847060DAFC70146BFC0E3703791D0F8': { c: 0x00003039, outlen: 4 },
  '4768E5B66193C061322B05DF68558E13': { c: 0xC138F16C, outlen: 4 },
  '4EACD11C4760A75F68C3AA2AC96FD6C9': { c: 0x0001275C, outlen: 4 },
  '6A21ED00CC328ADDA82E457383C91F66': { c: 0x00011677, outlen: 4 },
  '7506479DF24D07134B6A114ADD6E7EEC': { c: 0x9E7C9E7C, outlen: 4 },
  '78750486AB12BD8D8E599005FDDC2DC5': { c: 0x0000B016, outlen: 4 },
  '814487F8B49583427CE98A0D557FB1EE': { c: 0x00009CE8, outlen: 4 },
  '8349C602556708ED4601B6F624D9CFA3': { c: 0x000054A9, outlen: 4 },
  '8D18DD3E641F0AE8874B5464D931F247': { c: 0x00D887F2, outlen: 4 },
  '8E26CC75E1AA3240803481F9FF45B0CB': { c: 0x7FFFFFFE, outlen: 4 },
  '918EPB': { c: 0x000054A9, outlen: 4 },
  '918Lenk2': { c: 0x00009CE8, outlen: 4 },
  '944601F3D25CCBA6A210511751C2FF40': { c: 0x00000457, outlen: 4 },
  '95D9783BEB5C788B4358E063576B17B9': { c: 0x00011170, outlen: 4 },
  '9C8A2A7F4221D3D683D2E222E3C7A040': { c: 0x00011170, outlen: 4 },
  'AEDCE208A0C0F3058C4977948435DB08': { c: 0x0000062B, outlen: 4 },
  'B47D161D70F2B011F4F0A71BB8F19480': { c: 0x00007702, outlen: 4 },
  'B74881986F0C8ECE89CD36FB0EB54F84': { c: 0x00000C42, outlen: 4 },
  'C0A1224C57AC3FB81E4A0BD55C012228': { c: 0x00002111, outlen: 4 },
  'CamerSysteRearView_MODE1': { c: 0x00004E89, outlen: 4 },
  'CamerSysteRearView_MODE2': { c: 0x0001D6C6, outlen: 4 },
  'CamerSysteRearView_NightVisio': { c: 0x0000772F, outlen: 4 },
  'D692D19211C8FF8C4D62DAABBDF800EB': { c: 0x00006D43, outlen: 4 },
  'D7607F784BE6D97713A0678B14B20255': { c: 0x00006A2E, outlen: 4 },
  'DDF82664AD7BBFD89D6469978F70B32D': { c: 0x00004E87, outlen: 4 },
  'DME_TDI_V8': { c: 0x00006D43, outlen: 4 },
  'DriveMotorContrModul': { c: 0x00009B26, outlen: 4 },
  'EBB76889C822019AC780036F8C12AE38': { c: 0x00002FC9, outlen: 4 },
  'ECM_UDS': { c: 0x00012637, outlen: 4 },
  'EDCD8EF2E07A3CA7730968D50FB3BFFA': { c: 0x0000770B, outlen: 4 },
  'EPB': { c: 0x0000623D, outlen: 4 },
  'EPS': { c: 0x00002622, outlen: 4 },
  'F2A3BE0DBB59E382C9FA59BF279AECA4': { c: 0x0000DB19, outlen: 4 },
  'F3D774903065B4E5A9893836D30FB228': { c: 0x00004EC0, outlen: 4 },
  'FC948B24A15773BA5628A6DBCD8FEC9F': { c: 0x000336F1, outlen: 4 },
  'Frontkamera_1': { c: 0x00004E87, outlen: 4 },
  'ThermManagUDS': { c: 0x12345678, outlen: 4 },
};

/**
 * 内联特殊（3 个，每条都经解析 + 对拍 多点确认）：
 *   EMPTY      —— outLen=0，不写 key（空壳变体）
 *   NOT_TOP    —— `key = BE{outlen}((~BE32(seed)) >>> shift)`
 *   BYTES_NOT  —— `key[i] = ~seed[indices[i]]`（逐字节取反）
 */
export const INLINE_SPECIAL = {
  '0042D9949C80ED5B4FE5DF65117711A1': { kind: 'EMPTY', outlen: 0 },
  '494AD38D811996310A2886A910F892C3': { kind: 'NOT_TOP', outlen: 2, shift: 16 },
  'FDCDA878E28DE85634ACB6C3CF5A7AAB': { kind: 'BYTES_NOT', outlen: 2, indices: [0, 2] },
};

/**
 * 内联 MULADD：`key = BE(outlen)(imul(seed32, A) + B)`（32 位回绕）
 *
 * 🔑 2026-10-17：用 **仿真 真值对拍 32 点采样 + 独立复核** 合成出来的，
 *    不是猜的。⚠️ 只用 6 点会出假阳性（实测同一族能拟合出两个不同公式），
 *    32 点 + 独立求值器复核才敢收。
 *
 * ⚠️ 和 `NOT_MULADD(~seed * A' + B')` 代数恒等：`A = -A'`、`B = B' - A'`。
 *    收的是 `MULADD/id` 形式（合成器求出的那个），别再手工改写。
 */
/**
 * 变体族：**32 位 rotate+combine**（tools/gen-rc32.mjs 生成，真值对拍 32 点全过）。
 *   n = 若干 (p>>k)&m；若 (p & dirMask)!=0 → n = 0x20-n（方向用 n 取补）
 *   A = ROR32(p, n)；输出 BE32
 */
export function rotateCombine32RC(p, spec) {
  let n = spec.n(p) & 31;
  if (spec.dirMask != null && (p & spec.dirMask) !== 0) n = (0x20 - n) & 31;
  const A = u32((p >>> n) | (p << (32 - n)));
  const mode = spec.mode ? (spec.mode(p) & 3) : 0;
  const f = spec.combineMap[mode];
  return (f ? f(A, p) : A) >>> 0;
}

/**
 * 🔑 2026-10-18 第二轮收编：又拿下 16 个变体（全部 仿真 真值对拍 32 点对拍）。
 *    拆法统一：**先读静态分析 C / 汇编定骨架，再用 32 点采样逐条验**，不许猜。
 *
 * 新增家族：
 *   RC16      4 个  16 位 rotate+combine，seed 只用前 2 字节      outlen=2
 *   RC16B     2 个  同上但 n/mode 从两个 seed 字节分别抽位         outlen=2
 *   RC_VAR    2 个  变宽 rotate+combine（宽度 = seedLen）          outlen=seedLen
 *   BYTELOOP  2 个  逐字节 add/xor 迭代 31 轮                      outlen=4
 *   移位反馈32    2 个  rol1 + 条件异或 9 轮                           outlen=4
 *   RORADD26  2 个  (x + 0x54525730) 后 ror2 + 条件异或 26 轮      outlen=4
 *   CRC24     1 个  24 位位串行 CRC（按实测行为对齐）              outlen=3
 */
export const RC32_VARIANTS = {
  "DFEBB459FD90615ADC7AEE7698377B71": {
    n: (p) => (((p >>> 23) & 8) | ((p >>> 19) & 4) | ((p >>> 10) & 2) | ((p & 3) >>> 1)),
    mode: (p) => (((p >>> 17) & 2) | ((p & 127) >>> 6)),
    dirMask: 0x20000000,
    combineMap: {
    0: (A, s) => u32(A & s),
    1: (A, s) => u32(A | s),
    2: (A, s) => u32(A ^ s),
    3: (A, s) => u32(~s)
    },
  },
  // E006B2FF ：n = b12·8|b27·4|b8·2|b2；dir 位 0x40000000 → n = 32-n；mode = b22·2|b5
  // ⚠️ 位号是**直接位号**：`(p>>>k)&w` 里 w 是权重不是「再挪 k 位」，写错一位就全错。
  "E006B2FF19D9E1784A4B1E156444432B": {
    n: (p) => (((p >>> 12) & 1) << 3) | (((p >>> 27) & 1) << 2) | (((p >>> 8) & 1) << 1) | ((p >>> 2) & 1),
    mode: (p) => (((p >>> 22) & 1) << 1) | ((p >>> 5) & 1),
    dirMask: 0x40000000,
    combineMap: {
    0: (A, s) => u32(A & s),
    1: (A, s) => u32(A | s),
    2: (A, s) => u32(A ^ s),
    3: (A, s) => u32(~s)
    },
  },
};

/**
 * 16 位 rotate+combine ⚠️ **只吃 seed 的前 2 字节**（outlen=2）。
 * 骨架与 32 位同族，但 `p = seed16 << 16`，旋转/组合都在 16 位域里做。
 * 每条都是「按实测行为对齐的位抽取常量 + 32 点对拍」，改一个数就全错。
 */
export const RC16_VARIANTS = {
  // E70BF466 
  'E70BF466EE7EC94D7CA91F163898FEE5': (p) => {
    const v = (p >>> 16) & 0xffff;
    const n = (((p >>> 0x13) & 2) | ((p & 0x3fffffff) >>> 0x1d) | ((p >>> 0xf) & 0xc)) & 0x1f;
    const A = ((p >>> 0x10) & 0x400) === 0
      ? u32((v << ((0x10 - n) & 0xff)) | (v >>> n))
      : u32(v << n);
    const m = ((p >>> 0x15) & 2) | ((p & 0x1fffffff) >>> 0x1c);
    if (m === 1) return u32(A & v);
    if (m === 2) return u32(A ^ v);
    if (m === 3) return A;
    return u32(A | v);
  },
  // C1CBA4AF （seed 最高位为 1 时 v 先 |= 0xff00）
  'C1CBA4AF901F97C36CAEE016A5CC0E7B': (p) => {
    let v = (p >>> 16) & 0xffff;
    if (((p >>> 0x10) & 0x80) !== 0) v = (v | 0xff00) & 0xffff;
    const n = ((v & 4) | ((v >>> 2) & 8) | ((((v >>> 0xb) & 8) | (v & 0x10)) >>> 3)) & 0x1f;
    let a, c;
    if ((v & 0x200) === 0) { a = u32(v << n); c = u32(v >>> ((0x10 - n) & 0xff)); }
    else { a = u32(v >>> n); c = u32(v << ((0x10 - n) & 0xff)); }
    const A = u32(a | c);
    const m = ((v >>> 6) & 2) | ((v & 0xfff) >>> 0xb);
    if (m === 1) return u32(A | v);
    if (m === 2) return u32(A ^ v);
    if (m === 3) return A;
    return u32(A & v);
  },
  // 2BF9206C 
  '2BF9206CB1FA70E8D1C9333C6F06F725': (p) => {
    const v = (p >>> 16) & 0xffff;
    const n = (((p >>> 0x19) & 2) | ((p & 0x7fffff) >>> 0x16) | ((p >>> 0x10) & 4) | ((p >>> 0x1a) & 8)) & 0x1f;
    let a, c;
    if (((p >>> 0x10) & 0x10) === 0) { a = u32(v >>> n); c = u32(v << ((0x10 - n) & 0xff)); }
    else { a = u32(v << n); c = u32(v >>> ((0x10 - n) & 0xff)); }
    const A = u32(a | c);
    const m = ((p >>> 0x1d) & 2) | ((p & 0x3ffffff) >>> 0x19);
    if (m === 1) return u32(v | A);
    if (m === 2) return u32(v ^ A);
    if (m === 3) return u32(~v) & 0xffff;
    return u32(v & A);
  },
  // D2ACD9A3 
  'D2ACD9A34442B6428EF95114B14C95DB': (p) => {
    const v = (p >>> 16) & 0xffff;
    const n = (((p >>> 0x10) & 2) | ((p & 0xfffff) >>> 0x13) | ((p >>> 0x16) & 4) | ((p >>> 0xd) & 8)) & 0x1f;
    let a, c;
    if (((p >>> 0x10) & 0x1000) === 0) { a = u32(v >>> n); c = u32(v << ((0x10 - n) & 0xff)); }
    else { a = u32(v << n); c = u32(v >>> ((0x10 - n) & 0xff)); }
    const A = u32(a | c);
    const m = ((p >>> 0x13) & 2) | ((p & 0x7fffffff) >>> 0x1e);
    if (m === 1) return u32(v | A);
    if (m === 2) return u32(v ^ A);
    if (m === 3) return u32(~v) & 0xffff;
    return u32(v & A);
  },
};

/**
 * 16 位 rotate+combine（变体 B）：n / mode 的每个位各自来自 seed[0] 或 seed[1]。
 * spec 写成 [字节下标, 位号, 权重] —— 别简写成「数组顺序即权重」，第一次就栽在这上面。
 */
export const RC16B_VARIANTS = {
  // 3EF21C75 ：dir 位 = seed[0].b1（1 → ROR）
  '3EF21C75E1573EFC3E203052A35BEE5A': {
    nb: [[1, 5, 8], [1, 2, 4], [1, 4, 2], [0, 6, 1]],
    mb: [[1, 7, 2], [0, 3, 1]],
    dir: [0, 1], dirRot: 'R',
    combine: { 0: (A, w) => A & w, 1: (A, w) => A | w, 2: (A, w) => A ^ w, 3: (A) => A },
  },
  // C5A5A0A7 ：dir 位 = seed[1].b7（1 → ROL）
  'C5A5A0A78AACB928950975C88E19CF7C': {
    nb: [[0, 4, 8], [0, 7, 4], [1, 3, 2], [1, 0, 1]],
    mb: [[0, 2, 2], [1, 5, 1]],
    dir: [1, 7], dirRot: 'L',
    combine: { 0: (A, w) => (A + w) & 0xffff, 1: (A, w) => A ^ w, 2: (A, w) => (~w) & 0xffff, 3: (A) => A },
  },
};

/**
 * 变宽 rotate+combine：宽度 w = 8·seedLen，`x = BE32(seed) >>> (32-w)`。
 * n / mode / 方向位全部从 x 自己的位抽 —— 与 9X1 的 algoA/algoB 同族。
 */
export const RC_VAR_VARIANTS = {
  // 01A56221 ：combine 1=ADD 2=OR 3=AND 0=~x
  '01A562214A910B9312F157A8D16F298E': {
    nb: [1, 5, 4, 0xd], mb: [8, 0x10], dirBit: 0xc,
    combine: { 0: (A, x) => ~x, 1: (A, x) => u32(A + x), 2: (A, x) => A | x, 3: (A, x) => A & x },
  },
  // 9E46569F ：combine 1=XOR 2=AND 3=~x 0=OR
  '9E46569F8CC58E505F04D1ABE3B7602D': {
    nb: [0xb, 9, 6, 1], mb: [0x10, 2], dirBit: 0xd,
    combine: { 0: (A, x) => A | x, 1: (A, x) => A ^ x, 2: (A, x) => A & x, 3: (A, x) => ~x },
  },
};

/** 逐字节 add/xor 迭代 31 轮（常量 + 索引顺序全部按实测行为对齐） */
export const INLINE_BYTELOOP = {
  // CF204DC3 
  'CF204DC3E999C2DA3C824397DE7EDE89': (s) => {
    const k = Uint8Array.of((s[2] + 1) & 0xff, (s[0] + 2) & 0xff, (s[3] + 3) & 0xff, (s[1] + 4) & 0xff);
    let i = 0;
    do {
      const j = i % 4, t = i + 1;
      const u2 = k[j], u1 = s[t % 4];
      k[j] = (u1 + u2) & 0xff;
      k[j] = ((u1 + u2) ^ s[(i + 2) % 4]) & 0xff;
      const i4 = (i + 3) % 4;
      k[i4] = (s[j] ^ k[i4]) & 0xff;
      i = t;
    } while (i !== 0x1f);
    return k;
  },
  // ED8C844E （比 CF204DC3 多两个「按位条件」分支）
  'ED8C844E819F6BE1506FF5260ABF394E': (s) => {
    const k = Uint8Array.of((s[2] + 0x0e) & 0xff, (s[0] + 0xf0) & 0xff, (s[3] + 5) & 0xff, (s[1] + 0x60) & 0xff);
    let i = 0;
    do {
      const j = i % 4, t = i + 1, m = t % 4;
      const b5 = (s[m] + k[j]) & 0xff;
      k[j] = b5;
      const idx = (b5 & 0xaa) === 0 ? i + 3 : i + 2;
      const b1 = s[idx % 4];
      k[j] = (b5 ^ b1) & 0xff;
      if (((b5 ^ b1) & 0x55) === 0) k[m] = (k[m] ^ s[j]) & 0xff;
      else { const i2 = (i + 3) % 4; k[i2] = (k[i2] ^ s[j]) & 0xff; }
      i = t;
    } while (i !== 0x1f);
    return k;
  },
  // 42FFC7E0 （kombi_9x1_upload）：31 轮，两个「按位条件」用了 0xaf / 0xbf
  '42FFC7E0DF51DDD877EBCB99DE05677D': (s) => {
    const k = Uint8Array.of((s[2] + 0x0a) & 0xff, (s[0] + 0xb0) & 0xff, (s[3] + 0x0c) & 0xff, (s[1] + 0xd0) & 0xff);
    for (let i = 0; i < 31; i++) {
      const a = i % 4, b = (i + 3) % 4, c = (i + 2) % 4, d = (i + 1) % 4;
      k[a] = (s[b] + k[a]) & 0xff;
      const t = k[c];
      if ((t & 0xaf) === 0) k[c] = (t ^ s[d]) & 0xff;
      else k[d] = (s[b] ^ k[d]) & 0xff;
      const u = k[b];
      if ((u & 0xbf) === 0) k[b] = (s[b] ^ u) & 0xff;
      else k[a] = (k[a] ^ s[d]) & 0xff;
    }
    return k;
  },
};

/** 32 位 线性反馈移位：`x = rol1(x)`，若**移位前**的 MSB 为 1 则异或 poly */
export const INLINE_LFSR32 = {
  '76F77EB427B6238B2536CC4B6A8A13DE': { rounds: 9, poly: 0x0e442763, outlen: 4 },
  // 与 76F77EB4 完全同骨架，只有 poly 差一个字节（0x44 → 0x4a）
  '9316E2B47FC693876FA1EA72F38CA015': { rounds: 9, poly: 0x0e4a2763, outlen: 4 },
};

/** `(x + 0x54525730)` 之后 ror2，中间位为 1 时异或 poly，共 26 轮（与 mode 0x28 同骨架） */
export const INLINE_RORADD26 = {
  '1C6D563854E4E1F195DAF5890F96177B': { poly: 0x02341972, outlen: 4 },
  '0A8B1B4CF68DD51755634664F2E4F0D5': { poly: 0x02821964, outlen: 4 },
};

/**
 * 24 位位串行 CRC —— 11747BDA 。
 * ⚠️ 这条是**按实测行为对齐**来的：静态分析 把状态拆成了 uVar3/uVar8/uVar6 三个变量，
 *    化简成「24 位循环移位」会错（条件分支里混用了不同字节的位）。别去化简它。
 *    data = seed[0..2] + "SNpof"，8 字节 × 8 bit。
 */
export const INLINE_CRC24 = {
  '11747BDA7E076A2E7ECA0D533DF540EC': (seed) => {
    const data = Uint8Array.of(seed[0], seed[1], seed[2], 0x53, 0x4e, 0x70, 0x6f, 0x66);
    let u8 = 0x41, u6 = 0xa9, u3 = 0xc5, u9 = 0;
    for (let i10 = 0; i10 !== 8; i10++) {
      let u5 = 0;
      do {
        u8 = u32(((u8 & 0xff) << 8) | (u3 << 0x10));
        const u7 = u32(u8 | (u6 & 0xff));
        const u4 = u32((u6 & 1) << 0x17);
        u8 = (u8 >>> 9) >>> 0;
        u9 = u32(u4 | (u7 >>> 1));
        u6 = u32(u7 >>> 1);
        if ((data[i10] & (1 << (u5 & 0xff))) !== 0) {
          u6 = u32(u4 | ((((u3 << 0x10) & 0x1fe0000) >>> 0) >>> 1) | (u6 & 0xff) | ((u8 & 0xff) << 8));
          u9 = u32(u6 ^ 0x800000);
          u8 = (u9 >>> 8) >>> 0;
        }
        if ((u9 & 0x800000) !== 0) {
          u6 = u32((((u8 & 0xff) << 8) | (u9 & 0xff0000) | (u6 & 0xff)) ^ 0x109028);
          u8 = (u6 >>> 8) >>> 0;
          u9 = u6;
        }
        u5 = u5 + 1;
        u3 = (u9 >>> 0x10) >>> 0;
      } while (u5 !== 8);
    }
    const hi = u32(((u8 & 0xf) << 4) | ((u6 & 0xf0) >>> 4));
    const l34 = u32((u3 & 0xf) | ((u6 & 0xf) << 4)
      | ((((u9 >>> 0x14) | (u8 & 0xf0)) & 0xff) << 8) | (hi << 0x10));
    return Uint8Array.of(hi & 0xff, (l34 >>> 8) & 0xff, l34 & 0xff);
  },
};


/**
 * 32 位位串行 CRC + **收尾半字节置换** —— 7F6DED18 （EPB_VR7 / VR8）。
 *
 * ⚠️ 静态分析 在这条上静态分析返回 None，语义是**逐条读机器码**读出来的
 *    （`tools/disasm-at.py 0x248d4 0x140`），并用 仿真 在 0x2491a（内层循环头）
 *    hook 逐轮打 r0/r6/r3/r5，**72 轮状态机对拍全过**才算数。
 *
 * 状态 = 4 个字节寄存器拼成的 32 位字 S = r0<<24 | r6<<16 | r3<<8 | r5，初值 0x66C541A9。
 * 每 bit（0x2491a..0x2498e）：
 *     m = S & 1                  # 旋出去的位
 *     S = ror32(S, 1)            # bfi/orr/lsr 那一串拼出来就是循环右移
 *     S ^= bit << 31             # 数据位插到最高位（0x2495c `eor r3, r4, #0x80000000`）
 *     if (m ^ bit) S ^= 0x17109028
 *   ⚠️ 判据是 **m ^ bit**（两条分支叉乘：0x24948 `beq` 判数据位、
 *     0x24966 `cmp r5,#-1 / ble` 判 T 的 bit31），不是单独的 m 或 bit ——
 *     之前按「移出的位」建模，32 点的差值恒定是 0x301A8951（差常量 = 判据错，不是数据错）。
 *
 * data = seed[0..3] + "SNpof"（9 字节 × 8 bit）。
 *   ⚠️ 后缀来自 rodata 表 @**0x7dc28**（不是 0x7dc26）：`add r3, pc` 是 **16 位 Thumb**，
 *      PC 按 2 对齐（(addr+4)&~2），按 4 对齐算会差 2 字节 —— 已用 仿真 读 r3 复核。
 *
 * 收尾（0x2499e 起）是半字节置换（s0 = S>>24 … s3 = S&0xff），s0 的低半字节被丢掉：
 *     out[0] = s0 & 0xf0        （低半字节恒 0 —— 32 点真值表首字节低 4 位全 0，正好对上）
 *     out[1] = ((s2 & 0x0f) << 4) | (s3 >> 4)
 *     out[2] = ((s1 >> 4) & 0x0f) | (s2 & 0xf0)
 *     out[3] = (s1 & 0x0f) | ((s3 & 0x0f) << 4)
 */
export const INLINE_CRC32 = {
  '7F6DED184289B009A3EBCF9DB4EE46F7': { init: 0x66C541A9, poly: 0x17109028, outlen: 4 },
};

/**
 * XOR_MULADD：`key = imul(seed32 ^ K, A) + B`（32 位回绕）
 * 从静态分析的 C 抄常量 + 仿真 真值对拍 32 点独立复核。
 * 7 个变体共用 A=0xA953FD4E / B=0x6ED9EBA1，只有 K 不同。
 */
export const INLINE_XOR_MULADD = {
  '0B35F900BA7685F664B33786AF22FDE4': { K: 0x19DF60B2, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  '0C06174BD705DAE0356040C2503F59B2': { K: 0x03F4C55D, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  '2400B02A51433AC88778712B4E59EAAE': { K: 0xF4932BD6, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  '3F879E2AE51C814CDCDC18549BF9390A': { K: 0x23DA0E7B, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  '8360015E6692D6D5D5B4B39254B3E770': { K: 0x000003A6, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  'D61F9674EC5E918218101C97593C55E0': { K: 0x30154C8B, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  'F2C78F0089B103F8E3F6FDF102EBFDB2': { K: 0x2E76ECD9, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  // F7297A9C （SWSG_Single_Seedkey 的本体）：`mla` 指令直接给出 A/B
  'F7297A9C7AA868AE333F42BCD132C428': { K: 0x00004A62, A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
};

export const INLINE_MULADD = {
  // Allrad / KLSM / Dummy —— 静态分析 `~local_10 * -0x56AC02B2 + 0x6ED9EBA1` 的恒等形式
  'CB4E06CAEDC58D35B8055A240C1B1B89': { A: 0x56AC02B2, B: 0xC585EE53, outlen: 4 },
  // 和 CB4E06 **同算法**（参数完全一致）
  'C3E7624220B63E3BE18878067DE4748C': { A: 0x56AC02B2, B: 0xC585EE53, outlen: 4 },
  '4A56BCB78E8E8B3520DA54045957A936': { A: 0xA953FD4E, B: 0x6ED9EBA1, outlen: 4 },
  '45DB8D57164942E7619B720CA41BE22A': { A: 0x459BF1A1, B: 0xC586EE53, outlen: 4 },
  '7524586A4CA033F39A386E919795A353': { A: 0x4AB752C2, B: 0xAD5E4CEB, outlen: 4 },
  'E1D83C42C643A48F6810DFABD830CAA6': { A: 0xBA630E5F, B: 0x7FEAFCB2, outlen: 4 },
};

/**
 * NOT_MULADD：`key = imul(~seed32, A) + B`（32 位回绕）。
 * 与 `pswCalc` 里 mode 0x27 的 `NOT_MULADD` 同骨架（常量都一样）。
 */
export const INLINE_NOT_MULADD = {
  /**
   * `_NEW9x1BKE` （`ASAP1A_CCP_ComputeKeyFromSeed__NEW9x1BKE`，74 字节）。
   * 逐条读机器码：
   *   `mvn.w r0, lr` → `mla r0, r0, r3, r1`（r3=0xB548AD3E / r1=0x62A6FA29）
   *   → `key = BE32(imul(~BE32(seed), 0xB548AD3E) + 0x62A6FA29)`
   * 输出那 4 次 `strb` 用的是 `asr r0,#8`，但每次都只取低 8 位 → 恒等于 BE32。
   * ⚠️ seed 长度：函数**根本不看 param_2**，无条件 `ldrb r0,[r0+r1] (r1=0..3)` 读 4 字节。
   *   旧 `seedkey.js` 里写的 `seedBytes:2` 是那张 stub 表的默认值（30 条全是 2），
   *   **不是证据** —— 按 4 字节实现，调用方传非 4 字节一律拒算。
   */
  '_NEW9x1BKE': { A: 0xB548AD3E, B: 0x62A6FA29, outlen: 4, seedLen: 4 },
};

/**
 * 待挖的内联 OTHER（rotate + combine 族为主）。
 *
 * 结构已定性（2026-10-17 解析指纹）：都是 **rotate + combine** 骨架，
 * 与 9X1 的 algoA/algoB 同族 —— 旋转次数 n、方向、组合模式都从 **seed 自己的位** 算出来，
 * 所以没有常量公式可用，必须逐个拆位布局。
 * 样本见 analysis/SEEDKEY-SHAPES.json + /tmp/pend-samples.json（32 点 真值对拍）。
 */
/**
 * ✅ **已清空**（2026-10-18 第六轮）：最后两条都已收编，name-map 71/71 全可算。
 *
 * - `7F6DED184289B009A3EBCF9DB4EE46F7` → `INLINE_CRC32`
 *     卡点复盘：不是「收尾半字节置换没对上」（置换本身早就对了），
 *     而是 **rodata 表地址差了 2 字节** —— `add r3, pc` 是 16 位 Thumb，
 *     PC 按 2 对齐；按 4 对齐算得 0x7dc26，真正的表在 **0x7dc28**，
 *     于是后缀取成 `00 00 53 4e 70` 而不是 `53 4e 70 6f 66`("SNpof")。
 *     32 点的差值恒定 0x301A8951 就是这个数据错的指纹（常量差 = 数据/初值错，
 *     判据错会随 seed 变）。用 仿真 在 0x2491a hook 逐轮打 r0/r6/r3/r5 定位。
 * - `_NEW9x1BKE` → `INLINE_NOT_MULADD`（，74 字节，`mla` 直接给常量）
 *
 * 留空数组是为了让 smoke 的「INLINE_OTHER_PENDING 仍在收窄」断言继续有意义。
 */
export const INLINE_OTHER_PENDING = [];

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
// 32 位 rotate+combine 执行器（本文件定义于 RC32_VARIANTS 之前）
const u32 = (x) => x >>> 0;
const be32 = (b) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
const toBE = (x, n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (x >>> (8 * (n - 1 - i))) & 0xff;
  return out;
};

/**
 * 按变体 ID 算 key。
 * @param {string} id  变体 ID，如 'E3_RDK' / 'EPB' / MD5 形式
 * @param {Uint8Array} seed  4 字节
 * @returns {{key: Uint8Array, algo: string, outlen: number}}
 */
export function computeVariantKey(id, seed) {
  const s32 = be32(seed);
  if (id in INLINE_CRC24) {
    const k = INLINE_CRC24[id](seed);
    return { key: k, algo: 'CRC24', outlen: k.length };
  }
  if (id in INLINE_CRC32) {
    // 32 位位串行 CRC + 收尾半字节置换（data = seed[0..3] + "SNpof"）
    const t = INLINE_CRC32[id];
    // C 里 `ldr r0,[r0]` 一次取 4 字节 —— 不足 4 字节会越界读，**必须拒算**
    if (seed.length < 4) {
      throw new Error(`变体 ${id} 需要 >=4 字节 seed（C 里 ldr 一次取 4 字节），收到 ${seed.length} 字节`);
    }
    const data = Uint8Array.of(seed[0], seed[1], seed[2], seed[3], 0x53, 0x4e, 0x70, 0x6f, 0x66);
    let S = t.init >>> 0;
    for (let k = 0; k < data.length; k++) {
      const b = data[k];
      for (let i = 0; i < 8; i++) {
        const bit = (b >> i) & 1;
        const m = S & 1;
        S = (((S >>> 1) | (m << 31)) ^ (bit << 31)) >>> 0;
        // ⚠️ 判据是 m ^ bit，不是 m（按 m 建模 32 点全差常量 0x301A8951）
        if ((m ^ bit) & 1) S = (S ^ t.poly) >>> 0;
      }
    }
    const s0 = (S >>> 24) & 0xff, s1 = (S >>> 16) & 0xff, s2 = (S >>> 8) & 0xff, s3 = S & 0xff;
    return {
      key: Uint8Array.of(
        s0 & 0xf0,
        ((s2 & 0x0f) << 4) | (s3 >> 4),
        ((s1 >> 4) & 0x0f) | (s2 & 0xf0),
        (s1 & 0x0f) | ((s3 & 0x0f) << 4),
      ),
      algo: 'CRC32',
      outlen: t.outlen,
    };
  }
  if (id in INLINE_BYTELOOP) {
    // 逐字节迭代：直接吃原始 seed 字节（顺序敏感，不能压成 u32）
    const k = INLINE_BYTELOOP[id](seed);
    return { key: k, algo: 'BYTELOOP', outlen: k.length };
  }
  if (id in INLINE_LFSR32) {
    const t = INLINE_LFSR32[id];
    let x = s32;
    for (let i = 0; i < t.rounds; i++) {
      const old = x;
      x = u32((x << 1) | (x >>> 31));
      if ((old & 0x80000000) !== 0) x = u32(x ^ t.poly);
    }
    // ⚠️ algo 标签会出现在 UI 上（发版面），不能用算法学名 —— 用中性描述名。
    return { key: toBE(x, t.outlen), algo: 'SHIFT_XOR32', outlen: t.outlen };
  }
  if (id in INLINE_RORADD26) {
    const t = INLINE_RORADD26[id];
    let x = s32;
    for (let i = 0; i < 26; i++) {
      const v = u32(x + 0x54525730);
      // 静态分析 `(v>>1 | x<<31) >> 1 | (v>>1)<<31` 恒等于 ROR(v, 2)；条件位 = v 的 bit1
      let y = u32((v >>> 2) | (v << 30));
      if ((v & 2) !== 0) y = u32(y ^ t.poly);
      x = y;
    }
    return { key: toBE(x, t.outlen), algo: 'RORADD26', outlen: t.outlen };
  }
  if (id in RC16_VARIANTS) {
    // ⚠️ 只吃前 2 字节：p = seed16 << 16
    const p = u32(((seed[0] << 8) | seed[1]) << 16);
    const A = u32(RC16_VARIANTS[id](p));
    return { key: Uint8Array.of((A >>> 8) & 0xff, A & 0xff), algo: 'RC16', outlen: 2 };
  }
  if (id in RC16B_VARIANTS) {
    const spec = RC16B_VARIANTS[id];
    const w = ((seed[0] << 8) | seed[1]) & 0xffff;
    const bi = (bx, k) => (seed[bx] >> k) & 1;
    let n = 0, mode = 0;
    for (const [bx, k, wt] of spec.nb) n |= bi(bx, k) * wt;
    for (const [bx, k, wt] of spec.mb) mode |= bi(bx, k) * wt;
    const rot = bi(spec.dir[0], spec.dir[1]) === 1 ? spec.dirRot : (spec.dirRot === 'L' ? 'R' : 'L');
    let A = w;
    if (n !== 0) {
      A = rot === 'R'
        ? ((w >>> n) | (w << (16 - n))) & 0xffff
        : ((w << n) | (w >>> (16 - n))) & 0xffff;
    }
    const r = spec.combine[mode](A, w) & 0xffff;
    return { key: Uint8Array.of((r >>> 8) & 0xff, r & 0xff), algo: 'RC16B', outlen: 2 };
  }
  if (id in RC_VAR_VARIANTS) {
    const spec = RC_VAR_VARIANTS[id];
    const seedLen = seed.length;
    const w = seedLen * 8, sh = 0x20 - w;
    const x = (s32 >>> sh) >>> 0;
    const bit = (k) => (x >>> (w - k)) & 1;
    let n = 0, mode = 0;
    for (let i = 0; i < spec.nb.length; i++) n |= bit(spec.nb[i]) << i;
    for (let i = 0; i < spec.mb.length; i++) mode |= bit(spec.mb[i]) << i;
    const mask = (w === 32) ? 0xffffffff : ((1 << w) - 1) >>> 0;
    const shl = (v, k) => (k >= 32 ? 0 : u32(v << k)) & mask;
    const A = (bit(spec.dirBit) === 0
      ? shl(x, n) | (x >>> (w - n))
      : shl(x, w - n) | (x >>> n)) & mask;
    const r = u32(spec.combine[mode](A, x));
    return { key: toBE(u32(r << sh), 4), algo: 'RC_VAR', outlen: seedLen };
  }
  if (id in INLINE_VM_PROGRAMS) {
    // 内联 VM（解释器被编译器内联进变体函数体）—— 见 INLINE_VM_PROGRAMS 注释
    const k = inlineVmRun(s32, hexToBytes(INLINE_VM_PROGRAMS[id]));
    if (k == null) throw new Error(`变体 ${id} 的内联 VM 遇到未定义指令/死循环 —— 拒绝猜测`);
    return { key: toBE(k, 4), algo: 'INLINE_VM', outlen: 4 };
  }
  if (id in SA2_PROGRAMS) {
    const t = SA2_PROGRAMS[id];
    return { key: computeKey(seed, hexToBytes(t.prog)), algo: 'SA2', outlen: t.outlen };
  }
  if (id in INLINE_ADD) {
    const t = INLINE_ADD[id];
    return { key: toBE((s32 + t.c) >>> 0, t.outlen), algo: 'ADD', outlen: t.outlen };
  }
  if (id in INLINE_XOR_MULADD) {
    const t = INLINE_XOR_MULADD[id];
    // key = imul(seed32 ^ K, A) + B —— 真值对拍 32 点独立复核
    return { key: toBE((Math.imul(s32 ^ t.K, t.A) + t.B) >>> 0, t.outlen), algo: 'XOR_MULADD', outlen: t.outlen };
  }
  if (id in INLINE_MULADD) {
    const t = INLINE_MULADD[id];
    // key = imul(seed32, A) + B（32 位回绕）—— 真值对拍 32 点 + 独立复核
    return { key: toBE((Math.imul(s32, t.A) + t.B) >>> 0, t.outlen), algo: 'MULADD', outlen: t.outlen };
  }
  if (id in INLINE_NOT_MULADD) {
    const t = INLINE_NOT_MULADD[id];
    // C 里**不看 seedLen**，无条件 `ldrb` 读 4 字节 —— 不足 4 字节会越界读，**必须拒算**
    if (seed.length < (t.seedLen ?? 4)) {
      throw new Error(`变体 ${id} 只读 ${t.seedLen ?? 4} 字节 seed，收到 ${seed.length} 字节`);
    }
    return { key: toBE((Math.imul((~s32) >>> 0, t.A) + t.B) >>> 0, t.outlen), algo: 'NOT_MULADD', outlen: t.outlen };
  }
  if (id in RC32_VARIANTS) {
    // 32 位 rotate+combine（方向用 n 取补），真值对拍 32 点全过
    return { key: toBE(rotateCombine32RC(s32, RC32_VARIANTS[id]), 4), algo: 'RC32', outlen: 4 };
  }
  if (id in INLINE_SPECIAL) {
    const t = INLINE_SPECIAL[id];
    if (t.kind === 'EMPTY') return { key: new Uint8Array(0), algo: 'EMPTY', outlen: 0 };
    if (t.kind === 'NOT_TOP') return { key: toBE(((~s32) >>> 0) >>> t.shift, t.outlen), algo: 'NOT_TOP', outlen: t.outlen };
    if (t.kind === 'BYTES_NOT') {
      const out = new Uint8Array(t.indices.length);
      for (let i = 0; i < t.indices.length; i++) out[i] = (~seed[t.indices[i]]) & 0xff;
      return { key: out, algo: 'BYTES_NOT', outlen: t.outlen };
    }
  }
  throw new Error(`变体 ${id} 尚未逆出（内联 OTHER 待挖）`);
}

export { computeKey };
