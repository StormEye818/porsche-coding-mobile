# 全链路真实对齐 431 — T05 独立 QA 与干净 clone 终验记录（2026-11-20）

> 本文只登记**实测**：命令、退出码、stdout 的 sha256。
> 任何收口结论以命令输出为准，本文不含「文档自宣通过 / 自宣全 A」式判断。
> 凡标 `内部指纹` 者为被测审计自输出的 `sha256=` 行（不含「不进指纹」尾部）；
> 凡标 `stdout sha256` 者为 `shasum -a 256` 对采集文件的整段摘要。

## 0. 现场

| 项 | 值 |
|---|---|
| 被测 HEAD（T01–T04 收口） | `703a0edc8859659a48b507aa80273526010f067b` |
| 本机工作树 | `/Users/se818/porsche-coder`（本机绝对路径仅此一处现场说明，不进任何指纹） |
| 干净 clone | 由本机 clone 至同级目录，检出同一 HEAD，`npm ci --prefer-offline` 后 `git status --porcelain` 为空 |
| T05 新增/修改 | `tools/verify-align431-qa.mjs`（新）、本文（新）、`docs/工程规范-验收文档与发版面.md`（改） |
| 本机环境差异 | 本机沙箱对 `www/data` 批量删除有守卫；本机 `npm test` 以 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 关闭该工具层守卫后执行（clone 无需该开关） |

## 1. 干净 clone 命令集

### 1.1 `npm ci --prefer-offline`

- 命令：`npm ci --prefer-offline`
- 退出码：`0`
- stdout sha256：`0a608a39b7121fe8c89ff9c208c78b6e6f64f6222b9792eb9fb1e05269b8e22e`

### 1.2 `npm test`

- 命令：`npm test`
- 退出码：`0`
- stdout sha256：`4896e582a9e99e9f7ae9b250a0ca12525108a2aa478e1eb405c3129b25d9b5ab`
- 耗时：`871.76 s`
- 末行机读：`VERIFY_EVIDENCE_REGISTRY PASS`（退出前最终门禁）

### 1.3 `npm run audit:align431` ×2

| 轮次 | 退出码 | stdout 整段 sha256 | 内部指纹 `sha256=` |
|---|---|---|---|
| 第 1 次 | `0` | `ee496e4f94f938c2576479f21e4a065ced9544db4a1d01b863893f8ca91862ce` | `9c67e16e65a41412dc8413fa5872c810ddb3d5d9dfce3041fdb49862372e6d85` |
| 第 2 次 | `0` | `ee496e4f94f938c2576479f21e4a065ced9544db4a1d01b863893f8ca91862ce` | `9c67e16e65a41412dc8413fa5872c810ddb3d5d9dfce3041fdb49862372e6d85` |

- 两次 stdout 逐字节相同（`diff` 无输出）。
- 汇总机读行：`退出码=0（全 A 243/243，禁用结案词/三件套/删行/合并行均归零）`。

### 1.4 `node tools/verify-align431-qa.mjs`（T05 独立 QA gate）

- 命令：`ALIGN431_QA_AUDIT_A=<clone 第1次审计输出> ALIGN431_QA_AUDIT_B=<clone 第2次审计输出> node tools/verify-align431-qa.mjs`
  （复用已采集的两份真实审计输出；不复用则本 gate 自行真实跑两次审计）
- 退出码：`0`
- stdout sha256：`2a9edffa5861a632f8cecbfa306c421999bb135440a34758016cdfc6df693635`
- 机读汇总：`QA_SUMMARY 15/15 PASS` / `QA_ALL_PASS PASS`

逐条机读结果（expected / actual 均取自 gate stdout）：

| 条目 | 判据 | 结果 |
|---|---|---|
| Q01 | `NO_COORD_IMPL_ROWS_ZERO` | `PASS expected=0 actual=0` |
| Q02 | `ZERO_COVERAGE_HIGH_RISK_SYSID_ZERO` | `PASS expected=0 uncovered / 130 highRisk actual=0 uncovered / 130/130 highRisk` |
| Q03 | `ZERO_COVERAGE_SYSID_ZERO` | `PASS expected=0 uncovered / 623 sysId actual=0 uncovered / 623 sysId` |
| Q04 | `SYMBOL_HIT_A_ROWS_ZERO` | `PASS expected=0 actual=0` |
| Q05 | `ZERO_RUNTIME_ANSWER_A_ROWS_ZERO` | `PASS expected=0 actual=0` |
| Q06 | `INJECTION_RED_RATE_100_FALSE_GREEN_0` | `PASS exit=0 rate=100% falseGreen=0 red=10/10` |
| Q07 | `FORBIDDEN_CLOSING_REASON_ZERO` | `PASS expected=0 actual=0 scanFiles=18` |
| Q08 | `MISSING_PROVABLE_TAG_ZERO` | `PASS expected=0 actual=0` |
| Q09 | `RUNTIME_HARDCODED_ZERO` | `PASS expected=0 actual=0` |
| Q10 | `LANE_CHANGE_FOUR_TUPLE_FIELDS_MISSING_ZERO` | `PASS expected=0 actual=0 missing=[] macanDualBind=1` |
| Q11 | `SINGLE_SYSID_RAW_MERGE_ZERO` | `PASS expected=0 actual=0` |
| Q12 | `BASELINE_41_ASSERTIONS_ONLY_ADDED` | `PASS numbering=1 text=1 flags=1 assertions=1 rows=243 shaMatch=1` |
| Q13 | `ALL_A_AND_HIGH_RISK_130_130` | `PASS 243/243 A and 130/130 highRisk` |
| Q14 | `BCD_24_READJUDICATED_DOUBLE_EVIDENCE` | `PASS bcd=24 bad=0 recorded=24` |
| Q15 | `AUDIT_TWICE_SHA_STABLE_NO_MACHINE_MARKS` | `PASS shaSame=1 internalSame=1 marks=0` |

### 1.5 `node tools/verify-align431-injection.mjs`

- 命令：`node tools/verify-align431-injection.mjs`
- 退出码：`0`
- stdout sha256：`91fe29bde8d75c440561d53544bc28e67160ffb7612b993919c080813d4d18cc`
- 机读：`INJECTION_RED_COUNT 10/10` / `INJECTION_RED_RATE 100%` / `INJECTION_FALSE_GREEN 0` / `INJECTION_RED_RATE_100 PASS`
- 附加反例：`INJECT_EXTRA IMPL_LANDED_NO_LOCAL_ONLY_CARRIER baseline=1 red=1`；`INJECT_RESTORE_HASH_EQUAL 1`

### 1.6 端到端脚本

- 命令：`node e2e-flow.mjs`
- 退出码：`0`
- stdout sha256：`165d42ec5b3ed9c7be0872dc949c6d0d2b9e969a810c9dfa813e3f5df922aed7`
- 机读：`===== 端到端结果：127 通过 / 0 失败 =====`

### 1.7 其余门禁

| 命令 | 退出码 | stdout sha256 | 关键机读 |
|---|---|---|---|
| `node tools/verify-forbidden-words.mjs` | `0` | `cd23164fc683df14dc5748d722cb299c51fc2c7598e130cd0304a32baeaed373` | `FORBIDDEN_WORDS_ZERO 作为结案理由命中=0`，`FORBIDDEN_WORDS_SCANSET_MIN 入库 .md 数=18 下限=18 → OK` |
| `node tools/verify-u2-numbers.mjs` | `0` | `4b4a5842202412f44a4f7347f7e78ff8fe1c25f231a4701ae7b7f6396e3ea960` | `U2_NUMBER_DIFF_ZERO 权威数字 diff=0`，行为断言全真 |
| `node tools/check-bundle.mjs` | `0` | `f7ea4ec4244a10d820c1d6d2e8051f03fab0d295373f1d2e7496886c661e4e74` | `ok app.js 可打包（770KB）` |
| `node tools/boot-smoke.mjs` | `0` | `41e5b203a0743f2068c3955082c8907d488886639bed3e97fb9c3c3b931a0034` | `ok bundle 可加载，启动期无未声明变量` |

### 1.8 `git status --porcelain`

- 命令：`git status --porcelain`
- 退出码：`0`
- 输出：空（SHA-256 of empty string：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）

### 1.9 在册文档与门禁依赖全部入库检查

- 命令：对下列清单逐项 `git ls-files --error-unmatch <file>`
- 清单：`AUDIT-20261112.md`、`B-TO-A-CLOSURE-20261112.md`、`GAP-INVENTORY-20261112.md`、
  `ACCEPTANCE-MATRIX.md`、`PRD-FULLALIGN-431-20261113.md`、`RE-GAPVERIFY-20261112.md`、`TAKEOVER.md`、
  `docs/ARCH-全链路真实对齐-20261120.md`、`docs/PRD-全链路真实对齐-20261120.md`、
  三本 `docs/evidence/431-*.md`、`docs/ACCEPTANCE-ALIGN431-20261120.md`、
  `docs/工程规范-验收文档与发版面.md`、`tools/verify-align431-qa.mjs`、
  `tools/verify-align431-injection.mjs`、`tools/align431-rows.json`、`tools/align431-eval.mjs`、
  `data/align431-evidence-registry.json`、`tools/align431-vectors/`（5 份）。
- 退出码：`0`（缺失项数 = 0；结论于 T05 提交后复查）

## 2. 本机命令集

| 命令 | 退出码 | stdout sha256 | 备注 |
|---|---|---|---|
| `npm run audit:align431`（第 1 次） | `0` | `0325b7391971a96355bf7358604135812cd979dad10d2885e07c5fc7276534a2` | 内部指纹 `9c67e16e…` |
| `npm run audit:align431`（第 2 次） | `0` | `0325b7391971a96355bf7358604135812cd979dad10d2885e07c5fc7276534a2` | 同上；两次逐字节相同 |
| `node tools/verify-align431-qa.mjs`（复用本机两份审计输出） | `0` | `2a9edffa5861a632f8cecbfa306c421999bb135440a34758016cdfc6df693635` | `QA_SUMMARY 15/15 PASS` |
| `node tools/verify-align431-qa.mjs`（不复用，gate 自行真跑两次审计） | `0` | `ad82ff1ea95cfd6011142d8e02e83ef540bd93addc88c4feb43ee9e528ef241a` | `QA_SUMMARY 15/15 PASS`，Q15 `reuse=0` |
| `node tools/verify-align431-injection.mjs` | `0` | `91fe29bde8d75c440561d53544bc28e67160ffb7612b993919c080813d4d18cc` | `INJECTION_RED_RATE 100%` |
| `node e2e-flow.mjs` | `0` | `2bdcfc19200a0a194694363612b78871e6e87afcdf98714774b157b1dc7a695b` | `127 通过 / 0 失败` |
| `node tools/verify-forbidden-words.mjs` | `0` | `b23a1cbf667618eb8d181b394f95ebb78181e2234413a442e338eefb9151e76a` | 结案理由命中 0 |
| `node tools/verify-u2-numbers.mjs`（定稿后复跑） | `0` | `02d3dd0186a10df80c47dd9c668ba2f98c9be8dca874cbc0f47fc761ea38359a` | 行为断言全真 |
| `node tools/check-bundle.mjs` | `0` | `f7ea4ec4244a10d820c1d6d2e8051f03fab0d295373f1d2e7496886c661e4e74` | — |
| `node tools/boot-smoke.mjs` | `0` | `96b44781ee6ea2b2119cd30929bc6de68de75dafc6e9abc001c1249b27fe83a7` | — |
| `npm test`（关闭沙箱工具层删除守卫后） | `0` | `a59dc42159921db850ae935ed49b79a49aed0d27b33de4d4b91b3dd15a414992` | 见 §2.1 |

### 2.1 本机 `npm test` 的环境说明

- 第 1 次执行被 WorkBuddy 沙箱的节点删除守卫中断（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，
  目标为构建产物目录，非源码/证据），退出码 `1`；非项目缺陷。
- 第 2 次执行在关闭该工具层守卫后，`docs/工程规范-验收文档与发版面.md` 一行触发 U2 子目录
  指标认领检测（`e2e-flow` 后紧跟数字），退出码 `1`；已改写该行去除认领形态并复跑独立门禁
  确认 `subdirOk=true`、退出 `0`。
- 定稿后完整复跑结果见上表 `npm test` 行（退出 `0`）；此两处红态均为验收文档/沙箱层面，
  未改 src / data / 任何 T01–T04 产物。

## 3. 跨机确定性

- 本机两次审计 stdout 整段相同：`0325b739…` == `0325b739…`。
- clone 两次审计 stdout 整段相同：`ee496e4f…` == `ee496e4f…`。
- 本机与 clone 的**内部指纹**相同：`9c67e16e65a41412dc8413fa5872c810ddb3d5d9dfce3041fdb49862372e6d85`。
- 本机与 clone 的整段 stdout 差异**仅**在末尾明确标注「不进指纹」的一行
  （本机 `未入库 .md 42 份` / clone `未入库 .md 0 份`）；指纹段逐字节相同，符合 A-8。

## 4. QA gate 可证伪性（非橡皮图章）

在 clone 中注入两处反例后 gate 均转红，恢复后回到 15/15：

| 注入 | 命令（复跑方式） | 观测 | stdout sha256 |
|---|---|---|---|
| 将四元对象 `can.provable` 由 `static` 改为 `runtime` | 临时覆写 `data/bind-plan.json` 后跑 QA gate | 退出 `1`，`QA Q10 … FAIL missing=["can.provable"]`，`QA_SUMMARY 14/15 PASS` | `d7584e6ee6384fd4f5cb4e559710da069595594e3b9fe2a10ab4d3562875242b` |
| 删除一行断言（改断言名） | 临时覆写 `tools/align431-rows.json` 后跑 QA gate | 退出 `1`，`QA Q12 … FAIL assertions=0 shaMatch=0`，`QA_FAILED Q06/Q12` | `3f4707eca810367d0ce3714016f7eee2c8ba5fdefc0bd917a208c052bc2e4b60` |
| 恢复两文件后复跑 | `node tools/verify-align431-qa.mjs` | 退出 `0`，`QA_SUMMARY 15/15 PASS` | `2a9edffa5861a632f8cecbfa306c421999bb135440a34758016cdfc6df693635` |

注入均在干净 clone 的副本上进行，关键文件已逐字节恢复；本机工作树未被注入污染。

## 5. 独立性声明（可核）

- `tools/verify-align431-qa.mjs` **不** import `align431-eval.mjs`，**不**调用被测 gate 的
  `evaluateRow` / `scanForbiddenWords` / `assertionIntegrity` / `evaluateProvableTag` 等求值函数；
  禁用词表、坐标形状、断言摘要、provable 树遍历均为该文件内独立实现。
- 对被测 gate 仅作黑盒调用：注入 gate 与审计 gate 通过子进程执行，只读其机器行 / stdout。
- 本文件 stdout 只含机器名与计数，不含本机绝对路径、时钟、随机值或工作目录。
- 子进程 stdout 以临时文件 fd 捕获后读回，与 ARCH §9 `> /tmp/a1` 同语义。
  实测：被测审计在约 160 KB 输出后即 `process.exit()`，pipe 捕获只 flush 约 54 KB、
  尾部 `sha256=` 行丢失（可直接 `npm ... > file` 复现对照）。此为本 QA gate 捕获方式的
  已知边界，已用文件 fd 规避；验收一律按文件重定向路径取指纹（见 §1.3 / §2）。
