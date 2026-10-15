#!/usr/bin/env python3
"""特殊功能清单构建 / 校验。

⚠️ 权威源（2026-10-15 从 参考实现分析得出，见
   ~/mes-reverse/rea-evidence/x431-apk-findings.md）：
   app 侧特殊功能配置是 **`特殊功能配置文件`** —— 标准 INI 文本（UTF-8，`[SECTION]` + `key=value`），
   由 `参考实现的配置解析器` 解析。
   **`[SYS_SPEC]` 节里值为 `1` 的 key = 有特殊功能的系统 ID**（`getSysIDHasSpec`）。

   本脚本当前**没有 特殊功能配置文件**（它在车机/SD 卡侧，不在 APK 里），
   所以只做：
     ① 给现有 `data/special-functions.json` 补 `systemId`（= systemCatalog 的 ecu 号）
     ② 校验系统名能对上 systemCatalog（对不上就是 module-map 有问题）
     ③ 留好 `[SYS_SPEC]` 的接入点 —— 拿到 特殊功能配置文件 后用 --spe-cfg 传进来即可对账

用法：
  python3 build-special-functions.py                     # 校验 + 回填 systemId
  python3 build-special-functions.py --spe-cfg 特殊功能配置文件  # 与权威源对账
  python3 build-special-functions.py --dry-run           # 只看差异不写
"""
import json, sys, os, re, argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SF = ROOT / 'data' / 'special-functions.json'
TREE = ROOT / 'data' / 'x431-tree-v2.json'


# 系统名别名表：special-functions.json 里的旧称 → systemCatalog 的正式 label。
# 2026-10-15 实测有 14 条对不上，分三类：
#   ① 全角/半角括号不一致（车道变换辅助 ×2）
#   ② 用了俗称而非正式名（保时捷主动悬挂/稳定/通讯管理系统、发动机、轮胎压力监控）
#   ③ **真的对不上，不猜**（前照灯 / BCM）—— 标 needsReview，等深挖 431 菜单确认
ALIAS = {
    '保时捷主动悬挂管理系统': 'PASM（保时捷主动悬架管理系统）',
    '保时捷稳定管理系统': 'ESP/PSM(电控稳定系统)',
    '保时捷通讯管理系统': 'PCM（保时捷通信管理系统）',
    '发动机': 'ECM/DME(发动机控制模块)',            # 条目是「节气门匹配」，属发动机 ECU
    '车道变换辅助系统，右侧(主设备)': '车道变换辅助系统，右侧（主设备）',   # 半角→全角括号
    '车道变换辅助系统，左侧(从动设备)': '车道变换辅助系统，左侧（从动设备）',  # 同上
    '轮胎压力监控': '轮胎压力监控 （TPM）',
}
# ③ 不猜 —— 候选有多个或对不上，留人工确认（遵守「和 431 对齐前先深挖、拒绝闷头改」）
# 2026-10-16 补充：APK 里没有 DFM/Headlight 硬编码类（纯数据驱动），归属必须等 特殊功能配置文件。
# 图片名给了线索但不足以定论，故按证据强弱排序候选：
#   BCM(车身控制) / DFM 连接 → img `SPEC-CONNECT-DFM-01/02`
#       「车身控制」语义最接近 systemCatalog 的 `车辆电气系统`(ecu=11)；`网关` 是另一条目在用
#   前照灯 / 前照灯调节 → img `HEADLIGHT_ADJUST-01..03`（3 步，是「调节/对光」不是点灯）
#       对光调平通常是中央功能 → `中央前照灯` 优先；但左右大灯控制单元也不能排除
NEEDS_REVIEW = {
    '前照灯': ['中央前照灯', '大灯控制单元-左', '大灯控制单元-右', '左前照灯', '右前照灯'],
    'BCM(车身控制)': ['车辆电气系统', '网关'],
}


def parse_ini_sections(path):
    """标准 INI：[SECTION] + key=value。与 参考实现的配置解析器.iniReaderHasSection 同语义
    （它按 `\\[.*\\]` 判节头，返回 Map<节名, Properties>）。"""
    sections = {}
    cur = None
    for raw in open(path, encoding='utf-8'):
        line = raw.strip()
        if not line or line.startswith((';', '#')):
            continue
        if re.fullmatch(r'\[.*\]', line):
            cur = line[1:-1].strip()
            sections.setdefault(cur, {})
            continue
        if '=' in line and cur is not None:
            k, v = line.split('=', 1)
            sections[cur][k.strip()] = v.strip()
    return sections


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spe-cfg', help='特殊功能配置文件 路径（拿到真车/SD 卡的那份后传进来对账）')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    sf = json.loads(SF.read_text(encoding='utf-8'))
    tree = json.loads(TREE.read_text(encoding='utf-8'))
    catalog = tree.get('systemCatalog') or {}

    # label → ecu 号
    label2ecu = {}
    for key, node in catalog.items():
        lab = (node or {}).get('label') or (node or {}).get('id') or key
        ecu = (node or {}).get('ecu')
        if lab and ecu is not None:
            label2ecu[lab] = ecu

    fns = sf.get('functions') or []
    print(f'special-functions.json: {len(fns)} 条')

    added = aliased = unmatched = 0
    review = {}
    for f in fns:
        lab = f.get('system')
        # ① 别名归一
        if lab in ALIAS:
            new = ALIAS[lab]
            print(f'  ~ 别名归一: {lab!r} → {new!r}')
            f['system'] = new
            f['systemAliasFrom'] = lab
            lab = new
            aliased += 1
        ecu = label2ecu.get(lab)
        if ecu is None:
            if lab in NEEDS_REVIEW:
                f.pop('systemId', None)
                f['needsReview'] = {
                    'reason': f'系统名 {lab!r} 不在 systemCatalog，候选需人工确认',
                    'candidates': NEEDS_REVIEW[lab],
                }
                review.setdefault(lab, 0)
                review[lab] += 1
            else:
                unmatched += 1
                print(f'  ✗ 系统名对不上 systemCatalog: {lab!r}')
            continue
        f.pop('needsReview', None)
        if f.get('systemId') != ecu:
            f['systemId'] = ecu
            added += 1

    print(f'  回填 systemId: {added} 条 · 别名归一: {aliased} 条 · 待人工确认: {sum(review.values())} 条 · 对不上: {unmatched} 条')
    for lab, n in review.items():
        print(f'    ⏳ {lab!r} × {n} → 候选 {NEEDS_REVIEW[lab]}')

    # img 缺口（UX）
    noimg = [f for f in fns if not f.get('img')]
    print(f'  ⚠️ 缺图 {len(noimg)}/{len(fns)} 条（UI 上是空白图标）')

    # risk 分布
    from collections import Counter
    print('  risk:', dict(Counter(f.get('risk') for f in fns)))
    print('  不同 systemId:', len({f.get('systemId') for f in fns}),
          '· 不同 routineId:', len({f.get('routineId') for f in fns}))

    # ---- 与权威源对账（可选）----
    if args.spe_cfg:
        secs = parse_ini_sections(args.spe_cfg)
        sys_spec = secs.get('SYS_SPEC') or secs.get('sys_spec') or {}
        authoritative = {k for k, v in sys_spec.items() if str(v).strip() == '1'}
        print(f'\n[特殊功能配置文件] [SYS_SPEC] 中值为 1 的 key = {len(authoritative)} 个')
        ours = {f.get('systemId') for f in fns if f.get('systemId') is not None}
        # 配置 的 key 大概率是模块/系统 ID，与 ecu 号同口径后比对
        missing = authoritative - {str(x) for x in ours}
        extra = {str(x) for x in ours} - authoritative
        print(f'  我们有但权威源没有（多做）: {sorted(extra)[:20]}')
        print(f'  权威源有但我们缺（漏做）: {sorted(missing)[:20]}')
    else:
        print('\n（未提供 --spe-cfg —— 无法与权威源对账。'
              '特殊功能配置文件 在车机/SD 卡侧，拿到后用 --spe-cfg 传入。）')

    if args.dry_run:
        print('\n--dry-run：不写回')
        return
    # ⚠️ 与 build-special-pics.py 协同：schemaVersion 取两者较大值，且不要动 imgSteps
    # （两个脚本都写同一文件，先后顺序不能互相降级/覆盖）
    sf['schemaVersion'] = max(int(sf.get('schemaVersion') or 1), 3)
    src = sf.setdefault('source', {})
    src['note'] = '手工整理 + systemId 回填。权威源应为 特殊功能配置文件 的 [SYS_SPEC] 节（见 build-special-functions.py 顶部注释）'
    src['authoritativeSource'] = '特殊功能配置文件 [SYS_SPEC]'
    src['verifiedAgainstSource'] = False
    SF.write_text(json.dumps(sf, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'\n已写回 {SF}（schemaVersion={sf["schemaVersion"]}，imgSteps 保留 {sum(1 for f in fns if f.get("imgSteps"))} 条）')


if __name__ == '__main__':
    main()
