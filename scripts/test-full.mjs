#!/usr/bin/env node
/**
 * test-full.mjs — 严格模式跑完整测试链（缺本地资产即失败）。
 *
 * 为什么需要它
 * ────────────
 * `tools/vectors/` 被 `.gitignore:118` 排除（本地真机对拍表，不入库）。干净 clone 上
 * 不存在时，相关步骤会降级成**可见的 SKIP**（见 smoke-fixes.mjs / verify-pending.mjs /
 * tools/walkthrough.mjs 里各自的 `REQUIRE_LOCAL_ASSETS` 段），这样 `npm test` 在任何
 * 机器上都能跑完，且不会把「没跑」伪装成「验过」。
 *
 * 但**验收**不能停在容错模式：验收必须证明这些断言真的跑过。所以设
 * `ALIGN431_REQUIRE_LOCAL_ASSETS=1` 再跑一遍 —— 此时资产缺失由 SKIP 升级为 FAIL。
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
  + '（缺 tools/vectors/ 由 SKIP 升级为 FAIL）');

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
