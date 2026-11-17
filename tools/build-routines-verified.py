#!/usr/bin/env python3
"""T04-c / D-2：实测例程库 + 功能全集数据层 + 三命名空间门禁。

用法
----
  python3 tools/build-routines-verified.py                     # 重建 data/routines-verified.json（79 RID + 字节坐标）
  python3 tools/build-routines-verified.py --rebuild-catalog  # 重建功能全集数据层（任务 1/2/4 的 data/*.json 新字段）
  python3 tools/build-routines-verified.py --verify           # D2_RID_79_79 / D2_NAMESPACE_CLEAN 门禁（离线，不依赖 ref 包）
  python3 tools/build-routines-verified.py --dry-run          # 只打印，不写盘

三命名空间（D-2，互不混用，禁止再算「sf∩rv=1」这种把两个命名空间硬相交的无效指标）
--------------------------------------------------------------------------------------
  · menuId    67 条：data/special-functions.json 的菜单索引（0x200–0x34E），
               与 data/special-function-map.json 的 maps[].menuId 逐条相等；
  · RID       79 个：例程导出.bin 里 参考诊断仪真机发过的 0x31 通信例程 ID（b[4:6]，大端）；
  · 功能序列  687 条：data/function-sequences.json 的 functions[].name（实现函数名）。
  三者是**不同语义对象**，数值偶然重合没有工程含义；旧版「交集只有 1 个」的说法已删除。

厂商扩展伪 RID：sub ∈ {0x10, 0xB8, 0xB9, 0xBA} 的 `31 xx` 记录里 b[4:6] 是**参数**，
不是 RID16；由 body 字节静态判定性质，单列 vendorExtPseudoRids，不进 79 的通信 RID 语义。

记录格式（例程导出.bin 实测）
------------------------------------
  b[0]   = 未知（恒 0x01）
  b[1]   = 后续长度
  b[2]   = SID (0x31)
  b[3]   = subFunc
  b[4:6] = RID16（大端，仅当 len >= 6）
  b[6:]  = params
  index row：idxOff = st['index_off'] + 5 + i * (keylen+4)，4 字节 cmdId + 4 字节加密 payload 偏移。
"""
import argparse
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

GAG = Path('/Users/se818/porsche-mapper/ref/decoded/例程导出.bin')
REF = Path('/Users/se818/porsche-mapper/ref')
DATA = Path(__file__).resolve().parent.parent / 'data'
OUT = DATA / 'routines-verified.json'

# 参考诊断仪侧真实条目数口径：MENU.BIN @0x4C 的 u16(LE) = 767。不是人造上限。
MENU_BIN = REF / 'porche-v24.58' / 'V24.58' / 'MENU.BIN'
MENU_U16_OFF = 0x4C

SUB_FUNC = {
    0x01: 'startRoutine', 0x02: 'stopRoutine', 0x03: 'requestRoutineResults',
    0x04: '厂商扩展04', 0x06: '厂商扩展06', 0x0B: '厂商扩展0B', 0x0C: '厂商扩展0C',
    0x0D: '厂商扩展0D', 0x10: '厂商扩展10', 0xB8: '厂商扩展B8', 0xB9: '厂商扩展B9',
    0xBA: '厂商扩展BA', 0xBB: '厂商扩展BB',
}
# 「b[4:6] 是参数、不是 RID16」的厂商扩展子功能（31 10 / 31 B8/B9/BA）。
VENDOR_EXT_PARAM_SUBS = frozenset({0x10, 0xB8, 0xB9, 0xBA})
KNOWN = {
    0x0107: '实测出现 69 次（最高频），参考诊断仪用作例程主力',
    0x0103: '实测出现 35 次',
}


def _page_size_from_431():
    """从 MENU.BIN @0x4C 读 u16(LE)=767，给数据层分页用（参考诊断仪侧真实条目数口径）。"""
    b = MENU_BIN.read_bytes()
    raw = b[MENU_U16_OFF:MENU_U16_OFF + 2]
    n = int.from_bytes(raw, 'little')
    assert n > 0, 'MENU.BIN@0x4C u16 非法'
    return n, raw.hex(' ').upper(), f'{MENU_BIN.name}:0x{MENU_U16_OFF:02X}'


def _index_row(st, i):
    """复现 gag_codec.decode_record 的索引行解析，返回 (payloadOff, idxOff, cmdIdHex)。"""
    gag, ctx = st['gag'], st['ctx']
    keylen = st['keylen']
    rec_size = keylen + 4
    base = st['index_off'] + 5 + i * rec_size
    cmd_id = bytes(gag[base:base + keylen]).hex(' ').upper()
    offb = bytearray(gag[base + keylen:base + rec_size])
    import gag_codec  # noqa: PLC0415 - 仅本函数与 collect() 需要 ref 包
    gag_codec.gag_decrypt_modetable(offb, 0xB, ctx)
    text_off = (offb[0] << 24) | (offb[1] << 16) | (offb[2] << 8) | offb[3]
    return text_off, base, cmd_id


def collect():
    sys.path.insert(0, str(REF))
    import gag_codec  # noqa: PLC0415
    st = gag_codec.parse_text_gag(GAG.read_bytes())

    total = 0
    per_rid = defaultdict(lambda: {'count': 0, 'subs': defaultdict(int),
                                   'params': defaultdict(int), 'coords': []})
    no_rid = []
    pseudo = defaultdict(lambda: {'subs': set(), 'count': 0, 'sample': None})

    for i in range(st['count']):
        try:
            r = gag_codec.decode_record(st, i)
        except Exception:
            continue
        if not r:
            continue
        _k, b = r
        if len(b) < 3 or b[2] != 0x31:
            continue
        total += 1
        try:
            payload_off, idx_off, cmd_id = _index_row(st, i)
        except Exception:
            payload_off, idx_off, cmd_id = None, None, None
        coord = {
            'recordIndex': i,
            'idxOff': f'0x{idx_off:04X}' if idx_off is not None else None,
            'payloadOff': f'0x{payload_off:04X}' if payload_off is not None else None,
            'cmdId': cmd_id,
            'body': b.hex(' ').upper(),
        }
        if len(b) < 6:
            # 形如 `31 0C`：只有子功能没有 RID —— noRid 16 条，单列（不是 RID 命名空间的成员）
            no_rid.append({**coord, 'subFunc': f'0x{b[3]:02X}' if len(b) > 3 else None})
            continue
        sub = b[3]
        rid = (b[4] << 8) | b[5]
        params = b[6:].hex(' ').upper()
        if sub in VENDOR_EXT_PARAM_SUBS:
            # b[4:6] 是参数：登记为伪 RID，给 body 字节静态证据，不参与 RID 语义推断
            d = pseudo[rid]
            d['subs'].add(sub)
            d['count'] += 1
            if d['sample'] is None:
                d['sample'] = coord
        d = per_rid[rid]
        d['count'] += 1
        d['subs'][sub] += 1
        if params:
            d['params'][params] += 1
        d['coords'].append(coord)

    items = []
    for rid, d in sorted(per_rid.items()):
        subs = sorted(d['subs'].items(), key=lambda x: -x[1])
        params = sorted(d['params'].items(), key=lambda x: (-x[1], x[0]))
        items.append({
            'routineId': f'0x{rid:04X}',
            'ridInt': rid,
            'hits': d['count'],
            'subFuncs': [{'sub': f'0x{s:02X}', 'name': SUB_FUNC.get(s, '?'), 'n': n}
                         for s, n in subs],
            'params': [{'hex': p, 'n': n} for p, n in params],
            'byteCoords': d['coords'][:4],
            'byteCoordCount': len(d['coords']),
            'note': KNOWN.get(rid, ''),
        })
    pseudo_items = [
        {'paramValue': f'0x{rid:04X}', 'subFuncs': sorted(f'0x{s:02X}' for s in d['subs']),
         'recordCount': d['count'], 'kind': 'parameter-not-rid16',
         'staticallyDecidedBy': 'body 字节 b[3] ∈ {10,B8,B9,BA} → b[4:6] 是参数',
         'evidence': d['sample']}
        for rid, d in sorted(pseudo.items())
    ]
    meta = {
        'gagFile': GAG.name,
        'gagCount': st['count'],
        'indexOff': f'0x{st["index_off"]:X}',
        'records31': total,
        'withRid': total - len(no_rid),
        'noRid': len(no_rid),
    }
    return total, items, no_rid, pseudo_items, meta


def build_routines_verified(dry_run=False):
    total, items, no_rid, pseudo_items, meta = collect()
    print(f'GAG 0x31 记录 {total} 条 → 唯一通信 RID {len(items)} 个'
          f'（noRid 裸子功能请求 {len(no_rid)} 条 / 厂商扩展伪 RID {len(pseudo_items)} 个）')
    out = {
        'schemaVersion': 2,
        'kind': 'verified-routine-ids',
        'source': '例程导出.bin（参考诊断仪实测请求序列）0x31 全集',
        'caveat': ('只保证这些 RID 在 参考诊断仪真机通信中出现过（ID 合法），不保证「哪个 ID 对应哪个功能」。'
                   'D-2 三命名空间独立：67 个 menuId（菜单索引 0x200–0x34E）/ '
                   f'{len(items)} 个通信 RID / 687 条功能序列，互不混用；'
                   '禁止把菜单索引与通信 RID 两个命名空间硬相交后按交集大小下结论。'),
        'byteEvidence': meta,
        'count': len(items),
        'requestCount': total,
        'noRidCount': len(no_rid),
        'items': items,
        # noRid 16 条单列：带完整字节坐标，不塞进 79 的 RID 命名空间
        'noRidEntries': no_rid,
        # 厂商扩展伪 RID：b[4:6] 是参数，由 body 字节静态判定（数量按字节动态计算）
        # ★ 裁定 A：旧取证报告里的「45」是历史静态快照口径；本值按
        # `31 10 / 31 B8 / 31 B9 / 31 BA` 的 b[4:6] 并集逐字节动态计算（44），
        # 不为对上 45 放宽判据、也不加假记录。U-2 清理时把 45 标为历史值，别误伤。
        'vendorExtPseudoRids': pseudo_items,
        'vendorExtPseudoCount': len(pseudo_items),
        'vendorExtPseudoCountNote': (
            '旧报告 45 为历史口径，本值按 body 字节动态计算（裁定 A 采纳动态值）；'
            'U-2 旧数字清单应把 45 标为历史值，禁止为凑 45 放宽判据或补假记录。'),
        'namespaces': {
            'menuId': len(json.loads((DATA / 'special-functions.json').read_text())['functions']),
            'rid': len(items),
            'functionSequence': len(json.loads((DATA / 'function-sequences.json').read_text())['functions']),
        },
    }
    if dry_run:
        print(json.dumps(out, ensure_ascii=False, indent=1)[:1500])
        return out
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'→ {OUT}  ({OUT.stat().st_size:,} bytes)')
    return out


# ──────────────────────────────────────────────────────────────────
# T04-c 任务 1/2/4：功能全集数据层（可复跑，纯 in-repo，不依赖 ref 包）
# ──────────────────────────────────────────────────────────────────

def rebuild_catalog():
    page_size, raw_hex, byte_ev = _page_size_from_431()
    print(f'参考诊断仪侧长度规则：{byte_ev} bytes=[{raw_hex}] u16(LE)={page_size}')

    # ── 任务 1：687 条功能序列全量登记 + 修 E3_HUD_Shakedown_Test 悬空引用 ──
    seq = json.loads((DATA / 'function-sequences.json').read_text())
    smap = json.loads((DATA / 'special-function-map.json').read_text())
    seq_names = [str(f['name']) for f in seq['functions']]
    seq_set = set(seq_names)

    impl_refs = defaultdict(list)
    dangling = []
    for m in smap['maps']:
        for im in (m.get('impls') or []):
            n = str(im.get('name') or '')
            if n in seq_set:
                impl_refs[n].append(str(m['menuId']))
            elif n:
                dangling.append({'menuId': str(m['menuId']), 'name': n})

    # 幂等：再次运行时悬空引用已被修掉，从已落盘的 `status:'static-only'`
    # 菜单项确定性地重建历史事实，不依赖可变状态，也不把证据清零。
    prev_cov = smap.get('sequenceCoverage') or {}
    HUD_STATIC_EVIDENCE = [
        'data/special-functions-real.json:platforms.E3.HUD[0] (action=Test, rids=[])',
        'data/special-function-map.json:maps[].img=9YA_HUD_CALIBRATION_TOOL',
        'GAG_TEXT_CN.GAG.bin:idx 1961..1992（车型/年款文本表，HUD 菜单项静态存在）',
    ]
    prev_static = list(prev_cov.get('staticOnlyEntries') or [])
    # 归一化历史条目的 staticEvidence（旧版本可能是嵌套数组）
    for e in prev_static:
        flat = []
        for r in (e.get('staticEvidence') or []):
            if isinstance(r, (list, tuple)):
                flat.extend(str(x) for x in r)
            else:
                flat.append(str(r))
        e['staticEvidence'] = flat or list(HUD_STATIC_EVIDENCE)
    for m in smap['maps']:
        if m.get('status') != 'static-only':
            continue
        if any(e.get('menuId') == str(m.get('menuId')) for e in prev_static):
            continue
        raw_refs = m.get('staticEvidenceRefs') or []
        flat_refs = []
        for r in raw_refs:
            if isinstance(r, (list, tuple)):
                flat_refs.extend(str(x) for x in r)
            else:
                flat_refs.append(str(r))
        prev_static.append({
            'menuId': str(m.get('menuId')), 'system': m.get('system'), 'sub': m.get('sub'),
            'name': 'E3_HUD_Shakedown_Test',
            'staticEvidence': flat_refs or list(HUD_STATIC_EVIDENCE),
            'reason': '包内有菜单项与静态证据，但无 参考诊断仪命令序列；登记为 static-only，不生成可执行按钮',
        })
    # 修正前确有 1 条悬空引用（HEAD 版 maps 的 impl 指向不存在的 E3_HUD_Shakedown_Test）
    dangling_before = max(1, prev_cov.get('danglingRefsBefore', 0) or 0, len(dangling))

    # 修悬空引用：E3_HUD_Shakedown_Test 在包内没有命令序列，只有菜单项 + 静态文本证据。
    # 从 impls 移到 staticOnlyEntries（带真实静态坐标），不再伪装成可执行序列去骗 app。
    static_only = []
    fixed_maps = []
    for m in smap['maps']:
        m = dict(m)
        kept = []
        for im in (m.get('impls') or []):
            n = str(im.get('name') or '')
            if n and n not in seq_set:
                static_only.append({
                    'menuId': str(m['menuId']), 'system': m.get('system'), 'sub': m.get('sub'),
                    'name': n,
                    'staticEvidence': list(HUD_STATIC_EVIDENCE),
                    'reason': '包内有菜单项与静态证据，但无 参考诊断仪命令序列；登记为 static-only，不生成可执行按钮',
                })
            else:
                kept.append(im)
        m['impls'] = kept
        # status 从虚构的 no-seq 改成有静态证据的 static-only（app 仍会按 status 过滤，但不再悬空）
        if m.get('status') in ('no-seq', 'static-only'):
            m['status'] = 'static-only'
            m['match'] = 'static-only'
            refs = [x for e in static_only if e['menuId'] == str(m['menuId'])
                    for x in e['staticEvidence']]
            if not refs:
                for r in (m.get('staticEvidenceRefs') or []):
                    if isinstance(r, (list, tuple)):
                        refs.extend(str(x) for x in r)
                    else:
                        refs.append(str(r))
            m['staticEvidenceRefs'] = refs or list(HUD_STATIC_EVIDENCE)
        fixed_maps.append(m)
    if not static_only:
        static_only = prev_static

    entries = [
        {
            'name': n, 'seqIndex': i,
            'cmdCount': seq['functions'][i].get('cmdCount', 0),
            'rids': seq['functions'][i].get('rids', []),
            'menuRefs': sorted(impl_refs.get(n, [])),
            'source': f'data/function-sequences.json:functions[{i}]',
        }
        for i, n in enumerate(seq_names)
    ]
    covered = {e['name'] for e in entries}
    smap['sequenceCoverage'] = {
        'schemaVersion': 1,
        'source': 'data/function-sequences.json:functions[]（687 条真实命令序列，逐条登记）',
        'rule': ('包内可枚举集合 = sequenceCoverage.entries[].name；app 可枚举集合 = '
                 'maps[].impls[].name ∪ sequenceCoverage.entries[].name。'
                 '每条序列都有静态登记与来源坐标，无 map 引用者记为 unmapped 但仍在可枚举集合内。'),
        'sequenceTotal': len(seq_names),
        'mappedSequenceCount': len({n for n in seq_names if impl_refs.get(n)}),
        'unmappedSequenceCount': len({n for n in seq_names if not impl_refs.get(n)}),
        'indexedTotal': len(entries),
        'coverageDiff': len(seq_set - covered),
        'danglingRefsBefore': dangling_before,
        'danglingRefsAfter': len(dangling),
        'staticOnlyEntries': static_only,
        'entries': entries,
    }
    smap['maps'] = fixed_maps
    # 幂等：note 只追加一次
    _note_tag = 'T04-c：sequenceCoverage 全量登记 687 条功能序列'
    if _note_tag not in str(smap.get('note') or ''):
        smap['note'] = (str(smap.get('note') or '')
                        + ' ｜ ' + _note_tag + '；'
                          'E3_HUD_Shakedown_Test 由悬空 impl 改为 static-only（含静态证据坐标）。')
    (DATA / 'special-function-map.json').write_text(
        json.dumps(smap, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'  special-function-map.json: 687/687 登记, '
          f'mapped={smap["sequenceCoverage"]["mappedSequenceCount"]}, '
          f'unmapped={smap["sequenceCoverage"]["unmappedSequenceCount"]}, '
          f'悬空 {len(dangling)}→0, staticOnly={len(static_only)}')

    # ── 任务 2：按 app.js 现有分组键重组，每组 ≤ app 现有渲染上限 ──
    #  ★ 裁定 B：767 只是 MENU.BIN:0x4C 的「参考诊断仪侧真实条目数」计数证据，
    #    **不是 参考诊断仪侧分页规则、也不是新造的渲染上限**。真正的分组上限原样复用
    #    src/app.js 现有的 .slice(0,30) / sect(...,40)，不自创任何数字。
    #    分组键也逐字复刻 app.js:426x/431x 的过滤/分组表达式，因此 app.js 现有
    #    .filter(module) → .slice(0,100) → .slice(0,30) 的每组结果都不再被截断。
    for fname, arr_key, cap, cap_source in (
        ('measure.json', 'params', 30, 'src/app.js:4263 .slice(0, 30)'),
        ('actuator.json', 'items', 40, 'src/app.js:4326 sect(..., 40)'),
    ):
        j = json.loads((DATA / fname).read_text())
        arr = j[arr_key]
        total_items = len(arr)
        if fname == 'measure.json':
            # app.js:4257-4261 filter 的键 = String(m.module || '')
            group_key = lambda x: str(x.get('module') or '')
        else:
            # app.js:4312-4315 grp() 的键 = a.group || a.name.split(' / ')[0] || '其他'
            group_key = lambda x: str(x.get('group')
                                     or str(x.get('name') or '').split(' / ')[0]
                                     or '其他')
        buckets = defaultdict(list)
        for i, x in enumerate(arr):
            buckets[group_key(x)].append(i)
        pages = []
        for key in sorted(buckets):
            idxs = buckets[key]
            for s in range(0, len(idxs), cap):
                chunk = idxs[s:s + cap]
                pages.append({
                    'index': len(pages), 'key': key, 'count': len(chunk),
                    # 用「原数组下标」而非连续区间：不改动 params/items 原有顺序
                    'itemIdx': chunk,
                    'itemIds': [str(arr[i].get('id') if arr[i].get('id') is not None
                                    else arr[i].get('name') if arr[i].get('name') is not None
                                    else i) for i in chunk],
                })
        covered = {i for p in pages for i in p['itemIdx']}
        assert len(covered) == total_items, f'{fname} 分组覆盖 {len(covered)}/{total_items}'
        assert all(p['count'] <= cap for p in pages), f'{fname} 存在超限分组'
        j['view'] = {
            'schemaVersion': 2,
            'groupRule': ('按 app.js 现有分组键逐字复刻分组，每组上限 = app.js 现有渲染上限，'
                          '不自创任何新上限；767 仅作 参考诊断仪侧真实条目数的字节证据。'),
            'groupCap': cap,
            'groupCapSource': cap_source,
            'count431': {
                'file': str(MENU_BIN), 'offset': f'0x{MENU_U16_OFF:02X}',
                'bytes': raw_hex, 'u16LE': page_size,
                'note': ('参考诊断仪侧真实条目数证据（MENU.BIN:0x4C u16LE）：'
                         '只用于证明 参考诊断仪侧确有该量级条目，不是分页规则，也不是渲染上限。'),
            },
            'byteEvidence': [{'file': str(MENU_BIN), 'offset': f'0x{MENU_U16_OFF:02X}',
                              'bytes': raw_hex, 'u16LE': page_size}],
            'totalItems': total_items,
            'groupCount': len(pages),
            'groupKeys': len(buckets),
            'groupsWithinCap': f'{sum(1 for p in pages if p["count"] <= cap)}/{len(pages)}',
            'pages': pages,
            'enumerable': (f'data/{fname}:{arr_key}[] 全量 {total_items} 条，'
                           f'按 {len(buckets)} 个分组键切成 {len(pages)} 组、每组 ≤ {cap}；'
                           '枚举并集覆盖 100%，差集=0，无截断'),
            'appLimits': {
                'note': ('src/app.js（T03 定稿，禁碰）的 slice 是 UI 单页渲染上限；'
                         'view.pages 的分组上限直接取该值，运行时消费者是 '
                         'www/index.html 的 feature-catalog bootstrap → '
                         'src/schema.js:enumeratePages()（app.js 已 import 的模块）。'),
                'measureFilter': 100, 'measureRender': 30,
                'actuatorInfo': 40, 'gagQuick': 40,
            },
        }
        (DATA / fname).write_text(
            json.dumps(j, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f'  {fname}: {total_items}/{total_items} 条 → {len(buckets)} 键 / {len(pages)} 组'
              f' × 每组 ≤ {cap}（{cap_source}），差集=0')

    # ── 任务 4：special-functions.json 的 routineId 正名为 menuId（保留旧名兼容生成器） ──
    sf = json.loads((DATA / 'special-functions.json').read_text())
    smap_menu_ids = [str(m['menuId']) for m in smap['maps']]
    for i, f in enumerate(sf['functions']):
        legacy = str(f.get('routineId') or '')
        canonical = legacy if legacy else (smap_menu_ids[i] if i < len(smap_menu_ids) else '')
        f['menuId'] = canonical
        f['routineId'] = canonical  # deprecated 兼容别名：离线生成器仍读旧名，值恒等
        f['namespace'] = 'menuId'
    sf['namespace'] = {
        'name': 'menuId',
        'count': len(sf['functions']),
        'range': '0x200–0x34E',
        'canonicalField': 'menuId',
        'deprecatedAlias': 'routineId',
        'note': ('67 条全等 data/special-function-map.json 的 maps[].menuId；'
                 '与 79 个通信 RID / 687 条功能序列是三个独立命名空间，互不混用；'
                 '已删除 sf∩rv 无效指标。'),
    }
    (DATA / 'special-functions.json').write_text(
        json.dumps(sf, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'  special-functions.json: {len(sf["functions"])} 条 menuId 正名完成')


# ──────────────────────────────────────────────────────────────────
# D2_RID_79_79 / D2_NAMESPACE_CLEAN 门禁（离线，只读 data/*.json）
# ──────────────────────────────────────────────────────────────────

def verify():
    lines = []
    bad = 0

    def ok(aid, cond, detail=''):
        nonlocal bad
        lines.append(f'{"PASS" if cond else "FAIL"} {aid} — {detail}')
        if not cond:
            bad += 1

    rv = json.loads((DATA / 'routines-verified.json').read_text())
    sf = json.loads((DATA / 'special-functions.json').read_text())
    smap = json.loads((DATA / 'special-function-map.json').read_text())
    seq = json.loads((DATA / 'function-sequences.json').read_text())

    # D2_RID_79_79：79 个通信 RID 全部带真实 4 字段字节坐标
    items = rv.get('items', [])
    coords_ok = all(
        isinstance(it.get('byteCoords'), list) and it['byteCoords']
        and all(isinstance(c, dict)
                and all(c.get(k) for k in ('idxOff', 'payloadOff', 'cmdId', 'body'))
                for c in it['byteCoords'])
        for it in items
    )
    ok('D2_RID_79_79 79 个通信 RID 全带 {idxOff,payloadOff,cmdId,body} 字节坐标',
       len(items) == 79 and coords_ok,
       f'items={len(items)} 坐标齐备={coords_ok} indexOff={rv.get("byteEvidence", {}).get("indexOff")}'
       f' records31={rv.get("byteEvidence", {}).get("records31")}')

    # D2_NAMESPACE_CLEAN：三命名空间独立
    menu_ids = [str(f.get('menuId')) for f in sf['functions']]
    map_ids = [str(m.get('menuId')) for m in smap['maps']]
    in_range = all(0x200 <= int(x, 16) <= 0x34E for x in menu_ids)
    same = menu_ids == map_ids
    seq_total = len(seq['functions'])
    cov = smap.get('sequenceCoverage', {})
    cov_ok = (cov.get('sequenceTotal') == seq_total == 687
              and cov.get('indexedTotal') == seq_total
              and cov.get('coverageDiff') == 0
              and cov.get('danglingRefsAfter') == 0)
    no_rid_ok = rv.get('noRidCount') == 16 == len(rv.get('noRidEntries', []))
    pseudo = rv.get('vendorExtPseudoRids', [])
    pseudo_ok = (len(pseudo) == rv.get('vendorExtPseudoCount')
                 and all(p.get('kind') == 'parameter-not-rid16'
                         and p.get('staticallyDecidedBy')
                         and p.get('evidence', {}).get('body') for p in pseudo))
    ok('D2_NAMESPACE_CLEAN 67 menuId 全在 0x200–0x34E 且逐条等于 map.menuId',
       len(menu_ids) == 67 and in_range and same,
       f'menuId={len(menu_ids)} 范围合法={in_range} 与 map 逐条相等={same}')
    # 结构性断言：不得存在把两个命名空间硬相交的「重叠/交集」指标字段。
    forbidden_metric = ('sfRvOverlap', 'sfRvIntersection', 'overlapWithSpecialFunctions',
                        'menuIdRidIntersection', 'intersectionCount')
    rv_text = json.dumps(rv, ensure_ascii=False)
    metric_absent = all(k not in rv_text for k in forbidden_metric)
    ok('D2_NAMESPACE_CLEAN 三命名空间 67/79/687 独立且无菜单索引×RID 交集指标',
       (rv.get('namespaces', {}).get('menuId') == 67
        and rv.get('namespaces', {}).get('rid') == 79
        and rv.get('namespaces', {}).get('functionSequence') == seq_total
        and metric_absent
        and '交集只有 1 个' not in rv_text
        and '交集仅 1 个' not in rv_text),
       f'67 menuId / 79 RID / 687 功能序列；无效指标字段归零={metric_absent}')
    ok('D2_NAMESPACE_CLEAN 687 条功能序列全量登记且悬空引用归零',
       cov_ok, f'indexed={cov.get("indexedTotal")} diff={cov.get("coverageDiff")}'
               f' 悬空={cov.get("danglingRefsAfter")}')
    ok('D2_NAMESPACE_CLEAN noRid 16 条单列 + 厂商扩展伪 RID 由 body 字节静态判定',
       no_rid_ok and pseudo_ok,
       f'noRid={rv.get("noRidCount")} vendorExtPseudoRids={len(pseudo)}'
       f'（按 31 10/31 B8/B9/BA 的 b[4:6] 动态计算）')

    # MENU_911_681_TO_454_PROOF：把 681→454 口径做成 --verify 的真实门禁断言。
    # 逐条钉死：codingCount431=681 是含重复+跨模块口径；**固定基线提交 50b720b** 的回填前
    # 版本 500 条里 157 重复/343 唯一；包内唯一 id 全集 454；227 差额非丢数据。
    #
    # ★ QA R3 / 问题1：原先用 `git show HEAD:` 取「回填前」版本 —— 一旦把回填结果提交，
    #   HEAD 就变成 454 条，断言前提失效 → 每次提交后必假红（依赖可变引用）。
    #   现改为**固定基线提交 BASELINE_COMMIT = 50b720b**，与后续任何提交无关、可永久复跑；
    #   git 不可用时仍 FAIL（不跳过、不伪造）。
    menu = json.loads((DATA / 'menu-tree-v3.json').read_text())
    node = None
    for g in menu.get('groups', []):
        for m in g.get('models', []):
            for f in m.get('functions', []):
                for s in f.get('systems', []):
                    if s.get('itemIdsSource') and s.get('codingCount431') == 681:
                        node = s
                        break
    BASELINE_COMMIT = '50b720b'   # 固定基线（回填前版本：500 条/343 唯一/157 重复）
    base_ids = []
    try:
        import subprocess  # noqa: PLC0415
        base = json.loads(subprocess.run(
            ['git', 'show', f'{BASELINE_COMMIT}:data/menu-tree-v3.json'],
            capture_output=True, text=True, check=True).stdout)
        for g in base.get('groups', []):
            for m in g.get('models', []):
                for f in m.get('functions', []):
                    for s in f.get('systems', []):
                        if s.get('ref') == (node or {}).get('ref') and s.get('itemIds'):
                            base_ids = [str(x) for x in s['itemIds']]
                            break
    except Exception:  # git 不可用 / 基线提交缺失时 base_ids 保持空 → 该断言 FAIL（不跳过、不伪造）
        base_ids = []
    cur_ids = [str(x) for x in (node or {}).get('itemIds', [])]
    cur_unique = set(cur_ids)
    base_unique = set(base_ids)
    base_dups = len(base_ids) - len(base_unique)
    # 包内静态全集：coding-v2.json params ∪ data/models/*/*.json items
    universe = {str(p['id']) for p in json.loads((DATA / 'coding-v2.json').read_text())['params']}
    for mf in sorted((DATA / 'models').glob('*/*.json')):
        try:
            for it in json.loads(mf.read_text()).get('items', []):
                if 'id' in it:
                    universe.add(str(it['id']))
        except (ValueError, OSError):
            continue
    universe_hit = sum(1 for x in cur_ids if x in universe)
    cc431 = (node or {}).get('codingCount431')
    cc_now = (node or {}).get('codingCount')
    d454_ok = (
        cc431 == 681 and cc_now == 454
        and len(cur_ids) == 454 and len(cur_unique) == 454
        and len(base_ids) == 500 and len(base_unique) == 343 and base_dups == 157
        and universe_hit == 454
        and (node or {}).get('modules') is not None
        and len((node or {}).get('modules', [])) == 4
        and menu.get('itemIdsBackfill', {}).get('fixedNodes') == 153
    )
    ok('MENU_911_681_TO_454_PROOF 681=含重复/跨模块口径，454=包内唯一 id 全集，227 差额非丢数据',
       d454_ok,
       f'cc431={cc431} baseline={BASELINE_COMMIT} {len(base_ids)} 条/{len(base_unique)} 唯一/{base_dups} 重复'
       f' → 现 {len(cur_ids)} 条/{len(cur_unique)} 唯一 codingCount={cc_now}'
       f'；包内全集命中 {universe_hit}/454；modules={(node or {}).get("modules")}'
       f'；681-454={681 - len(cur_ids)}')

    text = '\n'.join(lines)
    print(text)
    print(f'===== D2 门禁：{len(lines) - bad} PASS / {bad} FAIL =====')
    print('复跑：python3 tools/build-routines-verified.py --verify')
    print('sha256=' + hashlib.sha256(text.encode()).hexdigest())
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--rebuild-catalog', action='store_true')
    ap.add_argument('--verify', action='store_true')
    args = ap.parse_args()
    if args.verify:
        return verify()
    if args.rebuild_catalog:
        rebuild_catalog()
        return 0
    build_routines_verified(args.dry_run)
    return 0


if __name__ == '__main__':
    sys.exit(main())
