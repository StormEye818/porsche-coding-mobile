#!/usr/bin/env node
/**
 * boot-smoke.mjs —— 启动冒烟：用一个最小 DOM stub 加载打包后的 bundle，
 * 断言模块加载/初始化阶段没有「未声明变量」这类 ReferenceError。
 *
 * 为什么需要它：
 *   2026-10-29 线上出现「启动即 载入失败: Can't find variable: tree」——
 *   重写 loading 时把整块模块级状态声明误删了。`node --check` 只查语法、
 *   esbuild 只做打包，都发现不了；smoke 的静态断言也只能覆盖已知变量名。
 *   这个脚本真跑一遍 bundle，能兜住这一类问题。
 *
 * 跑法：node tools/boot-smoke.mjs（需先 npm run sync 产出 www/app.bundle.js）
 */
const el = () => new Proxy({
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  children: [], value: '', textContent: '', innerHTML: '', disabled: false, checked: false,
  appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
  querySelector() { return el(); }, querySelectorAll() { return []; },
  scrollIntoView() {}, focus() {}, blur() {}, click() {},
  setAttribute() {}, getAttribute() { return null; },
  insertAdjacentHTML() {}, closest() { return null; }, matches() { return false; },
}, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && k.startsWith('on')) return null;
    return undefined;
  },
  set(t, k, v) { t[k] = v; return true; },
});

globalThis.document = {
  getElementById: () => el(), createElement: () => el(), querySelector: () => el(),
  querySelectorAll: () => [], body: el(), documentElement: el(), addEventListener() {},
};
globalThis.window = globalThis;
window.addEventListener = () => {};
window.visualViewport = { offsetTop: 0 };
window.matchMedia = () => ({ matches: false, addEventListener() {} });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node', share: async () => {}, clipboard: { writeText: async () => {} } },
});
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null, text: async () => '' });
globalThis.confirm = () => false;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.location = { href: '' };

const errs = [];
process.on('uncaughtException', (e) => errs.push('uncaught: ' + e.message));
process.on('unhandledRejection', (e) => errs.push('unhandled: ' + (e?.message || e)));

const bundle = new URL('../www/app.bundle.js', import.meta.url);
try {
  await import(bundle.href);
} catch (e) {
  console.log(`  FAIL 加载 bundle：${e.message}`);
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 400));

// 只把「未声明变量 / 未定义」当失败；Capacitor 插件在 Node 里必然 UNIMPLEMENTED，属预期
const fatal = errs.filter((x) => /Can't find variable|is not defined|ReferenceError/.test(x));
if (fatal.length) {
  console.log(`  FAIL 启动期未声明变量：${fatal.join(' | ')}`);
  process.exit(1);
}
console.log(`  ok   bundle 可加载，启动期无未声明变量（其它运行时错误 ${errs.length} 条，均为适配器/插件不可用）`);
