# 增量 PRD（定稿）｜全链路字节级对齐 431 彻底收口

> **定稿信息**
> - 版本：**v1.3 定稿**（team-lead 2026-11-13 批准，按「自包含最终落盘清单」一次性落盘；v1.0 消息回传 → v1.1 落盘 → v1.2 / v1.2.1 承载 HB-1 取证与文本层闭合 → **v1.3 承载 HB-2 判据改写、HB-3 分层、D 类补强、U-1 分列纪律及全部纠错**）。**基线 `50b720b`、权威 N=120、Q1–Q4 裁定、附录 A 均不变。**
> - **基线：`50b720b`**（`git rev-parse --short HEAD` 实测）
> - **权威 N = 120**（`bind-plan.json` 的 `commCat10-family-default` sysId 数 = `stats.commFamilyDefault` = 120，双源实测一致；详见附录 A）
> - **Q1–Q4 已由主理人裁定**，不再列为待确认（见 §6）
> - 交付对象：架构师（任务分解输入）｜撰写：产品经理许清楚
> - 本文件为唯一授权新增文件；除此之外未修改任何项目文件，未执行 `git add` / `git commit`（由主理人统一提交）。`git check-ignore -v` 实测 `IGNORED=no`，无需 `git add -f`。**`tools/` 下两个待落盘门禁由 #20 实现，本 PRD 不写。**
> - **订正记录（2026-11-13，team-lead 裁定）**：D-1 / P0-8 / F5 / F14 / U-6 中关于老代 KWP sessionless「服务专属会话 `1040/1085/1003`」的旧结论，已按包内字节证据订正为「68 个 sessionless sysId 在全部 7 种服务上均不建立 UDS 会话」；`tools/verify-fullchain-audit.mjs:117` 的错误行为断言已登记为「按包内证据订正，非放宽标准」。**§2 三层模型、§3.1 HB-3、U-3、§8 中的 `1003` 属 cat=0x60 四帧模板 `3E00→22F19E→22F1A2→1003`，非老代服务专属会话，经核查无需订正。**

> 实证核对：`GAP-INVENTORY-20261112.md` §2 共 41 行（A17/B14/C5/D5）及 5 份配套基线文档确在项目根、被 `.gitignore` 排除 ✓；`package.json` 的 `npm test` / `npm run rebuild:all-models` / `coverage` 脚本清单已核对 ✓；R4 冲突点定位到 `src/app.js:426/435/647-658` 与 `src/probe.js:10/63/131/141/227` ✓。

---

## 0. 项目信息

| 项 | 内容 |
|---|---|
| Language | 中文 |
| Programming Language | **沿用现有栈**（esbuild + Capacitor + 原生 JS，见 `package.json`）；本轮为增量收口，不引入框架替换，避免改动运行时字节行为 |
| Project Name | `porsche_coder_431_fullalign` |
| 基线 | HEAD `50b720b`；`GAP-INVENTORY-20261112.md` §2 共 41 行（A17/B14/C5/D5）；配套 `ACCEPTANCE-MATRIX.md`（§3 未对齐）、`B-TO-A-CLOSURE-20261112.md`（§3 保留卡点）、`RE-GAPVERIFY-20261112.md`、`AUDIT-20261112.md`（§4 八项边界）、`TAKEOVER.md` |
| **权威 N** | **120**（family-default 候选 sysId 数；`schemaVersion=5`，sysId 总数 597；候选分布 3 个候选 28 个 / 13 个候选 2 个 / 16 个候选 90 个）。文档中的 `92` 为历史值，须消除。 |
| 原始需求复述 | 把卡点全部对齐 431：现有非 A 项一律收成 A；431 可离线完成所有支持车型的全链路（VIN→识别→进模块→编码读写），故一切分派/映射/帧序必然静态存在于本地包内，必须挖到字节证据再收口；修复后重新审计，未全 A 就继续挖，直到全部收口且字节级对齐审计确认；同时清掉「文档写 A、代码做 B」与 bug，保证收口后功能真的接进 app、完全复刻 431 全部功能且字节级实现。 |
| 不可协商前提 | **431 离线可完成全链路**。因此「包内不存在 / 需要真车测试 / 运行时态无法静态复刻 / 431 同界 / 适配器能力差异 / 有意偏离 / 结果由 ECU 裁决 / 源包限制 / 承诺外 / 留白证据级」一律**不得作为结案结论**，只能作为「待挖线索」并附下一载体与可复跑扫描命令。 |

---

## 1. 产品目标与用户故事

**产品目标（一句话）**：在「431 全链路静态可证」前提下，把清点表 41 行中所有非 A 项以包内字节/指令证据逐条收成 A，使 14 项功能在 app 运行时真实可调用，直至一条确定性可复跑审计命令逐行输出全 A、零非 A、零「文档 A 代码 B」、零数字冲突。

| # | 用户故事 |
|---|---|
| US1 挖证据 | 作为审计工程师，我要为每个非 A 项定位到**包内具体载体**（`.so` VA/指令、`BIN` 文件:偏移、`JSON` 记录号），以便由该字节独立复算出 431 的做法，而不是接受任何「运行时/边界/包内无」的定性结论。 |
| US2 收口 | 作为开发，我要把静态等价规则接进 app 主链并钉上门禁断言，以便我们「发什么帧、按什么规则选地址/会话/算法」与 431 逐字节/逐判定一致。 |
| US3 审计 | 作为验收人，我要一条可复跑审计命令，逐行输出 41 行的判定、证据坐标、数字实测来源，以便任何人独立复算，不能靠报告自宣达成。 |
| US4 再挖 | 作为审计人，当审计输出出现任一非 A 行时，我要它自动给出「下一载体清单 + 扫描命令」并回到 US1，形成循环，直到连续两次独立复跑全 A。 |
| US5 真接通 | 作为用户，我要文档标 A 的每一项都能在 app 里点到并跑通（不是死代码/纯文档分类），且数字与实测一致，以便「完全复刻 431」是可验证的功能事实。 |

---

## 2. 口径重定义（防止「文字游戏」的论证要求）

**A（新定义）**＝我们的**做法**（发什么帧；按什么规则选地址 / 会话 / 算法 / 平台 type / 分派）与 431 静态证据**逐字节、逐判定一致**，且该做法在 app 运行时真实生效。
**关键转换**：运行时输入（ECU 应答、VIN 具体值、NRC、回读值、是否 7F78）是**输入**，不是「做法」；输入不确定**不构成 B**。旧 B 的四种豁免理由（「431 同界」「适配器能力差异」「有意偏离」「结果由 ECU 裁决」）一律失效，必须翻译成三段式论证：

1. 431 侧做法是什么（由包内静态字节/指令复算）；
2. 我方做法是什么（由 `src/` 代码实发帧/判定函数复算）；
3. 两者逐字节 diff。

**论证要求（可证伪，缺一不得标 A）**：
- **R-1** 每行判定必须同时写出 `431 证据坐标 = <文件>:<偏移|VA|记录号>` 与 `我方代码路径 = <文件>:<符号|行>`，二者缺一即判不通过。
- **R-2** 必须给出「由 431 证据复算的期望字节序列 / 判定输出」与「我方实发的字节序列 / 判定输出」的 diff，**diff 为空**才算 A；「测试全绿」不作为对齐证据（`AUDIT-20261112.md §7` 已自述此纪律）。
- **R-3** 任何声称「由运行时决定」的项，必须给出**可复跑的阴性扫描命令**（列明扫描范围：27 个 `.so` 的 BL/BLX 目标、MOVW/MOVT 常量构造、数据段函数指针、dynstr 未定义符号、分发注册表/JNI 边界等，并输出各范围命中数）。**只给自然语言「未见即不存在」无效**；给不出扫描命令者一律按「待挖」处理，不得标 B，并必须换载体继续挖。
- **R-4 禁用结案词**：§0 不可协商前提列出的 10 类词，作为「结案理由」出现次数必须 = 0（可由 grep 复跑）。
- **R-5 证据等级与 U-1 载体状态分列**（v1.3 增补）：每行判定须同时给出两个互不替代的字段：
  - `取证等级`：由 431 静态证据坐标 + 我方代码路径 + **独立复跑命令**（如 `node -e` 只读 `src/app.js`、`llvm-objdump` 反汇编、BIN 偏移 dump）判定 A / B，**不依赖** `tools/verify-*` 门禁是否落盘；
  - `U-1 载体状态`：三件套（`src/` 路径 + 门禁断言名 + 431 证据坐标）是否齐备；未齐备标「**载体待落盘（#20）**」。
  - 「门禁待落盘」是**载体状态**，不是证据不成立，不得据此把已复跑的取证 A 降级为 B；但**「单行取证 A」≠「全链路全 A 终止」**：门禁未落盘时三件套缺失数 ≠ 0，**T1/T4 仍不达成、不得宣称「全部收口」**。

**帧序判据的三层模型（防止把 L2 当 L3 收 A）**：

| 层 | 载体 | 判定含义 |
|---|---|---|
| **L1 原厂包内静态** | `PORSCHE_SYS_DATA.BIN` cat=0x60 记录；`GAG_COMMAND.GAG.bin` 命令 ID 段 `0x00200000-0x0020000A` | 帧序 `3E00→22F19E→22F1A2→1003` |
| **L2 我方静态解析产物** | `data/sysdata-comm.json`（185 block / 74 sysId）、`src/oem-enter-frames.js`（185 序列） | `74/74` 与 `185/185` 是**同一帧序的两个统计口径**，逐字节互证所在层；只证明解析正确、L1 自洽 |
| **L3 我方运行时实发帧** | `probeChainFor`(app.js:443)、`finish()`(app.js:651,658)、`identityAdjudicate`(probe.js:227) | **判据「做法逐帧 diff=空」只在此层判定** |

`74/74`、`185/185` 只证 L1/L2 自洽与我方期望基准正确，**不得**据此宣称我方运行时实发帧已对齐。凡「**帧数差 = 0**」「**每候选 1 帧**」「**期望帧序列 vs 我方实发 diff = 空**」一律加「**探针阶段**」限定语；身份裁决阶段用 ②-b 单独表述（见 §3.1 HB-2 / HB-3）。

---

## 3. 需求池（P0 必须 / P1 应 / P2 可；每条均为可证伪判据）

### P0（不达 A 不收工）

| ID | 需求 | 可证伪验收判据 |
|---|---|---|
| P0-1 | **41 行按新口径重判**，产出逐行新清点表（每行含 R-1 两个坐标 + R-2 diff） | 新表行数 ≥ 41 且逐行可索引；理由字段中禁用结案词命中数 = 0（`grep -cE` 可复跑）；每行要么含 `evidence:<file>:<offset|VA>` 且对应复算命令退出码 0，要么明确标「待挖」并附 R-3 扫描命令；不存在「无坐标却标 A」的行数 = 0。**Q1 裁定落地**：挖出的新项（92→120 差额、9X6/9X7 新增 type 规则、`noRid` 静态载体等）作为**新增行追加**，原 41 行基线编号必须原样保留，删除行数 = 0、合并行数 = 0，禁止靠「行数变少」制造全 A 假象。 |
| P0-2 | **B 类 14 条逐条收 A** | 14/14 每条给出「431 期望帧序列 vs 我方实发帧序列」逐字节 diff = 空。逐条覆盖：n=0 链路绑定（ATSH/ATCRA 等价）、VIN 广播 `anyRx`、`vid` 归一化、9X1 KWP IC/0x0C08、`ECU_ADDR candidate`、R6 网关假说、68 老代 KWP 不建 UDS 会话、地址态闸默认关、**写结果由 ECU 裁决**、DRIVELINKS 无记录的 5 个 sysId、`needsKey:false` 不可达、例程 ID 合法性语义、回帧 ID 校验口径、共享子集高字节任选。其中「写结果由 ECU 裁决」类须证明 431 与我方**发同一帧 + 同一 NRC/回读判定函数**，ECU 回值仅作输入；不得再以「运行时不确定性」保留 B。 |
| P0-3 | **C 类 5 条 →「支持车型/功能全集与 431 一致」** | **Q2 裁定落地**：不人工指定单一权威载体；以 `DSN.BIN` 头 22 项 / `ALLDATA` 目录 / `PORSCHE_SYS_DATA.BIN` 根表 / `COMMAND.GAG` 的**并集**作为「包内可枚举集合」，与 app 可枚举的「车型全集 / 模块全集 / 功能全集」逐项比对：**差集 = 0，覆盖率 X/X**（X = 并集清单条数）。逐条落地：9X6/CS1 老平台模块（原判「源包数据量」）、6 对孪生「不承诺左右」（须给出 431 侧左右判定的静态规则或挖出等价规则，不得以「不承诺」结案；**Q3 裁定**：若挖出规则，UI 左右命名改为与 431 文本表一致，文案随动）、`noRid` 16 条（须给出例程 ID 的静态载体）、`SPECFG.INI [SYS_SPEC]` 对账、`BUCKET-LISTS` 归桶依据（须给出桶归属的静态规则）。**现状栏须记功能全集差集非 0 的 5 条事实**（见下），并明示 **D-3 的 100% 不得外推为「差集=0 / P0-3 达标 / 全 A」**：① `function-sequences.json` 687 条 → 489 条无任何 map 引用（UI 不可达）；② `measure.json` 1719 条 → app `.slice(0,30)` 仅 480 条可点击；③ `routines*.json` / `special-functions*.json` app 零 fetch；④ 顶层 27 个 json 不被 fetch；⑤ 500 截断本身。这 5 条按 P0-8 记为「当前 B / 待 #20 接进 app 后收 A」的**实现层未接通项**，不是 C 类口子，不做双判。 |
| P0-4 | **D 类 5 条逐条收口** | 每条须有包内证据坐标 + 独立复算命令，覆盖率均为 X/X；涉及 family-default 候选的条数一律以**权威 N=120** 为准（不得沿用历史值 92）：<br>**D-1** 老代 KWP（68 个 sessionless sysId）在 `coding/ident/routine/io/measure/reset/routine2` 全部 7 种服务上**均不建立 UDS 会话**；431 侧证据坐标 = `PORSCHE_SYS_DATA.BIN` comm 记录的 **117 条原厂进模块序列 `10xx` 命中 0**（`src/oem-enter-frames.js` 的 `OEM_SESSIONLESS_SYSIDS_SET` 68 键；`0x0101` 原厂序列 = `81` + `1A9A`，无 `10 40`）、`JOB.BIN` 12 个 DBUSER 中 9X6/9X7/E1 出现 0 次、`GAG_COMMAND.GAG.bin` 的 `1040`×87 / `1003`×9 / `1085`×1 属**新代 UDS 命令段**与老代 sessionless ECU 无关、老代 27 个 impls 首帧全是 `22/31/27/21/14/1A` 服务帧；`enterSessionFor` 在 `oemSessionless && opts.session==null` 时一律跳过会话建立，**期望帧序列与我方实发 diff = 空（两者均无 `10xx`）**；不得写「真车/零卡点」。**实现层事实（供 #21 QA 复核）**：`tools/verify-fullchain-audit.mjs:117` 的旧 `1040` 断言已按包内证据订正为「sessionless 上不发任何 `10xx` 帧」行为断言，**非放宽标准**。<br>**D-2** 例程 ID→功能语义：映射表须由 `GAG_COMMAND.GAG.bin`（count=3139 / `index_off=0x256` / 236 条 `0x31` 带 RID 记录）**某文件:偏移的字节复算**，在**同一 RID 命名空间**下覆盖率 **X/X**（79/79 RID 全部有 `{idxOff,payloadOff,cmdId,body}` 字节坐标）。**删去「与手工索引交集仅 1」这一无效指标**：`data/special-functions.json` 的 67 条 `routineId` 全在 0x200–0x34E 且 67/67 等于 `special-function-map.json` 的 `menuId`，实为菜单 ID，与 `data/routines-verified.json` 的 79 个 RID（0x0–0xF021，31 01 例程参数）不同命名空间，数值偶合 1 次无语义含义；`67/79/687` 分别标为 menuId / 通信 RID / 功能序列，不得读作同一命名空间；不接受「真车确认」。<br>**D-3** 代码-数据断接：以 `data/coding-v2.json` 的 `params[].id` ∪ `data/models/*/*.json` 的 `items[].id`（979661 个）为全集，`menu-tree-v3.json` 的 119657 个 distinct itemIds **119657/119657（Y/Y=100%）** 可解析到真实参数实体（119522 逐字命中 + 135 经 `车型:模块_变体:chain` 前缀归一命中，`miss_resolvable_by_chain=135/135`），`verdict=A`；`99.8872%` 仅为**归一前中间量**、不是判据数字。135 条中 127 条尾部 bit>7 的历史编号、20 条落在 500 截断数组，跨 19 车型含 981/991 各 1 条（**不得**写成「全是非 981 浏览态项」），主链路数据实体无缺失，归属 D-3 bug #2（itemIds↔coding-v2 单一口径）与 bug #3（500 自创上限）受影响索引行，**不构成 C 类缺口、不作为不收 A 的理由**。`MENU.BIN` u16 `0x01F4`(500) 0 命中、`0x4c`=767 与 codingCount 吻合（153/153）→ **500 是生成器自创上限、431 侧用真实 u16 条目数**，须给出该长度规则的静态证据；断言 `D3_ID_UNION` 由 `tools/verify-d3-id-union.py` 复跑（待落盘，见 §7）。<br>**D-4** VIN 字符集主链/OBD 链：两链对同一组 VIN 输入产出逐字节相同的字符集判定，用例 X/X 全同。<br>**D-5** 枚举 `maxText`：「34 条」为历史值；精确 **13873 条 / 24 值**，由 `GAG_EXPRESS.GAG.bin` 46205 条 `BitLength=` 逐条复算 `2^BitLength-1` → **13873/13873 一致**，证明**现值即 431 值、不清洗**；**禁止「清洗」成自创值**。<br>`noRid 16` 仍作独立待办。 |
| P0-5 | **三个硬骨头（不达 A 不收工）** | 见 §3.1 专项表（HB-2 的 N 已定为 **120**）。 |
| P0-6 | **文档写 A 代码做 B + 数字冲突收口** | `GAP-INVENTORY §2:50`（共享子集标 A，实为纯文档分类、无代码路径与门禁）与 `§2:54`（92 候选收敛标 A，`unknown` 保底下未证收敛）两处高估：要么补齐 `src/` 代码路径 + `tools/verify-*` 断言并给出 diff = 空，要么降级为「待挖」；`B-TO-A-CLOSURE §3.3/§4` 旧数字（1072 / 拒写 2 / 门禁 53）、`§3.3` 旧「异文件引用」结论与 `RE-GAPVERIFY §2` 更正、`GAP-INVENTORY §1`（1070 / 0 / 67）、`TAKEOVER` 顶部（53）与 `§0「还差 53」/§3「150/150、33/33、38/38、635」`、`ACCEPTANCE-MATRIX §5「36+359+105+84+66」`、以及**所有 `92` 旧表述**全部统一到**复跑实测值**：文档数字与命令输出 diff = 0（详见 §5 U-2、附录 A）。 |
| P0-7 | **确定性可复跑审计命令**（循环终止基础） | 存在一条命令（命名由架构师定，建议 `npm run audit:align431`），输出契约：① 41+N 行逐行判定（A / 非 A，新增行单独编号、不覆盖基线 41 行）；② 每行 R-1 两坐标；③ 每个数字的实测来源命令（含 `N=120` 的复跑命令）；④ 非 A 行的「下一载体 + 扫描命令」；⑤ 每行按 R-5 分列 `取证等级` 与 `U-1 载体状态`。判据：**全 A 时退出码 0，任一非 A 时非 0**；同一工作区连续两次运行输出 **sha256 相同**；`npm test` 全绿或文档结论**不得替代**该命令。 |
| P0-8 | **14 项功能真接通（非死代码）** | 每项须有「UI 入口 → 调用链（文件:符号序列）→ `elm.cmd` 实发帧」证据，且 `e2e-flow.mjs` / `smoke-fixes.mjs` 有逐帧断言，期望帧序列由 431 证据复算、diff = 空。死代码/未接通标记数 = 0：`runWritePrologue` 无调用方、`runtimeModules gen=null / apply=false`、`needsKey:false` 生产不可达、3 处裸 `uds` 未纳入写锁、`unknown` 保底、`provenance: 必须探针验证`、`noRid` 空语义、`sessionless` 上误发 `10xx` 帧（旧「服务专属会话」结论已按包内证据订正、非放宽标准） —— 逐项要么修通要么给出「431 侧亦无此路径」的静态证据。已知 bug 清单（`AUDIT-20261112 §3` 8 类已修项的回归断言、`§4` 八项边界、`_writeBusy` 竞态、探针阶段多发 2 帧、注释自称「进模块后」却在探针阶段）逐项给出收口判定与断言名。**待接通清单（当前 B / 待 #20 接进 app 后收 A）**：P0-3 现状栏的 5 条（489 条功能序列无 map 引用、measure 480/1719、routines/special-functions 零 fetch、27 个顶层 json 不被 fetch、500 截断）逐项给出 UI 入口→调用链→实发帧证据与 `e2e-flow.mjs` 断言；须显式证明 **D-3 的 Y/Y=100% 未外推为差集=0 / 全 A**。 |

#### §3.1 三个硬骨头专项判据

| ID | 现状结论（不得直接沿用） | 可证伪验收判据 |
|---|---|---|
| **HB-1** 9X6/9X7 模块→type 高字节归属（**取证判 A：静态可解；代码未落地前不计 A**） | 旧结论「运行时 BV 域、包内静态零调用点 / 需实车 VIN 日志比对」**已推翻**；「零调用点」真实成因 = 跨库 BSS 全局函数指针 + `blx rN` 分发架构，规则与表全在包内。**仍待 #20 代码落地**：`gen=null`、`apply=false`、`tools/build-dsn-module-sysids.mjs:132-133` 多 type 平台 `runtimeModules` 留空、真差异子集走全局表回退（实测 `runtimeModules={}`，9x6 26 / 9x7 38 停在 multiType/unresolved，属**待清零项非已达标项**） | **证据链（R-1 坐标，须可由 `python3 tools/disasm-elf.py <so> <VA>` / BIN 偏移 dump 独立复跑）**：`libPORSCHE_SYSP.so:0x26344 PorscheGetVehiclePlatform` 的 22 槽 TBB @`0x2634E` + 串池 @`0x56CBD`；`libPORSCHE_READWRITE.so:0x147C80 GetVehicleForVin`（Thumb 入口 `0x147C81`，17 槽 TBB @`0x147CD6` case 常量 `8E 09 AC AC 1E AC 26 35 43 AC AC AC AC AC AC AC 51`，二次键 VIN[11]，返回值全集 `{3,0x0B,0x0C,0x0D,0x0F,0x10,0x11,0x12,0x14,0x15,0x16}` **不含 1/2/4/5/6** → 9X6/9X7 老平台走平台级规范 type + 车型菜单，不由 VIN 位运算决定）；`libPORSCHE_SYSP.so:0x2A958 PorscheGetVehicleIDByManualSelect`（24 项菜单表 @`0x5E42C`）→ 恒等式 **vehicleId ≡ DSN id ≡ SYS_DATA type ≡ sysId 高字节 ≡ BV域**。**文本层已闭合**：`libSTD.so:0x255AC GetTextFromTextLib` 将 `0xFF0000NN` 大端拆 4 字节 key → PLT `FromIdGetBinaryString@0x25574` → `IndirectGetText@0x25614`；`GAG_TEXT_CN.GAG.bin` idx 1961..1992、key `0x0570C4A0..0x0570C4BF` 全量导出 **32 条车型名/年款文本**（9X6 五款 / 9X7 三款；另含 991/981/982/992/Cayenne/Panamera/Macan/Taycan/918）；**同平台多 vehicleId = 同平台多车型/年款条目，非不同通讯协议，不影响规范 type 规则**；「包内无车型名、无年款标注」正式推翻。**验收**：① 静态规范 type = 取 comm 目录覆盖模块表 `sysIdLow` 全集最多的 type（**9X6=0x01、9X7=0x05**；`0x01⊃0x02` 实测 12/14 vs 10/14、`0x05⊃0x06⊃0x04` 实测 33/34 vs 30/34 vs 20/34，须可复算）；② 产出 **9X6 29/29 + 9X7 41/41** 条 `(module,type,fullSysId)` 映射表，真差异子集（9X6 7 条、9X7 `0x05↔0x06` 11 条、`0x04` 参与 20 条）不再走 unknown 保底/全局表回退；9 个 `E1_pcm2_*`/PCM1 跨代模块按 `E1_` 前缀静态归 `type 0x03 (0x0346)`，1 个 `_9x7_pcm2_gw` low=0x00 标 `gatewayNoSysId` 且不在 `runtimeModules`；③ 标注「静态等价集」（共享 / 仅 echo / 真差异三档）；④ `gen=null`/`apply=false` 字段数 = 0、`runtimeModules` 留空行数 = 0；⑤ **禁止**「需实车 / VIN 日志比对 / 运行时 BV 域 / 包内静态零调用点」作为结案或待办理由（R-4 / U-3）。**验收依据（不得引用 /tmp）**：由 `tools/build-dsn-module-sysids.mjs` **自己产出** `runtimeModules`（全平台）/ `canonicalType` / `multiType[*].{staticChoice,equivalentTypes,differTypes}` / `crossGenModules` / `gatewayNoSysId` 并落到 `data/dsn-module-sysids.json`；另新增 `data/vehicle-id-type-map.json`（22 项 + `supersetProof` + 32 条 `menuTexts`）与 `data/vin-type-table.json`（`tbbSlots=17` / `tbbBytes` / `cases[]` / `returnIdSet`），由 `tools/build-vin-type-table.mjs` 按 **5 步静态解析** `@0x147CD6` 产出（读 17 个 u8 → `caseTarget(k)=0x147CD6+2*v` → capstone 反汇编至统一输出点 `0x147E2C` → 提取 PC-relative 平台名串 / VIN[11] 字符条件 / `movs r0,#imm` 返回 vehicleId → 硬校验 `vehicleId∈1..22` 且与 `vehicle-id-type-map.json.map[].vehicleId` 一致）。`/tmp/hb1_fullmap.json` 保持为取证中间产物、**不进仓库、不作验收依据**。复跑 `node tools/build-dsn-module-sysids.mjs && node tools/build-vin-type-table.mjs && node tools/verify-hb1.mjs`（建议 `npm run verify:hb1`），**10 条 `HB1-T5-01..10` 断言**：runtimeModules 非空（29/41）、canonicalType 超集硬校验（`{9x6:'0x01',9x7:'0x05'}`，`pickCanonical()` 的 `[...S].every(l=>bestSet.has(l))` 对 0x02→0x01、0x04/0x06→0x05 全成立）、唯一 `(module,type)` 29/29+41/41、完整 sysId 格式 `^0x[0-9A-F]{4}$`、跨代与网关特例、静态等价集标注、gen/apply 归零、VIN TBB 17 槽可复跑（`tbbBytes` == `8e09acac1eac263543acacacacacacac51`）、阳性证据坐标复跑（三处 VA 退出码 0）、结案词归零。**口径保持「取证判 A、代码待落地，代码未落地前不计 A」**（§2 的 A 要求运行时真实生效）。 |
| **HB-2** family-default 候选静态分派规则（**权威 N=120**） | 旧判据「120/120 条 sysId→唯一 (tx,rx) 静态绑定表」**参照系判错**：431 静态做法本身不产生逐 sysId 唯一地址表，而是「候选循环（每候选 1 帧 `22 14 09`）+ 应答即绑 + 185/185 统一 4 帧模板」；74 个 cat=0x60 sysId 只共享 21 个索引值、185/185 个 block 帧序逐字节全同。**120 个 family-default sysId 全部是 `family_default_pairs`(`tools/export-bind-plan.py:133-147`) 把「同代其它真实 ECU 的 cat=0x10 地址表」错配给无 cat=0x10 的 sysId**（实现 bug，须收口）；`[:16]` 截断只叠加在 90 个 16 候选组。新载体全阴性（8685 条 72B 定长 SID/LID 模板、41744 条 VIN+PR 纯文本地址 u16 命中 0、6 个未解 BIN、全二进制「16 候选连续静态表」0 命中）。`GAP-INVENTORY §2:54` / `B-TO-A §3.2` / `AUDIT-20261112 §4 #3` / `TAKEOVER` 中的 **92 为历史值**。**注意**：这是「431 做法本就不是唯一地址表」，不是「包内不存在 / 需实车」——后者按 R-4 / U-3 禁用。 | **A = 做法逐字节对齐（§2 口径）**，120 个候选仍须 **120/120** 逐条覆盖（N 不变），验收形态 = 「静态分派规则可复跑 + 期望/实发帧序列 diff=空」。① **431 侧坐标可独立复跑**：`libPORSCHE_LINK.so:0x18f00 DriveLinksMode_1001`（`llvm-objdump -d --triple=thumbv7a-none-eabi --start-address=0x18f4c --stop-address=0x18fa0`）候选循环 `0x18f80-0x18f9c`、`movw/movt r10=0xFF001409`（`22 14 09`）、`movs r2,#1`（每候选 1 帧）、`cbz r1,0x18f9e`（候选数 0 直绑）、`0x18fe2 movw r0,#0x1102`（补帧 `22 11 02`）、`0x18fb2-0x18fbc send(0x100359,A,2)` 绑定；cat=0x10 subs 全表 **527** 条，`tx∈0x700–0x77F` 段 **402/402** 满足 `rx=tx+0x6A`（**全表口径 402/527**，另 125 条老代用 `+0x100`(82)/`+8`(35)/其它(8)；`0x070B` owner 跨 12 代低字节全 `0x37`）；**185/185** 个 cat=0x60 block 统一 4 帧 `3E00→22F19E→22F1A2→1003`（`distinct 1 counts [185]`）。② **R-2 逐字节 diff 分列两条独立断言**：**②-a 探针阶段（取证结论 A，可独立复跑）**——`probeChainFor`(app.js:443) = `{kwp:1A9F,uds:221409}` vs 原厂 `0xFF001409` / 补帧 `0x1102`，**diff=空**（实跑命令为独立 `node -e` 只读 `./src/app.js`，**不依赖** `tools/verify-oem-probe-diff.mjs`）；支撑「每候选 1 帧」做法对齐。**②-b 身份裁决阶段（当前 B，待 #20 R4 修法）**——`finish()`(app.js:651,658) / `identityAdjudicate`(probe.js:227) 当前帧集 UDS `22F19E`+`1A9B` / KWP `1A9B` 与原厂 4 帧及 `ident-registry.json` 的 `moduleIdent.request`（`22F1A2`×6 / `1A9F`×6）均不一致（多 `1A9B`、少 `22F1A2`/`3E00`/`1003`），属**阶段错位 + 帧集错误**；全段反汇编 `0x18b0c-0x1ac48` immed 常量只有 `#0x1409`/`#0x1102`、**零 F19E/F1A2/1A9B/1A9F** → 身份裁决帧不在 DriveLinksMode 探测/绑定层；`22F19E+1A9B` 经 `GAG_COMMAND.GAG.bin` 3139 条全量复核为**我方派生组合、431 侧无独立 2 帧序列**（UDS 模板池 `0x00200000-0x0020000A`；`1A9B` 命令 ID 在 KWP 识别 LID 段 `0x0000000A`/`0x000018A8`/`0x00100303`，与 `22F19E@0x00200002` 不相邻；绑定成功分支 `18fc0→18fc2→0x19578` 不发身份帧）。须按 R4 修法移除该组合、把身份读帧并入**阶段③ cat=0x60 序列**、判据源接 `ident-registry.json` 的 `request`/`identName`/`suffixHex`，修好后才做「期望帧 vs 实发帧 diff=空」复跑。③ **前置条件（两个前提并列）**：`provenance: 必须探针验证`、`bindUnresolved`、`unknown 保底` 从主链移除须以 **②-a 探针阶段 diff=空 且 ②-b R4 修法落地后 diff=空** 为前提；不得仅凭 `probe.js` 头部注释自承。`unknown` 不裁决仅作为「应答即绑」这一 431 做法的结果被接受，运行时哪个 ECU 应答属输入（§2）。④ **bug 收口（不随判据改写豁免）**：`120/120` 条须逐条给出「**代 → 该代完整 cat=0x10 地址表 → 候选探测**」的静态来源规则，`family_default_pairs` 错配归零；**3 候选组 28 个 = gen0x03 完整 3 条**（owner `0x0301`/`0x030e`/`0x030f`）、**13 候选组 2 个 = gen0x13 完整 13 条**（13<16，无 `[:16]` 截断）、**16 候选组 90 个跨 10 个代**（`0x0b/0x0c/0x0d/0x0e/0x0f/0x10/0x12/0x14/0x15/0x16`），各代完整 39/33/31/36/33/27/46/34/38/40 条均被 `[:16]` 截断为 16 条（其中**共享完全同一 16 候选的 40 个 sysId 全在 gen0x15(24)/0x16(16)**，其余 50 个分属 8 代、8 种候选签名）；`fam120` 分布 `{3:28,13:2,16:90}`。**不得**把「120/120 错配归零」误读为「120 条须各有唯一静态地址」。⑤ **静态身份判据链**（替代旧 12/92 口径）：按 VIN→装备识别码→变体→模块→`moduleIdent.request/identName/suffixHex` 全静态可复跑；163 个识别码在 `GAG_PORSCHE_SERVICE.GAG.bin ∪ DSN.BIN` 联合覆盖 **163/163**（GAG 单载体 104、余 **59/59** 在 DSN.BIN 明文命中），163/163 可链至变体再链至 `moduleIdent.request`；148 个变体名在 `*_ALLDATA.BIN ∪ DSN.BIN ∪ ACTHELPINFO.BIN` 覆盖 **148/148**；12 个模块三字段 **12/12** 齐备（`request` 分布 `1A9F`×6 / `22F1A2`×6）。`104/163` 与 `2/148` 为单载体数据源分工实测值，不是覆盖率、不作验收分母。⑥ **分母分列纪律**：`120/120`（分派规则）与 `163/163`（身份链联合覆盖）**分列两条独立断言、不得混算**；`527/402/185/40/148/12/163/125/74/111/120/3/13/16` 各自标源、互不替代（`74` 与 `185` 是同一帧序的两个统计口径，不是两个独立结论）。⑦ **禁止**以「包内不存在唯一表 / 需实车逐地址核验 / 参照系判错即免验收」结案（R-4 / U-3）。⑧ **R-5 分列**：②-a `取证等级=A`、`U-1 载体状态=待落盘（#20）`；②-b `取证等级=B`（与门禁落盘无关，待 R4 修法）。 |
| **HB-3** R4 身份裁决帧序（`app.js:651 finish()` 阶段错位 + 帧集错误） | `src/app.js:426/435` 注释「每候选 1 帧 / 每族 2–3 帧，原厂每候选只 1 帧」自相矛盾；`:647-658` 在**探针阶段** `tryAddr` 内调 `identityAdjudicate` 多发 `22F19E+1A9B` 两帧（各 800ms）；`src/probe.js:10/63/131` 注释自称身份裁决在「进模块后的真实读帧」。三套帧集互不相同：我方 `identityFramesFor`(probe.js:141)/`finish()` = UDS `22F19E`+`1A9B` / KWP `1A9B`；原厂 cat=0x60 进模块 4 帧（185/185）= `3E00→22F19E→22F1A2→1003`；`ident-registry.json` `moduleIdent.request` = `22F1A2`×6 / `1A9F`×6 | **须分两层判定**：**取证层（A，已收口）**——431 侧静态帧序逐字节挖尽且自洽：① **探针阶段**每候选 1 帧 `22 14 09`（`DriveLinksMode_1001@0x18f00` 逐指令：`0xFF001409` 候选循环、`cbz` n=0 跳过、`0x10000359` 链路绑定、`0xFF001102` 补帧；全段 `0x18b0c-0x1ac48` 零 F19E/F1A2/1A9B/1A9F 常量）；② 进模块后 cat=0x60 四帧（`sysdata-comm.json` 74/74、`oem-enter-frames.js` 185/185、GAG_COMMAND 命令 ID 段三方互证）。期望帧序列可由包内字节复算、diff 基准明确，**无取证缺口**。**实现层（当前 B，待 #20）**——我方 `finish()` 实发与期望序列 **diff ≠ 0**；须按 R4 修法（探针只保留「应答即绑」每候选 1 帧、删掉 `finish()` 额外 2 帧；身份裁决移到 `enterSystem` 后按 4 帧 + `ident-registry` 判据做 `identMatch`）实现，并由 `e2e-flow.mjs` / `verify-fullchain-audit.mjs` 逐帧断言后才收 A。**判据**：凡「**帧数差 = 0**」「**每候选 1 帧**」「**期望帧 vs 实发 diff=空**」一律加「**探针阶段**」限定语（把 2 帧身份帧计入则全链路帧数差 ≠ 0）；身份裁决阶段用 ②-b 单独表述。注释、帧数、调用位置三者统一，「进模块后」类注释与代码实际阶段不一致的行数 = 0。`74/74`、`185/185` 只证 L1/L2 自洽与我方期望基准正确，**不得**据此宣称 L3 运行时实发帧已对齐（§2 三层模型）。 |

### P1（应）

| ID | 需求 | 可证伪验收判据 |
|---|---|---|
| P1-1 | 证据索引机读化 | 全部 A 判定集中为统一格式 `<file>:<offset\|VA\|recordId>` + 复算命令；索引条目数 = 重判后总行数（含 41 行基线 + 新增行）；每条命令独立执行退出码 0；随机抽 5 条由第二人复算，结果一致数 = 5/5。 |
| P1-2 | 阴性扫描可复跑化（含 HB-1 历史阴性扫描样例） | 每条「包内静态零调用点 / 无表 / 无标签」结论附扫描脚本 + 范围清单；脚本可复跑、输出命中数与文档一致；每条阴性结论必须对应一个「下一载体」而非结案，结案数 = 0。**HB-1 的 7 条历史 R-3 阴性扫描**（已由阳性证据取代，留作通用防线样例）：29 个 `.so` BL/BLX+PLT+重定位 0 命中、9 个 GAG 库 589,725 条 key 0 命中、GAG_PORSCHE_SERVICE 41,744 条 body 平台/type 标记 0 命中、ALLDATA/flag 0 命中、drivelinks `sid∈{1,2,4}` 0 命中。 |
| P1-3 | 数字单一来源 | 全库 `.md` 中 `1070/1072/0/2/53/67/74/92/120/3817/479/597/805/1005/3350/527/402/185/40/148/12/163/125/67/79/687/13873/153/119657` 等数字行均可 grep 到来源命令；冲突行数 = 0。其中 **`92` 为需消除的历史值**（改为 120 或标注历史并附附录 A 复跑命令）、**`34` 为需消除的历史值**（改为 13873）、**`99.8872%` 须标为「归一前中间量」**（正式 Y/Y 为 `119657/119657`）。`67` 明确标注为 `menuId`（非 RID），`67/79/687` 不得读作同一命名空间。 |
| P1-4 | 门禁断言映射 | 每条 P0 判据至少对应一个 **`tools/verify-*`（.mjs / .py）** 断言（断言名 ↔ 需求 ID 可映射），缺失数 = 0；`npm test` 全绿、失败数 = 0。python 门禁若无法直接映射，可由 #20 加 `.mjs` 薄包装（`child_process.execSync` 转发 python 断言、以退出码/stdout 断言）。**门禁未落盘 → 三件套缺失数 ≠ 0 → T1/T4 不达成。** |
| P1-5 | 发版不变式 | `node tools/check-bundle.mjs` + `node tools/boot-smoke.mjs` 退出码 0；`www/app.bundle.js` 中禁用字样（沿用 `TAKEOVER §1` 铁律）grep 命中数 = 0；核心源码匿名化通过。 |

### P2（可）

| ID | 需求 | 可证伪验收判据 |
|---|---|---|
| P2-1 | 审计输出可视化 | 逐行 A 状态 + 证据坐标可跳转由审计命令输出直接生成，手工维护字段数 = 0。 |
| P2-2 | 历史文档标注自动化 | 被推翻文档顶部/行内标注由脚本生成；新增 `.md` 若无标注则命令报警，漏报数 = 0。 |
| P2-3 | 证据复算增量缓存 | 二次运行耗时 ≤ 首次的 50%（可测量），且输出 sha256 与首次相同。 |

---

## 4. 「完全复刻 431 全部功能字节级实现」功能清单边界（14 项）

> 统一判据（每项均适用）：**① app 存在可达 UI 入口；② 调用链 `src/app.js` → `src/coder.js`/`src/probe.js`/… → `elm.cmd` 发帧，以「文件:符号序列」给出；③ `e2e-flow.mjs`/`smoke-fixes.mjs` 有逐帧断言；④ 期望帧序列由 431 静态证据复算，diff = 空（**帧序类一律带「探针阶段」限定语**）；⑤ 该项下 `gen=null / apply=false / 无调用方 / unknown 保底 / 必须探针验证` 标记数 = 0。** 运行时真实可调用，不是死代码。P0-3 现状栏与 P0-8 待接通清单的 5 条按「当前 B / 待 #20 接进 app 后收 A」逐项收口。

| # | 功能 | 当前已知「未接通/不一致」风险（须逐项收口） | 431 静态证据最低要求 |
|---|---|---|---|
| F1 | 读 VIN | 主链/OBD 链字符集口径不一（D-4）；广播 `anyRx` 被标 B | `0x7DF/0x7E8`、`21 09 05`/`49 02`、模板链 8 帧、ISO3779、`0xFBE0FD00` |
| F2 | 车型年款 | 24 键 `vid` 非原厂返回值、归一化非 strcmp；年款三档 | `PorscheGetVehicleNameID@SYSP:0x24DE4` 表 `@0x5E42C`、TBB 17 槽、`@0x261a8` |
| F3 | 平台代际 | **HB-1 取证判 A（静态可解、代码未落地前不计 A）**，剩余为 #20 代码落地：9X6/9X7 规范 type（0x01/0x05）未写入、`gen=null`/`apply=false`、`tools/build-dsn-module-sysids.mjs:132-133` `runtimeModules` 留空、全局表回退 | `PorscheGetVehiclePlatform@SYSP:0x26344`（22 槽 TBB @0x2634E + 串池 @0x56CBD）、`GetVehicleForVin@READWRITE:0x147C80`（17 槽 TBB @0x147CD6）、`PorscheGetVehicleIDByManualSelect@SYSP:0x2A958`、`GAG_TEXT_CN.GAG.bin` 文本层、`DSN.BIN` 头 22 项、静态规范 type 规则 |
| F4 | 地址绑定与探针 | **HB-2**（N=120）120 条错配 / `[:16]` 截断（90 个 16 候选组）；**HB-3** 探针阶段多发 2 帧、身份裁决阶段当前 B；`22 11 02` 补帧；6 对孪生；`noCand` | `bind-plan` 全量候选、`DriveLinksMode_1001@0x18F00/0x18f8c/0x18FE2`、cat=0x10 地址表（527 条）、185/185 统一 4 帧 |
| F5 | 进模块会话与帧序 | 68 老代 KWP sessionless sysId **已按包内证据收口：原厂不建 UDS 会话**（117 条原厂进模块序列 `10xx` 命中 0）；旧「会话被标 B / D-1 服务专属会话 `1040/1085/1003`」为误判、实现层误发待 #20 订正；flag=0 处理 | `src/oem-enter-frames.js` 的 `OEM_SESSIONLESS_SYSIDS_SET`（68 键 / 117 序列，`10xx` 命中 0）、`0x0101` = `81`+`1A9A`、`JOB.BIN` 12 个 DBUSER 无老代平台、`GAG_COMMAND.GAG.bin` 命令 ID 段归属新代、`src/oem-session-table.js` 805 sysId |
| F6 | 变体识别 | `identMatch` 注释与调用阶段不一致 | JOB.BIN memcmp、1A84/87/91/92/94 件号分词、平台限定 |
| F7 | 编码读 | 回帧 ID 校验口径主链/广播链不一 | `21/22/1A` 构造、`SysTemReadData@0x0F830D`、正响应 SID+0x40 |
| F8 | 编码写 | 写结果由 ECU 裁决被标 B；地址态闸默认关；7F78 重发隐患；三处裸 `uds` | 写闸门 3817/3817、13 项写帧判定、`SysTemWriteData@0x0F855D`、withWriteLock |
| F9 | seed-key | `needsKey:false` 生产不可达；0x1D `seed+state`；双入口口径 | 29 mode + 24 变体、wordvm 9×288 点、`libPORSCHE_FILE.so:0x18A74`、1070 条记录 |
| F10 | 恢复备份 | `runWritePrologue` 无调用方；`_restore` 裸 `uds`；无读服务不写 | 备份链、sessionless 标志、`McrCodeChileWrite` |
| F11 | 批量序列 | 含写命令功能序列的写锁覆盖；489 条功能序列无 map 引用（P0-8 待接通） | 功能序列帧序、diagProfile 5 处一致 |
| F12 | 编程页 | 写类操作写锁覆盖、浏览态 `coding-v2` 口径（D-3）、500 自创上限 | 编程页帧序、`MENU.BIN` u16 真实条目数（500 为 0 命中） |
| F13 | 例程与特殊功能 | **D-2** 同 RID 命名空间 X/X（旧「交集仅 1」指标作废）；`noRid` 16 条；routines/special-functions 零 fetch（P0-8 待接通） | `GAG_COMMAND.GAG.bin` 字节坐标（3139 / `0x256` / 236 条 `0x31`）、语义映射表 X/X、功能序列 |
| F14 | 数据流测量 | `measure/io/actuator` 等服务在 68 个 sessionless sysId 上**不建 UDS 会话**（D-1 已订正；旧「sessionless 上发 `1040/1085/1003`」为实现层误发、当前 B 待 #20 修）；`measure.json` 1719→480 可点击、27 个顶层 json 不被 fetch（P0-8 待接通） | `PORSCHE_SYS_DATA.BIN` comm 117 条原厂序列 `10xx` 命中 0、`0x0101` = `81`+`1A9A`、`JOB.BIN` 12 个 DBUSER 无老代平台、`GAG_COMMAND.GAG.bin` 的 `1040`×87/`1003`×9/`1085`×1 属新代命令段、老代 27 个 impls 首帧全为 `22/31/27/21/14/1A`、measure 帧序 |

---

## 5. 文档一致性验收判据

| ID | 判据 |
|---|---|
| **U-1 标 A 三件套（按 R-5 分列两字段）** | 文档任一「A」行必须同时具备：`src/` 代码路径、`tools/verify-*` 门禁断言名、431 证据坐标。**每行分列**：① `取证等级`（独立复跑命令判定，不依赖门禁是否落盘）；② `U-1 载体状态`（三件套是否齐备）。脚本遍历全部行，缺任一项的行数 = 0。**「门禁待落盘」是载体状态、非证据降级**，不得把已复跑的取证 A 压成 B；但**三件套缺失数 ≠ 0 → T1/T4 不达成、不得宣称「全部收口」**。重点核查 `GAP-INVENTORY §2:50`、`§2:54` 两处高估，`ACCEPTANCE-MATRIX §3 #5`「共享子集收 A」、`B-TO-A §2` 8 项「已落地」。两个待落盘门禁（§7）在落盘并接入 `scripts.test` 前，对应行 `U-1 载体状态` 记「待 #20」。 |
| **U-2 数字与实测一致** | 以 `npm test`、`npm run rebuild:all-models`、`node tools/coverage.mjs`、`node tools/verify-fullchain-audit.mjs`、`node tools/test-align431.mjs`、附录 A 的 `N=120` 复跑命令、以及 `tools/verify-d3-id-union.py` 输出为**唯一真值**，文档数字 diff = 0。已知冲突必须消除：1072↔1070、拒写 2↔0、门禁 53↔67↔74（任务口径 74）、**92↔120（92 历史值）**、**34↔13873（34 历史值）**、**99.8872%→119657/119657（前者为归一前中间量）**、`TAKEOVER §0/§3` 历史数字、`ACCEPTANCE-MATRIX §5「36+359+105+84+66」`、`B-TO-A §3.3` 旧「异文件引用」结论。**「与手工索引交集仅 1」由数字冲突项改为「口径修正项」**（命名空间混淆，指标无效）。**须消除 `92` 的具体位置**：`B-TO-A-CLOSURE-20261112.md §3.2`、`AUDIT-20261112.md §4 #3`、`TAKEOVER.md`（含 §0/§3 及顶部边界段）、`GAP-INVENTORY-20261112.md §2:54`、`RE-GAPVERIFY-20261112.md` 中相关旧表述。分母清单 `527/402/185/40/148/12/163/125/74/111/120/67/79/687/13873/153/119657/3/13/16` 各自标源、互不替代。 |
| **U-3 禁用结案词** | §0 所列 10 类词作为「结案理由」在全库 `.md` 中命中数 = 0（grep 可复跑）；作为「待挖线索」出现时必须同行附下一载体与扫描命令。 |
| **U-4 不得自我宣称** | 任何「已完全对齐 / 0 卡点 / 全部收口 / 全 A」结论句必须附审计命令输出哈希或退出码；无命令输出支撑的宣称句数 = 0。 |
| **U-5 历史快照标注** | 被推翻文档顶部 + 行内标注齐全，且标注所引用的「现行文档」数字亦通过 U-2；标注缺失数 = 0。 |
| **U-6 bug 与注释一致** | 「文档写 A、代码做 B / 注释写 A、时序做 B」逐项清零：`src/app.js:426/435/647-658` vs `src/probe.js:10/63/131`、`22 11 02` 三处注释、`bind-plan rule`、过时数字 `334/980` `342/980`、旧「HB-3 静态时序成立」含糊措辞（按分层裁决撤回）、旧「老代 KWP 服务专属会话 `1040/1085/1003`」结论（按 D-1 包内证据订正）；`tools/verify-fullchain-audit.mjs:117` 的 `ok("enterSessionFor('routine') 不被误跳过（服务专属会话保留）", frames(m3).includes('1040'))` 是把错误行为固化成断言，**已裁定解禁并改为「sessionless 上不发任何 `10xx` 帧」的行为断言——该断言已按包内证据订正、非放宽标准**（供 #21 QA 复核）；注释与实际帧序/阶段不一致的行数 = 0。 |
| **U-7 清理范围（Q4 裁定）** | 文档一致性清理范围 = **所有出现 U-2 冲突数字的文档 + 本轮 6 份基线文档**；不必逐字清洗约 60 份历史文件。但**被推翻的结论必须有顶部指向**（指向现行定论/本 PRD/复跑命令），顶部指向缺失数 = 0。 |

---

## 6. 已裁定事项（原待确认 Q1–Q4，主理人 2026-11-13 裁定，不再询问用户）

> **不列「是否需要实车测试」**：用户已断言 431 可离线完成全链路，此为不可协商前提，不作为待确认项。以下 4 项已由主理人按权限直接裁定，架构师按裁定执行即可。

| # | 原问题 | 裁定结果（已生效） |
|---|---|---|
| Q1 | 重判挖出新项后，清点表固定 41 行合并还是扩表？ | **扩表 + 保留 41 行基线编号**。新项（92→120 差额、9X6/9X7 新增 type 规则、`noRid` 静态载体等）作为**新增行追加**，禁止删行或合并行造成「全 A」假象。落地判据见 P0-1。 |
| Q2 | 「431 支持车型/功能全集」以哪个包内载体为权威清单？ | **不人工指定单一权威载体**；以 `DSN.BIN` 头 22 项 / `ALLDATA` 目录 / `PORSCHE_SYS_DATA.BIN` 根表 / `COMMAND.GAG` 的**并集**为「包内可枚举集合」，判定式为「app 可枚举集合 = 包内可枚举集合，差集 = 0」。落地判据见 P0-3。 |
| Q3 | 6 对孪生若挖出 431 侧左右静态规则，UI 文案是否随动？ | **随动**：UI 左右命名改为与 431 文本表一致，文案同步修改（含发版文案与匿名化检查，见 P1-5）。落地判据见 P0-3。 |
| Q4 | 文档一致性清理范围？ | **所有出现 U-2 冲突数字的文档 + 本轮 6 份基线文档**；不必逐字清洗约 60 份历史文件，但被推翻结论要有顶部指向。落地判据见 U-7。 |

---

## 7. 「重新审计」循环与终止条件（绑定可复跑命令，不允许自宣达成）

**循环体（挖证据 → 收口 → 审计 → 再挖）**：
1. 运行审计命令 → 对输出的**每一条非 A 行**生成「下一载体清单 + R-3 扫描命令」；
2. 用静态证据收口（改代码/数据/文档），每条补齐 R-1 两坐标 + R-2 逐字节 diff + 门禁断言；
3. 重跑命令集（见下）；
4. 若仍有非 A 行 → 回到 1，**禁止以「包内不存在 / 需实车 / 运行时态 / 431 同界」结案**，必须换载体继续挖。

**终止条件（全部同时满足，由命令输出证明，非文档宣称）**：

| ID | 条件 |
|---|---|
| T1 | `npm run audit:align431`（或架构师指定等价命令）**退出码 0**；输出逐行全 A（含 41 行基线 + 新增行），非 A 行数 = 0；U-3 禁用结案词命中 = 0。 |
| T2 | 间隔一次 `npm run rebuild:all-models` 数据重建后，**连续两次独立运行输出 sha256 相同**（确定性）。 |
| T3 | `npm test` 全绿、失败数 = 0；每条 P0 判据 ↔ `tools/verify-*`（.mjs/.py）断言映射 diff = 0（P1-4）。 |
| T4 | U-1 标 A 三件套缺失 = 0、U-2 数字 diff = 0（含 `92`、`34` 全部消除与 `99.8872%` 标注）、U-5 标注缺失 = 0、U-6 注释/时序不一致 = 0、U-7 顶部指向缺失 = 0。**门禁未落盘 → 三件套缺失数 ≠ 0 → T1/T4 不达成、不得宣称「全部收口」**。 |
| T5 | HB-1 / HB-2 / HB-3 专项断言通过：**HB-1** 静态规范 type（9X6=0x01、9X7=0x05）+ 由仓库内生成器复跑的 9X6 29/29 + 9X7 41/41 `(module,type,fullSysId)` 映射表 + 静态等价集标注 + `runtimeModules` 留空 = 0 + 10 条 `HB1-T5-01..10` 断言全 PASS；**HB-2** 120/120 静态分派规则可复跑 + **探针阶段**期望/实发帧 diff=空（②-a）+ ②-b 身份裁决阶段 R4 修法后 diff=空 + 185/185 + `402/402`（限 `tx∈0x700–0x77F`，全表 402/527）+ 163/163 身份链 + 120 条错配归零；**HB-3** **探针阶段**每候选 1 帧且帧数差 = 0、身份裁决阶段 R4 修法后帧集/时序与 431 一致。 |
| T6 | F1–F14 逐项「UI 入口 → 调用链 → 实发帧」断言通过，死代码/未接通标记数 = 0（含 P0-8 待接通清单 5 条）。 |

**明确不构成终止**：`npm test` 全绿、文档中写「全部收口」、任何 agent 的口头结论、单次运行输出、**单行取证 A**（R-5）。

**绑定的可复跑命令清单**（现有 + 需落地）：
- 现有：`npm test`、`npm run rebuild:all-models`、`node tools/coverage.mjs`、`node tools/verify-fullchain-audit.mjs`、`node tools/test-align431.mjs`、`node e2e-flow.mjs`、`node smoke-fixes.mjs`、`node tools/walkthrough.mjs`、`node tools/check-bundle.mjs`、`node tools/boot-smoke.mjs`。
- **需落地（P0-7）**：逐行 A/非 A 判定 + 证据坐标 + 数字实测 + 非 A 下一载体 + R-5 两字段的**确定性审计命令**；命名/落点由架构师定。
- **两个待落盘门禁（#20，当前均不在仓库、`package.json` 中亦无引用）**：`tools/verify-oem-probe-diff.mjs`（**9 条**断言：探针帧 diff、进模块 4 帧 diff、185/185、402/402 限定段、`[:16]` 移除、身份链 163/163 + 148/148 + 12/12、三类候选集来源、`tools/verify-d3-id-union.py` 之外的身份裁决阶段 diff〔标注待 #20 实现〕）与 `tools/verify-d3-id-union.py`（零 `/tmp` 依赖、`__file__` 相对定位只读 `data/`、退出码 0、`--verbose` 逐条输出 135 条及 chain 实体数、输出 sha256 满足 T2）。二者须追加进 `package.json` 的 `scripts.test`；落盘前判据中所有引用它们的断言标注「**门禁待落盘**」，对应行 `U-1 载体状态` 记「待 #20」。P1-4 措辞已放宽为 `tools/verify-*`（.mjs/.py），或由 #20 加 `.mjs` 薄包装。
- 证据复算命令格式示例（每条 A 行须可独立复算）：`python3 tools/disasm-elf.py <so> <VA>`、`llvm-objdump -d --triple=thumbv7a-none-eabi --start-address=<VA> --stop-address=<VA> <so>`、`tools/inventory-package.py`、`<BIN>:<offset>` dump、`<JSON>:<recordId>` 提取、`node -e` 只读 `src/`——判据统一为「由该命令复算出的期望字节序列 = 我方实发字节序列」。

---

## 8. 给架构师的分解提示（不代替编排）

建议按「**一条可证伪判据 = 一个可验收任务**」拆分：P0-1..P0-8、HB-1..HB-3、U-1..U-7、T1..T6、F1..F14 各自成任务。

- **HB-1**取证判 A（静态可解、文本层已闭合），但**代码未落地前不计 A**；剩余为 #20 代码落地：`tools/build-dsn-module-sysids.mjs:132-133` 的 `runtimeModules` + 规范 type 写入 + `tools/build-vin-type-table.mjs` + 10 条 `HB1-T5` 断言。
- **关键路径收敛为 HB-2 / HB-3 / P0-7**，其中 P0-7（审计命令）须先落地，否则 T1/T2 无法判定。**HB-2 验收形态已按取证从「唯一静态地址表」纠正为「静态分派规则 + 探针阶段逐字节 diff」**，权威 N=120 不变；`tools/export-bind-plan.py:147` 的 `[:16]` 错配与 120 条 `family_default_pairs` 错配作为实现 bug **单独收口，不得随判据改写豁免**。**HB-3** 原厂侧帧序已证、我方 `finish()` 帧集错位是实现 bug（当前 B），须 #20 按 R4 修法后才收 A。
- 两个 `tools/` 门禁属 #20 实现任务，PM 不写；门禁未落盘前 T1/T4 不达成。
- Q1–Q4 已裁定，不再作为阻塞项；`N=120` 为 HB-2 与 U-2 的权威分母，不得使用 92；分母清单各自标源。

---

## 附录 A：权威数字 N = 120 的复算与沿革

**权威定义（HEAD `50b720b` 实测）**：`bind-plan.json` 中 `provenance` 含 `commCat10-family-default` 的 sysId 数 = `stats.commFamilyDefault` = **120**，双源一致；`schemaVersion = 5`，sysId 总数 **597**。

**复跑命令**（在项目根执行，退出码 0，输出 `120 120`）：

```bash
node -e "const b=require('./data/bind-plan.json');console.log(Object.entries(b.ecu).filter(([k,v])=>JSON.stringify(v.provenance||[]).includes('commCat10-family-default')).length, b.stats.commFamilyDefault)"
```

**候选数分布复跑**（输出 `{"3":28,"13":2,"16":90}`，合计 120）：

```bash
node -e "const b=require('./data/bind-plan.json');const d={};for(const [k,v] of Object.entries(b.ecu)){if(JSON.stringify(v.provenance||[]).includes('commCat10-family-default')){const c=(v.pairs||v.candidates||[]).length;d[c]=(d[c]||0)+1;}}console.log(JSON.stringify(d));"
```

**沿革（主理人复算提供，可用 `git log --oneline -- data/bind-plan.json` 逐提交复算）**：
- `247cfb7` / `731fe1c` / `62e86cb` 时代：`92/92`（历史值）。
- `e79c033`（CS1/E1 接入、variant-sysids 重建）起：`120/120`。
- 根因：E1/CS1 与新增变体 sysId 加入后，family-default 补源条目增加。
- 因此 `GAP-INVENTORY §2:54`、`B-TO-A-CLOSURE §3.2`、`AUDIT-20261112 §4 #3`、`TAKEOVER` 等处的 `92` 均为历史快照，按 U-2 必须消除或标注历史并附本附录复跑命令。

**口径边界与分母清单**：`74 个 cat=0x60 固定模板` 与 `185 个 cat=0x60 block` 是**同一帧序的两个统计口径**（74 = fam120 子集里的 sysId 数、185 = 全表 block 数）；`111 条 commCat10Exact`、`402`（`tx∈0x700–0x77F` 段的 cat=0x10 地址对）、`527`（cat=0x10 subs 总数）、`40`（共享同一 16 候选的 sysId）、`148/12/163`（身份链）、`3/13/16`（候选分组）、`120`（family-default sysId）、`67/79/687`（menuId / 通信 RID / 功能序列）、`13873`（D-5 枚举值）、`153`（D-3 长度规则）、`119657`（D-3 itemIds）**各自标源、互不替代**；P0-7 审计命令输出中须分别标注来源，避免分母错配。
