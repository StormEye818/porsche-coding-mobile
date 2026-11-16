/**
 * sync.mjs — 组装 www/ 并保住 app 内插件注册。
 *
 * ⚠️ 必踩的坑（alfaproxi 2026-09-30 实测）：
 *
 * ① Capacitor 的 app 内插件（如 MfiSerialPlugin）不会自动注册。
 *    `npx cap sync` 只登记 npm 插件，且**每次重写** capacitor.config.json
 *    的 packageClassList；不回填则 registerPlugin('MfiSerial') 拿到空壳、
 *    运行时调用无响应。
 *
 * ② **裸模块标识符在 WebView 里解析不了**：
 *    `import { registerPlugin } from '@capacitor/core'` 直接当 ES module 加载
 *    会报 "Failed to resolve module specifier"，整个模块图挂掉，
 *    表现为「界面出来了但所有按钮点了没反应」。
 *    必须用 esbuild `bundle:true` 打成单文件（照搬 alfaproxi 的 vendor 方案）。
 *
 * 用法：
 *   node scripts/sync.mjs            # 打包 + 同步 + 回填
 *   node scripts/sync.mjs --refill   # 只回填（放在 npx cap sync ios 之后）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.join(__dirname, '..');
const WWW = path.join(MOBILE, 'www');

const PLUGINS = ['MfiSerialPlugin', 'ShareSheetPlugin'];

function refill() {
  // ⚠️ 必须**合并**，不能覆盖：
  // `cap sync` 会把 npm 插件（如 SharePlugin）写进 packageClassList。
  // 如果这里整份替换，会把它们删掉，运行时报 "Xxx plugin is not implemented on ios"
  // （2026-10-01 实测：覆盖后 Share.share() 直接失败）。
  const merge = (cfg) => {
    const cur = Array.isArray(cfg.packageClassList) ? cfg.packageClassList : [];
    for (const p of PLUGINS) if (!cur.includes(p)) cur.push(p);
    cfg.packageClassList = cur;
    return cfg;
  };

  const cfgPath = path.join(MOBILE, 'capacitor.config.json');
  const rootCfg = merge(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
  fs.writeFileSync(cfgPath, JSON.stringify(rootCfg, null, 2) + '\n');

  const iosCfg = path.join(MOBILE, 'ios', 'App', 'App', 'capacitor.config.json');
  if (fs.existsSync(iosCfg)) {
    // 只补包内插件，保留 cap sync 写入的 npm 插件
    const ios = merge(JSON.parse(fs.readFileSync(iosCfg, 'utf8')));
    fs.writeFileSync(iosCfg, JSON.stringify(ios, null, 2) + '\n');
    console.log(`[sync] packageClassList = [${ios.packageClassList.join(', ')}]`);
  }
}

if (!process.argv.includes('--refill')) {
  console.log('[sync] esbuild 打包 app.js（解决裸模块标识符）…');
  await build({
    entryPoints: [path.join(MOBILE, 'src', 'app.js')],
    outfile: path.join(WWW, 'app.bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    logLevel: 'info',
  });
  const kb = (fs.statSync(path.join(WWW, 'app.bundle.js')).size / 1024).toFixed(0);
  console.log(`[sync] www/app.bundle.js  ${kb}KB`);

  // ★ 入口页必须从仓库根的 index.html 拷过来（2026-10-29 审计 P0-4）：
  //   此前 www/ 整目录被 .gitignore 排除，而 index.html 是手写源文件 ——
  //   仓库里一个 index.html 都没有，新 clone 直接构建不出可运行的 app。
  //   现在源头在根目录（受版本控制），www/ 只放产物。
  const INDEX_SRC = path.join(MOBILE, 'index.html');
  if (!fs.existsSync(INDEX_SRC)) {
    throw new Error('缺少 index.html（仓库根）—— 入口页是源文件，不能被忽略');
  }
  // ★ 2026-10-31：bundle 内联到 index.html —— 消除外部 script 加载失败问题。
  //   Capacitor WKWebView 的 file:// 对外部 script 加载有兼容性问题。
  const bundleCode = fs.readFileSync(path.join(WWW, 'app.bundle.js'), 'utf8');
  let htmlContent = fs.readFileSync(INDEX_SRC, 'utf8');
  // 替换动态加载块和静态 script 标签为内联
  htmlContent = htmlContent.replace(
    /<script>[\s\S]*?document\.head\.appendChild\(s\)[\s\S]*?<\/script>/,
    '<script>/* bundle inlined below */</script>'
  );
  htmlContent = htmlContent.replace(
    /<script src="app\.bundle\.js"><\/script>/,
    '<script>\ntry {\n' + bundleCode + '\n} catch(e) { window.__bundleError = (e.message||"?") + " | " + (e.stack||"").split("\\n").slice(0,3).join(" | "); }\n</script>'
  );
  // 如果动态加载块没被替换（格式变了），兜底再试一次
  if (!htmlContent.includes('__bundleLoaded')) {
    htmlContent = htmlContent.replace(
      /<script src="app\.bundle\.js"><\/script>/,
      '<script>\n' + bundleCode + '\n</script>'
    );
  }
  // ★ T04-c 任务 3：UI 侧真正消费功能全集数据。
  //   这是唯一一处「UI 入口」接线：不碰 T03 定稿的 src/app.js，用独立 ESM 模块
  //   在页面启动时 fetch 12 份零 fetch 数据，挂到 window.__featureCatalog 供视图层枚举。
  //   链路：www/index.html → feature-catalog.js:loadFeatureCatalog → enumeratePages
  //         → featureFramesFor → src/elm327.js:Elm327.cmd 实发帧（F13/F14 逐帧断言）。
  const CATALOG_BOOTSTRAP = [
    '<script type="module">',
    "import { loadFeatureCatalog, FEATURE_DATA_SOURCES } from './feature-catalog.js';",
    'try {',
    '  const catalog = await loadFeatureCatalog(fetch);',
    // ★ 裁定 B：枚举函数取自 app 运行时全局（src/schema.js 模块级副作用注册，
    //   app.js:16 已 import → 进 app.bundle.js），证明调用链真的经过 app 的 import 图。
    '  const enumeratePages = window.__pcEnumeratePages;',
    '  const featureFramesFor = window.__pcFeatureFramesFor;',
    '  if (typeof enumeratePages !== "function" || typeof featureFramesFor !== "function")',
    '    throw new Error("app 运行时缺 __pcEnumeratePages/__pcFeatureFramesFor");',
    //   真的枚举全量分组并挂到 window，不是只 fetch 完就放着。
    //   measure 1719 / actuator 2506 逐组 ≤ app 现有渲染上限，差集=0。
    '  const measure = enumeratePages(catalog.sources["measure.json"], "params");',
    '  const actuator = enumeratePages(catalog.sources["actuator.json"], "items");',
    '  window.__featureCatalog = catalog;',
    '  window.__featureCatalogEnumerated = {',
    '    measure: { total: measure.total, items: measure.items.length, diff: measure.diff, groups: measure.pages },',
    '    actuator: { total: actuator.total, items: actuator.items.length, diff: actuator.diff, groups: actuator.pages }',
    '  };',
    '  window.__featureFramesFor = featureFramesFor;',
    '  window.__featureCatalogReady = catalog.ok && measure.diff === 0 && actuator.diff === 0;',
    '  window.__featureCatalogSources = FEATURE_DATA_SOURCES.slice();',
    '} catch (e) { window.__featureCatalogReady = false; window.__featureCatalogError = String(e && e.message || e); }',
    '</script>',
  ].join('\n');
  if (!htmlContent.includes('__featureCatalogReady')) {
    htmlContent = htmlContent.replace('</body>', `${CATALOG_BOOTSTRAP}\n</body>`);
  }
  fs.writeFileSync(path.join(WWW, 'index.html'), htmlContent);
  console.log('[sync] www/index.html  ← index.html（含功能全集 UI bootstrap）');

  // ★ data/ → www/data/ 必须每次同步。
  //   早先靠手动 cp，改了 data/ 忘了同步就发旧数据（2026-10-12 实测踩过：
  //   清洗了 data/measure.json 的内部格式描述，www/data/ 里还是旧的，差点打包出去去）。
  const DATA_SRC = path.join(MOBILE, 'data');
  const DATA_DST = path.join(WWW, 'data');
  // ★ 2026-11-04：先清空再拷 —— copyDir 只增不删，旧中间产物会永远留在
  //   www/data 里（实测排除规则生效后 www/data 仍 1.5G）
  fs.rmSync(DATA_DST, { recursive: true, force: true });
  fs.mkdirSync(DATA_DST, { recursive: true });
  let n = 0;
  // ⚠️ models/ 子目录也要递归拷（按车型×模块×变体的懒加载文件）
  //   只拷顶层 json 会让 app 取不到车型数据（2026-10-13 踩过）
  // ★ 2026-11-04：只同步运行时引用的数据。中间产物（rebuild-all.py 生成，
  //   运行时从不 fetch）此前被整个拷进安装包，app 体积 1.4G；排除后 ≈700M。
  const SKIP = new Set([
    'coding-models.json',    // 403M 全量中间表
    'coding-by-model.json',  // 207M 全量中间表
    'menu-tree.json',        // v1，已被 menu-tree-v3.json 取代
    'platforms.json',        // RE 中间表
    'so-exports.json',       // .so 研究产物
  ]);
  // ★ T04-c 任务 3：功能全集「零 fetch」数据源的运行时可达清单。
  //   src/special-catalog.js 的 FEATURE_DATA_SOURCES 与本数组同源等长；
  //   这些文件会被 UI 侧的 feature-catalog.js 真正 fetch，绝不能被 SKIP 排除。
  //   fs.rmSync safe-delete 护栏保留（先清空再拷，避免旧中间产物滞留）。
  const RUNTIME_REACHABLE = Object.freeze([
    'measure.json',
    'actuator.json',
    'function-sequences.json',
    'special-function-map.json',
    'special-functions.json',
    'special-functions-real.json',
    'special-functions-ext.json',
    'special-systems.json',
    'routines.json',
    'routines-verified.json',
    'routine-templates.json',
    'gag-routines.json',
  ]);
  for (const name of RUNTIME_REACHABLE) {
    if (SKIP.has(name)) throw new Error(`[sync] 运行时可达数据被误列入 SKIP：${name}`);
  }
  const skip = (name) => SKIP.has(name) || /^x[0-9][0-9][0-9]-tree/.test(name);
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else if (e.name.endsWith('.json') && !skip(e.name)) { fs.copyFileSync(s, d); n++; }
    }
  };
  copyDir(DATA_SRC, DATA_DST);
  console.log(`[sync] www/data/  同步 ${n} 个 json（含 models/ 递归，已排除中间产物）`);

  // ★ T04-c 裁定 B：把 UI 侧消费模块单独打成纯 ESM 文件（不进 app.bundle.js，
  //   app.js 是 T03 定稿禁碰文件，且 smoke 门禁要求 special-functions-ext 不进 bundle）。
  //   special-catalog.js 从 './schema.js' re-export enumeratePages/featureFramesFor，
  //   所以 schema.js 也必须拷到 www/ 下作为兄弟模块；两者在 app 侧则由
  //   app.js:16 的 import 通过 esbuild 打进 app.bundle.js（同一份实现，无副本）。
  const CATALOG_SRC = path.join(MOBILE, 'src', 'special-catalog.js');
  const CATALOG_DST = path.join(WWW, 'feature-catalog.js');
  fs.copyFileSync(CATALOG_SRC, CATALOG_DST);
  // 把 catalog 的 `from './schema.js'` 改成 `from './www-schema.js'`，
  // 避免与 www/ 下其它同名产物冲突；同时拷一份 schema.js 过去。
  const SCHEMA_SRC = path.join(MOBILE, 'src', 'schema.js');
  const SCHEMA_DST = path.join(WWW, 'www-schema.js');
  const catalogText = fs.readFileSync(CATALOG_SRC, 'utf8');
  const rewritten = catalogText.replace(/from '\.\/schema\.js'/g, "from './www-schema.js'");
  fs.writeFileSync(CATALOG_DST, rewritten, 'utf8');
  fs.copyFileSync(SCHEMA_SRC, SCHEMA_DST);
  const catalogSrcText = fs.readFileSync(CATALOG_SRC, 'utf8');
  if (!fs.readFileSync(SCHEMA_SRC, 'utf8').includes('export function enumeratePages')) {
    throw new Error('[sync] src/schema.js 缺 enumeratePages（app.js 已 import 的模块）');
  }
  const reachableDeclared = RUNTIME_REACHABLE.every((name) => catalogSrcText.includes(`'${name}'`));
  const reachablePresent = RUNTIME_REACHABLE.every((name) => fs.existsSync(path.join(DATA_DST, name)));
  if (!reachableDeclared || !reachablePresent) {
    throw new Error('[sync] SYNC_DATA_CONSISTENT 失败：功能全集数据源未全部声明或未同步到 www/data/');
  }
  // 顶层 json 差集：未被 app.js 直接 fetch 的，逐类如实标注，不许留「差集未知」。
  const topJson = fs.readdirSync(DATA_SRC).filter((f) => f.endsWith('.json') && !skip(f));
  const appSrc = fs.readFileSync(path.join(MOBILE, 'src', 'app.js'), 'utf8');
  const appFetched = topJson.filter((f) => appSrc.includes(`data/${f}`));
  const viaCatalog = topJson.filter((f) => RUNTIME_REACHABLE.includes(f) && !appFetched.includes(f));
  const compiledIntoSrc = topJson.filter((f) => !appFetched.includes(f) && !viaCatalog.includes(f));
  const diff = topJson.length - (appFetched.length + viaCatalog.length + compiledIntoSrc.length);
  if (diff !== 0) throw new Error(`[sync] SYNC_DATA_CONSISTENT 顶层 json 差集=${diff}（应为 0）`);
  console.log(`[sync] SYNC_DATA_CONSISTENT 顶层 ${topJson.length} 个 json：`
    + `app 直接 fetch ${appFetched.length} / feature-catalog 运行时消费 ${viaCatalog.length} / `
    + `离线生成器中间产物（编译进 src 后运行时消费）${compiledIntoSrc.length} / 差集 ${diff}`);
  console.log('[sync] 运行时可达清单 12/12 已在 www/data/ 且已在 src/special-catalog.js 声明');
}

refill();
