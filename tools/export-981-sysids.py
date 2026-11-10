#!/usr/bin/env python3
"""export-981-sysids.py — 981（9X1）模块 → 0x0E 代 sysId 静态解析导出器。

数据链（全部包内字节证据，2026-11-10 第三轮定案，见 RE-SYSDATA-ROWS-20261110.md §2）：
  1. 9X1_ALLDATA.BIN 顶级目录：[u8 sysCount=56][u16 nlen][name\\0][u32 sysOff]×56
     系统区：[u32 varCount][u8 0] + varCount × [u16 nlen][vname\\0][u32 varPtr][u32 X]
  2. PORSCHE_SYS_DATA.BIN 9X1 段（≈57900–81500）名字记录：
     [前缀（可含 sysId 指派段）][u16 len][name\\0][6×u32 池指针]
     name-9 法：flag u16@name-11、sysId u32@name-9、len u16@name-2（len==strlen+1 校验）。
  3. 逐系统「变体名投票」：9X1_ALLDATA 每系统全部变体名在 SYS_DATA 全表检索
     flag∈{1,2,3} 的记录，0x0E 代票即该系统 sysId。
  4. 无 0x0E 票的系统按证据规则收口：
     - 段内邻接（同段相邻记录的 sysId，DME 家族 / Verdeck_Targa / Lift_VA_Gen2 /
       ERA_GLONASS_VFA / RDK3→RDK 等）；
     - DRIVELINKS 键存在性（LCA 0x0F4D：唯一含 0x6CC–0x6CF 直连键的 ecu 键）；
     - SCHEINWERFER_LED 双记录 0x0E2F/0x0E30（左右），SWSG 无独立 sysId → 归 0x0E2F/0x0E30
       （0x0B 代同构证据：SWSG_mit_AFS_ALWR 0x0B2F/0x0B30）。

输出 data/981-sysids.json：
  { "schemaVersion":1, "modules": { "<module>": {
      "sysId":"0x0Exx", "sysIds":["0x0Exx",...](左右双记录), "method":"vote|adjacency|…",
      "evidence":"…" } }, "votes": {...原始票…} }
用法： python3 tools/export-981-sysids.py
"""
import json
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYS = Path('/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN')
ALL = Path('/Users/se818/porsche-mapper/ref/decoded/9X1_ALLDATA.BIN')
V3 = ROOT / 'data' / 'drivelinks-v3.json'
OUT = ROOT / 'data' / '981-sysids.json'

# 验收模块清单（48，data/acceptance-981-modules.tsv 第 1 列）
ACCEPT = [l.split('\t')[0] for l in
          (ROOT / 'data' / 'acceptance-981-modules.tsv').read_text().splitlines()[1:] if l.strip()]

# 手工收口规则（证据列内注明；均为段内邻接/同构/键存在性，非锚点地址）
OVERRIDES = {
    # DME 家族：BV_ECM_UDS(62905-63834) + BV_EnginContrModul1UDS(63834-64773) 段
    # 夹在 DME_BDE(60979,0x0E01)/MED17(62460,0x0E01) 与 Airbag(64869) 之间 → 0x0E01
    'BV_ECM_UDS': ('0x0e01', 'adjacency', '段 62905-63834 夹在 DME_BDE(0x0E01@60979)/MED17(0x0E01@62460) 与 Airbag(0x0E04@64869) 之间'),
    'BV_EnginContrModul1UDS': ('0x0e01', 'adjacency', '段 63834-64773 同上 DME 家族簇；且 9X1_ALLDATA 命令行区 3344 行 [u16 can][02 f0] 全部属于其池'),
    'MED17_1_11': ('0x0e01', 'vote', 'MED17_1_11_BaseSys@62460 flag=2 sysId=0x0E01'),
    # Verdeck_Targa 段 72993-73207 夹在 Verdeck_Synchronisation(0x0E27@72876) 与 PDCC_2(0x0E2B@73289) 之间
    'Verdeck_Targa': ('0x0e27', 'adjacency', '段 72993-73207 紧邻 Verdeck_Synchronisation(0x0E27@72876)'),
    # Lift_VA_Gen2 段 79719-79809 紧邻 Lift_VA(0x0E5B@79601)
    'Lift_VA_Gen2': ('0x0e5b', 'adjacency', '段 79719-79809 紧邻 Lift_VA(0x0E5B@79601)'),
    # ERA_GLONASS_VFA 段 81084-81134 紧邻 ERA_GLONASS(0x0EA5@80991)
    'ERA_GLONASS_VFA': ('0x0ea5', 'adjacency', '段 81084-81134 紧邻 ERA_GLONASS(0x0EA5@80991)'),
    # BV_InforContrUnit1UDSDesay@81423 紧随 BV_InforContrUnit1UDS(0x0E46@81222)
    'BV_InforContrUnit1UDSDesay': ('0x0e46', 'adjacency', '记录@81423 紧随 BV_InforContrUnit1UDS(0x0E46@81222)'),
    # RDK3 981 段记录@81722+ 全 flag=0，紧随 RDK(0x0E37@81582)；他代 RDK3=0x0C37/0x0F37
    'RDK3': ('0x0e37', 'adjacency', '981 段 RDK3 记录@81722+ 全 flag=0，紧随 RDK_BaseSys(0x0E37@81582)；0x0C/0x0F 代 RDK3 独立 sysId 不适用于 981'),
    # SWSG：981 无独立名字记录；0x0B 代同构 SWSG_mit_AFS_ALWR=0x0B2F/0x0B30 ↔ SCHEINWERFER_LED 0x0E2F/0x0E30
    'SWSG': ('0x0e2f', 'isomorphic', 'SWSG 981 无名字记录；0x0B 代 SWSG_mit_AFS_ALWR=0x0B2F/0x0B30 与 SCHEINWERFER_LED 0x0E2F/0x0E30 同构；DRIVELINKS 0x0E2F/0x0E30 均含直连键 0x00300763/0x00300764（=SWSG 大灯随动）'),
    # LCA：无名字记录；DRIVELINKS 中唯一持有 0x6CC-0x6CF 直连键的 ecu 键为 0x0F4D
    'BV_ContrUnitLaneChangAssis2UDS': ('0x0f4d', 'drivelinks-key', '无名字记录；drivelinks-v3 键 0x0f4d 独占直连键 0x003006CC-0x003006CF（lane change assist 惯用段）'),
    # Head_Unit 与 BV_InforContrUnit1UDS 同为 0x0E46（投票双确认）
    'Head_Unit': ('0x0e46', 'vote', 'Head_Unit_BaseSys@74583 flag=1 sysId=0x0E46'),
}


def parse_alldata_variants(A):
    """9X1_ALLDATA：系统 → 变体名列表。"""
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
        cnt, = struct.unpack_from('<I', A, off)
        if A[off + 4] != 0:
            raise SystemExit(f'9X1_ALLDATA 系统区 pad 校验失败: {name}@{off}')
        j = off + 5
        vs = []
        for _ in range(cnt):
            nlen, = struct.unpack_from('<H', A, j)
            vname = A[j + 2:j + 2 + nlen - 1].decode('latin1')
            vs.append(vname)
            j += 2 + nlen + 8
        out[name] = vs
    return out


def scan_name_records(S):
    """SYS_DATA 全表 name-9 记录：名字 → [(offset, flag, sysId)]。"""
    idx = defaultdict(list)
    for m in re.finditer(rb'[A-Za-z][A-Za-z0-9_]{2,40}\x00', S):
        p = m.start()
        nm = m.group()[:-1].decode('latin1')
        if p < 11:
            continue
        ln, = struct.unpack_from('<H', S, p - 2)
        if ln != len(nm) + 1:
            continue
        flag, = struct.unpack_from('<H', S, p - 11)
        sysid, = struct.unpack_from('<I', S, p - 9)
        idx[nm].append((p, flag, sysid))
    return idx


def main():
    S = SYS.read_bytes()
    A = ALL.read_bytes()
    v3 = json.loads(V3.read_text())
    dl_keys = set(v3.get('ecu', {}).keys())

    sys_vars = parse_alldata_variants(A)
    name_idx = scan_name_records(S)

    votes = {}
    sysid_by_sys = {}
    for sysname, vs in sys_vars.items():
        c = Counter()
        for vn in vs:
            for p, flag, sid in name_idx.get(vn, []):
                if flag in (1, 2, 3):
                    c[sid] += 1
        votes[sysname] = {f'0x{k:04x}': v for k, v in c.items()}
        oe = [(sid, v) for sid, v in c.items() if 0x0E00 <= sid <= 0x0EFF]
        if oe:
            oe.sort(key=lambda x: -x[1])
            sysid_by_sys[sysname] = ('0x%04x' % oe[0][0], 'vote',
                                     '变体名投票 ' + '/'.join(f'0x{k:04x}×{v}' for k, v in oe))

    # 双记录系统（左右件）：SCHEINWERFER_LED 0x0E2F/0x0E30、TUER/Sitz/HAL 各两枚
    dual = {
        'SCHEINWERFER_LED': ['0x0e2f', '0x0e30'],
        'TUER_VORNE': ['0x0e1e', '0x0e1f'],
        'TUER_HINTEN': ['0x0e4f', '0x0e50'],
        'Sitzsteuergeraet': ['0x0e4c', '0x0e4e'],
        'Hinterachslenkung': ['0x0e59', '0x0e5a'],
    }

    modules = {}
    for mod in ACCEPT:
        if mod in OVERRIDES:
            sid, method, ev = OVERRIDES[mod]
            modules[mod] = {'sysId': sid, 'sysIds': [sid], 'method': method, 'evidence': ev}
        elif mod in sysid_by_sys:
            sid, method, ev = sysid_by_sys[mod]
            entry = {'sysId': sid, 'sysIds': dual.get(mod, [sid]), 'method': method, 'evidence': ev}
            modules[mod] = entry
        else:
            modules[mod] = {'sysId': None, 'sysIds': [], 'method': 'unresolved', 'evidence': '9X1_ALLDATA 无此系统'}

    # 交叉校验：sysId 必须出现在 DRIVELINKS 目录（209 键）内，否则降级标注
    for mod, e in modules.items():
        missing = [s for s in e['sysIds'] if s and s not in dl_keys]
        if missing:
            e['drivelinksMissing'] = missing

    ok = sum(1 for e in modules.values() if e['sysId'])
    doc = {
        'schemaVersion': 1,
        'source': '9X1_ALLDATA 顶级目录/系统区 + PORSCHE_SYS_DATA name-9 变体名投票 + 段内邻接收口',
        'method': 'name-9: flag u16@name-11, sysId u32@name-9, len u16@name-2 (len==strlen+1); flag∈{1,2,3} 记录带有效 sysId; 981 段≈57900-81500',
        'stats': {'resolved': ok, 'total': len(modules)},
        'modules': modules,
        'votes': votes,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{ok}/{len(modules)} 模块解析 → {OUT.name}')
    for mod, e in sorted(modules.items()):
        mark = '✅' if e['sysId'] else '❌'
        extra = ' ⚠️drivelinks缺' + ','.join(e.get('drivelinksMissing', [])) if e.get('drivelinksMissing') else ''
        print(f'  {mark} {mod:34s} {e["sysId"] or "—":8s} [{e["method"]}]{extra}')
    if ok < 40:
        print('❌ 验收线 40 未达')
        sys.exit(1)
    print('✅ ≥40 静态解析达标')


if __name__ == '__main__':
    main()
