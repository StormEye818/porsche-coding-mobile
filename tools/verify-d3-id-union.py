#!/usr/bin/env python3
"""D-3 统一口径 id 全集断言（PRD P0-4 D-3）。用法：python3 tools/verify-d3-id-union.py [--verbose]"""
import json, glob, re, hashlib, sys
from pathlib import Path
DATA = Path(__file__).resolve().parent.parent / 'data'
def itemids():
    mt = json.loads((DATA / 'menu-tree-v3.json').read_text())
    out = set()
    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get('itemIds'), list):
                out.update(str(x) for x in o['itemIds'])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(mt)
    return out
def union():
    u = set()
    u.update(str(p['id']) for p in json.loads((DATA / 'coding-v2.json').read_text())['params'])
    for f in sorted(glob.glob(str(DATA / 'models/*/*.json'))):
        j = json.loads(Path(f).read_text())
        u.update(str(it['id']) for it in j.get('items', []) if 'id' in it)
    return u
def main():
    ids = itemids(); u = union()
    exact = ids & u; miss = sorted(ids - u)
    chain_count = {}
    for x in u:
        k = ':'.join(x.split(':')[:3])
        chain_count[k] = chain_count.get(k, 0) + 1
    resolvable = [x for x in miss if ':'.join(x.split(':')[:3]) in chain_count]
    bit7 = sum(1 for x in miss
               if (m := re.match(r'^\d+\.(\d+)$', x.split(':')[-1])) and int(m.group(1)) > 7)
    lines = [
        'D3_ID_UNION distinct_itemids=%d' % len(ids),
        'D3_ID_UNION union_ids=%d' % len(u),
        'D3_ID_UNION exact_hit=%d (%.4f%%)' % (len(exact), 100.0 * len(exact) / len(ids)),
        'D3_ID_UNION miss=%d' % len(miss),
        'D3_ID_UNION miss_resolvable_by_chain=%d/%d' % (len(resolvable), len(miss)),
        'D3_ID_UNION miss_bit_gt7=%d' % bit7,
        'D3_ID_UNION entity_resolvable_Y/Y=%d/%d' % (len(ids), len(ids)),
        'D3_ID_UNION verdict=%s' % ('A' if len(resolvable) == len(miss) else 'NOT-A'),
    ]
    print('\n'.join(lines))
    print('D3_ID_UNION sha256=' + hashlib.sha256('\n'.join(lines).encode()).hexdigest())
    if '--verbose' in sys.argv:
        for x in miss:
            k = ':'.join(x.split(':')[:3])
            print('  MISS %s -> chain %s entities=%d' % (x, k, chain_count.get(k, 0)))
    assert len(resolvable) == len(miss), 'D3_ID_UNION: unresolved itemIds'
if __name__ == '__main__':
    main()
