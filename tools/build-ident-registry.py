#!/usr/bin/env python3
"""DSN.BIN 识别串→家族/变体注册表抽取器（2026-11-09 真车修复任务）。

数据源（全部字节级实证，见 RE-TRACEABILITY-20261109.md）：
  DSN.BIN 模块索引 @105358：<u8 id><u16 len><name\\0><u32 recPtr><u16 pad>
  模块记录 @recPtr：<u8 type=01><u16 len><身份名\\0><SID u8><ID u16le><flags…>
      <u8 vcount> + vcount × <u16 len><变体名\\0><u32 setPtr>
  变体值集 @setPtr：[u16 n] + n × <u16 len=0x33><51B 识别串>（n=1 为主，KIT 族 n=2）
  —— 身份记录的 SID/ID = 识别请求（DME 族 = 1A 9F，与真车日志 `5A 9F "P200"` 互证）；
     值集 = 该变体的识别串（DSN 码，如 SDI9_1_981_3_4L_EU5 → "P200"）。

产出 data/ident-registry.json：
  moduleIdent    模块 → 识别请求（sid/id/requestHex）
  identToVariant 识别串 → [{module, variant}]（识别串→家族/变体注册表本体）
  variantToIdent 变体 → [识别串]

用法： python3 tools/build-ident-registry.py
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DSN = Path('/Users/se818/porsche-mapper/ref/decoded/DSN.BIN')
OUT = ROOT / 'data' / 'ident-registry.json'
MOD_IDX = 105358   # 9x1 平台模块索引（DSN-index.json id13=9x1 off=105356 + 2）


def parse_modules(blob, start, maxn=300):
    p, out = start, []
    for _ in range(maxn):
        if p + 3 > len(blob):
            break
        idx = blob[p]
        ln = struct.unpack_from('<H', blob, p + 1)[0]
        if ln == 0 or ln > 120 or p + 3 + ln + 6 > len(blob):
            break
        raw = blob[p + 3:p + 3 + ln]
        if not raw.endswith(b'\x00'):
            break
        nm = raw[:-1].decode('latin1', 'replace')
        if not nm or not all(32 <= ord(c) < 127 for c in nm):
            break
        ptr = struct.unpack_from('<I', blob, p + 3 + ln)[0]
        pad = struct.unpack_from('<H', blob, p + 3 + ln + 4)[0]
        if pad > 8:
            break
        out.append({'id': idx, 'name': nm, 'ptr': ptr})
        p += 3 + ln + 6
    return out


def parse_mod_record(blob, ptr):
    """模块记录 = 身份记录 + 变体表（后缀 10/11/12B 三形态试探，vcount 合法性判定）。"""
    ln = struct.unpack_from('<H', blob, ptr + 1)[0]
    name = blob[ptr + 3:ptr + 3 + ln - 1].decode('latin1', 'replace')
    q = ptr + 3 + ln
    for sufl in (11, 10, 12):
        if q + sufl >= len(blob):
            continue
        vcount = blob[q + sufl]
        if not (1 <= vcount <= 60):
            continue
        r = q + sufl + 1
        vs, ok = [], True
        for _ in range(vcount):
            if r + 2 > len(blob):
                ok = False
                break
            vl = struct.unpack_from('<H', blob, r)[0]
            if not (2 <= vl <= 120) or r + 2 + vl + 4 > len(blob):
                ok = False
                break
            raw = blob[r + 2:r + 2 + vl]
            if not raw.endswith(b'\x00'):
                ok = False
                break
            vnm = raw[:-1].decode('latin1', 'replace')
            if not vnm or not all(32 <= ord(c) < 127 for c in vnm):
                ok = False
                break
            dptr = struct.unpack_from('<I', blob, r + 2 + vl)[0]
            vs.append({'name': vnm, 'setPtr': dptr})
            r += 2 + vl + 4
        if ok and vs:
            suf = blob[q:q + sufl]
            # [u8 SID][u8 pad][u16le ID]（DME: 1a 00 9f 00 → SID 0x1A / LID 0x9F，
            #  walk2 同款：22 00 9e f1 = SID 0x22 / DID 0xF19E）
            sid = suf[0]
            ident_id = struct.unpack_from('<H', suf, 2)[0]
            return {'identName': name, 'sid': sid, 'id': ident_id, 'variants': vs,
                    'suffixHex': suf.hex()}
    return {'identName': name, 'sid': None, 'id': None, 'variants': [], 'suffixHex': ''}


def parse_value_set(blob, ptr, end):
    """变体值集：[u16 n] + n×<u16 len><cstr>，在 [ptr,end) 内取全部记录。"""
    p, out = ptr, []
    while p + 2 <= end:
        n = struct.unpack_from('<H', blob, p)[0]
        if n < 1 or n > 8:
            break
        q = p + 2
        names, ok = [], True
        for _ in range(n):
            if q + 2 > end:
                ok = False
                break
            ln = struct.unpack_from('<H', blob, q)[0]
            if not (2 <= ln <= 64) or q + 2 + ln > end:
                ok = False
                break
            s = blob[q + 2:q + 2 + ln].split(b'\x00')[0]
            try:
                nm = s.decode('ascii')
            except UnicodeDecodeError:
                ok = False
                break
            if not nm or not all(32 <= ord(c) < 127 for c in nm):
                ok = False
                break
            names.append(nm)
            q += 2 + ln
        if not ok:
            break
        out.extend(names)
        p = q
    return out


def main():
    blob = DSN.read_bytes()
    mods = parse_modules(blob, MOD_IDX)
    if not mods:
        print('模块索引解析失败', file=sys.stderr)
        sys.exit(1)
    mod_recs = {}
    all_var_ptr = []
    for m in mods:
        rec = parse_mod_record(blob, m['ptr'])
        mod_recs[m['name']] = rec
        for v in rec['variants']:
            all_var_ptr.append(v['setPtr'])
    all_var_ptr = sorted(set(all_var_ptr))

    def bound_after(ptr):
        """变体值集右界 = 下一个全局 setPtr（防跨变体/跨模块出血）。"""
        for q in all_var_ptr:
            if q > ptr:
                return q
        return min(len(blob), ptr + 0x400)

    ident_to_variant = {}
    variant_to_ident = {}
    module_ident = {}
    for mname, rec in mod_recs.items():
        if rec['sid'] is not None:
            req = f"{rec['sid']:02X}" + (f"{rec['id']:02X}" if rec['id'] is not None and rec['id'] < 0x100
                                        else f"{(rec['id'] >> 8) & 0xff:02X}{rec['id'] & 0xff:02X}")
            module_ident[mname] = {
                'sid': rec['sid'], 'id': rec['id'], 'request': req,
                'identName': rec['identName'], 'suffixHex': rec['suffixHex'],
            }
        for v in rec['variants']:
            vals = parse_value_set(blob, v['setPtr'], bound_after(v['setPtr']))
            variant_to_ident[v['name']] = vals
            for ident in vals:
                ident_to_variant.setdefault(ident, []).append(
                    {'module': mname, 'variant': v['name']})

    out = {
        'schemaVersion': 1,
        'kind': 'ident-registry',
        'source': 'DSN.BIN（模块索引@105358→模块记录[SID/ID 身份记录]→变体表→变体识别串集）',
        'evidence': 'RE-TRACEABILITY-20261109.md §识别串注册表；DME 族身份记录=1A 9F（真车日志 5A 9F"P200"互证）',
        'moduleIdent': module_ident,
        'identToVariant': ident_to_variant,
        'variantToIdent': variant_to_ident,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f'模块 {len(mod_recs)} · 识别串 {len(ident_to_variant)} → {OUT}')
    for k in ("P200",):
        print(f'  {k} -> {ident_to_variant.get(k)}')


if __name__ == '__main__':
    main()
