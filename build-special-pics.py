#!/usr/bin/env python3
"""特殊功能分步图补齐（D6）。

发现：`SPECFUNPIC/` 里 53 张图是**按步骤序列**命名的，
例如 `TME-CLEAN_REFRIGERANT-01..13`（一个功能 13 步）、`HEADLIGHT_ADJUST-01..03`（3 步）。
我们原来的 `img: string` 只存了第一步 —— 不是「缺图」，是**数据模型装不下**。

本脚本：
  ① 按 `-NN` / `_NN` 尾号把图归组
  ② 每个条目从 `img`（首步）展开成 `imgSteps`（整组步骤，按序）
  ③ 校验所有引用的图确实存在（防止坏引用）
  ④ 报出「有图组但没条目引用」的余量

用法: python3 build-special-pics.py [--dry-run]
图片根目录: ~/porsche-mapper/ref/porche-v24.58/V24.58/SPECFUNPIC
"""
import json, re, argparse
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent
SF = ROOT / 'data' / 'special-functions.json'
PICDIR = Path.home() / 'porsche-mapper/ref/porche-v24.58/V24.58/SPECFUNPIC'
# 发版面只放文件名引用，不打包原图（原图留在研究目录）
PIC_NOTE = 'SPECFUNPIC/'


def group_by_base(stems):
    """按去掉尾部序号的 base 分组，保留序号顺序。"""
    g = defaultdict(list)
    for s in stems:
        base = re.sub(r'[-_]\d+$', '', s)
        g[base].append(s)
    for base in g:
        g[base].sort(key=lambda x: int(re.search(r'(\d+)$', x).group(1)) if re.search(r'(\d+)$', x) else 0)
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not PICDIR.is_dir():
        raise SystemExit(f'图目录不存在: {PICDIR}')
    stems = sorted(p.stem for p in PICDIR.iterdir()
                   if p.suffix.upper() in ('.JPG', '.JPEG', '.PNG', '.GIF'))
    groups = group_by_base(stems)
    print(f'图 {len(stems)} 张 → {len(groups)} 组')
    multi = {b: v for b, v in groups.items() if len(v) > 1}
    print(f'其中多步骤组 {len(multi)} 个:')
    for b, v in sorted(multi.items()):
        print(f'  {b}: {len(v)} 步')

    sf = json.loads(SF.read_text(encoding='utf-8'))
    fns = sf['functions']
    expanded = matched = 0
    used = set()
    for f in fns:
        img = f.get('img') or ''
        if not img:
            continue
        base = re.sub(r'[-_]\d+$', '', img)
        seq = groups.get(base)
        if not seq:
            print(f'  ✗ img 找不到组: {img!r}  ({f.get("system")} / {f.get("sub")})')
            continue
        f['imgSteps'] = seq
        f['imgDir'] = PIC_NOTE
        used.update(seq)
        matched += 1
        if len(seq) > 1:
            expanded += 1
    print(f'\n已给 {matched} 条补 imgSteps（其中 {expanded} 条是多步骤）')

    leftover = [s for s in stems if s not in used]
    print(f'未被引用的图 {len(leftover)} 张:')
    for s in leftover:
        print('   ', s)

    # 校验：所有 imgSteps 都必须是真实文件
    bad = [x for f in fns for x in f.get('imgSteps', []) if x not in set(stems)]
    print(f'\n坏引用: {len(bad)} 个  {bad[:5]}')

    if args.dry_run:
        print('\n--dry-run：不写回')
        return
    # ⚠️ 与 build-special-functions.py 协同：schemaVersion 取大，别降级
    sf['schemaVersion'] = max(int(sf.get('schemaVersion') or 1), 4)
    src = sf.setdefault('source', {})
    src['picDir'] = 'SPECFUNPIC（研究目录，不进发版包）'
    src['picModel'] = 'imgSteps = 同一功能的分步图序列（按序号）；img 保留为首步'
    SF.write_text(json.dumps(sf, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'\n已写回 {SF}（schemaVersion={sf["schemaVersion"]}）')


if __name__ == '__main__':
    main()
