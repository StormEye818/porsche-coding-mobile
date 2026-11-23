#!/usr/bin/env node
/**
 * verify-coding-did-integrity.mjs — 编码数据 DID 高字节完整性门禁（v0.8.3 批次 A）。
 *
 * 真值源：tools/coding-did-truth.json（LID-SID-MAP.json 的入库副本，含原始 7B prefix）。
 * 统一语义：readSid=0x22 且 prefix≥7B ⇒ did = (u32@3 & 0xffff)；其余 SID 是单字节 LID。
 *
 * 真执行断言：
 *   (a) 所有 readSid=0x22 且 5 键（module+variant+chain+byte+bit）在真值表中的条目，
 *       lid 必须等于 prefix 重算出的完整 DID；
 *   (b) 所有 readSid∈{0x21,0x1A} 的条目 lid ≤ 0xff；VIN chain 0xA00005F0 仍为 0x90；
 *   (c) 反例注入：把真 0x22 条目的 lid 改回低字节，判据必须转红；
 *   (d) 反例注入：把真 0x1A 条目的 lid 改成 16 位值，判据必须转红。
 *
 * 全部 shipped 表示（coding.json / coding-v2.json / coding-by-model.json /
 * coding-models.json / data/models/**）逐个扫描；查表无匹配的键一律不动、也不判红。
 *
 * 缺席目标的处理（v0.8.3 批次 D）：被 .gitignore 排除且本机的确没有的中间表
 * （coding-by-model.json / coding-models.json，rebuild-all.py 本地产物）在干净
 * clone 里天然缺席 → 记为 localOnlyAbsent 并跳过，不进 grand totals、不判红；
 * 未被忽略却缺席的目标视为 tracked 文件丢失，必须判红。存在的文件照常全量真扫。
 *
 * 跑法：node tools/verify-coding-did-integrity.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TRUTH_REL = 'tools/coding-did-truth.json';
const BCM_KEY = ['BCM_hinten', 'BCM_hinten_BaseSys', '0xF001FA3B$0x4000028F', 0, 0];
const VIN_CHAIN = '0xA00005F0';

const fail = (msg) => { console.log(`FAIL ${msg}`); process.exitCode = 1; };
const read = (rel) => readFileSync(join(ROOT, rel));
const makeKey = (f) => [f.module, f.variant, f.chain, f.byte, f.bit].join('\u0000');

/**
 * 判定一个缺席目标是否被 .gitignore 排除。只有 git 明确回答「被忽略」才返回 true；
 * git 不可用或返回异常状态一律判红（fail-closed），绝不当成可跳过。
 * @param {string} rel 相对 ROOT 的路径
 * @returns {boolean} true=被忽略；false=未忽略或判定失败（调用方判红）
 */
function isGitIgnored(rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], {
    cwd: ROOT,
    stdio: 'ignore',
    encoding: 'utf8',
  });
  if (r.error || r.status === null) {
    fail(`GIT_CHECK_IGNORE_UNAVAILABLE ${rel} error=${r.error ? r.error.message : 'no-status'}`);
    return false;
  }
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  fail(`GIT_CHECK_IGNORE_FAILED ${rel} status=${r.status}`);
  return false;
}

/* ── 真值表：从 prefix 重算，不信任真值文件里旧的 lid 字段 ─────────── */
const truthRows = JSON.parse(read(TRUTH_REL).toString('utf8'));
const didMap = new Map();
let truth22 = 0;
let bcmPrefixRows = 0;
for (const row of truthRows) {
  if (row.readSid !== 0x22) continue;
  const pre = Buffer.from(String(row.prefix).trim().split(/\s+/).map((x) => parseInt(x, 16)));
  if (pre.length < 7 || pre[0] !== 0x22) {
    fail(`TRUTH_PREFIX_INVALID ${row.prefix}`);
    process.exit();
  }
  const did = pre.readUInt32LE(3) & 0xffff;
  didMap.set(makeKey(row), did);
  truth22 += 1;
  if (String(row.prefix) === '22 2e 00 a0 04 00 00') bcmPrefixRows += 1;
}
if (didMap.get(BCM_KEY.join('\u0000')) !== 0x04A0) {
  fail(`TRUTH_BCM_SAMPLE key=${BCM_KEY.join(',')} did=${didMap.get(BCM_KEY.join('\u0000'))}`);
  process.exit();
}
console.log(`TRUTH rows=${truthRows.length} 22_rows=${truth22} keys=${didMap.size} bcm_prefix_rows=${bcmPrefixRows} bcm_did=0x04A0`);

/* ── 通用字节级记录扫描（与 fix-did-highbyte.py 同一锚点口径） ─────── */
const FIELD_RE = /(module|variant|chain|platform|readSid|byte|bit)"\s*:\s*("(?:[^"\\]|\\.)*"|\d+)/g;
const isWs = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * @param {Buffer} buf 文件字节
 * @param {string} rel 相对路径（仅用于报错）
 * @param {'"id"'|'"chain"'} anchor 记录锚点
 * @param {(rec: object)=>void} [capture] 捕获首条满足条件的记录（反例注入用）
 * @returns {{lid:number, sid22:number, matched22:number, smallSid:number, violations:string[]}}
 */
function scan(buf, rel, anchor, capture = null) {
  const stats = { lid: 0, sid22: 0, matched22: 0, smallSid: 0, violations: [] };
  let pos = 0;
  while (true) {
    const p = buf.indexOf('"lid"', pos);
    if (p < 0) break;
    let i = p + 5;
    while (i < buf.length && isWs(buf[i])) i += 1;
    if (buf[i] !== 0x3a) { stats.violations.push(`MALFORMED_LID ${rel} @${p}`); break; }
    i += 1;
    while (i < buf.length && isWs(buf[i])) i += 1;
    const ds = i;
    while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x39) i += 1;
    if (i === ds) { stats.violations.push(`MALFORMED_LID ${rel} @${p}`); break; }
    const lid = Number(buf.toString('ascii', ds, i));
    stats.lid += 1;

    const ap = buf.lastIndexOf(anchor, p);
    if (ap < 0) { stats.violations.push(`NO_ANCHOR ${rel} @${p}`); break; }
    const window = buf.toString('utf8', ap, Math.min(buf.length, i + 400));
    const fields = {};
    FIELD_RE.lastIndex = 0;
    let fm;
    while ((fm = FIELD_RE.exec(window)) !== null) {
      const k = fm[1];
      if (!(k in fields)) {
        fields[k] = fm[2][0] === '"' ? JSON.parse(fm[2]) : Number(fm[2]);
      }
    }
    const sid = fields.readSid;
    if (capture) {
      capture({ buf, rel, anchor, start: ap, end: Math.min(buf.length, i + 400),
                lidStart: ds, lidEnd: i, lid, fields });
    }
    if (sid === 0x22) {
      stats.sid22 += 1;
      const did = didMap.get(makeKey(fields));
      if (did !== undefined) {
        stats.matched22 += 1;
        if (lid !== did) {
          stats.violations.push(`DID_HIGHBYTE ${rel} key=${makeKey(fields)} lid=${lid} expected=${did}`);
        }
      }
    } else if (sid === 0x21 || sid === 0x1A) {
      stats.smallSid += 1;
      if (lid > 0xff) {
        stats.violations.push(`SMALL_SID_LID ${rel} sid=${sid} key=${makeKey(fields)} lid=${lid}`);
      }
      if (fields.chain === VIN_CHAIN && lid !== 0x90) {
        stats.violations.push(`VIN_LID ${rel} sid=${sid} lid=${lid} expected=144`);
      }
    }
    pos = i;
  }
  return stats;
}

/* ── 目标文件全集 ─────────────────────────────────────────────────── */
const targets = [
  ['data/coding.json', '"id"'],
  ['data/coding-v2.json', '"id"'],
  ['data/coding-by-model.json', '"chain"'],
  ['data/coding-models.json', '"id"'],
];
const walk = (dir, out) => {
  const full = join(ROOT, dir);
  for (const name of readdirSync(full).sort()) {
    const rel = `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (st.isFile() && name.endsWith('.json')) out.push([rel, '"id"']);
  }
};
walk('data/models', targets);

const grand = { lid: 0, sid22: 0, matched22: 0, smallSid: 0 };
const localOnlyAbsent = [];
let scanned = 0;
for (const [rel, anchor] of targets) {
  // 干净 clone 里 rebuild-all.py 本地中间表天然缺席；被忽略才允许跳过。
  if (!existsSync(join(ROOT, rel))) {
    if (isGitIgnored(rel)) {
      localOnlyAbsent.push(rel);
      continue;
    }
    fail(`TARGET_MISSING ${rel} (not gitignored: tracked file lost or undeclared fixture)`);
    continue;
  }
  // 存在的文件（无论 tracked 还是本地）一律全量真扫，判据不变。
  const s = scan(read(rel), rel, anchor);
  grand.lid += s.lid; grand.sid22 += s.sid22;
  grand.matched22 += s.matched22; grand.smallSid += s.smallSid;
  if (s.violations.length) {
    for (const v of s.violations.slice(0, 5)) fail(v);
    fail(`SCAN ${rel} violations=${s.violations.length}`);
  }
  scanned += 1;
}
console.log(`SCANNED files=${scanned} lid=${grand.lid} sid22=${grand.sid22} matched22=${grand.matched22} smallSid=${grand.smallSid} violations=0`);
console.log(`CODING_DID_INTEGRITY_LOCALONLY_ABSENT n=${localOnlyAbsent.length} rels=${localOnlyAbsent.join(',')}`);

/* ── (c) 反例注入：真 0x22 条目改回低字节 → 必须转红 ──────────────── */
const codingBuf = read('data/coding.json');
let rec22 = null;
scan(codingBuf, 'data/coding.json', '"id"', (rec) => {
  if (!rec22 && makeKey(rec.fields) === BCM_KEY.join('\u0000')) rec22 = rec;
});
if (!rec22) {
  fail('COUNTEREXAMPLE_22 no real BCM record found');
} else {
  const before = codingBuf.subarray(rec22.start, rec22.lidStart).toString('utf8');
  const after = codingBuf.subarray(rec22.lidEnd, rec22.end).toString('utf8');
  const mutated = Buffer.from(before + '160' + after, 'utf8'); // 0x04A0 → 0xA0（低字节）
  const s = scan(mutated, 'data/coding.json(injected-22)', '"id"');
  const red = s.violations.some((v) => v.startsWith('DID_HIGHBYTE'));
  if (red) console.log(`COUNTEREXAMPLE_22 PASS did=0x04A0 -> lid=160 -> ${s.violations[0]}`);
  else fail('COUNTEREXAMPLE_22 gate stayed GREEN after restoring low byte');
}

/* ── (d) 反例注入：真 0x1A 条目改成 16 位 → 必须转红 ──────────────── */
// coding.json 只含 9X1 设码项（无 0x1A）；从含 KWP 记录的 models 表示里取真条目。
const kwpRel = 'data/models/Boxster_981_/TVTuner_Delphi_A2.json';
const kwpBuf = read(kwpRel);
let rec1a = null;
scan(kwpBuf, kwpRel, '"id"', (rec) => {
  if (!rec1a && rec.fields.readSid === 0x1A) rec1a = rec;
});
if (!rec1a) {
  fail('COUNTEREXAMPLE_1A no real 0x1A record found');
} else {
  const before = kwpBuf.subarray(rec1a.start, rec1a.lidStart).toString('utf8');
  const after = kwpBuf.subarray(rec1a.lidEnd, rec1a.end).toString('utf8');
  const mutated = Buffer.from(before + '4660' + after, 'utf8'); // 0x1234
  const s = scan(mutated, `${kwpRel}(injected-1a)`, '"id"');
  const red = s.violations.some((v) => v.startsWith('SMALL_SID_LID'));
  if (red) console.log(`COUNTEREXAMPLE_1A PASS lid=4660 -> ${s.violations[0]}`);
  else fail('COUNTEREXAMPLE_1A gate stayed GREEN after widening 0x1A lid');
}

if (process.exitCode) {
  console.log('CODING_DID_INTEGRITY_FAIL');
} else {
  console.log('CODING_DID_INTEGRITY_PASS'
    + ` truth_keys=${didMap.size} files=${scanned} lid=${grand.lid}`
    + ` matched22=${grand.matched22} smallSid=${grand.smallSid} counterexamples=2`
    + ` localOnlyAbsent=${localOnlyAbsent.length}`);
}
