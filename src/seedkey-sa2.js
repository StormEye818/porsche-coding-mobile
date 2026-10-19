/**
 * Porsche seed/key —— SA2 虚拟机实现。
 *
 * 🔑 解出结论（2026-10-17，工具链 解析 core.so）：
 *    **93 个变体不是 93 个算法，而是 1 个 VM 解释器 + 93 段小程序**。
 *    黑盒方法（查找表/指纹聚类）看不出这层；只有伪代码能看出来。
 *
 * 每个 `ASAP1A_CCP_ComputeKeyFromSeed_<ECU>` 变体的结构：
 * ```
 *   char prog[17];                       // VM 程序（17 字节）
 *   uint32 seed32 = BE32(seed[0..3]);    // seed 4 字节大端
 *   uint32 key32  = sa2Run(seed32, prog);
 *   *(uint32*)key = BE32(key32);         // key 4 字节大端
 *   *outLen = 4;
 * ```
 *
 * VM 指令集（`sa2ExecuteCommand`  解析）：
 *   0x81  SHL1   x<<1，bit31→bit0，carry=旧 bit31
 *   0x82  SHR1   x>>1（32 位循环），bit0→bit31，carry=旧 bit0
 *   0x84  SUB    x - imm32（大端），carry=借位
 *   0x87  XOR    x ^ imm32，carry=0
 *   0x93  ADD    x + imm32，carry=进位
 *   0x4A  JNZ    carry≠0 ? ip+2 : ip = imm8+2
 *   0x6B  JMP    ip = imm8+2
 *   0x68  FOR    count=table[ip+1]，循环到 `0x49`（'I'）结束标记
 *   0x49  FOR-END 标记（仅被 FOR 识别）
 *   0x4C  HALT   返回 x
 *   0x83/0x85/0x86  NOP
 */

const IP_MAX = 100;          // securityAlgorithm 缓冲长度
const OP_HALT = 0x4c;        // 'L'
const OP_FOREND = 0x49;      // 'I'
const OP_FOR = 0x68;         // 'h'

function u32(x) { return x >>> 0; }

/** 读 4 字节大端操作数（sa2Get4ByteOperand） */
function getOperand(prog, ip) {
  if (ip + 5 < IP_MAX) {
    return ((prog[ip + 1] << 24) | (prog[ip + 2] << 16) | (prog[ip + 3] << 8) | prog[ip + 4]) >>> 0;
  }
  return 0;
}

/**
 * 执行一条 VM 指令。
 * @returns {{x:number, ip:number, carry:number}}
 */
function execOne(prog, x, ip, carry) {
  const op = prog[ip];
  // ⚠️ 必须按**有符号 char** 分派（解析 `iVar3 = (int)(char)securityAlgorithm[ip]`）：
  //    0x81 作为无符号是 129 > 0x49 会被误判成 JMP，实际有符号是 -0x7f 应走 SHL1。
  const sop = (op << 24) >> 24;
  if (sop > 0x49) {
    if (op < 0x68) {
      if (op === 0x4a) {              // JNZ：carry≠0 → ip+2；否则 ip = imm8+2
        if (carry !== 0) return { x, ip: ip + 2, carry };
        const t = (ip + 1 < IP_MAX) ? prog[ip + 1] + 2 : 2;
        return { x, ip: ip + t, carry };
      }
      if (op === OP_HALT) return { x, ip, carry, halted: true };
      return { x: 0, ip, carry, halted: true };
    }
    if (op === OP_FOR) return { x, ip, carry, forOp: true };
    // 0x6b JMP
    const t = (ip + 1 < IP_MAX) ? prog[ip + 1] + 2 : 2;
    return { x, ip: ip + t, carry };
  }
  // 算术/逻辑（0x81-0x93 段）
  const s = (op << 24) >> 24;   // 有符号
  let nx = 0, nc = 0, nip = ip + 1;
  if (s === -0x7f) {              // 0x81 SHL1 = 32 位循环左移 1
    // 解析：`bVar5 = param_1 < 0` 是**有符号**比较 → 取 bit31；
    // `uVar4 = param_1 << 1; if (bVar5) uVar4 |= 1` 把 bit31 转进 bit0。
    // ⚠️ JS 里 x 已是 u32，`x < 0` 恒假 —— 必须显式取 bit31（这条曾导致 6/10 对拍失败）。
    const b = (x & 0x80000000) !== 0;
    nx = u32((x << 1) | (b ? 1 : 0));
    nc = b ? 1 : 0;
  } else if (s === -0x7e) {       // 0x82 SHR1 = 32 位循环右移 1
    // C 里 `param_1 >> 1` 是算术右移，`^ 0x80000000` 在补偿符号位 —— 等价于
    // JS 的 `>>>`（逻辑右移），所以这里直接逻辑右移，再把 bit0 转进 bit31。
    const b = (x & 1) !== 0;
    nx = u32(x >>> 1);
    if (b) nx = u32(nx | 0x80000000);
    nc = b ? 1 : 0;
  } else if (s === -0x7c) {       // 0x84 SUB
    const v = getOperand(prog, ip);
    nc = u32(x) < v ? 1 : 0;
    nx = u32(x - v);
    nip = ip + 5;
  } else if (s === -0x79) {       // 0x87 XOR
    const v = getOperand(prog, ip);
    nx = u32(x ^ v); nc = 0; nip = ip + 5;
  } else if (s === -0x6d) {       // 0x93 ADD
    const v = getOperand(prog, ip);
    const r = u32(x) + v;
    nx = u32(r);
    nc = r > 0xFFFFFFFF ? 1 : 0;
    nip = ip + 5;
  } else {
    // 0x83/0x85/0x86 NOP 等
    nx = x; nc = carry;
  }
  return { x: nx, ip: nip, carry: nc };
}

/**
 * 指令长度（按 opcode，**不能**按字节扫——imm32 操作数里会出现 0x49/0x68/0x4C）。
 * 与 sa2ExecuteCommand / sa2Get4ByteOperand 解析一致。
 */
function instrLen(prog, ip) {
  const op = prog[ip];
  const s = (op << 24) >> 24;
  if (op === OP_FOR || op === 0x4a || op === 0x6b) return 2;      // FOR / JNZ / JMP
  if (s === -0x7c || s === -0x79 || s === -0x6d) return 5;        // SUB / XOR / ADD
  return 1;                                                       // SHL1/SHR1/NOP/FEND/HALT
}

/**
 * 从 bodyStart 起，找与**外层** FOR 匹配的 0x49（跳过嵌套 FOR 块）。
 * 解析里内层 while 退出时 `instructionPointer` 正停在 0x49 上，随后 +1 跳过它。
 */
function findForend(prog, bodyStart) {
  let p = bodyStart, depth = 1;
  while (p < IP_MAX && prog[p] !== undefined) {
    const op = prog[p];
    if (op === OP_FOR) { depth++; p += 2; continue; }
    if (op === OP_FOREND) {
      depth--;
      if (depth === 0) return p;
      p += 1;
      continue;
    }
    if (op === OP_HALT) return -1;
    p += instrLen(prog, p);
  }
  return -1;
}

/** 执行 FOR 体（sa2ExecuteForLoop ） */
function execFor(prog, x, ip, carry) {
  if (prog[ip] !== OP_FOR) return { x: 0, ip, carry, halted: true };
  // 解析：`iVar4 = (int)(char)securityAlgorithm[ip+1]` —— **有符号 char**，
  // count 的 bit7 置位就是负数 → 循环体一次都不进。
  const count = (prog[ip + 1] << 24) >> 24;
  const bodyStart = ip + 2;
  if (count <= 0) {
    // 解析：`instructionPointer = iVar5; return 0;` —— 返回 **0**（不是 x），ip=ip+2
    return { x: 0, ip: bodyStart, carry };
  }
  for (let n = 0; n < count; n++) {
    let p = bodyStart;
    while (prog[p] !== OP_FOREND) {
      const r = execOne(prog, x, p, carry);
      x = r.x; p = r.ip; carry = r.carry;
      if (r.forOp) { const fr = execFor(prog, x, p, carry); x = fr.x; p = fr.ip; carry = fr.carry; }
      if (r.halted) return { x, ip: p, carry, halted: true };
    }
    // 此时 p 停在本层 body 的 0x49 上；下一圈从 bodyStart 重来（解析 `iVar3+2`）
  }
  // 解析：`instructionPointer = instructionPointer + 1` → 本层 0x49 的下一位
  const end = findForend(prog, bodyStart);
  return { x, ip: end < 0 ? bodyStart : end + 1, carry };
}

/** 跑完整 VM 程序 */
export function sa2Run(seed, prog) {
  let x = seed >>> 0, ip = 0, carry = 0;
  let guard = 0;
  while (prog[ip] !== OP_HALT) {
    if (++guard > 100000) throw new Error('SA2 VM 死循环');
    const r = execOne(prog, x, ip, carry);
    x = r.x; ip = r.ip; carry = r.carry;
    if (r.forOp) {
      const fr = execFor(prog, x, ip, carry);
      x = fr.x; ip = fr.ip; carry = fr.carry;
    }
    if (r.halted) break;
  }
  return x >>> 0;
}

/**
 * 用 17 字节程序算 key（4 字节大端入/出）。
 * @param {Uint8Array} seed  4 字节
 * @param {Uint8Array} prog  17 字节 VM 程序
 * @returns {Uint8Array} 4 字节 key
 */
export function computeKey(seed, prog) {
  const s32 = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
  const k32 = sa2Run(s32, prog);
  return new Uint8Array([(k32 >>> 24) & 0xff, (k32 >>> 16) & 0xff, (k32 >>> 8) & 0xff, k32 & 0xff]);
}

export { OP_HALT, OP_FOR, OP_FOREND };
