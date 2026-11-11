#!/usr/bin/env python3
"""export-coding-address-sources.py — RE-CODINGADDR §6 步骤4：编码地址来源全车型判定。

981 上的结论（RE-CODINGADDR §4）：SYS_DATA name 记录 `[前缀][u16 len][name\\0][6×u32 池指针]`
之后**直接是下一条 [u16 len][name]** —— 没有 +2 扩展，所以 ctx+0x638 的
`[u8 n][u32×n]×2` 编码地址流不落位；981 编码地址走 9X1_ALLDATA coding 池
（变体块 `[22 2e …]["0x…" 键串]` → coding-v2.json）。

本工具把该判定推广到全量车型：
  ① SYS_DATA 全表 len-checked name 记录逐条判：
       6×u32 之后是合法下一条 [u16 len][name\\0] → no-extension（→ coding 池）；
       6×u32 之后是严格 `[u8 n][u32×n][u32×n]`（n≤16，u32 值 0<v<0x800000）→
       sysDataStream，解析并输出编码地址对；
       其余 → unknown（如实标注，不猜）。
  ② 按代际（name-9 的 sysId 高字节，flag∈{1,2,3} 有效记录）汇总；
  ③ 每个平台 ALLDATA 的 coding 池证据：变体块 [22 2e] 行与 "0x…" 键串计数；
  ④ 平台编码地址来源判定：该代无扩展且 coding 池有数据 → allDataCodingPool；
     该代发现流 → sysDataStream（附地址对）；包内无证据 → unresolved。

输出 data/coding-address-sources.json。
用法： python3 tools/export-coding-address-sources.py
"""
import json
import re
import struct
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
D = Path('/Users/se818/porsche-mapper/ref/decoded')
SYS = D / 'PORSCHE_SYS_DATA.BIN'
ALL_SYSIDS = ROOT / 'data' / 'all-model-sysids.json'
OUT = ROOT / 'data' / 'coding-address-sources.json'


def name_records(b):
    """全表 len-checked name 记录（name-9 字段：flag/sysId/len 校验）。"""
    for m in re.finditer(rb'[A-Za-z][A-Za-z0-9_]{2,60}\x00', b):
        p = m.start()
        nm = m.group()[:-1].decode('latin1')
        if p < 11:
            continue
        ln, = struct.unpack_from('<H', b, p - 2)
        if ln != len(nm) + 1:
            continue
        flag, = struct.unpack_from('<H', b, p - 11)
        sid, = struct.unpack_from('<I', b, p - 9)
        yield p, nm, flag, sid


def next_name_at(b, q):
    """[u16 len][name\\0] —— len 含结尾 \\0，逐字节校验。"""
    if q + 2 > len(b):
        return None
    ln, = struct.unpack_from('<H', b, q)
    if 2 <= ln <= 90 and q + 2 + ln <= len(b) and b[q + 2 + ln - 1] == 0:
        s = b[q + 2:q + 2 + ln - 1]
        if len(s) >= 3 and all(32 <= c < 127 for c in s):
            return s.decode('latin1')
    return None


def main():
    b = SYS.read_bytes()
    all_sysids = json.loads(ALL_SYSIDS.read_text())

    stat = Counter({'no-extension': 0, 'sysDataStream': 0, 'unknown': 0, 'EOF': 0})
    streams = []
    by_gen = defaultdict(Counter)
    for p, nm, flag, sid in name_records(b):
        e = p + len(nm) + 1
        q = e + 24                      # 6×u32 池指针之后
        gen = sid >> 8 if (flag in (1, 2, 3) and 0 < sid < 0x2000) else None
        if q + 2 > len(b):
            stat['EOF'] += 1
            continue
        if next_name_at(b, q):
            stat['no-extension'] += 1
            if gen is not None:
                by_gen[gen]['no-extension'] += 1
            continue
        n = b[q]
        if 1 <= n <= 16 and q + 1 + 8 * n <= len(b):
            vals = struct.unpack_from('<' + 'I' * (2 * n), b, q + 1)
            if all(0 < v < 0x800000 for v in vals):
                stat['sysDataStream'] += 1
                if gen is not None:
                    by_gen[gen]['sysDataStream'] += 1
                streams.append({
                    'off': q, 'name': nm, 'sysId': f'0x{sid:04X}', 'n': n,
                    'addrGroup1': [f'0x{v:08X}' for v in vals[:n]],
                    'addrGroup2': [f'0x{v:08X}' for v in vals[n:]],
                })
                continue
        stat['unknown'] += 1
        if gen is not None:
            by_gen[gen]['unknown'] += 1

    # 各平台 ALLDATA coding 池证据：[22 2e] 行 + "0x…" 键串
    pool = {}
    for f in sorted(D.glob('*_ALLDATA.BIN')):
        A = f.read_bytes()
        pool[f.stem.replace('_ALLDATA', '')] = {
            'readWriteRows': len(re.findall(rb'\x22\x2e', A)),
            'hexKeyStrings': len(re.findall(rb'0x[0-9A-Fa-f]{2,8}', A)),
            'bytes': len(A),
        }

    platforms = {}
    for p, e in sorted((all_sysids.get('platforms') or {}).items()):
        gen = int(e['gen'], 16) if e.get('gen') else None
        g = by_gen.get(gen, {}) if gen is not None else {}
        pool_ev = pool.get(p, {})
        if g.get('sysDataStream'):
            source, why = 'sysDataStream', f'该代 name 记录发现 {g["sysDataStream"]} 条 [u8 n][u32×n]×2 编码地址流'
        elif g.get('no-extension') and pool_ev.get('readWriteRows'):
            source, why = 'allDataCodingPool', (f'该代 {g["no-extension"]} 条 name 记录 6×u32 后直接下一条记录（无 +2 扩展），'
                                                f'ALLDATA 变体块 [22 2e] 行 {pool_ev["readWriteRows"]} 条 → 编码地址走 coding 池')
        elif pool_ev.get('readWriteRows'):
            source, why = 'allDataCodingPool(weak)', 'ALLDATA coding 池有数据，但该代无有效 name-9 记录（新代/老平台），按 981 通用规则'
        else:
            source, why = 'unresolved', '包内无编码池/流证据（不猜）'
        platforms[p] = {
            'gen': e.get('gen'), 'confidence': e.get('confidence'),
            'source': source, 'evidence': why,
            'nameRecordStats': dict(g), 'codingPool': pool_ev,
        }

    doc = {
        'schemaVersion': 1,
        'source': 'PORSCHE_SYS_DATA.BIN name 记录 + 14× *_ALLDATA.BIN 变体块',
        'rule': ('步骤4 通用判定：name 记录 6×u32 之后若有合法 [u16 len][name\\0] → 无 ctx+0x638 扩展 '
                 '→ 编码地址走 ALLDATA coding 池；若严格 [u8 n][u32×n]×2 → SYS_DATA 编码地址流。'
                 'Xml_GetCodingAddress 消费格式见 RE-CODINGADDR §2。'),
        'stats': {'nameRecords': sum(stat.values()), **dict(stat),
                  'generationsWithName9': len(by_gen), 'streams': len(streams)},
        'byGeneration': {f'0x{g:02X}': dict(c) for g, c in sorted(by_gen.items())},
        'streams': streams,
        'platforms': platforms,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'写出 {OUT.name}: name 记录 {sum(stat.values())} → {dict(stat)}')
    print(f'  编码地址流 {len(streams)} 条，{len(by_gen)} 个代际有 name-9 记录')
    for p, e in platforms.items():
        print(f"  {p:8s} gen={str(e['gen']):6s} 来源={e['source']:24s} "
              f"[22 2e]行={e['codingPool'].get('readWriteRows', 0)}")


if __name__ == '__main__':
    main()
