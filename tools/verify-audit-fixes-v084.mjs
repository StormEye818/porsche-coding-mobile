#!/usr/bin/env node
/**
 * verify-audit-fixes-v084.mjs — v0.8.4 批次1 三处代码真 bug 的可证伪门禁。
 *
 * 真执行：
 *   ① 抽 src/app.js 里 showSub 路径的 securityAccessEx 调用，断言
 *      level = kwpRoutine ? 0x00 : 0x03，且没有裸 0x09；
 *   ② 真调用 pickVariant / variantForName，断言过去会误配的「变体名子串」
 *      与「includes 双向」输入现在都返回 null；精确/显式别名仍命中；
 *   ③ 真调用 parseDtcPayload，喂 format 1/2/3 与未知 format 样本，
 *      断言条长由 descriptor 驱动、未知 format fail-closed、无 descriptor 仍是旧 3B 回退。
 *
 * 反例注入（只写 mkdtemp 临时 .mjs，绝不碰真实仓库）：
 *   - 把 SA level 改回 0x09 → ① 共享判据必须转红；
 *   - 把 pickVariant 的子串分支 / variantForName 的双向 includes 加回临时模块 → ② 必须转红；
 *   - 把 parseDtcPayload 的 entryLen 写死 3 后重跑 format1 样本 → ③ 必须转红。
 *
 * 跑法：node tools/verify-audit-fixes-v084.mjs
 * stdout：逐条 `ok`/`FAIL`，末行 `AUDIT_FIXES_V084_PASS count=N`（或 `_FAIL` + exit 1）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pickVariant } from '../src/seedkey.js';
import { variantForName, NAME_TO_VARIANT } from '../src/seedkey-name-map.js';
import { parseDtcPayload } from '../src/dtc.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const appSrc = read('src/app.js');

let checks = 0;
const failures = [];

/** 登记一条断言。 */
function record(name, pass, detail = '') {
  checks += 1;
  if (pass) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

/** 登记一条相等断言（结构化比较，避免字符串拼接误判）。 */
function same(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(name, a === e, `actual=${a} expected=${e}`);
}

/* ── ① SA level：showSub 路径不得再发 27 09 ───────────────────────── */
const SA_LEVEL_RE = /level:\s*kwpRoutine\s*\?\s*0x00\s*:\s*0x03\s*,\s*kwp:\s*kwpRoutine/;

/** 共享判据：真源码和注入副本都走这一条，确保反例确实可证伪。 */
function saLevelVerdict(src) {
  const lines = String(src).split('\n')
    .filter((line) => line.includes('securityAccessEx(') && line.includes('kwpRoutine'));
  if (lines.length !== 1) return false;
  const line = norm(lines[0]);
  return SA_LEVEL_RE.test(line) && !/level:\s*0x09\b/.test(line);
}

record('SA_LEVEL_REAL_GREEN', saLevelVerdict(appSrc));
record('SA_EXEC_ROUTINE_UNCHANGED',
  /level:\s*kwp\s*\?\s*0x00\s*:\s*0x03/.test(norm(appSrc)));
const saLine = appSrc.split('\n')
  .find((line) => line.includes('securityAccessEx(') && line.includes('kwpRoutine')) || '';
const injectedSa = saLine
  ? appSrc.replace(saLine, saLine.replace(SA_LEVEL_RE, 'level: 0x09, kwp: kwpRoutine'))
  : appSrc;
record('SA_LEVEL_INJECT_RED', injectedSa !== appSrc && !saLevelVerdict(injectedSa));

/* ── ② 模糊匹配：过去会误配、现在必须 null ──────────────────────────── */
// '9x7GW' 是 VARIANT_BY_ECU 的键；旧 pickVariant ③ 子串分支会命中它。
const FUZZY_ECU = 'XYZ_9X7GW_XYZ';
// 'ASAM_SeedKey_ESP_DL' 是 NAME_TO_VARIANT 的键；旧双向 includes 会命中它。
const FUZZY_NAME = 'ASAM_SeedKey_ESP_DL_legacy_extra';

record('VARIANT_FUZZY_ECU_REJECTED', pickVariant(FUZZY_ECU) === null,
  `actual=${JSON.stringify(pickVariant(FUZZY_ECU))}`);
record('VARIANT_FUZZY_NAME_REJECTED', variantForName(FUZZY_NAME) === null,
  `actual=${JSON.stringify(variantForName(FUZZY_NAME))}`);
record('VARIANT_EXACT_KEPT', pickVariant('9x7GW')?.variant === '9x7GW');
record('VARIANT_ALIAS_KEPT', pickVariant('Allrad')?.variant === 'Allrad_Gen1');
const exactName = NAME_TO_VARIANT['ASAM_SeedKey_ESP_DL'];
record('NAME_EXACT_KEPT', Boolean(exactName) && variantForName('ASAM_SeedKey_ESP_DL') === exactName);
record('NAME_UPPER_EXACT_KEPT', Boolean(exactName) && variantForName('asam_seedkey_esp_dl') === exactName);
record('APP_TOKEN_FALLBACK_KEPT',
  appSrc.includes('ASAP1A_CCP_ComputeKeyFromSeed_' + '${tok}') && appSrc.includes('不做模糊包含'));

// 反例注入锚点：临时模块把删掉的模糊分支原样加回。
const seedMarker = '  // ③ 无：不做「变体名是模块名子串」模糊匹配（独立算法错配会 NRC 0x35 → 0x36 锁死）。\n'
  + '  return null;\n}';
const seedFuzzy = '  for (const [k, v] of Object.entries(VARIANT_BY_ECU)) {\n'
  + '    const kk = k.toUpperCase();\n'
  + '    if (kk.length >= 3 && n.includes(kk)) return { variant: k, ...v };\n'
  + '  }\n  return null;\n}';
const nameMarker = '  for (const k of Object.keys(NAME_TO_VARIANT)) {\n'
  + '    if (k.toUpperCase() === up) return NAME_TO_VARIANT[k];\n  }\n  return null;\n}';
const nameFuzzy = nameMarker.replace('  return null;\n}',
  '  for (const k of Object.keys(NAME_TO_VARIANT)) {\n'
  + '    const ku = k.toUpperCase();\n'
  + '    if (up.includes(ku) || ku.includes(up)) return NAME_TO_VARIANT[k];\n'
  + '  }\n  return null;\n}');
const dtcMarker = 'const entryLen = Number.isInteger(d.entryLen) && d.entryLen > 0 ? d.entryLen : 0;';

/** 锚点必须存在，否则注入自检本身是空转。 */
record('INJECT_ANCHOR_SEED', read('src/seedkey.js').includes(seedMarker));
record('INJECT_ANCHOR_NAME', read('src/seedkey-name-map.js').includes(nameMarker));
record('INJECT_ANCHOR_DTC', read('src/dtc.js').includes(dtcMarker));

/* ── ③ DTC：descriptor 驱动条长，未知 format fail-closed ────────────── */
const FORMAT1_BODY = [0x59, 0x02, 0x89, 0xC1, 0x11, 0x00, 0x22];
const FORMAT1_DESC = { entryLen: 2, headerLen: 3, format: 1, count: null };
const FORMAT2_BODY = [0x59, 0x02, 0x89, 0x00, 0xC7, 0x31, 0x04, 0x12, 0x08];
const FORMAT2_DESC = { entryLen: 3, headerLen: 3, format: 2, count: null };

const samples = [
  {
    name: 'DTC_FORMAT1', body: FORMAT1_BODY, descriptor: FORMAT1_DESC,
    expected: [{ code: 'U0001', status: 0x11 }, { code: 'P0000', status: 0x22 }],
  },
  {
    name: 'DTC_FORMAT2', body: FORMAT2_BODY, descriptor: FORMAT2_DESC,
    expected: [{ code: 'P00C7', status: 0x31 }, { code: 'P0412', status: 0x08 }],
  },
  {
    name: 'DTC_FORMAT3_4B', body: [0x59, 0x02, 0x89, 0x00, 0xC7, 0x11, 0x91, 0x04, 0x12, 0x22, 0x08],
    descriptor: { entryLen: 4, headerLen: 3, format: 3, count: null },
    expected: [{ code: 'P00C711', status: 0x91 }, { code: 'P041222', status: 0x08 }],
  },
  {
    // UDS 常见 3 字节条目：format=3 + entryLen=3 → 2B DTC + 1B status。
    name: 'DTC_FORMAT3_UDS3', body: [0x59, 0x02, 0x89, 0x00, 0xC7, 0x11, 0x04, 0x12, 0x22],
    descriptor: { entryLen: 3, headerLen: 3, format: 3, count: null },
    expected: [{ code: 'P00C7', status: 0x11 }, { code: 'P0412', status: 0x22 }],
  },
  {
    // count 优先：body 里有 2 条，descriptor 说 1 条 → 只解析 1 条。
    name: 'DTC_COUNT_PRIORITY', body: FORMAT2_BODY,
    descriptor: { entryLen: 3, headerLen: 3, format: 2, count: 1 },
    expected: [{ code: 'P00C7', status: 0x31 }],
  },
  {
    // headerLen 跳头：59 02 89 AA 之后才是数据。
    name: 'DTC_HEADER_LEN', body: [0x59, 0x02, 0x89, 0xAA, 0x00, 0xC7, 0x31],
    descriptor: { entryLen: 3, headerLen: 4, format: 2, count: null },
    expected: [{ code: 'P00C7', status: 0x31 }],
  },
];

for (const s of samples) {
  const r = parseDtcPayload(s.body, s.descriptor);
  same(`${s.name}_PROTOCOL`, r.protocol, 'uds');
  same(`${s.name}_COUNT`, r.dtcs.length, s.expected.length);
  same(`${s.name}_CODES`, r.dtcs.map((x) => x.code), s.expected.map((x) => x.code));
  same(`${s.name}_STATUS`, r.dtcs.map((x) => x.status), s.expected.map((x) => x.status));
  same(`${s.name}_DESCRIPTOR_USED`, r.descriptorUsed, true);
}

const unknownSample = parseDtcPayload(FORMAT2_BODY,
  { entryLen: 3, headerLen: 3, format: 9, count: null });
same('DTC_UNKNOWN_FORMAT_PROTOCOL', unknownSample.protocol, 'unknown');
same('DTC_UNKNOWN_FORMAT_DTCS', unknownSample.dtcs.length, 0);
same('DTC_UNKNOWN_FORMAT_RAW', unknownSample.raw.map((x) => x.toString(16).padStart(2, '0')).join(' '),
  '59 02 89 00 c7 31 04 12 08');

const fallbackUds = parseDtcPayload(FORMAT2_BODY);
same('DTC_FALLBACK_UDS_PROTOCOL', fallbackUds.protocol, 'uds');
same('DTC_FALLBACK_UDS_CODES', fallbackUds.dtcs.map((x) => x.code), ['P00C7', 'P0412']);
same('DTC_FALLBACK_UDS_FLAG', fallbackUds.descriptorUsed, false);
const fallbackKwp = parseDtcPayload([0x58, 0x02, 0x00, 0xC7, 0x31]);
same('DTC_FALLBACK_KWP_PROTOCOL', fallbackKwp.protocol, 'kwp');
same('DTC_FALLBACK_KWP_CODES', fallbackKwp.dtcs.map((x) => x.code), ['P00C7']);
same('DTC_FALLBACK_KWP_FLAG', fallbackKwp.descriptorUsed, false);

record('DTC_CALLSITE_DESCRIPTOR',
  /parseDtcPayload\(r\.body,\s*\{\s*entryLen:\s*3,\s*headerLen:\s*dtcHeaderLen,\s*format:\s*2,\s*count:\s*null\s*\}\)/.test(norm(appSrc)));
record('DTC_CALLSITE_HONESTY', appSrc.includes('不是从 ECU 动态读出的 descriptor'));

/* ── 反例注入：临时 .mjs 模块，真执行后必须转红 ─────────────────────── */
const tmp = mkdtempSync(join(tmpdir(), 'audit-fixes-v084-'));

/** 把变换后的模块源码写进临时目录并真导入（.mjs 保证 ESM 解析）。 */
async function injectModule(name, src, transform) {
  const out = transform(src);
  if (out === null) return null;
  const p = join(tmp, name + '.mjs');
  writeFileSync(p, out, 'utf8');
  return import(pathToFileURL(p).href + '?inject=' + name);
}

try {
  const seedSrc = read('src/seedkey.js');
  const nameSrc = read('src/seedkey-name-map.js');
  const dtcSrc = read('src/dtc.js');

  const injSeedMod = await injectModule('seedkey-injected', seedSrc,
    (s) => s.includes(seedMarker) ? s.replace(seedMarker, seedFuzzy) : null);
  const injNameMod = await injectModule('name-map-injected', nameSrc,
    (s) => s.includes(nameMarker) ? s.replace(nameMarker, nameFuzzy) : null);
  const injDtcMod = await injectModule('dtc-injected', dtcSrc,
    (s) => s.includes(dtcMarker) ? s.replace(dtcMarker, 'const entryLen = 3;') : null);

  record('INJECT_FUZZY_ECU_RED', Boolean(injSeedMod) && injSeedMod.pickVariant(FUZZY_ECU) !== null,
    '子串分支加回后应误配');
  record('INJECT_FUZZY_NAME_RED', Boolean(injNameMod) && injNameMod.variantForName(FUZZY_NAME) !== null,
    'includes 兜底加回后应误配');
  const injectedFormat1 = injDtcMod
    ? injDtcMod.parseDtcPayload(FORMAT1_BODY, FORMAT1_DESC)
    : null;
  record('INJECT_DTC_ENTRYLEN3_RED',
    Boolean(injectedFormat1) && (injectedFormat1.dtcs.length !== 2
      || injectedFormat1.dtcs.some((d, i) => d.code !== samples[0].expected[i].code)),
    `injected=${JSON.stringify(injectedFormat1 && injectedFormat1.dtcs.map((x) => x.code))}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`AUDIT_FIXES_V084_FAIL count=${checks} failures=${failures.length}`);
  process.exit(1);
}
console.log(`AUDIT_FIXES_V084_PASS count=${checks}`);
