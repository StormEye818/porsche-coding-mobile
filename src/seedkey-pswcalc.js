/**
 * securityModel —— **编码写入安全访问的权威密钥算法**
 *
 * 🔑 2026-10-17 · 从 原厂 保时捷诊断包 `core.so`
 *    `securityModel` @静态分析 … 逐行照抄（50KB 伪代码 → 12.5KB 精简）。
 *    **这就是「和 参考诊断仪 对齐」的落点** —— 不是猜的，是抄的。
 *
 * ## 调用链（编码写入的完整安全访问路径）
 * ```
 * SendSysSeedKey(TOKEN*)                        core.so 
 *   └─ PorscheKeySendCmd(mode)                 选 4 字节命令模板对（rodata 6 对）
 *        └─ securityModel(session, mode)  ← 本文件
 *             ├─ 发取 seed 命令 → 收 seed（2 或 4 字节大端）
 *             ├─ switch(mode) 算 key
 *             └─ 回发 key：27 05 01 <4B> / 27 03 04 <2B>
 * ```
 *
 * ## 命令模板（rodata，各 4 字节）
 * ```
 * 0x88d76  01 02 10 03      0x88d7b  01 02 10 4F
 * 0x88d80  01 02 10 89      0x88d85  01 02 10 86   ← 89 = 会话
 * 0x88d8a  01 02 10 85      0x88d8f  01 02 10 88
 * ```
 *
 * ## session（securityModel 的 param_1）决定取 seed 的命令与 seed 宽度
 * | session | 取 seed 命令 | 响应长度 | seed 宽度 |
 * |---|---|---|---|
 * | `0x000` | `&0x88d72`（3 字节） | 2 | **2 字节** |
 * | `0x100` | `&0x88d68`（4 字节） | 4 | 4 |
 * | `0x102` | `&0x88d68` | 3 或 4 | 3→4 字节 / 2→2 字节 |
 * | `0x304` | `&0x88d63` | 3 或 4 | 同上 |
 * | `0x506` | `&0x88d6d` | 3 或 4 | 同上 |
 *
 * ## mode（param_2）表 —— 内联公式部分（可直接用，无外部依赖）
 * 已与本项目 `seedkey-registry.js` 的 44 个 INLINE_ADD 常数逐条对上 ✅
 *
 * ⚠️ 调 `mode` / `stdSeedKey` / `algo-cayenne` 等的分支
 *    见 `PENDING_MODES`，那些还要单独逆（函数体各自独立）。
 */

/** 32 位无符号包装 */
import { sa2Run } from './seedkey-sa2.js';
import { wordVmRun } from './seedkey-wordvm.js';
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const u32 = (x) => x >>> 0;
/** 有符号 32 位（对齐 C 的 `(int)` 语义，只用于算术右移） */
const i32 = (x) => x | 0;

/**
 * mode → key 的**内联公式**（照抄 原厂 switch，无外部调用）。
 * 形式：`{ kind, … }`，kind 取：
 *   ADD   key = seed + c
 *   XOR   key = seed ^ c
 *   NOT   key = ~seed        （可带 mask）
 *   ID    key = seed
 *   ZERO  key = 0
 *   CONST key = c
 *   MULADD key = seed * mul + add
 *   POLY3 三次多项式
 *   BSWAP_MUL 字节交换后乘
 */
export const INLINE_MODES = {
  // 0x48 = key = ~seed32  —— `mode 0x48`  size=136（真函数），
  //   仿真 真值对拍 32 点 + 独立复核通过。合成形式 MULADD(A=-1,B=-1) ≡ NOT。
  0x48: { kind: 'NOT' },
  0x03: { kind: 'MULADD', mul: 0xBA630E5F, add: 0x7FEAFCB2 },   // seed * -0x459cf1a1 + 0x7feafcb2
  0x21: { kind: 'MULADD', mul: 0xBA630E5F, add: 0x7FEAFCB2 },
  0x04: { kind: 'ID' },                                          // 恒等
  // ⚠️ 这组 `uVar10 = ~uVar8; goto LAB_00030c7a` —— 取反**之后还要**
  //    `* -0x56ac02b2 + 0x6ed9eba1`（= *0xA953FD4E + 0x6ED9EBA1）。
  //    抄 goto 语义时漏掉这一步会让 7 个 mode 全错。
  0x05: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x24: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x26: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x32: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x34: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x3d: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x49: { kind: 'NOT_MULADD', mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x0C: { kind: 'POLY3', a: 0x12C2A4F9, b: 0x902CEA29, c: 0x902CB3AF, k: 0x4C8 },
  0x14: { kind: 'ZERO' },
  0x1A: { kind: 'BSWAP_MUL', x: 0xA5A5A55A, mul: 0x5AA5A5A5 },
  0x1C: { kind: 'NOT' },   // 纯取反（break，无 goto）
  0x20: { kind: 'XOR_MUL', x: 0x5AA5A5A5, mul: 0x5AA5A5A5 },
  // goto LAB_00030c78 → `t = C ^ seed` 然后同样后置乘加
  0x22: { kind: 'XOR_CONST_POST', c: 0x23DA0E7B, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x23: { kind: 'XOR_POST', c: 0xF4932BD6, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x25: { kind: 'XOR_MULADD', x: 0x4A62, mul: 0xF4932BE56, add: 0x6ED9EBA1 }, // ^0x4a62)*-0xb6cd42a+0x6ed9eba1
  0x27: { kind: 'NOT_MULADD', mul: 0xB548AD3E, add: 0x62A6FA29 },  // ~seed * -0x4ab752c2 + 0x62a6fa29
  0x2A: { kind: 'ADD', c: 0x30D7 }, 0x31: { kind: 'ADD', c: 0x30D7 },
  0x2B: { kind: 'XOR_CONST_POST', c: 0x5358A13F, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x2C: { kind: 'XOR', c: 0x03F4C55D }, 0x36: { kind: 'XOR', c: 0x03F4C55D },
  0x2E: { kind: 'ADD', c: 0x11677 },
  0x2F: { kind: 'ADD', c: 0x54A9 },
  0x38: { kind: 'NOT', mask: 0xFFFF },
  0x3A: { kind: 'XOR_CONST_POST', c: 0x30154C8B, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x3C: { kind: 'XOR_CONST_POST', c: 0x2E76ECD9, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x3E: { kind: 'ADD', c: 0x4E87 }, 0x44: { kind: 'ADD', c: 0x4E87 },
  0x3F: { kind: 'ADD', c: 0x0C42 },
  0x40: { kind: 'ADD', c: 0x7702 },
  0x43: { kind: 'ADD', c: 0x062B },
  0x45: { kind: 'ADD', c: 0x3507 },
  0x46: { kind: 'ADD', c: 0x4EC0 },
  0x4A: { kind: 'ADD', c: 0x80000002 },
  0x4B: { kind: 'ROL_XOR_COND', xor: 0x0E4A2763, rounds: 9 },   // 9 次：左旋，若进位则 ^0xe4a2763
  0x4D: { kind: 'ADD', c: 0xD887F2 },
  0x4E: { kind: 'ADD', c: 0x5A10 },
  0x51: { kind: 'ADD', c: 0x6D43 }, 0x63: { kind: 'ADD', c: 0x6D43 },
  0x69: { kind: 'ADD', c: 0x6D43 },
  0x52: { kind: 'ADD', c: 0x770B },
  0x53: { kind: 'ADD', c: 0x2F77 },
  0x54: { kind: 'ADD', c: 0x7892 },
  0x55: { kind: 'ADD', c: 0x4B53 },
  0x56: { kind: 'ADD', c: 0x2A90 },
  0x57: { kind: 'ADD', c: 0x8048 },
  0x58: { kind: 'ADD', c: 0x350B },
  0x59: { kind: 'ADD', c: 0x1170 },
  0x5A: { kind: 'ADD', c: 0x1 },
  0x5E: { kind: 'ADD', c: 0x8F9 },
  0x5F: { kind: 'CONST', c: 0x928C3EE6 },
  0x61: { kind: 'ADD', c: 0x0B }, 0x6A: { kind: 'ADD', c: 0x0B },
  0x62: { kind: 'ADD', c: 0x2FC9 },
  0x64: { kind: 'ADD', c: 0x1275C },
  0x66: { kind: 'ADD', c: 0x336F1 },
  0x6B: { kind: 'ADD', c: 0x457 },
  0x6C: { kind: 'ADD', c: 70000 },              // 0x11170
  // ⚠️ 0x6D / 0x74 的公式来自 `securityModel` 的 switch（C 里 goto Lab_30c78/30c7a）。
  //    .so 里虽然也有 `mode 0x6D` / `mode 0x74` 符号（size 28/32），
  //    但**不是这个 case 的实现**（直接调它们会得到另一套结果）——
  //    真值对拍 必须走 securityModel，别拿这两个符号当 mode 0x6d/0x74 的真值。
  0x6D: { kind: 'XOR_CONST_POST', c: 0x19DF60B2, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x74: { kind: 'XOR_CONST_POST', c: 0x3A6, mul: 0xA953FD4E, add: 0x6ED9EBA1 },
  0x90: { kind: 'ADD', c: 0x2622 },
};

/**
 * 还需要单独逆的 mode（原厂 里是外部调用，函数体各自独立）。
 * ⚠️ 这些**不要猜**，照 原厂 一个个来。
 */
export const PENDING_MODES = {
  0x01: 'algo-1', 
  0x06: 'algo-6',   0x07: 'algo-7',
  0x08: 'algo-8', 
  0x0A: 'algo-A',  
  0x0F: 'algo-F',   0x10: 'algo-10',
  0x11: 'algo-11',  0x12: 'algo-12',
  // 0x13/0x15/0x16/0x19/0x1B/0x1F/0x29/0x35/0x42/0x47/0x5B/0x5C/0x5D/0x68
  //   → 已由 RAW_MODE_FNS 收编（2026-10-18，32 点 真值对拍）
  0x18: 'algo-18',
  0x1D: 'mode 0x1D 是 2 字节空壳（bx lr），语义在调用方/运行时状态里 —— 拒写',
  // 0x28/0x2D/0x30/0x4F/0x65 → 已由 RAW_MODE_FNS 收编（哈希/线性反馈移位 族）
  0x33: 'algo-33',
  0x37: 'algo-37',
  0x39: 'algo-39',  0x3B: 'algo-3B',
  0x4C: 'algo-4C',
  0x50: 'algo-50',
  0x60: 'algo-60',
  // 0x6E/0x6F/0x70/0x71/0x72/0x73/0x75/0x76/0x77 → 已由 WORDVM_PROGRAMS 收编
  //   （2026-10-18，字长 VM 解释器 + 32 点 真值对拍 对拍）
  // 0x74 / 0x6D → 已由 INLINE_MODES 收编（XOR_CONST_POST，见上表）
  // 0x79/0x7A/0x7B → 已由 RAW_MODE_FNS 收编（2026-10-18 第三轮 ext79/ext7a/ext7b）
  // default → stdSeedKey(mode, seed, len)
};

const bswap32 = (x) => {
  x = u32(x);
  return u32(((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >> 8) & 0xff00) | (x >>> 24));
};

// ─────────────────────────────────────────────────────────────────────────────
// 原语 mode 直译（2026-10-18 收编）
//
// 来源：`原厂口令算法库` 的 `mode`，**先静态分析核对、
// 再逐行直译**。每个函数都用 仿真 实跑 32 个 seed 点对拍（见 tools/lib-真值对拍.py、
// tools/vectors/mode-samples.json）。
//
// ⚠️ 这里**故意不做代数化简**：C 里 `(uint)` 与 `(ushort)` 的差别、`n==0` 时
//    循环体跳过但**仍要走组合**、左移把高位留下来（不截 16 位）——
//    化简掉任何一条都会对不上（历史上 0x1B 就是漏了“不截断”）。
// ⚠️ 位提取的两种写法语义**相反**：`p >> k & m` = `(p>>>k)&m`，
//    `(p & m) >> k` = `(p&m)>>>k`。逐条照抄。
// ─────────────────────────────────────────────────────────────────────────────

/** `mode 0x13`  —— 32 位工作字，n/mode 都从 seed 位取 */
function prim13(p) {
  const n = (((p >>> 1) & 2) | (p & 8) | ((p & 0x1fff) >>> 12) | ((p & 1) << 2)) & 15;
  let v = p;
  for (let i = 0; i < n; i++) {
    v = (p & 0x80) ? u32((v << 15) | (v >>> 1)) : u32((v << 1) | (v >>> 15));
  }
  const m = ((p >>> 4) & 2) | ((p & 0x3ff) >>> 9);
  if (m === 1) return u32(~v);
  if (m === 3) return u32(p | v);
  if (m === 2) return u32(p & v);
  return u32(p ^ v);
}

/** `mode 0x15`  —— 16 位工作字；**mode 用旋转后的 v 取位**（不是 seed） */
function prim15(p) {
  const w = p & 0xffff;
  const n = (((p & 2) << 1) | ((p >>> 2) & 2) | ((p & 0x3fff) >>> 13) | ((p >>> 1) & 8)) & 15;
  let v = w;
  for (let i = 0; i < n; i++) {
    v = (p & 0x100) ? (((v >>> 1) | (v << 15)) & 0xffff) : (((v >>> 15) | (v << 1)) & 0xffff);
  }
  const m = (((v & 0x7ff) >>> 10) | ((v >>> 5) & 2)) & 3;
  if (m === 0) v = (v | w) & 0xffff;
  else if (m === 3) return (v & w) & 0xffff;
  else if (m === 1) return (v ^ w) & 0xffff;
  return v & 0xffff;
}

/** `mode 0x16`  —— 左旋分支带 “|1” 进位；uVar2 在右旋分支被覆盖成进位 */
function prim16(p) {
  const n = (((p & 0xf) >>> 3) | (p & 4) | ((p >>> 8) & 2) | ((p >>> 4) & 8)) & 15;
  let u2 = p & 0xffff, u4 = p & 0xffff;
  for (let i = 0; i < n; i++) {
    if ((p & 0x1000) === 0) {
      u4 = (((u4 & 0x7fff) << 1) | 1) & 0xffff;
    } else {
      u2 = u4 & 1;
      u4 = ((u4 >>> 1) | (u2 << 15)) & 0xffff;
    }
  }
  let r = (u4 ^ u2) & 0xffff;
  if ((p >>> 5) & 2) r = (u4 | u2) & 0xffff;
  return r;
}

/** `mode 0x19`  —— 低 16 位先字节交换；左移分支是“符号位拷贝”不是循环移位 */
function prim19(p) {
  const sw = (((p & 0xffff) >>> 8) | ((p & 0xff) << 8)) & 0xffff;
  const sbfx = (x, lsb, w) => {
    const v = (x >> lsb) & ((1 << w) - 1);
    return (v & (1 << (w - 1))) ? v - (1 << w) : v;
  };
  const n = ((u32(sw << 16) >>> 19) & 1) | ((p << 2) & 4) | ((p >>> 8) & 2) | ((p >>> 5) & 8);
  let v = sw;
  for (let i = 0; i < n; i++) {
    if ((sw & 0x1000) === 0) {
      v = (((sbfx(v, 1, 15) << 15) | (i32(u32(v << 16)) >> 17)) & 0xffff) >>> 0;
    } else {
      v = (v << 1) & 0xffff;
    }
  }
  const m = (((sw >>> 4) & 1) << 1) | ((sw >>> 14) & 1);
  if (m === 1) return (sw | v) & 0xffff;
  if (m === 3) return (sw ^ 0xffff) & 0xffff;
  if (m === 2) return (sw ^ v) & 0xffff;
  return (sw & v) & 0xffff;
}

/**
 * `mode 0x1B` 
 * ⚠️ 左移分支 `orr r1, ip, r0, lsl #1` **不截 16 位**（进位没进来时才 uxth），
 *    高位会留到下一轮继续左移 —— 返回值的 0x0001xxxx 就是这么来的。
 */
function prim1b(p) {
  const w = p & 0xffff;
  const n = ((w >>> 10) & 4) | ((w >>> 10) & 1) | ((p >>> 5) & 2);
  let v = w;
  if (n !== 0) {
    let carry = 1;
    for (let i = 0; i < n; i++) {
      let t, nc;
      if ((p & 4) === 0) {
        t = u32((v << 1) | 1);
        if (carry === 0) t = (v << 1) & 0xffff;
        nc = v & 0x8000;
      } else {
        nc = v & 1;
        t = carry === 0 ? ((v >>> 1) & 0x7fff) : ((v >>> 1) | 0x8000);
      }
      v = u32(t);
      carry = nc ? 1 : 0;
    }
  }
  return v;
}

/** `mode 0x1F`  —— 工作字是**完整 seed**（不是低 16 位） */
function prim1f(p) {
  const n = ((p >>> 10) & 4) | ((p >>> 5) & 2) | ((p & 0x7ff) >>> 10);
  let v = p;
  if (n !== 0) {
    let carry = 0;
    for (let i = 0; i < n; i++) {
      let t, nc;
      if ((p & 4) === 0) {
        t = u32((v & 0x7fff) << 1);
        nc = v & 0x8000;
        if (carry) t = u32(t | 1);
      } else {
        nc = v & 1;
        t = u32(v >>> 1);
        if (carry) t = u32((t & 0x7fff) | 0x8000);
      }
      v = t;
      carry = nc ? 1 : 0;
    }
  }
  return v;
}

/** `mode 0x29`  —— 32 位 rotate+combine */
function prim29(p) {
  const n = (((p >>> 19) & 4) | ((p >>> 10) & 2) | ((p & 3) >>> 1) | ((p >>> 23) & 8)) & 31;
  let v = p;
  for (let i = 0; i < n; i++) {
    v = (p & 0x20000000) === 0 ? u32((v >>> 1) | (v << 31)) : u32((v >>> 31) | (v << 1));
  }
  const m = (((p >>> 17) & 2) | ((p & 0x7f) >>> 6)) & 3;
  if (m === 1) return u32(p | v);
  if (m === 3) return u32(~p);
  if (m === 2) return u32(p ^ v);
  return u32(p & v);
}

/**
 * `mode 0x2D`  —— 4 字节种子扩展成 31 轮字节混淆，结果 = 缓冲前 4 字节（大端）。
 * ⚠️ `(char)param_1 + 3` 是**有符号 char** 运算（seed 低字节 0x80 → 0x83），
 *    写成无符号会对不上 0x80000000 这类点。
 */
function prim2d(p) {
  const b = [(p >>> 24) & 0xff, (p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff];
  const l98 = new Uint8Array(8);
  l98[2] = ((((p & 0xff) << 24 >> 24) + 3) & 0xff);
  l98[1] = (b[0] + 2) & 0xff;
  l98[0] = (b[2] + 1) & 0xff;
  l98[3] = (b[1] + 4) & 0xff;
  let u1 = 0;
  for (;;) {
    const u3 = u1 + 1;
    const u2 = u1 & 3;
    l98[u2] = (((l98[u2] + b[u3 & 3]) & 0xff) ^ b[(u1 + 2) & 3]) & 0xff;
    u1 = (u1 + 3) & 3;
    l98[u1] = (b[u2] ^ l98[u1]) & 0xff;
    u1 = u3;
    if (u3 === 0x1f) break;
  }
  return u32((l98[0] << 24) | (l98[1] << 16) | (l98[2] << 8) | l98[3]);
}

/** `mode 0x35`  */
function prim35(p) {
  const w = p & 0xffff;
  const n = (((p & 2) << 1) | ((p >>> 3) & 2) | ((p & 0x3fff) >>> 13) | ((p & 4) << 1)) & 15;
  let v = w;
  for (let i = 0; i < n; i++) {
    v = (p & 0x400) === 0 ? (((v >>> 1) | (v << 15)) & 0xffff) : ((v << 1) & 0xffff);
  }
  const m = (((p & 0x1fff) >>> 12) | ((p >>> 5) & 2)) & 3;
  if (m === 0) v = (v | w) & 0xffff;
  else if (m === 2) return (v ^ w) & 0xffff;
  else if (m === 1) return (v & w) & 0xffff;
  return v & 0xffff;
}

/** `mode 0x42`  —— mode1 是 `(param_1 + v) & 0xffff`（和完整 seed 加） */
function prim42(p) {
  const w = p & 0xffff;
  const n = (((w >>> 10) & 2) | (p & 8) | (w >>> 15) | ((w >>> 10) & 4)) & 15;
  let v = w;
  for (let i = 0; i < n; i++) {
    v = (p & 0x10) === 0 ? (((v >>> 15) | (v << 1)) & 0xffff) : (((v >>> 1) | (v << 15)) & 0xffff);
  }
  const m = (((p & 0x1ff) >>> 8) | ((p & 1) << 1)) & 3;
  if (m === 1) return (p + v) & 0xffff;
  if (m === 3) return (v & w) & 0xffff;
  if (m === 2) return (v | w) & 0xffff;
  return (w ^ 0xffff) & 0xffff;
}

/** `mode 0x47`  —— 32 位 rotate+combine（和 0x29 同骨架，位不同） */
function prim47(p) {
  const n = (((p >>> 25) & 4) | ((p >>> 7) & 2) | ((p & 7) >>> 2) | ((p >>> 9) & 8)) & 31;
  let v = p;
  for (let i = 0; i < n; i++) {
    v = (p & 0x40000000) === 0 ? u32((v >>> 1) | (v << 31)) : u32((v >>> 31) | (v << 1));
  }
  const m = (((p >>> 21) & 2) | ((p & 0x3f) >>> 5)) & 3;
  if (m === 1) return u32(p | v);
  if (m === 3) return u32(~p);
  if (m === 2) return u32(p ^ v);
  return u32(p & v);
}

/** 0x5B/0x5C/0x5D/0x68 共用骨架：工作字 32 位、只转 16 位、组合仍用完整 seed */
function primShift16(p, nFn, dirMask, mFn, comb) {
  const n = nFn(p) & 15;
  let v = p;
  for (let i = 0; i < n; i++) {
    v = (p & dirMask) === 0 ? u32((v << 1) | (v >>> 15)) : u32((v << 15) | (v >>> 1));
  }
  return comb(mFn(p) & 3, p, v) >>> 0;
}

/** `mode 0x5B`  */
function prim5b(p) {
  return primShift16(p,
    (x) => ((x >>> 8) & 2) | (x & 4) | ((x & 0xf) >>> 3) | ((x >>> 4) & 8),
    0x1000,
    (x) => ((x >>> 5) & 2) | ((x & 0x3fff) >>> 13),
    (m, x, v) => (m === 1 ? u32(x ^ v) : m === 3 ? u32(x | v) : m === 2 ? u32(x & v) : u32(x + v)));
}

/** `mode 0x5C`  / `mode 0x5D`  —— 两个静态分析分支写法不同，32 点结果完全一致 */
function prim5c(p) {
  return primShift16(p,
    (x) => ((x >>> 3) & 2) | (x & 4) | ((x & 0x7fff) >>> 14) | ((x >>> 2) & 8),
    0x200,
    (x) => ((x & 0xfff) >>> 11) | ((x >>> 6) & 2),
    (m, x, v) => (m === 0 ? u32(v & x) : m === 2 ? u32(v ^ x) : m === 1 ? u32(v | x) : u32(v)));
}

/** `mode 0x68`  */
function prim68(p) {
  return primShift16(p,
    (x) => ((x >>> 10) & 2) | (x & 8) | ((x & 0xffff) >>> 15) | ((x >>> 10) & 4),
    0x10,
    (x) => ((x & 0x1ff) >>> 8) | ((x & 1) << 1),
    (m, x, v) => (m === 1 ? u32(x + v) : m === 3 ? u32(x & v) : m === 2 ? u32(x | v) : u32(~x)));
}

/**
 * `mode 0x28`  —— 走内部 26 轮 ARX（`sub_75643070` 实际执行体 ）：
 *   x_{i+1} = ROR32(x_i + 0x54525730, 2) ^ ((x_i+0x54525730) 的 bit1 ? 0x02341972 : 0)
 * 和 `ASAM_seedkey_Airbag_Upload` 是同一族（同一个 0x54525730 轮常量），26 轮。
 */
function prim28(p) {
  let x = p;
  for (let i = 0; i < 26; i++) {
    const t = u32(x + 0x54525730);
    const r1 = u32((t >>> 1) | (t << 31));           // ROR1
    let y = u32((r1 >>> 1) | (r1 << 31));            // ROR2
    if (r1 & 1) y = u32(y ^ 0x02341972);
    x = y;
  }
  return x;
}

/**
 * `mode 0x30`  —— 位串行 线性反馈移位（CRC 风格）：
 *   状态 4 字节（初值 a9 41 c5 66 = 0x66C541A9 小端），每 bit 做一次“大端 32 位循环右移”，
 *   data = seed(大端 4B) + "SNpof"；移位后若最高字节 bit7 置位 → 最高字节 ^= 0x80。
 * ⚠️ 这里**没有**异或表（异或表是 0x65 的，别串味）。
 * ⚠️ 输出是**半字节重排**（静态分析尾部 0x1f4aa 起的 and/bfi/orr 序列），不是直接返回状态。
 */
function prim30(p) {
  const b = [0xa9, 0x41, 0xc5, 0x66];
  const data = [(p >>> 24) & 0xff, (p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff, 0x53, 0x4e, 0x70, 0x6f, 0x66];
  for (const byte of data) {
    for (let i = 0; i < 8; i++) {
      const b0 = b[0];
      b[0] = ((b[0] >> 1) | ((b[1] & 1) << 7)) & 0xff;
      b[1] = ((b[1] >> 1) | ((b[2] & 1) << 7)) & 0xff;
      b[2] = ((b[2] >> 1) | ((b[3] & 1) << 7)) & 0xff;
      b[3] = ((b[3] >> 1) | ((b0 & 1) << 7)) & 0xff;
      if (byte & (1 << i)) b[3] ^= 0x80;
    }
  }
  const [b0, b1, b2, b3] = b;
  // 静态分析尾部 0x1f4aa 起的半字节重排（和 0x65 的尾部写法不同，别照抄）
  const r6 = u32((b0 >>> 4) | ((b1 & 0x0f) << 4));
  let r3 = u32(b3 | (b3 << 4));
  r3 = u32(((r3 << 8) & 0xf000) | r6);
  let r2 = u32((b1 & 0xf0) | (b2 >>> 4));
  r2 = u32(r2 | (r3 << 8));
  let out = u32(((b0 << 4) & 0xff) | (b2 & 0x0f));
  return u32(out | (r2 << 8));
}

/**
 * `mode 0x4F`  → 实际执行体 ：
 *   44 轮：s = popcount(r0 & 0xb8e7)；r0 = (s << 15) & 0xffff | (r0 >>> 1)
 *   收尾：r0 = (r0 & 0xffe0) | 0x16
 */
function prim4f(p) {
  let r0 = p;
  for (let i = 0; i < 0x2c; i++) {
    let x = u32(r0 & 0xb8e7), s = 0;
    while (x) { s += x & 1; x >>>= 1; }
    r0 = u32((((s << 15) & 0xffff) | (r0 >>> 1)) >>> 0);
  }
  return u32((r0 & 0xffe0) | 0x16);
}

/**
 * `mode 0x65`  —— 4 字状态 + 4 bit 并行移位 + 条件异或表 (28,90,10,17)。
 * ⚠️ 移位是**跨字**的（word[i] 的 bit0 进 word[i-1] 的 bit7），输出同样有半字节重排。
 */
function prim65(p) {
  const w = [0xa9, 0x41, 0xc5, 0x66];
  const data = [(p >>> 24) & 0xff, (p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff, 0x53, 0x4e, 0x70, 0x6f, 0x66];
  const T = [0x28, 0x90, 0x10, 0x17];
  for (const byte of data) {
    for (let bit = 0; bit < 8; bit++) {
      const b0 = w[0];
      w[0] = u32((w[0] >>> 1) | ((w[1] & 1) << 7));
      w[1] = u32((w[1] >>> 1) | ((w[2] & 1) << 7));
      w[2] = u32((w[2] >>> 1) | ((w[3] & 1) << 7));
      w[3] = u32((w[3] >>> 1) | ((b0 & 1) << 7));
      if (byte & (1 << bit)) w[3] = u32(w[3] ^ 0x80);
      if (w[3] & 0x80) for (let k = 0; k < 4; k++) w[k] = u32(w[k] ^ T[k]);
    }
  }
  const [x0, x1, x2, x3] = w;
  const bfi = (v, src, lsb, width) => {
    const m = ((1 << width) - 1) << lsb;
    return u32((v & ~m) | ((src << lsb) & m));
  };
  let r1 = u32((x1 & 0xf0) | ((x2 >>> 4) & 0xf));
  const r6 = bfi(x2 & 0x0f, x0, 4, 4);
  r1 = u32(r6 | (r1 << 8));
  const r3 = bfi((x0 >>> 4) & 0xf, x1, 4, 4);
  const out = u32(r1 | (r3 << 16));
  return u32(out | (u32((x3 | (x3 << 4)) << 24) & 0xf0000000));
}

/**
 * 0x79（原厂 `SK_SW_SG_CAYENNE` ）—— 16 位 rotate+combine。
 * 逐条照静态分析：n / mode 都从**原始 seed** 取位；旋转方向由 `seed & 0x1000` 决定；
 * 组合前只取低 16 位（mode 0 是 32 位相加后截 16）。
 * 仿真 真值对拍：32 点对拍 + 2000 随机点复核全过。
 */
function ext79(p) {
  const s = u32(p);
  const n = (((s >>> 4) & 8) | ((s >>> 8) & 2) | ((s >>> 3) & 1) | (s & 4));
  const mode = (((s >>> 5) & 2) | ((s >>> 13) & 1)) & 3;
  let v = s;
  for (let i = 0; i < n; i++) {
    if ((s & 0x1000) === 0) v = u32(((v >>> 15) & 1) | (v << 1));
    else v = u32(((v << 15) & 0xffff) | (v >>> 1));
  }
  const w = v & 0xffff;
  if (mode === 1) return u32(s ^ w);
  if (mode === 2) return u32(s & w);
  if (mode === 3) return u32(s | w);
  return (v + s) & 0xffff;
}

/**
 * 0x7A（原厂 `DME_ME711_CAYENNE` ）—— GF(2) 线性变换。
 *
 * 原函数是一个 12 字 VM（`68 05 81 4A 05 87 5F BD 5D BD 49 4C`）。逐条读完 VM 后
 * 可把它等价成「32 位输入的高 5 位经一个 5 级 线性反馈移位 反馈，再与 `seed << 5` 异或」：
 *
 *   f(s) = (s << 5) ^ XOR_{i=0..4, bit_i(s>>27)=1} FEEDBACK[i]
 *
 * 这不是黑盒拟合：FEEDBACK 是 5 个线性基（bit27..31 各自的输出），
 * 已用 1006 个随机点与 仿真 原函数逐点对拍（含 0/全 1/边界）。
 * 线性映射的组合性也已验证：f(a)^f(b) == f(a^b)。
 */
const EXT7A_FEEDBACK = [
  0x5FBD5DBC, 0xBF7ABB78, 0x21482B4C, 0x42905698, 0x8520AD30,
];
function ext7a(p) {
  const s = u32(p);
  const t = (s >>> 27) & 0x1f;
  let fb = 0;
  for (let i = 0; i < 5; i++) if ((t >>> i) & 1) fb = u32(fb ^ EXT7A_FEEDBACK[i]);
  return u32((s << 5) ^ fb);
}

/**
 * 0x7B（原厂 `变体 9x7GW` ）—— 16 位 rotate+combine。
 *
 * 与 0x79 同族，但有三个额外语义（少抄一条就对不上）：
 *   ① n 的 bit2 来自 **符号扩展后的 seed**（`sxth(seed) & 4`）；
 *   ② 方向位 `seed & 0x200` 为 0 时走 `sxth`/`lsl #1 & 0x1fffe` 分支，
 *      为 1 时走 15 位右移 + 低位回填 bit15；
 *   ③ mode 3 是**直通**（不参与 AND），mode 0 才是 AND。
 * 仿真 真值对拍：32 点对拍 + 2000 随机点复核全过。
 */
function ext7b(p) {
  const s = u32(p);
  const sxth = (x) => {
    const v = x & 0xffff;
    return (v & 0x8000) ? v - 0x10000 : v;
  };
  const lr = sxth(s);
  const n = (((s >>> 2) & 8) | ((s >>> 3) & 2) | ((s >>> 14) & 1) | (lr & 4));
  const mode = (((s >>> 6) & 2) | ((s >>> 11) & 1)) & 3;
  let v = s;
  for (let i = 0; i < n; i++) {
    if ((s & 0x200) !== 0) {
      let r7 = (v >>> 1) & 0x7fff;
      if (v & 1) { r7 |= 0x8000; v = sxth(r7); } else v = r7;
    } else {
      const r7 = sxth(v);
      if (r7 <= -1) v = u32(1 | ((u32(v << 17)) >>> 16));
      else v = sxth(u32((v << 1) & 0x1fffe));
    }
  }
  if (mode === 1) return sxth((v & 0xffff) | lr);
  if (mode === 2) return sxth((v & 0xffff) ^ lr);
  if (mode === 3) return sxth(v);
  return sxth((v & 0xffff) & lr);
}

/** mode → 直译原语。全部 32 点 真值对拍 对拍（tools/verify-pending.mjs） */
export const RAW_MODE_FNS = {
  0x13: prim13, 0x15: prim15, 0x16: prim16, 0x19: prim19, 0x1b: prim1b, 0x1f: prim1f,
  0x28: prim28, 0x29: prim29, 0x2d: prim2d, 0x30: prim30,
  0x35: prim35, 0x42: prim42, 0x47: prim47, 0x4f: prim4f,
  0x5b: prim5b, 0x5c: prim5c, 0x5d: prim5c, 0x65: prim65, 0x68: prim68,
  0x79: ext79, 0x7a: ext7a, 0x7b: ext7b,
};

/**
 * 按 原厂 `securityModel` 的 switch 算 key。
 * @param {number} mode  0x00..0xA0（param_2）
 * @param {number} seed  32 位无符号
 * @returns {{key: number, algo: string}}
 */
export function pswCalc(mode, seed) {
  const s = u32(seed);
  if (RAW_MODE_FNS[mode]) {
    return { key: u32(RAW_MODE_FNS[mode](s)), algo: `PRIM/0x${mode.toString(16)}` };
  }
  if (ROTATE_COMBINE_MODES[mode]) {
    const spec = ROTATE_COMBINE_MODES[mode];
    // 0x02 起的 rotate+combine 用**符号扩展**语义（见 rotateCombine16SX）
    if (spec && spec.dirMask !== undefined && (spec.combineMap || typeof spec.combine === 'function')) {
      return { key: u32(rotateCombine16SX(s, spec)), algo: `RC_SX/0x${mode.toString(16)}` };
    }
    return { key: u32(rotateCombine16(s, spec)), algo: `ROTATE_COMBINE/0x${mode.toString(16)}` };
  }
  if (WORDVM_PROGRAMS[mode]) {
    // ⚠️ 必须用**字长 VM**解释器：字节版 sa2Run 在 0x73 上只能对 28/32
    //    （差在 SHR1 的 bit31 还要吃「SUB 借位留下的 hi」），见 seedkey-wordvm.js 文件头。
    return { key: u32(wordVmRun(s, hexToBytes(WORDVM_PROGRAMS[mode]))), algo: `WORDVM/0x${mode.toString(16)}` };
  }
  if (FEISTEL_MODES[mode]) {
    return { key: u32(FEISTEL_MODES[mode].fn(s)), algo: `FEISTEL/0x${mode.toString(16)}` };
  }
  if (ROTATE_COMBINE32_MODES[mode]) {
    return { key: u32(rotateCombine32(s, ROTATE_COMBINE32_MODES[mode])), algo: `ROTATE32/0x${mode.toString(16)}` };
  }
  const m = INLINE_MODES[mode];
  if (!m) {
    const name = PENDING_MODES[mode] || (mode > 0x77 ? 'stdSeedKey' : `未知 mode 0x${mode.toString(16)}`);
    throw new Error(`mode 0x${mode.toString(16)} 走外部例程 ${name}，尚未逆出（照 原厂 逐个来）`);
  }
  switch (m.kind) {
    case 'ADD':        return { key: u32(s + m.c), algo: 'ADD' };
    case 'XOR':        return { key: u32(s ^ m.c), algo: 'XOR' };
    case 'ID':         return { key: s, algo: 'ID' };
    case 'ZERO':       return { key: 0, algo: 'ZERO' };
    case 'CONST':      return { key: u32(m.c), algo: 'CONST' };
    case 'NOT':        return { key: m.mask ? (u32(~s) & m.mask) : u32(~s), algo: 'NOT' };
    case 'MULADD':     return { key: u32(Math.imul(s, m.mul) + m.add), algo: 'MULADD' };
    case 'XOR_MUL':    return { key: u32(Math.imul(u32(s ^ m.x), m.mul)), algo: 'XOR_MUL' };
    case 'XOR_CONST_POST':
      return { key: u32(Math.imul(u32(s ^ m.c), m.mul) + m.add), algo: 'XOR_CONST_POST' };
    case 'XOR_POST':
      return { key: u32(Math.imul(u32(s ^ m.c), m.mul) + m.add), algo: 'XOR_POST' };
    case 'XOR_MULADD': return { key: u32(Math.imul(u32(s ^ m.x), m.mul) + m.add), algo: 'XOR_MULADD' };
    case 'NOT_MULADD': return { key: u32(Math.imul(u32(~s), m.mul) + m.add), algo: 'NOT_MULADD' };
    case 'BSWAP_MUL':  return { key: u32(Math.imul(bswap32(u32(s ^ m.x)), m.mul)), algo: 'BSWAP_MUL' };
    case 'POLY3': {
      const p = u32(u32(s ^ m.a) + m.b);
      const q = u32(u32(s & m.c) + m.b);
      const r = u32(u32(s ^ m.a) + (s & m.c) + m.k);
      return { key: u32(Math.imul(Math.imul(p, q), r)), algo: 'POLY3' };
    }
    case 'ROL_XOR_COND': {
      let x = s;
      for (let i = 0; i < m.rounds; i++) {
        const carry = (x & 0x80000000) !== 0;
        x = u32((x << 1) | (x >>> 31));
        if (carry) x = u32(x ^ m.xor);
      }
      return { key: x, algo: 'ROL_XOR_COND' };
    }
    default: throw new Error(`未实现 kind ${m.kind}`);
  }
}

/** 已实现的 mode 数（内联） */
export const INLINE_MODE_COUNT = Object.keys(INLINE_MODES).length;
/** 待逆的 mode 数 */
export const PENDING_MODE_COUNT = Object.keys(PENDING_MODES).length;

// ─────────────────────────────────────────────────────────────────────────────
// rotate + combine 引擎（照抄 原厂 的 mode 骨架）
// ⚠️ 位布局**逐个从解析读出**，且每个 mode 写显式表达式 ——
//    别用「通用位操作 DSL」，右移在 JS 的 `<<` 里会被当成 `<<25`（真踩过）。
// ─────────────────────────────────────────────────────────────────────────────

function rot16(x, n, left) {
  x &= 0xffff; n &= 15;
  if (!n) return x;
  return left ? (((x << n) | (x >>> (16 - n))) & 0xffff)
              : (((x >>> n) | (x << (16 - n))) & 0xffff);
}

const M16 = (v) => v & 0xffff;

/**
 * 通用骨架：n 与 mode 由调用方给的纯函数算出。
 * @param {number} s 32 位 seed
 * @param {{n:(s)=>number, left:(s)=>boolean, mode:(s)=>number, modeMap:object}} spec
 */
function rotateCombine16(s, spec) {
  const x = s & 0xffff;
  const n = spec.n(s) & 15;
  const left = spec.left(s);
  const r = rot16(x, n, left);
  const m = spec.mode(s) & 3;
  const f = spec.modeMap[m];
  if (!f) throw new Error(`rotate+combine mode=${m} 未定义`);
  // 某些 mode（如 Mode_F 的 2）要用**完整 32 位 param_1** —— 作为第三参传下去
  return f(x, r, s >>> 0);
}

/** algo-A （照抄） */
export const MODE_A = {
  // n = (p&1)<<2 | (p>>14)&2 | (p&0x3ff)>>9 | (p>>3)&8
  n: (p) => (((p & 1) << 2) | ((p >>> 14) & 2) | ((p & 0x3ff) >>> 9) | ((p >>> 3) & 8)),
  left: (p) => (p & 0x800) !== 0,
  // mode = (p>>2)&2 | (p&0xff)>>7
  mode: (p) => (((p >>> 2) & 2) | ((p & 0xff) >>> 7)),
  modeMap: { 1: (x, r) => M16(x | r), 2: (x, r) => M16(x ^ r), 3: (x, _r) => x, 0: (x, r) => M16(x & r) },
};

/** algo-18 （照抄） */
export const MODE_18 = {
  // n = (p&0xc) | (p>>15) | (p>>4)&2
  n: (p) => ((p & 0xc) | (p >>> 15) | ((p >>> 4) & 2)),
  left: (p) => (p & 0x800) !== 0,
  // mode = (p&0x3fff)>>13 | (p>>6)&2
  mode: (p) => (((p & 0x3fff) >>> 13) | ((p >>> 6) & 2)),
  modeMap: {
    1: (x, r) => M16(x & r), 2: (x, r) => M16(x ^ r),
    3: (x, _r) => M16(~x),    // uVar4 ^ 0xffff
    0: (x, r) => M16(x | r),
  },
};

/** algo-39 （照抄） */
export const MODE_39 = {
  // n = (p>>12)&8 | (p>>8)&4 | (p>>6)&2 | (p&0x3f)>>5
  n: (p) => (((p >>> 12) & 8) | ((p >>> 8) & 4) | ((p >>> 6) & 2) | ((p & 0x3f) >>> 5)),
  left: (p) => (p & 8) === 0,          // ⚠️ (p&8)==0 → 左旋（和 A/18 相反）
  // mode = p&1 | (p>>13)&2
  mode: (p) => ((p & 1) | ((p >>> 13) & 2)),
  modeMap: {
    1: (x, r) => M16(x ^ r), 2: (x, r) => M16(x & r),
    3: (x, _r) => M16(~x),
    0: (x, r) => M16(x | r),
  },
};

/** algo-10 （照抄） */
export const MODE_10 = {
  // n = (p>>11)&2 | (p>>8)&4 | (p&7)>>2 | (p&0xffff)>>2 & 8
  n: (p) => (((p >>> 11) & 2) | ((p >>> 8) & 4) | ((p & 7) >>> 2) | (((p & 0xffff) >>> 2) & 8)),
  left: (p) => (p & 0x8000) === 0,     // ⚠️ (p&0x8000)==0 → 左旋（和 A/18 相反）
  // mode = (p & 0x1ff) >> 7   即 bit7..bit8
  mode: (p) => ((p & 0x1ff) >>> 7),
  modeMap: {
    0: (x, r) => M16(x ^ r),
    1: (x, r) => M16(x | r),
    2: (x, r) => M16(x & r),
    3: (_x, r) => r,                 // 直接返回旋转结果
  },
};

/** algo-F （照抄） */
export const MODE_F = {
  // n = (p>>12)&4 | (p>>3)&2 | (p&7)>>2 | (p&0xffff)>>4 & 8
  n: (p) => (((p >>> 12) & 4) | ((p >>> 3) & 2) | ((p & 7) >>> 2) | (((p & 0xffff) >>> 4) & 8)),
  left: (p) => (p & 0x800) !== 0,      // (p&0x800)==0 → 右旋
  // mode = (p&0x3ff)>>9 | (p&0xffff)>>4 & 2
  mode: (p) => (((p & 0x3ff) >>> 9) | (((p & 0xffff) >>> 4) & 2)),
  modeMap: {
    0: (x, r) => M16(x ^ r),
    // ⚠️ mode 2 用的是**完整 32 位 param_1**，不是工作字 x
    2: (_x, r, p) => M16(p + r),
    3: (_x, r) => M16(~r),            // uVar2 ^ 0xffff = ~旋转结果
    1: (_x, r) => r,                  // 直接返回旋转结果
  },
};

/** 已逆出的 rotate+combine mode → 布局 */
/** algo-6 （照抄） */
export const MODE_6 = {
  // n = (p>>3)&2 | (p&4) | (p&0x7fff)>>14 | (p>>2)&8
  n: (p) => (((p >>> 3) & 2) | (p & 4) | ((p & 0x7fff) >>> 14) | ((p >>> 2) & 8)),
  left: (p) => (p & 0x200) === 0,      // ⚠️ (p&0x200)==0 → 左旋（又一个反的）
  // mode = (p&0xfff)>>11 | (p>>6)&2
  mode: (p) => (((p & 0xfff) >>> 11) | ((p >>> 6) & 2)),
  modeMap: {
    0: (x, r) => M16(x & r),
    1: (x, r) => M16(x | r),
    2: (x, r) => M16(x ^ r),
    3: (_x, r) => r,
  },
};

/** algo-37 （照抄） */
export const MODE_37 = {
  // n = (p>>6)&4 | (p&2) | (p&0xf)>>3 | (p&1)<<3
  n: (p) => (((p >>> 6) & 4) | (p & 2) | ((p & 0xf) >>> 3) | ((p & 1) << 3)),
  left: (p) => (p & 0x1000) !== 0,     // (p&0x1000)==0 → 右旋
  // mode = (p&0x7fff)>>14 | (p&0xffff)>>3 & 2
  mode: (p) => (((p & 0x7fff) >>> 14) | (((p & 0xffff) >>> 3) & 2)),
  modeMap: {
    1: (x, r) => M16(x | r),
    2: (x, r) => M16(x ^ r),
    0: (x, r) => M16(x & r),
    3: (x, _r) => M16(~x),            // uVar4 ^ 0xffff = ~工作字
  },
};

/**
 * algo-4C  —— **n/方向/mode 位布局与 MODE_6 完全相同**，
 * 只有 modeMap 不同（0=ROT 1=OR 2=XOR 3=AND）。同骨架不同映射，不是笔误。
 */
export const MODE_4C = {
  n: MODE_6.n, left: MODE_6.left, mode: MODE_6.mode,
  modeMap: {
    0: (_x, r) => r,
    1: (x, r) => M16(x | r),
    2: (x, r) => M16(x ^ r),
    3: (x, r) => M16(x & r),
  },
};

/** algo-33 （照抄） */
export const MODE_33 = {
  // n = (p>>13)&4 | (p>>2)&2 | (p&1) | (p&0xffff)>>9 & 8
  n: (p) => (((p >>> 13) & 4) | ((p >>> 2) & 2) | (p & 1) | (((p & 0xffff) >>> 9) & 8)),
  left: (p) => (p & 0x80) !== 0,       // (p&0x80)==0 → 右旋
  // mode = (p&0x3f)>>5 | (p&0xffff)>>9 & 2
  mode: (p) => (((p & 0x3f) >>> 5) | (((p & 0xffff) >>> 9) & 2)),
  modeMap: {
    1: (x, r) => M16(x ^ r),
    2: (x, _r) => M16(~x),
    0: (_x, r, p) => M16(p + r),       // ⚠️ 用完整 32 位 param_1
    3: (_x, r) => r,
  },
};

/** algo-3B （照抄） */
export const MODE_3B = {
  // n = (p&0xffff)>>9 & 2 | (p>>10)&8 | (p&4) | (p&0x7f)>>6
  n: (p) => ((((p & 0xffff) >>> 9) & 2) | ((p >>> 10) & 8) | (p & 4) | ((p & 0x7f) >>> 6)),
  left: (p) => (p & 0x10) !== 0,       // (p&0x10)==0 → 右旋
  // mode = (p>>13)&2 | (p&0xffff)>>9 & 1
  mode: (p) => (((p >>> 13) & 2) | (((p & 0xffff) >>> 9) & 1)),
  modeMap: {
    1: (x, r) => M16(x | r),
    3: (x, _r) => M16(~x),
    2: (x, r) => M16(x ^ r),
    0: (x, r) => M16(x & r),
  },
};

/**
 * algo-50  —— **n/方向/mode 位布局与 MODE_3B 完全相同**，
 * 只有 mode 1 不同（AND 而非 OR）。又一个同骨架不同映射。
 */
export const MODE_50 = {
  n: MODE_3B.n, left: MODE_3B.left, mode: MODE_3B.mode,
  modeMap: {
    0: (x, r) => M16(x & r),
    1: (x, r) => M16(x & r),
    2: (x, r) => M16(x ^ r),
    3: (x, _r) => M16(~x),
  },
};

/**
 * bit-hash 族（2 轮 Feistel + ARX）—— 照抄 原厂 `algo-1` 。
 *
 * ```
 * rounds = ((p >> 16) & 0xf) + 3
 * K      = ROR32(0xbbef73b2, rounds) & 0x9fffffff
 * L = p >> 16
 * R = (((p & 0xff00) << 8 | p << 24) >>> 16) & 0xffff      // 低 16 位字节交换
 * for i in 0..1:
 *     t  = ROL16(L ^ R, rounds)
 *     k  = (i == 0) ? ((K0 >> 1) & 0xffff) : (K >>> 16)     // K0 = 循环前的 uVar8
 *     L' = (t + k) & 0xffff ;  R' = L
 * 输出 = (L'<<8) | ((t+k)*0x1000000) | (L'>>8)             // 字节重排
 * ```
 * ⚠️ `K0` 是**循环移位之前**的 `0xbbef73b2`（解析里 `uVar8` 保存了前一轮值）。
 */
function ror32(x, n) {
  x >>>= 0; n &= 31;
  if (!n) return x;
  return (((x >>> n) | (x << (32 - n))) >>> 0);
}
function rol16(x, n) {
  x &= 0xffff; n &= 15;
  if (!n) return x;
  return (((x << n) | (x >>> (16 - n))) & 0xffff);
}

export function bitHashRounds(p) {
  return (((p & 0xfffff) >>> 16) + 3);
}

/**
 * bit-hash 核心 —— **逐变量照抄 C**，不做任何整理。
 * 变量名沿用解析的 uVar1/uVar2/uVar3/uVar4/uVar6/uVar8/uVar9/iVar7/iVar10，
 * 这样和 工具链 伪代码逐行对得上，出错好查。
 */
export function bitHashCore(p, finalCombine) {
  p = p >>> 0;
  let uVar1 = 0, uVar2 = 0, uVar3 = 0, uVar4 = 0, uVar6 = 0, uVar8 = 0, uVar9 = 0;
  let iVar5 = 0, iVar7 = 0, iVar10 = 0;

  iVar10 = ((p & 0xfffff) >>> 16) + 3;
  iVar7 = iVar10;
  uVar9 = 0xbbef73b2 >>> 0;
  do {
    uVar8 = uVar9;                       // ⚠️ uVar8 = 上一轮值，return 里用它
    iVar7 = iVar7 - 1;
    uVar9 = ((ror32(uVar8, 1) & 0x9fffffff) >>> 0);
  } while (iVar7 !== 0);

  iVar7 = 0;
  uVar3 = (p >>> 16) & 0xffffffff;
  uVar4 = (((((p & 0xff00) << 8) | ((p & 0xffffffff) << 24)) >>> 16) & 0xffffffff);
  do {
    uVar1 = uVar3;
    uVar2 = (uVar1 ^ uVar4) >>> 0;
    iVar5 = iVar10;
    do {
      iVar5 = iVar5 - 1;
      uVar2 = (((((uVar2 & 0xffff) >>> 15) | ((uVar2 << 1) & 0xffffffff)) >>> 0));
    } while (iVar5 !== 0);
    uVar6 = (uVar9 >>> 16) & 0xffff;
    if (iVar7 === 0) {
      uVar6 = (uVar8 >>> 1) & 0xffff;
    }
    iVar7 = iVar7 + 1;
    uVar3 = ((uVar2 + uVar6) & 0xffff) >>> 0;
    uVar4 = uVar1;
  } while (iVar7 !== 2);

  return finalCombine({ uVar1, uVar2, uVar3, uVar4, uVar6, uVar8, uVar9, iVar10, p });
}

/** algo-1  —— `return uVar1<<8 | (uVar2+uVar6)*0x1000000 | uVar3>>8` */
/**
 * mode 0x7  —— 与 MODE_1 同骨架（2 轮 Feistel + ARX），
 * **唯一差别是轮密钥选择**：
 *   Mode_1 第 0 轮用 `K(r-1) >> 1 & 0xffff`，第 1 轮 `K(r) >> 16`
 *   Mode_7 第 0 轮用 `K(r)` **全 32 位**，第 1 轮 `K(r) >> 16`
 * return 公式两者相同。
 */
export const MODE_7 = {
  fn: (p) => {
    p = p >>> 0;
    const rounds = (((p & 0xfffff) >>> 16) + 3);
    let K = 0xbbef73b2 >>> 0;
    for (let i = 0; i < rounds; i++) K = (ror32(K, 1) & 0x9fffffff) >>> 0;
    let uVar1 = ((((p & 0xff00) << 8) | ((p & 0xffffffff) << 24)) >>> 16) & 0xffffffff;  // R
    let uVar7 = (p >>> 16) & 0xffffffff;                                                 // L
    let uVar5 = 0, uVar6 = 0, uVar3 = 0;
    for (let iVar8 = 0; iVar8 !== 2; iVar8++) {
      uVar5 = uVar7;
      uVar6 = rol16(uVar1 ^ uVar5, rounds);
      uVar3 = K;                          // ⚠️ 第 0 轮用**全 32 位 K**
      if (iVar8 !== 0) uVar3 = (K >>> 16) & 0xffff;
      uVar7 = (uVar6 + uVar3) & 0xffff;
      uVar1 = uVar5;
    }
    // return uVar5<<8 | (uVar6+uVar3)*0x1000000 | uVar7>>8
    return u32((((uVar5 << 8) & 0xffffffff) | (((uVar6 + uVar3) * 0x1000000) >>> 0) | (uVar7 >>> 8)) >>> 0);
  },
};

export const MODE_1 = {
  fn: (p) => bitHashCore(p, (v) => {
    const { uVar1, uVar2, uVar3, uVar6 } = v;
    return u32((((uVar1 << 8) & 0xffffffff) | (((uVar2 + uVar6) * 0x1000000) >>> 0) | (uVar3 >>> 8)) >>> 0);
  }),
};


/** algo-39 （照抄） */

/** algo-10 （照抄） */

/** algo-F （照抄） */

/** 已逆出的 rotate+combine mode → 布局 */
/** algo-6 （照抄） */

/** algo-37 （照抄） */

/**
 * algo-4C  —— **n/方向/mode 位布局与 MODE_6 完全相同**，
 * 只有 modeMap 不同（0=ROT 1=OR 2=XOR 3=AND）。同骨架不同映射，不是笔误。
 */

/** algo-33 （照抄） */

/** algo-3B （照抄） */

/**
 * algo-50  —— **n/方向/mode 位布局与 MODE_3B 完全相同**，
 * 只有 mode 1 不同（AND 而非 OR）。又一个同骨架不同映射。
 */

/**
 * bit-hash 族（2 轮 Feistel + ARX）—— 照抄 原厂 `algo-1` 。
 *
 * ```
 * rounds = ((p >> 16) & 0xf) + 3
 * K      = ROR32(0xbbef73b2, rounds) & 0x9fffffff
 * L = p >> 16
 * R = (((p & 0xff00) << 8 | p << 24) >>> 16) & 0xffff      // 低 16 位字节交换
 * for i in 0..1:
 *     t  = ROL16(L ^ R, rounds)
 *     k  = (i == 0) ? ((K0 >> 1) & 0xffff) : (K >>> 16)     // K0 = 循环前的 uVar8
 *     L' = (t + k) & 0xffff ;  R' = L
 * 输出 = (L'<<8) | ((t+k)*0x1000000) | (L'>>8)             // 字节重排
 * ```
 * ⚠️ `K0` 是**循环移位之前**的 `0xbbef73b2`（解析里 `uVar8` 保存了前一轮值）。
 */


/** algo-1 的核心（也供同族复用） */

/** algo-1 ：return uVar1<<8 | (uVar2+uVar6)*0x1000000 | uVar3>>8 */

// ─────────────────────────────────────────────────────────────────────────────
// 32 位 rotate + combine（mode 0x8/11/12/1E/41/60）
// 工作字是**完整 param_1**（不是低 16 位）。modeMap 全族统一：
//   1 = p | r    2 = p ^ r    3 = ~p    0 = p & r
// ⚠️ `0x08` / `0x12` / `0x41` **三者位布局完全相同**（只是项的书写顺序不同），
//    是同骨架重复实现，不是我抄错。
// ─────────────────────────────────────────────────────────────────────────────

function rot32(x, n, left) {
  x >>>= 0; n &= 31;
  if (!n) return x;
  return left ? (((x << n) | (x >>> (32 - n))) >>> 0)
              : (((x >>> n) | (x << (32 - n))) >>> 0);
}

/** 32 位骨架：n / 方向 / mode 都由 spec 的纯函数算 */
function rotateCombine32(s, spec) {
  const p = s >>> 0;
  const n = spec.n(p) & 31;
  const r = rot32(p, n, spec.left(p));
  const m = spec.mode(p) & 3;
  const f = spec.modeMap[m];
  if (!f) throw new Error(`rotate32 mode=${m} 未定义`);
  return f(p, r);
}

const M32 = (v) => v >>> 0;
const RC32_MAP = {
  1: (p, r) => M32(p | r),
  2: (p, r) => M32(p ^ r),
  3: (p, _r) => M32(~p),
  0: (p, r) => M32(p & r),
};

/** mode 0x8 （= Mode_12 = Mode_41，位布局相同） */
export const MODE_8 = {
  // n = (p>>19)&4 | (p>>10)&2 | (p&3)>>1 | (p>>23)&8
  n: (p) => (((p >>> 19) & 4) | ((p >>> 10) & 2) | ((p & 3) >>> 1) | ((p >>> 23) & 8)),
  left: (p) => (p & 0x20000000) !== 0,   // (p&0x20000000)==0 → 右旋
  // mode = (p>>17)&2 | (p&0x7f)>>6
  mode: (p) => (((p >>> 17) & 2) | ((p & 0x7f) >>> 6)),
  modeMap: RC32_MAP,
};

/** mode 0x11  */
export const MODE_11 = {
  // n = (p>>17)&4 | (p>>4)&2 | (p&0x3fffffff)>>29 | (p>>15)&8
  n: (p) => (((p >>> 17) & 4) | ((p >>> 4) & 2) | ((p & 0x3fffffff) >>> 29) | ((p >>> 15) & 8)),
  left: (p) => (p & 0x4000000) !== 0,
  // mode = (p&0x7f)>>6 | (p>>17)&2
  mode: (p) => (((p & 0x7f) >>> 6) | ((p >>> 17) & 2)),
  modeMap: RC32_MAP,
};

/** mode 0x1E  */
export const MODE_1E = {
  // n = (p>>16)&8 | (p>>18)&4 | (p>>4)&2 | (p&0x3fffffff)>>29
  n: (p) => (((p >>> 16) & 8) | ((p >>> 18) & 4) | ((p >>> 4) & 2) | ((p & 0x3fffffff) >>> 29)),
  left: (p) => (p & 0x4000000) !== 0,
  // mode = (p&0x3fff)>>13 | (p&1)<<1
  mode: (p) => (((p & 0x3fff) >>> 13) | ((p & 1) << 1)),
  modeMap: RC32_MAP,
};

/** mode 0x60  */
export const MODE_60 = {
  // n = (p>>25)&4 | (p>>7)&2 | (p&7)>>2 | (p>>9)&8
  n: (p) => (((p >>> 25) & 4) | ((p >>> 7) & 2) | ((p & 7) >>> 2) | ((p >>> 9) & 8)),
  left: (p) => (p & 0x40000000) !== 0,
  // mode = (p>>21)&2 | (p&0x3f)>>5
  mode: (p) => (((p >>> 21) & 2) | ((p & 0x3f) >>> 5)),
  modeMap: RC32_MAP,
};

/** 32 位 rotate+combine 已逆出的（0x12/0x41 与 0x08 同布局） */
export const ROTATE_COMBINE32_MODES = {
  0x08: MODE_8, 0x11: MODE_11, 0x12: MODE_8, 0x1E: MODE_1E,
  0x41: MODE_8, 0x60: MODE_60,
};

/** Feistel 族（2 轮 ARX）—— 0x01 与 0x07 只差轮密钥选择 */
export const FEISTEL_MODES = { 0x01: MODE_1, 0x07: MODE_7 };

/**
 * 字长 VM 程序（mode 0x6E/6F/70/71/72）—— **复用 SA2 VM**。
 *
 * `sub_75759F58` 是 SA2 的字长变体：同一套指令集（0x81 SHL1 … 0x4C HALT），
 * 只是指令流是 u32 字、操作数散在 4 个字的低字节（大端连续）。
 * 这里存的是**转换后的字节程序**，`sa2Run` 直接可跑。
 * ✅ 0x6F/0x70/0x71/0x72 已 真值对拍 对拍通过（各 4 种子）。
 * ⚠️ 0x6E 的表**没有 HALT**（以 FOREND 结尾），终止条件待查，暂不收编。
 */
/**
 * 字长 VM 程序表（mode 0x6E–0x77 族）—— **64 位**累加器解释器，见 `seedkey-wordvm.js`。
 *
 * 提取方法（`tools/extract-wordvm.py` 同款）：`mode` 函数体里
 * `movs r2,#byteLen` + `ldr r1,[pc]`/`add r1,pc` 指向 rodata 的 **int32 数组**，
 * 每个元素取 `& 0xff` 就是一个 VM 字节（≥0x80 的存成负数）。
 * 已与真实 .so（仿真 真值对拍）32 点 × 9 个 mode 对拍全过 ✅
 */
export const WORDVM_PROGRAMS = {
  0x6e: '680893529177684a0b6809824987127741186b09680d814987869056684984214823384c',
  0x6f: '6807871e06135393040b13524a03826b068193190914068410041351494c',
  0x70: '680a874f5cf49c93d13246124a03826b06819371bafe308438f452b4494c',
  0x71: '93130120126807814a05870b22aa89494c',
  0x72: '680787251a71cb814a0584c8a50f6b494c',
  0x73: '680581680384150523104a06873312450681498433571045828712082001824a0181494c',
  0x75: '828282680787def5da85814a059355ea847d494c',
  0x76: '6805814a05870a22128949930002997f4c',
  0x77: '68059319820102814a058788913021494c',
};

// ─────────────────────────────────────────────────────────────────────────────
// 非 ASAP1A 入口（9x7 族 / 992 族 / Airbag）—— 照抄 参考诊断仪
// 全是 rotate+combine 或 SA2 程序，同一套骨架。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SecurityAccess_9x7_ALLRAD  —— rotate+combine 16 位
 *   工作字 = BE16(seed[0..1])
 *   n    = (s0&3)>>1 | (s0>>6)&2 | (s1&1)<<2 | (s1>>3)&8
 *   方向  = (s0 & 8) == 0 → 右旋
 *   mode = (s1>>2)&2 | (s1>>7)      1=OR 2=XOR 3=~x 0=AND
 *   输出  = BE2
 */
export const MODE_9X7_ALLRAD = {
  n: (p) => {
    const s0 = (p >>> 24) & 0xff, s1 = (p >>> 16) & 0xff;
    return (((s0 & 3) >>> 1) | ((s0 >>> 6) & 2) | ((s1 & 1) << 2) | ((s1 >>> 3) & 8));
  },
  left: (p) => (((p >>> 24) & 0xff) & 8) !== 0,
  mode: (p) => {
    const s1 = (p >>> 16) & 0xff;
    return (((s1 >>> 2) & 2) | (s1 >>> 7));
  },
  modeMap: {
    1: (x, r) => M16(x | r), 2: (x, r) => M16(x ^ r),
    3: (x, _r) => M16(~x),  0: (x, r) => M16(x & r),
  },
  // 工作字是 BE16
  pack: (p) => (p >>> 16) & 0xffff,
  outBE: true,
};

/** SecM_9x7_PCMKey  —— rotate+combine 16 位，输出 BE2 */
export const MODE_9X7_PCMKEY = {
  // ⚠️ C 里 n 的位来自 **seed[0]（uVar7）**，方向/部分 mode 来自 **seed[1]（bVar1）** —— 别搞反
  n: (p) => {
    const s0 = (p >>> 24) & 0xff, s1 = (p >>> 16) & 0xff;
    return (((s0 >>> 1) & 8) | ((s0 & 0x80) ? 4 : 0) | ((s1 & 8) ? 2 : 0) | ((s1 & 1) ? 1 : 0));
  },
  left: (p) => (((p >>> 16) & 0xff) & 0x80) !== 0,      // bVar1 = seed[1]
  mode: (p) => {
    const s0 = (p >>> 24) & 0xff, s1 = (p >>> 16) & 0xff;
    return (((s0 >>> 1) & 2) | ((s1 & 0x20) ? 1 : 0));
  },
  modeMap: {
    0: (x, r) => M16(x + r), 2: (x, _r) => M16(~x),
    1: (x, r) => M16(x ^ r),
    3: (_x, r) => r,                 // C 里无该分支 → uVar2 不变 = 旋转结果
  },
  pack: (p) => (p >>> 16) & 0xffff,
  outBE: true,
};

/** SeedAndKeyPag_9x7_SK_PSM8  —— rotate+combine 16 位，输出 hex 字符串 */
export const MODE_9X7_PSM8 = {
  n: (p) => {
    const s0 = (p >>> 24) & 0xff, s1 = (p >>> 16) & 0xff;
    return (((s1 & 4) << 1) | ((s1 & 2) << 1) | ((s1 >>> 3) & 2) | ((s0 & 0x3f) >>> 5));
  },
  left: (p) => (((p >>> 24) & 0xff) & 4) !== 0,
  mode: (p) => {
    const s0 = (p >>> 24) & 0xff, s1 = (p >>> 16) & 0xff;
    return (((s0 & 0x1f) >>> 4) | ((s1 >>> 5) & 2));
  },
  modeMap: {
    1: (x, r) => M16(x & r), 2: (x, r) => M16(x ^ r),
    3: (x, r) => M16(x | r), 0: (x, r) => M16(x | r),
  },
  pack: (p) => (p >>> 16) & 0xffff,
  hexOut: true,   // 输出是 4 个 ASCII hex 字符
};

/**
 * ASAM_seedkey_Airbag_Upload_CONFIDENTIAL  —— 26 轮 ARX 哈希
 *   x = seed（按长度取低字节拼成 u32）
 *   重复 26 次：t = x + 0x54525730;  x = ROR32(t, 2);  if (t>>1 & 1) x ^= 0x2921980
 *   输出 4 字节，**字节序倒置**（先写 >>24，再递减）
 */
export function airbagUploadKey(seedBytes) {
  const n = Math.min(seedBytes.length, 4);
  let x = 0;
  for (let i = 0; i < n; i++) x = ((x << 8) | seedBytes[i]) >>> 0;
  if (n === 1) x = seedBytes[1] >>> 0;   // ⚠️ 静态分析：长度为 1 时取 param_1[1]
  // ⚠️ 逐行照抄 C 的双重移位，别自作聪明整理：
  //    local_24 = (uVar7 >> 1 | local_24 << 0x1f) >> 1 | (uVar7 >> 1) << 0x1f
  //    其中 uVar7 = local_24 + 0x54525730（用的是**旧** local_24）
  for (let i = 0; i < 0x1a; i++) {
    const t = (x + 0x54525730) >>> 0;
    const A = ((t >>> 1) | (x << 31)) >>> 0;
    x = ((A >>> 1) | ((t >>> 1) << 31)) >>> 0;
    if (((t >>> 1) & 1) !== 0) x = (x ^ 0x02921980) >>> 0;
  }
  // 输出：param_3[0] = x>>24，然后循环写 x 的字节 2,1,0 → 实为**大端**
  return Uint8Array.of((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
}

/**
 * mode* —— rotate+combine 16 位（静态分析逐条抄，真值对拍 32 点验证）。
 * ⚠️ 三条通式（各 mode 只是位来源和组合式不同）：
 *    w    = param_1 & 0xffff          （lo16）
 *    n    = 若干 (p>>k)&m 的或         → 旋转次数
 *    dir  = (p & M)==0 ? ROL : ROR
 *    mode = 若干 (p>>k)&m 的或         → 组合式
 *   组合式里 **和 param_1 全 32 位** 运算（不是只和 w），所以结果可能带高位。
 */

/**
 * rotate+combine **符号扩展**骨架（2026-10-18 真值对拍 逐点逼出来的语义）：
 *   n == 0  → 循环跳过，A = **完整 seed**
 *   n  > 0  → A = **符号扩展**的 16 位旋转结果（C: `(uint)(short)uVar1`）
 *   组合    → A OP B，B 是完整 seed 或 w=seed&0xffff（因函数而异）
 * 之前漏了符号扩展和 n==0，只对到 17/32、31/32。
 *
 * ⚠️ 方向极性**因函数而异**：`==0` 分支是 `<<1`+`>>0xf` 则 bit 清=ROL（invert），
 *    是 `>>1`+`<<0xf` 则 bit 清=ROR。别假定。
 */
export function rotateCombine16SX(s, spec) {
  const n = spec.n(s) & 15;
  let A;
  if (n === 0) {
    // ⚠️ n==0 循环跳过，A = 初值（seed 或 w），**仍要走组合**（不是直接返回）
    A = (spec.n0W ? (s & 0xffff) : s) >>> 0;
  } else {
    const dir = spec.invert ? ((s & spec.dirMask) === 0) : ((s & spec.dirMask) !== 0);
    let v = s & 0xffff;
    for (let i = 0; i < n; i++) {
      v = dir ? ((((v << 1) | (v >>> 15)) & 0xffff)) : ((((v >>> 1) | (v << 15)) & 0xffff));
    }
    A = (v & 0x8000) ? u32(0xFFFF0000 | v) : u32(v);
  }
  const B = spec.withW ? (s & 0xffff) : s;
  if (spec.combineMap) {
    const mode = spec.mode ? (spec.mode(s) & 3) : 0;
    const f = spec.combineMap[mode];
    let r = f ? f(A, B, s) : A;
    return spec.finalMask ? (r & 0xffff) : (r >>> 0);
  }
  return spec.combine(A, B, s);
}




/**
 * rotate+combine 符号扩展族（RC_SX）—— tools/fit-rc-standalone.mjs 生成。
 * 每条都经 仿真 真值对拍 **32 点全过**才收。语义见 rotateCombine16SX。
 * n==0 → A=(n0W ? w : seed)；n>0 → A=outForm 的旋转结果；组合 A OP B；finalMask 截 16 位。
 */
export const RC_SX_MODES = {
  0x2: {
    n: (p) => (((p >>> 3) & 2) | ((p >>> 2) & 8) | (p & 4) | ((p & 32767) >>> 14)),
    mode: (p) => (((p >>> 6) & 2) | ((p & 4095) >>> 11)),
    dirMask: 0x200, invert: true,
    withW: false, finalMask: false,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A & B),
    1: (A, B) => u32(A | B),
    2: (A, B) => u32(A ^ B)
    },
  },
  0x9: {
    n: (p) => (((p >>> 3) & 2) | (p & 4) | ((p & 32767) >>> 14) | ((p >>> 2) & 8)),
    mode: (p) => (((p >>> 6) & 2) | ((p & 4095) >>> 11)),
    dirMask: 0x200, invert: true,
    withW: false, finalMask: true,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A & B),
    1: (A, B) => u32(A + B),
    2: (A, B) => u32(A ^ B)
    },
  },
  0xB: {
    n: (p) => (((p & 4) << 1) | ((p & 2) << 1) | ((p >>> 3) & 2) | ((p & 16383) >>> 13)),
    mode: (p) => (((p & 8191) >>> 12) | ((p >>> 5) & 2)),
    dirMask: 0x400, invert: false,
    withW: false, finalMask: true,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A | B),
    1: (A, B) => u32(A & B),
    2: (A, B) => u32(A ^ B),
    3: (A, B) => u32(0)
    },
  },
  0xD: {
    n: (p) => (((p >>> 3) & 2) | (p & 4) | ((p & 32767) >>> 14) | ((p >>> 2) & 8)),
    mode: (p) => (((p & 4095) >>> 11) | ((p >>> 6) & 2)),
    dirMask: 0x200, invert: false,
    withW: false, finalMask: true,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A & B),
    1: (A, B) => u32(A | B),
    2: (A, B) => u32(A ^ B)
    },
  },
  0xE: {
    n: (p) => (((p >>> 4) & 2) | (p & 12) | ((p & 32767) >>> 14)),
    mode: (p) => (((p & 16383) >>> 13) | ((p >>> 6) & 2)),
    dirMask: 0x800, invert: false,
    withW: false, finalMask: true,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A & B),
    1: (A, B) => u32(A | B),
    2: (A, B) => u32(A ^ B),
    3: (A, B) => u32(~B)
    },
  },
  0x17: {
    n: (p) => ((p & 10) | ((p & 32767) >>> 14) | ((p & 1) << 2)),
    mode: (p) => (((p & 1023) >>> 9) | ((p >>> 4) & 2)),
    dirMask: 0x40, invert: true,
    withW: false, finalMask: true,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A ^ B),
    1: (A, B) => u32(A & B),
    2: (A, B) => u32(~A),
    3: (A, B) => u32(A | B)
    },
  },
  0x67: {
    n: (p) => (((p >>> 8) & 4) | ((p >>> 6) & 2) | ((p & 63) >>> 5) | ((p >>> 12) & 8)),
    mode: (p) => ((p & 1) | ((p >>> 13) & 2)),
    dirMask: 0x8, invert: true,
    withW: false, finalMask: true,
    n0W: false,
    combineMap: {
    0: (A, B) => u32(A | B),
    1: (A, B) => u32(A ^ B),
    2: (A, B) => u32(A & B),
    3: (A, B) => u32(~B)
    },
  },
};

export const ROTATE_COMBINE_MODES = {
  0x2: RC_SX_MODES[0x2], 0x9: RC_SX_MODES[0x9], 0xB: RC_SX_MODES[0xB], 0xD: RC_SX_MODES[0xD], 0xE: RC_SX_MODES[0xE], 0x17: RC_SX_MODES[0x17], 0x67: RC_SX_MODES[0x67], 0x9: RC_SX_MODES[0x9], 0xB: RC_SX_MODES[0xB], 0xD: RC_SX_MODES[0xD], 0xE: RC_SX_MODES[0xE], 0x17: RC_SX_MODES[0x17], 0x67: RC_SX_MODES[0x67],
  0x02: RC_SX_MODES[0x2], 0x09: RC_SX_MODES[0x9], 0x0D: RC_SX_MODES[0xD], 0x0E: RC_SX_MODES[0xE], 0x17: RC_SX_MODES[0x17], 0x67: RC_SX_MODES[0x67],
  0x02: RC_SX_MODES[0x2], 0x09: RC_SX_MODES[0x9], 0x0D: RC_SX_MODES[0xD], 0x0E: RC_SX_MODES[0xE], 0x17: RC_SX_MODES[0x17], 0x67: RC_SX_MODES[0x67],
  0x06: MODE_6, 0x0A: MODE_A, 0x0F: MODE_F, 0x10: MODE_10,
  0x18: MODE_18, 0x33: MODE_33, 0x37: MODE_37, 0x3B: MODE_3B, 0x39: MODE_39, 0x4C: MODE_4C, 0x50: MODE_50,
};


export { rotateCombine16, rot16 };
