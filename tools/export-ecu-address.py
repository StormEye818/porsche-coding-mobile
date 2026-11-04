#!/usr/bin/env python3
"""
ECU 寻址全量导出 —— 把 SYS_DATA 候选集灌进 data/ecu-addresses.json（2026-11-04）。

依据 ECU-ADDRESSING-20261019.md：
  · 431 链路 sysId → DRIVELINKS → internal → SYS_DATA 表A/B → CAN 候选集
  · internal→CAN 一对多（文档 §3），最终唯一化 = proto/attr/idx 消歧 + 1.2% 探测
  · 2026-10-24 审计：DRIVELINKS 变体 internal 与 SYS_DATA 不同坐标，
    纯静态唯一化**未闭环** —— 但候选集**包含真地址**（DME 0x7E0、IC 0x7C0 实证在列）。

落地策略（app 侧配套）：
  · 候选集收敛到 11 位诊断段（0x700–0x7FF）内，按（锚点 attr 组 → idx 序）
    排序成定向探测短名单 —— 替换全网段盲扫；
  · 进模块时对短名单发 1A9F（+22F190 兜底），识别串验证后落 measured 覆盖。
  · proven 锚点（6 条真机）原样保留，优先级最高。

用法：python3 tools/export-ecu-address.py     # 重写 data/ecu-addresses.json
"""
import importlib.util
import json
import os
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools' / 'resolve-ecu-address.py'
OUT = ROOT / 'data' / 'ecu-addresses.json'

spec = importlib.util.spec_from_file_location('rea', TOOL)
rea = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rea)

# 真机锚点 attr 组（2026-10-19 6/6 实证）—— 这些组的候选排前面
ANCHOR_ATTRS = {0x000c02, 0x000e0c, 0x000f05}
# 锚点（sysId → (tx, rx, internal)）
ANCHORS = {sid: (tx, tx + 8 if tx in (0x710,) else tx + 8, inter)
           for _n, sid, tx, inter in rea.ANCHORS}


def order_key(r):
    """排序：锚点 attr 组 → 11 位诊断段 → idx 槽位序（锚点多见 0x05/0x08）。"""
    in_anchor_grp = 0 if r['attr'] in ANCHOR_ATTRS else 1
    slot = 0 if r['idx'] in (0x05, 0x08) else 1
    return (in_anchor_grp, slot, r['idx'], r['tx'])


def main():
    dl, sd = rea.load()
    sd_rows = rea.sysdata_records(sd)
    dl_idx = rea.drivelinks_index(dl)

    # 旧表：保留手工/实测字段（manual overrides 与 proven 校验靠它）
    old = {}
    if OUT.exists():
        for e in json.loads(OUT.read_text()).get('entries', []):
            old[e.get('sysId', '').lower()] = e

    entries = []
    for sysid in sorted(dl_idx):
        key = f'0x{sysid:04x}'
        variants = dl_idx[sysid]
        lows = {v['internal'] & 0xFF for v in variants}
        cands = [r for r in sd_rows if (r['internal'] & 0xFF) in lows]
        # 11 位诊断段（0x700–0x7FF）才是我们能探的物理段
        diag = [r for r in cands if 0x700 <= r['tx'] <= 0x7FF]
        diag.sort(key=order_key)
        # 去重（同 tx 保留排序最靠前的一条）
        seen, rows = set(), []
        for r in diag:
            if r['tx'] in seen:
                continue
            seen.add(r['tx'])
            rows.append({'tx': f"0x{r['tx']:04X}", 'rx': f"0x{r['tx'] + 8:04X}",
                         'attr': f"0x{r['attr']:06X}", 'proto': r['proto'], 'idx': r['idx']})
            if len(rows) >= 16:
                break

        e_old = old.get(key, {})
        e = {
            'sysId': key,
            'sysIdDec': sysid,
            'tx': e_old.get('tx'),
            'rx': e_old.get('rx'),
            'confidence': e_old.get('confidence', 'candidate'),
            'internals': e_old.get('internals', []),
            'candidateCount': len(rows),
            'needsProbe': e_old.get('needsProbe', False),
            'probeCmd': e_old.get('probeCmd', []),
            'blockKeys': e_old.get('blockKeys', [f"0x{v['blockKey']:04X}" for v in variants][:8]),
            'system': e_old.get('system'),
            'cands': rows,
        }
        # 锚点直接落 measured（rx 规则：网关 710→77A 是非 +8 锚点，其余 +8）
        if sysid in ANCHORS and e['confidence'] != 'proven':
            tx, rx, _ = ANCHORS[sysid]
            e['tx'], e['rx'], e['confidence'] = f'0x{tx:04X}', f'0x{rx:04X}', 'proven'
        entries.append(e)

    doc = {
        'schemaVersion': 2,
        'source': 'PORSCHE_DRIVELINKS.BIN 三层目录 + PORSCHE_SYS_DATA.BIN 表B(sysId→internal) + 表A(internal→CAN)',
        'note': ('internal→CAN 一对多。proven=真机锚点；table-unique=proto 过滤后唯一；'
                 'candidate=多候选需消歧；needsProbe=走 431 探测协议。'
                 'cands=11 位诊断段定向探测短名单（锚点 attr 组→idx 槽位排序，2026-11-04）。'),
        'probeRule': 'blockKey ∈ {0x0B40,0x0B41,0x2040,0x2041,0x2340..0x2345} → 发探测命令，按响应 flags 丢 2/3 条候选',
        'entries': entries,
        'anchorNote': '6 条 proven 来自真机实测锚点（2026-10-19 验证 6/6 命中）。candidate 需消歧或真机扫描。',
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    n_prov = sum(1 for e in entries if e['confidence'] == 'proven')
    n_cand = sum(1 for e in entries if e['cands'])
    print(f'写出 {OUT} · {len(entries)} 条（proven {n_prov} · 有短名单 {n_cand}）')
    ic = next((e for e in entries if e['sysId'] == '0x0B08'), None)
    if ic:
        print('IC(0x0B08) 短名单:', [c['tx'] for c in ic['cands']])


if __name__ == '__main__':
    main()
