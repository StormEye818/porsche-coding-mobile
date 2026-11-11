#!/usr/bin/env python3
"""export-comm-shared-keys.py — RE-CODINGADDR §6 步骤5：comm 键全车型提取与共享键判定。

comm 记录（SYS_DATA，每个根表 type 的 comm 子表 commOff 指向）：
  [10 03 01][u32 a][u32 b=a+0xD40 常量差][03][u8 n][ [u16 key][u16 flag] × n ]
  flag 实测 ∈ {0x10, 0x20}（0x10 常出现在首项，0x03A7+0x10 是共享键标记）。

用途（981 已证实并推广）：一个 key 若出现在多个不同 sysId 的 comm 记录里，
说明该键是「共享键」——多个模块共用同一请求键，解释了 PASM/PSM/IC/SWSG/BKE
等模块键重叠；运行时不能把一个共享键当成某模块的独占地址证据。

输出 data/comm-shared-keys.json：
  { byType:{type:[{sysId,commOff,keys:[{key,flag}]}]}, sharedKeys:{key:{owners,sysIds,types}}, stats }
用法： python3 tools/export-comm-shared-keys.py
"""
import json
import struct
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYS = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN')
ROOT_TABLE = ROOT / 'data' / 'sysdata-root-table.json'
OUT = ROOT / 'data' / 'comm-shared-keys.json'

VALID_FLAGS = {0x0010, 0x0020}


def parse_comm(b, co):
    if co + 13 > len(b) or b[co:co + 3] != b'\x10\x03\x01':
        return None
    a, bb = struct.unpack_from('<II', b, co + 3)
    if bb != a + 0xD40 or b[co + 11] != 3:
        return None
    n = b[co + 12]
    if n > 32 or co + 13 + 4 * n > len(b):
        return None
    keys = []
    for z in range(n):
        k, f = struct.unpack_from('<HH', b, co + 13 + z * 4)
        if f not in VALID_FLAGS:
            return None
        keys.append({'key': f'0x{k:04X}', 'flag': f'0x{f:04X}'})
    return {'a': f'0x{a:08X}', 'b': f'0x{bb:08X}', 'keys': keys}


def main():
    b = SYS.read_bytes()
    rt = json.loads(ROOT_TABLE.read_text())
    by_type = {}
    owners = defaultdict(set)      # key -> {(type,sysId)}
    flags = Counter()
    parsed = skipped = 0
    for t, e in sorted(rt['types'].items()):
        rows = []
        for rec in e.get('commRecords') or []:
            r = parse_comm(b, rec['commOff'])
            if r is None:
                skipped += 1
                continue
            parsed += 1
            for k in r['keys']:
                owners[k['key']].add((t, rec['sysId']))
                flags[k['flag']] += 1
            rows.append({'sysId': rec['sysId'], 'commOff': rec['commOff'], **r})
        by_type[t] = rows

    shared = {}
    for k, own in sorted(owners.items()):
        sysids = sorted({s for _, s in own})
        types = sorted({t for t, _ in own})
        if len(sysids) >= 2:
            shared[k] = {
                'sysIdCount': len(sysids), 'typeCount': len(types),
                'types': types, 'sysIdsSample': sysids[:24],
            }

    doc = {
        'schemaVersion': 1,
        'source': 'PORSCHE_SYS_DATA.BIN 根表 22 type 的 comm 子表 commOff 记录',
        'format': '[10 03 01][u32 a][u32 b=a+0xD40][03][u8 n][[u16 key][u16 flag∈{0x10,0x20}]×n]',
        'rule': '共享键 = 同一 key 出现在 ≥2 个不同 sysId 的 comm 记录；共享键不可当作模块独占地址证据',
        'stats': {'parsedCommRecords': parsed, 'skippedCommRecords': skipped,
                  'types': len(by_type), 'distinctKeys': len(owners), 'sharedKeys': len(shared),
                  'flagCounts': {k: v for k, v in flags.most_common()}},
        'sharedKeys': shared,
        'byType': by_type,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'写出 {OUT.name}: comm 记录 {parsed} 条 / 跳过 {skipped}，key {len(owners)} 种，共享键 {len(shared)} 种')
    for k, v in sorted(shared.items(), key=lambda x: -x[1]['sysIdCount'])[:8]:
        print(f"  {k} sysId={v['sysIdCount']:3d} types={v['typeCount']:2d} 例={v['sysIdsSample'][:4]}")
    if '0x03A7' not in shared:
        raise SystemExit('❌ 共享键 0x03A7 锚点缺失')
    print('✅ 0x03A7 共享键锚点通过')


if __name__ == '__main__':
    main()
