#!/usr/bin/env python3
"""各变体文件里 PTI/车载电脑组的条目数（终端 ≤6 行，详单落文件）。"""
import json
from pathlib import Path
ROOT = Path('/Users/se818/porsche-coder/data/models/Boxster_982_')
out = []
for f in sorted(ROOT.glob('Kombiinstrument*.json')):
    d = json.loads(f.read_text())
    for g in ('Performance and torque indication', '车载电脑显示配置出厂设置', '车载电脑菜单配置', '车载电脑菜单出厂设置'):
        items = [it for it in d['items'] if (it.get('path') or [''])[0] == g]
        if items:
            out.append(f"{f.name:<40} {g:<28} {len(items):>4} 条")
Path('/Users/se818/porsche-coder/tmp-analysis/variant-copies.txt').write_text('\n'.join(out) + '\n')
print('\n'.join(out[:6]))
print(f"... 共 {len(out)} 行")
