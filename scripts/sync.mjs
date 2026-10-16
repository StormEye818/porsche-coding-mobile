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
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'info',
  });
  const kb = (fs.statSync(path.join(WWW, 'app.bundle.js')).size / 1024).toFixed(0);
  console.log(`[sync] www/app.bundle.js  ${kb}KB`);

  // ★ data/ → www/data/ 必须每次同步。
  //   早先靠手动 cp，改了 data/ 忘了同步就发旧数据（2026-10-12 实测踩过：
  //   清洗了 data/measure.json 的内部格式描述，www/data/ 里还是旧的，差点打包出去去）。
  const DATA_SRC = path.join(MOBILE, 'data');
  const DATA_DST = path.join(WWW, 'data');
  fs.mkdirSync(DATA_DST, { recursive: true });
  let n = 0;
  // ⚠️ models/ 子目录也要递归拷（按车型×模块×变体的懒加载文件）
  //   只拷顶层 json 会让 app 取不到车型数据（2026-10-13 踩过）
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else if (e.name.endsWith('.json')) { fs.copyFileSync(s, d); n++; }
    }
  };
  copyDir(DATA_SRC, DATA_DST);
  console.log(`[sync] www/data/  同步 ${n} 个 json（含 models/ 递归）`);
}

refill();
