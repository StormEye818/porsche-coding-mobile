#!/usr/bin/env python3
"""export-bind-plan.py — 多源「进模块绑定计划」生成器（T02 全代真值注入版）。

证据口径（docs/evidence/431-linkmap-20261120.md E-06/E-10/E-11/E-18 与
docs/evidence/431-static-allmodels-20261120.md E11/§7）：
  · CAN 空间只来自 PORSCHE_SYS_DATA.BIN comm cat=0x10 记录的 A>>5 / C>>5，
    或 SYS_DATA 16B 路由记录的 u32 can 字段（均为 11 位诊断CAN）。
  · 请求键空间 0x0030xxxx / 0xFF60xxxx（DRIVELINKS bindKey = flags<<16|internal）
    与路由 internal（16B 记录 m 字段）都**不是 CAN**。旧版把 bindKey/record.candidates
    低 16 位当 CAN 候选（v3key / v3cand / v3candRx）的路径已全部删除；
    请求键只写入 requestKeys 字段，作进模块绑定入参（E-06/E-18/E-20）。
  · rx 优先取同一条 cat=0x10 记录的 C>>5 原值；没有任何记录时才按
    tx<=0x7F7 → tx+8 派生；不做 &0x7FF 回绕，不把 +0x6A 全局常量化（E-11/E-12）。

多源分级（tierA 优先，空则降级，每条候选带 provenance/e0Coord/provable）：
  S1 routing    sysdata-routing owner==sysId 的 can（u32 can 字段，非 internal）
  S0 routeGroup DME 家族路由组 owner（0x_0C，限 0x7E0-0x7EF）
  S4 crossgen   旧代 sysId 的表A 候选 ∩ 路由表 can（精确交集）
  S5 commCat10  ★本版起对**所有**有 cat=0x10 真值的代生效（不再限 gen>=0x14）：
                本 sysId 的本代 tx/rx 作为首选候选插入，rx=记录 C 原值；
                gen<0x14 的 172 个此前缺失 sysId 由此补齐（172→0）。
  tierA 空 → S4 → 按代完整 cat=0x10 地址表 family-default → 空（fail-closed）。
  全部候选仍需探针验证，绝不免探针直绑（E-01）。

输出 data/bind-plan.json（键=sysId 小写）：每条带 provable='static'、e0Coord、
requestKeys（请求键空间）、blockOff（DRIVELINKS addrBlock）、truth（本代 cat10 真值）。
0x0f4d 另带四元对象 fourTuple：sysId/sysName/requestKey/can/altIdentitySysIds/identityRule；
0x0e5f/0x0e60 是异名同功能 sysId，禁止按 raw 相同合并身份（E-14）。

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
COMM = ROOT / 'data' / 'sysdata-comm.json'
COMM_ADDR = ROOT / 'data' / 'comm-addr-table.json'
SYSIDS = ROOT / 'data' / '981-sysids.json'
ALL_SYSIDS = ROOT / 'data' / 'all-model-sysids.json'
# ★ 2026-11-12 全量收口：变体文件实际用到的 sysId 全集（tools/export-variant-sysids.mjs）。
#   此前 target_sids 只来自 981/全车型平台/根表，漏了 126 个会被 sysIdForModule 解析到、
#   却没有 bind-plan 条目的 sysId —— 进模块只能靠枚举兜底，是全链路真实断点。
VARIANT_SYSIDS = ROOT / 'data' / 'variant-sysids.json'
OUT = ROOT / 'data' / 'bind-plan.json'
MODELS = ROOT / 'data' / 'models'

DIAG_LO, DIAG_HI = 0x600, 0x7FF
# 11 位诊断**请求**段：0x7F8-0x7FF 是应答段（tx+8 必然溢出），不能当请求地址发 ATSH。
REQ_HI = 0x7F7
# 0x0f4d 直连请求键（DRIVELINKS addrBlock @0x1148a 前 4 行，E11/E-14 证据定值）；
# 同一 block 还有 0x00300317 等其它行，不能混进四元对象的 requestKey。
FOUR_TUPLE_REQUEST_KEYS = (0x06CC, 0x06CD, 0x06CE, 0x06CF)

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


def hx(value: int) -> str:
    """稳定 4 位十六进制字符串（大写前缀小写 x，逐字节可复现）。"""
    return f'0x{value:04X}'


def rx_rule_of(tx: int, rx: int) -> str:
    """按记录 (A>>5, C>>5) 的差值命名 rx 规则，绝不改写原厂值。"""
    delta = rx - tx
    if delta == 0x6A:
        return 'rx=tx+0x6A'
    if delta == 0x100:
        return 'rx=tx+0x100'
    if delta == 8:
        return 'rx=tx+8'
    if delta == 16:
        return 'rx=tx+0x10'
    if delta == 32:
        return 'rx=tx+0x20'
    if delta == 0:
        return 'rx=tx'
    if delta < 0:
        return 'rx<tx(非11位请求段的应答回绕/旧代编码)'
    return f'rx=tx+0x{delta:X}'


def model_items_signature(directory: str, filename: str) -> tuple:
    """变体文件 items 的 (module,lid,readSid) 序列签名（E07 可复核命令同构）。"""
    payload = json.loads((MODELS / directory / filename).read_text(encoding='utf-8'))
    return tuple((i.get('module'), i.get('lid'), i.get('readSid')) for i in payload.get('items') or [])


def dataset_merge_policy():
    """车型数据集共用判据：文件集全等 + 每个同名文件 items 签名全等才允许合并。

    E06：431 的 JOB.BIN 只合并变体名（Cayman_ 出现 0 次）；E07：981/982/987 的
    Boxster/Cayman 文件集与签名实测全等。986 vs 987 是不同平台，作为反例一并落盘。
    """
    pairs = [
        ('Boxster_981_', 'Cayman_981_'),
        ('Boxster_982_', 'Cayman_982_'),
        ('Boxster_987_', 'Cayman_987_'),
        ('Boxster_986_', 'Cayman_987_'),
    ]
    report = {}
    for left, right in pairs:
        left_dir, right_dir = MODELS / left, MODELS / right
        if not left_dir.is_dir() or not right_dir.is_dir():
            raise SystemExit(f'车型数据集缺失，禁止合并判定：{left} / {right}')
        left_files = sorted(f.name for f in left_dir.glob('*.json'))
        right_files = sorted(f.name for f in right_dir.glob('*.json'))
        only_left = sorted(set(left_files) - set(right_files))
        only_right = sorted(set(right_files) - set(left_files))
        shared = sorted(set(left_files) & set(right_files))
        sig_diff = sorted(f for f in shared
                          if model_items_signature(left, f) != model_items_signature(right, f))
        file_set_equal = not only_left and not only_right
        signature_equal = file_set_equal and not sig_diff
        report[f'{left}|{right}'] = {
            'leftFiles': len(left_files),
            'rightFiles': len(right_files),
            'onlyLeft': len(only_left),
            'onlyRight': len(only_right),
            'signatureDiff': len(sig_diff),
            'fileSetEqual': file_set_equal,
            'signatureEqual': signature_equal,
            'allowed': signature_equal,
            'e0Coord': 'docs/evidence/431-static-allmodels-20261120.md#E07',
            'provable': 'static',
        }
    return report


def main():
    v3 = json.loads(V3.read_text())
    addr = json.loads(ADDR.read_text())
    coding = json.loads(CODING.read_text())
    routing = json.loads(ROUTING.read_text())
    root_table = json.loads(ROOT_TABLE.read_text())
    comm_doc = json.loads(COMM.read_text())
    comm_addr_doc = json.loads(COMM_ADDR.read_text()) if COMM_ADDR.exists() else {}
    # 有 cat=0x10 静态地址表的代（走完整的按代地址表路径，绝不套路由兜底）
    gens_with_cat10 = {str(k).replace('0x', '').replace('0X', '').upper()
                       for k in (comm_addr_doc.get('byGeneration') or {})}
    sysids_doc = json.loads(SYSIDS.read_text())
    all_sysids = json.loads(ALL_SYSIDS.read_text())
    variant_sysids = json.loads(VARIANT_SYSIDS.read_text()) if VARIANT_SYSIDS.exists() else {'sysIds': []}

    # ---- 新代 0x14-0x16 的本代地址证据（2026-11-12 复核推翻「路由 owner 0 行=无地址」） ----
    # SYS_DATA comm cat=0x10 子表内嵌 (A,C) 地址对，解出 tx/rx 全部是合法 11 位，
    # 且与实车锚点一致（0x1401 DME → 0x7E0/0x7E8、0x1409 网关 → 0x710/0x77A）。
    # 此前这些 sysId 的候选全部来自「旧代表A ∩ 路由表」跨代平移（同 16 项、命中率 0）。
    # 只作**首选候选**插入，保留既有候选回退，不设免探针直绑（地址仍由探针验证）。
    # 981 等 gen<0x14 的条目完全不动。
    # ★ T02：对**所有代**（不只 gen>=0x14）注入 cat=0x10 本代真值。
    #   tx=A>>5 / rx=C>>5 从记录 raw 独立复算：raw='0x'+A(4hex)+C(4hex)。
    #   同一 sysId 可有多条记录（如 0x0b57 两条），逐条保留，rx 用 C 原值。
    comm_pairs = {}
    truth_by_sid = {}
    truth_rule_by_sid = {}
    truth_coord_by_sid = {}
    for sid, e in (comm_doc.get('ecu') or {}).items():
        for blk in e.get('blocks') or []:
            if blk.get('cat') != 0x10:
                continue
            coord = f"PORSCHE_SYS_DATA.BIN:{blk.get('commOff') or 'unknown'}"
            for s in blk.get('subs') or []:
                tx, rx, raw = s.get('tx'), s.get('rx'), s.get('raw') or ''
                if len(raw) == 10:
                    raw_tx = int(raw[2:6], 16) >> 5
                    raw_rx = int(raw[6:10], 16) >> 5
                    if (raw_tx, raw_rx) != (tx, rx):
                        raise SystemExit(f'{sid} {coord}: raw A/C 与 tx/rx 不一致 '
                                         f'({raw} → {hx(raw_tx)}/{hx(raw_rx)} vs {tx}/{rx})')
                if isinstance(tx, int) and isinstance(rx, int) and 0 < tx <= REQ_HI and 0 < rx <= 0x7FF:
                    key = sid.lower()
                    comm_pairs.setdefault(key, {})[tx] = rx
                    truth_by_sid.setdefault(key, set()).add((tx, rx, rx_rule_of(tx, rx)))
                    truth_rule_by_sid.setdefault(key, {})[tx] = rx_rule_of(tx, rx)
                    truth_coord_by_sid.setdefault(key, {})[tx] = coord

    def family_default_pairs(sid):
        """按代输出「完整」cat=0x10 地址表（静态分派规则，非逐 sysId 唯一地址）。

        有些 ECU 的 comm 子表只有 cat=0x60 固定 4 帧模板，subs 里的 0x020-0x02D 是
        索引而非 CAN 地址。参考诊断仪静态做法本身不产生逐 sysId 唯一地址表：按代取该代
        **完整** cat=0x10 地址表作为候选循环（每候选 1 帧 22 14 09）+ 应答即绑，
        provenance 标 commCat10-addressTable + oemProbeSequence（四帧模板 185/185）。
        ★ 2026-11-13 收口：删除 16 项截断（此前把 90 个 16 候选组截成 16 条），
        并按 data/comm-addr-table.json 的 byGeneration[gen].addresses[] 附 ownerSysId
        与 rx 校验；不设免探针直绑。
        """
        gen = int(sid, 16) >> 8
        merged = {}
        # ① 完整静态地址表（comm-addr-table.json 由 build-comm-addr-table.mjs 产出）
        by_gen = comm_addr_doc.get('byGeneration') or {}
        gen_key = f'0x{gen:02X}'
        for row in (by_gen.get(gen_key) or {}).get('addresses') or []:
            tx, rx = int(row['tx'], 16), int(row['rx'], 16)
            if 0 < tx <= REQ_HI and 0 < rx <= 0x7FF:
                merged.setdefault(tx, {'rx': rx, 'ownerSysId': row.get('ownerSysId')})
        # ② 兼容回退：直接从 sysdata-comm.json 的 cat=0x10 子表按代聚合
        for k, pairs in comm_pairs.items():
            if (int(k, 16) >> 8) != gen:
                continue
            for tx, rx in pairs.items():
                if tx not in merged:
                    merged[tx] = {'rx': rx, 'ownerSysId': k}
        # 完整表，不截断；rx 统一为整数值（原厂记录自带，绝不改写）
        return {tx: int(info['rx']) for tx, info in sorted(merged.items())}, {
            tx: info.get('ownerSysId') or f'gen{gen_key}' for tx, info in sorted(merged.items())
        }

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

    def v3_request_keys_of(sid):
        """请求键全集（0x0030xxxx / 0xFF60xxxx）——只作绑定入参，绝不下降为 CAN。"""
        keys = set()
        for r in v3_rows(sid):
            bk = r.get('bindKey')
            if bk:
                keys.add(f'0x{int(bk, 16):08X}')
            internal = r.get('internal')
            flags = r.get('flags')
            if internal and flags:
                keys.add(f'0x{(int(flags, 16) << 16) | int(internal, 16):08X}')
        return sorted(keys)

    def v3_fake_can_low16(sid):
        """旧版 v3key/v3cand 曾误当 CAN 的请求键低 16 位——只作反例标注，绝不进 cands。"""
        vals = set()
        for r in v3_rows(sid):
            candidates = [r.get('bindKey')] + list((r.get('record') or {}).get('candidates') or [])
            for value in candidates:
                if value:
                    v = int(value, 16) & 0xFFFF
                    if DIAG_LO <= v <= DIAG_HI:
                        vals.add(v)
        return vals

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
    # ★ 全量收口：纳入变体文件实际解析到的 sysId（4588 变体 / 445 个 sysId）。
    #   其中 126 个此前没有条目，补源见 add_entry 的 commCat10Exact / commFamilyDefault。
    target_sids.update(s.lower() for s in variant_sysids.get('sysIds') or [])
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
        req_keys = v3_request_keys_of(sid)
        if gen >= 0x0E:
            # ===== 0x0E+ 代（含 0x10-0x16 新代）：多源分级（全车型推广） =====
            src_map = defaultdict(set)   # can -> 源名集合
            def mark(cans, name):
                for c in cans:
                    if DIAG_LO <= c <= DIAG_HI:
                        src_map[c].add(name)
            # ★ T02：v3key / v3cand / v3candRx 三条「请求键低16位=CAN」路径全删。
            #   DRIVELINKS bindKey/internal 只写入 requestKeys 作绑定入参（E-06/E-18）。
            # S1：owner==sysId 的路由行（u32 can 字段，不是 routing internal）
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
                     if ss & {'routing', 'routeGroup', 'crossgenProven'}}
            prov = []
            if tierA:
                for c in sorted(tierA):
                    # 独立 provenance：tierA 路径的输出不计入 120 条错配分母、
                    # 也不计入 402/527 分母（团队规格增量 2）。
                    prov.append({'can': f'0x{c:04X}', 'sources': sorted(src_map[c]),
                                 'provenance': 'tierA'})
                # 收敛序：源数降序、地址升序；★ 删除 20 项截断（输出完整候选集）
                ordered = sorted(tierA, key=lambda c: (-len(src_map[c]), c))
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
                    # ★ 删除 16 项截断（输出完整跨代候选集）
                    ordered = sorted(cands, key=lambda c: (c not in pt, c))
                    # 独立 provenance：crossgen 路径的输出不计入 120 条错配分母、
                    # 也不计入 402/527 分母（团队规格增量 2）。
                    prov = [{'can': f'0x{c:04X}', 'sources': ['crossgen'],
                             'provenance': 'crossgen'} for c in ordered]
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
            # ===== 旧代（0x0B/0x0C…）：表A join 候选 =====
            ordered = [int(t, 16) for t, _ in cand_by_sys.get(sid, [])]
            stats['legacy'] += 1
            prov = [{'source': 'tableA', 'note': '表A 精确 join 候选（旧代路径保留）'}]
            # ★ 2026-11-13 HB-1 收口附带：9X6（gen 0x01）等老代平台启用后，
            #   部分 sysId 在表A 无候选、也没有 cat=0x10 地址表；此时取「同代
            #   sysdata-routing.json byOwner 的 can 全集」作为包内静态候选集
            #   （参考诊断仪做法 = 候选循环 + 应答即绑，不是逐 sysId 唯一地址表）。
            #   独立 provenance=genRoutingStaticTable，不计入 120 条错配分母，
            #   也不计入 402/527 分母（团队规格增量 2 的分母纪律）。
            gen_old = int(sid, 16) >> 8
            gen_hex = f'{gen_old:02X}'
            if not ordered and gen_hex not in gens_with_cat10:
                gen_cans = set()
                for own, cans in route_by_owner.items():
                    if (int(own, 16) >> 8) == gen_old:
                        # route_by_owner 的值是 {int(can,16)} 集合（见本文件解析处）
                        for c in cans:
                            if DIAG_LO <= c <= REQ_HI:
                                gen_cans.add(c)
                if gen_cans:
                    ordered = sorted(gen_cans)
                    prov = ([{'can': f'0x{c:04X}', 'rx': f'0x{c + 8:04X}',
                              'sources': ['genRoutingStaticTable'],
                              'provenance': 'genRoutingStaticTable',
                              'note': (f'代 0x{gen_old:02X} 无 cat=0x10 地址表；'
                                       '候选=同代 SYS_DATA 路由表 byOwner 的 can 全集（包内静态字节）；'
                                       '每候选 1 帧 + 应答即绑；不设免探针直绑')}
                             for c in ordered])
                    stats['genRoutingStaticTable'] += 1

        # ★ T02 全代真值注入：对所有有 cat=0x10 记录的 sysId（不只 0x14+），
        #   把本代 tx/rx 作为**首选候选**插入；rx 一律取记录 C>>5 原值。
        #   gen<0x14 的 172 个此前缺真值候选 sysId 由此归零（172→0）。
        gen_here = int(sid, 16) >> 8
        truth_rows = sorted(truth_by_sid.get(sid, set()))
        cp = comm_pairs.get(sid) or {}
        if gen_here < 0x14 and truth_rows and not ({t for t, _, _ in truth_rows} & set(ordered)):
            stats['rawTruthMissingBeforeInjection'] += 1
        if cp:
            ordered = [c for c in sorted(cp) if c not in ordered] + ordered
            prov = ([{'can': hx(c), 'rx': hx(cp[c]),
                      'rxRule': truth_rule_by_sid[sid][c],
                      'sources': ['commCat10'], 'provenance': 'commCat10',
                      'provable': 'static',
                      'e0Coord': truth_coord_by_sid[sid][c],
                      'note': 'SYS_DATA comm cat=0x10 本代真值（A>>5/C>>5，rx 取记录 C 原值）'}
                     for c in sorted(cp)] + prov)
            stats['commCat10'] += 1
        if gen_here < 0x14 and truth_rows and ({t for t, _, _ in truth_rows} & set(ordered)):
            stats['genBelow14TruthPresentAfter'] += 1

        # ★ 2026-11-13 HB-2 收口：变体实际用到、但 tierA/跨代/表A 全空的 sysId 不留 0 候选。
        #   ① 本 ECU 的 comm cat=0x10 子表带地址对 → 直接用（完整，不截断）；
        #   ② 只有 cat=0x60 固定 4 帧模板（subs 是 0x020-0x02D 索引，非 CAN 地址）
        #      → 按代取「完整」cat=0x10 静态地址表 + ownerSysId + rx 校验，
        #        provenance = commCat10-addressTable + oemProbeSequence（185/185 四帧）。
        #   参考诊断仪静态做法 = 候选循环（每候选 1 帧 22 14 09）+ 应答即绑，本就不产生
        #   逐 sysId 唯一地址表；「120 条错配」指此前把同代它 ECU 地址表截断后错配，
        #   现改为完整的按代静态分派规则。两者都只作候选；bindDirect 仍由 n=0 +
        #   唯一合法地址决定，绝不免探针直绑。
        # ordered 非空但**全落在应答段/超 11 位**时，最终 pairs 仍是空
        # （例 0x050c 表A 只给 0x7FD），同样要补，否则留一个 0 候选断点。
        newly_sourced = False
        if (not ordered or all(c > REQ_HI for c in ordered)) and not truth_rows:
            newly_sourced = True
            ordered = [c for c in ordered if c <= REQ_HI]
            exact = comm_pairs.get(sid)
            if exact:
                cp = exact
                ordered = sorted(exact)                 # ★ 完整输出，16 项截断已移除
                prov = ([{'can': f'0x{c:04X}', 'rx': f'0x{exact[c]:04X}',
                          'sources': ['commCat10Exact'],
                          'note': 'SYS_DATA comm cat=0x10 本 ECU 地址对（补全变体链路断点）'}
                         for c in ordered] + prov)
                stats['commCat10Exact'] += 1
            else:
                fam, fam_owner = family_default_pairs(sid)
                if fam:
                    cp = fam
                    ordered = sorted(fam)               # ★ 完整输出，16 项截断已移除
                    gen_key = f'0x{(int(sid, 16) >> 8):02X}'
                    # 旧版只有 v3key/v3cand 伪候选的 sysId，删除伪候选后按代静态表兜底；
                    # 单列 provenance，避免把 120 条 family-default 分母虚增为 123。
                    only_fake_before = bool(v3_fake_can_low16(sid)) and not truth_rows
                    fam_tag = ('commCat10-addressTable-fallback' if only_fake_before
                               else 'commCat10-family-default')
                    why = ('旧版仅有请求键低16位伪 CAN 候选（v3key/v3cand），已删除；'
                           '现按代取完整 cat=0x10 静态地址表' if only_fake_before
                           else '本 ECU comm 仅 cat=0x60 固定四帧模板（subs 为索引非 CAN 地址）')
                    prov = ([{'can': f'0x{c:04X}', 'rx': f'0x{fam[c]:04X}',
                              'ownerSysId': fam_owner.get(c),
                              'sources': [fam_tag],
                              'provenance': (
                                  f'commCat10-addressTable(gen静态地址表={gen_key},'
                                  f'ownerSysId={fam_owner.get(c)})+'
                                  'oemProbeSequence(3E00/22F19E/22F1A2/1003,185/185逐字节一致)'),
                              'note': (why + '；'
                                       f'静态来源规则=代 {gen_key} → 该代完整 cat=0x10 地址表 → '
                                       '候选探测（每候选 1 帧 221409 + 应答即绑）；'
                                       '非按车型唯一地址，由 oemProbeSequence 四帧模板逐字节一致支撑')}
                             for c in ordered] + prov)
                    if not only_fake_before:
                        stats['commFamilyDefault'] += 1
                    else:
                        stats['fakeKeyFallbackRelabelled'] += 1

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
            # 本代 comm 记录自带 rx（A/C 编码），优先于「tx+8」默认推导。
            cp_rx = (cp or {}).get(c)
            if cp_rx is not None:
                rx = f'0x{cp_rx:04X}'
                rx_source = ('commCat10' if c in truth_rule_by_sid.get(sid, {})
                             else 'commCat10-family-default')
            else:
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
            if rx_source == 'commCat10':
                pair_rule = truth_rule_by_sid[sid][c]
                stats['rxFromRecordC'] += 1
            elif rx_source.startswith('tableA') or rx_source == 'commCat10-family-default':
                pair_rule = rx_rule_of(c, int(rx, 16))
                stats['rxPreserved'] += 1
            else:
                pair_rule = 'rx=tx+8(fallback-no-cat10-record)'
                stats['rxDefaultPlus8'] += 1
            pairs.append((tx_s, rx, pair_rule, rx_source))
        # 只有「全部相关行均 n=0 + 唯一合法地址」才允许免探针直绑。
        # n=0 多候选或混合 n 必须继续探测/枚举，不能拿首项冒充唯一地址。
        # ★ 新增补源（本 ECU comm 地址对 / 按代完整静态地址表）一律禁止免探针直绑：
        #   参考诊断仪做法是「候选循环 + 应答即绑」，静态地址表是候选集而非逐 sysId
        #   唯一实测地址；n=0 也不能拿首项冒充唯一地址。
        bind_direct = bool(rows) and not n_mixed and n_value == 0 and len(pairs) == 1 \
            and not newly_sourced
        # 每条候选带 provable + E0 坐标；请求键只作绑定入参，绝不写进 cands。
        default_coord = (truth_coord_by_sid.get(sid) or {}).get(
            min(cp) if cp else -1, f'data/drivelinks-v3.json#{sid}')
        for item in prov:
            item.setdefault('provable', 'static')
            item.setdefault('e0Coord', default_coord)
        blocks_here = v3.get('ecu', {}).get(sid, {}).get('blocks', []) or []
        block_offs = sorted({int(b.get('addrBlock', -1)) for b in blocks_here if b.get('addrBlock') is not None})
        block_keys = sorted({str(b.get('blockKey')) for b in blocks_here if b.get('blockKey')})
        rec = {
            'mode': f'0x{mode:04x}' if mode is not None else None,
            'n': n_value,
            'nMixed': n_mixed,
            'bindDirect': bind_direct,
            'cands': [p[0] for p in pairs],
            'pairs': [{'tx': t, 'rx': r, 'rxRule': rule, 'rxSource': src,
                       'provable': 'static' if src == 'commCat10' else 'derived'}
                      for t, r, rule, src in pairs],
            'firstRead': (first_read_of(sid) or {}).get('frame'),
            'provable': 'static',
            'e0Coord': default_coord,
            'requestKeys': req_keys,
            'blockOff': block_offs,
            'blockKeys': block_keys,
            'truth': [{'tx': hx(t), 'rx': hx(r), 'rxRule': rule, 'provable': 'static',
                       'e0Coord': truth_coord_by_sid[sid].get(t, default_coord)}
                      for t, r, rule in truth_rows],
        }
        # 0x0f4d 四元对象：sysId + 请求键 + CAN 真值 + 异名同功能 sysId；
        # 0x0e5f 与 0x0f4d 的 raw 相同但名字不同，禁止合并（E-14 / E11）。
        if sid == '0x0f4d':
            four_keys = [k for k in FOUR_TUPLE_REQUEST_KEYS if f'0x{(0x0030 << 16) | k:08X}' in req_keys]
            if four_keys != list(FOUR_TUPLE_REQUEST_KEYS):
                raise SystemExit('0x0f4d 四元对象请求键缺失（证据 E11 应为 0x06CC..0x06CF）')
            truth_074e = next((t for t in truth_rows if t[0] == 0x74E), (0x74E, 0x7B8, 'rx=tx+0x6A'))
            four = {
                'sysId': '0x0f4d',
                'sysName': 'SWA2_BaseSys',
                'requestKey': four_keys,
                'can': {'tx': truth_074e[0], 'rx': truth_074e[1],
                        'rxRule': truth_074e[2], 'provable': 'static'},
                'altIdentitySysIds': ['0x0e5f', '0x0e60'],
                'identityRule': 'nameVariant + PARTNUMBER memcmp',
                'provable': 'static',
                'e0Coord': truth_coord_by_sid[sid].get(0x74E, default_coord),
            }
            rec['fourTuple'] = dict(four)
            rec.update({k: v for k, v in four.items() if k != 'fourTuple'})
        if rejected_pairs:
            rec['rejectedPairs'] = rejected_pairs
        if rows and not n_mixed and n_value == 0 and len(pairs) != 1:
            rec['bindUnresolved'] = 'n=0 但合法地址不唯一，禁止首候选直绑；继续探测/枚举'
        if newly_sourced:
            rec['bindUnresolved'] = ('候选来自 SYS_DATA comm 静态补源（本 ECU 地址对或按代完整 '
                                     'cat=0x10 地址表）；参考诊断仪做法为候选循环 + 应答即绑，'
                                     '静态地址表是候选集 → 一律禁止免探针直绑')
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

    # ★ 2026-11-12 全量审计修 bug：同一个 (tx,rx) 被多个 sysId **免探针直绑**时，
    #   该地址不可能同时是这些 ECU 的唯一实测地址。实测 0x07F1/0x07F9 被
    #   0x0b32/0x0b34/0x0c34/0x0f34 四个不同模块直绑，而 0x07F1 正是真车日志里
    #   「探 0x7F1 回帧头 7E8」的肇事地址；0x07DB/0x07E3 也被 2 个模块直绑。
    #   全部取消 bindDirect，强制走探针 + 身份核验，不再让错绑地址免检进模块。
    direct_by_pair = defaultdict(list)
    for sid, rec in out.items():
        ps = rec.get('pairs') or []
        if rec.get('bindDirect') and len(ps) == 1:
            direct_by_pair[(ps[0]['tx'], ps[0]['rx'])].append(sid)
    for (tx, rx), sids in direct_by_pair.items():
        if len(sids) < 2:
            continue
        for sid in sids:
            out[sid]['bindDirect'] = False
            out[sid]['bindUnresolved'] = (
                f'地址 {tx}/{rx} 被 {len(sids)} 个 sysId 同时免探针直绑'
                f'（{",".join(sids)}）—— 不可能都是唯一地址，强制探针 + 身份核验')
        stats['duplicateDirectUnbound'] += len(sids)

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

    # ★ 2026-11-13 HB-2 收口统计（全部按 provenance 显式过滤后机读计数，禁手填常数）：
    #   - mismatchFixed：按 provenance 含 commCat10-family-default 的 sysId 数（权威 N=120）
    #   - truncationFixed：5 处 16/20 项截断删除后，候选数 > 16 的 family-default sysId 数
    #   - candidateDistribution：fam120 候选分组（gen0x03 完整 3 条 / gen0x13 完整 13 条
    #     / 10 代完整 39/33/31/36/33/27/46/34/38/40 条；3/13/16 各自标源不混算）
    fam_sids = [s for s, rec in out.items()
                if 'commCat10-family-default' in json.dumps(rec.get('provenance') or [])]
    mismatch_fixed = len(fam_sids)
    # 每个 fam120 sysId 所属代的「完整」cat=0x10 地址表条数（comm-addr-table.json）；
    # 分组标签 = min(完整条数, 16)：gen0x03=3 / gen0x13=13 / 其余 10 代=16。
    # 这样 {3:28,13:2,16:90} 由实际条目机读得出，且与 PRD 附录 A 的 fam120 分布一致。
    by_gen_doc = comm_addr_doc.get('byGeneration') or {}
    gen_full_count = {g: int(v.get('count') or len(v.get('addresses') or []))
                      for g, v in by_gen_doc.items()}
    group_of = lambda s: min(gen_full_count.get(f'0x{(int(s, 16) >> 8):02X}', 0), 16)
    truncation_fixed = sum(1 for s in fam_sids
                           if gen_full_count.get(f'0x{(int(s, 16) >> 8):02X}', 0) > 16)
    fam_dist = Counter(group_of(s) for s in fam_sids)
    stats['mismatchFixed'] = mismatch_fixed
    stats['truncationFixed'] = truncation_fixed
    stats['candidateDistribution'] = {str(k): v for k, v in sorted(fam_dist.items())}
    stats['familyDefaultProvenanceCount'] = mismatch_fixed

    doc = {
        'schemaVersion': 6,
        'source': ('drivelinks-v3(请求键/addrBlock) + sysdata-routing(路由表 u32 can/根表22type) '
                   '+ sysdata-comm(cat=0x10 本代真值 A>>5/C>>5) '
                   '+ comm-addr-table(完整 cat=0x10 地址表/ownerSysId/rx 规则) '
                   '+ all-model-sysids(全车型换表) + variant-sysids(变体实解析 sysId) '
                   '+ ecu-addresses(表A/跨代) + coding-v2(首参数/族) '
                   '+ data/models(Boxster/Cayman 文件集+items 签名)'),
        'rule': ('T02 全代真值注入：CAN 只来自 SYS_DATA comm cat=0x10 的 A>>5/C>>5 与路由表 u32 can；'
                 'DRIVELINKS bindKey/internal（0x0030xxxx / 0xFF60xxxx）与 record.candidates 低 16 位'
                 '是请求键，只写 requestKeys 作绑定入参，绝不进 cands（v3key/v3cand/v3candRx 路径数=0）。'
                 'gen=sysId>>8；对每个有 cat=0x10 本代真值的 sysId（全代，不再限 gen>=0x14）'
                 '把 tx/rx 作为首选候选注入，rx 取记录 C 原值；gen<0x14 此前缺真值的 172 个 sysId 归零。'
                 'tierA=路由表(owner==sysId)∪DME 路由组∪跨代已证 tx；空则同系统跨代表A候选∩路由表 can；'
                 '再空则按代取完整 cat=0x10 地址表 family-default；候选仍需探针验证，绝不免探针直绑。'
                 'rx 规则原样保留 +0x6A/+0x100/+8/rx<tx；无 cat=0x10 记录时才按 tx≤0x7F7 → +8 派生；'
                 'tx/rx 超 11 位进 rejectedPairs，绝不 &0x7FF 回绕、不把 +0x6A 全局常量化。'
                 '0x0f4d 四元对象按名字串+件号裁决，0x0e5f/0x0e60 是异名同功能 sysId（raw 相同不合并）；'
                 'Macan 后端电子设备 0x0f23/0x0f34 blockOff 不同 → 分别绑定；'
                 'Boxster/Cayman 981/982/987 仅在文件集+items 签名全等时允许合并。'),
        'stats': dict(stats),
        'coverage': coverage,
        'truthBaseline': {
            'genBelow14TruthSysIds': 296,
            'genBelow14MissingBefore': 172,
            'genBelow14TruthPairs': 302,
            'genBelow14RxNotPlus8': 281,
            'evidence': [
                'docs/evidence/431-static-allmodels-20261120.md#7',
                'docs/evidence/431-linkmap-20261120.md#F',
            ],
            'provable': 'static',
        },
        'datasetMerge': dataset_merge_policy(),
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
    # 硬门禁：同一地址不得被多个 sysId 免探针直绑（全量审计 0x07F1 肇事地址收口）
    still_direct = defaultdict(list)
    for sid, rec in out.items():
        if rec.get('bindDirect'):
            for p in (rec.get('pairs') or []):
                still_direct[(p['tx'], p['rx'])].append(sid)
        if (rec.get('cands') or []) != [p['tx'] for p in (rec.get('pairs') or [])]:
            problems.append(f'{sid}: cands 与 pairs.tx 不一致')
        if not rec.get('provable'):
            problems.append(f'{sid}: 缺 provable 标记')
        for p in (rec.get('pairs') or []):
            tx, rx = int(p['tx'], 16), int(p['rx'], 16)
            if not ((tx <= 0x7FF and rx <= 0x7FF) or (tx > 0x7FF and rx <= 0x1FFFFFFF)):
                problems.append(f"{sid}: 协议非法 pair {p['tx']}→{p['rx']}")
    for pair, sids in still_direct.items():
        if len(sids) > 1:
            problems.append(f'{pair[0]}/{pair[1]}: 仍被 {len(sids)} 个 sysId 直绑 {sids}')
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
    # ★ 2026-11-12 全量收口：4588 个变体实际解析到的 sysId 必须全部有地址候选（0 链路断点）。
    var_ids = [s.lower() for s in variant_sysids.get('sysIds') or []]
    var_missing = [s for s in var_ids if not cand_of(s)]
    checks.append((f'变体实解析 {len(var_ids)} 个 sysId 全部有地址候选（缺 {len(var_missing)}）',
                   not var_missing))
    # T02 数字单一来源自检：623 / 408 / 172→0 / 302 / 281（大小写+0x 前缀归一）。
    # 分母口径与 evidence §7 完全一致：按 comm-addr-table.byGeneration[].addresses[].ownerSysId
    # （tx/rx 去重后的首 owner），不按 sysdata-comm 原始 subs 聚合，避免 410/304 假多算。
    truth_rows_all = defaultdict(set)
    for gen_rows in (comm_addr_doc.get('byGeneration') or {}).values():
        for row in gen_rows.get('addresses') or []:
            owner = str(row.get('ownerSysId') or '').lower()
            if owner:
                truth_rows_all[owner].add((int(row['tx'], 16), int(row['rx'], 16), row.get('rxRule') or ''))
    truth_sids = [s for s in out if s in truth_rows_all]
    checks.append((f'本代 cat=0x10 真值 sysId={len(truth_sids)}（408）', len(truth_sids) == 408))
    missing_after = []
    pair_count = rx_not_plus8 = 0
    for s in truth_sids:
        rows = sorted(truth_rows_all[s])
        if (int(s, 16) >> 8) < 0x14:
            cand_set = {int(c, 16) for c in (out[s].get('cands') or [])}
            if not ({t for t, _, _ in rows} & cand_set):
                missing_after.append(s)
            for t, r, rule in rows:
                pair_count += 1
                if rule != 'rx=tx+8':
                    rx_not_plus8 += 1
    checks.append((f'gen<0x14 缺真值候选 sysId={len(missing_after)}（172→0）', not missing_after))
    checks.append((f'gen<0x14 本 sysId 真值配对={pair_count}（302）', pair_count == 302))
    checks.append((f'gen<0x14 rx≠+8={rx_not_plus8}（281）', rx_not_plus8 == 281))
    gen14_truth_sids = sum(1 for s in truth_sids if (int(s, 16) >> 8) < 0x14)
    checks.append((f'gen<0x14 真值 sysId={gen14_truth_sids}（296）', gen14_truth_sids == 296))
    if var_missing:
        print('  缺失样本：', var_missing[:10])
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
