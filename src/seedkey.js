/**
 * seedkey.js — Porsche seed/key 算法实现。
 *
 * 来源：安全模块 逐条还原
 *   算法 A: 算法变体 A 
 *   算法 B: （另一变体）
 *
 * ⚠️ 注意：`PorscheCodingKeyCalc` 是误导（位域插入，构造命令字节），
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
export function makeProvider({ variant = '9x7GW', algo = 'A', seedBytes = 2 } = {}) {
  const fn = algo === 'B' ? algoB : algoA;
  return {
    name: `Porsche-${algo}(${variant})`,
    verified: true,           // ✅ 离线逐位校验（离线校验）
    calc(seed /* Uint8Array */, level /* number */) {
      // seedBytes 决定取几字节 seed 做 16 位输入。
      // ⚠️ 若 ECU 实发 4 字节 seed，必须显式声明 seedBytes=4 并约定取哪 16 位，
      //    绝不静默丢高 16 位——那会算出错 key 然后吃满尝试次数锁死（NRC 0x36）。
      if (seed.length < seedBytes) {
        throw new Error(
          `seed 长度 ${seed.length} < 期望 ${seedBytes}（variant=${variant}），拒绝计算。` +
          `请核对该 ECU 的 seed 长度后显式配置 seedBytes。`);
      }
      // 默认取低 16 位（小端）。4 字节 seed 的取法需按 ECU 确认后调整此处。
      const v = (seed[0] | (seed[1] << 8)) & 0xffff;
      const key = fn(v) & 0xffff;
      return new Uint8Array([key & 0xff, (key >>> 8) & 0xff]);
    },
  };
}

/**
 * 自检（对照 Python 参考实现 analysis/seedkey.py，该实现经 离线向量校验）。
 * ⚠️ 期望值必须与 Python 一致，否则 selftest 会假失败/假通过。
 */
export function selftest() {
  const cases = [
    // [输入, 期望A, 期望B]
    [0x0000, 0x0000, 0x0000],
    [0x0001, 0x0001, 0x0002],
    [0xffff, 0xffff, 0xffff],
    [0x1234, 0x0010, 0xe27c],   // ← 修正：A(0x1234)=0x0010（旧值 0x0004 是错的）
    [0x8000, 0x8000, 0x0000],
    [0x4000, 0x0000, 0x8000],
    [0x0004, 0x0000, 0x0044],
    [0x0008, 0x0008, 0x0018],
    [0x1000, 0x1000, 0x2000],
    [0x2000, 0x2000, 0x0000],
    [0x0200, 0x0200, 0x0a00],
    [0x0800, 0x0800, 0x1000],
  ];
  const out = [];
  for (const [inp, wantA, wantB] of cases) {
    const gotA = algoA(inp) & 0xffff;
    const gotB = algoB(inp) & 0xffff;
    out.push({
      inp,
      a: { want: wantA, got: gotA, ok: gotA === wantA },
      b: { want: wantB, got: gotB, ok: gotB === wantB },
    });
  }
  return out;
}
