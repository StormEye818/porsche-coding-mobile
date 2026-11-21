#!/usr/bin/env node
/**
 * verify-bindplan-runtime-contract.mjs — 阶段 A 生产 bind-plan → runtime rows 真契约门禁。
 *
 * 与旧 tools/test-align431.mjs 的合成 `can/requestKey` fixture 不同，本门禁：
 *   ① 直接读真实 `data/bind-plan.json`；
 *   ② 直接调真实 `src/sweep.js:selectAddrRows()`（不复制适配逻辑）；
 *   ③ 断言代表 sysId 的 CAN/rxRule/requestKeys 全部来自生产字段；
 *   ④ 注入：改名/删除 `0x0e23.requestKeys` 后该代表 sysId 行数必须为 0，恢复后为绿；
 *   ⑤ 统计「有 requestKeys 的 sysId 中真执行 row>0」数量并打印，不用合成 fixture。
 *
 * stdout 每行机器可读：`PASS <NAME> <detail>` / `FAIL ...`；
 * 末行 `BINDPLAN_RUNTIME_CONTRACT_PASS count=N` 或 `..._FAIL failed=N`；退出码 0 / 1。
 *
 * 跑法：node tools/verify-bindplan-runtime-contract.mjs
 */
import { readFileSync } from 'node:fs';
import { selectAddrRows, sweepPlan } from '../src/sweep.js';
import { bindPlanRuntimeRows } from '../src/bind-plan-rows.js';

const plan = JSON.parse(readFileSync(
  new URL('../data/bind-plan.json', import.meta.url), 'utf8'));

const results = [];
const ck = (name, pass, detail = '') => {
  const good = Boolean(pass);
  results.push({ name, ok: good });
  console.log(`${good ? 'PASS' : 'FAIL'} ${name} ${detail}`.trimEnd());
};

/** 请求键空间：0x0030xxxx / 0xFF60xxxx（生产 requestKeys 的完整形态）。 */
const REQUEST_KEY_SPACE = /^0x(?:0030|ff60)[0-9a-f]{4}$/i;

const ecuCount = Object.keys(plan.ecu || {}).length;
ck('REAL_BIND_PLAN_LOADED', ecuCount === 623, `ecu=${ecuCount}`);

// ── 0x0e23：本代真值 0x070D/0x0777 + 生产 requestKeys ──────────────────────
const e23 = plan.ecu['0x0e23'];
const rows23 = selectAddrRows(plan, ['0x0e23']);
ck('E23_ROWS_NONEMPTY', rows23.length > 0, `rows=${rows23.length}`);
const first23 = rows23[0] || {};
ck('E23_FIRST_TX_RX_RULE_FROM_TRUTH',
  first23.tx === 0x070d && first23.rx === 0x0777 && /0x6[aA]/.test(first23.rxRule || ''),
  `tx=0x${(first23.tx ?? 0).toString(16)} rx=0x${(first23.rx ?? 0).toString(16)} rule=${first23.rxRule}`);
ck('E23_FIRST_IS_STATIC_TRUTH', first23.source === 'truth' && first23.provable === 'static',
  `source=${first23.source} provable=${first23.provable}`);
const keys23 = new Set(e23?.requestKeys || []);
ck('E23_REQUEST_KEY_NONEMPTY_AND_IN_KEY_SPACE',
  rows23.length > 0 && rows23.every((r) => r.requestKey && REQUEST_KEY_SPACE.test(r.requestKey)),
  `keys=${[...new Set(rows23.map((r) => r.requestKey))].length}`);
ck('E23_REQUEST_KEYS_READ_FROM_PRODUCTION_FIELD',
  rows23.length > 0 && rows23.every((r) => keys23.has(r.requestKey)),
  `production=${keys23.size}`);
ck('E23_BLOCKOFF_ARRAY_NOT_GUESSED',
  rows23.length > 0 && rows23[0].blockOff === (e23.blockOff || []).join(','),
  `blockOff=${rows23[0]?.blockOff}`);

// ── 0x0e08：0x0714/0x077E + 7 枚 requestKeys 可读 ──────────────────────────
const e08 = plan.ecu['0x0e08'];
const rows08 = selectAddrRows(plan, ['0x0e08']);
const keys08 = new Set(rows08.map((r) => r.requestKey));
ck('E08_ROWS_NONEMPTY_WITH_TRUTH_CAN',
  rows08.length > 0 && rows08[0].tx === 0x0714 && rows08[0].rx === 0x077e,
  `rows=${rows08.length} first=0x${(rows08[0]?.tx ?? 0).toString(16)}/0x${(rows08[0]?.rx ?? 0).toString(16)}`);
ck('E08_SEVEN_REQUEST_KEYS_READABLE',
  keys08.size === 7 && [...keys08].every((k) => (e08?.requestKeys || []).includes(k)),
  `keys=${keys08.size}`);

// ── 其它代表 sysId 全部非空（含无请求键的 0x1408）──────────────────────────
for (const sid of ['0x0b08', '0x0b23', '0x1408', '0x0623']) {
  const rows = selectAddrRows(plan, [sid]);
  ck(`${sid.slice(2).toUpperCase()}_ROWS_NONEMPTY`, rows.length > 0,
    `rows=${rows.length} first=0x${(rows[0]?.tx ?? 0).toString(16)}/0x${(rows[0]?.rx ?? 0).toString(16)} requestKey=${rows[0]?.requestKey}`);
}
ck('1408_EMPTY_REQUEST_KEYS_FAIL_CLOSED_ROW',
  (plan.ecu['0x1408']?.requestKeys || []).length === 0
    && selectAddrRows(plan, ['0x1408']).every((r) => r.requestKey === null),
  'requestKeys=[] → row.requestKey=null（下游 fail-closed）');

// ── 0x0f4d 四元对象 / altIdentitySysIds 必须原样保留 ───────────────────────
const e4d = plan.ecu['0x0f4d'];
const before4d = JSON.stringify(e4d);
const rawRows4d = bindPlanRuntimeRows(e4d, { sysId: '0x0f4d' });
const rows4d = selectAddrRows(plan, ['0x0f4d']);
ck('F4D_FOUR_TUPLE_PRESERVED',
  e4d?.fourTuple?.sysId === '0x0f4d'
    && e4d.fourTuple.can.tx === 0x074e && e4d.fourTuple.can.rx === 0x07b8
    && Array.isArray(e4d.fourTuple.altIdentitySysIds),
  `fourTuple=${JSON.stringify(e4d?.fourTuple?.altIdentitySysIds || [])}`);
ck('F4D_ALT_IDENTITY_IN_RUNTIME_ROWS',
  rows4d.length > 0
    && rows4d[0].altIdentitySysIds.join() === '0x0e5f,0x0e60',
  `alt=${JSON.stringify(rows4d[0]?.altIdentitySysIds || [])}`);
ck('F4D_TRUTH_FIRST_AND_PRODUCTION_KEYS',
  rows4d[0]?.tx === 0x074e && rows4d[0]?.rx === 0x07b8
    && new Set(rows4d.map((r) => r.requestKey)).size === 5
    && rows4d.every((r) => (e4d.requestKeys || []).includes(r.requestKey)),
  `rows=${rows4d.length} keys=${new Set(rows4d.map((r) => r.requestKey)).size}`);
ck('ADAPTER_PURE_NO_MUTATION', JSON.stringify(e4d) === before4d);

// ── 真值排序 + derived 不得冒充 static truth ───────────────────────────────
const rawRows23 = bindPlanRuntimeRows(e23, { sysId: '0x0e23' });
const lastStatic = rawRows23.reduce((acc, r, i) => (r.provable === 'static' ? i : acc), -1);
const firstDerived = rawRows23.findIndex((r) => r.provable === 'derived');
ck('TRUTH_BEFORE_DERIVED',
  firstDerived > -1 && lastStatic > -1 && lastStatic < firstDerived,
  `lastStatic=${lastStatic} firstDerived=${firstDerived}`);
ck('DERIVED_NOT_LABELLED_STATIC_TRUTH',
  rawRows23.filter((r) => r.provable === 'derived')
    .every((r) => r.source !== 'truth' && r.source !== 'commCat10'),
  `derived=${rawRows23.filter((r) => r.provable === 'derived').length}`);
ck('NO_REQUEST_KEY_LOW16_AS_CAN',
  rawRows23.every((r) => !/^0x0030/i.test(r.tx) && r.tx <= 0x7ff && r.rx <= 0x7ff));

// ── 真实统计：有 requestKeys 的 sysId 中，真执行 row>0 的数量 ─────────────
const withKeys = Object.entries(plan.ecu).filter(([, e]) => Array.isArray(e.requestKeys) && e.requestKeys.length > 0);
const executed = withKeys.filter(([sid]) => selectAddrRows(plan, [sid]).length > 0);
const allRows = Object.keys(plan.ecu)
  .reduce((sum, sid) => sum + selectAddrRows(plan, [sid]).length, 0);
console.log(`STAT REAL_RUNTIME_ROWS_TOTAL=${allRows}`);
console.log(`STAT SYSIDS_WITH_REQUEST_KEYS=${withKeys.length} EXECUTED_ROWS_GT_ZERO=${executed.length}`);
ck('REAL_EXECUTION_COVERAGE_WITH_REQUEST_KEYS',
  withKeys.length > 0 && executed.length === withKeys.length,
  `${executed.length}/${withKeys.length}`);
ck('SWEEP_PLAN_SAME_CONTRACT_AS_SELECT',
  sweepPlan({ bindPlan: plan, sysIds: ['0x0e23'] }).length === rows23.length
    && sweepPlan({ bindPlan: plan, sysIds: ['0x0e23'], skip: [0x070d] }).length === 0,
  'skip=0x070D 后无行（derived 未冒充替代真值）');

// ── 注入：改名 / 删除 requestKeys → 0x0e23 行数必须为 0；恢复后为绿 ────────
const renamed = JSON.parse(JSON.stringify(plan));
renamed.ecu['0x0e23']._requestKeys = renamed.ecu['0x0e23'].requestKeys;
delete renamed.ecu['0x0e23'].requestKeys;
const renamedRows = selectAddrRows(renamed, ['0x0e23']);
ck('INJECT_RENAMED_REQUEST_KEYS_ZERO_ROWS', renamedRows.length === 0,
  `rows=${renamedRows.length}`);

const deleted = JSON.parse(JSON.stringify(plan));
delete deleted.ecu['0x0e23'].requestKeys;
const deletedRows = selectAddrRows(deleted, ['0x0e23']);
ck('INJECT_DELETED_REQUEST_KEYS_ZERO_ROWS', deletedRows.length === 0,
  `rows=${deletedRows.length}`);

ck('INJECT_RESTORE_GREEN', selectAddrRows(plan, ['0x0e23']).length === rows23.length,
  `rows=${selectAddrRows(plan, ['0x0e23']).length}`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? `BINDPLAN_RUNTIME_CONTRACT_FAIL failed=${failed}`
  : `BINDPLAN_RUNTIME_CONTRACT_PASS count=${results.length}`);
process.exit(failed ? 1 : 0);
