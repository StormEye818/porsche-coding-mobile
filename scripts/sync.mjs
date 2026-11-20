/**
 * sync.mjs — 组装 www/ 并保住 app 内插件注册。
 *
 * ⚠️ 必踩的坑（2026-09-30 真机实测）：
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
 *    必须用 esbuild `bundle:true` 打成单文件（采用已验证的 vendor 方案）。
 *
 * 用法：
 *   node scripts/sync.mjs            # 打包 + 同步 + 回填
 *   node scripts/sync.mjs --refill   # 只回填（放在 npx cap sync ios 之后）
 *   node scripts/sync.mjs --dry      # **只记账、不写盘**：跳过 esbuild / rmSync / 所有拷贝与写盘，
 *                                    # 但三桶（SYNC_DATA_CONSISTENT）五条断言照跑到底，
 *                                    # 末行打印机器可解析的 `SYNC_DATA_CONSISTENT top=… app=… …`。
 *                                    # 供门禁（smoke-fixes 的 F14）真跑一遍，替代「grep 源码里的字符串」。
 *                                    # ⚠️ --dry 路径下**禁止任何写盘**：新增写操作时必须包 `if (!DRY)`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.join(__dirname, '..');
const WWW = path.join(MOBILE, 'www');

// ★ --dry：给门禁用的「真跑但不落盘」模式。所有写盘都必须被 DRY 挡住。
const DRY = process.argv.includes('--dry');

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
  // ── ① esbuild 打包（--dry 下跳过：它会写 www/app.bundle.js）──
  if (DRY) {
    console.log('[sync] --dry：跳过 esbuild 打包 / www/ 写盘 / www/data 拷贝，只跑三桶记账');
  } else {
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
  }

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
  // ⚠️ --dry 下不写 www/index.html（只做字符串处理，不落盘）
  if (!DRY) {
    fs.writeFileSync(path.join(WWW, 'index.html'), htmlContent);
    console.log('[sync] www/index.html  ← index.html（含功能全集 UI bootstrap）');
  }

  // ★ data/ → www/data/ 必须每次同步。
  //   早先靠手动 cp，改了 data/ 忘了同步就发旧数据（2026-10-12 实测踩过：
  //   清洗了 data/measure.json 的内部格式描述，www/data/ 里还是旧的，差点打包出去去）。
  const DATA_SRC = path.join(MOBILE, 'data');
  const DATA_DST = path.join(WWW, 'data');
  // ★ 2026-11-04：先清空再拷 —— copyDir 只增不删，旧中间产物会永远留在
  //   www/data 里（实测排除规则生效后 www/data 仍 1.5G）
  // ⚠️ --dry 下绝不执行 rmSync/copyDir：那是 2.3GB 的破坏性写盘
  if (!DRY) {
    fs.rmSync(DATA_DST, { recursive: true, force: true });
    fs.mkdirSync(DATA_DST, { recursive: true });
  }
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
    // ★ 2026-11-16 体积/口径收口：下面三项运行时**零 fetch**，进安装包只是白占体积。
    'actinfo-modules.json',  // RE 中间产物 8.86MB：tools/export-actinfo-modules.py 产出的 ALL_ACTINFO
                             //   三级模块目录（modules 1817 / chainIndex 1264）。
                             //   ⚠️ 2026-11-17 口径定稿（上一版理由已作废，别再抄回去）：
                             //   它是**构建期输入**——tools/build-actuators.py:502 读它做模块级地址
                             //   解析（multi-resolved-by-module / ambiguous-in-module），:503 还把
                             //   它的 sha256 记进 data/actuator.json 的 source；
                             //   但**运行时零 fetch**（app / feature-catalog 都不取它）。
                             //   ⇒ 进 SKIP（不进安装包）依然正确，理由不是「没人用」，是
                             //     「构建期用、运行期不用」。要取消 SKIP，前提是运行时真的 fetch 它，
                             //     光有构建期读取不算。
    'sysdata-comm.json',     // 已编译进 src/oem-enter-frames.js + src/oem-session-table.js
                             //   （tools/build-oem-enter-frames.mjs / build-oem-session-table.mjs 的数据源）；
                             //   app.js 只在注释里提及（app.js:2898），运行时零 fetch
    'vin-vehicle-map.json',  // 运行时零 fetch：app.js:1374-1377 注释明写它只是离线参考/审计产物，
                             //   以 app.js 内的内联表为准
    'comm-timeouts-oem.json', // 等待参数单一真值表：3 个值（5000/8000/16000）已内联为
                              //   src/comm-timeouts.js 的 COMM_TIMEOUT，运行时零 fetch；
                              //   EVIDENCE_OEM.DATA_FILE 只是出证字符串。证据本体（含 5 条
                              //   unresolvedCandidates 的 reloc/disasm）留仓库侧供门禁读，
                              //   不进安装包。两边相等由 tools/verify-comm-timeouts.mjs 双向断言。
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
  if (!DRY) {
    copyDir(DATA_SRC, DATA_DST);
    console.log(`[sync] www/data/  同步 ${n} 个 json（含 models/ 递归，已排除中间产物）`);
  }

  // ★ T04-c 裁定 B：把 UI 侧消费模块单独打成纯 ESM 文件（不进 app.bundle.js，
  //   app.js 是 T03 定稿禁碰文件，且 smoke 门禁要求 special-functions-ext 不进 bundle）。
  //   special-catalog.js 从 './schema.js' re-export enumeratePages/featureFramesFor，
  //   所以 schema.js 也必须拷到 www/ 下作为兄弟模块；两者在 app 侧则由
  //   app.js:16 的 import 通过 esbuild 打进 app.bundle.js（同一份实现，无副本）。
  const CATALOG_SRC = path.join(MOBILE, 'src', 'special-catalog.js');
  const CATALOG_DST = path.join(WWW, 'feature-catalog.js');
  // 把 catalog 的 `from './schema.js'` 改成 `from './www-schema.js'`，
  // 避免与 www/ 下其它同名产物冲突；同时拷一份 schema.js 过去。
  const SCHEMA_SRC = path.join(MOBILE, 'src', 'schema.js');
  const SCHEMA_DST = path.join(WWW, 'www-schema.js');
  const catalogText = fs.readFileSync(CATALOG_SRC, 'utf8');
  const rewritten = catalogText.replace(/from '\.\/schema\.js'/g, "from './www-schema.js'");
  if (!DRY) {
    fs.copyFileSync(CATALOG_SRC, CATALOG_DST);
    fs.writeFileSync(CATALOG_DST, rewritten, 'utf8');
    fs.copyFileSync(SCHEMA_SRC, SCHEMA_DST);
  }
  const catalogSrcText = fs.readFileSync(CATALOG_SRC, 'utf8');
  if (!fs.readFileSync(SCHEMA_SRC, 'utf8').includes('export function enumeratePages')) {
    throw new Error('[sync] src/schema.js 缺 enumeratePages（app.js 已 import 的模块）');
  }
  // ─────────────────────────────────────────────────────────────────
  // SYNC_DATA_CONSISTENT —— 顶层 data/*.json 三桶记账（★ 2026-11-16 由恒真改为可证伪）
  //
  // ⚠️ 旧实现是**恒真**的：第三桶用补集定义
  //      compiledIntoSrc = topJson − appFetched − viaCatalog
  //    于是 diff = |top| − (|appFetched| + |viaCatalog| + |compiledIntoSrc|) ≡ 0，
  //    无论漏拷、漏登记还是分类错了都绿；只把 19/8/20 这三个数打印出来当"证明"。
  //    而且 appFetched 用 `appSrc.includes('data/'+f)` 判，**注释里提到也算** ——
  //    实测 sysdata-comm.json / vin-vehicle-map.json 只在注释里出现、运行时根本不 fetch，
  //    却被算进"app 直接 fetch 19"，桶 1 口径偏大 2。
  //
  // 现在：三个**显式清单**（每条带归属理由）+ 五条可证伪断言
  //   ① 桶内无重复、桶间两两交集为空；
  //   ② 三桶并集**恰好等于** data/ 下未被 skip 的顶层 *.json 实存集
  //      （新增数据文件忘登记 → 红）；反方向「登记了但不存在」是否红，
  //      **由 git 回答**（见 ⑤），不靠名单声明；
  //   ③ 桶1 与 src/app.js 里实际 `fetch('data/<name>')` 的集合**逐个相等**
  //      （加了引用没登记 → 红；登记了却没 fetch → 红；注释里提到不算 fetch）；
  //   ④ 桶2 恰好等于 RUNTIME_REACHABLE − 桶1，且 RUNTIME_REACHABLE 与
  //      src/special-catalog.js 的 FEATURE_DATA_SOURCES 是同一集合（只改一处 → 红）；
  //   ⑤ 缺失项归类只由 git 事实回答：`git ls-files --error-unmatch` 命中 = 入库
  //      文件（缺了红）；`git check-ignore -q` 命中 = 本地产物（缺席只打印）；
  //      两个都不命中 = 归属未定（红）。非 git 环境显式降级为「未判」+ gitfacts=0。
  //
  // 桶定义
  //   桶1 APP_FETCHED        运行时由 app 自己 fetch('data/<name>')，必须原样进安装包
  //   桶2 VIA_CATALOG        app 不 fetch，由 UI 侧 feature-catalog.js 按
  //                          FEATURE_DATA_SOURCES 逐份 fetch（「零 fetch 功能全集」）
  //   桶3 COMPILED_INTO_SRC  运行时**从不** fetch：离线生成器中间表，或同一真值被
  //                          内联/转写成 src 常量（改了要跑门禁校验两边相等）
  //   ★ 另有 data/models/** —— app 用 template `data/models/<slug>/<file>` 动态取，
  //     整棵子树都在同步范围（copyDir 递归），不参与顶层三桶记账。
  //   ★ SKIP 项**不进任何桶**：实存集按「顶层 *.json 且 !skip(f)」取，被 SKIP 的文件
  //     （actinfo-modules.json / sysdata-comm.json / vin-vehicle-map.json 等）天然不在
  //     实存集里。所以**不要**给 SKIP 项补登记 —— 补了会立刻被判成「幽灵项」。
  // ─────────────────────────────────────────────────────────────────
  const APP_FETCHED = Object.freeze([
    ['actuator.json', '执行器目录（2F/31 构帧源）'],
    ['bind-plan.json', '进模块绑定计划'],
    ['coding-v2.json', '编码表 v2'],
    ['coding.json', '编码表 v1（v2 缺项时的兼容回落）'],
    ['drivelinks.json', '驾驶链接表'],
    ['dtc.json', '故障码表'],
    ['ecu-addresses.json', 'ECU 地址表'],
    ['ecu-part-map.json', 'ECU 零件号映射'],
    ['function-sequences.json', '功能序列（建链/会话帧序）'],
    ['gag-actuators.json', 'GAG 实测 2F 帧'],
    ['ident-registry.json', '识别串→家族注册表'],
    ['identity.json', '身份裁决表'],
    ['measure.json', '测量值目录'],
    ['menu-tree-v3.json', '菜单树 v3'],
    ['models-catalog.json', '车型/变体目录（含 models/ 子路径）'],
    ['module-family.json', '模块族'],
    ['special-function-map.json', '特殊功能映射'],
  ]);
  const VIA_CATALOG = Object.freeze([
    ['gag-routines.json', 'GAG 实测例程库（31 参数出处）'],
    ['routine-templates.json', '例程模板（31 构帧）'],
    ['routines-verified.json', '已验证例程清单'],
    ['routines.json', '例程目录'],
    ['special-functions-ext.json', '特殊功能扩展集'],
    ['special-functions-real.json', '特殊功能实测集'],
    ['special-functions.json', '特殊功能目录'],
    ['special-systems.json', '特殊功能系统表'],
  ]);
  const COMPILED_INTO_SRC = Object.freeze([
    ['981-sysids.json', 'sysId 导出表，已转写进 src/module-ecu-map.js；运行时无 fetch'],
    ['align431-evidence-registry.json', '431 证据 registry（tools/build-align431-evidence-registry.mjs 产物，门禁消费；运行时从不 fetch）'],
    ['all-model-sysids.json', '导出表，编译成 src/model-sysid-map.js（tools/build-model-sysid-map.mjs）'],
    ['coding-address-sources.json', '编码地址取证表（tools/export-coding-address-sources.py 产物，门禁消费）'],
    ['comm-addr-table.json', '通讯地址取证表（src 里仅注释引用；门禁 verify-oem-probe-diff 消费）'],
    ['comm-shared-keys.json', '通讯共享键取证表（tools/export-comm-shared-keys.py 产物，门禁消费）'],
    ['drivelinks-v3.json', '驾驶链接 v3 取证表（运行时用 drivelinks.json）'],
    ['dsn-module-sysids.json', 'DSN 模块 sysId 中间表（build-dsn-module-sysids.mjs 产物，喂 export-all-model-sysids.py）'],
    ['menu-index.json', '菜单索引中间表（仅离线 rebuild/fix 脚本引用）'],
    ['model-map.json', '车型映射中间表（喂 tools/export-all-model-sysids.py）'],
    ['module-map.json', '模块映射中间表（仅离线 build-module-map.py 等引用）'],
    ['params-981.json', '981 参数中间表（全仓无运行时/src 引用）'],
    ['platform-type-map.json', '平台→type 映射表（build-platform-type-map.mjs 产物，喂导出链）'],
    ['sysdata-root-table.json', 'sysdata 根表中间产物（tools/export-sysdata-routing.py 产物）'],
    ['sysdata-routing.json', 'sysdata 路由表中间产物（喂 export-all-model-sysids.py / export-bind-plan.py）'],
    ['tree.json', '菜单树原始导出（运行时用 menu-tree-v3.json）'],
    ['variant-sysids.json', '变体 sysId 表（export-variant-sysids.mjs 产物，喂 export-bind-plan.py）'],
    ['vehicle-id-type-map.json', 'vehicleID→type 映射（build-platform-type-map.mjs 产物，喂导出链）'],
    ['vin-type-table.json', 'VIN→type 表（build-vin-type-table.mjs 产物，门禁 verify-hb1 消费）'],
    // ★ 2026-11-17：下面两项是**本机生成、不入库**的离线产物（.gitignore 排除）。
    //   它们仍登记在本桶（语义就是「离线中间产物，运行时从不 fetch」），但
    //   「干净 clone 上可以不存在」这件事**不由这张表声明** —— 判据只有一个，
    //   见下方 ⑤：git 是否跟踪它。所以这里不要加 local-only 标记位。
    ['coverage-audit.json', '覆盖率审计产物（tools/audit-coverage.py 输出）；本机生成·不入库'],
    ['module-disposition-252.json', '252 条目处置表（tools/build-module-disposition.py 产物）；本机生成·不入库'],
    // ⚠️ sysdata-comm.json / vin-vehicle-map.json / comm-timeouts-oem.json 已进 SKIP（2026-11-16），
    //    **不要**再在这里登记：实存集已按 !skip(f) 排除它们，登记了就是幽灵项（会立刻红）。
    //    它们的归属理由见上方 SKIP 注释。
  ]);

  // ─────────────────────────────────────────────────────────────────
  // ★ 2026-11-17 修订：**取消第四张名单**，改用一个判据 —— 「这个文件被 git 跟踪吗」。
  //
  // 前一版把 data/coverage-audit.json 与 data/module-disposition-252.json 单列进
  // LOCAL_ONLY_ARTIFACTS，用「人写第二张表」表达「它是本机产物」。那是错的：
  // 等于在仓库里维护第二处真相 —— 文件哪天入库了、或 .gitignore 改了，红绿不会
  // 自动跟着变，得有人记得回来改名单。名单一旦腐烂，结论就与事实脱钩。
  // （为什么不能直接入库：module-disposition-252.json 里写着另一个项目的绝对路径，
  //  见其 :4-5；为什么不能靠生成器补齐：audit-coverage.py 的输入**包含**
  //  module-disposition-252.json，clone 里是死循环。两条路都堵死，只剩「按 git 事实判别」。）
  //
  // 现在只有一条判据，且它由 git 回答，不来自我的记忆：
  //   登记 ∧ 实存                        → OK（计入等式）
  //   登记 ∧ 缺失 ∧ git 跟踪             → 红（真删了；clone 上同样红）
  //   登记 ∧ 缺失 ∧ 未跟踪 ∧ 已 ignore   → 打印「本地产物 N 项」，不判红
  //   登记 ∧ 缺失 ∧ 未跟踪 ∧ 未 ignore   → 红（既没入库也没排除 ⇒ clone 上凭空消失）
  //   未登记 ∧ 实存                      → 红（原样保留）
  //   未登记 ∧ 缺失                      → 无关
  // 外加一条反向校验：**实存但「既未入库、也未 ignore」** 也红 —— 那是「我本机加了
  // 文件、既没提交也没排除」，本机全绿 / clone 上凭空少一个，正是本检查要抓的形态。
  //
  // 非 git 环境（tarball 导出）下两种缺失不可判别：**显式降级**并计数打印，
  // 绝不静默按「本地产物」放过 —— 机器行里 `gitfacts=0` 就是那个标记。
  // ─────────────────────────────────────────────────────────────────

  const topJson = fs.readdirSync(DATA_SRC).filter((f) => f.endsWith('.json') && !skip(f));
  const actual = new Set(topJson);
  const buckets = [
    ['APP_FETCHED', APP_FETCHED],
    ['VIA_CATALOG', VIA_CATALOG],
    ['COMPILED_INTO_SRC', COMPILED_INTO_SRC],
  ];
  const bucketSets = buckets.map(([label, list]) => [label, new Set(list.map(([n]) => n))]);
  const problems = [];

  // ① 桶内无重复 + 桶间两两交集为空
  for (const [label, list] of buckets) {
    if (new Set(list.map(([n]) => n)).size !== list.length) problems.push(`${label} 清单内有重复项`);
    if (list.some(([n, why]) => !n || !why)) problems.push(`${label} 有缺归属理由的条目`);
  }
  for (let i = 0; i < bucketSets.length; i += 1) {
    for (let j = i + 1; j < bucketSets.length; j += 1) {
      const [la, sa] = bucketSets[i];
      const [lb, sb] = bucketSets[j];
      const both = [...sa].filter((n) => sb.has(n));
      if (both.length) problems.push(`${la} ∩ ${lb} 非空：${both.join(', ')}`);
    }
  }

  // ② 三桶并集恰好等于实存集（不多不少）
  const union = new Set(bucketSets.flatMap(([, s]) => [...s]));
  const undeclared = [...actual].filter((f) => !union.has(f)).sort();
  const missing = [...union].filter((f) => !actual.has(f)).sort();
  if (undeclared.length) problems.push(`data/ 实存但三桶都没登记：${undeclared.join(', ')}`);

  // ⑤ 缺失项与「归属未定」项的归类，全部来自 **git 事实**（不是名单、不是记性）。
  //    · `git ls-files --error-unmatch data/<n>` 命中 ⇒ 入库文件，缺了必须红；
  //    · `git check-ignore -q data/<n>` 命中     ⇒ 才是「可以缺席的本地产物」；
  //    · 两个都不命中 ⇒ 归属未定，红（本机绿、clone 缺，正是本项要抓的形态）。
  //    非 git 环境不能判别 ⇒ 显式降级：计数打印 + 机器行 gitfacts=0，不静默放过。
  const gitOk = (args) => {
    try {
      execFileSync('git', args, { cwd: MOBILE, stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { return false; }
  };
  const isGitRepo = gitOk(['rev-parse', '--is-inside-work-tree']);
  const trackedCache = new Map();
  const ignoredCache = new Map();
  const isTracked = (n) => {
    if (!trackedCache.has(n)) trackedCache.set(n, gitOk(['ls-files', '--error-unmatch', `data/${n}`]));
    return trackedCache.get(n);
  };
  const isIgnored = (n) => {
    if (!ignoredCache.has(n)) ignoredCache.set(n, gitOk(['check-ignore', '-q', `data/${n}`]));
    return ignoredCache.get(n);
  };
  const missingTracked = [];     // 入库文件缺失 → 红
  const missingLocalOnly = [];   // 本地产物缺失（未跟踪 + 已 ignore）→ 只打印
  const missingUnexplained = []; // 未跟踪 + 未 ignore + 缺失 → 红
  const missingUnjudged = [];    // 非 git 环境，无法判别 → 只打印 + gitfacts=0
  if (!isGitRepo) {
    missingUnjudged.push(...missing);
    console.log('[sync]   ⚠ 非 git 环境：入库文件与本地产物无法判别，'
      + `${missing.length} 项缺失**未判**（不按本地产物放过；机器行 gitfacts=0，结果随机器变）`);
  } else {
    for (const n of missing) {
      if (isTracked(n)) missingTracked.push(n);
      else if (isIgnored(n)) missingLocalOnly.push(n);
      else missingUnexplained.push(n);
    }
    // 反向校验：实存、已登记，但「既未入库、也未 .gitignore 排除」⇒ 归属未定
    const unowned = [...actual]
      .filter((n) => union.has(n) && !isTracked(n) && !isIgnored(n))
      .sort();
    if (unowned.length) {
      problems.push('实存但既未被 git 跟踪、也未被 .gitignore 排除'
        + `（本机在、clone 上会凭空消失）：${unowned.join(', ')}`);
    }
    if (missingTracked.length) {
      problems.push(`登记了但 data/ 里不存在，且 git 仍在跟踪它（是真删了）：${missingTracked.join(', ')}`);
    }
    if (missingUnexplained.length) {
      problems.push('登记了但不存在，且既未被 git 跟踪、也未被 .gitignore 排除'
        + `（归属未定）：${missingUnexplained.join(', ')}`);
    }
  }

  // ③ 桶1 === src/app.js 里真实的 `fetch('data/<name>')` 集合（注释提及不算）
  const appSrc = fs.readFileSync(path.join(MOBILE, 'src', 'app.js'), 'utf8');
  const appFetchedActual = new Set(
    [...appSrc.matchAll(/fetch\(\s*[`'"]data\/([A-Za-z0-9._-]+\.json)[`'"]/g)].map((m) => m[1]),
  );
  const [, setAppFetched] = bucketSets[0];
  const fetchNotDeclared = [...appFetchedActual].filter((n) => !setAppFetched.has(n)).sort();
  const declaredNotFetch = [...setAppFetched].filter((n) => !appFetchedActual.has(n)).sort();
  if (fetchNotDeclared.length) {
    problems.push(`src/app.js 真的 fetch 了但桶1 没登记：${fetchNotDeclared.join(', ')}`);
  }
  if (declaredNotFetch.length) {
    problems.push(`桶1 登记了但 src/app.js 并不 fetch（注释里提到不算）：${declaredNotFetch.join(', ')}`);
  }
  // app.js 里 fetch 到的文件必须真的在 data/（抓拼错文件名 → 运行时 404）
  const fetchMissingFile = [...appFetchedActual].filter((n) => !actual.has(n)).sort();
  if (fetchMissingFile.length) {
    problems.push(`src/app.js fetch 的 data/ 文件不存在：${fetchMissingFile.join(', ')}`);
  }

  // ④ 桶2 === RUNTIME_REACHABLE − 桶1，且 RUNTIME_REACHABLE === FEATURE_DATA_SOURCES
  const [, setViaCatalog] = bucketSets[1];
  const [, setCompiled] = bucketSets[2];
  const reachableDeclared = RUNTIME_REACHABLE.every((name) => catalogSrcText.includes(`'${name}'`));
  // ★ --dry 不拷贝，www/data 不保证最新；此时“已同步到 www/data”退化为「源 data/ 里存在」。
  //   www/ 与 data/ 的**字节级**一致性由 tools/verify-www-data-identical.mjs 逐文件 sha256 断言，
  //   本处只做存在性（弱判据），不要在 --dry 里假装验过拷贝。
  const reachablePresent = RUNTIME_REACHABLE.every((name) =>
    fs.existsSync(path.join(DRY ? DATA_SRC : DATA_DST, name)));
  if (!reachableDeclared || !reachablePresent) {
    problems.push(`功能全集数据源未全部声明或不存在于 ${DRY ? 'data/' : 'www/data/'}`);
  }
  const expectViaCatalog = new Set(RUNTIME_REACHABLE.filter((n) => !setAppFetched.has(n)));
  const viaExtra = [...setViaCatalog].filter((n) => !expectViaCatalog.has(n)).sort();
  const viaMissing = [...expectViaCatalog].filter((n) => !setViaCatalog.has(n)).sort();
  if (viaExtra.length) problems.push(`桶2 多登记了（不在 RUNTIME_REACHABLE−桶1 里）：${viaExtra.join(', ')}`);
  if (viaMissing.length) problems.push(`桶2 漏登记了（RUNTIME_REACHABLE−桶1 里没进桶2）：${viaMissing.join(', ')}`);
  // 跨文件交叉校验：src/special-catalog.js 的 FEATURE_DATA_SOURCES（另一份清单）
  const catalogList = /FEATURE_DATA_SOURCES\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\);/.exec(catalogSrcText);
  const catalogNames = catalogList
    ? [...catalogList[1].matchAll(/['"]([^'"\r\n]+)['"]/g)].map((m) => m[1])
    : [];
  const setReachable = new Set(RUNTIME_REACHABLE);
  const setCatalog = new Set(catalogNames);
  if (!catalogList || catalogNames.length === 0) {
    problems.push('解析不到 src/special-catalog.js 的 FEATURE_DATA_SOURCES 清单');
  } else if (setReachable.size !== setCatalog.size
    || [...setReachable].some((n) => !setCatalog.has(n))) {
    problems.push(`RUNTIME_REACHABLE(${setReachable.size}) 与 FEATURE_DATA_SOURCES(${setCatalog.size}) 不同集合：`
      + `仅 sync ${[...setReachable].filter((n) => !setCatalog.has(n)).join(',') || '无'}`
      + ` / 仅 catalog ${[...setCatalog].filter((n) => !setReachable.has(n)).join(',') || '无'}`);
  }
  if (RUNTIME_REACHABLE.some((n) => setCompiled.has(n))) {
    problems.push(`RUNTIME_REACHABLE 的项被登记进桶3（运行时可达不该算中间产物）：${
      RUNTIME_REACHABLE.filter((n) => setCompiled.has(n)).join(', ')}`);
  }

  if (problems.length) {
    for (const p of problems) console.error(`[sync] SYNC_DATA_CONSISTENT 失败：${p}`);
    throw new Error(`[sync] SYNC_DATA_CONSISTENT 有 ${problems.length} 项不一致（见上），拒绝继续`);
  }
  // ★ 等式口径 = 「登记 ∧ 实存」的成员数。
  //   缺失项不进等式：入库的缺失已经在 ⑤ 判红；本地产物的缺失是政策，不该进分母。
  const presentIn = (set) => new Set([...set].filter((n) => actual.has(n)));
  const nApp = presentIn(setAppFetched).size;
  const nVia = presentIn(setViaCatalog).size;
  const nCompiled = presentIn(setCompiled).size;
  const nLocalOnlyAbsent = missingLocalOnly.length;
  const nUnregistered = undeclared.length;
  const nGhost = missingTracked.length + missingUnexplained.length;
  const diff = topJson.length - (nApp + nVia + nCompiled);
  if (diff !== 0) {
    problems.push(`三桶实存计数 ${nApp}+${nVia}+${nCompiled}`
      + ` ≠ 实存 ${topJson.length}（diff=${diff}，应为 0）`);
  }

  // ★ 逐桶打印**成员名**（不只计数）：计数错了看不出是哪个文件算错桶；
  //   本桶内「登记了但缺席」的成员也打印出来，别让人以为清单少写了一行。
  const dump = (label, set) => {
    const present = [...set].filter((n) => actual.has(n)).sort();
    const absent = [...set].filter((n) => !actual.has(n)).sort();
    console.log(`[sync]   ${label} ${present.length}/${set.size}：${present.join(', ')}`
      + (absent.length ? `  ｜登记但缺席 ${absent.length}：${absent.join(', ')}` : ''));
  };
  dump('APP_FETCHED', setAppFetched);
  dump('VIA_CATALOG', setViaCatalog);
  dump('COMPILED_INTO_SRC', setCompiled);
  // 本地产物缺席必须**打印**：不判红不等于不让人知道（否则「少了两个文件」永远无声）。
  // 判它是「本地产物」的依据是 git（未跟踪 + check-ignore 命中），不是名单。
  console.log(`[sync]   本地产物缺席 ${nLocalOnlyAbsent} 项（git 未跟踪 + .gitignore 命中；`
    + '干净 clone 上就是它们不存在，不参与记账）'
    + `${nLocalOnlyAbsent ? `：${missingLocalOnly.join(', ')}` : ''}`);
  if (missingUnjudged.length) {
    console.log(`[sync]   ⚠ 缺失未判 ${missingUnjudged.length} 项（非 git 环境，无法判别入库/本地产物）：`
      + missingUnjudged.join(', '));
  }
  console.log(`[sync]   SKIP ${SKIP.size}：${[...SKIP].sort().join(', ')}`);

  // 机器可解析末行（门禁按字段断言，不 grep 源码字符串）
  //   gitfacts=0 表示「非 git 环境，缺失项未判」—— 这是显式降级标记，不是通过标记。
  const machineLine = `SYNC_DATA_CONSISTENT top=${topJson.length} app=${nApp} catalog=${nVia}`
    + ` compiled=${nCompiled} localonly_absent=${nLocalOnlyAbsent}`
    + ` missing_tracked=${missingTracked.length} missing_unjudged=${missingUnjudged.length}`
    + ` unregistered=${nUnregistered} ghost=${nGhost} diff=${diff}`
    + ` gitfacts=${isGitRepo ? 1 : 0}`;

  if (problems.length) {
    for (const p of problems) console.error(`[sync] SYNC_DATA_CONSISTENT 失败：${p}`);
    console.error(machineLine);
    if (DRY) process.exit(1);  // 门禁据退出码判红；正常同步沿用 throw 中止
    throw new Error(`[sync] SYNC_DATA_CONSISTENT 有 ${problems.length} 项不一致（见上），拒绝继续`);
  }
  console.log(`[sync] SYNC_DATA_CONSISTENT 顶层 ${topJson.length} 个 json（各类互斥，并集 = 实存集）：`
    + `app 直接 fetch ${nApp} / feature-catalog 运行时消费 ${nVia} / `
    + `编译进 src 或离线中间产物 ${nCompiled}`
    + `（另有 ${nLocalOnlyAbsent} 项本地产物未生成，不入库不算缺口）/ `
    + `未登记 ${nUnregistered} / 幽灵 ${nGhost} / 判据 gitfacts=${isGitRepo ? 1 : 0}`);
  console.log('[sync] 口径：桶1 与 src/app.js 真实 fetch 逐个相等；'
    + `桶2 = RUNTIME_REACHABLE(${setReachable.size}) − 桶1 = ${nVia}，`
    + `RUNTIME_REACHABLE 与 src/special-catalog.js 的 FEATURE_DATA_SOURCES 同集合`);
  console.log('[sync] 口径：缺失项归类只由 git 回答（ls-files / check-ignore），'
    + '没有任何「本地产物名单」需要人维护');
  console.log(`[sync] 运行时可达清单 ${RUNTIME_REACHABLE.length}/${RUNTIME_REACHABLE.length}`
    + ` 已在 ${DRY ? 'data/' : 'www/data/'} 且已在 src/special-catalog.js 声明`);
  console.log(machineLine);
}

// --dry 下不写 capacitor.config.json（refill 是纯写操作）
if (!DRY) refill();
