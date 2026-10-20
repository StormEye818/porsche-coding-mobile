#!/usr/bin/env python3
"""把 参考诊断仪中文特殊功能菜单项映射到各平台的实现函数，生成 data/special-function-map.json。

为什么不用自动关键词匹配：
  自动匹配会把「节气门匹配」对到 `TPM_SysAdaptation`（胎压），把「HUD 校准」
  对到 PSM 校准 —— 在真车上发错例程是危险的。所以映射表 tools/special-map-table.json
  是人工核对过的，脚本只做解析、平台归类和完整性校验。

平台归属由函数名前缀推断，与 src/seedkey-nonasap.js 的 MODEL_PLATFORM 同一套码
（9X1 / 9X6 / 9X7 / 992 / 918S / CS1 / G1 / G2 / G3 / CAJUN / E1 / E2 / E3 / J1）。
推不出的记为 ALL（平台无关的公共实现）。

用法：
  python3 tools/build-special-map.py
  python3 tools/build-special-map.py --report   # 额外打印各平台覆盖率
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEQ = ROOT / 'data' / 'function-sequences.json'
SF = ROOT / 'data' / 'special-functions.json'
TABLE = ROOT / 'tools' / 'special-map-table.json'
OUT = ROOT / 'data' / 'special-function-map.json'

# 函数名前缀 → 平台码（一个函数可能属于多个平台，如 E3G2_ 同时用于 E3/G2）
PLATFORM_RULES = [
    (r'^E3G2_', ['E3', 'G2']),
    (r'^G3G2_', ['G3', 'G2']),
    (r'^P9X1_|^P9x1_', '9X1'),
    (r'^P9x6_|^P9X6_', '9X6'),
    (r'^P9x7_|^P9X7_|^P997_|^p9x7_', '9X7'),
    (r'^P992_', '992'),
    (r'^P918_', '918S'),
    (r'^CS1_', 'CS1'),
    (r'^CAY9PA|^Cayenne_9PA', 'G1'),
    (r'^CAY92A|^Cayenne_2010|^Cayenne_2011|^Cayenne_92A|^Cayenne2011', 'G2'),
    (r'^CAY9YA|^Cayenne_9YA', 'G3'),
    (r'^PAN970|^Panamera_970|^Panamer970', 'E1'),
    (r'^PAN971|^Panamera_971', 'E2'),
    (r'^Cayenne_|^CAYENNE_', 'G2'),
    (r'^Panamera_|^PANAMERA_', 'E2'),
    (r'^Macan|^MACAN', 'CAJUN'),
    (r'^PJ1_|^J1_', 'J1'),
    (r'^E1_', 'E1'), (r'^E2_', 'E2'), (r'^E3_', 'E3'),
    (r'^G1_', 'G1'), (r'^G2_', 'G2'), (r'^G3_', 'G3'),
    (r'^PE3_', 'E3'),
]


def platform_of(name):
    """返回平台码列表。空列表表示平台无关（ALL），由调用方处理。"""
    for pat, plat in PLATFORM_RULES:
        if re.search(pat, name, re.I):
            return plat if isinstance(plat, list) else [plat]
    return []


def norm_sys(s):
    """与 app 侧同一套归一化：小写，只留字母数字和汉字。"""
    return re.sub(r'[^a-z0-9\u4e00-\u9fff]', '', str(s or '').lower())


# 中文系统名 → 菜单树里的模块/系统关键词。
# 菜单树用 ECU 名（PASM_PADM / EPB / Kombiinstrument_MM），
# 菜单用中文功能名（组合仪表 / 驻车制动器），两边只能靠这张表接上。
SYSTEM_ALIASES = {
    'Tiptronic 变速器控制': ['TIP', 'PDK', 'GETRIEBE', 'TCM'],
    '乘客侧座椅位置记忆': ['SITZ', 'DSM'],
    '驾驶员侧座椅记忆': ['SITZ', 'DSM'],
    'PASM（保时捷主动悬架管理系统）': ['PASM', 'PADM'],
    'ESP/PSM(电控稳定系统)': ['PSM'],
    'PCM（保时捷通信管理系统）': ['PCM', 'MOST', 'HEAD_UNIT', 'INFORCONTR'],
    '前端电子设备': ['BCM_VORNE'],
    'ECM/DME(发动机控制模块)': ['DME', 'ECM', 'MED', 'BDE'],
    '组合仪表': ['KOMBI'],
    '网关': ['GATEWAY', 'GAT'],
    '车道变换辅助系统，右侧（主设备）': ['SWA', 'LANECHANG', 'SPUR'],
    '车道变换辅助系统，左侧（从动设备）': ['SWA', 'LANECHANG', 'SPUR'],
    '转向盘电子设备': ['LENKSTOCK', 'LWS', 'STEERING_COLUMN'],
    '驻车制动器': ['EPB', 'PBM', 'PARKBREMSE'],
    'AC(空调系统)': ['BKE', 'KLIMA', 'AIRCOND'],
    'SRS(安全气囊)': ['AIRBAG', 'SRS'],
    '全轮驱动': ['VTG', 'ALLRAD', 'PTM', 'TRANSFER'],
    '平视显示器': ['HUD'],
    '水平高度控制/PASM': ['LEC', 'PASM'],
    '灯光电子': ['SCHEINWERFER', 'LHB'],
    '通讯连接系统': ['CONNECT', 'TELEMAT'],
    '后端电子设备': ['BCM_HINTEN'],
    '动力机组支承': ['TME', 'LAGER'],
    '可折叠顶篷': ['VERDECK', 'DACH', 'REA'],
    '座椅记忆': ['SITZ', 'DSM'],
    'EPS(电动助力转向系统)': ['EPS', 'STEERING_CONTROL'],
    '轮胎压力监控 （TPM）': ['RDK', 'TPM'],
}


def main():
    seq = json.loads(SEQ.read_text())
    sf = json.loads(SF.read_text())
    table = json.loads(TABLE.read_text())

    funcs = seq['functions']
    by_name = {f['name']: f for f in funcs}
    for f in funcs:
        plats = platform_of(f['name'])
        f['platforms'] = plats or ['ALL']

    # menuId → 表项（重复即视为配置错误）
    tmap = {}
    for t in table['items']:
        if t['menuId'] in tmap:
            raise SystemExit(f'映射表 menuId 重复：{t["menuId"]}')
        tmap[t['menuId']] = t

    maps = []
    problems = []
    for it in sf['functions']:
        t = tmap.get(it['routineId'])
        if not t:
            problems.append(f'映射表缺条目：{it["routineId"]} {it["sub"]}')
            t = {'patterns': [], 'match': 'none'}

        impls = []
        seen = set()
        for order, pat in enumerate(t['patterns']):
            rx = re.compile(pat, re.I)
            for f in funcs:
                if f['name'] in seen or not rx.search(f['name']):
                    continue
                seen.add(f['name'])
                impls.append({
                    'name': f['name'],
                    'platforms': f['platforms'],
                    'cmdCount': f['cmdCount'],
                    'rids': f['rids'],
                    '_order': order,
                    # 不重复存 cmds —— 执行时按 name 从 function-sequences.json 取
                })
            if len(impls) >= 8:
                break

        # 保持 pattern 优先级：表里写得越靠前越贴近该菜单项语义；
        # 平台无关实现（ALL）排在同优先级的后面，避免盖掉平台专属实现。
        impls.sort(key=lambda x: (x['_order'], x['platforms'] == ['ALL']))
        for x in impls:
            x.pop('_order', None)

        platforms = []
        for x in impls:
            for p in x['platforms']:
                if p not in platforms:
                    platforms.append(p)

        # 有符号、但静态解析不出命令序列（命令在运行时拼）：
        # 仍然列出来，但标 no-seq，app 不给执行按钮。
        if not impls and t.get('symbols'):
            for s in t['symbols']:
                impls.append({
                    'name': s['name'], 'platforms': s['platforms'],
                    'cmdCount': 0, 'rids': [], 'cmds': [],
                })
                for p in s['platforms']:
                    if p not in platforms:
                        platforms.append(p)

        status = 'ok' if any(x['cmdCount'] for x in impls) else (
            'no-seq' if impls else ('no-impl' if t['match'] in ('none', 'no-seq') else 'missing'))

        maps.append({
            'menuId': it['routineId'],
            'system': it['system'],
            'sub': it['sub'],
            'risk': it.get('risk') or 'medium',
            'verified': t.get('verified', True),
            'unverifiedReason': t.get('unverifiedReason', ''),
            'img': it.get('img') or '',
            'status': status,
            'match': t['match'],
            'platforms': platforms,
            'impls': impls,
        })

    ok = sum(1 for m in maps if m['status'] == 'ok')
    out = {
        'schemaVersion': 1,
        'kind': 'special-function-map',
        'source': '特殊功能项与各平台实现的对应关系（人工核对）',
        'note': ('每个功能项给出各平台的实现函数与命令序列。app 只展示当前车型平台有实现且序列非空的项；'
                 '跨平台 RID 与 ECU 绑定，不执行。'),
        'count': len(maps),
        'mapped': ok,
        'systemAliases': {norm_sys(k): v for k, v in SYSTEM_ALIASES.items()},
        'maps': maps,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n')

    print(f'菜单项 {len(maps)} | 有实现 {ok} | 无实现 {len(maps) - ok}')
    if problems:
        print('\n问题：')
        for p in problems:
            print('  ' + p)
    print('\n无实现清单：')
    for m in maps:
        if m['status'] != 'ok':
            print(f"  {m['menuId']} [{m['system']}] {m['sub']}  ({m['match']})")

    if '--report' in sys.argv:
        print('\n各平台可执行覆盖率（67 项为分母）：')
        plats = ['9X1', '9X6', '9X7', '992', '918S', 'CS1', 'G1', 'G2', 'G3', 'CAJUN', 'E1', 'E2', 'E3', 'J1']
        for p in plats:
            n = sum(1 for m in maps
                    if any(p in x['platforms'] or x['platforms'] == ['ALL'] for x in m['impls']))
            print(f'  {p:<6} {n:>3}/{len(maps)}')


if __name__ == '__main__':
    main()
