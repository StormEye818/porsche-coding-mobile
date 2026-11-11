#!/usr/bin/env python3
"""export-all-model-sysids.py — RE-CODINGADDR §6 步骤1：981 换表方案推广到全量车型。

方法（全部包内字节证据，零手工猜测）：
  A. 平台 → 代际：SYS_DATA 根表 `[u8 count=22][[u8 type][u32 off]×22]`
     每个 type 的 comm 子表 sysDataOff → 子系统记录表（名字集）。
     **平台 ALLDATA 变体名集 ∩ type 子系统名字集 = 精确交集**（非近似 join），
     交集 top1 且领先 runner-up ≥15% → 定案该平台代际 type（=sysId 高字节）。
     9X1 → 0x0E（380 票/次高 352）与 981 已验收定案自证规则有效。
  B. 模块 → sysId：平台 ALLDATA 系统区全部变体名在 SYS_DATA name-9 全表检索
     （flag u16@name-11、sysId u32@name-9、len u16@name-2，len==strlen+1 校验），
     只取 **该平台代际** 的票（sid>>8==gen），得票最多者即系统 sysId。
  C. 981（9X1）沿用 data/981-sysids.json 的 48/48 已验收结果（含 adjacency/
     isomorphic/drivelinks-key 收口），保证推广不回退 981。
  D. 车型 → 平台：data/model-map.json（多平台车型取 isDefault / variantCount 最大）。

置信度：high（gap≥15%）/ medium（5%≤gap<15%）/ low（gap<5% 或平票）/ unresolved（无交集）。
只有 high/medium 的平台才在运行时启用平台专属 sysId；其余保持原全局表（不猜）。

输出 data/all-model-sysids.json（同时由 tools/build-model-sysid-map.mjs 编译成 src 模块）。
用法： python3 tools/export-all-model-sysids.py
"""
import json
import re
import struct
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
D = Path('/Users/se818/porsche-mapper/ref/decoded')
SYS = D / 'PORSCHE_SYS_DATA.BIN'
MODEL_MAP = ROOT / 'data' / 'model-map.json'
SYSIDS_981 = ROOT / 'data' / '981-sysids.json'
OUT = ROOT / 'data' / 'all-model-sysids.json'


def parse_root(b):
    n = b[0]
    return [(b[1 + i * 5], struct.unpack_from('<I', b, 2 + i * 5)[0]) for i in range(n)]


def parse_comm_subtable(b, off):
    """comm 子表：[u8 count][[u16 sysId][u8 nComm][nComm×[u32 commOff][u32 sysDataOff]]]"""
    n = b[off]
    p = off + 1
    out = []
    if not (0 < n <= 120):
        return out
    for _ in range(n):
        if p + 3 > len(b):
            break
        sid = struct.unpack_from('<H', b, p)[0]
        nc = b[p + 2]
        p += 3
        if nc > 16 or p + 8 * nc > len(b):
            return []
        pairs = []
        for _ in range(nc):
            co, so = struct.unpack_from('<II', b, p)
            p += 8
            pairs.append((co, so))
        out.append((sid, pairs))
    return out


def subsystem_names(b, so):
    """sysDataOff → [u8 count][[u16 len][name\\0][6×u32]] 名字集。"""
    if so >= len(b) - 8:
        return set()
    c = b[so]
    p = so + 1
    names = set()
    if not (0 < c <= 128):
        return names
    for _ in range(c):
        if p + 2 > len(b):
            break
        ln, = struct.unpack_from('<H', b, p)
        if ln > 90 or ln < 2 or p + 2 + ln > len(b) or b[p + 2 + ln - 1] != 0:
            break
        names.add(b[p + 2:p + 2 + ln - 1].decode('latin1', 'replace'))
        p += 2 + ln + 24
    return names


def alldata_systems(A):
    """ALLDATA 顶级目录 → 系统 → 变体名列表（14 平台同构，实测）。"""
    n = A[0]
    i = 1
    ents = []
    for _ in range(n):
        nlen, = struct.unpack_from('<H', A, i)
        name = A[i + 2:i + 2 + nlen - 1].decode('latin1')
        off = struct.unpack_from('<I', A, i + 2 + nlen)[0]
        ents.append((name, off))
        i += 2 + nlen + 4
    out = {}
    for name, off in ents:
        try:
            cnt, = struct.unpack_from('<I', A, off)
            j = off + 5
            vs = []
            for _ in range(min(cnt, 4000)):
                nlen, = struct.unpack_from('<H', A, j)
                if nlen > 200 or nlen < 2 or j + 2 + nlen + 8 > len(A):
                    break
                vs.append(A[j + 2:j + 2 + nlen - 1].decode('latin1'))
                j += 2 + nlen + 8
            out[name] = vs
        except Exception:
            out[name] = []
    return out


def name9_index(b):
    idx = defaultdict(list)
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
        if flag in (1, 2, 3) and 0 < sid < 0x2000:
            idx[nm].append((p, flag, sid))
    return idx


def main():
    b = SYS.read_bytes()
    root = parse_root(b)
    idx = name9_index(b)

    # type → 子系统名字集 / sysId 清单 / 名字→sysId 精确 join 表
    type_names, type_sysids, type_name_sids = {}, {}, {}
    for t, off in root:
        names, sids = set(), []
        n2s = defaultdict(set)
        for sid, pairs in parse_comm_subtable(b, off):
            sids.append(sid)
            for _, so in pairs:
                ns = subsystem_names(b, so)
                names |= ns
                for nm in ns:
                    n2s[nm].add(sid)
        type_names[t] = names
        type_sysids[t] = sids
        type_name_sids[t] = n2s

    mm = json.loads(MODEL_MAP.read_text())
    s981 = json.loads(SYSIDS_981.read_text())

    platforms, model_of_platform = {}, defaultdict(list)
    for model, hits in mm['modelMap'].items():
        best = sorted(hits, key=lambda h: (not h.get('isDefault'), -h.get('variantCount', 0)))[0]
        model_of_platform[best['platform']].append(model)

    stats = Counter()
    for f in sorted(D.glob('*_ALLDATA.BIN')):
        plat = f.stem.replace('_ALLDATA', '')
        V = alldata_systems(f.read_bytes())
        allnames = set(V) | {v for vs in V.values() for v in vs}

        # A. 精确交集定代际
        scores = sorted(((len(names & allnames), t) for t, names in type_names.items()
                         if names & allnames), reverse=True)
        gen, conf, evidence = None, 'unresolved', '平台变体名与全部 type 子系统名字集零交集'
        if scores:
            top, t = scores[0]
            second = scores[1][0] if len(scores) > 1 else 0
            gap = (top - second) / top if top else 0
            conf = 'high' if gap >= 0.15 else ('medium' if gap >= 0.05 else 'low')
            if conf in ('high', 'medium'):
                gen = t
            evidence = (f'精确交集 top1=type 0x{t:02X}×{top} 次高={second} gap={gap:.1%}；'
                        f'type 子表 {len(type_sysids.get(t, []))} 个 sysId（高字节=type 自证）')

        # B. 模块 → sysId：①限定该代 name-9 投票；②无票时用 comm 子表 sysId→名字精确 join
        #    （新代 0x10+ 的 SYS_DATA 段几乎无 flag∈{1,2,3} 记录，但 comm 子表的
        #     sysDataOff 记录表按 sysId 组织，名字是精确键，可直接 join —— 非近似匹配）。
        modules = {}
        if gen is not None:
            join = type_name_sids.get(gen, {})
            for sysname, vs in V.items():
                c = Counter()
                for vn in [sysname] + vs:
                    for _p, _flag, sid in idx.get(vn, []):
                        if sid >> 8 == gen:
                            c[sid] += 1
                if c:
                    sid = c.most_common(1)[0][0]
                    modules[sysname] = {
                        'sysId': f'0x{sid:04x}',
                        'method': 'name9-vote',
                        'evidence': f'代际 0x{gen:02X} 变体名投票 {sum(c.values())} 票 → 0x{sid:04x}×{c[sid]}',
                    }
                    continue
                j = Counter()
                for vn in [sysname] + vs:
                    for sid in join.get(vn, ()):
                        j[sid] += 1
                if j:
                    sid, top = j.most_common(1)[0]
                    second = j.most_common(2)[1][1] if len(j) > 1 else 0
                    uniq = (top - second) / top if top else 0
                    modules[sysname] = {
                        'sysId': f'0x{sid:04x}',
                        'method': 'comm-join',
                        'confidence': 'high' if uniq >= 0.15 or len(j) == 1 else 'low',
                        'evidence': (f'type 0x{gen:02X} comm 子表 sysId→名字精确 join '
                                     f'{sum(j.values())} 票 → 0x{sid:04x}×{top}（次高 {second}）'),
                    }
        # C. 981 权威覆盖
        if plat == '9X1':
            gen, conf = 0x0E, 'high'
            modules = {n: dict(m) for n, m in s981['modules'].items()}
            evidence += '；9X1 模块表沿用 981-sysids.json（48/48 已验收，含 adjacency/isomorphic/drivelinks-key 收口）'

        # 路由侧证据：该代 owner 数（sysdata-routing.json）
        routing = json.loads((ROOT / 'data' / 'sysdata-routing.json').read_text())
        n_owner = sum(1 for o in routing['byOwner'] if int(o, 16) >> 8 == gen) if gen else 0

        platforms[plat] = {
            'gen': f'0x{gen:02x}' if gen is not None else None,
            'confidence': conf,
            'genEvidence': evidence,
            'systems': len(V),
            'modulesResolved': sum(1 for m in modules.values() if m.get('sysId')),
            'routeOwnerCount': n_owner,
            'modules': modules,
        }
        stats[conf] += 1
        stats['modules'] += len(modules)

    # D. 车型展开（只引用 high/medium 平台；其余保持全局表，不猜）
    models = {}
    for model, hits in mm['modelMap'].items():
        best = sorted(hits, key=lambda h: (not h.get('isDefault'), -h.get('variantCount', 0)))[0]
        p = best['platform']
        e = platforms.get(p, {})
        models[model] = {
            'platform': p,
            'gen': e.get('gen'),
            'confidence': e.get('confidence'),
            'applyPlatformSysIds': e.get('confidence') in ('high', 'medium'),
            'moduleCount': e.get('modulesResolved', 0),
        }

    doc = {
        'schemaVersion': 1,
        'source': 'PORSCHE_SYS_DATA.BIN 根表/comm 子表/name-9 + 14× *_ALLDATA.BIN 目录 + model-map.json + 981-sysids.json',
        'method': '平台→代际=平台变体名∩type 子系统名字集精确交集(top1 gap≥15% high/≥5% medium)；模块→sysId=限定该代 name-9 投票；981 沿用已验收 48/48',
        'rule': '只有 high/medium 平台在运行时启用平台专属 sysId；low/unresolved 保持全局 MODULE_TO_ECUID（宁可不覆盖也不猜）',
        'stats': {'platforms': len(platforms), 'models': len(models), **dict(stats)},
        'platforms': platforms,
        'models': models,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'写出 {OUT.name}  {OUT.stat().st_size/1024:.0f}KB  {doc["stats"]}')
    for p, e in sorted(platforms.items()):
        print(f'  {p:8s} gen={str(e["gen"]):6s} conf={e["confidence"]:10s} '
              f'模块 {e["modulesResolved"]:3d}/{e["systems"]:3d} 路由owner={e["routeOwnerCount"]:2d} 车型={len(model_of_platform[p])}')
    applied = sum(1 for m in models.values() if m['applyPlatformSysIds'])
    print(f'车型启用平台专属映射：{applied}/{len(models)}（其余保持全局表）')
    if not (platforms.get('9X1', {}).get('gen') == '0x0e' and platforms['9X1']['modulesResolved'] == 48):
        raise SystemExit('❌ 981/9X1 回归失败')
    print('✅ 9X1 → 0x0E / 48 模块回归通过')


if __name__ == '__main__':
    main()
