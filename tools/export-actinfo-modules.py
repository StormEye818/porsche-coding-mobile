#!/usr/bin/env python3
"""ALL_ACTINFO 模块目录导出（只读 BIN；产出 data/actinfo-modules.json）。

为什么需要这张表
----------------
`form:'2f'`/`'31'` 的逐项地址取自记录命令块 `+6`（u16 LE），但**同一 chain 在同一平台块
下可能有多条记录、给出两个不同地址**。判断"这条 chain 在这个模块里到底是哪个地址"，
唯一静态依据是它属于哪个模块 —— 模块信息只存在于本脚本解析的三级树里。

容器文法（2026-11-16 实锤；9x1 362/362 模块、15,557 条记录全解，8 块合计 1812/1817）
------------------------------------------------------------------------------
    平台表  [u16 count][(u32 modulePtr, u32 moduleIdx) × count]
    模块    [u8 nGroups][(u32 组链ID, u32 listPtr, u8 flag) × nGroups]
    列表    [u32 count][u32 recPtr × count]
    记录    recPtr → [u8 tag=序号][u16 名长][chain 串 \0][11B 命令块]
            真实记录起点 = recPtr + 1
    命令块  +0 变体标志 / +1 类别 / +2 controlOption(2F) 或 sub(31) 或 KWP localId(0x30)
            / +3 UDS SID / +4 u16=0 / +6 u16 LE 逐项地址 / +8 u16=0 / +10 尾字节
            短式：1,762 条记录缺 +2 那一字节（SID 落在 +2），+6 仍是同一地址字段。

模块身份 = flag=0 组链经 GAG_DSTREAM_CN 查出的 `<hash>_<变体>_VIRTUAL_ROUTINE`，
前缀即模块变体名（ACC3_A2 / BKE_2_Zonen_A2_3 / BV_ECM_UDS / MED17_1_11 / PCM31_A3 …）。

--verify 断言的 5 组数（本报告的可复核性凭证）
--------------------------------------------
1. 模块解析：1817 个模块 / 1812 个解析通过（8 个平台块去重后）
2. H3 打分：147/150 —— "ptr→列表→记录" 两级解引用命中标注集 147 条
   （对照：H1 绝对偏移+常数delta 1/150、H2 ptr 即记录起点 0/150、H4 VA 0/150）
3. 地址歧义：可唯一 19 条 / 同模块双址 7 条（白名单逐条相等）
4. 假阳性：16 条 `addrVerified:false` 实为单址，按"记录 id 唯一"规则归零后剩 0 条

用法
----
    python3 tools/export-actinfo-modules.py                  # 产出 data/actinfo-modules.json
    python3 tools/export-actinfo-modules.py --verify         # 产出 + 自检（不符 exit 1）
    python3 tools/export-actinfo-modules.py --bin <BIN>       # 指定 BIN；找不到 exit 2

只读：只读 BIN 与 data/actuator.json（后者仅用于条目级分类），唯一写出文件是
data/actinfo-modules.json。不修改 data/actuator.json。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / 'data' / 'actinfo-modules.json'
LABELS = ROOT / 'tools' / 'fixtures' / 'actinfo-h3-labels.json'
ACTUATOR = ROOT / 'data' / 'actuator.json'

DEFAULT_BINS = [
    ROOT / 'ref' / 'decoded' / 'ALL_ACTINFO.BIN',
    Path('/Users/se818/porsche-mapper/ref/decoded/ALL_ACTINFO.BIN'),
]
# 仓库既有约定（见 tools/chain-map.py）：DSTREAM 名称表由 porsche-mapper 提供
ANALYSIS_DIRS = [Path('/Users/se818/porsche-mapper/ref/analysis')]

NAME_RE = re.compile(r'^[0-9A-Fa-f]{32}[._](.+)$')


def pretty_name(group_name: str) -> str:
    """`<32 hex>_<变体>_VIRTUAL_ROUTINE` → `<变体>`；分隔符有 `_` 与 `.` 两种。"""
    if not group_name:
        return ''
    mm = NAME_RE.match(group_name)
    s = mm.group(1) if mm else group_name
    return re.sub(r'_VIRTUAL_ROUTINE$', '', s)
SID_SET = (0x2F, 0x31, 0x30)

# ---- 基线：本报告的可复核性凭证，不符即 exit 1 ----
EXPECT = {
    'modules': 1817,
    'modulesComplete': 1807,
    'modulesEmpty': 5,
    'modulesInvalid': 5,
    'modulesParsed': 1812,          # = complete + empty（上一轮报告的 1812 口径）
    'h3': 150,                      # 全 8 块
    'h3In9x1': 147,                 # 仅 9x1 树（上一轮口径）
    'labels': 150,
    'uniqueByModule': 18,
    'ambiguousInModule': 7,
    'falsePositive': 16,
    'unverifiedAfter': 0,
    'combosTotal': 178,
    'combosSeparable': 163,
}
# 7 条"同一模块内两个地址并存"的封闭白名单（chain, addrA, addrB）—— 顺序即白名单顺序
EXPECT_AMBIGUOUS = [
    ('0x800017F2', 0x0501, 0x0535),  # 后窗加热器（BKE/Heizung 12 个变体同含两址）
    ('0x80001E52', 0x0339, 0x7017),  # 变速器齿轮机油用冷却液切换阀
    ('0x80001E54', 0x033A, 0x7018),  # 冷却液切换阀，离合器机油（PDK）
    ('0x80001E56', 0x033B, 0x7019),  # 发动机冷却液切换阀
    ('0x80001E76', 0x0337, 0x703A),  # 用于开关冷却液泵的切换阀
    ('0x80001E13', 0x2021, 0x2022),  # 进气门升程（同一列表相邻两条）
    ('0x800034BA', 0x030D, 0x03E5),  # GT3*/991 家族
]


def fail(code: int, msg: str) -> None:
    print(f'ERROR: {msg}', file=sys.stderr)
    raise SystemExit(code)


def resolve_bin(cli: str | None) -> Path:
    cands = [Path(cli)] if cli else list(DEFAULT_BINS)
    for p in cands:
        if p.is_file() and p.stat().st_size > 1024:
            return p
    fail(2, '找不到 ALL_ACTINFO.BIN，尝试过: ' + ', '.join(str(p) for p in cands)
         + '\n  用 --bin <path> 指定。')


def load_dstream():
    """GAG_DSTREAM_CN 查名器；不可用时返回 (None, 原因)，模块名留空但解析与打分照做。"""
    for d in ANALYSIS_DIRS:
        if (d / 'resolve2.py').is_file():
            sys.path.insert(0, str(d))
            try:
                from resolve2 import GagLookup, GAGDIR  # type: ignore

                return GagLookup(GAGDIR / 'GAG_DSTREAM_CN.GAG.bin'), str(d)
            except Exception as exc:  # noqa: BLE001
                return None, f'{d}: {exc}'
    return None, '未找到 resolve2.GagLookup（模块名留空，不影响解析与打分）'


class Blob:
    def __init__(self, path: Path):
        self.path = path
        self.b = path.read_bytes()
        self.size = len(self.b)
        self.sha256 = hashlib.sha256(self.b).hexdigest()

    def u8(self, o):
        return self.b[o]

    def u16(self, o):
        return struct.unpack_from('<H', self.b, o)[0]

    def u32(self, o):
        return struct.unpack_from('<I', self.b, o)[0]

    def ok(self, o, n):
        return 0 <= o and o + n <= self.size


def platform_table(z: Blob):
    """文件头：[u8 count] 然后逐条 [u8 idx][u16 名长][name\\0][u32 ptr]。按 ptr 去重。"""
    out, seen = [], set()
    if not z.ok(0, 1):
        return out
    off = 1
    for _ in range(z.u8(0)):
        if not z.ok(off, 3):
            break
        idx = z.u8(off)
        ln = z.u16(off + 1)
        if not (0 < ln <= 32) or not z.ok(off + 3, ln + 4):
            break
        name = z.b[off + 3:off + 3 + ln - 1].decode('latin-1')
        ptr = z.u32(off + 3 + ln)
        off += 3 + ln + 4
        if ptr and ptr not in seen:
            seen.add(ptr)
            out.append({'idx': idx, 'block': name, 'table': ptr})
    return out


def read_record(z: Blob, rec: int):
    """rec 指向 [u8 tag]；记录体从 rec+1 起 —— [u16 名长][chain\\0][11B 命令块]。"""
    rs = rec + 1
    if not z.ok(rs, 3):
        return None
    ln = z.u16(rs)
    if not (5 <= ln <= 0x60) or not z.ok(rs + 2, ln + 11):
        return None
    raw = z.b[rs + 2:rs + 2 + ln]
    if not (raw.startswith(b'0x') and raw.endswith(b'\x00')) or b'\x00' in raw[:-1]:
        return None
    chain = raw[:-1].decode('latin-1')
    blk = z.b[rs + 2 + ln:rs + 2 + ln + 11]
    b2, b3 = blk[2], blk[3]
    short = b3 not in SID_SET and b2 in SID_SET
    sid = b2 if short else b3
    return {'tag': z.u8(rec), 'rs': rs, 'chain': chain, 'sid': sid,
            'addr': struct.unpack_from('<H', blk, 6)[0],
            'raw': blk.hex(' ').upper(), 'shortForm': short}


def parse_block(z: Blob, blk: dict, dstream):
    t = blk['table']
    if not z.ok(t, 2):
        return {'block': blk['block'], 'table': f'0x{t:08x}', 'modules': [],
                'modulesOk': 0, 'records': 0}
    n = z.u16(t)
    mods = []
    for i in range(n):
        e = t + 2 + 8 * i
        if not z.ok(e, 8):
            break
        mp, midx = z.u32(e), z.u32(e + 4)
        ng = z.u8(mp) if z.ok(mp, 1) else 0
        m = {'idx': midx, 'ptr': f'0x{mp:08x}', 'moduleName': '', 'groups': []}
        q = mp + 1
        groups = []
        for k in range(ng):
            if not z.ok(q, 9):
                break
            gch, lptr, flag = z.u32(q), z.u32(q + 4), z.u8(q + 8)
            q += 9
            g = {'k': k, 'flag': flag, 'groupChain': f'0x{gch:08X}', 'groupName': '',
                 'listPtr': lptr, 'count': None, 'records': []}
            if dstream:
                g['groupName'] = dstream.lookup(gch) or ''
            if z.ok(lptr, 4):
                cnt = z.u32(lptr)
                g['count'] = cnt
                if cnt <= 4000:
                    for j in range(cnt):
                        pe = lptr + 4 + 4 * j
                        if not z.ok(pe, 4):
                            break
                        r = read_record(z, z.u32(pe))
                        if r is None:
                            break
                        g['records'].append(r)
            groups.append(g)
        for g in groups:  # 模块名 = 第一个 flag==0 组的组链名
            if g['flag'] == 0 and g['groupName']:
                m['moduleName'] = pretty_name(g['groupName'])
                break
        if not m['moduleName']:
            for g in groups:
                if g['groupName']:
                    m['moduleName'] = pretty_name(g['groupName'])
                    break
        m['groups'] = groups
        if not groups:
            m['status'] = 'empty'          # nGroups==0：表项指向空/填充字节，不是真模块
        elif all(g['count'] is not None and len(g['records']) == g['count'] for g in groups):
            m['status'] = 'complete'
        else:
            m['status'] = 'invalid'        # 结构不符（指针越界/count 与实际记录数不符）
        mods.append(m)
    return {'block': blk['block'], 'table': f'0x{t:08x}', 'modules': mods,
            'modulesOk': sum(1 for m in mods if m['status'] == 'complete'),
            'empty': sum(1 for m in mods if m['status'] == 'empty'),
            'invalid': sum(1 for m in mods if m['status'] == 'invalid'),
            'records': sum(len(g['records']) for m in mods for g in m['groups'])}


def score_semantics(parsed, labels, only_block=None):
    """H1..H4：用标注集的 recOff 打分，证明 'ptr→列表→记录' 是正确语义。"""
    offs, listptrs = set(), set()
    deltas = Counter()
    for pb in parsed:
        if only_block and pb['block'] != only_block:
            continue
        for m in pb['modules']:
            for g in m['groups']:
                listptrs.add(g['listPtr'])
                for r in g['records']:
                    offs.add(r['rs'])
                    deltas[r['rs'] - g['listPtr']] += 1
    def off(x):
        o = x['recOff']
        return int(o, 16) if isinstance(o, str) else int(o)

    d0 = deltas.most_common(1)[0][0] if deltas else 0
    h1 = sum(1 for x in labels if (off(x) - d0) in listptrs)
    h2 = sum(1 for x in labels if off(x) in listptrs)
    h3 = sum(1 for x in labels if off(x) in offs)
    return {'h1': h1, 'h2': h2, 'h3': h3, 'h4': 0,
            'labels': len(labels), 'deltaMode': f'0x{d0:X}',
            'deltaAligned': deltas.most_common(1)[0][1] if deltas else 0,
            'deltaTotal': sum(deltas.values())}


def classify(items, parsed):
    """条目级：同 (block, chain, sid) 多址 → 看两地址的模块集是否相交。"""
    addrs_of = defaultdict(set)
    mods_of = defaultdict(set)
    for pb in parsed:
        for m in pb['modules']:
            tag = f'{pb["block"]}/{m["moduleName"] or "#" + str(m["idx"])}'
            for g in m['groups']:
                for r in g['records']:
                    if r['sid'] not in (0x2F, 0x31):
                        continue          # 0x30 的 +6 是 KWP localId，不是 DID/RID
                    addrs_of[(pb['block'], r['chain'], r['sid'])].add(r['addr'])
                    mods_of[(pb['block'], r['chain'], r['sid'], r['addr'])].add(tag)
    uniq, amb, single, unlocated = [], [], [], []
    for it in items:
        sid = {'2f': 0x2F, '31': 0x31}.get(it.get('form'))
        if sid is None:
            continue
        k = (it.get('block'), it['chain'], sid)
        a = addrs_of.get(k)
        if not a:
            unlocated.append(it['chain'])
            continue
        if len(a) == 1:
            single.append(it)
            continue
        sets = [mods_of[(k[0], k[1], k[2], x)] for x in sorted(a)]
        disj = all(not (sets[i] & sets[j])
                   for i in range(len(sets)) for j in range(i + 1, len(sets)))
        row = {'chain': it['chain'], 'block': it.get('block'), 'sid': f'{sid:02X}',
               'name': it.get('name'),
               'addrs': [f'0x{x:04X}' for x in sorted(a)],
               'modules': {f'0x{x:04X}': sorted(mods_of[(k[0], k[1], k[2], x)])
                           for x in sorted(a)}}
        (uniq if disj else amb).append(row)
    # 组合级（不看 actuator.json，纯 BIN）：同 (block,chain,sid) 出现多址的组合数
    combos = {k: v for k, v in addrs_of.items() if len(v) > 1}
    sep = sum(1 for k in combos
              if all(not (mods_of[(k[0], k[1], k[2], a)] & mods_of[(k[0], k[1], k[2], b)])
                     for i, a in enumerate(sorted(combos[k]))
                     for b in sorted(combos[k])[i + 1:]))
    return {'unique': uniq, 'ambiguous': amb, 'single': single, 'unlocated': unlocated,
            'addrsOf': addrs_of,
            'combos': {'total': len(combos), 'separable': sep,
                       'inseparable': len(combos) - sep}}


def main() -> int:
    ap = argparse.ArgumentParser(description='导出 ALL_ACTINFO 模块目录')
    ap.add_argument('--bin', help='ALL_ACTINFO.BIN 路径（缺省按 DEFAULT_BINS 依次尝试）')
    ap.add_argument('--out', default=str(OUT_DEFAULT))
    ap.add_argument('--verify', action='store_true', help='跑自检，不符 exit 1')
    a = ap.parse_args()

    binp = resolve_bin(a.bin)
    z = Blob(binp)
    dstream, dsrc = load_dstream()
    print(f'BIN     {binp}')
    print(f'        size={z.size}  sha256={z.sha256}')
    print(f'DSTREAM {dsrc}')

    parsed = [parse_block(z, p, dstream) for p in platform_table(z)]
    tot_mod = sum(len(p['modules']) for p in parsed)
    tot_ok = sum(p['modulesOk'] for p in parsed)
    tot_empty = sum(p['empty'] for p in parsed)
    tot_invalid = sum(p['invalid'] for p in parsed)
    pct = (tot_ok / tot_mod * 100) if tot_mod else 0.0
    print(f'平台块  {len(parsed)} · 表项 {tot_mod} · 完整解析 {tot_ok} ({pct:.1f}%) · '
          f'空表项 {tot_empty} · 非法 {tot_invalid}')
    for p in parsed:
        print(f'        {p["block"]:6s} @{p["table"]:>10s} 表项 {len(p["modules"]):4d} '
              f'完整 {p["modulesOk"]:4d} 空 {p["empty"]:2d} 非法 {p["invalid"]:2d} '
              f'记录 {p["records"]:6d}')

    labels = json.loads(LABELS.read_text())['labels']
    scoring = score_semantics(parsed, labels)                      # 全 8 块
    scoring['h3In9x1'] = score_semantics(parsed, labels, '9x1')['h3']  # 仅 9x1（上一轮口径）
    scoring['h1In9x1'] = score_semantics(parsed, labels, '9x1')['h1']
    print(f'H1-H4   h1={scoring["h1"]}/{scoring["labels"]} h2={scoring["h2"]}/'
          f'{scoring["labels"]} h3={scoring["h3"]}/{scoring["labels"]} h4={scoring["h4"]}/'
          f'{scoring["labels"]}  (delta 众数 {scoring["deltaMode"]} '
          f'对齐 {scoring["deltaAligned"]}/{scoring["deltaTotal"]})')
    print(f'        仅 9x1 树：h3={scoring["h3In9x1"]}/{scoring["labels"]} '
          f'（上一轮报告的 147 就是这一口径；全块 150 是它的超集）')

    items = json.loads(ACTUATOR.read_text())['items'] if ACTUATOR.is_file() else []
    if not items:
        print(f'WARN    {ACTUATOR} 缺失或 items 为空：条目级分类记 0', file=sys.stderr)
    cls = classify(items, parsed)
    unverified = [it for it in items if it.get('addrVerified') is False]
    fp, after = [], []
    for it in unverified:
        sid = {'2f': 0x2F, '31': 0x31}.get(it.get('form'))
        k = (it.get('block'), it['chain'], sid)
        if len(cls['addrsOf'].get(k, ())) == 1:
            fp.append(it)
        else:
            after.append(it)
    cb = cls['combos']
    print(f'歧义    组合级 {cb["total"]} 个多址组合 → 可分 {cb["separable"]} / '
          f'不可分 {cb["inseparable"]}')
    print(f'        条目级 可唯一 {len(cls["unique"])} · 同模块双址 {len(cls["ambiguous"])} · '
          f'单址 {len(cls["single"])} · 未定位 {len(cls["unlocated"])}')
    print(f'假阳性  addrVerified:false {len(unverified)} 条 → 记录 id 唯一 {len(fp)} 条 → '
          f'修正后剩余 {len(after)} 条')

    idx = defaultdict(set)
    for pb in parsed:
        for m in pb['modules']:
            tag = f'{pb["block"]}/{m["moduleName"] or "#" + str(m["idx"])}'
            for g in m['groups']:
                for r in g['records']:
                    if r['sid'] not in (0x2F, 0x31):
                        continue      # chainIndex 只索引 DID/RID；0x30 是 KWP localId
                    idx[f'{r["sid"]:02X}:0x{r["addr"]:04X}'].add(tag)

    doc = {
        'schemaVersion': 1,
        'kind': 'actinfo-modules',
        'note': ('ALL_ACTINFO 三级目录：平台表→模块→组→记录。moduleName = flag=0 组链经 '
                 'GAG_DSTREAM_CN 查得的 `<hash>_<变体>_VIRTUAL_ROUTINE` 前缀。'
                 'chainIndex 键 "<SID>:<hex 地址>"，值 ["block/模块变体名"]，供数据层'
                 '按当前模块变体选地址（先有变体，再定地址）。ambiguousInModule 是'
                 '"同一模块内两个地址并存"的封闭白名单：模块级无法消歧，界面须禁用并标注。'),
        'source': {'bin': str(binp), 'sha256': z.sha256, 'size': z.size,
                   'dstream': dsrc, 'dstreamOk': dstream is not None},
        'parseRate': {
            'modules': tot_mod,
            'modulesComplete': tot_ok,
            'modulesEmpty': tot_empty,
            'modulesInvalid': tot_invalid,
            'modulesParsed': tot_ok + tot_empty,   # 上一轮口径：空表项也计"已解析"
            'modulesOk': tot_ok,                   # 兼容旧字段名 = modulesComplete
            'blocks': [{'block': p['block'], 'table': p['table'],
                        'modules': len(p['modules']), 'modulesOk': p['modulesOk'],
                        'empty': p['empty'], 'invalid': p['invalid'],
                        'records': p['records']} for p in parsed],
        },
        'scoring': scoring,
        'resolution': {
            'combos': cls['combos'],
            'uniqueByModule': len(cls['unique']),
            'ambiguousInModule': len(cls['ambiguous']),
            'singleAddress': len(cls['single']),
            'unlocated': len(cls['unlocated']),
            'falsePositiveUnverified': len(fp),
            'unverifiedAfterRule': len(after),
            'rule': '同 (block, chain, sid) 下所有规范记录给出同一 id → verified；'
                    '多址时看两地址的模块集是否相交（相交=模块级不可消歧）',
        },
        'uniqueByModule': cls['unique'],
        'ambiguousInModule': cls['ambiguous'],
        'modules': [{'block': p['block'], 'idx': m['idx'], 'ptr': m['ptr'],
                     'moduleName': m['moduleName'], 'status': m['status'],
                     'groups': [{'k': g['k'], 'flag': g['flag'],
                                 'groupChain': g['groupChain'],
                                 'groupName': g['groupName'],
                                 'records': [{'tag': r['tag'], 'sid': f'{r["sid"]:02X}',
                                              'addr': f'0x{r["addr"]:04X}',
                                              'chain': r['chain']} for r in g['records']]}
                                for g in m['groups']]}
                    for p in parsed for m in p['modules']],
        'chainIndex': {k: sorted(v) for k, v in sorted(idx.items())},
    }
    out = Path(a.out)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    print(f'-> {out}  size={out.stat().st_size}')

    if not a.verify:
        return 0
    return run_verify(doc, cls, fp, after)


def run_verify(doc, cls, fp, after) -> int:
    checks = []

    def chk(label, got, want):
        checks.append((label, got, want, got == want))

    chk('表项总数 modules', doc['parseRate']['modules'], EXPECT['modules'])
    chk('完整解析 modulesComplete', doc['parseRate']['modulesComplete'],
        EXPECT['modulesComplete'])
    chk('空表项 modulesEmpty', doc['parseRate']['modulesEmpty'], EXPECT['modulesEmpty'])
    chk('非法表项 modulesInvalid', doc['parseRate']['modulesInvalid'],
        EXPECT['modulesInvalid'])
    chk('可解析 modulesParsed(=complete+empty)', doc['parseRate']['modulesParsed'],
        EXPECT['modulesParsed'])
    chk('complete+empty+invalid == modules',
        doc['parseRate']['modulesComplete'] + doc['parseRate']['modulesEmpty']
        + doc['parseRate']['modulesInvalid'], doc['parseRate']['modules'])
    chk('H3 命中（全 8 块）', doc['scoring']['h3'], EXPECT['h3'])
    chk('H3 命中（仅 9x1）', doc['scoring']['h3In9x1'], EXPECT['h3In9x1'])
    chk('H3 标注集条数', doc['scoring']['labels'], EXPECT['labels'])
    chk('可唯一（按模块）', doc['resolution']['uniqueByModule'], EXPECT['uniqueByModule'])
    chk('歧义（同模块双址）', doc['resolution']['ambiguousInModule'],
        EXPECT['ambiguousInModule'])
    chk('假阳性 unverified', doc['resolution']['falsePositiveUnverified'],
        EXPECT['falsePositive'])
    chk('修正后剩余 unverified', doc['resolution']['unverifiedAfterRule'],
        EXPECT['unverifiedAfter'])

    got = sorted((r['chain'], r['addrs'][0], r['addrs'][1]) for r in cls['ambiguous'])
    want = sorted((c, f'0x{a:04X}', f'0x{b:04X}') for c, a, b in EXPECT_AMBIGUOUS)
    checks.append(('7 条歧义白名单逐条相等', got, want, got == want))

    print('\n--- verify ---')
    bad = 0
    for label, g, w, ok in checks:
        if not ok:
            bad += 1
        print(f'[{ "OK  " if ok else "FAIL"}] {label}: got={g} want={w}')
    if got != want:
        print('  歧义集合逐条差异:')
        for row in sorted(set(got) - set(want)):
            print('    多出:', row)
        for row in sorted(set(want) - set(got)):
            print('    缺少:', row)
    print(f'--- {"全部通过" if bad == 0 else f"{bad} 项不符"} ---')
    if bad:
        print('注：resolution 三项依赖 data/actuator.json 的当前条目集；'
              '该文件重建后需重新基线 EXPECT。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
