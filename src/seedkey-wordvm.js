/**
 * Porsche seed/key —— **字长 VM** 解释器（mode 0x6E–0x77 族）。
 *
 * 🔑 2026-10-18 · 从 `原厂口令算法库` 静态分析直译。
 *    与 `seedkey-sa2.js`（字节版 SA2 VM）**不是同一个解释器**：
 *
 * | | 字节版 SA2 | 字长 VM（本文件） |
 * |---|---|---|
 * | 入口 | `calculateSecurityKeySA2`  | `sub_75759F58`  + 解释器  |
 * | 取指 | `securityAlgorithm[ip]`（**字节**） | `mem32[ip]`（**int32 数组**） |
 * | 累加器 | 32 位 `x` | **64 位** `hi:lo`（r8:r5） |
 * | 内存 | 无 | `malloc(4n+4)` 的变量区（程序先拷一份进去，实测未被读取） |
 *
 * ## 程序表怎么来的
 * `mode 0x6E` 等函数体：
 * ```
 *   memcpy(sp+0x28, rodataBlob, byteLen)      // int32 数组，值 ≥0x80 存成负数
 *   mem = malloc(4*byteLen + 4)
 *   for (i=0; i<byteLen; i++) mem[i] = blob[i]   // ⚠️ 按**字节数**当字数，多读 3 倍
 *   vmRun(ctx, 0, seed, mem, …)               // ctx[0x18]=byteLen, ctx[0x10]=mem
 * ```
 * 所以程序 = `blob[i] & 0xff` 逐字节拼起来（opcode 与操作数各占 1 个字 = 1 字节）。
 * ⚠️ 那段「按字节数当字数」的多读会越过栈帧（原厂就这么写的），实测结果**不依赖**
 *    多读到的内容（改 SP/HEADROOM 结果不变），所以这里按干净语义实现。
 *
 * ## 指令集（解释器  逐条直译）
 *   0x81 SHL1   lo = lo<<1 | bit31;  carry = bit31;  hi = 0
 *   0x82 SHR1   lo = (hi&1)<<31 | lo>>>1;  carry = lo&1(旧);  hi = 0   ← ⚠️ 依赖 hi
 *   0x84 SUB    lo -= v;  hi -= (v<0?-1:0) + borrow;  carry = (hi <= -1)
 *   0x87 XOR    lo ^= v;  carry = 0;  hi = 0
 *   0x93 ADD    lo += v;  hi += carryOut;  carry = (hi > 0);  hi = 0
 *   0x4A JNZ    carry≠0 ? ip+2 : ip + mem32[ip+1] + 2
 *   0x6B JMP    ip + mem32[ip+1] + 2
 *   0x68 FOR    count = mem32[ip+1]（有符号），循环到 0x49，结束 ip = forend+1
 *   0x49 FOR-END
 *   0x4C HALT   （由调用方循环判；解释器里是 NOP）
 *
 * ## hi 的传播范围（⚠️ 关键，漏了就错）
 * 调用方 `sub_75759F58` 的循环每次都把 hi 参数写成 0 再调解释器：
 *
 *     do { lo = vmStep(ctx, ip, lo, 0); ip = ctx[0]; } while (mem32[ip] != 0x4C);
 * 所以 **hi 只在 FOR 体内部逐条传播**，FOR 结束后回到顶层又变 0。
 * 0x73 正是「FOR 体内 SUB 借位 → 紧接 SHR1 用 hi 填 bit31」才和字节版分叉的。
 */

const IP_MAX = 200;
const OP_HALT = 0x4c;
const OP_FOREND = 0x49;
const OP_FOR = 0x68;

const u32 = (x) => x >>> 0;
/** 当成有符号 32 位（C 的 `int`） */
const i32 = (x) => x | 0;

/** 读 4 字节大端操作数（4 个**字**各存 1 字节 → 等价按字节读） */
function getOperand(prog, ip) {
  if (ip + 4 >= prog.length) return 0;
  return ((prog[ip + 1] << 24) | (prog[ip + 2] << 16) | (prog[ip + 3] << 8) | prog[ip + 4]) >>> 0;
}

/** 取位于 ip+1 的单字（FOR 计数 / 跳转偏移），按**有符号**解释 */
function getImm8(prog, ip) {
  const b = ip + 1 < prog.length ? prog[ip + 1] : 0;
  return (b << 24) >> 24;
}

/**
 * 执行一条指令。
 * @returns {{lo,hi,ip,carry,forOp?:boolean,halted?:boolean}}
 */
function execOne(prog, lo, hi, ip, carry) {
  const op = prog[ip];
  const sop = (op << 24) >> 24;          // 有符号 opcode

  if (sop > OP_FOREND) {                  // 0x4A / 0x4C / 0x68 / 0x6B
    if (op < 0x68) {
      if (op === 0x4a) {                  // JNZ
        if (carry !== 0) return { lo, hi, ip: ip + 2, carry };
        return { lo, hi, ip: ip + getImm8(prog, ip) + 2, carry };
      }
      if (op === OP_HALT) return { lo, hi, ip, carry, halted: true };
      return { lo, hi, ip, carry, halted: true };      // 其余 = NOP
    }
    if (op === OP_FOR) return { lo, hi, ip, carry, forOp: true };
    return { lo, hi, ip: ip + getImm8(prog, ip) + 2, carry };   // 0x6B JMP
  }

  switch (sop) {
    case -0x7f: {                          // 0x81 SHL1
      const b = (lo & 0x80000000) !== 0 ? 1 : 0;
      return { lo: u32((lo << 1) | b), hi: 0, ip: ip + 1, carry: b };
    }
    case -0x7e: {                          // 0x82 SHR1 —— ⚠️ bit31 有**两个**来源
      const c = lo & 1;
      // 汇编：`lsl r0, r8, #31` → `orr r2, r0, r5, lsr #1`
      //       `tst r5,#1` 命中时再 `orr r5, r2, #0x80000000`
      // 即 bit31 = (hi & 1) | (旧 bit0)，两者任一为 1 就置位。
      let nlo = u32(((hi & 1) << 31) | (lo >>> 1));
      if (c) nlo = u32(nlo | 0x80000000);
      return { lo: nlo, hi: 0, ip: ip + 1, carry: c };
    }
    case -0x7c: {                          // 0x84 SUB（64 位减）
      const v = getOperand(prog, ip);
      const borrow = u32(lo) < v ? 1 : 0;
      const nlo = u32(lo - v);
      // C: `subs r5,r5,r0; sbc r8,r8,r1`，r1 = (int)v >> 31 = v<0 ? -1 : 0
      const nhi = i32(i32(hi) - (i32(v) < 0 ? -1 : 0) - borrow);
      // `cmp r8,#-1; bgt` → carry = !(nhi > -1)
      return { lo: nlo, hi: nhi, ip: ip + 5, carry: i32(nhi) > -1 ? 0 : 1 };
    }
    case -0x79: {                          // 0x87 XOR
      return { lo: u32(lo ^ getOperand(prog, ip)), hi: 0, ip: ip + 5, carry: 0 };
    }
    case -0x6d: {                          // 0x93 ADD（64 位加）
      const v = getOperand(prog, ip);
      const sum = u32(lo) + v;
      const nlo = u32(sum);
      const out = sum > 0xFFFFFFFF ? 1 : 0;
      const nhi = i32(i32(hi) + out);      // 操作数高字实测为 0
      // `cmp r8,#0; ble` → carry = (nhi > 0)；随后 hi 归 0
      return { lo: nlo, hi: 0, ip: ip + 5, carry: i32(nhi) > 0 ? 1 : 0 };
    }
    default:                               // 0x83/0x85/0x86/0x49/0x4C … NOP
      return { lo, hi, ip: ip + 1, carry };
  }
}

/** 指令长度（按 opcode 算，**不能**按字节扫） */
function instrLen(prog, ip) {
  const op = prog[ip];
  if (op === OP_FOR || op === 0x4a || op === 0x6b) return 2;
  const s = (op << 24) >> 24;
  if (s === -0x7c || s === -0x79 || s === -0x6d) return 5;
  return 1;
}

/** 从 bodyStart 起找与**本层** FOR 匹配的 0x49（跳过嵌套） */
function findForend(prog, bodyStart) {
  let p = bodyStart, depth = 1;
  while (p < prog.length) {
    const op = prog[p];
    if (op === OP_FOR) { depth++; p += 2; continue; }
    if (op === OP_FOREND) { depth--; if (depth === 0) return p; p += 1; continue; }
    if (op === OP_HALT) return -1;
    p += instrLen(prog, p);
  }
  return -1;
}

/** FOR 体执行（hi 在**体内部**逐条传播） */
function execFor(prog, lo, hi, ip, carry, onStep) {
  const count = getImm8(prog, ip);
  const bodyStart = ip + 2;
  if (count <= 0) return { lo: 0, hi: 0, ip: bodyStart, carry };
  for (let n = 0; n < count; n++) {
    let p = bodyStart;
    while (p < prog.length && prog[p] !== OP_FOREND) {
      if (onStep) onStep(p, lo, hi, carry);
      const r = execOne(prog, lo, hi, p, carry);
      lo = r.lo; hi = r.hi; p = r.ip; carry = r.carry;
      if (r.forOp) {
        const fr = execFor(prog, lo, hi, p, carry, onStep);
        lo = fr.lo; hi = fr.hi; p = fr.ip; carry = fr.carry;
      }
      if (r.halted) return { lo, hi, ip: p, carry, halted: true };
    }
  }
  const e = findForend(prog, bodyStart);
  return { lo, hi, ip: e < 0 ? bodyStart : e + 1, carry };
}

/**
 * 跑完整字长 VM 程序。
 * @param {number} seed  32 位无符号
 * @param {Uint8Array|number[]} prog  程序字节流（每字 1 字节）
 * @returns {number} 32 位 key
 */
export function wordVmRun(seed, prog, onStep) {
  const p = Array.from(prog);
  let lo = u32(seed), hi = 0, ip = 0, carry = 0;
  let guard = 0;
  while (p[ip] !== undefined && p[ip] !== OP_HALT) {
    if (++guard > 200000) throw new Error('字长 VM 死循环');
    if (onStep) onStep(ip, lo, hi, carry);
    // ⚠️ 顶层每次都用 hi=0 调解释器（见文件头「hi 的传播范围」）
    const r = execOne(p, lo, 0, ip, carry);
    lo = r.lo; hi = r.hi; ip = r.ip; carry = r.carry;
    if (r.forOp) {
      const fr = execFor(p, lo, hi, ip, carry, onStep);
      lo = fr.lo; hi = fr.hi; ip = fr.ip; carry = fr.carry;
    }
    if (r.halted) break;
  }
  return u32(lo);
}

/** 4 字节大端入/出 */
export function wordVmKey(seedBytes, prog) {
  const s = ((seedBytes[0] << 24) | (seedBytes[1] << 16) | (seedBytes[2] << 8) | seedBytes[3]) >>> 0;
  const k = wordVmRun(s, prog);
  return new Uint8Array([(k >>> 24) & 0xff, (k >>> 16) & 0xff, (k >>> 8) & 0xff, k & 0xff]);
}

export { OP_HALT, OP_FOR, OP_FOREND };
