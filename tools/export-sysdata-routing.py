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
  { records:[...], byOwner:{owner:[...]}, byGeneration:{gen:[can...]}, rootTypes:{type:{...}}, stats }
另输出 data/sysdata-root-table.json（根表 22 type 的 comm 子表/sysId/子系统名字集，
供 export-all-model-sysids.py / export-bind-plan.py / export-comm-shared-keys.py 复用）。
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
ROOT_TABLE_OUT = ROOT / 'data' / 'sysdata-root-table.json'

SIGS = {(1, 2), (3, 2), (1, 1)}


def parse_root_table(b):
    """根表 [u8 count=22][[u8 type][u32 off]×22] + comm 子表 sysId/子系统名。

    comm 子表 = [u8 count][[u16 sysId][u8 nComm][nComm×[u32 commOff][u32 sysDataOff]]]
    子系统记录表 = [u8 count][[u16 len][name\\0][6×u32]]×count
    """
    n = b[0]
    types = {}
    for i in range(n):
        t = b[1 + i * 5]
        off = struct.unpack_from('<I', b, 2 + i * 5)[0]
        cnt = b[off]
        p = off + 1
        sysids, comms, names = [], [], set()
        if 0 < cnt <= 120:
            for _ in range(cnt):
                if p + 3 > len(b):
                    break
                sid = struct.unpack_from('<H', b, p)[0]
                nc = b[p + 2]
                p += 3
                if nc > 16 or p + 8 * nc > len(b):
                    break
                sysids.append(sid)
                for _k in range(nc):
                    co, so = struct.unpack_from('<II', b, p)
                    p += 8
                    comms.append({'sysId': f'0x{sid:04X}', 'commOff': co, 'sysDataOff': so})
                    if so < len(b) - 8:
                        c = b[so]
                        q = so + 1
                        for _j in range(min(c, 128)):
                            if q + 2 > len(b):
                                break
                            ln, = struct.unpack_from('<H', b, q)
                            if ln > 90 or ln < 2 or q + 2 + ln > len(b) or b[q + 2 + ln - 1] != 0:
                                break
                            names.add(b[q + 2:q + 2 + ln - 1].decode('latin1', 'replace'))
                            q += 2 + ln + 24
        types[f'0x{t:02X}'] = {
            'off': off, 'sysIdCount': len(sysids),
            'sysIds': [f'0x{s:04X}' for s in sysids],
            'genConsistent': all(s >> 8 == t for s in sysids) if sysids else None,
            'commRecords': comms,
            'subsystemNames': sorted(names),
        }
    return types


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
    # 全车型推广（2026-11-11）：其它代际锚点（根表 type=代际前缀，逐字节复验）
    (0x0B02, 0x724), (0x0C02, 0x759), (0x0D08, 0x7A3), (0x0F05, 0x750),
    (0x1008, 0x78B), (0x0A00, 0x7C0), (0x0607, 0x67B), (0x0302, 0x7E8),
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

    # ---- 根表 / 按代索引（全车型推广） ----
    root_types = parse_root_table(b)
    by_generation = defaultdict(set)
    for o, rs in by_owner.items():
        by_generation[f'0x{o >> 8:02X}'].update(r['can'] for r in rs)
    gen_owner_count = defaultdict(int)
    for o in by_owner:
        gen_owner_count[f'0x{o >> 8:02X}'] += 1
    for t, e in root_types.items():
        e['routeOwnerCount'] = gen_owner_count.get(t, 0)
        e['routeCans'] = sorted(by_generation.get(t, set()))

    root_doc = {
        'schemaVersion': 1,
        'source': 'PORSCHE_SYS_DATA.BIN (decoded) 根表 [u8 count=22][[u8 type][u32 off]×22] + comm 子表',
        'rule': 'type = 代际前缀（sysId 高字节）；comm 子表 sysId 列表=该代模块目录；sysDataOff 子系统名字集=模块→sysId 精确 join 键',
        'types': root_types,
        'stats': {'types': len(root_types),
                  'genConsistentTypes': sum(1 for e in root_types.values() if e['genConsistent'])},
    }
    ROOT_TABLE_OUT.write_text(json.dumps(root_doc, ensure_ascii=False, indent=1), encoding='utf-8')

    doc = {
        'schemaVersion': 2,
        'source': 'PORSCHE_SYS_DATA.BIN (decoded) 全局路由表 16B 记录',
        'format': '[u32 owner][u8 sigA][u8 sigB][u8 sel][u8 ff][u32 can][u32 m]; sig对∈{01 02,03 02,01 01}; can∈0x600-0x7FF; 0<m<0x10000',
        'ownerSemantics': 'owner=代际前缀+系统低字节(家族/路由代码)；0x0E0C=DME路由组；0x13(PASM)家族任何代都无owner行=PASM无静态路由',
        'legacyNote': f'旧 decode-can-routing.py 表A [00 00 03 02] 行=本记录错位2字节读法；对账交集 {cross} 条（03 02 sig 且 owner 高16位=0 的子集）',
        'stats': {
            'records': len(recs), 'owners': len(by_owner), 'generations': len(by_generation),
            'rootTypes': len(root_types),
            'anchorsChecked': len(ANCHORS), 'anchorsPassed': len(ANCHORS) - len(fail),
        },
        'byGeneration': {g: [f'0x{c:04X}' for c in sorted(cs)] for g, cs in sorted(by_generation.items())},
        'rootTypeGen': {t: {'sysIdCount': e['sysIdCount'], 'genConsistent': e['genConsistent'],
                            'routeOwnerCount': e['routeOwnerCount']} for t, e in sorted(root_types.items())},
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
