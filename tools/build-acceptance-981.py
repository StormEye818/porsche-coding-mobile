#!/usr/bin/env python3
"""981 全模块验收表生成器（2026-11-09 用户追加验收①）。

对 981（Cayman/Boxster 981 数据集）菜单可达的**每一个模块**输出四元组：
  数据家族 | 变体匹配键 | 地址来源 | 读写帧格式
+ VA 出处（家族/变体/帧来源逐行带证据锚）。任何模块缺一项=验收失败（生成器自检）。

数据源（全部包内实证）：
  menu-tree-v3.json          菜单可达模块集（Cayman（981）/Boxster（981）systems[].modules）
  module-family.json         模块记录 SID 统计（KWP 21/3B vs UDS 22/2E 计数）
  ident-registry.json        DSN.BIN 识别串注册表（身份记录 SID/ID + 变体 DSN 码）
  ecu-part-map.json          JOB.BIN 件号→(模块,变体)（checkPartNumber ACTF:0x4e00c 分词语义）
  module-ecu-map.js/ecu-addresses.json  sysId→tx/rx（PORSCHE_SYS_DATA.BIN 表A/表B）
用法： python3 tools/build-acceptance-981.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
OUT = DATA / 'acceptance-981-modules.tsv'

VA_FAMILY = ('家族:DSN.BIN 模块记录(SearchTxtByID libSTD:0x17835→GetTextFromTextLib libSTD:0x255ac)'
             '+JOB.BIN ECU-REFS(checkPartNumber ACTF:0x4e00c/IsMatchName ACTF:0x5f8ba)')
VA_FRAME = '帧:记录 SID 成帧(SysTemReadData READWRITE:0x0F830D/SysTemWriteData READWRITE:0x0F855D)'
VA_ADDR = ('址:表A/表B 精确 internal join(Xml_GetDriveLinksEntry FILE:0x188e4/'
           'Xml_GetDriveLinksAddress FILE:0x18a0c 11B 行原样转写/GetSubSysDataAddr FILE:0x15c18；'
           'join 链无 internal→CAN 换算=RE-ICADDR-20261109 §2/§3 逐指令转写)')


def menu_modules():
    mt = json.loads((DATA / 'menu-tree-v3.json').read_text())
    out = []
    for g in mt.get('groups', []):
        for m in g.get('models', []):
            if m.get('id') in ('Cayman（981）', 'Boxster（981）'):
                for fn in m.get('functions', []):
                    for s in fn.get('systems', []):
                        for mod in s.get('modules', []):
                            if mod not in out:
                                out.append(mod)
    return out


def load_module_ecu_map():
    src = (ROOT / 'src' / 'module-ecu-map.js').read_text()
    out = {}
    # 键值可单引号或双引号（module-ecu-map.js 现为双引号）
    for m in re.finditer(r"['\"]([^'\"]+)['\"]\s*:\s*['\"](0x[0-9a-fA-F]+)['\"]", src):
        out[m.group(1)] = m.group(2)
    return out


def main():
    cat = json.loads((DATA / 'models-catalog.json').read_text())
    mf = json.loads((DATA / 'module-family.json').read_text())
    reg = json.loads((DATA / 'ident-registry.json').read_text())
    pm = json.loads((DATA / 'ecu-part-map.json').read_text())
    addr = json.loads((DATA / 'ecu-addresses.json').read_text())
    mod2ecu = load_module_ecu_map()
    addr_by_sysid = {e['sysId']: e for e in addr.get('entries', [])}

    mods = menu_modules()
    catmods = {}
    for key in ('Cayman（981）', 'Boxster（981）'):
        for x in (cat['models'].get(key, {}) or {}).get('modules', []):
            catmods.setdefault(x['module'], x)

    rows = []
    missing = []
    for mod in sorted(set(mods) | set(catmods)):
        # ① 数据家族（记录 SID 族）
        st = mf.get(mod) or {}
        kwp, uds = st.get('kwp', 0), st.get('uds', 0)
        if kwp and uds:
            fam = f'混合（KWP 21/3B×{kwp} + UDS 22/2E×{uds}）'
        elif kwp:
            fam = f'KWP（21/3B×{kwp}）'
        elif uds:
            fam = f'UDS（22/2E×{uds}）'
        else:
            fam = ''
        # ② 变体匹配键（识别串请求 + DSN 码集 + 件号键数）
        mi = reg['moduleIdent'].get(mod, {})
        req = mi.get('request', '')
        codes = sorted({c for c, hits in reg['identToVariant'].items()
                        if any(h['module'] == mod for h in hits)})
        part_keys = [pn for pn, es in pm['byPart'].items() if any(e.get('module') == mod for e in es)]
        vkey = f'识别串 {req}→DSN码 {len(codes)} 个' if codes else (
            '识别串:DSN.BIN 无身份记录（回落件号/协议族）' if not req else f'识别串 {req}（无码集）')
        vkey += f'；件号键 {len(part_keys)} 条（JOB.BIN）'
        # ③ 地址来源（RE-ICADDR-20261109 通用口径：精确 internal join + 逐行偏移证据）
        #   join 键=SYS_DATA 表B f1（routing internal 精确全等）；tx=表A f0 行（每行留偏移）；
        #   无精确表A 行=未决（低字节近似 join 已真车证伪退役，禁止任何形式近似 join）。
        ecu = mod2ecu.get(mod)
        ent = addr_by_sysid.get(ecu) if ecu else None
        if ent:
            keys = ';'.join(ent.get('internals') or []) or '未决'
            cands = ent.get('cands') or []
            rows_ev = ' | '.join(f"{c['tx']}@{c.get('rowOff', '?')}" for c in cands[:6])
            if len(cands) > 6:
                rows_ev += f' | …共{len(cands)}行'
            if ent.get('tx') is not None:
                addr_s = (f"joinKey {keys} → tx 0x{int(ent['tx'], 16):03X}/rx 0x{int(ent['rx'], 16):03X}"
                          f"（{ent.get('confidence', '?')}）；表A行 {rows_ev or '无'}")
            elif cands:
                addr_s = (f"joinKey {keys} → 精确 join 候选 {len(cands)} 行（身份匹配探测择址）；"
                          f"表A行 {rows_ev}")
            else:
                addr_s = f'joinKey {keys} → 无表A 行'
            if ent.get('joinUnresolved'):
                u = ';'.join(f"{x['internal']}(proto{x.get('proto')})@{','.join(x.get('tabBRows') or [])}"
                             for x in ent['joinUnresolved'])
                addr_s += f'；未决 join：{u}（码像候选已被发现机制取代：候选源=SpecArray/表行，RE-ICADDR §3.2）'
            if ent.get('family'):
                f14 = sorted({str(f['tx']) for f in ent['family'] if 'code-image' not in str(f.get('src', ''))})
                fci = sorted({str(f['tx']) for f in ent['family'] if 'code-image' in str(f.get('src', ''))})
                if f14:
                    addr_s += f'；14B 记录族 {",".join(f14)}（运行时候选，RE-ICADDR §4）'
                if fci:
                    addr_s += f'；码像候选 {",".join(fci)}（未证，RE-ICADDR §3.1）'
        else:
            addr_s = '无表行（进模块短名单探测+识别串终审）'
        # ④ 读写帧格式
        if kwp and uds:
            frame = '混合：读 21 <LID8>/22 <DID16>（按记录 readSid）· 写 3B/2E（按记录 writeSid）'
        elif kwp:
            frame = '读 21 <LID8> · 写 3B <LID8>'
        elif uds:
            frame = '读 22 <DID16> · 写 2E <DID16>'
        else:
            frame = ''
        for name, val in (('数据家族', fam), ('变体匹配键', vkey), ('地址来源', addr_s), ('读写帧格式', frame)):
            if not val:
                missing.append((mod, name))
        rows.append([mod, fam, vkey, addr_s, frame, VA_FAMILY, VA_FRAME, VA_ADDR])

    header = ['模块', '数据家族', '变体匹配键', '地址来源', '读写帧格式', 'VA出处-家族/变体', 'VA出处-帧', 'VA出处-地址']
    lines = ['\t'.join(header)]
    lines += ['\t'.join(r) for r in rows]
    OUT.write_text('\n'.join(lines) + '\n')
    print(f'{len(rows)} 模块 → {OUT}')
    if missing:
        print('❌ 缺项：', missing)
        sys.exit(1)
    print('✅ 四元组无缺项')


if __name__ == '__main__':
    main()
