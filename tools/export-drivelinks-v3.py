#!/usr/bin/env python3
"""export-drivelinks-v3.py — 把 PORSCHE_DRIVELINKS.BIN 全量解成「模块 → 行 → 记录 → 候选/模板」。

为什么要这个工具（RE-DISCOVERY-20261110）：
  431 进模块 = 选行 → 取记录 → 0/1 帧绑定。记录形态有 5 种（mode）：
    0x1001/0x1002 → SpecArray + 14B 记录族（旧导出器只认这两种，占 2.1%）
    0x1005        → u16 计数 + u32 数组
    0x1000        → 4×u32
    0x1010        → SpecArray + 0x230 条目描述符（SID/LID 模板）—— 52.7%，旧导出器完全没建模
  覆盖率从 2.1% 提到 100%，是「所有模块都进不去」的第一层修复。

结构（逐指令依据见 RE-DISCOVERY-20261110 §1/§2）：
  目录 8B/条  [u32 sysId][u32 blockOffset]，sysId==0x7FFFFFFF 结束
  block       [u8 count][count × 6B [u16 blockKey][u32 addrBlock]]
  addrBlock   [u16 grp][u16 0x0304][u16 count] + count×11B
              特例：首字节 0x1d → [u8 0x1d][u8 ?][u16 0x0304][u32 state][u16 count]（10B 头）
  行 11B      [u8 idx][u16 internal][u16 flags][u32 cmdptr][u16 mode]
  记录        [u16 mode][u8 tag][u8 n][u32 × n] 之后按 mode 分派

用法：
  python3 tools/export-drivelinks-v3.py            # 生成 data/drivelinks-v3.json + 覆盖率报告
  python3 tools/export-drivelinks-v3.py --check    # 只跑自检（锚点行/记录）
"""
import json
import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DL = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_DRIVELINKS.BIN')
OUT = ROOT / 'data' / 'drivelinks-v3.json'

# 已证锚点：sysId → (internal, 说明)。用来确认解析没跑偏。
ANCHORS = {
    0x0B13: (0x04CB, 'PASM  tx 0x7D0'),
    0x0B12: (0x04C1, 'PDC   tx 0x7CF'),
    0x0B01: (0x0538, 'DME   tx 0x7E0'),
    0x0B08: (0x026B, 'IC    地址未决'),
}


def parse_directory(dl):
    """目录 → [(sysId, blockOffset)]"""
    out, i = [], 0
    while i + 8 <= len(dl):
        sys_id, off = struct.unpack_from('<II', dl, i)
        if sys_id == 0x7FFFFFFF:
            break
        out.append((sys_id, off))
        i += 8
    return out


VALID_MODES = (0x1000, 0x1001, 0x1002, 0x1005, 0x1010)


def parse_block(dl, ab):
    """addrBlock → (state, [row...], 是否特例头)"""
    if ab + 6 > len(dl):
        return None, [], False
    special = dl[ab] == 0x1D
    if special:
        if ab + 10 > len(dl):
            return None, [], True
        magic = struct.unpack_from('<H', dl, ab + 2)[0]
        state = struct.unpack_from('<I', dl, ab + 4)[0]
        count = struct.unpack_from('<H', dl, ab + 8)[0]
        q = ab + 10
    else:
        _grp, magic, count = struct.unpack_from('<HHH', dl, ab)
        state = None
        q = ab + 6
    # 2026-11-10：除 0x0304 外还有 magic=0x0000 的块头（同样 6B：[grp][0][count]），
    #   如 blockKey 0x0b40/0x2040/0x2340（mode 0x1005 族）。早期只认 0x0304 → 整块被丢，
    #   这也是"0x1005 不存在"这个错误结论的来源。
    if magic not in (0x0304, 0x0000):
        return None, [], special
    rows = []
    for _ in range(min(count, 512)):      # 上限保护：异常 count 不拖死
        if q + 11 > len(dl):
            break
        idx = dl[q]
        internal, flags, cmdptr, mode = struct.unpack_from('<HHIH', dl, q + 1)
        # 行有效性：mode 必须在已知集合内，cmdptr 不能越界 —— 否则说明 count 不可信，停在这一行
        if mode not in VALID_MODES or (cmdptr and cmdptr >= 0x30000):
            break
        rows.append({'idx': idx, 'internal': internal, 'flags': flags,
                     'bindKey': (flags << 16) | internal,
                     'cmdptr': cmdptr, 'mode': mode, 'rowOff': q})
        q += 11
    return state, rows, special


def parse_record(dl, off, end, mode_hint):
    """记录头 [u16 mode][u8 tag][u8 n][u32×n] + 按 mode 分派载荷。"""
    if off + 4 > len(dl):
        return None
    mode, tag, n = struct.unpack_from('<HBB', dl, off)
    if mode not in VALID_MODES:
        # 少数模块的 cmdptr 指向的不是记录（如 0x0B46 的 [u16 0xffff][u16 idx] 表）
        return {'mode': mode, 'tag': tag, 'n': n, 'off': off, 'decoded': False,
                'error': 'not-a-record', 'payloadHex': dl[off:off + 16].hex(' ')}
    rec = {'mode': mode, 'tag': tag, 'n': n, 'off': off, 'decoded': False}
    pos = off + 4
    if n > 32:
        rec['error'] = f'n 异常 {n}'
        return rec
    cands = []
    for _ in range(n):
        if pos + 4 > len(dl):
            rec['error'] = 'SpecArray 越界'
            return rec
        cands.append(struct.unpack_from('<I', dl, pos)[0])
        pos += 4
    rec['candidates'] = [f'0x{c:08X}' for c in cands]
    body = min(end, len(dl)) - pos
    if body < 0:
        body = 0
    if mode in (0x1001, 0x1002):
        # u16 计数 + count×14B [u8 idx][u32 A][u32 B][u8 C][u32 D]
        if pos + 2 <= len(dl):
            cnt = struct.unpack_from('<H', dl, pos)[0]
            items, q = [], pos + 2
            for _ in range(min(cnt, 256)):
                if q + 14 > min(end, len(dl)):
                    break
                i_idx = dl[q]
                a, b, c, d = struct.unpack_from('<IIBI', dl, q + 1)
                items.append({'idx': i_idx, 'A': f'0x{a:08X}', 'B': f'0x{b:08X}',
                              'C': c, 'D': f'0x{d:08X}'})
                q += 14
            rec['records14'] = items
            rec['decoded'] = bool(items)
            rec['countField'] = cnt
    elif mode == 0x1005:
        # u16 计数 + count×u32
        if pos + 2 <= len(dl):
            cnt = struct.unpack_from('<H', dl, pos)[0]
            vals, q = [], pos + 2
            for _ in range(min(cnt, 256)):
                if q + 4 > min(end, len(dl)):
                    break
                vals.append(f'0x{struct.unpack_from("<I", dl, q)[0]:08X}')
                q += 4
            rec['u32Array'] = vals
            rec['decoded'] = bool(vals)
            rec['countField'] = cnt
    elif mode == 0x1000:
        if pos + 16 <= len(dl):
            rec['quad'] = [f'0x{struct.unpack_from("<I", dl, pos + 4 * i)[0]:08X}' for i in range(4)]
            rec['decoded'] = True
    elif mode == 0x1010:
        # 0x230 条目描述符（SID/LID 模板）尚未逐字段解 —— 如实留原始字节，不猜
        rec['payloadHex'] = dl[pos:pos + min(body, 64)].hex(' ')
        rec['decoded'] = False
        rec['decoder'] = 'todo-0x1010'
    else:
        rec['payloadHex'] = dl[pos:pos + min(body, 32)].hex(' ')
    return rec


def main():
    check_only = '--check' in sys.argv
    dl = DL.read_bytes()
    dirc = parse_directory(dl)

    # 记录边界：用全量 cmdptr 排序后的下一个作为上界（记录不重叠）
    all_rows = []
    blocks = []
    for sys_id, boff in dirc:
        if boff >= len(dl):
            continue
        cnt = dl[boff]
        q = boff + 1
        for _ in range(min(cnt, 64)):
            if q + 6 > len(dl):
                break
            bk, ab = struct.unpack_from('<HI', dl, q)
            q += 6
            state, rows, special = parse_block(dl, ab)
            if not rows:
                continue
            blocks.append({'sysId': sys_id, 'blockKey': bk, 'addrBlock': ab,
                           'state': state, 'special': special, 'rows': rows})
            for r in rows:
                r['sysId'] = sys_id
                r['blockKey'] = bk
                all_rows.append(r)
    ptrs = sorted({r['cmdptr'] for r in all_rows if 0 < r['cmdptr'] < len(dl)})
    next_ptr = {p: (ptrs[i + 1] if i + 1 < len(ptrs) else p + 0x400) for i, p in enumerate(ptrs)}

    rec_cache = {}
    for r in all_rows:
        p = r['cmdptr']
        if not p or p >= len(dl):
            r['record'] = None
            continue
        if p not in rec_cache:
            rec_cache[p] = parse_record(dl, p, next_ptr[p], r['mode'])
        rec = rec_cache[p]
        if rec and rec.get('mode') != r['mode']:
            rec = dict(rec, modeMismatch=f'行 0x{r["mode"]:04x} / 记录 0x{rec.get("mode", 0):04x}', decoded=False)
        r['record'] = rec

    # 统计只看唯一行（同一 addrBlock 会被多个 sysId 共享，重复计数会失真）
    uniq = {}
    for r in all_rows:
        uniq.setdefault(r['rowOff'], r)
    urows = list(uniq.values())
    modes = Counter(r['record']['mode'] for r in urows if r.get('record'))
    ns = Counter(r['record']['n'] for r in urows if r.get('record'))
    decoded = Counter(bool(r['record'].get('decoded')) for r in urows if r.get('record'))
    print(f'\n唯一行 {len(urows)} / 总行 {len(all_rows)}（同一 addrBlock 被多 sysId 共享）')

    # 自检：锚点行必须存在
    fails = []
    for sid, (internal, note) in ANCHORS.items():
        hit = [r for r in all_rows if r['sysId'] == sid and r['internal'] == internal]
        if not hit:
            fails.append(f'{note}: sysId 0x{sid:04x} 缺 internal 0x{internal:04x} 行')
            continue
        rec = hit[0].get('record') or {}
        print(f'  ok  {note}: 行 internal=0x{internal:04x} mode=0x{rec.get("mode", 0):04X} '
              f'n={rec.get("n")} cands={rec.get("candidates")}')
    print(f'\n行 {len(all_rows)} · 记录 {len(rec_cache)} · mode {[(hex(k), v) for k, v in modes.most_common(6)]}')
    print(f'候选数 n: {sorted(ns.items())} · 已解载荷: {dict(decoded)}')
    if fails:
        print('\n'.join('  FAIL ' + f for f in fails))
        return 1
    if check_only:
        print('\n自检通过')
        return 0

    # 按模块聚合输出
    ecu = {}
    for b in blocks:
        key = f'0x{b["sysId"]:04x}'
        e = ecu.setdefault(key, {'blocks': []})
        e['blocks'].append({
            'blockKey': f'0x{b["blockKey"]:04x}',
            'addrBlock': b['addrBlock'],
            'state': b['state'],
            'specialHeader': b['special'],
            'rows': [{
                'idx': r['idx'], 'internal': f'0x{r["internal"]:04x}',
                'flags': f'0x{r["flags"]:04x}', 'bindKey': f'0x{r["bindKey"]:08X}',
                'mode': f'0x{r["mode"]:04x}', 'cmdptr': f'0x{r["cmdptr"]:04x}',
                'rowOff': r['rowOff'], 'record': r['record'],
            } for r in b['rows']],
        })
    doc = {
        'schemaVersion': 3,
        'source': 'PORSCHE_DRIVELINKS.BIN (decoded) — row→record 全量，含 0x1010/0x1005/0x1000',
        'note': 'bindKey = 431 绑定入参 A（flags<<16|internal）；candidates = SpecArray；'
                'decoded=false 表示载荷形态未解（0x1010 描述符待做），只留原始字节',
        'stats': {
            'rows': len(all_rows), 'uniqueRows': len(urows), 'records': len(rec_cache),
            'modes': {f'0x{k:04x}': v for k, v in modes.items()},
            'nHistogram': {str(k): v for k, v in sorted(ns.items())},
            'decoded': {'true': decoded.get(True, 0), 'false': decoded.get(False, 0)},
        },
        'ecu': ecu,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'\n写出 {OUT.relative_to(ROOT)}  {OUT.stat().st_size / 1024:.0f}KB · {len(ecu)} 个 ECU')
    return 0


if __name__ == '__main__':
    sys.exit(main())
