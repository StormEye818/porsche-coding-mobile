#!/usr/bin/env python3
"""重建 data/drivelinks.json —— 记录字节级口径（2026-11-09 mode 收口）。

旧口径（已证伪）：6B 条目 = `<8 variantTag><8 ecu_lo><8 mode><24le LID>`，
m=mode、l=LID —— 条目里根本没有 mode（Xml_GetDriveLinksEntry 逐指令：
6B = [u16 blockKey][u32 recOff]）。旧 m 其实 = recOff 低字节、l = recOff>>8，
拿 m 当 mode 算 key = 垃圾 key → NRC 0x35 风险（analysis/seedkey-coverage-audit-20261108.md ⚠️）。

真口径（SendSysSeedKey → Xml_GetDriveLinksAddress 逐指令 + freadEx 语义实证）：
  条目 6B            = [u16 blockKey][u32 recOff]
  记录 recOff+0..3   = u32 复合 P（freadEx 两次读回起点，落在 TOKEN+0x360950）
      P&0xff         = mode   （securityModel 的 param_2，PorscheKeySendCmd 低字节）
      (P>>8)&0xff    = family （命令模板族 0x100..0x900）
      P>>16          = session（securityModel 的 param_1）
  recOff+4..7        = state  —— 仅 rec[0]==0x1d 时装载进 TOKEN+0x408838（0x1d 运行时态）
      （非 0x1d 记录 rec[4] 为变体行 count，勿混用）
条目选择（模块入口）：GetSubSysDataAddr 识别串命中行键 → TOKEN+0x28 = blockKey；
  未命中回落组首行键 = 块内首条目（app 的 hit[0] 与之同构）。

字段：t=blockKey&0xff（兼容旧展示）、bk=blockKey、recOff、recOffsetLo/recOffsetHi
（旧 m/l 改名防再误用）、mode/family/session（记录复合真值）、state（0x1d 专属）。

跑法：python3 tools/rebuild-drivelinks.py
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path('/Users/se818/porsche-mapper/ref/analysis/PORSCHE_DRIVELINKS.dec.bin')
OUT = ROOT / 'data' / 'drivelinks.json'


def main():
    b = SRC.read_bytes()
    index = []
    i = 0
    while i + 8 <= len(b):
        ecu, off = struct.unpack_from('<II', b, i)
        if ecu == 0x7FFFFFFF:
            break
        index.append((ecu, off))
        i += 8

    ecu = {}
    nrec = 0
    for sid, off in index:
        cnt = b[off]
        rows = []
        for j in range(cnt):
            s = off + 1 + j * 6
            bk, rec = struct.unpack_from('<HI', b, s)
            row = {
                't': bk & 0xff,
                'bk': bk,
                'recOff': rec,
                'recOffsetLo': rec & 0xff,
                'recOffsetHi': rec >> 8,
            }
            if rec + 8 > len(b):
                # 全库仅 2 条（0xf41/0xf51 末条）：记录偏移越出解密体（异文件引用），
                # mode 不可得 → 置 null，调用方回落名字分发，不猜。
                print(f'WARN rec 0x{rec:x} 越界（0x{sid:x} bk 0x{bk:04x}）→ mode=null', file=sys.stderr)
                row['mode'] = None
            else:
                mode = b[rec]
                row['mode'] = mode
                row['family'] = b[rec + 1]
                row['session'] = struct.unpack_from('<H', b, rec + 2)[0]
                if mode == 0x1D:
                    row['state'] = struct.unpack_from('<I', b, rec + 4)[0]
            rows.append(row)
            nrec += 1
        ecu[f'0x{sid:04x}'] = rows

    doc = {
        'schemaVersion': 2,
        'source': 'PORSCHE_DRIVELINKS.BIN (解密) · 条目=[u16 blockKey][u32 recOff] · 记录复合 u32@rec+0 · 2026-11-09',
        'layout': 'entry 6B=[u16 blockKey][u32 recOff]；mode=family<<8|session<<16 复合 u32@rec+0（mode=低字节）；rec[0]==0x1d 时 state=u32@rec+4',
        'note': 'recOffsetLo/recOffsetHi = 记录偏移拆字节（旧 m/l 改名，禁止当 mode/LID 用）；mode/family/session 才是安全访问真值',
        'ecuCount': len(index),
        'recordCount': nrec,
        'ecu': ecu,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    print(f'ecu {len(index)} entries {nrec} -> {OUT}')


if __name__ == '__main__':
    main()
