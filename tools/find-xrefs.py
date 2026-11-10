#!/usr/bin/env python3
"""find-xrefs.py — 在 ARM32 .so 里找「谁引用了这个字符串 / 这个常量」。

用途（不上车取证）：定位 431 native 侧的系统扫描/地址上报实现。
ARM32 引用字符串的方式是 `ldr rX,[pc,#imm]` 取字面量 + `add rX, pc`，
所以先把字面量池里的值算出来，再和目标的 VA 比对。

用法:
  python3 tools/find-xrefs.py <so> --str "PorscheSystemScanInterface" [--around 40]
  python3 tools/find-xrefs.py <so> --imm 0x7df [--around 40]
"""
import struct
import sys
from pathlib import Path

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_LITTLE_ENDIAN


def segments(blob):
    e_phoff = struct.unpack_from('<I', blob, 0x1C)[0]
    e_phentsize = struct.unpack_from('<H', blob, 0x2A)[0]
    e_phnum = struct.unpack_from('<H', blob, 0x2C)[0]
    out = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from('<I', blob, off)[0]
        if p_type != 1:
            continue
        p_offset, p_vaddr, _p_paddr, p_filesz, p_memsz, p_flags = struct.unpack_from('<IIIIII', blob, off + 4)
        out.append({'off': p_offset, 'va': p_vaddr, 'filesz': p_filesz,
                    'memsz': p_memsz, 'exec': bool(p_flags & 1)})
    return out


def va_to_off(segs, va):
    for s in segs:
        if s['va'] <= va < s['va'] + s['filesz']:
            return s['off'] + (va - s['va'])
    return None


def off_to_va(segs, off):
    for s in segs:
        if s['off'] <= off < s['off'] + s['filesz']:
            return s['va'] + (off - s['off'])
    return None


def find_string(blob, segs, needle):
    pat = needle.encode() + b'\x00'
    i = blob.find(pat)
    if i < 0:
        pat = needle.encode()
        i = blob.find(pat)
    if i < 0:
        return []
    out = []
    while i >= 0:
        va = off_to_va(segs, i)
        if va is not None:
            out.append(va)
        i = blob.find(pat, i + 1)
    return out


def main():
    so = Path(sys.argv[1])
    blob = so.read_bytes()
    segs = segments(blob)
    targets = []
    if '--str' in sys.argv:
        needle = sys.argv[sys.argv.index('--str') + 1]
        targets = find_string(blob, segs, needle)
        print(f'字符串 "{needle}" VA: {[hex(t) for t in targets]}')
    elif '--imm' in sys.argv:
        targets = [int(sys.argv[sys.argv.index('--imm') + 1], 0)]
    else:
        sys.exit('需要 --str 或 --imm')
    around = int(sys.argv[sys.argv.index('--around') + 1]) if '--around' in sys.argv else 0

    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_LITTLE_ENDIAN)
    md.detail = True

    def literal_of(insn):
        """ldr rX,[pc,#imm] → (字面量地址, 值)"""
        for op in insn.operands:
            if op.type == 3:          # ARM_OP_MEM
                if op.mem.base == 15 and op.mem.index == 0:
                    la = (insn.address + 4) & ~3
                    la += op.mem.disp
                    off = va_to_off(segs, la)
                    if off is None or off + 4 > len(blob):
                        return None
                    return la, struct.unpack_from('<I', blob, off)[0]
        return None

    hits = []
    for s in segs:
        if not s['exec']:
            continue
        code = blob[s['off']:s['off'] + s['filesz']]
        hist = []            # 最近几条指令，用于识别 ldr+add pc 模式
        for insn in md.disasm(code, s['va']):
            # 模式 A：ldr rX,[pc,#n] 后紧跟 add rX, pc（Thumb 常用）
            if insn.mnemonic == 'add' and 'pc' in insn.op_str:
                parts = [x.strip() for x in insn.op_str.split(',')]
                rd = parts[0]
                base = parts[-1] if len(parts) == 2 else parts[-1]
                if base == 'pc':
                    for prev in reversed(hist[-3:]):
                        if prev.mnemonic.startswith('ldr') and prev.op_str.startswith(rd + ','):
                            lit = literal_of(prev)
                            if lit:
                                cand = lit[1] + ((insn.address + 4) & ~3)
                                if cand in targets:
                                    hits.append((prev.address, lit[0], cand))
                            break
            # 模式 B：字面量直接是绝对 VA
            lit = literal_of(insn)
            if lit and lit[1] in targets:
                hits.append((insn.address, lit[0], lit[1]))
            hist.append(insn)
    print(f'xref 命中 {len(hits)} 处')
    for addr, la, v in hits[:20]:
        print(f'  @0x{addr:x} → 字面量 0x{la:x} = 0x{v:x}')

    if around and hits:
        for addr, _la, _v in hits[:3]:
            print(f'\n--- 反汇编 @0x{addr - around:x} .. +{around * 2} ---')
            start = max(0, addr - around)
            off = va_to_off(segs, start)
            if off is None:
                continue
            code = blob[off:off + around * 2]
            for insn in md.disasm(code, start):
                mark = '  <<<' if insn.address == addr else ''
                print(f'  0x{insn.address:06x}  {insn.mnemonic:<8}{insn.op_str}{mark}')


if __name__ == '__main__':
    main()
