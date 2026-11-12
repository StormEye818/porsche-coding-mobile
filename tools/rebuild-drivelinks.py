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

★ 2026-11-12 块边界修正（RE-GAPVERIFY-20261112 §2，推翻旧「异文件引用」注释）：
  旧口径把 0x0f41/0x0f51 末条 recOff（18537735/19267858）判为「指向 GFS_CONFIG/
  ALL_EXDTCFILE 的异文件引用」——错。真相 = **块 count 多 1 的解析错位 1 字节**：
  这两块物理上只容 2 条目（span=13=1+2×6），第 3「条目」字节是邻块（0x0f07/0x0f12）
  的块头 `count|条目`，幻影 recOff = 邻块真 recOff<<8|count（恒等式已证）。
  正确口径：条目数以**目录 blockOff 间距**为准，再按参考诊断仪选行结构不变量
  `blockKey>>8 == sysId 低字节` 逐条校验（全库 1070/1070 合规，幻影 0x8D02/0x7403 恰违此）。
  真记录 72413/72694/75265/75308 全在解密体内（@0x11ADD/0x11BF6/0x12601/0x1262C，
  含 0x1D+state 0x18BD 与既有 3 条 0x1D 状态集互证）。

字段：t=blockKey&0xff（兼容旧展示）、bk=blockKey、recOff、recOffsetLo/recOffsetHi
（旧 m/l 改名防再误用）、mode/family/session（记录复合真值）、state（0x1d 专属）。

跑法：python3 tools/rebuild-drivelinks.py
"""
import bisect
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

    # ★ 块边界（RE-GAPVERIFY §2.3）：条目数以「下一目录 blockOff 间距」为准。
    block_offs = sorted({off for _, off in index})

    ecu = {}
    nrec = 0
    for sid, off in index:
        cnt = b[off]
        j = bisect.bisect_right(block_offs, off)
        span = (block_offs[j] - off) if j < len(block_offs) else (len(b) - off)
        max_n = max((span - 1) // 6, 0)
        if cnt > max_n:
            # 解析错位修正：count 字节多算（邻块头被当记录）→ 按块长截断。
            print(f'WARN 块 0x{sid:04x}@0x{off:x} count={cnt} 超出块长 {span}B '
                  f'→ 按 {max_n} 条解析（幻影条目=邻块头，RE-GAPVERIFY §2）', file=sys.stderr)
            cnt = max_n
        rows = []
        for k in range(cnt):
            s = off + 1 + k * 6
            bk, rec = struct.unpack_from('<HI', b, s)
            if (bk >> 8) != (sid & 0xff):
                # 参考诊断仪选行结构不变量：blockKey 0xNNxx 的 NN = sysId 低字节。
                print(f'WARN 条目 bk 0x{bk:04x} 违反 bk>>8==sysId低字节 0x{sid & 0xff:02x}'
                      f'（0x{sid:04x}@0x{off:x}）→ 丢弃', file=sys.stderr)
                continue
            row = {
                't': bk & 0xff,
                'bk': bk,
                'recOff': rec,
                'recOffsetLo': rec & 0xff,
                'recOffsetHi': rec >> 8,
            }
            if rec + 8 > len(b):
                # 兜底护栏：块边界修正后不应再出现（旧口径的 2 条「越界」是幻影条目，
                # 不是异文件引用，RE-GAPVERIFY §2 已证伪）。出现=解析仍错位，置 null 拒猜。
                print(f'WARN rec 0x{rec:x} 越界（0x{sid:04x} bk 0x{bk:04x}）→ mode=null', file=sys.stderr)
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
