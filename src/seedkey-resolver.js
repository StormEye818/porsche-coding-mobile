/**
 * 编码写入安全访问的**端到端密钥解析器**
 *
 * 🔑 2026-10-17 · 全链路照抄 原厂（`core.so` +
 *    `core.so` + `links.dat`）
 *
 * ## 完整调用链（原厂 权威）
 * ```
 * SendSysSeedKey(TOKEN*)                        工具链DWRITE.so
 *   │  地址表查询("links.dat") ← ECU→mode→LID
 *   └─ PorscheKeySendCmd(mode)
 *        ├─ 发 4 字节命令模板（rodata 6 对）
 *        └─ securityModel(session, mode)   ENTERSYSPASSWORD.so
 *             ├─ 取 seed（2 或 4 字节大端）
 *             ├─ switch(mode):
 *             │    mode ≤0x77  → 内联公式 / mode
 *             │    mode 0xB0..0xED → stdSeedKey(mode,seed,len)
 *             │        └─ switch(mode) → ASAP1A_CCP_ComputeKeyFromSeed_<ECU>
 *             │                            ↑ 已 校验 验证 97/135
 *             └─ 回发 key：27 05 01 <4B> / 27 03 04 <2B>
 * ```
 *
 * ## 覆盖状态（DRIVELINKS 980 条记录实测）
 * | 桶 | 记录数 | 占比 | 状态 |
 * |---|---|---|---|
 * | 内联公式 | 279 | 28.5% | ✅ |
 * | ASAM→ASAP1A | 99 | 10.1% | ✅ |
 * | mode | 261 | 26.6% | ⏳ 待逆 |
 * | 无算法（key=0） | 341 | 34.8% | 🔶 待确认：是「无需解锁」还是漏了分支 |
 *
 * ⚠️ **算不了的绝不猜** —— `resolveKey` 会抛 `SeedKeyUnresolvedError`，
 *    调用方必须拒写，绝不静默用 0 或错 key（审计红线）。
 */

import { pswCalc, INLINE_MODES, PENDING_MODES, ROTATE_COMBINE_MODES, ROTATE_COMBINE32_MODES, FEISTEL_MODES, WORDVM_PROGRAMS, RAW_MODE_FNS } from './seedkey-pswcalc.js';
import { computeVariantKey, SA2_PROGRAMS, INLINE_ADD, INLINE_SPECIAL, INLINE_MULADD } from './seedkey-registry.js';
import { variantForName } from './seedkey-name-map.js';
import { nonAsapResolve, computeNonAsapKey, NON_ASAP_BY_NAME, platformForModel } from './seedkey-nonasap.js';

/** 算不出 key 时抛这个，调用方必须拒写 */
export class SeedKeyUnresolvedError extends Error {
  constructor(mode, ecuId, why) {
    super(`seed/key 未解析：mode=0x${(mode ?? 0).toString(16).padStart(2, '0')} ` +
          `ecu=${ecuId != null ? '0x' + ecuId.toString(16) : '?'} —— ${why}。` +
          `按 原厂 该分支还没逆出来，**拒绝写入**（绝不猜 key，猜错 = NRC 0x35 → 0x36 锁死）。`);
    this.name = 'SeedKeyUnresolvedError';
    this.mode = mode;
    this.ecuId = ecuId;
  }
}

/**
 * `stdSeedKey` 的 mode → ASAP1A 变体 ID（从 `stdSeedKey`  逐条抄出）。
 * 只覆盖 0xB0..0xBC 与 0xE0..0xED；**中间 0xBD..0xDF 与区间外无 case**，
 * 原厂 里那些会保持 outLen=0 → key=0。
 */
export const ASAM_MODE_TO_VARIANT = {
  0xb0: 'DFEBB459FD90615ADC7AEE7698377B71',
  0xb1: '3D5365460CB39FEFC14651DF5075A1B8',
  0xb2: '9E95AD479750DBABF9068A886EC37CE7',
  0xb3: '91C0B71C660408DF11A4C211006FB913',
  0xb4: 'C0A1224C57AC3FB81E4A0BD55C012228',
  0xb5: '944601F3D25CCBA6A210511751C2FF40',
  0xb6: '01EA0D371104956F002D33636F6CD69B',
  0xb7: 'C3E7624220B63E3BE18878067DE4748C',
  0xb8: 'F7297A9C7AA868AE333F42BCD132C428',
  0xb9: '0C06174BD705DAE0356040C2503F59B2',
  0xba: '2400B02A51433AC88778712B4E59EAAE',
  0xbb: '2847060DAFC70146BFC0E3703791D0F8',
  0xbc: '8D18DD3E641F0AE8874B5464D931F247',
  0xe0: '918Aero',
  0xe1: '918BKV',
  0xe2: '918TBF',
  0xe3: '918EPB',
  0xe4: '918Lenk2',
  0xe5: 'DME_TDI_V8',
  0xe6: 'Frontkamera_1',
  0xe7: 'RealTopview',
  0xe8: 'Allrad_Gen1',
  0xe9: 'ECM_UDS',
  0xea: 'EPB',
  0xeb: 'EPS',
  0xec: 'BMS2',
  0xed: 'BatteCM',
};

/** `stdSeedKey` 收尾：按 outLen 归一 key（含 4 字节的字节交换） */
function asamFinalize(rawKey, outlen) {
  if (!outlen) return 0;
  if (outlen === 2) return ((rawKey & 0xff) << 8) | ((rawKey >>> 8) & 0xff);
  // 4 字节：原厂 是 `b1<<16 | b0<<24 | (b2>>16)<<8 | b3>>24` ≡ 字节交换
  const b = [(rawKey >>> 24) & 0xff, (rawKey >>> 16) & 0xff, (rawKey >>> 8) & 0xff, rawKey & 0xff];
  return ((b[1] << 16) | (b[0] << 24) | (b[2] << 8) | b[3]) >>> 0;
}

/**
 * 端到端解析：ECU → key。
 *
 * @param {number} mode   DRIVELINKS 的 mode 字节（securityModel 的 param_2）
 * @param {number} seed   32 位无符号 seed
 * @param {object} [ctx]  { ecuId, session, len }
 * @returns {{key: number, algo: string, mode: number, outlen: number}}
 * @throws {SeedKeyUnresolvedError} 该 mode 的算法还没逆出来 —— 调用方必须拒写
 */
export function resolveKey(mode, seed, ctx = {}) {
  const s = seed >>> 0;
  const ecuId = ctx.ecuId;

  // ⓪ mode 0xa0：securityModel case 0xa0 → PorscheComputeKeyFromSeed(seed,4,"SWSG_Single_Seedkey")
  //    → 变体 F7297A9C7AA868AE333F42BCD132C428（XOR_MULADD，已实现）
  //    静态分析证据：case 0xa0 把 "SWSG_Single_Seedkey" 写进栈缓冲后递归调变体分发器
  if (mode === 0xA0) {
    const r = computeVariantKey('F7297A9C7AA868AE333F42BCD132C428',
      new Uint8Array([(s>>>24)&0xff, (s>>>16)&0xff, (s>>>8)&0xff, s&0xff]));
    const raw = ((r.key[0]<<24)|(r.key[1]<<16)|(r.key[2]<<8)|r.key[3]) >>> 0;
    return { key: raw, algo: 'VARIANT/SWSG_Single_Seedkey', mode, outlen: r.outlen || 4, needsKey: true };
  }

  // ① 内联公式 / rotate+combine / 原语直译（securityModel 的 mode ≤0x77 分支）
  if (mode in INLINE_MODES || mode in ROTATE_COMBINE_MODES || mode in ROTATE_COMBINE32_MODES
      || mode in FEISTEL_MODES || mode in WORDVM_PROGRAMS || mode in RAW_MODE_FNS) {
    return { ...pswCalc(mode, s), mode, outlen: 4, needsKey: true };
  }

  // ② stdSeedKey → ASAP1A 变体（mode 0xB0..0xED 有 case）
  const vid = ASAM_MODE_TO_VARIANT[mode];
  if (vid) {
    const bytes = new Uint8Array([(s >>> 24) & 0xff, (s >>> 16) & 0xff, (s >>> 8) & 0xff, s & 0xff]);
    let r;
    try {
      // ⚠️ 必须走 computeVariantKey 全家族分发（SA2 / ADD / MULADD / XOR_MULADD / RC32 / SPECIAL）。
      //    早先只放行 SA2 与 ADD/SPECIAL，`0xB7`（C3E76242，MULADD 族）会被误判「尚未逆出」。
      r = computeVariantKey(vid, bytes);
    } catch (e) {
      throw new SeedKeyUnresolvedError(mode, ecuId,
        `stdSeedKey 分发到变体 ${vid}，但该变体尚未逆出（${e.message}）`);
    }
    // stdSeedKey 的收尾（按实际 key 字节数归一，再走字节交换）
    // ⚠️ 早先写死取 4 字节：2 字节 key 时 keyBytes[2]/[3] 是 undefined，
    //    算出来恒为 0 —— 现在按真实长度拼。（当前 ASAM 表里全是 4 字节，但别再踩）
    let raw = 0;
    for (let i = 0; i < r.key.length && i < 4; i++) raw = ((raw << 8) | r.key[i]) >>> 0;
    return { key: asamFinalize(raw, r.outlen), algo: `${r.algo}/${vid.slice(0, 12)}`,
             mode, outlen: r.outlen, needsKey: (r.outlen | 0) !== 0 };
  }

  // ③ 明确列在 PENDING_MODES 里的（包括 0xA0 >0x77）—— 还没逆，必须报「待逆」，
  //    不能被下面的 `mode > 0x77` 误当成「原厂无 case」。0xA0 是 computeKeyByVariant
  //    的真实 switch 分支，只是还没做；当成 no-case 会让 UI 显示「不需 key」，语义错。
  const pendingName = PENDING_MODES[mode];
  if (pendingName) {
    throw new SeedKeyUnresolvedError(mode, ecuId, `走外部例程 ${pendingName}`);
  }

  // ④ 区间外：原厂 的 stdSeedKey 保持 outLen=0 → key=0
  //
  // ⚠️ 2026-10-18 澄清语义（此前差点酿成锁车）：
  //    `outlen: 0` 的含义是「**原厂 该 mode 没有 case，不需要发 key**」，
  //    **不是**「算法算出来 key = 0」。这两者在写入路径上是天壤之别：
  //      - 当成「key=0」→ 发出 `27 0A 00000000` → NRC 0x35 → 重试吃满 → **0x36 锁死**
  //      - 当成「无需解锁」→ ECU 回全零 seed 时直接放行；回非零 seed 时**拒写**
  //    所以这里必须带 `needsKey: false`，让调用方（securityAccessEx）能区分。
  //    受影响的 DRIVELINKS 记录有 334/980 条（34.1%），覆盖 mode 0x7d..0xfe 一大片。
  if (mode > 0x77) {
    return { key: 0, algo: 'NO_ALGO(无 case)', mode, outlen: 0, needsKey: false };
  }

  // ⑤ mode 0x00 —— securityModel 的 switch **没有 case 0**（112 个 case 里唯独缺它）
  //    → 落到 default → ASAM_SeedKey(0) → `if (mode-0xb0 < 0x3e)` 不成立 → 不设 outLen
  //    → **不发 key**。所以它是「原厂无 case」，不是缺口（2026-10-19 REA 证实）。
  //    ⚠️ 只对 0x00 特判，不搞一刀切：1..0x7b/0x89 都有 case，实现缺失时仍应报错。
  if (mode === 0x00) {
    return { key: 0, algo: 'NO_ALGO(securityModel 无 case 0)', mode, outlen: 0, needsKey: false };
  }

  // ⑥ mode ≤0x77 但既没有实现、也没有 PENDING 记录 —— 数据/代码不一致
  throw new SeedKeyUnresolvedError(mode, ecuId, `未知 mode 0x${mode.toString(16)}`);
}

/** 覆盖统计（DRIVELINKS 980 条口径） */
export function coverageSummary(rows) {
  const b = { inline: 0, asam: 0, pending: 0, zero: 0 };
  for (const r of rows) {
    const m = r.mode;
    if (m in INLINE_MODES || m in ROTATE_COMBINE_MODES || m in ROTATE_COMBINE32_MODES
        || m in FEISTEL_MODES || m in WORDVM_PROGRAMS || m in RAW_MODE_FNS) b.inline++;
    else if (ASAM_MODE_TO_VARIANT[m]) b.asam++;
    else if (PENDING_MODES[m] || m <= 0x77) b.pending++;
    else b.zero++;
  }
  return b;
}

/**
 * 某个 mode 现在能不能算 key（给 UI 预检用，不用真 seed）。
 * 不抛异常：能算返回 true。
 */
export function canResolveMode(mode) {
  if (mode in INLINE_MODES || mode in ROTATE_COMBINE_MODES || mode in ROTATE_COMBINE32_MODES
      || mode in FEISTEL_MODES || mode in WORDVM_PROGRAMS || mode in RAW_MODE_FNS) return true;
  const vid = ASAM_MODE_TO_VARIANT[mode];
  if (vid) {
    try { computeVariantKey(vid, new Uint8Array(4)); return true; } catch (e) { return false; }
  }
  if (PENDING_MODES[mode]) return false;
  return mode > 0x77;      // 原厂 stdSeedKey 无 case → key=0，不算「未实现」
}

export { pswCalc, INLINE_MODES, PENDING_MODES };

/**
 * 造一个 `coder.seedKeyProvider` 插槽值，走 原厂 的 mode 表。
 * 供 `coder.securityAccess` 直接用；算不出的会抛 SeedKeyUnresolvedError（调用方拒写）。
 *
 * @param {number} mode   DRIVELINKS 的 mode
 * @param {object} [ctx]  { ecuId, name }
 */
export function makeResolverProvider(mode, ctx = {}) {
  // 先探一次，把「该 mode 到底要不要发 key」定下来（seed=0 是合法输入，纯函数无副作用）
  let needsKey = true;
  try {
    needsKey = (resolveKey(mode, 0, ctx).outlen | 0) !== 0;
  } catch (e) {
    // 算不出来 → 保守按「要 key」，让 securityAccessEx 走拒写分支
    needsKey = true;
  }
  return {
    name: `原厂-mode-0x${(mode >>> 0).toString(16).padStart(2, '0')}` +
          (ctx.name ? `(${ctx.name})` : ''),
    verified: true,          // 算法本身是照抄 原厂 的；变体覆盖见 coverageSummary
    mode,
    // ⚠️ false = 原厂 stdSeedKey 里这个 mode 没有 case，不需要发 key。
    //    securityAccessEx 用它区分「无需解锁」与「算法算不出」，两者都拒发但报错要不同。
    needsKey,
    calc(seedBytes, _level) {
      const b = Array.from(seedBytes);
      if (b.length === 2) {
        // 2 字节 seed：原厂 里 uVar8 = CONCAT11(b0,b1)，仍当 u32 用
        var s = ((b[0] << 8) | b[1]) >>> 0;
      } else if (b.length === 4) {
        s = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      } else {
        throw new Error(`seed 长度 ${b.length} ≠ 2/4，拒绝计算（绝不静默截断）`);
      }
      const r = resolveKey(mode, s, ctx);
      const n = r.outlen | 0;
      // ⚠️ 必须按 outlen 取**低 n 字节**，不能一律返回 4 字节（2026-10-18 修）：
      //    outlen=0（原厂 无 case）时此前返回 `00 00 00 00`，会被当成真 key 发出去
      //    → NRC 0x35 → 重试吃满 → 0x36 锁死。现在返回空数组，由 securityAccessEx 拦住。
      //    outlen=2 时 asamFinalize 已把结果放进低 16 位，取低 2 字节即可。
      if (n === 0) return new Uint8Array(0);
      const k = r.key >>> 0;
      const all = [(k >>> 24) & 0xff, (k >>> 16) & 0xff, (k >>> 8) & 0xff, k & 0xff];
      return Uint8Array.from(all.slice(4 - Math.min(n, 4)));
    },
  };
}

/**
 * 按 **ECU 名字**算 key —— 走 原厂 的 `nameTable` 名字表。
 *
 * 这是「和 参考诊断仪 对齐」的正解：名字来自车辆数据/编码条目，
 * 直接查权威映射表选变体，不猜、不造别名。
 *
 * @param {string} name   ECU 名字（如 'ASAM_seedkey_PSM' / 'E3_RDK'）
/**
 * 按名字算 key —— 走 原厂 的 `nameTable` 名字表。
 *
 * @param {string} name   ECU 名字 / 函数名（如 'ASAM_seedkey_PSM' / 'SecurityAccess_9x7_ALLRAD'）
 * @param {number|Uint8Array|number[]|null} seed
 *        原始 seed 字节（**推荐**，非 ASAP1A 的 seedLen 是 2，压成 32 位会丢字节），
 *        或 32 位 seed（ASAP1A 路径）。
 *        传 null 表示只查算法是否存在（写入闸门预检）。
 * @param {object} [ctx]  { platform, module } —— 非 ASAP1A 的**平台限定**模块映射
 *        （`BV_SteerAssisUDS` 跨 5 个平台，必须知道平台才能选对算法）
 * @returns {{key: Uint8Array|null, variant: string|null, algo: string}}
 * @throws {SeedKeyUnresolvedError} 名字不在表里，或变体尚未实现
 */
export function resolveKeyByName(name, seed, ctx = {}) {
  // —— 输入归一：拿原始字节 + 32 位 ——
  let bytes = null;
  let s32 = null;
  if (seed != null) {
    if (seed instanceof Uint8Array) bytes = seed;
    else if (Array.isArray(seed)) bytes = Uint8Array.from(seed);
    if (bytes) {
      if (bytes.length === 2) s32 = ((bytes[0] << 8) | bytes[1]) >>> 0;
      else if (bytes.length === 4) {
        s32 = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      } else {
        throw new SeedKeyUnresolvedError(null, null,
          `seed 长度 ${bytes.length} ≠ 2/4，拒绝计算（绝不静默截断/补零）`);
      }
    } else {
      s32 = seed >>> 0;
    }
  }

  // ⓪ 非 ASAP1A 入口 —— **只做精确匹配**，抢在 ASAP1A 模糊匹配之前。
  //    理由：`ASAM_seedkey_Airbag`（ASAP1A 正解）和
  //    `ASAM_seedkey_Airbag_Upload_CONFIDENTIAL`（非 ASAP1A）是两个东西，
  //    模糊匹配会把对的算成错的 → NRC 0x35 → 0x36 锁死。
  //    `Allrad` / `PSM` / `Airbag` 这类模块名**不放**进非 ASAP1A 表，
  //    它们在 ASAP1A 名字表里已有正解（见 seedkey-nonasap.js 头注释）。
  const na = nonAsapResolve(name, ctx.platform, ctx.module);
  if (na) {
    if (seed == null) {
      if (na.pending) {
        throw new SeedKeyUnresolvedError(null, null, `「${name}」算法（${na.algo}）尚未实现`);
      }
      return { key: null, variant: null, algo: na.algo, nonAsap: true };
    }
    // 非 ASAP1A 必须拿**原始 seed 字节**（seedLen 可能是 2）
    let nb;
    if (bytes) nb = bytes;
    else {
      // 只给 32 位时：它就是 BE32，函数读的是**前 seedLen 字节** → 取高位
      // ⚠️ 别写成取低位（2026-10-17 踩过：那样 0x12340000 会算成 [0,0]）
      const n = na.seedLen ?? 4;
      nb = new Uint8Array(n);
      for (let i = 0; i < n; i++) nb[i] = (s32 >>> (24 - 8 * i)) & 0xff;
    }
    const r = computeNonAsapKey(name, nb);
    return { key: r.key, variant: null, algo: r.algo, nonAsap: true };
  }

  const variant = variantForName(name);
  if (!variant) {
    throw new SeedKeyUnresolvedError(null, null,
      `名字「${name}」不在 原厂 的 nameTable 名字表里（138 条）`);
  }
  const sb = bytes || new Uint8Array([
    (s32 >>> 24) & 0xff, (s32 >>> 16) & 0xff, (s32 >>> 8) & 0xff, s32 & 0xff,
  ]);
  // ⚠️ 走**全家族**分发：早先只放行 SA2/ADD/MULADD/SPECIAL，
  //    名字落在 XOR_MULADD（如 0C06174B）或 RC32（如 DFEBB459）的 ECU 会被
  //    误判「尚未实现」→ 明明能算却被拒写。
  if (seed == null) {
    // 预检模式：只判断算法在不在，不真的算
    try {
      computeVariantKey(variant, new Uint8Array(4));
      return { key: null, variant, algo: 'ok' };
    } catch (e) {
      throw new SeedKeyUnresolvedError(null, null,
        `变体 ${variant}（名字「${name}」）尚未实现`);
    }
  }
  try {
    const r = computeVariantKey(variant, sb);
    return { ...r, variant };
  } catch (e) {
    throw new SeedKeyUnresolvedError(null, null,
      `变体 ${variant}（名字「${name}」）尚未实现`);
  }
}
