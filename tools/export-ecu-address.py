#!/usr/bin/env python3
"""
ECU 寻址全量导出 v3 —— 表B 精确 join + 文件行序（2026-11-04 收官）。

参考诊断仪 链路（ECU-ADDRESSING-20261019.md + 反汇编实证）：
  sysId → DRIVELINKS 目录 → addrBlock 行（文件行序 = 候选数组序）
        → 表B（sysId→internal）→ 表A（internal→CAN 候选，proto/attr/idx 消歧字段）
  98.8% 静态 / 1.2% 探针（0x2040/0x0B40/0x2340 族）。

落地三级（文档 §5 规格）：
  proven      → 直接进（真机锚点/实测）
  table-unique→ 直接进（候选唯一）
  candidate   → 定向探测（431 探报文+flags+识别串终审）；歧义禁写

用法：python3 tools/export-ecu-address.py     # 重写 data/ecu-addresses.json
"""
import importlib.util
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools' / 'resolve-ecu-address.py'
OUT = ROOT / 'data' / 'ecu-addresses.json'
SYS_DATA = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN')

spec = importlib.util.spec_from_file_location('rea', TOOL)
rea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rea)

ANCHOR_ATTRS = {0x000c02, 0x000e0c, 0x000f05}
ANCHORS = {sid: (tx, inter) for _n, sid, tx, inter in rea.ANCHORS}


def load_tabB(sd_bytes, sysids):
    """表B 多源并集（2026-11-04 收官）：
    SYS_DATA 16B 行 + ALL_ACTINFO/GFS 等文件的柔性共现扫描 —— 代际块分布在多个文件。
    实测：覆盖 209/209，锚点 5/6 数据命中（GW 为手工锚点）。
    """
    import glob as _glob
    tabB = {}
    # ① SYS_DATA 16B 行（宽松 tail）
    for off in range(0, len(sd_bytes) - 16):
        sid, inter = struct.unpack_from('<II', sd_bytes, off)
        if sid in sysids and 0x100 <= inter <= 0x1FFF:
            tabB.setdefault(sid, set()).add(inter)
    # ② 其余 decoded/*.BIN 柔性 24B 窗口共现（sysId u32 + internal u16）
    for f in _glob.glob('/Users/se818/porsche-mapper/ref/decoded/*.BIN'):
        if f.endswith('PORSCHE_SYS_DATA.BIN'):
            continue
        blob = open(f, 'rb').read()
        for sid in sysids:
            b4 = struct.pack('<I', sid)
            start = 0
            while True:
                i = blob.find(b4, start)
                if i < 0:
                    break
                win = blob[i:i + 24]
                for o in range(0, 22, 2):
                    v = struct.unpack_from('<H', win, o)[0]
                    if 0x100 <= v <= 0x1FFF:
                        tabB.setdefault(sid, set()).add(v)
                start = i + 1
    return tabB


def order_key(r):
    """候选序：表B 精确源优先 → 锚点 attr 组 → idx 槽位（0x05/0x08 常见真位）。"""
    src_rank = 0 if r.get('src') == 'tableB' else 1
    anchor_grp = 0 if r['attr'] in ANCHOR_ATTRS else 1
    slot = 0 if r['idx'] in (0x05, 0x08) else 1
    return (src_rank, anchor_grp, slot, r['idx'], r['tx'])


def main():
    dl, sd = rea.load()
    sd_rows = rea.sysdata_records(sd)
    dl_idx = rea.drivelinks_index(dl)
    sd_bytes = SYS_DATA.read_bytes()
    sysids = set(dl_idx.keys())
    tabB = load_tabB(sd_bytes, sysids)
    tabA = {}
    for r in sd_rows:
        if r['tx'] not in sysids:
            tabA.setdefault(r['internal'], []).append(r)

    old = {}
    if OUT.exists():
        for e in json.loads(OUT.read_text()).get('entries', []):
            old[e.get('sysId', '').lower()] = e

    entries = []
    for sysid in sorted(dl_idx):
        key = f'0x{sysid:04x}'
        variants = dl_idx[sysid]
        # ★ 表B 精确 join（sysId→internal→表A）优先；低字节模糊兜底
        precise = []
        for inter in tabB.get(sysid, ()):
            precise.extend(tabA.get(inter, []))
        if precise:
            cands_src, src_tag = precise, 'tableB'
        else:
            lows = {v['internal'] & 0xFF for v in variants}
            cands_src = [r for r in sd_rows if (r['internal'] & 0xFF) in lows]
            src_tag = 'lowbyte'
        diag = [r for r in cands_src if 0x700 <= r['tx'] <= 0x7FF]
        diag.sort(key=order_key)
        seen, rows = set(), []
        for r in diag:
            if r['tx'] in seen:
                continue
            seen.add(r['tx'])
            rows.append({'tx': f"0x{r['tx']:04X}", 'rx': f"0x{r['tx'] + 8:04X}",
                         'attr': f"0x{r['attr']:06X}", 'proto': r['proto'], 'idx': r['idx'],
                         'src': src_tag})
            if len(rows) >= 16:
                break
        # addrBlock 文件行序（裁剪语义用，2026-11-04 实证 = 候选数组序）
        row_order = [{'internal': f"0x{v['internal']:04X}", 'flags': v['flags'],
                      'blockKey': f"0x{v['blockKey']:04X}"} for v in variants[:32]]

        e_old = old.get(key, {})
        e = {
            'sysId': key,
            'sysIdDec': sysid,
            'tx': e_old.get('tx'),
            'rx': e_old.get('rx'),
            'confidence': e_old.get('confidence', 'candidate'),
            'internals': sorted(hex(i) for i in tabB.get(sysid, ())) or e_old.get('internals', []),
            'candidateCount': len(rows),
            'needsProbe': e_old.get('needsProbe', False),
            'probeCmd': e_old.get('probeCmd', []),
            'blockKeys': e_old.get('blockKeys', [f"0x{v['blockKey']:04X}" for v in variants][:8]),
            'system': e_old.get('system'),
            'cands': rows,
            'rows': row_order,
        }
        if sysid in ANCHORS and e['confidence'] != 'proven':
            tx, _ = ANCHORS[sysid]
            e['tx'], e['rx'], e['confidence'] = f'0x{tx:04X}', f'0x{tx + 8:04X}', 'proven'
        entries.append(e)

    doc = {
        'schemaVersion': 4,
        'source': 'PORSCHE_DRIVELINKS.BIN 三层目录 + PORSCHE_SYS_DATA.BIN 表B(sysId→internal) + 表A(internal→CAN)',
        'note': ('proven=真机锚点；table-unique=候选唯一；candidate=多候选走定向探测（文档 §5 三级）。'
                 'cands.src=tableB 为精确 join，lowbyte 为模糊兜底；rows=addrBlock 文件行序（表头裁剪语义用）。'),
        'probeRule': 'blockKey ∈ {0x0B40,0x0B41,0x2040,0x2041,0x2340..0x2345} → 发探测命令，按响应 flags 丢 2/3 条候选',
        'entries': entries,
        'anchorNote': '6 条 proven 来自真机实测锚点（2026-10-19 验证 6/6 命中）。',
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    n_prov = sum(1 for e in entries if e['confidence'] == 'proven')
    n_tB = sum(1 for e in entries if e['cands'] and e['cands'][0]['src'] == 'tableB')
    print(f'写出 {OUT} · {len(entries)} 条（proven {n_prov} · 表B精确源 {n_tB} · 有短名单 {sum(1 for e in entries if e["cands"])}）')


if __name__ == '__main__':
    main()
