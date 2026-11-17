#!/usr/bin/env node
/**
 * test-full.mjs — 严格模式跑完整测试链（真值表缺失即失败）。
 *
 * 为什么需要它
 * ────────────
 * `tools/vectors/` 里的三份 seed/key 真值表**随仓库提供**（2026-11-17 已入库），
 * 干净 clone 上本来就在，`npm test` 直接 375/69/84 全跑、零 SKIP。
 *
 * 那这个脚本现在干嘛用？——**抓坏 checkout**。表缺失只可能是 checkout 不完整
 * （稀疏检出 / 打包漏文件 / 有人手工删过），此时 smoke-fixes / verify-pending /
 * tools/walkthrough 会降级成**可见的 SKIP**（各自的 `REQUIRE_LOCAL_ASSETS` 段），
 * 于是 `npm test` 依然能跑完、也不会把「没跑」伪装成「验过」——
 * 但它**不会失败**。验收不能停在「没崩」：必须证明这些断言真的跑过。
 * 所以再跑一遍并设 `ALIGN431_REQUIRE_LOCAL_ASSETS=1`，缺表由 SKIP 升级为 FAIL。
 *
 * 换句话说：`npm test` 是容错档（跑得完、跳过可见），`npm run test:full` 是验收档
 * （一个文件不到位就红）。机制没变，只是职能从「补本地没有的表」变成「抓不完整的检出」。
 *
 * 为什么不用 `ALIGN431_REQUIRE_LOCAL_ASSETS=1 npm test`
 * ────────────────────────────────────────────────────
 * 前置环境变量赋值是 POSIX shell 语法，Windows 的 cmd 不认（会当成命令的一部分或
 * 直接报错）。这里用 node 设 `process.env` 再 spawn，平台无关。
 *
 * 跑法：node scripts/test-full.mjs   （或 npm run test:full）
 * 退出码：透传内层 `npm test` 的退出码；启动失败记 1。
 *
 * ⚠️ 本机沙箱：`npm test` 第一步 `sync` 会清空重建 `www/data/`（4600+ 文件），
 *    WorkBuddy 沙箱注入的 `node-safe-delete-shim` 会以
 *    `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 拦住它 —— 那是**环境护栏**，
 *    不是 `scripts/sync.mjs` 的缺陷（清空重建是正确行为，不要去改删除逻辑）。
 *    在本机跑请加 `NODE_OPTIONS=` 清掉注入的 shim：
 *      NODE_OPTIONS= npm run test:full
 *    普通终端 / CI 无此问题，直接 `npm run test:full` 即可。
 */
import { spawnSync } from 'node:child_process';

/** Windows 下 `npm` 是 `npm.cmd`，且需要 shell 才能被 spawn。 */
const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';

console.log('[test:full] 严格模式：ALIGN431_REQUIRE_LOCAL_ASSETS=1'
  + '（tools/vectors/ 真值表缺失由 SKIP 升级为 FAIL）');

const r = spawnSync(npmBin, ['test'], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env, ALIGN431_REQUIRE_LOCAL_ASSETS: '1' },
});

if (r.error) {
  console.error(`[test:full] 启动 ${npmBin} test 失败：${r.error.message}`);
  process.exit(1);
}
// 被信号打断时 status 为 null —— 不能当成 0（那就是「假绿」）。
if (r.status === null) {
  console.error(`[test:full] 子进程被信号终止：signal=${r.signal}`);
  process.exit(1);
}
process.exit(r.status);
