#!/usr/bin/env node
/**
 * tools/verify-www-data-identical.mjs
 * 门禁：**WWW_DATA_BYTE_IDENTICAL**
 *
 * 为什么需要它（2026-11-16 核执行器数据时挖出的假绿洞）
 * ───────────────────────────────────────────────────────
 * 数据/取证类门禁（verify-all-models / verify-write-gate / verify-fullchain-audit /
 * verify-catalog-frame-bytes / verify-comm-timeouts …）读的都是仓库根的 `data/…`；
 * 只有 boot-smoke / e2e-flow / smoke-fixes 碰 `www/`，且它们读的是**代码产物**
 * （`www/app.bundle.js`、`www/index.html`、`www/feature-catalog.js`）。
 * 也就是说：**没有任何一条门禁断言 `www/data/*.json` 与 `data/*.json` 字节相等** ——
 * 而 `www/data/` 才是装进 app、被浏览器 fetch 的出厂产物。
 * `scripts/sync.mjs` 负责 data/ → www/data/ 的拷贝，但它自己那条
 * `SYNC_DATA_CONSISTENT` 只统计三类条数，同样不断言两边字节相等。
 * 于是出现：`data/actuator.json` 已重建成 `form:'2f'` 320 条 / 288 个不同 DID，
 * 而 `www/data/actuator.json` 还是旧的 150 条、149 条塌缩成 `did=0x0101`
 * —— 门禁全绿，装进 app 的执行器目录全是错的。这一层只能由确定性命令钉死。
 *
 * 三段判据
 * ───────
 * [A] 同步集**逐文件逐字节**相等
 *     · 同步集从 `scripts/sync.mjs` **现读**（`SKIP` / `RUNTIME_REACHABLE` 两个数组
 *       字面量 + `skip()` 里的排除正则），本文件不另抄一份 —— 抄一份就会出现
 *       「门禁认为该同步、sync 实际不同步」的口径漂移。**解析失败即判红**，不静默跳过。
 *     · data/ 下（含 models/ 递归）每个未被 skip 的 .json：www/data 同名文件必须存在且 sha256 相等；
 *     · 反向：www/data 下任何 json 都必须属于同步集（抓「清空后旧产物滞留」、SKIP 漏网）；
 *     · `RUNTIME_REACHABLE` 与 `www/feature-catalog.js` 的 `FEATURE_DATA_SOURCES`
 *       必须是**同一集合**（两份清单在两个不同文件里，删一处漏一处必红）。
 * [B] 反向自检：在 `fs.mkdtempSync` 的副本里分别做「改一个字节 / 删一个文件 /
 *     多一个文件」，比对器必须三档都报红。三档里任何一档「也通过」= 比对恒真，
 *     打印 `SELF_CHECK_FAILED` 并 exit 1。
 * [C] 出厂产物**行为级**校验（不只是文件相等）
 *     直接 `import()` 浏览器侧 `www/feature-catalog.js`（它 re-export
 *     `www/www-schema.js`，**不是** `src/schema.js`），从 `www/data/actuator.json`
 *     取 3 条 DID 互不相同的 `form:'2f'` 条目真实构帧，断言：
 *       帧长 8 字节 / SID 0x2F / 帧内 DID === entry.did / 三帧互不相同。
 *     另断言 8 字节帧条目数 ≥ 300、distinct DID ≥ 250（下界表述，不写死 320/288）。
 *     反向自检：塌缩形态（三条同 DID、149/150 塌到 0x0101 那种）喂进同一判定函数
 *     必须返回失败 —— 证明它真能抓塌缩。
 *     ⚠️ C 依赖 sync：www/data 与 data 字节不等时 C 直接红并提示跑 `node scripts/sync.mjs`，
 *        不会用「旧产物也算过」的方式掩盖。
 *
 * 跑法：node tools/verify-www-data-identical.mjs
 * 退出码：全过 0 / 任一不符或反向自检失败 1
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSERTION = 'WWW_DATA_BYTE_IDENTICAL';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SYNC_MJS = path.join(ROOT, 'scripts', 'sync.mjs');
const DATA_DIR = path.join(ROOT, 'data');
const WWW_DATA_DIR = path.join(ROOT, 'www', 'data');
const WWW_CATALOG = path.join(ROOT, 'www', 'feature-catalog.js');
const SRC_SCHEMA = path.join(ROOT, 'src', 'schema.js');

let pass = 0;
let fail = 0;
const failures = [];

/**
 * 记录一条断言。
 * @param {string} name 断言名（含 [A]/[B]/[C] 段前缀）
 * @param {boolean} cond
 * @param {string} [extra] 失败/通过时都打印的细节
 * @returns {boolean}
 */
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${extra ? ' -- ' + extra : ''}`);
  }
  return !!cond;
}

/** 一段的汇总行。 */
function sectionSummary(label, okCount, total) {
  console.log(`    ${label}: ${okCount}/${total}`);
}

/** 相对路径统一成正斜杠，便于跨平台比较与打印。 */
const toPosix = (p) => p.split(path.sep).join('/');

/**
 * 递归列出目录下全部 `.json` 文件（相对路径，正斜杠）。目录不存在返回空数组。
 * @param {string} root
 * @returns {string[]}
 */
function walkJson(root) {
  const out = [];
  const rec = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(childAbs, childRel);
      else if (e.isFile() && e.name.endsWith('.json')) out.push(childRel);
    }
  };
  rec(root, '');
  out.sort();
  return out;
}

/**
 * 文件的 sha256（十六进制小写）。
 * @param {string} abs
 * @returns {string}
 */
function sha256File(abs) {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/**
 * 从一段源码里取某个 `const NAME = <opener>[...]<closer>` 的字符串元素。
 *
 * 只认**数组字面量里的引号字符串**：注释里没有引号，因此不会被注释里的文字污染。
 * 找不到声明 / 元素为空 → 返回 null（调用方判红，绝不返回空数组冒充成功）。
 * @param {string} text 源文件全文
 * @param {string} constName 常量名
 * @returns {{values: string[], raw: string}|null}
 */
function parseStringArrayLiteral(text, constName) {
  const head = new RegExp(`const\\s+${constName}\\s*=\\s*(?:new\\s+Set|Object\\.freeze)?\\s*\\(?\\s*\\[`);
  const m = head.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = text.indexOf(']', start);
  if (end < 0) return null;
  const body = text.slice(start, end);
  const values = [];
  const re = /['"]([^'"\r\n]+)['"]/g;
  let s = re.exec(body);
  while (s !== null) {
    values.push(s[1]);
    s = re.exec(body);
  }
  if (!values.length) return null;
  return { values, raw: body.trim() };
}

/**
 * 从 `scripts/sync.mjs` 现读同步清单（唯一真值，不在本文件另抄一份）。
 *
 * 解析三样：
 *   · `const SKIP = new Set([...])`          —— 明确排除的中间产物（按 basename）
 *   · `const RUNTIME_REACHABLE = ...([...])` —— UI 运行时真 fetch 的零 fetch 数据源
 *   · `const skip = (name) => SKIP.has(name) || /<regex>/.test(name)` —— 排除正则
 *
 * 任何一样解析不出来 → 抛错（由调用方判红）。宁可比对器失效时报红，
 * 也不能在清单读不到时静默返回空集把门禁变成恒真。
 * @param {string} syncText
 * @returns {{skip:Set<string>, runtimeReachable:string[], skipPattern:RegExp, skipPatternSource:string}}
 */
function parseSyncManifest(syncText) {
  const skipDecl = parseStringArrayLiteral(syncText, 'SKIP');
  if (!skipDecl) throw new Error('解析不到 `const SKIP = new Set([...])` 的字符串元素');
  const runtimeDecl = parseStringArrayLiteral(syncText, 'RUNTIME_REACHABLE');
  if (!runtimeDecl) throw new Error('解析不到 `const RUNTIME_REACHABLE = ...([...])` 的字符串元素');
  const reDecl = /const\s+skip\s*=\s*\(\s*name\s*\)\s*=>\s*SKIP\.has\(\s*name\s*\)\s*\|\|\s*\/(.+?)\/\.test\(\s*name\s*\)/.exec(syncText);
  if (!reDecl) throw new Error('解析不到 `const skip = (name) => SKIP.has(name) || /<regex>/.test(name)`');
  const skipPatternSource = reDecl[1];
  let skipPattern;
  try {
    skipPattern = new RegExp(skipPatternSource);
  } catch (err) {
    throw new Error(`排除正则非法（/${skipPatternSource}/）：${err.message}`);
  }
  return {
    skip: new Set(skipDecl.values),
    runtimeReachable: runtimeDecl.values.slice(),
    skipPattern,
    skipPatternSource,
  };
}

/**
 * 单文件双端字节比较（供 C 段「C 依赖 sync」判定复用）。
 * @param {string} rel data/ 下的相对路径
 * @param {string} dataRoot
 * @param {string} wwwRoot
 * @returns {{present:boolean, equal:boolean, dataHash:string, wwwHash:string}}
 */
function compareOne(rel, dataRoot, wwwRoot) {
  const a = path.join(dataRoot, rel);
  const b = path.join(wwwRoot, rel);
  const present = fs.existsSync(a) && fs.existsSync(b);
  if (!present) return { present: false, equal: false, dataHash: '', wwwHash: '' };
  const dataHash = sha256File(a);
  const wwwHash = sha256File(b);
  return { present: true, equal: dataHash === wwwHash, dataHash, wwwHash };
}

/**
 * 双端同步集比对（纯函数式：只读两个根目录，不依赖全局状态，便于反向自检复用）。
 *
 * 判据：
 *   ① 同步集内每个文件在 www 侧存在（缺失即错）
 *   ② 双端 sha256 相等（字节相等，不做 JSON 语义比较 —— 出厂产物是字节）
 *   ③ www 侧不得存在同步集之外的 json（多余即错：清空后旧产物滞留 / SKIP 漏网）
 * @param {{dataRoot:string, wwwRoot:string, isSkipped:(base:string)=>boolean}} opts
 * @returns {{ok:boolean, syncRel:string[], skippedRel:string[], identical:number,
 *   missing:string[], differing:{rel:string,dataHash:string,wwwHash:string}[],
 *   extra:string[], wwwJson:number}}
 */
function compareTrees({ dataRoot, wwwRoot, isSkipped }) {
  const dataRel = walkJson(dataRoot);
  const wwwRel = walkJson(wwwRoot);
  const syncRel = dataRel.filter((rel) => !isSkipped(path.posix.basename(rel)));
  const skippedRel = dataRel.filter((rel) => isSkipped(path.posix.basename(rel)));
  const syncSet = new Set(syncRel);
  const wwwSet = new Set(wwwRel);

  const missing = [];
  const differing = [];
  let identical = 0;
  for (const rel of syncRel) {
    if (!wwwSet.has(rel)) {
      missing.push(rel);
      continue;
    }
    const dataHash = sha256File(path.join(dataRoot, rel));
    const wwwHash = sha256File(path.join(wwwRoot, rel));
    if (dataHash === wwwHash) identical += 1;
    else differing.push({ rel, dataHash, wwwHash });
  }
  const extra = wwwRel.filter((rel) => !syncSet.has(rel));

  return {
    ok: syncRel.length > 0 && missing.length === 0 && differing.length === 0 && extra.length === 0,
    syncRel,
    skippedRel,
    identical,
    missing,
    differing,
    extra,
    wwwJson: wwwRel.length,
  };
}

/** 打印清单：前 n 条 + 总数。 */
function printList(label, items, n = 5) {
  if (!items.length) {
    console.log(`    ${label}: 无`);
    return;
  }
  console.log(`    ${label}（前 ${Math.min(n, items.length)} / 共 ${items.length}）：`);
  for (const it of items.slice(0, n)) console.log(`      - ${it}`);
}

// ───────────────────────────────────────────────────────────────────
// 头部：现读同步清单
// ───────────────────────────────────────────────────────────────────
console.log(`\n=== ${ASSERTION} ===`);

let manifest = null;
let manifestError = '';
try {
  manifest = parseSyncManifest(fs.readFileSync(SYNC_MJS, 'utf8'));
} catch (err) {
  manifestError = err.message;
}

const manifestOk = check('[A] scripts/sync.mjs 的同步清单可解析（SKIP / RUNTIME_REACHABLE / skip 正则）',
  manifest !== null, manifestError || '三样全部解析成功');

if (manifest) {
  console.log(`同步清单（现读 ${toPosix(path.relative(ROOT, SYNC_MJS))}）：SKIP ${manifest.skip.size} 项`
    + ` · RUNTIME_REACHABLE ${manifest.runtimeReachable.length} 项`
    + ` · 排除正则 /${manifest.skipPatternSource}/`);
  console.log(`  SKIP = [${[...manifest.skip].join(', ')}]`);
} else {
  console.log(`同步清单解析失败：${manifestError}`);
  console.log('  ⚠ 清单读不到就无法确定「该同步哪些文件」—— 判红，不静默跳过。');
}

/** 排除判定（basename 口径，与 sync.mjs 的 copyDir 完全一致）。 */
const isSkipped = (base) => (manifest
  ? (manifest.skip.has(base) || manifest.skipPattern.test(base))
  : false);

// ───────────────────────────────────────────────────────────────────
// [A] 同步集逐文件逐字节相等
// ───────────────────────────────────────────────────────────────────
console.log('\n[A] 同步集逐文件逐字节相等（data/**/*.json → www/data/**/*.json）');
const report = manifest
  ? compareTrees({ dataRoot: DATA_DIR, wwwRoot: WWW_DATA_DIR, isSkipped })
  : { ok: false, syncRel: [], skippedRel: [], identical: 0, missing: [], differing: [], extra: [], wwwJson: 0 };

if (manifest) {
  console.log(`    同步集 ${report.syncRel.length} 个文件 · 一致 ${report.identical}/${report.syncRel.length}`
    + ` · 缺失 ${report.missing.length} · 内容不同 ${report.differing.length}`
    + ` · www/data 多余 ${report.extra.length}（www/data 实存 ${report.wwwJson} 个 json）`);
  // 目录分层只打「前 5 大 + 其余合计」：models/ 下有 26 个车型目录，
  // 逐目录列全会把 CI 日志撑长；这里纯属人看的摘要，**不参与任何断言**。
  {
    const byDir = new Map();
    for (const rel of report.syncRel) {
      const d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
      byDir.set(d, (byDir.get(d) || 0) + 1);
    }
    const dirRows = [...byDir.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = dirRows.slice(0, 5);
    const rest = dirRows.slice(5);
    const restFiles = rest.reduce((s, [, n]) => s + n, 0);
    console.log(`    同步集按目录分层（前 5 大 + 合计）：${top.map(([d, n]) => `${d}=${n}`).join(' · ')}`
      + (rest.length ? ` · 其余 ${rest.length} 个目录共 ${restFiles} 个文件` : '')
      + ` · 合计 ${report.syncRel.length} 个文件 / ${byDir.size} 个目录`);
  }
  // data 侧被 skip 的文件（不进安装包）。注意 skip 按 basename 匹配，与 sync 的 copyDir 一致。
  // 若它们仍残留在 www/data，会出现在下面的「多余」清单里 —— 那正是清空没生效的信号。
  printList('被 skip 的中间产物（data 侧，不进安装包）', report.skippedRel);
  printList('缺失（data 有、www/data 无）', report.missing);
  printList('内容不同（sha256 不等）', report.differing.map((d) => `${d.rel}  data=${d.dataHash.slice(0, 12)}… www=${d.wwwHash.slice(0, 12)}…`));
  printList('多余（www/data 有、同步集无）', report.extra);
}

check('[A] 同步集非空（清单解析出了真实文件，不是空集自证）',
  manifest ? report.syncRel.length >= 20 : false,
  `同步集 ${report.syncRel.length} 个 json`);
check('[A] 同步集每个文件在 www/data 都存在', report.missing.length === 0,
  `缺失 ${report.missing.length} 个${report.missing.length ? `：${report.missing.slice(0, 5).join(', ')}` : ''}`);
check('[A] 同步集每个文件双端 sha256 相等（逐字节）',
  report.differing.length === 0 && report.identical === report.syncRel.length,
  `一致 ${report.identical}/${report.syncRel.length}，内容不同 ${report.differing.length}`
  + (report.differing.length ? `：${report.differing.slice(0, 5).map((d) => d.rel).join(', ')}` : ''));
check('[A] www/data 无同步集之外的 json（清空后旧产物不得滞留）',
  report.extra.length === 0,
  `多余 ${report.extra.length}${report.extra.length ? `：${report.extra.slice(0, 5).join(', ')}` : ''}`);
sectionSummary('[A] 逐字节一致', report.identical, report.syncRel.length);

if (manifest) {
  // RUNTIME_REACHABLE 必须全部真的在同步集里（否则浏览器 fetch 404）
  const missingRuntime = manifest.runtimeReachable.filter((n) => !report.syncRel.includes(n));
  check('[A] RUNTIME_REACHABLE 全部落在同步集内（运行时可达 ≠ 被 SKIP 掉）',
    missingRuntime.length === 0,
    `缺 ${missingRuntime.length} 个${missingRuntime.length ? `：${missingRuntime.join(', ')}` : ''}`);

  // 跨文件交叉校验：sync.mjs 的 RUNTIME_REACHABLE vs www/feature-catalog.js 的 FEATURE_DATA_SOURCES
  let catalogSources = null;
  try {
    catalogSources = parseStringArrayLiteral(fs.readFileSync(WWW_CATALOG, 'utf8'), 'FEATURE_DATA_SOURCES');
  } catch (err) {
    catalogSources = null;
    console.log(`    ⚠ 读 www/feature-catalog.js 失败：${err.message}`);
  }
  const declared = catalogSources ? catalogSources.values : [];
  const setA = new Set(manifest.runtimeReachable);
  const setB = new Set(declared);
  const onlySync = manifest.runtimeReachable.filter((n) => !setB.has(n));
  const onlyCatalog = declared.filter((n) => !setA.has(n));
  check('[A] RUNTIME_REACHABLE（sync.mjs）与 FEATURE_DATA_SOURCES（www/feature-catalog.js）是同一集合',
    catalogSources !== null && onlySync.length === 0 && onlyCatalog.length === 0
      && setA.size === manifest.runtimeReachable.length && setB.size === declared.length,
    catalogSources === null ? 'www/feature-catalog.js 未解析出 FEATURE_DATA_SOURCES'
      : `sync.mjs ${setA.size} 项 / www ${setB.size} 项`
        + `${onlySync.length ? `；仅 sync.mjs 有：${onlySync.join(',')}` : ''}`
        + `${onlyCatalog.length ? `；仅 www 有：${onlyCatalog.join(',')}` : ''}`);
}

// ───────────────────────────────────────────────────────────────────
// [A+] 产物代码副本：sync.mjs 还会把 src 的两个模块重写成 www/ 下的纯 ESM 产物
//   · www/www-schema.js  = src/schema.js 原样拷贝
//   · www/feature-catalog.js = src/special-catalog.js，且 `from './schema.js'`
//     必须被改写为 `from './www-schema.js'`（否则浏览器 404、整模块图挂掉）
// 这两条与 data/ 是同一类缺陷：改了 src 忘了 sync，装进 app 的就是旧代码。
// ───────────────────────────────────────────────────────────────────
console.log('\n[A+] 产物代码副本与 src 源文件的一致性');
{
  const WWW_SCHEMA = path.join(ROOT, 'www', 'www-schema.js');
  const SRC_CATALOG = path.join(ROOT, 'src', 'special-catalog.js');
  const schemaSrc = path.join(ROOT, 'src', 'schema.js');
  const hasAll = [WWW_SCHEMA, SRC_CATALOG, WWW_CATALOG, schemaSrc].every((p) => fs.existsSync(p));
  if (!hasAll) {
    check('[A+] 产物代码副本存在（www/www-schema.js · www/feature-catalog.js）', false,
      '有文件缺失');
  } else {
    const schemaSame = sha256File(WWW_SCHEMA) === sha256File(schemaSrc);
    check('[A+] www/www-schema.js 与 src/schema.js 逐字节相等（sync 原样拷贝）', schemaSame,
      schemaSame ? '一致' : `www=${sha256File(WWW_SCHEMA).slice(0, 12)}… src=${sha256File(schemaSrc).slice(0, 12)}…`
        + ' —— 改了 src/schema.js 未跑 sync');
    const expectedCatalog = fs.readFileSync(SRC_CATALOG, 'utf8')
      .replace(/from '\.\/schema\.js'/g, "from './www-schema.js'");
    const actualCatalog = fs.readFileSync(WWW_CATALOG, 'utf8');
    const catalogSame = expectedCatalog === actualCatalog;
    check('[A+] www/feature-catalog.js = src/special-catalog.js 的 sync 改写结果（逐字节）', catalogSame,
      catalogSame ? `一致（${actualCatalog.length} 字节）`
        : `www=${actualCatalog.length} 字节 / 期望=${expectedCatalog.length} 字节`
          + ' —— 改了 src/special-catalog.js 未跑 sync');
    if (!schemaSame || !catalogSame) {
      console.log('    ⚠ 这两条与 [A] 一样是「预期红」：跑 node scripts/sync.mjs 后自动转绿。');
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// [B] 反向自检：变更必须被比对器抓到（mkdtemp 副本，绝不碰真文件）
// ───────────────────────────────────────────────────────────────────
console.log('\n[B] 反向自检：副本里改字节/删文件/多文件，比对器必须报红');
let selfCheckOk = true;
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wwwdata-'));
  const dataRoot = path.join(tmp, 'data');
  const wwwRoot = path.join(tmp, 'www');
  const skipTmp = (base) => base === 'skip-me.json';
  try {
    fs.mkdirSync(path.join(dataRoot, 'models'), { recursive: true });
    fs.mkdirSync(path.join(wwwRoot, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'a.json'), '{"k":1}\n');
    fs.writeFileSync(path.join(dataRoot, 'models', 'b.json'), '{"k":2}\n');
    fs.writeFileSync(path.join(dataRoot, 'skip-me.json'), '{"k":3}\n');
    fs.writeFileSync(path.join(wwwRoot, 'a.json'), '{"k":1}\n');
    fs.writeFileSync(path.join(wwwRoot, 'models', 'b.json'), '{"k":2}\n');

    const base = compareTrees({ dataRoot, wwwRoot, isSkipped: skipTmp });
    const okBase = check('[B] 基线副本（两侧字节相同）比对器必须判「一致」',
      base.ok && base.identical === 2 && base.syncRel.length === 2 && base.extra.length === 0,
      `ok=${base.ok} 一致=${base.identical}/${base.syncRel.length} 缺失=${base.missing.length}`
      + ` 多余=${base.extra.length} 跳过=${base.skippedRel.length}`);
    console.log(`    ① 基线（2 个文件两侧相同）：ok=${base.ok} 一致=${base.identical}/2 跳过=${base.skippedRel.length}`
      + ` → ${okBase ? '按预期判一致' : '未按预期'}`);

    // ① 改一个字节
    fs.writeFileSync(path.join(wwwRoot, 'a.json'), '{"k":9}\n');
    const flipped = compareTrees({ dataRoot, wwwRoot, isSkipped: skipTmp });
    const okFlip = check('[B] 副本里改一个字节 → 必须判「内容不同」',
      !flipped.ok && flipped.differing.length === 1 && flipped.differing[0].rel === 'a.json',
      `ok=${flipped.ok} differing=${JSON.stringify(flipped.differing.map((d) => d.rel))}`);
    console.log(`    ② 改 1 字节：ok=${flipped.ok} 内容不同=${JSON.stringify(flipped.differing.map((d) => d.rel))}`
      + ` → ${okFlip ? '按预期报红' : '未报红'}`);
    fs.writeFileSync(path.join(wwwRoot, 'a.json'), '{"k":1}\n');

    // ② 删一个文件
    fs.unlinkSync(path.join(wwwRoot, 'models', 'b.json'));
    const removed = compareTrees({ dataRoot, wwwRoot, isSkipped: skipTmp });
    const okRemoved = check('[B] 副本里删掉一个文件 → 必须判「缺失」',
      !removed.ok && removed.missing.length === 1 && removed.missing[0] === 'models/b.json',
      `ok=${removed.ok} missing=${JSON.stringify(removed.missing)}`);
    console.log(`    ③ 删 1 个文件：ok=${removed.ok} 缺失=${JSON.stringify(removed.missing)}`
      + ` → ${okRemoved ? '按预期报红' : '未报红'}`);
    fs.writeFileSync(path.join(wwwRoot, 'models', 'b.json'), '{"k":2}\n');

    // ③ 多一个文件（模拟「清空没生效，旧中间产物滞留」）
    fs.writeFileSync(path.join(wwwRoot, 'stale.json'), '{"k":4}\n');
    const extra = compareTrees({ dataRoot, wwwRoot, isSkipped: skipTmp });
    const okExtra = check('[B] 副本里多一个 www 侧 json → 必须判「多余」',
      !extra.ok && extra.extra.length === 1 && extra.extra[0] === 'stale.json',
      `ok=${extra.ok} extra=${JSON.stringify(extra.extra)}`);
    console.log(`    ④ 多 1 个文件：ok=${extra.ok} 多余=${JSON.stringify(extra.extra)}`
      + ` → ${okExtra ? '按预期报红' : '未报红'}`);
    fs.unlinkSync(path.join(wwwRoot, 'stale.json'));

    // ④ 同步集为空时必须判红（防「清单解析成空集 → 恒真」）
    const emptyData = path.join(tmp, 'empty');
    fs.mkdirSync(emptyData, { recursive: true });
    const empty = compareTrees({ dataRoot: emptyData, wwwRoot, isSkipped: skipTmp });
    const okEmpty = check('[B] 同步集为空 → 必须判红（不允许空集恒真）',
      !empty.ok, `ok=${empty.ok} 同步集=${empty.syncRel.length}`);
    console.log(`    ⑤ 同步集为空：ok=${empty.ok} 同步集=${empty.syncRel.length}`
      + ` → ${okEmpty ? '按预期报红' : '未报红'}`);

    selfCheckOk = okBase && okFlip && okRemoved && okExtra && okEmpty;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (!selfCheckOk) {
    console.log('    SELF_CHECK_FAILED：变更未被比对器抓到 —— 比对是恒真的，[A] 的绿不可信。');
  }
}

// ───────────────────────────────────────────────────────────────────
// [C] 出厂产物行为级校验
//   ⚠️ 必须 import 浏览器侧 www/feature-catalog.js（它 re-export www/www-schema.js）。
//      直接从 src/schema.js 取实现会让「产物里那份是不是坏的」检不出来。
// ───────────────────────────────────────────────────────────────────
console.log('\n[C] 出厂产物行为级：用 www/ 侧的构帧实现跑 www/data/ 的条目');

/** 2F 默认驱动态（记录默认值；用于「帧长 8 字节」这一档判据）。 */
const STATE_4B = /^[0-9A-F]{8}$/;

/** 字节串规范化：'FF 00 00 00' / 'ff000000' → 'FF000000'。 */
function normHex(v) {
  if (v == null) return '';
  return String(v).replace(/0x/gi, ' ').split(/[^0-9A-Fa-f]+/).filter(Boolean)
    .map((t) => t.toUpperCase().padStart(2, '0')).join('').toUpperCase();
}

/**
 * 「三条不同 DID 的 2f 条目必须生成三条互不相同的 8 字节帧」判定（单一实现，
 * 真实数据与塌缩自检都走它）。
 * @param {object[]} entries
 * @param {(kind:string, entry:object)=>string[]} framesFor 构帧实现（注入，便于自检）
 * @returns {{ok:boolean, reasons:string[], frames:string[], bytes:number[]}}
 */
function evalThreeFrames(entries, framesFor) {
  const reasons = [];
  const frames = [];
  const bytes = [];
  if (!Array.isArray(entries) || entries.length !== 3) reasons.push(`条目数 ${entries ? entries.length : 0} ≠ 3`);
  for (const [i, entry] of (entries || []).entries()) {
    const out = framesFor('actuator', entry);
    if (!Array.isArray(out) || out.length !== 1) {
      reasons.push(`第 ${i + 1} 条 featureFramesFor 返回 ${Array.isArray(out) ? out.length : '非数组'} 帧`);
      frames.push('');
      bytes.push(NaN);
      continue;
    }
    const hex = out[0];
    frames.push(hex);
    bytes.push(hex.length / 2);
    if (!/^2F/i.test(hex)) reasons.push(`第 ${i + 1} 条 SID 不是 0x2F：${hex}`);
    if (hex.length !== 16) reasons.push(`第 ${i + 1} 条帧长 ${hex.length / 2} 字节 ≠ 8：${hex}`);
    const didInFrame = Number.parseInt(hex.slice(2, 6), 16);
    if (didInFrame !== Number(entry.did)) {
      reasons.push(`第 ${i + 1} 条帧内 DID 0x${didInFrame.toString(16).padStart(4, '0')}`
        + ` ≠ entry.did 0x${Number(entry.did).toString(16).padStart(4, '0')}`);
    }
  }
  if (new Set(frames).size !== frames.length) {
    reasons.push(`三帧不互不相同（distinct=${new Set(frames).size}）：${frames.join(' / ')}`);
  }
  const dids = (entries || []).map((e) => Number(e.did));
  if (new Set(dids).size !== dids.length) reasons.push(`三条条目 DID 互不相同的前提不成立：${dids.join(',')}`);
  return { ok: reasons.length === 0, reasons, frames, bytes };
}

let catalogMod = null;
let srcSchemaMod = null;
try {
  catalogMod = await import(pathToFileURL(WWW_CATALOG).href);
} catch (err) {
  console.log(`    ⚠ import www/feature-catalog.js 失败：${err.message}`);
}
try {
  srcSchemaMod = await import(pathToFileURL(SRC_SCHEMA).href);
} catch (err) {
  console.log(`    ⚠ import src/schema.js 失败：${err.message}`);
}

const catalogText = fs.existsSync(WWW_CATALOG) ? fs.readFileSync(WWW_CATALOG, 'utf8') : '';
check('[C] www/feature-catalog.js 已把 `from \'./schema.js\'` 改写成 `from \'./www-schema.js\'`',
  catalogText.includes("from './www-schema.js'") && !/from\s+'\.\/schema\.js'/.test(catalogText),
  catalogText ? '改写已生效（浏览器侧不会 404）' : '文件不存在');
check('[C] 构帧实现取自产物副本（不是 src/schema.js）',
  catalogMod !== null && srcSchemaMod !== null
    && typeof catalogMod.featureFramesFor === 'function'
    && catalogMod.featureFramesFor !== srcSchemaMod.featureFramesFor,
  catalogMod && srcSchemaMod
    ? `www 侧 ${typeof catalogMod.featureFramesFor} ≠ src 侧实现（同一函数对象则说明取错了文件）`
    : '模块未加载');

// ── C 依赖 sync：www/data/actuator.json 必须与 data/actuator.json 字节相等 ──
const actuatorIdentity = compareOne('actuator.json', DATA_DIR, WWW_DATA_DIR);
const cSyncReady = check('[C] C 依赖 sync：www/data/actuator.json 与 data/actuator.json 逐字节相等',
  actuatorIdentity.equal,
  actuatorIdentity.present
    ? `data=${actuatorIdentity.dataHash.slice(0, 12)}… www=${actuatorIdentity.wwwHash.slice(0, 12)}…`
      + (actuatorIdentity.equal ? '' : ' —— 先跑 `node scripts/sync.mjs` 重建 www/data，行为级校验才有意义')
    : '文件缺失');

if (!cSyncReady) {
  console.log('    ⚠ C 段后续断言跳过（按失败记账）：www/data 是旧产物，跑出来的行为结果不代表出厂状态。');
  check('[C] 2f 条目数下界 / distinct DID 下界 / 三帧互异（依赖 sync）', false,
    'www/data/actuator.json 过期，未执行 —— 见上一条');
} else if (catalogMod === null) {
  check('[C] 产物构帧实现可加载（www/feature-catalog.js）', false, 'import 失败');
} else {
  const doc = JSON.parse(fs.readFileSync(path.join(WWW_DATA_DIR, 'actuator.json'), 'utf8'));
  const items = Array.isArray(doc.items) ? doc.items : (Array.isArray(doc) ? doc : []);
  const items2f = items.filter((x) => String(x.form || '').toLowerCase() === '2f');
  const dids = new Set(items2f.map((x) => Number(x.did)));
  const eightByte = items2f.filter((x) => STATE_4B.test(normHex(x.drive && x.drive.state)));

  // 取 3 条 DID 互不相同、且 state 为 4 字节（→ 8 字节帧）的条目，按数据原顺序
  const picked = [];
  const seen = new Set();
  for (const it of items2f) {
    const d = Number(it.did);
    if (seen.has(d)) continue;
    if (!STATE_4B.test(normHex(it.drive && it.drive.state))) continue;
    seen.add(d);
    picked.push(it);
    if (picked.length === 3) break;
  }

  const sampleFrame = picked.length ? (catalogMod.featureFramesFor('actuator', picked[0]) || [])[0] || '(空)' : '(未取到条目)';
  console.log(`    www/data/actuator.json：条目 ${items.length} · 2f ${items2f.length} · distinct DID ${dids.size}`
    + ` · 4 字节 state（→8 字节帧）${eightByte.length} 条`);
  console.log(`    取样 3 条：${picked.map((it) => `did=${it.didHex || it.did}`).join(' / ')}`);
  console.log(`    首帧样例：${sampleFrame}（${sampleFrame.length / 2} 字节）`);

  check('[C] www/data/actuator.json 的 form:\'2f\' 条目数 ≥ 300（下界，不写死 320）',
    items2f.length >= 300, `${items2f.length} 条`);
  check('[C] form:\'2f\' 的 distinct DID ≥ 250（下界，不写死 288；塌缩形态会掉到 1~2）',
    dids.size >= 250, `${dids.size} 个`);
  check('[C] 能取到 3 条 DID 互不相同的 2f 条目用于构帧', picked.length === 3,
    `取到 ${picked.length} 条`);

  const three = evalThreeFrames(picked, catalogMod.featureFramesFor);
  console.log(`    三帧：${three.frames.map((f) => f || '(空)').join(' / ')}`);
  check('[C] 三条真实条目 → 三帧均 8 字节 / SID 0x2F / 帧内 DID 正确 / 三帧互不相同',
    three.ok, three.ok ? '三条全过' : `不符 ${three.reasons.length} 项：${three.reasons.join('；')}`);

  // 诊断（不单独判分）：取前 3 条 2f 条目（不管 DID 是否互异）直接打印帧，
  // 塌缩形态在这一行会一眼看出来 —— 三条帧完全相同就是塌缩。
  const head3 = items2f.slice(0, 3);
  const head3Frames = head3.map((it) => (catalogMod.featureFramesFor('actuator', it) || [])[0] || '(空)');
  console.log(`    诊断（前 3 条 2f，不论 DID）did=${head3.map((it) => it.didHex || it.did).join('/')}`
    + ` → 帧 ${head3Frames.join(' / ')}（distinct=${new Set(head3Frames).size}）`);

  // 反向自检：塌缩形态必须被判失败（旧 150 条全塌到 0x0101 的形态）
  const collapsed = [
    { name: '塌缩-1', form: '2f', did: 0x0101, drive: { controlOption: 3, state: 'FF 00 00 00' } },
    { name: '塌缩-2', form: '2f', did: 0x0101, drive: { controlOption: 3, state: 'FF 00 00 00' } },
    { name: '塌缩-3', form: '2f', did: 0x0101, drive: { controlOption: 3, state: 'FF 00 00 00' } },
  ];
  const collapsedEval = evalThreeFrames(collapsed, catalogMod.featureFramesFor);
  check('[C] 反向自检：塌缩形态（三条同 DID 0x0101）喂进同一判定必须失败',
    collapsedEval.ok === false, `ok=${collapsedEval.ok}（应 false）· 原因 ${collapsedEval.reasons.length} 项`);

  if (collapsedEval.ok !== false) {
    console.log('    SELF_CHECK_FAILED：塌缩形态喂进同一判定竟然通过 —— 判定恒真，[C] 的绿不可信。');
    selfCheckOk = false;
  }
  if (!three.ok) {
    console.log(`    行为不符：产物侧构帧不满足判据（${three.reasons.length} 项，见下方失败明细）—— 这是结果红，不是自检失败。`);
  }
}

// ───────────────────────────────────────────────────────────────────
// 汇总
// ───────────────────────────────────────────────────────────────────
console.log(`\n${ASSERTION}: ${pass} passed / ${fail} failed`
  + ` | 同步集 ${report.syncRel.length} · 一致 ${report.identical}`
  + ` · 缺失 ${report.missing.length} · 不同 ${report.differing.length} · 多余 ${report.extra.length}`);
if (failures.length) {
  console.log(`\n失败明细（${failures.length}）：`);
  for (const f of failures) console.log(`  - ${f}`);
}
if (!manifestOk) {
  console.log('\n清单解析失败 —— 门禁无法确定同步集，结果不可信。');
  process.exit(1);
}
if (!selfCheckOk) {
  console.log('\nSELF_CHECK_FAILED —— 反向自检未通过，门禁结果不可信。');
  process.exit(1);
}
if (fail) {
  console.log(`\n不通过：${ASSERTION} FAIL`);
  process.exit(1);
}
console.log(`\n通过：${ASSERTION} PASS`);
process.exit(0);
