#!/usr/bin/env python3
"""export-sysdata-routing.py — PORSCHE_SYS_DATA 路由表（16B 记录）提取器。

记录格式（2026-11-10 定案，见 RE-SYSDATA-ROWS-20261110.md §路由表 + 本文件锚点自检）：
  [u32 ownerSysId][u8 sigA][u8 sigB][u8 sel][u8 ff][u32 K(can 0x600-0x7FF)][u32 M(internal)]
  sig 对 ∈ {(01,02),(03,02),(01,01)}；K = CAN 请求地址（诊断段）；M = internal 路由码
  （0 < M < 0x10000）。

与旧「表A A-sig 行」扫描的关系：旧扫描 `[00 00 03 02]...` 即本记录**错位 2 字节**的读法
（00 00 = owner 高 2 字节；旧 T 字段 = owner 低 16 位），旧 decode-can-routing.py 保留作对账。

owner 语义（110 个 owner 实测）：
  owner = 代际前缀 + 系统低字节（家族/路由代码）。多数与该代 sysId 同值：
    0x0E02=Getriebe 0x725-0x72A、0x0E04=Airbag 0x6F6/0x731/0x767/0x769、
    0x0E05=PSM 0x6E6-0x6EA、0x0E07=BKE 0x733/0x736/0x738/0x739、0x0E08=IC 0x7F1。
  例外是路由组代码：0x0E0C = DME 路由组（0x7E1-0x7E8；0x7E0 由网关 0x0C09 拥有）。
  0x13（PASM）家族在任何代都没有 owner 行 → PASM 无静态路由行，这是数据事实不是缺陷。

输出 data/sysdata-routing.json：
  { records:[{off,owner,sigA,sigB,sel,ff,can,m}], byOwner:{owner:[{can,sel,ff,m,off}]}, stats }
用法： python3 tools/export-sysdata-routing.py
"""
import json
import struct
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN')
OUT = ROOT / 'data' / 'sysdata-routing.json'

SIGS = {(1, 2), (3, 2), (1, 1)}


def extract(b):
    recs = []
    for o in range(len(b) - 16):
        owner = struct.unpack_from('<I', b, o)[0]
        sig = (b[o + 4], b[o + 5])
        can = struct.unpack_from('<I', b, o + 8)[0]
        m = struct.unpack_from('<I', b, o + 12)[0]
        if sig in SIGS and 0x600 <= can <= 0x7FF and 0 < m < 0x10000 and 0 < owner < 0x10000:
            recs.append({'off': o, 'owner': owner, 'sigA': sig[0], 'sigB': sig[1],
                         'sel': b[o + 6], 'ff': b[o + 7], 'can': can, 'm': m})
    return recs


# 锚点自检（全部来自逐字节证据，见 RE-SYSDATA-ROWS-20261110.md；任何一条失败=格式改动，禁止输出）
ANCHORS = [
    (0x0E02, 0x725), (0x0E04, 0x6F6), (0x0E04, 0x731), (0x0E05, 0x6E6), (0x0E05, 0x6EA),
    (0x0E07, 0x733), (0x0E07, 0x736), (0x0E08, 0x7F1),        # 981 模块直own
    (0x0E0C, 0x7E1), (0x0C09, 0x7E0), (0x0C09, 0x7DF),         # DME 路由组 / 网关
    (0x0C05, 0x7D0), (0x0C02, 0x7D0), (0x0C07, 0x7D8),         # 跨代 owner（0x7D0/0x7D8）
]


def main():
    b = SRC.read_bytes()
    recs = extract(b)
    by_owner = defaultdict(list)
    for r in recs:
        by_owner[r['owner']].append(r)

    fail = [(hex(o), hex(c)) for o, c in ANCHORS
            if not any(r['owner'] == o and r['can'] == c for r in recs)]
    if fail:
        print('❌ 锚点自检失败：', fail)
        sys.exit(1)

    # 与旧 decode-can-routing.py 表A 行对账：旧 offset = 新记录 +2（错位 2 字节读法）
    old = json.loads((ROOT / 'ref' / 'porsche-can-routing.json').read_text())
    old_pairs = {(r['offset'], r['can'], r['internal']) for r in old.get('form_a', [])}
    new_pairs = {(r['off'] + 2, r['can'], r['m']) for r in recs if (r['sigA'], r['sigB']) == (3, 2)
                 and r['owner'] >> 16 == 0}
    cross = len(old_pairs & new_pairs)

    doc = {
        'schemaVersion': 1,
        'source': 'PORSCHE_SYS_DATA.BIN (decoded) 全局路由表 16B 记录',
        'format': '[u32 owner][u8 sigA][u8 sigB][u8 sel][u8 ff][u32 can][u32 m]; sig对∈{01 02,03 02,01 01}; can∈0x600-0x7FF; 0<m<0x10000',
        'ownerSemantics': 'owner=代际前缀+系统低字节(家族/路由代码)；0x0E0C=DME路由组；0x13(PASM)家族任何代都无owner行=PASM无静态路由',
        'legacyNote': f'旧 decode-can-routing.py 表A [00 00 03 02] 行=本记录错位2字节读法；对账交集 {cross} 条（03 02 sig 且 owner 高16位=0 的子集）',
        'stats': {
            'records': len(recs), 'owners': len(by_owner),
            'anchorsChecked': len(ANCHORS), 'anchorsPassed': len(ANCHORS) - len(fail),
        },
        'records': [{'off': r['off'], 'owner': f"0x{r['owner']:04X}", 'sig': f"{r['sigA']:02X} {r['sigB']:02X}",
                     'sel': r['sel'], 'ff': r['ff'], 'can': f"0x{r['can']:03X}", 'm': f"0x{r['m']:04X}"} for r in recs],
        'byOwner': {f"0x{o:04X}": [{'off': r['off'], 'can': f"0x{r['can']:03X}", 'sel': r['sel'],
                                    'ff': r['ff'], 'm': f"0x{r['m']:04X}"} for r in rs]
                    for o, rs in sorted(by_owner.items())},
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'写出 {OUT.name}: {len(recs)} 条 / {len(by_owner)} owner，锚点 {len(ANCHORS)}/{len(ANCHORS)} 通过')
    for o in ('0x0E01', '0x0E02', '0x0E04', '0x0E05', '0x0E07', '0x0E08', '0x0E0C', '0x0C05'):
        cans = sorted({r['can'] for r in by_owner.get(int(o, 16), [])})
        print(f'  {o}: {[str(c) for c in cans]}')


if __name__ == '__main__':
    main()
