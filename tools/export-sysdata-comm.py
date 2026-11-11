#!/usr/bin/env python3
"""export-sysdata-comm.py — PORSCHE_SYS_DATA comm 记录全量导出（2026-11-11 逆取收口）。

背景：此前「逐 ECU 会话/进模块命令表被加密体挡住」的结论是错的——
`~/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN` 是**已解码副本**（加密壳在
`ref/x431-porsche-v24.58/V24.58/PORSCHE_SYS_DATA.BIN`，YZJM 容器；解码器在
porsche-mapper）。路由表 / comm 子表 / 名字记录一直读的就是这份副本。

本导出器按 `GetCommData @libPORSCHE_FILE.so:0x15580` 的逐指令语义解析每个 sysId 的
comm 记录（874 条，覆盖全部 22 个 type）：

  comm 子表（每 type 一张）：[u8 count][[u16 sysId][u8 nComm][nComm×[u32 commOff][u32 sysDataOff]]]
  comm 记录（类别分支，token 偏移与 .so 一一对应）：
    cat 1   : [cat][b1→0x640][b2→0x63e][b3→0x63f][u16@4→0x642][M@6→0x654][M×u32 cmd@7]
    cat 2   : [cat][b1→0x63e][b2→0x63f][u16@3→0x642][M@5→0x654][M×u32 cmd@6]
    cat 4   : [cat][b1→0x640][M@2→0x654][M×u32 cmd@3]
    cat 0x20: [cat][b1→0x63e][b2→0x63f][b3→0x641][N@4→0x64e] + N×子记录
    cat 0x10/0x30/0x50: [cat][b1→0x641][N@2→0x64e] + N×子记录
    cat 0x60: [cat][b1→0x641][N@2→0x64e] + N×子记录（字段序不同）
  子记录（cat 0x10/0x20/0x30/0x50）: [u32 A][u32 C][u8 X][u32 D（仅 X==5）][u8 M][M×u32 cmd]
  子记录（cat 0x60）              : [u32 A][u8 B][u32 C][u8 M][M×u32 cmd]

  ★ 地址对：token+0x65c = (A&0xFFFF)<<16 | (C&0xFFFF)，两个 16 位各是 <<5 编码：
    DME 0x0E01 记录 A=0xFC00 C=0xFD00 → tx=0x7E0 rx=0x7E8（实车已证）；
    原厂硬编码 0xFBE0FD00（PorscheReadVehicleVin）→ tx=0x7DF rx=0x7E8（功能广播）；
    0xE200EF40（PorscheGetVinAndOdo）→ tx=0x710 rx=0x77A（网关，实车已证）。
    ⚠️ A/C 是**家族默认**（同低字节跨代相同；PSM=0x713 在 992 集合里、不在 981 集合里），
    不能直接当按车型地址用——按车型地址在 ALLDATA 的 16B CAN 行里（RE-CLOSURE §7）。

  ★ 命令 ID → 帧字节：COMMAND.GAG（GGP 第 6 段，IdSearch 语义，键=命令 ID 大端）。
    例：0x00200007→`01 02 10 89`、0x00200006→`01 02 1A 9F`、0x0020000A→`00 02 10 03`、
    0x001003A7→`00 02 3E 00`、0x00200001→`01 03 22 F1 A2`。帧格式 [flag][len][payload]。

输出 data/sysdata-comm.json：{ "ecu": { "0x0e01": { "type", "blocks": [...] } } }
用法： python3 tools/export-sysdata-comm.py
"""
import json
import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYS = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN')
CMDGAG = Path('/Users/se818/porsche-mapper/ref/decoded/GAG_COMMAND.GAG.bin')
OUT = ROOT / 'data' / 'sysdata-comm.json'

sys.path.insert(0, str(Path('/Users/se818/porsche-mapper/ref')))
import gag_codec  # noqa: E402


def load_cmd_dict():
    st = gag_codec.parse_text_gag(CMDGAG.read_bytes())
    kl = st['keylen']
    rc = kl + 4
    b0 = st['index_off'] + 5
    g = st['gag']

    def look(cid):
        n = bytearray(struct.pack('>I', cid))
        gag_codec.encrypt_number_strict(n, st['ctx'])
        lo, hi = 0, st['count'] - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            k = g[b0 + mid * rc:b0 + mid * rc + kl]
            if n < k:
                hi = mid - 1
            elif n > k:
                lo = mid + 1
            else:
                _, body = gag_codec.decode_record(st, mid)
                return list(body)
        return None
    return look


def parse_flat(b, co, hdr_len, m_off):
    """cat 1/2/4：定长头 + M×u32 命令。返回 (b 字段, M, 命令列表)。"""
    if co + m_off + 1 > len(b):
        return None
    m = b[co + m_off]
    if m > 64:
        return None
    cmds = []
    p = co + m_off + 1
    for _ in range(m):
        if p + 4 > len(b):
            break
        cmds.append(struct.unpack_from('<I', b, p)[0])
        p += 4
    return m, cmds


def parse_subs(b, co, n_off, subs_off, cat):
    """cat 0x10/0x20/0x30/0x50/0x60：N×变长子记录。"""
    if co + n_off + 1 > len(b):
        return None
    n = b[co + n_off]
    if n > 16:
        return None
    out = []
    p = co + subs_off
    for _ in range(n):
        if p + 10 > len(b):
            break
        A, C = struct.unpack_from('<II', b, p)
        if cat == 0x60:
            bo = b[p + 4]
            C2 = struct.unpack_from('<I', b, p + 5)[0]
            m = b[p + 9]
            q = p + 10
            tx_rx = ((A & 0xFFFF) << 16) | (C2 & 0xFFFF)
        else:
            x = b[p + 8]
            q = p + 9
            if x == 5:
                if q + 4 > len(b):
                    break
                q += 4
            if q >= len(b):
                break
            m = b[q]
            q += 1
            tx_rx = ((A & 0xFFFF) << 16) | (C & 0xFFFF)
        cmds = []
        for _ in range(m):
            if q + 4 > len(b) or m > 64:
                break
            cmds.append(struct.unpack_from('<I', b, q)[0])
            q += 4
        out.append({
            'tx': (tx_rx >> 16) >> 5,
            'rx': (tx_rx & 0xFFFF) >> 5,
            'raw': f'0x{tx_rx:08X}',
            'm': m,
            'cmds': [f'0x{c:08X}' for c in cmds],
        })
        p = q
    return out


def main():
    b = SYS.read_bytes()
    look = load_cmd_dict()
    # 根表：[u8 count][[u8 type][u32 off]×count]
    n_root = b[0]
    root = [(b[1 + i * 5], struct.unpack_from('<I', b, 2 + i * 5)[0]) for i in range(n_root)]

    out = {}
    stats = Counter()
    sess_dist = Counter()
    for t, off in root:
        cnt = b[off]
        p = off + 1
        if not (0 < cnt <= 120):
            continue
        for _ in range(cnt):
            if p + 3 > len(b):
                break
            sid = struct.unpack_from('<H', b, p)[0]
            nc = b[p + 2]
            p += 3
            if nc > 16 or p + 8 * nc > len(b):
                break
            blocks = []
            for k in range(nc):
                co, so = struct.unpack_from('<II', b, p)
                p += 8
                if co + 3 > len(b):
                    continue
                cat = b[co]
                blk = {
                    'cat': cat,
                    'commOff': f'0x{co:X}',
                    'sysDataOff': f'0x{so:X}',
                }
                subs = None
                if cat in (1, 2, 4):
                    if cat == 1:
                        r = parse_flat(b, co, 7, 6)
                    elif cat == 2:
                        r = parse_flat(b, co, 6, 5)
                    else:
                        r = parse_flat(b, co, 3, 2)
                    if r:
                        blk['m'], blk['cmds'] = r[0], [f'0x{c:08X}' for c in r[1]]
                elif cat in (0x10, 0x20, 0x30, 0x50, 0x60):
                    if cat == 0x20:
                        subs = parse_subs(b, co, 4, 5, cat)
                    else:
                        subs = parse_subs(b, co, 2, 3, cat)
                    if subs is not None:
                        blk['subs'] = subs
                else:
                    stats['unknownCat'] += 1
                # 命令 → 帧解析（IdSearch：键 = 命令 ID 大端）
                cmd_ids = []
                if 'cmds' in blk:
                    cmd_ids = [int(c, 16) for c in blk['cmds']]
                for s in blk.get('subs') or []:
                    cmd_ids += [int(c, 16) for c in s['cmds']]
                frames = []
                for cid in cmd_ids:
                    f = look(cid)
                    if f is None:
                        frames.append(None)
                        stats['cmdMiss'] += 1
                    else:
                        frames.append(f)
                        stats['cmdHit'] += 1
                if cmd_ids:
                    blk['frames'] = frames
                    # 会话号统计：帧里找 10 xx（flag/len 后的 SID 0x10）
                    for f in frames:
                        if f and len(f) >= 4 and f[0] in (0, 1) and f[2] == 0x10:
                            sess_dist[f[3]] += 1
                blocks.append(blk)
                stats['records'] += 1
            key = f'0x{sid:04x}'
            e = out.setdefault(key, {'type': f'0x{t:02X}', 'blocks': []})
            e['blocks'] += blocks
            stats['sysIds'] += 0

    doc = {
        'schemaVersion': 1,
        'source': 'decoded PORSCHE_SYS_DATA.BIN comm 子表 + GetCommData @FILE:0x15580 逐指令语义',
        'format': ('blocks[i].cat=类别（token+0x63d 值域 1/2/3/4/0x10/0x20/0x30/0x4F/0x50/0x60）；'
                   'subs[j].tx/rx=(A&0xFFFF>>5, C&0xFFFF>>5)（家族默认地址，实车对 DME/网关已证，'
                   'PSM 等 981 不符 → 只作参考不作权威）；cmds=命令 ID（u32）；'
                   'frames=COMMAND.GAG 帧字节 [flag][len][payload]'),
        'stats': {
            'records': stats['records'],
            'cmdHit': stats['cmdHit'],
            'cmdMiss': stats['cmdMiss'],
            'sessionFrames': {f'0x{s:02X}': c for s, c in sorted(sess_dist.items())},
        },
        'ecu': dict(sorted(out.items())),
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'写出 {OUT.name}：{len(out)} sysId / {stats["records"]} 条 comm 记录 / '
          f'命令解析 {stats["cmdHit"]} 命中 {stats["cmdMiss"]} 缺')
    print('会话帧分布（10 xx）:', {f'0x{s:02X}': c for s, c in sorted(sess_dist.items())})
    # 锚点自检
    dme = out.get('0x0e01')
    if dme and dme['blocks']:
        s0 = dme['blocks'][0].get('subs') or []
        frames = dme['blocks'][0].get('frames') or []
        if s0:
            print(f'锚点 DME 0x0E01: tx=0x{s0[0]["tx"]:03X} rx=0x{s0[0]["rx"]:03X}')
        if frames:
            print('  命令帧:', [' '.join(f'{x:02X}' for x in f) if f else '?' for f in frames])


if __name__ == '__main__':
    main()
