#!/usr/bin/env node
/**
 * verify-generator-consumer-contract.mjs — 阶段 F 生成器→消费者真实产物契约巡检。
 *
 * 权威口径：枚举 **git tracked** 的 tools/build-* / tools/export-*（干净 clone 为 26），
 * 与契约清单集合必须完全相等；本机 ignored 的 3 个取证生成器不参与该集合，
 * 由清单 EXTERNAL_GENERATORS 段单独纳管（产物 tracked 或 offline-only）。
 *
 * 每条 check 都是真执行规格：
 *   · nodeFunction：import 真实消费者函数，注入磁盘 fetch / 真实产物调用；
 *   · gateCommand：spawnSync 真实 gate，验退出码与机器行；
 *   · offline-only：证明产物不被运行时 fetch / 功能全集 / 243 行判定依赖，
 *     并用「把真运行时产物当 offline-only」的自注入证明该判据能红。
 * EXTERNAL_GENERATORS 中 runtime-consumed 产物还钉住 sha256、验 git tracked、
 * FEATURE_DATA_SOURCES / sync RUNTIME_REACHABLE / www/data 字节一致。
 *
 * stdout：`PASS <name> <detail>` / `FAIL ...`；
 * 末行 `GENERATOR_CONTRACT_PASS count=26 external=3 offline=2 runtime=13 gate=14`
 * 或 `GENERATOR_CONTRACT_FAIL ... failed=N`。
 * 跑法：node tools/verify-generator-consumer-contract.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const MANIFEST_REL = 'tools/generator-consumer-contracts.json';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const gitOk = (args) => {
  try { execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch { return false; }
};
const isTracked = (rel) => gitOk(['ls-files', '--error-unmatch', rel]);
const isIgnored = (rel) => gitOk(['check-ignore', '-q', rel]);

const manifest = readJson(MANIFEST_REL);
const contracts = Array.isArray(manifest?.contracts) ? manifest.contracts : [];
const external = Array.isArray(manifest?.EXTERNAL_GENERATORS) ? manifest.EXTERNAL_GENERATORS : [];
const results = [];
const add = (ok, name, detail = '') => {
  results.push({ ok: Boolean(ok), name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
};
const info = (name, detail) => console.log(`INFO ${name} ${detail}`);

/* ── ① git tracked 生成器集合与清单一致性 ─────────────────────────── */
const trackedGenerators = execFileSync(
  'git', ['ls-files', 'tools/build-*', 'tools/export-*'],
  { cwd: ROOT, encoding: 'utf8' },
).split('\n').map((s) => s.trim()).filter(Boolean).sort();
const listedGenerators = contracts.map((c) => c.generator).sort();
const eqSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
add(eqSet(trackedGenerators, listedGenerators), 'GENERATOR_SET_EQUAL',
  `tracked=${trackedGenerators.length} listed=${listedGenerators.length}`);
if (!eqSet(trackedGenerators, listedGenerators)) {
  console.log(`GENERATOR_SET_DIFF onlyTracked=${JSON.stringify(trackedGenerators.filter((x) => !listedGenerators.includes(x)))}`
    + ` onlyListed=${JSON.stringify(listedGenerators.filter((x) => !trackedGenerators.includes(x)))}`);
}
add(contracts.length === manifest.countExpected, 'CONTRACT_COUNT_EXPECTED',
  `count=${contracts.length} expected=${manifest.countExpected}`);
add(external.length === manifest.externalExpected, 'EXTERNAL_COUNT_EXPECTED',
  `external=${external.length} expected=${manifest.externalExpected}`);

/* ── 通用工具 ──────────────────────────────────────────────────────── */
const artifactObjCache = new Map();
const artifactObj = (rel) => {
  if (!artifactObjCache.has(rel)) {
    let obj = null;
    try { obj = JSON.parse(read(rel)); } catch { /* src/* 产物是 JS 模块，不是 JSON */ }
    artifactObjCache.set(rel, obj);
  }
  return artifactObjCache.get(rel);
};
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 注入给 loadFeatureCatalog 的磁盘 fetch：真实读 data/ 下产物，不合成 fixture。 */
const diskFetch = async (url) => {
  const name = String(url || '').replace(/^data\//, '');
  const rel = `data/${name}`;
  try {
    if (!existsSync(join(ROOT, rel))) return { ok: false, json: async () => ({}) };
    const text = readFileSync(join(ROOT, rel), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, json: async () => ({}) };
  }
};

/** 从真实 rows 产物取一条嵌套 evidence 检查描述符（不用手写 fixture）。 */
const rowsNestedEvidenceCheck = () => {
  const doc = artifactObj('tools/align431-rows.json');
  const rows = [...(doc.baselineRows || []), ...(doc.addedRows || [])];
  for (const r of rows) {
    const cs = r.check && r.check.kind === 'all' ? r.check.of : [];
    for (const c of cs) if (c && c.kind === 'evidence') return c;
  }
  return null;
};

const resolveArg = (spec, artifactRel) => {
  if (spec && typeof spec === 'object' && !Array.isArray(spec) && '$' in spec) {
    switch (spec.$) {
      case 'artifact': return artifactObj(artifactRel);
      case 'artifactText': return read(artifactRel);
      case 'artifactPath': return join(ROOT, artifactRel);
      case 'diskFetch': return diskFetch;
      case 'artifactField': {
        let v = artifactObj(artifactRel);
        for (const k of spec.path || []) v = v == null ? undefined : v[k];
        return v;
      }
      case 'rowsNestedEvidenceCheck': return rowsNestedEvidenceCheck();
      default: throw new Error(`unknown arg spec: ${spec.$}`);
    }
  }
  return spec;
};

const getPath = (obj, path) => {
  let v = obj;
  for (const k of path || []) v = v == null ? undefined : v[k];
  return v;
};

const namedAssertions = {
  platformTypeMapAgreesWithRuntime: (value, artifact) => {
    const types = artifact?.platformTypes || {};
    const key = Object.keys(types).find((k) => k.toLowerCase() === String(value ?? '').toLowerCase());
    return Boolean(key && Array.isArray(types[key]) && types[key].length > 0);
  },
};

const checkAssert = (value, spec, artifact) => {
  if (!spec || typeof spec !== 'object') return { ok: false, detail: 'assert spec missing' };
  if ('nonEmpty' in spec) {
    const ok = Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : typeof value === 'string' ? value.length > 0 : Boolean(value);
    return { ok, detail: `nonEmpty=${ok}` };
  }
  if ('jsonPathNonEmpty' in spec) {
    const v = getPath(value, spec.jsonPathNonEmpty);
    const ok = Array.isArray(v) ? v.length > 0
      : v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v);
    return { ok, detail: `path=${JSON.stringify(spec.jsonPathNonEmpty)} nonEmpty=${ok}` };
  }
  if ('pathCountGte' in spec) {
    const v = getPath(value, spec.pathCountGte.path);
    const ok = Array.isArray(v) && v.length >= spec.pathCountGte.min;
    return { ok, detail: `path=${JSON.stringify(spec.pathCountGte.path)} len=${Array.isArray(v) ? v.length : 'n/a'} min=${spec.pathCountGte.min}` };
  }
  if ('fieldEquals' in spec) {
    const ok = value != null && value[spec.fieldEquals.field] === spec.fieldEquals.value;
    return { ok, detail: `${spec.fieldEquals.field}=${JSON.stringify(value?.[spec.fieldEquals.field])} expected=${JSON.stringify(spec.fieldEquals.value)}` };
  }
  if ('equals' in spec) {
    const ok = value === spec.equals;
    return { ok, detail: `value=${JSON.stringify(value)} expected=${JSON.stringify(spec.equals)}` };
  }
  if ('countGte' in spec) {
    const ok = Array.isArray(value) && value.length >= spec.countGte;
    return { ok, detail: `count=${Array.isArray(value) ? value.length : 'n/a'} min=${spec.countGte}` };
  }
  if ('allTruthyField' in spec) {
    const ok = Array.isArray(value) && value.length > 0
      && value.every((x) => x && x[spec.allTruthyField]);
    return { ok, detail: `rows=${Array.isArray(value) ? value.length : 'n/a'} allTruthyField=${spec.allTruthyField}` };
  }
  if ('hasAllKeys' in spec) {
    const ok = value && typeof value === 'object'
      && spec.hasAllKeys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
    return { ok, detail: `keys=${JSON.stringify(Object.keys(value || {}))}` };
  }
  if ('named' in spec) {
    const fn = namedAssertions[spec.named];
    if (typeof fn !== 'function') return { ok: false, detail: `unknown named assertion ${spec.named}` };
    const ok = Boolean(fn(value, artifact));
    return { ok, detail: `named=${spec.named} ok=${ok}` };
  }
  return { ok: false, detail: 'no recognized assert operator' };
};

/* ── ② offline-only 非消费证明 + 自注入 ─────────────────────────────── */
const appSrc = read('src/app.js');
const catalogSrc = read('src/special-catalog.js');
const syncSrc = read('scripts/sync.mjs');
const rowsText = read('tools/align431-rows.json');
const consumptionSignals = (rel) => {
  const name = basename(rel);
  const sig = [];
  if (rowsText.includes(name)) sig.push('rows243');
  if (new RegExp(`fetch\\(\\s*['"]data/${escapeRe(name)}['"]`).test(appSrc)) sig.push('appFetch');
  if (catalogSrc.includes(`'${name}'`)) sig.push('featureCatalog');
  return sig;
};
const proveNotConsumed = (rel) => {
  const sig = consumptionSignals(rel);
  return { ok: sig.length === 0, detail: sig.length ? `consumedBy=${sig.join(',')}` : 'no runtime/rows consumption' };
};
const selfInject = proveNotConsumed('data/bind-plan.json');
add(!selfInject.ok, 'OFFLINE_PROOF_SELF_INJECTION_RED',
  `bind-plan.json would be flagged as ${selfInject.detail}`);

/* ── ③ gateCommand / nodeFunction 真执行 ───────────────────────────── */
const gateCache = new Map();
const runGate = (command) => {
  if (gateCache.has(command)) return gateCache.get(command);
  const argv = command.split(/\s+/).filter(Boolean);
  if (argv[0] === 'node') argv.shift();
  const run = spawnSync(process.execPath, argv, {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  });
  const rec = { status: run.status, out: `${run.stdout || ''}\n${run.stderr || ''}`, error: run.error };
  gateCache.set(command, rec);
  return rec;
};

const tally = { nodeFunction: 0, gateCommand: 0, 'offline-only': 0 };

/** nodeFunction 真执行：import 消费者函数 + 注入真实产物/磁盘 fetch。 */
const execNodeFunction = async (tag, artifactRel, ch) => {
  if (!ch.module || !ch.fn || !Array.isArray(ch.args)) {
    add(false, tag, 'NODEFN_SPEC_INVALID');
    return;
  }
  try {
    const mod = await import(pathToFileURL(join(ROOT, ch.module.replace(/^\.\//, ''))).href);
    const fn = mod[ch.fn];
    if (typeof fn !== 'function') { add(false, tag, `EXPORT_MISSING ${ch.fn}`); return; }
    const args = ch.args.map((a) => resolveArg(a, artifactRel));
    let value = fn(...args);
    if (ch.mode === 'async') value = await value;
    const a = checkAssert(value, ch.assert, artifactObj(artifactRel));
    add(a.ok, tag, `nodeFunction=${ch.fn} ${a.detail}`);
    tally.nodeFunction += 1;
  } catch (e) {
    add(false, tag, `NODE_EXEC_ERROR ${String(e?.message || e)}`);
  }
};

/* ── ④ tracked 生成器逐条真执行 ───────────────────────────────────── */
for (const c of contracts) {
  const tag = c.generator;
  const ch = c.check || {};
  const type = c.consumer;
  if (!(type in tally)) { add(false, tag, `unknown consumer type ${type}`); continue; }

  // 生成器必须仍是 git tracked，且源码确实声明该输出产物（output 路径改错 → 红）。
  if (!isTracked(c.generator)) { add(false, tag, `GENERATOR_NOT_TRACKED ${c.generator}`); continue; }
  const genSrc = read(c.generator);
  if (!genSrc.includes(basename(c.artifact))) {
    add(false, tag, `OUTPUT_DECLARATION_MISSING expected=${basename(c.artifact)}`);
    continue;
  }

  if (type === 'offline-only') {
    if (ch.prove !== 'notConsumedByRuntimeOrRows') { add(false, tag, 'OFFLINE_PROOF_REQUIRED'); continue; }
    const p = proveNotConsumed(c.artifact);
    add(p.ok, tag, `offline-only ${p.detail} reason="${ch.reason || ''}"`);
    tally[type] += 1;
    continue;
  }

  if (!existsSync(join(ROOT, c.artifact))) { add(false, tag, `ARTIFACT_MISSING ${c.artifact}`); continue; }

  if (type === 'gateCommand') {
    if (!ch.command || typeof ch.expectExit !== 'number' || typeof ch.expectLine !== 'string') {
      add(false, tag, 'GATE_SPEC_INVALID'); continue;
    }
    const run = runGate(ch.command);
    const lineOk = run.out.split('\n').some((l) => l.includes(ch.expectLine));
    const ok = !run.error && run.status === ch.expectExit && lineOk;
    add(ok, tag, `gate=${ch.command} exit=${run.status} expect=${ch.expectExit} line="${ch.expectLine}" hit=${lineOk}`);
    tally[type] += 1;
    continue;
  }
  if (type === 'nodeFunction') { await execNodeFunction(tag, c.artifact, ch); continue; }
}

/* ── ⑤ EXTERNAL_GENERATORS：未入库取证工具及其产物 ─────────────────── */
for (const e of external) {
  const gen = e.generator;
  const art = e.outputArtifact;
  // 决策：这些生成器保持未入库；若被跟踪则视为口径漂移。
  add(!isTracked(gen), `EXTERNAL_NOT_TRACKED ${gen}`, `tracked=${isTracked(gen)}`);

  // 未入库理由的 file:line 必须真的含绝对路径（本机在场时核；clone 缺席只记 INFO）。
  if (existsSync(join(ROOT, gen))) {
    const genLines = read(gen).split('\n');
    const cited = (e.evidenceLines || []).map((n) => genLines[n - 1] || '');
    const absHit = cited.filter((l) => /\/Users\/|\/tmp\//.test(l)).length;
    add(absHit > 0, `EXTERNAL_EVIDENCE_LINES ${gen}`,
      `lines=${JSON.stringify(e.evidenceLines || [])} absPathHits=${absHit}`);
  } else {
    info(`EXTERNAL_EVIDENCE_LINES ${gen}`, 'generator absent in clone (expected; not required)');
  }

  // 声明的 artifact 跟踪形态必须与 git 事实一致。
  const declared = e.artifactTracking;
  const trackedOk = declared === 'tracked' ? isTracked(art)
    : declared === 'local-ignored' ? (!isTracked(art) && isIgnored(art)) : false;
  add(trackedOk, `EXTERNAL_ARTIFACT_TRACKING ${gen}`,
    `declared=${declared} gitTracked=${isTracked(art)} gitIgnored=${isIgnored(art)}`);

  if (e.consumerKind === 'offline-only') {
    if (e.check?.prove !== 'notConsumedByRuntimeOrRows') {
      add(false, `EXTERNAL_OFFLINE ${gen}`, 'OFFLINE_PROOF_REQUIRED'); continue;
    }
    const p = proveNotConsumed(art);
    add(p.ok, `EXTERNAL_OFFLINE ${gen}`, `${p.detail} reason="${e.check.reason || ''}"`);
    tally['offline-only'] += 1;
    continue;
  }

  if (e.consumerKind !== 'runtime-consumed') {
    add(false, `EXTERNAL_CONSUMER_KIND ${gen}`, `unknown kind=${e.consumerKind}`); continue;
  }

  // runtime-consumed：存在 + sha 钉住 + FEATURE_DATA_SOURCES + sync 同步 + 真消费者 + www/data 字节一致。
  if (!existsSync(join(ROOT, art))) { add(false, `EXTERNAL_ARTIFACT ${gen}`, `MISSING ${art}`); continue; }
  const actualSha = sha256(read(art));
  add(actualSha === e.sha256, `EXTERNAL_ARTIFACT_SHA ${gen}`,
    `actual=${actualSha} pinned=${e.sha256}`);

  const name = basename(art);
  add(catalogSrc.includes(`'${name}'`), `EXTERNAL_FEATURE_SOURCE ${gen}`,
    `${name} in FEATURE_DATA_SOURCES=${catalogSrc.includes(`'${name}'`)}`);
  add(new RegExp(`'${escapeRe(name)}'`).test(syncSrc), `EXTERNAL_SYNC_REACHABLE ${gen}`,
    `${name} in sync RUNTIME_REACHABLE=${new RegExp(`'${escapeRe(name)}'`).test(syncSrc)}`);

  const wwwRel = `www/data/${name}`;
  if (existsSync(join(ROOT, wwwRel))) {
    const wwwSha = sha256(read(wwwRel));
    add(wwwSha === actualSha, `EXTERNAL_WWW_DATA_IDENTICAL ${gen}`,
      `wwwSha=${wwwSha} sourceSha=${actualSha}`);
  } else {
    info(`EXTERNAL_WWW_DATA_IDENTICAL ${gen}`, 'www/data not synced yet (npm test runs npm run sync first)');
  }

  await execNodeFunction(`EXTERNAL_RUNTIME_CONSUMER ${gen}`, art, e.check || {});
}

const failed = results.filter((r) => !r.ok).length;
const head = `GENERATOR_CONTRACT_${failed ? 'FAIL' : 'PASS'} count=${contracts.length}`
  + ` external=${external.length}`
  + ` offline=${tally['offline-only']} runtime=${tally.nodeFunction} gate=${tally.gateCommand}`;
console.log(failed ? `${head} failed=${failed}` : head);
process.exit(failed ? 1 : 0);
