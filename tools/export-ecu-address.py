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
import bisect
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

# ★ 2026-11-09 RE-ICADDR（真车二连败后证据级重收敛）：
#   R2「internal 低字节补 join」（0x02F9→0x35F9 族 0x721/722/723）**已被真车证伪**
#   （2101/1A9F/1A87/1A90 全 NO DATA）—— 按验收标准禁止任何形式的近似 join，整体删除。
#   无精确表A 行的 routing internal → `joinState='unresolved'`（未决），不产出候选。
#   R1 代际同名合并保留（名字记录同名 = 同模块代际对，非近似 join）。
# ★ 通用候选族（DRIVELINKS 14B 记录族，任何模块适用，零特判）：
#   记录 = [u8 idx][u32 A=(flags<<16)|u16][u32 B][u8 C tag][u32 D]（GetDriveLinksData
#   0x18b74 mode 0x1001/0x1002 循环 @0x18d9a，stride 14 @0x18dda 逐指令转写，RE-ICADDR §3）。
#   u16 与 addrBlock A 同为请求键坐标空间（语义未证，见 RE-ICADDR §3.3）——
#   只作**运行时身份探测候选**（识别串匹配才算命中，真车自证），不作静态 tx 定论。
FLAG_OK = (0x0000, 0x1000, 0x2000, 0x3000)

# ★ 2026-11-09(2) 链路绑定段转写（最后一锹）：
#   `PorscheTransCanCalcID` COMM:0x13fc0（64B 逐指令，本次复核）：
#   out = ((idx<<8)|lo) ^ T2[idx]，idx = 输入高字节在 T1 的位置；8 族不中→直通。
#   8 族互逆双射（CAN↔连接码）；全包调用点 0（1900 调用普查 + P5TOKEN 边界定案）——
#   它是 CAN 的下游编码，**不是行→CAN 选择器**。锚点反证：internal 当码反解与真值矛盾
#   （PASM 0x01CB→0x068A ≠ 0x7D0）→ internal≠连接码，禁作 join。
#   按任务指令把「码像候选」（internal 经本公式的反解像）喂给运行时身份探测自证通道，
#   标 code-image（未证），不作静态 tx 定论。
TC_T1 = (0x05, 0x07, 0x03, 0x02, 0x04, 0x06, 0x01, 0x00)
TC_T2 = (0x46, 0x75, 0x63, 0x6B, 0x55, 0x53, 0x41, 0x2E)


def tc_code_to_can(code):
    """TransCanCalcID 同式反解（码→CAN）。8 族不中返回 None（直通形态不可反解）。"""
    hi, lo = (code >> 8) & 0xFF, code & 0xFF
    if hi not in TC_T1:
        return None
    idx = TC_T1.index(hi)
    return ((idx << 8) | lo) ^ TC_T2[idx]


def load_rows(sd_bytes, sysids):
    tabA, tabB = {}, {}
    tabB_proto = {}   # (sysid, inter) -> 表B 行 proto
    tabB_off = {}     # (sysid, inter) -> 表B 行文件偏移（逐候选行证据）
    for off in range(0, len(sd_bytes) - 16):
        f0, inter, attr, tail = struct.unpack_from('<IIII', sd_bytes, off)
        b = tail.to_bytes(4, 'little')
        if not (b[3] == 0xff and b[1] == 0x02 and b[0] in (0x01, 0x03) and 0 < attr < 0x20000 and inter <= 0x3FFF):
            continue
        if f0 in sysids:
            tabB.setdefault(f0, set()).add(inter)
            tabB_proto[(f0, inter)] = b[0]
            tabB_off.setdefault((f0, inter), []).append(off)
        elif 0x180 <= f0 <= 0x1FFF:
            tabA.setdefault(inter, []).append({'tx': f0, 'attr': attr, 'proto': b[0], 'idx': b[2], 'off': off})
    return tabA, tabB, tabB_proto, tabB_off


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


def gen_groups(sd_bytes):
    """R1 代际同名组：SYS_DATA 名字记录 [u32 sysId @name-9][u32 ?][u16 len][name\0]。
    同名 sysId = 同模块代际对（RE-MODELADDR §2.2 归属法，sysId 字段=name_ptr-9）。"""
    import collections
    name_of = {}
    N = len(sd_bytes)
    for off in range(9, N - 30):
        n = struct.unpack_from('<H', sd_bytes, off - 2)[0]
        if not (4 <= n <= 80):
            continue
        nb = sd_bytes[off:off + n]
        if not (len(nb) == n and nb[-1] == 0 and all(32 <= c < 127 for c in nb[:-1])):
            continue
        sysid = struct.unpack_from('<I', sd_bytes, off - 9)[0]
        if not (0x0100 <= sysid <= 0x0FFF):
            continue
        name_of.setdefault(sysid, nb[:-1].decode())
    by_name = collections.defaultdict(set)
    for sid, nm in name_of.items():
        by_name[nm].add(sid)
    group = {}
    for nm, sids in by_name.items():
        for sid in sids:
            group.setdefault(sid, set()).update(sids - {sid})
    return group


def row_kind(inter, tabA):
    """join 形态：精确 = 有表A 行；无精确行 = 未决（2026-11-09 起无近似 join）。"""
    if tabA.get(inter):
        return 'exact'
    return 'unresolved'


def order_key(r, rank, excl):
    # 专属 internal 的行优先（共享路由组行殿后），再按锚点槽位/idx/tx
    return (excl, rank, 0 if r['idx'] in (0x05, 0x08) else 1, r['idx'], r['tx'])


def extract_families(dl_bytes, allrows):
    """DRIVELINKS 14B 记录族（通用候选族生成规则，零特判）。

    记录（GetDriveLinksData FILE:0x18b74 mode 0x1001/0x1002 循环 @0x18d9a 转写）：
      [u8 idx][u32 A=(flags<<16)|u16][u32 B][u8 C tag][u32 D]，stride 14。
    归属：addrBlock 行 cmdptr（记录流起点）序 → 包含 run 起点的最大 cmdptr 的行组。
    u16 与 addrBlock A 同为请求键坐标空间（RE-ICADDR §3.3，语义未证）——
    只作运行时身份探测候选（识别串匹配才算命中），不作静态 tx 定论。
    返回 {sysId: [{'tx','rx','idx','tag','keyD','recB','recOff','rowOff','ownerCmdptr'}]}
    """
    def rec_ok(p):
        if p + 14 > len(dl_bytes):
            return False
        idx = dl_bytes[p]
        A, B = struct.unpack_from('<II', dl_bytes, p + 1)
        C = dl_bytes[p + 9]
        D = struct.unpack_from('<I', dl_bytes, p + 10)[0]
        alo, ahi = A & 0xFFFF, A >> 16
        return (1 <= idx <= 64 and 0x180 <= alo <= 0x7FF and ahi <= 0x1FFF
                and B < 0x02000000 and C <= 0x40 and D < 0x200000)

    runs = []
    p = 0
    while p < len(dl_bytes) - 14:
        if rec_ok(p) and rec_ok(p + 14) and rec_ok(p + 28):
            start = p
            while p + 14 <= len(dl_bytes) and rec_ok(p):
                p += 14
            runs.append((start, (p - start) // 14))
        else:
            p += 1

    cmdptrs = sorted(set(r[5] for r in allrows))

    def owner_rows(off):
        prev = [c for c in cmdptrs if c <= off]
        if not prev:
            return []
        c = prev[-1]
        out, seen = [], set()
        for r in allrows:
            if r[5] == c and (r[0], r[1], r[2]) not in seen:
                seen.add((r[0], r[1], r[2]))
                out.append(r)
        return out

    fam = {}
    for start, n in runs:
        recs = []
        for k in range(n):
            q = start + k * 14
            idx = dl_bytes[q]
            A, B = struct.unpack_from('<II', dl_bytes, q + 1)
            C = dl_bytes[q + 9]
            D = struct.unpack_from('<I', dl_bytes, q + 10)[0]
            recs.append({'tx': A & 0xFFFF, 'idx': idx, 'tag': C,
                         'keyD': D, 'recB': B, 'recOff': f'PORSCHE_DRIVELINKS.dec.bin:0x{q:X}',
                         'aPacked': f'0x{A:08X}'})
        owners = owner_rows(start)
        for r in owners:
            sysId = r[0]
            lst = fam.setdefault(sysId, [])
            have = {e['recOff'] for e in lst}
            for rec in recs:
                if rec['recOff'] in have:
                    continue
                lst.append(dict(rec,
                                rx=f"0x{rec['tx'] + 8:04X}",
                                ownerCmdptr=f"0x{r[5]:X}",
                                rowOff=f"PORSCHE_DRIVELINKS.dec.bin:0x{r[7]:X}",
                                src='drivelinks-14b'))
    return fam


def parse_addr_rows(dl_bytes):
    """DRIVELINKS 目录→block→addrBlock 全行（含文件行偏移）。
    目录 8B/条 [u32 sysId][u32 blockOffset]；block=[u8 count][count×6B [u16 blockKey][u32 addrBlock]]；
    addrBlock=[u16 grp][u16 0x0304][u16 count]+count×11B [u8 idx][u16 vint][u16 flags][u32 cmdptr][u16 C]。"""
    dirc, i = [], 0
    while i + 8 <= len(dl_bytes):
        sysId, off = struct.unpack_from('<II', dl_bytes, i)
        if sysId == 0x7FFFFFFF:
            break
        dirc.append((sysId, off))
        i += 8
    rows = []
    # ★ 2026-11-12 块边界修正（RE-GAPVERIFY §2）：count 多 1 时按目录 blockOff 间距截断，
    #   并按参考诊断仪选行不变量 bk>>8==sysId低字节 校验（幻影条目=邻块头）。
    block_offs = sorted({off for _, off in dirc})
    for sysId, boff in dirc:
        if boff >= len(dl_bytes):
            continue
        cnt = dl_bytes[boff]
        j = bisect.bisect_right(block_offs, boff)
        span = (block_offs[j] - boff) if j < len(block_offs) else (len(dl_bytes) - boff)
        cnt = min(cnt, max((span - 1) // 6, 0))
        q0 = boff + 1
        for k in range(cnt):
            bk, ab = struct.unpack_from('<HI', dl_bytes, q0)
            q0 += 6
            if (bk >> 8) != (sysId & 0xff):
                continue
            if ab >= len(dl_bytes):
                continue
            grp, magic, n = struct.unpack_from('<HHH', dl_bytes, ab)
            if magic != 0x0304:
                continue
            q = ab + 6
            for r in range(n):
                if q + 11 > len(dl_bytes):
                    break
                idx = dl_bytes[q]
                vint, flags, cmdptr, c = struct.unpack_from('<HHIH', dl_bytes, q + 1)
                if cmdptr < 0x30000:
                    rows.append((sysId, bk, idx, vint, flags, cmdptr, c, q))
                q += 11
    return rows


def main():
    dl, sd = rea.load()
    dl_idx = rea.drivelinks_index(dl)
    sd_bytes = SYS_DATA.read_bytes()
    sysids = set(dl_idx.keys())
    tabA, tabB, tabB_proto, tabB_off = load_rows(sd_bytes, sysids)
    tabB2 = load_rows2(sysids)
    name_lookup = name_records_index(sd_bytes)
    allrows = parse_addr_rows(dl)
    families = extract_families(dl, allrows)
    print(f'表A internal {len(tabA)} · 表B源1 {len(tabB)} sysId · 表B源2 {len(tabB2)} sysId · '
          f'14B 记录族 {len(families)} sysId')

    old = {}
    if OUT.exists():
        for e in json.loads(OUT.read_text()).get('entries', []):
            old[e.get('sysId', '').lower()] = e

    ANCH = {sid: tx for _n, sid, tx, _i in rea.ANCHORS}
    GG = gen_groups(sd_bytes)
    # internal 专属度：被多个 sysId 引用的 internal 是共享路由组，其行靠后、不能当唯一
    inter_users = {}
    for sysid in dl_idx:
        for g in (tabB.get(sysid, set()), tabB2.get(sysid, set())):
            for inter in g:
                inter_users.setdefault(inter, set()).add(sysid)
    entries = []
    stat = {'proven': 0, 'unique': 0, 'multi': 0, 'none': 0}
    for sysid in sorted(dl_idx):
        key = f'0x{sysid:04x}'
        variants = dl_idx[sysid]
        # R1：代际同名兄弟的 routing internal 并入 join 集（同模块代际对共享候选池）
        sib = GG.get(sysid, set())
        b1 = set(tabB.get(sysid, set()))
        for s in sib:
            b1 |= tabB.get(s, set())
        groups = [(b1, 0), (tabB2.get(sysid, set()), 1)]
        rows, seen = [], set()
        picked = []
        unresolved = []   # 无精确表A 行的 routing internal（近似 join 禁用 → 未决）
        for internals, rank in groups:
            for inter in sorted(internals):
                excl = 0 if len(inter_users.get(inter, ())) <= 1 else 1
                exact = [r for r in tabA.get(inter, []) if 0x180 <= r['tx'] <= 0x7FF]
                if exact:
                    for r in exact:
                        picked.append((excl, rank, inter, r))
                    continue
                # ★ 2026-11-09：低字节 join 已被真车证伪（0x02F9→0x35F9→0x721/722/723 NO DATA），
                #   禁止任何形式的近似 join —— 无精确行 = 未决（joinState='unresolved'），
                #   记录 表B 行偏移 作证据，不出候选。
                if rank == 0:
                    unresolved.append({
                        'internal': f'0x{inter:04X}',
                        'proto': tabB_proto.get((sysid, inter)) or
                                 next((tabB_proto.get((s, inter)) for s in sib if tabB_proto.get((s, inter))), None),
                        'tabBRows': [f'PORSCHE_SYS_DATA.BIN:{o}' for o in
                                     sorted({o for s in {sysid} | sib
                                             for o in tabB_off.get((s, inter), [])})],
                    })
        picked.sort(key=lambda t: (order_key(t[3], t[1], t[0]), t[3]['tx']))
        for excl, rank, inter, r in picked:
            if r['tx'] in seen:
                continue
            seen.add(r['tx'])
            rows.append({'tx': f"0x{r['tx']:04X}", 'rx': f"0x{r['tx'] + 8:04X}",
                         'attr': f"0x{r['attr']:06X}", 'proto': r['proto'], 'idx': r['idx'],
                         'internal': f"0x{inter:04X}",
                         'src': f'tabB{rank + 1}',
                         'rowOff': f"PORSCHE_SYS_DATA.BIN:{r['off']}"})
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
        if GG.get(sysid):
            e['genSiblings'] = sorted(f'0x{s:04x}' for s in GG[sysid])
        if unresolved:
            e['joinUnresolved'] = unresolved
            e['joinState'] = 'unresolved' if not rows else 'partial'
            # ★ 2026-11-09(3)：码像候选（internal 经 TransCanCalcID 反解）**撤销**——
            #   被发现机制取代（发现循环候选源=SpecArray/表行，RE-ICADDR §3.2；
            #   GetData FILE:0x160fc 装载体 + Mode_1000/1001 发现循环转写后，码像无机制依据）。
        if families.get(sysid):
            e['family'] = families[sysid]
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
        'schemaVersion': 6,
        'source': 'PORSCHE_SYS_DATA.BIN 表B/表A 结构化行（精确 internal join）+ ALL_ACTINFO internal|flags 行',
        'note': ('proven=真机锚点；table-unique=诊断段候选唯一；candidate=短名单定向探测+识别串终审。'
                 'v6=低字节 join 退役（真车证伪 0x721/722/723 NO DATA），无精确表A 行=joinState:unresolved；'
                 'family=DRIVELINKS 14B 记录族（通用运行时候选族，识别串匹配才算命中）。'),
        'probeRule': ('候选序=表行序（cands）→family；接受=识别串匹配模块名（strcmp/前缀/strstr）；'
                      'NRC=有 ECU 但身份不符，不算候选；KWP 只发 21 01/1A xx，UDS 走 22 14 09 族'),
        'entries': entries,
        'anchorNote': '6 条 proven 来自真机实测锚点（2026-10-19 验证 6/6 命中）。',
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    print(f"写出 {OUT} · {len(entries)} 条（proven {stat['proven']} · unique {stat['unique']} · "
          f"multi {stat['multi']} · none {stat['none']}）")


if __name__ == '__main__':
    main()
