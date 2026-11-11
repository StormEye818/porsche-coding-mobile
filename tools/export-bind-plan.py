#!/usr/bin/env python3
"""export-bind-plan.py — 多源「进模块绑定计划」生成器（2026-11-11 全车型推广）。

2026-11-10 在 981（0x0E 代）证实；2026-11-11 按 RE-CODINGADDR §6 推广到全量车型：
  · 代际泛化：gen = sysId>>8；gen≥0x0E 的条目全部走多源分级（含 0x10-0x16 新代，
    即使 drivelinks-v3 无键也由路由表/comm 子表给 sysId 建条目）。
  · DME 路由组自动注入：对每代 g，owner=(g<<8)|0x0C 存在即作为 (g<<8)|0x01 的
    路由组；优先取该 owner 的 0x7E0-0x7EF can 行（0x0E0C 自证），无则退全量。
  · 跨代候选泛化：all-model-sysids.json 的同名模块在各平台的 sysId 全部作为
    「同系统跨代 sysId」→ 旧代表A 候选 ∩ 路由表 can（精确交集）。
  · 旧代 0x05/0x06/0x0B-0x0D 条目保留表A join 逻辑（test-align431 对账基线，不改）。

依据：
  RE-DISCOVERY-20261110 §1（DriveLinksMode_1001 @LINK:0x18f00）：n==0 → 直接绑定；
    n>0 → 逐候选 1 帧 22 14 09。候选/行键在**请求键坐标空间**（0x0030xxxx），
    但 0x0E 代直连键（bindKey）低 16 位**有时即 CAN 本身**（SWSG 0x763/0x764、
    Verdeck 0x765、Lift 0x771、BKE 0x735-0x73C、LCA 0x6CC-0x6CF）。
  RE-SYSDATA-ROWS-20261110 路由表（data/sysdata-routing.json，tools/export-sysdata-routing.py）：
    16B 记录 [u32 owner][sig][sel][ff][u32 can][u32 m]；owner=代际前缀+系统低字节，
    0x0E0C=DME 路由组、0x0C09=网关（拥有 0x7DF/0x7E0）；0x13(PASM) 家族任何代无 owner 行。

多源分级（tierA 优先，空则降级，每条候选带 provenance）：
  S2 v3key      drivelinks-v3 bindKey 低16位 ∈ 0x600-0x7FF（直连键= CAN tx）
  S3 v3cand     drivelinks-v3 record.candidates 低16位 ∈ 诊断段：低半字节 ≥8 视为 rx
                （DME 0x7E8-0x7EC → tx=rx-8=0x7E0-0x7E4），否则视为 tx
  S1 routing    sysdata-routing owner==sysId 的 can（PSM 0x6E6-0x6EA、IC 0x7F1 等）
  S0 routeGroup DME 家族路由组 owner（0x0E0C，限 0x7E0-0x7EF；各代同构 0x_0C）
  S4 crossgen   旧代 sysId 的表A 候选 ∩ 路由表 can（精确交集，非近似 join）：
                PASM 0x0e13 无静态直达（0x13 家族无路由行）→ 0x0b13 表A候选 ∩ 路由表
                → 0x7D0（owner 0x0C05/0x0C02 跨代行）。
  tierA = S1∪S2∪S3∪S0 非空 → 只用 tierA；否则 S4；否则空（app.js 枚举兜底）。
  候选序 = 多源收敛数降序、再按地址升序（DME 0x7E0 四源收敛排第一）。

输出 data/bind-plan.json（键=sysId 小写；0x0B 旧代条目逻辑保持不变，test-align431 对账）：
  { "ecu": { "0x0e01": { mode, n, bindDirect, cands, pairs, firstRead,
                          sources:{routing,v3key,v3candRx,crossgen}, provenance:[...] } } }

firstRead：绑定后验证帧（coding-v2 首参数读帧）。0x0E 键用 module-ecu-map.js 正则名字；
  0x0B 旧键换表后正则名字不足（981 模块名已迁 0x0E）→ LEGACY_981_MODULES 补（git 历史口径）。
"""
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V3 = ROOT / 'data' / 'drivelinks-v3.json'
ADDR = ROOT / 'data' / 'ecu-addresses.json'
CODING = ROOT / 'data' / 'coding-v2.json'
ROUTING = ROOT / 'data' / 'sysdata-routing.json'
ROOT_TABLE = ROOT / 'data' / 'sysdata-root-table.json'
SYSIDS = ROOT / 'data' / '981-sysids.json'
ALL_SYSIDS = ROOT / 'data' / 'all-model-sysids.json'
OUT = ROOT / 'data' / 'bind-plan.json'

DIAG_LO, DIAG_HI = 0x600, 0x7FF
# 11 位诊断**请求**段：0x7F8-0x7FF 是应答段（tx+8 必然溢出），不能当请求地址发 ATSH。
REQ_HI = 0x7F7

# DME 家族路由组：不再硬编码代际 —— 运行时按「该代 owner=(g<<8)|0x0C 是否存在」自动注入
# （0x_0C 各代同构，根表 type=代际前缀；见 tools/export-sysdata-routing.py parse_root_table）。

# 换表前 981 模块 → 0x0B 代 sysId（git 历史 module-ecu-map.js 顶层块口径）。
# 仅用于旧代 0x0B 条目的 firstRead（coding-v2 按模块名查首参数）。
LEGACY_981_MODULES = {
    '0x0b01': ['DME_BDE_Continental', 'BV_ECM_UDS'],
    '0x0b02': ['Getriebesteuerung_PDK', 'Waehlhebel'],
    '0x0b04': ['Airbag'],
    '0x0b05': ['PSM'],
    '0x0b07': ['BKE'],
    '0x0b08': ['Kombiinstrument_MM'],
    '0x0b09': ['CAN_CAN_Gateway'],
    '0x0b12': ['PDC'],
    '0x0b13': ['PASM_PADM'],
    '0x0b1d': ['Zusatzinstrument'],
    '0x0b1e': ['TUER_VORNE'],
    '0x0b1f': ['TUER_HINTEN'],
    '0x0b20': ['BCM_vorne'],
    '0x0b23': ['BCM_hinten'],
    '0x0b32': ['EPB'],
    '0x0b36': ['Lenkstockschalter'],
    '0x0b37': ['RDK'],
    '0x0b40': ['ACC3'],
    '0x0b41': ['Verstaerker'],
    '0x0b45': ['Steering_Control_Unit'],
    '0x0b46': ['Head_Unit'],
    '0x0b4a': ['Frontkamera'],
    '0x0b4b': ['TVTuner'],
    '0x0b4c': ['Sitzsteuergeraet'],
    '0x0b51': ['Rueckfahrkamera_II'],
    '0x0b58': ['SCHEINWERFER'],
}


def main():
    v3 = json.loads(V3.read_text())
    addr = json.loads(ADDR.read_text())
    coding = json.loads(CODING.read_text())
    routing = json.loads(ROUTING.read_text())
    root_table = json.loads(ROOT_TABLE.read_text())
    sysids_doc = json.loads(SYSIDS.read_text())
    all_sysids = json.loads(ALL_SYSIDS.read_text())

    # ---- 公共：模块名 → 首参数 lid / 族（readSid 众数） ----
    by_mod = {}
    for it in coding.get('params', []):
        m = it.get('module')
        if not m:
            continue
        e = by_mod.setdefault(m, {'sids': Counter(), 'firstLid': None})
        if it.get('readSid') is not None:
            e['sids'][it['readSid']] += 1
        if e['firstLid'] is None and isinstance(it.get('lid'), int):
            e['firstLid'] = it['lid']

    # ---- sysId → 模块名：正则 module-ecu-map.js + LEGACY_981_MODULES + 981-sysids ----
    sys_to_mods = defaultdict(list)
    src = (ROOT / 'src' / 'module-ecu-map.js').read_text(encoding='utf-8')
    for name, sid in re.findall(r'"([A-Za-z0-9_]+)"\s*:\s*"(0x[0-9a-fA-F]{4})"', src):
        if name not in sys_to_mods[sid.lower()]:
            sys_to_mods[sid.lower()].append(name)
    for sid, names in LEGACY_981_MODULES.items():
        for n in names:
            if n not in sys_to_mods[sid]:
                sys_to_mods[sid].append(n)
    for name, m in sysids_doc.get('modules', {}).items():
        for s in m.get('sysIds') or []:
            k = s.lower()
            if name not in sys_to_mods[k]:
                sys_to_mods[k].append(name)
    # 全车型：只把 high/medium 平台的模块名纳入（low/unresolved 不猜、不覆盖）
    module_sids_all = defaultdict(set)
    for p, e in (all_sysids.get('platforms') or {}).items():
        if e.get('confidence') not in ('high', 'medium'):
            continue
        for name, m in (e.get('modules') or {}).items():
            s = (m.get('sysId') or '').lower()
            if not s:
                continue
            module_sids_all[name].add(s)
            if name not in sys_to_mods[s]:
                sys_to_mods[s].append(name)

    def first_read_of(sid):
        best = None
        for name in sys_to_mods.get(sid, []):
            e = by_mod.get(name)
            if not e or e['firstLid'] is None:
                continue
            sid_read = e['sids'].most_common(1)[0][0] if e['sids'] else None
            if sid_read not in (0x21, 0x22, 0x1a):
                continue
            if sid_read == 0x22:
                frame = f'22{e["firstLid"]:04X}'
            else:
                frame = f'{sid_read:02X}{e["firstLid"] & 0xFF:02X}'
            if best is None:
                best = {'frame': frame, 'module': name}
        return best

    # ---- 路由表 ----
    route_by_owner = {}
    for own, rows in (routing.get('byOwner') or {}).items():
        route_by_owner[own.lower()] = {int(r['can'], 16) for r in rows}
    routing_all = set().union(*route_by_owner.values()) if route_by_owner else set()

    # ---- 旧代表A 候选（沿用 ecu-addresses 导出，只取诊断段；rx 原样保留） ----
    cand_by_sys, prov_tx_by_sys = {}, {}
    rx_by_sys, rx_votes = {}, defaultdict(set)
    for e in addr.get('entries', []):
        cs = []
        sid = e['sysId'].lower()
        rx_by_sys[sid] = {}
        for c in e.get('cands') or []:
            tx = c.get('tx')
            if not tx:
                continue
            v = int(tx, 16)
            if DIAG_LO <= v <= DIAG_HI:
                # 表A 原始记录只有 tx（16B 路由行 [owner][sig][sel][ff][u32 can][u32 m]），
                # 没有独立 rx 字段；ecu-addresses 的 rx 本身就是 tx+8 的派生值。
                # 这里仍按「有 rx 就保留」处理，但不做 &0x7FF 回绕：越界值交给 rejectedPairs。
                rx = c.get('rx') or (f'0x{v + 8:04X}' if v + 8 <= 0x7FF else None)
                tx_s = f'0x{v:04X}'
                rx_s = f'0x{int(rx, 16):04X}' if rx is not None else None
                cs.append((tx_s, rx_s))
                if rx_s is not None:
                    rx_by_sys[sid][tx_s] = rx_s
                    rx_votes[tx_s].add(rx_s)
        cand_by_sys[sid] = sorted(set(cs))
        if e.get('tx') is not None and DIAG_LO <= int(e['tx'], 16) <= DIAG_HI:
            prov_tx_by_sys[e['sysId'].lower()] = int(e['tx'], 16)

    # ---- 981 模块 → sysIds / 旧代投票 + 全车型同系统跨代 sysId ----
    mod_sysids = {n: [s.lower() for s in (m.get('sysIds') or [])]
                  for n, m in sysids_doc.get('modules', {}).items()}
    mod_votes = sysids_doc.get('votes') or {}

    # 自动 DME 路由组：每代 owner=(g<<8)|0x0C 存在 → 注入 (g<<8)|0x01
    # 优先取 0x7E0-0x7EF 行（0x_0C 组的 DME 段），该代无 0x7Ex 行才退全量。
    family_route = {}
    for g in range(0x01, 0x17):
        owner = f'0x{(g << 8) | 0x0C:04x}'
        cans = route_by_owner.get(owner)
        if not cans:
            continue
        dme = f'0x{(g << 8) | 0x01:04x}'
        hi = {c for c in cans if 0x7E0 <= c <= 0x7EF} or cans
        family_route[dme] = (owner, sorted(hi))
    print(f'自动注入 DME 路由组（全代）：{len(family_route)} 个 → ' +
          ', '.join(f'{k}/{v[0]}' for k, v in sorted(family_route.items())))

    # v3 键的工具函数
    def v3_rows(sid):
        ent = (v3.get('ecu') or {}).get(sid) or {}
        return [r for b in ent.get('blocks', []) for r in b.get('rows', [])]

    def v3_keys_of(sid):
        """(直连键 set, 候选 set) —— 低16位 ∈ 诊断段。"""
        keys, cands = set(), set()
        for r in v3_rows(sid):
            bk = r.get('bindKey')
            if bk and DIAG_LO <= int(bk, 16) & 0xFFFF <= DIAG_HI:
                keys.add(int(bk, 16) & 0xFFFF)
            for c in (r.get('record') or {}).get('candidates') or []:
                v = int(c, 16) & 0xFFFF
                if DIAG_LO <= v <= DIAG_HI:
                    cands.add(v)
        return keys, cands

    def crossgen_cands_of(module, cur_sid):
        """S4：同系统跨代 sysId 的表A 候选 ∩ 路由表 can（精确交集，非近似 join）。

        跨代 sysId 来源：① 981 变体名投票旧代；② all-model-sysids.json 同名模块在
        其它平台的 sysId（全车型推广）；③ 名字前缀唯一命中（app.js aliasEntryFor 同构）。
        """
        cur_gen = int(cur_sid, 16) >> 8
        old_sys = set()
        for sid_s in (mod_votes.get(module) or {}):
            s = sid_s.lower()
            if (int(sid_s, 16) >> 8) != cur_gen and cand_by_sys.get(s):
                old_sys.add(s)
        for s in module_sids_all.get(module, ()):
            if (int(s, 16) >> 8) != cur_gen and cand_by_sys.get(s):
                old_sys.add(s)
        # 名字前缀规则（app.js aliasEntryFor 同构）：非当前代且唯一命中才用
        if not old_sys:
            norm = re.sub(r'[^A-Z0-9]', '', module.upper())
            hits = set()
            for sid, names in sys_to_mods.items():
                if (int(sid, 16) >> 8) == cur_gen:
                    continue
                for n in names:
                    nn = re.sub(r'[^A-Z0-9]', '', n.upper())
                    if len(nn) >= 4 and norm.startswith(nn) and cand_by_sys.get(sid):
                        hits.add(sid)
            if len(hits) == 1:
                old_sys = hits
            elif len(hits) > 1:
                # 全车型推广后前缀可能命中多个 sysId：按「表A候选∩路由表can 存活数」
                # 取并列 top 的全部（都是精确交集、证据等强；旧代同系统常共享同一候选集）。
                scored = [(len({int(t, 16) for t, _ in cand_by_sys.get(s, [])} & routing_all), s)
                          for s in hits]
                best = max((n for n, _ in scored), default=0)
                if best > 0:
                    old_sys = {s for n, s in scored if n == best}
        cands, prov = set(), []
        for s in sorted(old_sys):
            cs = {int(t, 16) for t, _ in cand_by_sys.get(s, [])}
            keep = cs & routing_all
            if keep:
                cands |= keep
                prov.append({'source': 'crossgen', 'oldSysId': s,
                             'note': f'表A候选∩路由表can（{len(keep)}/{len(cs)} 条存活）'})
        return cands, prov

    # ---- 目标 sysId 集：981 全 sysId + 全车型 high/medium 平台 sysId + 根表 22 type 的
    #      comm 子表 sysId（新代无 drivelinks-v3 键，也能按路由表建条目） ----
    target_sids = set()
    for sids in mod_sysids.values():
        target_sids.update(sids)
    for p, e in (all_sysids.get('platforms') or {}).items():
        if e.get('confidence') not in ('high', 'medium'):
            continue
        target_sids.update((m.get('sysId') or '').lower() for m in (e.get('modules') or {}).values())
    for t, e in (root_table.get('types') or {}).items():
        # 只补 0x10+ 新代（旧代 0x01-0x0F 已由 v3 键/表A 覆盖，避免无意义空条目膨胀）
        if e.get('genConsistent') and int(t, 16) >= 0x10:
            target_sids.update(s.lower() for s in e.get('sysIds') or [])
    target_sids.discard('')

    out, stats = {}, Counter()
    notes = {}

    def rx_for(sid, can):
        """rx 解析：同一 sysId 有实测值就用；否则仅在全局唯一时复用；绝不 &0x7FF 回绕。"""
        tx = f'0x{can:04X}'
        if rx_by_sys.get(sid, {}).get(tx):
            return rx_by_sys[sid][tx], 'tableA-same-sys'
        votes = rx_votes.get(tx, set())
        if len(votes) == 1:
            return next(iter(votes)), 'tableA-crossgen-unique'
        if len(votes) > 1:
            return None, 'ambiguous-tableA-rx'
        if can + 8 <= 0x7FF:
            return f'0x{can + 8:04X}', 'adapter-plus8-unproven'
        return None, 'rx-overflow-no-evidence'

    def add_entry(sid):
        sid = sid.lower()
        if sid in out:
            return
        rows = v3_rows(sid)
        modes = Counter((r.get('record') or {}).get('mode') for r in rows)
        mode = modes.most_common(1)[0][0] if modes and rows else None
        ns = [((r.get('record') or {}).get('n')) for r in rows]
        # n 是当前行 SpecArray 的候选数，不能跨行取最小值把 n>0 行吞成 n=0。
        n_value = ns[0] if ns and all(n == ns[0] for n in ns) else None
        n_mixed = bool(ns) and any(n != ns[0] for n in ns)

        gen = int(sid, 16) >> 8
        if gen >= 0x0E:
            # ===== 0x0E+ 代（含 0x10-0x16 新代）：多源分级（全车型推广） =====
            src_map = defaultdict(set)   # can -> 源名集合
            def mark(cans, name):
                for c in cans:
                    if DIAG_LO <= c <= DIAG_HI:
                        src_map[c].add(name)
            keys, vc = v3_keys_of(sid)
            mark(keys, 'v3key')
            # S3：候选低半字节 ≥8 视为 rx → tx=c-8；否则 tx=c
            rx_cands = {c for c in vc if (c & 0xF) >= 8 and DIAG_LO <= c - 8}
            tx_cands = vc - rx_cands
            mark(tx_cands, 'v3cand')
            mark({c - 8 for c in rx_cands}, 'v3candRx')
            # S1：owner==sysId 的路由行
            own = route_by_owner.get(sid)
            if own:
                mark(own, 'routing')
            # S0：家族路由组（DME）——全代自动注入，无需车型特判
            fg = family_route.get(sid)
            if fg:
                gowner, gc = fg[0], set(fg[1])
                if gc:
                    mark(gc, 'routeGroup')

            # S4'：跨代已证 tx（同系统跨代 sysId 的表A proven tx 落在 tierA 内 → 加权）
            for m in sys_to_mods.get(sid, []):
                for sid_s in list((mod_votes.get(m) or {}).keys()) + list(module_sids_all.get(m, set())):
                    s = sid_s.lower()
                    if (int(sid_s, 16) >> 8) != gen:
                        pt = prov_tx_by_sys.get(s)
                        if pt is not None:
                            mark({pt}, 'crossgenProven')

            tierA = {c for c, ss in src_map.items()
                     if ss & {'v3key', 'v3cand', 'v3candRx', 'routing', 'routeGroup', 'crossgenProven'}}
            prov = []
            if tierA:
                for c in sorted(tierA):
                    prov.append({'can': f'0x{c:04X}', 'sources': sorted(src_map[c])})
                # 收敛序：源数降序、地址升序（DME 0x7E0：v3candRx+crossgenProven 双源 → 第一）
                ordered = sorted(tierA, key=lambda c: (-len(src_map[c]), c))[:20]
                stats['tierA'] += 1
            else:
                # S4 跨代
                mods = sys_to_mods.get(sid, [])
                cands, prov = set(), []
                for m in mods:
                    cs, p = crossgen_cands_of(m, sid)
                    cands |= cs
                    prov += p
                if cands:
                    pt = {prov_tx_by_sys[s] for s in cand_by_sys
                          if prov_tx_by_sys.get(s) in cands}
                    ordered = sorted(cands, key=lambda c: (c not in pt, c))[:16]
                    prov = [{'can': f'0x{c:04X}', 'sources': ['crossgen']} for c in ordered]
                    stats['crossgen'] += 1
                    if sid == '0x0e13':
                        notes[sid] = ('PASM 无静态直达（0x13 家族任何代无路由 owner 行，数据事实）：'
                                      '候选=0x0b13 表A(表A精确 join 结果) ∩ 路由表 can；'
                                      '0x7D0 由跨代 owner 0x0C05/0x0C02 行确证（非锚点补录）')
                else:
                    ordered = []
                    stats['enumeration'] += 1
                    prov = [{'note': '无静态候选（tierA/跨代皆空）→ app.js 枚举兜底（live-map）'}]
        else:
            # ===== 旧代（0x0B/0x0C…）：原逻辑不变（表A join 候选） =====
            ordered = [int(t, 16) for t, _ in cand_by_sys.get(sid, [])]
            stats['legacy'] += 1
            prov = [{'source': 'tableA', 'note': '表A 精确 join 候选（旧代路径保留）'}]

        pairs, rejected_pairs = [], []
        for c in ordered:
            tx_s = f'0x{c:04X}'
            # 路由表/表A 的 can 值是 12 位空间，出现过 0x800+；0x7F8-0x7FF 是 11 位应答段。
            # 这两类都不能当请求地址：发 ATSH 会绑到别的 ECU 或直接非法。
            if c > REQ_HI:
                rejected_pairs.append({
                    'tx': tx_s, 'rx': None,
                    'reason': 'tx-in-response-range' if c <= DIAG_HI else 'tx-not-11bit-request',
                    'source': 'address-table',
                })
                stats['rxRejected'] += 1
                continue
            rx, rx_source = rx_for(sid, c)
            if rx is None:
                rejected_pairs.append({'tx': tx_s, 'rx': None, 'reason': rx_source})
                stats['rxDropped'] += 1
                continue
            rx_v = int(rx, 16)
            # 11 位请求 tx 的应答必须仍在 11 位内；超出的原始记录只留证，不发 ATCRA。
            if rx_v > 0x7FF:
                rejected_pairs.append({'tx': tx_s, 'rx': rx, 'reason': 'rx-not-valid-for-11bit', 'source': rx_source})
                stats['rxRejected'] += 1
                continue
            pairs.append((tx_s, rx))
            stats['rxPreserved' if rx_source.startswith('tableA') else 'rxDefaultPlus8'] += 1
        # 只有「全部相关行均 n=0 + 唯一合法地址」才允许免探针直绑。
        # n=0 多候选或混合 n 必须继续探测/枚举，不能拿首项冒充唯一地址。
        bind_direct = bool(rows) and not n_mixed and n_value == 0 and len(pairs) == 1
        rec = {
            'mode': f'0x{mode:04x}' if mode is not None else None,
            'n': n_value,
            'nMixed': n_mixed,
            'bindDirect': bind_direct,
            'cands': [t for t, _ in pairs],
            'pairs': [{'tx': t, 'rx': r} for t, r in pairs],
            'firstRead': (first_read_of(sid) or {}).get('frame'),
        }
        if rejected_pairs:
            rec['rejectedPairs'] = rejected_pairs
        if rows and not n_mixed and n_value == 0 and len(pairs) != 1:
            rec['bindUnresolved'] = 'n=0 但合法地址不唯一，禁止首候选直绑；继续探测/枚举'
        if prov:
            rec['provenance'] = prov
        if sid in notes:
            rec['note'] = notes[sid]
        if not rec['cands']:
            stats['noCand'] += 1
        out[sid] = rec

    # 旧代：v3 全键（保持原输出域 —— test-align431 对账 0x0b08/0x0b12/0x0b13 等）
    for sid, ent in (v3.get('ecu') or {}).items():
        rows = [r for b in ent.get('blocks', []) for r in b.get('rows', [])]
        if rows:
            add_entry(sid)
    # 全车型 sysId（含 0x10-0x16 新代：comm 子表目录，v3 无键也建条目）
    for sid in sorted(target_sids):
        add_entry(sid)

    def cand_of(s):
        return [int(c, 16) for c in out.get(s, {}).get('cands') or []]

    # 全车型静态覆盖统计（按平台）
    coverage = {}
    for p, e in sorted((all_sysids.get('platforms') or {}).items()):
        mods = e.get('modules') or {}
        if not mods:
            coverage[p] = {'modules': 0, 'static': 0, 'gen': e.get('gen'), 'confidence': e.get('confidence')}
            continue
        st = sum(1 for m in mods.values() if cand_of((m.get('sysId') or '').lower()))
        coverage[p] = {'modules': len(mods), 'static': st, 'gen': e.get('gen'),
                       'confidence': e.get('confidence')}

    doc = {
        'schemaVersion': 3,
        'source': ('drivelinks-v3 + sysdata-routing(路由表/根表22type) + all-model-sysids(全车型换表) '
                   '+ ecu-addresses(表A/跨代) + coding-v2(首参数/族)'),
        'rule': ('全车型多源分级：gen=sysId>>8，gen≥0x0E 走 tierA = v3直连键(bindKey低16位=CAN) '
                 '∪ v3候选(rx→tx=rx-8) ∪ 路由表(owner==sysId) ∪ DME路由组(每代自动注入 0x_0C)；'
                 'tierA 空→同系统跨代表A候选∩路由表can（精确交集）；再空→枚举兜底。'
                 'n 逐行保留，混合 n 不合并；bindDirect 仅在全行 n=0 且唯一合法地址时成立。'
                 'rx 只有一条规则：11 位请求 tx≤0x7F7 → rx=tx+8；'
                 'tx 落在 0x7F8-0x7FF（应答段）、tx 或 rx 超出 11 位（路由表 12 位空间）'
                 '一律进 rejectedPairs，绝不 &0x7FF 回绕、绝不发 ATCRA。'),
        'stats': dict(stats),
        'coverage': coverage,
        'ecu': dict(sorted(out.items())),
    }
    # 硬门禁：任何错误直绑、候选/pair 不一致或协议非法 rx 都不许落盘。
    problems = []
    for sid, rec in out.items():
        pairs = rec.get('pairs') or []
        if rec.get('bindDirect') and len(pairs) != 1:
            problems.append(f'{sid}: bindDirect 但 pairs={len(pairs)}')
        if rec.get('nMixed') and rec.get('bindDirect'):
            problems.append(f'{sid}: 混合 n 却 bindDirect')
        if (rec.get('cands') or []) != [p['tx'] for p in pairs]:
            problems.append(f'{sid}: cands 与 pairs.tx 不一致')
        for p in pairs:
            tx, rx = int(p['tx'], 16), int(p['rx'], 16)
            if not ((tx <= 0x7FF and rx <= 0x7FF) or (tx > 0x7FF and rx <= 0x1FFFFFFF)):
                problems.append(f"{sid}: 协议非法 pair {p['tx']}→{p['rx']}")
    if problems:
        raise SystemExit('bind-plan 硬门禁失败：\n  ' + '\n  '.join(problems[:20]))

    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print('写出', OUT.relative_to(ROOT), f'{OUT.stat().st_size / 1024:.0f}KB')
    print('sysId', len(out), dict(stats))

    # ---- 验收自检（981 五项 + 全车型覆盖） ----
    checks = []
    dme = cand_of('0x0e01')
    checks.append(('DME=0x7E0', 0x7E0 in dme))
    pasm = cand_of('0x0e13')
    checks.append(('PASM 含 0x7D0（跨代路由行，非锚点）', 0x7D0 in pasm))
    ic, psm = cand_of('0x0e08'), cand_of('0x0e05')
    checks.append(('IC=0x7F1', 0x7F1 in ic))
    checks.append(('IC 与 PSM 可区分（集合无交集）', not (set(ic) & set(psm))))
    # 48 模块静态解出数（模块任一 sysId 有候选即算）
    resolved = [n for n, sids in mod_sysids.items() if any(cand_of(s) for s in sids)]
    checks.append((f'≥40/48 静态解出（实际 {len(resolved)}/48）', len(resolved) >= 40))
    for name, okk in checks:
        print(('  ✅' if okk else '  ❌'), name)
    if not all(okk for _, okk in checks):
        raise SystemExit('验收自检失败')
    print('  未静态解出（981）：', sorted(set(mod_sysids) - set(resolved)))
    print('\n全车型静态覆盖（bind-plan 按平台）：')
    for p, c in coverage.items():
        if c['modules']:
            print(f"  {p:8s} gen={str(c['gen']):6s} conf={c['confidence']:10s} "
                  f"静态 {c['static']:3d}/{c['modules']:3d} 模块")
    tot_m = sum(c['modules'] for c in coverage.values())
    tot_s = sum(c['static'] for c in coverage.values())
    print(f'  合计 {tot_s}/{tot_m}（{tot_s / tot_m * 100:.1f}%）')


if __name__ == '__main__':
    main()
