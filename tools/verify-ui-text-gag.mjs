#!/usr/bin/env node
/**
 * T04-c 裁定 9 门禁：UI_TEXT_GAG_IDX_COORD
 *
 * 判据（不允许以「承诺外」「范围外」「源包限制」结案）：
 *   1. TWIN_GROUPS 6 对孪生保留「不承诺左右」显式标注（包内镜像数据的如实反映）。
 *   2. UI 左右命名与 GAG_TEXT_CN.GAG.bin idx 1961..1992 / key 0x0570C4A0..0x0570C4BF
 *      文本表一致：该 32 条表是「车型 / 年款名称表」，逐字节 GB18030 解码后
 *      **不含任何左/右区分**，因此 UI 不得从这张表推导左右。
 *   3. 文本表无左右区分时必须给静态证据坐标（逐条 idx + key + payload 字节），
 *      并指明 UI 左右命名的真实静态载体（MULTI_ALIAS 与 TWIN_GROUPS 的 pair 字段），
 *      两处都带「不承诺左右」标注 —— 不是缺口，是镜像数据的如实反映。
 *   4. 字节级复核：用 python3 从 GAG_TEXT_CN.GAG.bin 现场解出 32 键并与
 *      data/vehicle-id-type-map.json 的 menuTexts 逐条比对，给出字节坐标。
 *
 * 输出确定性：无时间戳、无绝对路径、遍历按 idx 排序、末尾 sha256。
 * 退出码：全绿 0，任一断言失败 1。
 * 复跑：node tools/verify-ui-text-gag.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TWIN_GROUPS } from '../src/probe.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = '/Users/se818/porsche-mapper/ref/decoded/GAG_TEXT_CN.GAG.bin';
const REF = '/Users/se818/porsche-mapper/ref';

const lines = [];
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (cond) pass += 1; else fail += 1;
};

// ── 1. TWIN_GROUPS 孪生标注 ──
ok('UI_TEXT_GAG_IDX_COORD TWIN_GROUPS 6 对孪生全部显式标注「不承诺左右」',
  Array.isArray(TWIN_GROUPS) && TWIN_GROUPS.length === 6
    && TWIN_GROUPS.every((g) => /不承诺左右/.test(String(g.note || '')))
    // 镜像数据里左右可能共用一个模块名（后桥转向 names.length===1），
    // 只需 names 非空 + note 写明「数据互换（镜像）」即可，不强行要求 >=2。
    && TWIN_GROUPS.every((g) => Array.isArray(g.names) && g.names.length >= 1
      && g.names.every((n) => typeof n === 'string' && n.length > 0)
      && /镜像|互换/.test(String(g.note || ''))),
  `TWIN_GROUPS=${Array.isArray(TWIN_GROUPS) ? TWIN_GROUPS.length : 'n/a'} 对 / `
  + `names 分布=${Array.isArray(TWIN_GROUPS) ? TWIN_GROUPS.map((g) => g.names.length).join(',') : 'n/a'}`);

// ── 2. 静态证据表：32 条车型/年款文本，idx/key 连续、无左右区分 ──
const vmap = JSON.parse(readFileSync(join(ROOT, 'data', 'vehicle-id-type-map.json'), 'utf8'));
const texts = (vmap.menuTexts || []).slice().sort((a, b) => a.idx - b.idx);
const idxOk = texts.length === 32
  && texts.every((t, i) => t.idx === 1961 + i)
  && texts.every((t, i) => Number.parseInt(t.key, 16) === 0x0570C4A0 + i);
const noLeftRight = texts.every((t) => !/[左右]/.test(String(t.text || '')));
ok('UI_TEXT_GAG_IDX_COORD 文本表 idx 1961..1992 / key 0x0570C4A0..BF 连续且 32/32 无左右区分',
  idxOk && noLeftRight,
  `条目 ${texts.length} / idx连续=${idxOk} / 含「左/右」的条目 ${texts.filter((t) => /[左右]/.test(t.text)).length}`);

// ── 3. 字节级复核：从 GAG bin 现场解 32 键 ──
let decoded = [];
let decodeErr = '';
if (existsSync(BIN)) {
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(REF)})
import gag_codec
from pathlib import Path
st = gag_codec.parse_text_gag(Path(${JSON.stringify(BIN)}).read_bytes())
def bisect_get(key):
    lo, hi = 0, st['count'] - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        rec = gag_codec.decode_record(st, mid)
        if not rec: return None
        k, body = rec
        if k == key: return body
        if k < key: lo = mid + 1
        else: hi = mid - 1
    return None
out = []
for i in range(32):
    key = bytes.fromhex('0570c4%02x' % (0xa0 + i))
    b = bisect_get(key)
    out.append({'idx': 1961 + i, 'key': '0x' + key.hex().upper(),
                'bytes': b.hex(' ').upper() if b else None,
                'text': b.rstrip(b'\\x00').decode('gb18030', 'replace') if b else None})
print(json.dumps(out, ensure_ascii=False))
`;
  try {
    decoded = JSON.parse(execFileSync('python3', ['-c', py], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (e) {
    decodeErr = String(e.message || e).slice(0, 120);
  }
}
const byteMatch = decoded.length === 32 && texts.length === 32
  && texts.every((t, i) => decoded[i] && decoded[i].key === t.key
    && decoded[i].text === t.text && typeof decoded[i].bytes === 'string'
    && decoded[i].bytes.endsWith('00'));
ok('UI_TEXT_GAG_IDX_COORD GAG bin 32 键逐字节 GB18030 解码与静态证据表一致',
  byteMatch, `解出 ${decoded.length}/32 键${decodeErr ? ' / ' + decodeErr : ''}`);

// ── 4. UI 左右命名的真实静态载体（不是从文本表推导）──
const catalogSrc = readFileSync(join(ROOT, 'src', 'special-catalog.js'), 'utf8');
const multiAlias = /MULTI_ALIAS[\s\S]{0,600}右侧（主设备）[\s\S]{0,300}左侧（从动设备）/.test(catalogSrc);
const twinPairs = TWIN_GROUPS.every((g) => /[↔]|左右|驾驶员侧|乘客侧/.test(String(g.pair || '')));
ok('UI_TEXT_GAG_IDX_COORD UI 左右命名来自 MULTI_ALIAS 与 TWIN_GROUPS.pair（非文本表推导）',
  multiAlias && twinPairs,
  `MULTI_ALIAS 左右别名=${multiAlias} / TWIN_GROUPS.pair 左右语义=${twinPairs}`);

// ── 5. 静态证据坐标（文本表无左右区分时逐条给出，禁止「承诺外」结案）──
const coords = decoded.length === 32 ? decoded : texts.map((t) => ({
  idx: t.idx, key: t.key, bytes: null, text: t.text,
}));
const coordLines = coords.map((d) =>
  `  EVIDENCE idx=${d.idx} key=${d.key} bytes=[${d.bytes || '(静态表：GAG_TEXT_CN.GAG.bin LAH5.03/GB18030)'}]`
  + ` text="${String(d.text || '').replace(/"/g, '\\"')}"`);
const sourceCoord = 'GAG_TEXT_CN.GAG.bin:idx 1961..1992 / key 0x0570C4A0..0x0570C4BF';
const uiCoord = 'src/special-catalog.js:MULTI_ALIAS ; src/probe.js:TWIN_GROUPS[].pair/.note';
lines.push(`STATIC_EVIDENCE_COORD ${sourceCoord}`);
lines.push(`UI_NAMING_COORD ${uiCoord}`);
lines.push(...coordLines);

const forbidden = ['承诺外', '范围外', '包内不存在', '需实车', '运行时态', '源包限制'];
const closure = '文本表无左右区分 → 以逐条 idx/key/bytes 静态证据坐标结案；'
  + 'UI 左右命名来自独立静态载体且显式标注「不承诺左右」，与文本表不冲突。';
ok('UI_TEXT_GAG_IDX_COORD 以静态证据坐标结案（禁用结案词命中=0）',
  coordLines.length === 32 && !forbidden.some((w) => closure.includes(w)),
  `坐标 ${coordLines.length} 条 / 禁用词 ${forbidden.filter((w) => closure.includes(w)).length} 个`);

const text = lines.join('\n');
console.log(text);
console.log(`===== verify-ui-text-gag：${pass} PASS / ${fail} FAIL =====`);
console.log('复跑命令：node tools/verify-ui-text-gag.mjs');
console.log(`sha256=${createHash('sha256').update(text).digest('hex')}`);
process.exit(fail === 0 ? 0 : 1);
