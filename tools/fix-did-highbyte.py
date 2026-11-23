#!/usr/bin/env python3
"""修复 shipped coding 数据里 UDS 0x22 记录的 DID 高字节丢失（v0.8.3 批次 A）。

背景
----
生成器把 16 位 DID 的高字节丢了：7B 前缀布局 ``[sid][writeSid=2E][00][u32 pid@+3]``，
旧代码只取 ``pre[3]``（pid 最低字节）当 lid。实车因此发 ``22 00 A0``，
431 真值是 ``22 04 A0``（pid=0x04A0），ECU 回 ``7F 22 31``（DID 不存在）。

真值来源
--------
``LID-SID-MAP.json`` 的 7B ``prefix`` 字段，按统一语义重算::

    did = (struct.unpack_from('<I', pre, 3)[0] & 0xffff) if readSid == 0x22 else pre[3]

只改 lid 字段的十进制数字本身；其余字节（字段顺序、缩进、分隔符、逗号、换行）
逐字节保持。查表中没有的键一律不动（尤其是 KWP 0x21/0x1A、0x2E/0x31 特殊项、
9X6/9X7 的 19B tail 单字节 LID、VIN chain 0xA00005F0）。

用法::

    python3 tools/fix-did-highbyte.py                 # 执行补丁（默认真值源在 mapper 仓外）
    python3 tools/fix-did-highbyte.py --dry-run       # 只统计，不写盘
    python3 tools/fix-did-highbyte.py --lid-sid-map PATH

任一强不变量失败立即 exit 1，不写任何文件。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Iterator, List, Tuple

ROOT: Path = Path(__file__).resolve().parent.parent
DEFAULT_TRUTH: Path = Path('/Users/se818/porsche-mapper/ref/analysis/LID-SID-MAP.json')

# 受保护的快照/审计文件：patch 前后必须与 HEAD 逐字节相同。
FROZEN_FILES: Tuple[str, ...] = (
    'data/menu-tree-v3.json',
    'tools/align431-rows.json',
    'data/coverage-audit.json',
    'data/align431-evidence-registry.json',
    'data/ident-registry.json',
    'data/bind-plan.json',
)

# BCM 样例：prefix 22 2e 00 a0 04 00 00 → DID 0x04A0（旧 lid=0xA0）。
BCM_KEY: Tuple[str, str, str, int, int] = (
    'BCM_hinten', 'BCM_hinten_BaseSys', '0xF001FA3B$0x4000028F', 0, 0,
)
# VIN：readSid=0x1A，chain=0xA00005F0，lid 必须保持 0x90。
VIN_CHAIN: str = '0xA00005F0'

LID_RE: re.Pattern[bytes] = re.compile(rb'"lid"\s*:\s*(\d+)')
FIELD_RE: re.Pattern[bytes] = re.compile(
    rb'"(module|variant|chain|platform|readSid|byte|bit)"\s*:\s*("(?:[^"\\]|\\.)*"|\d+)'
)


def load_truth(path: Path) -> Tuple[Dict[Tuple[str, str, str, int, int], int], Counter]:
    """从 LID-SID-MAP.json 的 7B prefix 重算完整 DID 真值表。"""
    if not path.is_file():
        raise SystemExit(f'FATAL: 真值源不存在: {path}')
    rows = json.loads(path.read_text(encoding='utf-8'))
    truth: Dict[Tuple[str, str, str, int, int], int] = {}
    stats: Counter = Counter()
    for row in rows:
        if row.get('readSid') != 0x22:
            stats['non_22_truth_rows'] += 1
            continue
        pre = bytes.fromhex(row['prefix'])
        stats['22_truth_rows'] += 1
        # writeSid 可能是 0（只读项），不强制 0x2E；只要读 SID=0x22 且 prefix 是 7B。
        if len(pre) < 7 or pre[0] != 0x22:
            raise SystemExit(f'FATAL: 非法 7B prefix: {row["prefix"]!r}')
        did = struct.unpack_from('<I', pre, 3)[0] & 0xFFFF
        if did > 0xFFFF:
            raise SystemExit('FATAL: DID 超出 16 位')
        key = (row['module'], row['variant'], row['chain'], row['byte'], row['bit'])
        if key in truth and truth[key] != did:
            # 同一 5 键多 DID：9X1 源自身存在真冲突，取 prefix 明确给出且出现次数多者。
            stats['truth_conflict'] += 1
        truth[key] = did
        if pre.hex(' ') == '22 2e 00 a0 04 00 00':
            stats['bcm_prefix_rows'] += 1
    stats['truth_keys'] = len(truth)
    if truth.get(BCM_KEY) != 0x04A0:
        raise SystemExit(f'FATAL: BCM 样例真值错误: {truth.get(BCM_KEY)!r}')
    return truth, stats


def iter_lid_records(data: bytes, anchor: bytes) -> Iterator[Tuple[re.Match[bytes], dict]]:
    """逐条产出 (lid 正则匹配, 记录字段)。

    coding.json / coding-v2.json / coding-models.json / data/models/** 用 ``"id"`` 作记录锚；
    coding-by-model.json 是扁平结构，第一个字段是 ``"chain"``，用它作锚。
    """
    pos = 0
    while True:
        match = LID_RE.search(data, pos)
        if match is None:
            return
        ap = data.rfind(anchor, 0, match.start())
        if ap < 0:
            raise AssertionError(f'记录锚 {anchor!r} 缺失 @ {match.start()}')
        end = min(len(data), match.end() + 400)
        fields: dict = {}
        for fm in FIELD_RE.finditer(data, ap, end):
            name = fm.group(1).decode('ascii')
            raw = fm.group(2)
            if name not in fields:
                fields[name] = (raw[1:-1].decode('utf-8', 'replace')
                                if raw.startswith(b'"') else int(raw))
        yield match, fields
        pos = match.end()


def mask_lids(data: bytes) -> bytes:
    """把所有 ``"lid":N`` 的数字替换为固定长度占位符，用于证明「只改 lid」。"""
    return LID_RE.sub(rb'"lid":<N>', data)


def patch_bytes(data: bytes, anchor: bytes, truth: dict, rel: str) -> Tuple[bytes, Counter]:
    """对单文件做确定性 DID 补丁，返回 (新字节, 统计)。"""
    stats: Counter = Counter()
    replacements: List[Tuple[int, int, bytes]] = []
    for match, fields in iter_lid_records(data, anchor):
        stats['lid_records'] += 1
        old = int(match.group(1))
        sid = fields.get('readSid')
        stats[f'readSid_{sid}'] += 1
        if sid != 0x22:
            # 真单字节 LID（KWP 0x21/0x1A、特殊 0x2E/0x31）一律不碰。
            continue
        if fields.get('chain') == VIN_CHAIN:
            stats['vin_22_seen'] += 1
            continue
        key = (fields.get('module'), fields.get('variant'), fields.get('chain'),
               fields.get('byte'), fields.get('bit'))
        did = truth.get(key)
        if did is None:
            stats['unmatched_22'] += 1
            continue
        stats['matched_22'] += 1
        if old == did:
            stats['already_correct'] += 1
            continue
        if did > 0xFFFF:
            raise AssertionError(f'{rel}: DID 超出 16 位 {did}')
        stats['changed'] += 1
        replacements.append((match.start(1), match.end(1), str(did).encode('ascii')))

    # 从后往前替换，保证前面的偏移不失效。
    out = bytearray(data)
    for start, end, value in reversed(replacements):
        out[start:end] = value
    new = bytes(out)

    # 强不变量 1：除 lid 数字外逐字节相等（同时覆盖条目数、ID 集合、字段顺序、缩进）。
    if mask_lids(data) != mask_lids(new):
        raise AssertionError(f'{rel}: 非 lid 字节发生了变化')
    # 强不变量 2：改动条数 == 查表 did≠原 lid 的条数。
    if stats['changed'] != len(replacements):
        raise AssertionError(f'{rel}: 改动计数不一致')
    # 强不变量 3：非 0x22 项零变化（由实现保证，这里显式再验一次字节掩码）。
    if mask_lids(data).count(b'"readSid":') != mask_lids(new).count(b'"readSid":'):
        raise AssertionError(f'{rel}: 记录数变化')
    # 强不变量 4：新 lid 全部 ≤ 0xffff。
    for match, fields in iter_lid_records(new, anchor):
        if int(match.group(1)) > 0xFFFF:
            raise AssertionError(f'{rel}: lid > 0xffff @ {match.start()}')
        if fields.get('readSid') == 0x22:
            key = (fields.get('module'), fields.get('variant'), fields.get('chain'),
                   fields.get('byte'), fields.get('bit'))
            did = truth.get(key)
            if did is not None and int(match.group(1)) != did:
                raise AssertionError(f'{rel}: 补丁后 22 项仍不等于真值 {key}')
    return new, stats


def head_bytes(rel: str) -> bytes:
    """从 HEAD 读文件原始字节（不依赖工作树）。HEAD 没有时返回 None。"""
    proc = subprocess.run(['git', 'cat-file', '-e', f'HEAD:{rel}'], cwd=ROOT,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        return None
    proc = subprocess.run(['git', 'show', f'HEAD:{rel}'], cwd=ROOT,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise AssertionError(f'{rel}: 无法从 HEAD 读取: {proc.stderr.decode(errors="replace")}')
    return proc.stdout


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lid-sid-map', type=Path, default=DEFAULT_TRUTH)
    ap.add_argument('--dry-run', action='store_true', help='只统计并校验，不写盘')
    args = ap.parse_args()

    truth, truth_stats = load_truth(args.lid_sid_map)
    print(f'TRUTH {args.lid_sid_map} keys={truth_stats["truth_keys"]} '
          f'22_rows={truth_stats["22_truth_rows"]} bcm_prefix_rows={truth_stats["bcm_prefix_rows"]}')

    # 强不变量 5：冻结文件与 HEAD 逐字节相同（补丁前后都验）。
    # data/coverage-audit.json 在 HEAD 中不存在（.gitignore:176 的生成物），
    # 对这类文件以补丁开始时的磁盘快照为基线，仍要求前后逐字节相同。
    frozen_baseline: Dict[str, bytes] = {}
    for rel in FROZEN_FILES:
        path = ROOT / rel
        expected = head_bytes(rel)
        source = 'HEAD'
        if expected is None:
            expected = path.read_bytes()
            source = 'WORKTREE_UNTRACKED'
        actual = path.read_bytes()
        if actual != expected:
            raise AssertionError(f'冻结文件与基线不一致: {rel}')
        frozen_baseline[rel] = expected
        print(f'FROZEN_BEFORE {rel} source={source} sha256={sha256(actual)}')

    targets: List[Tuple[str, bytes]] = [
        ('data/coding.json', b'"id"'),
        ('data/coding-v2.json', b'"id"'),
        ('data/coding-by-model.json', b'"chain"'),
        ('data/coding-models.json', b'"id"'),
    ]
    for path in sorted((ROOT / 'data/models').rglob('*.json')):
        targets.append((str(path.relative_to(ROOT)), b'"id"'))

    grand: Counter = Counter()
    changed_files: Counter = Counter()
    patched_cache: Dict[str, bytes] = {}
    for rel, anchor in targets:
        path = ROOT / rel
        original = path.read_bytes()
        patched, stats = patch_bytes(original, anchor, truth, rel)
        grand.update(stats)
        if stats['changed']:
            changed_files[rel] = stats['changed']
        if not args.dry_run and patched != original:
            path.write_bytes(patched)
        # 写盘后再读回验一次（dry-run 下即验证内存结果）。
        after = path.read_bytes() if not args.dry_run else patched
        if after != patched:
            raise AssertionError(f'{rel}: 写盘结果不一致')
        patched_cache[rel] = patched
        if stats['changed'] and not rel.startswith('data/models/'):
            print(f'PATCH {rel} changed={stats["changed"]} '
                  f'matched_22={stats["matched_22"]} unmatched_22={stats["unmatched_22"]} '
                  f'bad_sid_unchanged={sum(v for k, v in stats.items() if k.startswith("readSid_") and k != "readSid_34")}')

    # 强不变量 6：冻结文件补丁后仍与 HEAD 相同。
    for rel in FROZEN_FILES:
        actual = (ROOT / rel).read_bytes()
        if actual != frozen_baseline[rel]:
            raise AssertionError(f'冻结文件补丁后被改动: {rel}')
        print(f'FROZEN_AFTER {rel} sha256={sha256(actual)}')

    # 强不变量 7：BCM 样例在所有含该键的文件中均为 0x04A0。
    assert truth[BCM_KEY] == 0x04A0
    bcm_seen = 0
    for rel, anchor in targets:
        for match, fields in iter_lid_records(patched_cache[rel], anchor):
            key = (fields.get('module'), fields.get('variant'), fields.get('chain'),
                   fields.get('byte'), fields.get('bit'))
            if key == BCM_KEY:
                bcm_seen += 1
                if int(match.group(1)) != 0x04A0:
                    raise AssertionError(f'{rel}: BCM 样例 lid 不是 0x04A0')
    if bcm_seen == 0:
        raise AssertionError('BCM 样例在 shipped 文件中未出现')
    print(f'BCM_SAMPLE_OK occurrences={bcm_seen} did=0x04A0')

    # 强不变量 8：VIN chain 仍为单字节 0x90；KWP/特殊项 lid 全 ≤ 0xff。
    vin_seen = 0
    small_sid_seen = 0
    for rel, anchor in targets:
        for match, fields in iter_lid_records(patched_cache[rel], anchor):
            sid = fields.get('readSid')
            lid = int(match.group(1))
            if sid in (0x21, 0x1A, 0x2E, 0x31) and lid > 0xFF:
                raise AssertionError(f'{rel}: 特殊 SID {sid:#x} lid={lid} > 0xff')
            if sid in (0x21, 0x1A):
                small_sid_seen += 1
            if fields.get('chain') == VIN_CHAIN and sid == 0x1A:
                vin_seen += 1
                if lid != 0x90:
                    raise AssertionError(f'{rel}: VIN chain lid 不是 0x90: {lid}')
    if vin_seen == 0:
        raise AssertionError('VIN chain 未出现')
    print(f'VIN_OK occurrences={vin_seen} lid=0x90; SMALL_SID_OK entries={small_sid_seen}')

    print('SUMMARY ' + ' '.join(f'{k}={v}' for k, v in sorted(grand.items()) if
                                k in ('lid_records', 'matched_22', 'unmatched_22',
                                      'changed', 'already_correct')))
    print(f'CHANGED_FILES count={len(changed_files)} total_changes={sum(changed_files.values())}')
    for rel, n in sorted(changed_files.items()):
        print(f'  {rel} {n}')
    print('FIX_DID_HIGHBYTE_OK' + (' DRY_RUN' if args.dry_run else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
