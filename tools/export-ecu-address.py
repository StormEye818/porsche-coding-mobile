#!/usr/bin/env python3
"""
ECU 寻址全量导出 v5.1 —— 结构化表B 多源 join（2026-11-05）。

背景（HANDOFF 2026-11-05 条）：
  v4 的「柔性共现扫描」把 sysId 窗口内所有 u16 当 internal，脏行（0x746/0x74E）
  被 join 进 165 个 sysId —— 2026-11-04 真机 IC「表唯一候选免探测」直奔 0x746 全灭事故根因。

结构（字节级实证）：
  表A 行（PORSCHE_SYS_DATA.BIN）= [CAN_tx u32][internal u32][attr u32][proto|0x02|idx|0xff]
  表B 源1（SYS_DATA 同区）= [sysId u32][internal u32][attr u32][proto|0x02|idx|0xff]
      PASM/BCM_h/BCM_v/PDC 四锚点 internal 逐字命中（0x1CB/0x1C6/0x1C7/0x1CA）。
      internal 含共享路由组小值（0xBC/0x20/0x22…），不过滤。
  表B 源2（ALL_ACTINFO 等）= [sysId u32][internal|flags u32]（flags=高16：0x2000/0x3000/0x0082…）
      DME 0x0B01→0x20000122 逐字命中；E1 代际 IC→0x3000039E；CAJUN/E2/G1 IC→0x00821200。
  交叉引用（手工，证据级）：IC 0x0B08→0x117（0x7C0 仪表诊断段簇 + 崩溃会话记录）。

候选：限诊断段 tx∈0x700-0x7FF，按 源1→源2→xref 分层 + idx 槽位排序，≤16 条。
  唯一 → table-unique 直进；多条 → 定向探测+识别串终审（参考诊断仪 同款）；6 真机锚点 proven 优先。

用法：python3 tools/export-ecu-address.py
"""
import importlib.util
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools' / 'resolve-ecu-address.py'
OUT = ROOT / 'data' / 'ecu-addresses.json'
SYS_DATA = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN')
DEC = Path('/Users/se818/porsche-mapper/ref/decoded')

spec = importlib.util.spec_from_file_location('rea', TOOL)
rea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rea)

XREF = {0x0B08: {0x0117}}   # IC：0x7C0 仪表诊断段簇（手工交叉引用，证据见 HANDOFF）
FLAG_OK = (0x0000, 0x1000, 0x2000, 0x3000)


def load_rows(sd_bytes, sysids):
    tabA, tabB = {}, {}
    for off in range(0, len(sd_bytes) - 16):
        f0, inter, attr, tail = struct.unpack_from('<IIII', sd_bytes, off)
        b = tail.to_bytes(4, 'little')
        if not (b[3] == 0xff and b[1] == 0x02 and b[0] in (0x01, 0x03) and 0 < attr < 0x20000 and inter <= 0x1FFF):
            continue
        if f0 in sysids:
            tabB.setdefault(f0, set()).add(inter)
        elif 0x180 <= f0 <= 0x1FFF:
            tabA.setdefault(inter, []).append({'tx': f0, 'attr': attr, 'proto': b[0], 'idx': b[2]})
    return tabA, tabB


def load_rows2(sysids):
    """ALL_ACTINFO 异形行：[sysId u32][internal|flags u32]，多文件。"""
    out = {}
    for f in sorted(DEC.glob('*.BIN')):
        B = f.read_bytes()
        for sid in sysids:
            p = struct.pack('<I', sid)
            start = 0
            while True:
                i = B.find(p, start)
                if i < 0:
                    break
                if i + 8 <= len(B):
                    v = struct.unpack_from('<I', B, i + 4)[0]
                    if 0x01 <= (v & 0xFFFF) <= 0x1FFF and (v >> 16) in FLAG_OK:
                        out.setdefault(sid, set()).add(v & 0xFFFF)
                start = i + 1
    return out


def name_records_index(sd_bytes):
    """SYS_DATA 名字记录表：[u16 n][name\0][24B 尾]。cmdptr 是名字池游标（语义存疑，仅作索引）。"""
    import bisect
    recs = []
    N = len(sd_bytes)
    for off in range(0, N - 30):
        n = struct.unpack_from('<H', sd_bytes, off)[0]
        if 4 <= n <= 80 and off + 2 + n + 24 <= N:
            nb = sd_bytes[off+2:off+2+n]
            if nb[-1] == 0 and all(32 <= c < 127 for c in nb[:-1]):
                recs.append((off, nb[:-1].decode(), off + 2 + n + 24))
    starts = [r[0] for r in recs]

    def lookup(cmdptr):
        i = bisect.bisect_right(starts, cmdptr) - 1
        if i >= 0 and recs[i][0] <= cmdptr < recs[i][2]:
            return recs[i][1], 'inside'
        # 最近记录（±48 字节内）
        best, bd = None, 1 << 30
        for off, name, end in recs[max(0, i - 1):i + 3]:
            d = min(abs(cmdptr - off), abs(cmdptr - end))
            if d < bd:
                best, bd = name, d
        return (best, 'near') if best and bd <= 48 else (None, None)
    return lookup


def order_key(r, rank, excl):
    # 专属 internal 的行优先（共享路由组行殿后），再按锚点槽位/idx/tx
    return (excl, rank, 0 if r['idx'] in (0x05, 0x08) else 1, r['idx'], r['tx'])


def main():
    dl, sd = rea.load()
    dl_idx = rea.drivelinks_index(dl)
    sd_bytes = SYS_DATA.read_bytes()
    sysids = set(dl_idx.keys())
    tabA, tabB = load_rows(sd_bytes, sysids)
    tabB2 = load_rows2(sysids)
    name_lookup = name_records_index(sd_bytes)
    print(f'表A internal {len(tabA)} · 表B源1 {len(tabB)} sysId · 表B源2 {len(tabB2)} sysId')

    old = {}
    if OUT.exists():
        for e in json.loads(OUT.read_text()).get('entries', []):
            old[e.get('sysId', '').lower()] = e

    ANCH = {sid: tx for _n, sid, tx, _i in rea.ANCHORS}
    # internal 专属度：被多个 sysId 引用的 internal 是共享路由组，其行靠后、不能当唯一
    inter_users = {}
    for sysid in dl_idx:
        for g in (tabB.get(sysid, set()), tabB2.get(sysid, set()), XREF.get(sysid, set())):
            for inter in g:
                inter_users.setdefault(inter, set()).add(sysid)
    entries = []
    stat = {'proven': 0, 'unique': 0, 'multi': 0, 'none': 0}
    for sysid in sorted(dl_idx):
        key = f'0x{sysid:04x}'
        variants = dl_idx[sysid]
        groups = [(tabB.get(sysid, set()), 0), (tabB2.get(sysid, set()), 1), (XREF.get(sysid, set()), 2)]
        rows, seen = [], set()
        picked = []
        for internals, rank in groups:
            for inter in sorted(internals):
                excl = 0 if len(inter_users.get(inter, ())) <= 1 else 1
                for r in tabA.get(inter, []):
                    if 0x700 <= r['tx'] <= 0x7FF:
                        picked.append((excl, rank, inter, r))
        picked.sort(key=lambda t: order_key(t[3], t[1], t[0]))
        for excl, rank, inter, r in picked:
            if r['tx'] in seen:
                continue
            seen.add(r['tx'])
            rows.append({'tx': f"0x{r['tx']:04X}", 'rx': f"0x{r['tx'] + 8:04X}",
                         'attr': f"0x{r['attr']:06X}", 'proto': r['proto'], 'idx': r['idx'],
                         'internal': f"0x{inter:04X}", 'src': f'tabB{rank + 1}'})
            if len(rows) >= 16:
                break

        # 辅助候选（非诊断段行）：无 7xx 候选的 sysId 用（2026-11-05 ③ 收口）
        aux = []
        if not rows:
            seen_aux = set()
            for inter in internals_all if 'internals_all' in dir() else sorted(set().union(*[g[0] for g in groups])):
                for r in tabA.get(inter, []):
                    if r['tx'] not in seen_aux:
                        seen_aux.add(r['tx'])
                        aux.append({'tx': f"0x{r['tx']:04X}", 'rx': f"0x{r['tx'] + 8:04X}",
                                    'attr': f"0x{r['attr']:06X}", 'proto': r['proto'], 'idx': r['idx'],
                                    'internal': f"0x{inter:04X}", 'src': 'aux'})
                        if len(aux) >= 8: break
                if len(aux) >= 8: break
        internals_all = sorted(set().union(*[g[0] for g in groups]))
        e_old = old.get(key, {})
        if len(rows) == 1:
            conf, tx, rx = 'table-unique', rows[0]['tx'], rows[0]['rx']
        else:
            conf, tx, rx = 'candidate', e_old.get('tx'), e_old.get('rx')
        e = {
            'sysId': key, 'sysIdDec': sysid, 'tx': tx, 'rx': rx,
            'confidence': 'proven' if e_old.get('confidence') == 'proven' else conf,
            'internals': [f'0x{i:04X}' for i in internals_all],
            'candidateCount': len(rows),
            'needsProbe': e_old.get('needsProbe', False),
            'probeCmd': e_old.get('probeCmd', []),
            'blockKeys': e_old.get('blockKeys', [f"0x{v['blockKey']:04X}" for v in variants][:8]),
            'system': e_old.get('system'),
            'cands': rows,
            'candsAux': aux,
            'rows': [{'internal': f"0x{v['internal']:04X}", 'flags': v['flags'],
                      'blockKey': f"0x{v['blockKey']:04X}", 'cmdptr': f"0x{v['cmdptr']:X}",
                      'variant': (name_lookup(v['cmdptr'])[0]),
                      'variantSrc': (name_lookup(v['cmdptr'])[1])} for v in variants[:32]],
        }
        if sysid in ANCH:
            e['tx'], e['rx'], e['confidence'] = f'0x{ANCH[sysid]:X}', f'0x{ANCH[sysid] + 8:X}', 'proven'
        entries.append(e)

    # 共享唯一降级：同一 tx 被多个 sysId 当 table-unique → 全部降回 candidate（防两家抢一个地址）
    uniq_tx = {}
    for e in entries:
        if e['confidence'] == 'table-unique' and e['tx']:
            uniq_tx.setdefault(e['tx'].lower(), []).append(e)
    for tx, es in uniq_tx.items():
        if len(es) > 1:
            for e in es:
                e['confidence'], e['tx'], e['rx'] = 'candidate', None, None
    for e in entries:
        stat['proven' if e['confidence'] == 'proven' else
             'unique' if e['confidence'] == 'table-unique' else
             'multi' if e['cands'] else 'none'] += 1

    doc = {
        'schemaVersion': 5,
        'source': 'PORSCHE_SYS_DATA.BIN 表B/表A 结构化行 + ALL_ACTINFO internal|flags 行 + 交叉引用',
        'note': ('proven=真机锚点；table-unique=诊断段候选唯一；candidate=短名单定向探测+识别串终审。'
                 'v5=结构化 join（v4 柔性扫描 0x746 污染事故后重写），候选限诊断段 0x700-0x7FF。'),
        'probeRule': 'blockKey ∈ {0x0B40,0x0B41,0x2040,0x2041,0x2340..0x2345} → 发探测命令，按响应 flags 丢 2/3 条候选',
        'entries': entries,
        'anchorNote': '6 条 proven 来自真机实测锚点（2026-10-19 验证 6/6 命中）。',
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    print(f"写出 {OUT} · {len(entries)} 条（proven {stat['proven']} · unique {stat['unique']} · "
          f"multi {stat['multi']} · none {stat['none']}）")


if __name__ == '__main__':
    main()
