/**
 * Porsche seed/key —— **内联 VM** 解释器（按实测行为对齐，不许化简）。
 *
 * 🔑 与 `seedkey-sa2.js` 的区别（2026-10-18 解出）
 *    sa2 那套是**独立函数** `sa2ExecuteCommand`（）被 93 个变体共用；
 *    这一族是**编译器把解释器内联进每个变体函数里**（`local_50[40]` 栈上程序 +
 *    一个 do-while 大 switch）。指令**助记符相同**，但 **FOR 的实现机制不同**：
 *
 *      sa2  : `execFor` 递归 —— 取出 count，循环 count 次，遇到 0x49 停
 *      内联 : **扁平** —— 0x68 只做「压栈记录」并 pc+=2 继续往下走；
 *             走到 0x49 时查计数器，减 1，没到 1 就 `pc = body[depth]` 回跳
 *
 *    两者在「循环体里没有跨越 0x49 的跳转」时等价；一旦有 JMP 跳出/跳入循环体，
 *    或者 count<=0，行为就分叉：
 *      · sa2     count<=0 → **x 归零**并跳过循环体（静态分析 `return 0`）
 *      · 内联    count<=0 → 计数器从 0 减成 255，会**真的转 256 圈**才退出
 *               （`bVar2 == 1` 才是退出条件）
 *    别把这两套合并 —— 合并了就是「大部分点对、偶发算错」的假解。
 *
 * 权威来源是 `tools/vectors/decompiled.txt` 的
 * `===== [29] var:9E95AD479750DBABF9068A886EC37CE7 @ … =====`
 * （[28] 3D536546 的 静态分析 静态分析失败了，但两者机器码同构，靠 [29] 定语义）。
 *
 * 指令集（静态分析 switch）：
 *   0x68  FOR      depth++（>2 则失败）; cnt[depth]=prog[pc+1]; body[depth]=pc+2; pc+=2
 *   0x49  FOREND   depth<0 则失败；c=cnt[depth]; cnt[depth]=c-1;
 *                  c==1 ? depth--, pc+=1 : pc=body[depth]
 *   0x4A  JZ       pc+=2; carry==0 时 pc += (int8)prog[pc+1] 且 carry=0
 *   0x6B  JMP      pc += (int8)prog[pc+1] + 2
 *   0x81  ROL1     carry=x>>31;  x = (x>>31) | (x<<1)
 *   0x82  ROR1     carry=x&1;    x = (x>>1) | (x<<31)
 *   0x84  SUB imm32(BE)  carry = (x < imm) ? 1 : 0; x = x - imm; pc+=5
 *   0x87  XOR imm32(BE)  x ^= imm; carry = 0;                    pc+=5
 *   0x93  ADD imm32(BE)  x += imm; carry = (x < imm) ? 1 : 0;    pc+=5
 *   0x4C  HALT
 *   0x83 / 0x85 / 0x86 / 其它 → **失败**（返回 null，绝不猜）
 *
 * 入口/出口（3D536546  的汇编逐条核过）：
 *   入：seed 4 字节按 `strb [sp+8+r1], r1=3..0` 写入 → `ldr` 读出 = **标准大端**
 *   出：`param_3[0]=x>>24`，随后 byte[2],byte[1],byte[0] —— 也是大端，outLen=4
 */

const OP_HALT = 0x4c;
const OP_FOREND = 0x49;
const OP_FOR = 0x68;
const OP_JZ = 0x4a;
const OP_JMP = 0x6b;

const u32 = (x) => x >>> 0;
/** 有符号字节（静态分析里所有 *pbVar6 都是 `(char)`） */
const s8 = (v) => (v & 0x80 ? v - 0x100 : v);
/** 4 字节大端操作数 */
function be32(p, i) {
  return (((p[i] & 0xff) << 24) | ((p[i + 1] & 0xff) << 16) |
          ((p[i + 2] & 0xff) << 8) | (p[i + 3] & 0xff)) >>> 0;
}

/**
 * 跑内联 VM 程序。
 * @param {number} seed  已经大端拼好的 u32
 * @param {Uint8Array|number[]} prog  40 字节程序（以 0x4C 结尾）
 * @param {(pc:number,x:number,carry:number)=>void} [onStep]  差分 trace 用
 * @returns {number|null} key（u32）；失败/未定义指令返回 **null**
 */
export function inlineVmRun(seed, prog, onStep) {
  const p = Array.from(prog);
  let x = u32(seed);
  let carry = 0;
  let depth = -1;                 // cVar7（signed）
  const cnt = [0, 0, 0, 0];       // local_64[4]
  const body = [0, 0, 0, 0];      // local_60[4]
  let pc = 0;
  let op = p[0];
  let guard = 0;

  const fail = () => null;

  while (op !== OP_HALT) {
    if (++guard > 200000) throw new Error('内联 VM 死循环（程序可能有环）');
    if (pc < 0 || pc >= p.length) return fail();
    if (onStep) onStep(pc, x, carry);

    const next = pc + 1;          // pbVar6
    if (op < 0x6b) {
      if (op === OP_FOREND) {
        const d = depth;
        if (d < 0) return fail();
        const c = cnt[d];
        cnt[d] = (c - 1) & 0xff;
        if (c === 1) { depth = d - 1; pc = next; }
        else { pc = body[d]; }
      } else if (op === OP_JZ) {
        pc = pc + 2;
        if (carry === 0) {
          pc = pc + s8(p[next]);
          carry = 0;              // LAB_00032610
        }
      } else {
        if (op !== OP_FOR) return fail();
        if (depth > 2) return fail();          // '\x02' < cVar7
        depth = depth + 1;
        cnt[depth] = p[pc + 1] & 0xff;
        body[depth] = pc + 2;
        pc = pc + 2;
      }
    } else {
      switch (op) {
        case 0x81:                              // ROL1
          carry = (x >>> 31) & 1;
          x = u32(((x >>> 31) & 1) | (x << 1));
          pc = next;
          break;
        case 0x82:                              // ROR1
          carry = x & 1;
          x = u32((x >>> 1) | (x << 31));
          pc = next;
          break;
        case 0x84: {                            // SUB
          const imm = be32(p, pc + 1);
          const borrow = u32(x) < imm ? 1 : 0;
          x = u32(x - imm);
          carry = borrow;
          pc = pc + 5;
          break;
        }
        case 0x87: {                            // XOR
          const imm = be32(p, pc + 1);
          pc = pc + 5;
          x = u32(x ^ imm);
          carry = 0;
          break;
        }
        case 0x93: {                            // ADD
          const imm = be32(p, pc + 1);
          x = u32(x + imm);
          carry = u32(x) < imm ? 1 : 0;         // 用**加后**的 x 比（静态分析顺序如此）
          pc = pc + 5;
          break;
        }
        case 0x83:
        case 0x85:
        case 0x86:
          return fail();
        default:
          if (op !== OP_JMP) return fail();
          pc = pc + s8(p[pc + 1]) + 2;
          break;
      }
    }
    if (pc < 0 || pc >= p.length) return fail();
    op = p[pc];
  }
  if (onStep) onStep(pc, x, carry);
  return x >>> 0;
}

/** 4 字节大端 seed → 4 字节大端 key */
export function inlineVmKey(seedBytes, prog) {
  const s32 = be32(Array.from(seedBytes), 0);
  const k32 = inlineVmRun(s32, prog);
  if (k32 == null) return null;
  return Uint8Array.of((k32 >>> 24) & 0xff, (k32 >>> 16) & 0xff, (k32 >>> 8) & 0xff, k32 & 0xff);
}

export { OP_HALT, OP_FOR, OP_FOREND, OP_JZ, OP_JMP };
