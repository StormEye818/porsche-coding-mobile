# ACCEPTANCE-MATRIX-431 — 与原厂逐项对照验收矩阵

> ⚠️ **2026-11-12 第十阶段全量审计标注：本文是 2026-11-11 的历史快照，以下结论已被推翻。**
> - §3 #4「会话号已收口为固定 `0x89`（边界已证）／SYS_DATA 加密记录体静态不可导出」→ **错**。
>   SYS_DATA 解码副本可读，已导出逐 ECU 原厂会话（`src/oem-session-table.js`，805 sysId）
>   与逐帧进模块序列（`src/oem-enter-frames.js`，1005 序列 / 3350 帧）；981 是 32×`10 03` + 16×`10 89`，
>   68 个老代 sysId 原厂不建 UDS 会话。
> - §3 #5「9X6/9X7/CS1/E1 结构性不可证」→ **错**。`DSN.BIN` 头 22 项索引给出显式
>   平台→type 链接（`data/platform-type-map.json`）；CS1→0x13、E1→0x03 唯一，9X6/9X7 给出候选集。
> - 「写入仍只放开 981 DME」「解 SYS_DATA 容器加密后才可能数据驱动」→ **错**。写闸门已按
>   「逐帧对齐原厂主写模板」全量打开（`src/write-alignment.js`、`WRITE-GATE-OPEN-20261112.md`）。
> - §5 门禁数字 36/359/105/84/66 是当时快照；现行以 `npm test` 15 项门禁为准。
> **当前状态以 `TAKEOVER.md` + `WRITE-GATE-OPEN-20261112.md` + `AUDIT-20261112.md` 为准**；本文保留作取证记录。


> 2026-11-11 第二轮（按用户要求：偏离全部改成原厂行为、删除自创内容、文档↔代码收口）。
> 判定基准：`RE-CODINGADDR-20261010`/`RE-FLOWSPEC`/`RE-DISCOVERY`/`RE-MODELADDR` 的
> .so 逐指令（A）、BIN 字节（B）、实车日志（C）。行号基准：本轮改造后的最终磁盘。
> 复跑命令：`npm test`（含 `tools/verify-all-models.mjs` 79 条门禁）。

## 0. 一句话结论

> 🔴 **2026-11-11 第三轮复核：本矩阵的「无自创 / 全路径默认关闭 / 全绿」结论已废止。**
> 当前代码仍有 P0/P1 bug，UI/编程页与 SAFETY 也不一致；最新有效审计见
> [`CODE-AUDIT-FULLCHAIN-20261111.md §11`](./CODE-AUDIT-FULLCHAIN-20261111.md)。
> 本文件以下内容仅保留为第二轮改造时的历史快照，**不得再作为实车写入验收依据**。
> 当前实现请以 `HANDOFF.md` 顶部 2026-11-11 16:55 第五阶段记录为准；新增运行时安全回归为
> `node tools/verify-runtime-safety.mjs`（30/30），真车未证 profile 仍默认只读。

**历史快照（已被第三轮复核推翻）**：四阶段偏离项全部改成原厂做法；安全增强收敛为
`SAFETY` 开关（默认全关，见 §2）；仅剩 **1 项数据缺口**（OBD VIN 通道地址，见 §3）
与 1 项「原厂行为本身不可在 ELM 层完全复刻」的适配器差异（n=0 链路绑定，见 §3）。

---

## 1. 已对齐（默认路径，逐帧/逐判定）

| # | 环节 | 实现（文件:行） | 原厂证据 | 验证方式 |
|---|---|---|---|---|
| 1 | 读 VIN 主/备双请求 | `coder.js:readVehicleIdentity` `221102`→`221101`，仅主未得名才发备 | `PorscheReadVinAndGetVehicleID @SYSP:0x29fb8`（0xff001102/0xff001101） | 代码逐帧 + e2e 帧序断言 |
| 2 | VIN 模板链 8 帧序 | `coder.js` `1003,22F190,1A90,1A87,1A9B,2150,2151,1A9A`（KWP 去 0x22 段） | `PorscheReadVehicleVin @SYSP:0x2a4b4` 模板表 @0x56a66 | 代码 + `verify [H]` |
| 3 | 留存键固定长度取值 | `22F190/1A90`→17B VIN；`2151`→车名；其余 fire-and-forget | 同上（0x11 字节写 param_2、memclr8） | `verify [H]`（无 looksVin 自创层） |
| 4 | 读 VIN 不预建 10 89 | `autoSearch` 只 `coder.address()`（ATSP/ATSH/ATCRA），模板链首帧 `10 03` 建会话 | 原厂自动搜索是独立链 | `verify [H]` |
| 5 | 年款表三档基数 | `app.js:decodeVinYear(vin, modelId)`：`≤10&E..Y→+1971`、`≤10 其余→+2001`、`>10 字母→+2001`、`>10 数字→+2031`；无 modelId → null | `PorscheGetYearByModel @SYSP:0x261a8` 指令 0x261c8-0x261e4 | `smoke [year 三档]` 6 条 |
| 6 | 年款不参与车型分派 | `guessModelFromVin(vin)` 单参；年款只用于显示（`designationFrom`） | `RE-MODELADDR §1.4`：VIN[7]/[11] 定家族，年款不判 trim | 代码签名 + 注释收口 |
| 7 | VIN 分派 TBB 17 槽 | `app.js:guessModelFromVin`（V[7]/V[11]/V[6]） | `PorscheGetYearAndModel @0x22ad4` TBB @0x22b08 | `smoke` 981/718 断言 |
| 8 | 车型码收窄 | `series=(c6+c7+c11)` 过滤 `ID_MODELS[id]`，死代码 cross 已删 | 三处 ldrb 指令实锤 | `verify [H]`（死代码已删） |
| 9 | 显示串全等 | `variant.js:pickModelByName` 去括号基名 **全等**（不再 includes） | `RE-MODELID`：24 键语言表 strcmp | `verify [H]` + e2e「14款 Cayman」 |
| 10 | 件号分词 | `coder.js` 1A84/87/94 按 0x20 分词取单词 token 入 `lastPartNo` | `checkPartNumber @ACTF:0x4e00c` 分词全等 | 代码 + e2e 件号断言 |
| 11 | 平台限定 | `pickFamilyByEvidence` 传 `platform: platformForModel(currentModel)` | `RE-VARIANT`：变体/算法必须平台限定 | `verify [H]` |
| 12 | n=0 不探测 | `app.js:probeAddressFor`：ATSH/ATCRA 回执 OK → 直接 bound（0 探针帧） | `DriveLinksMode_1001 @LINK:0x18f00` `cbz r1` 分支 + `send(0x10000359,A,2)` | `verify [H]` + 代码逐帧 |
| 13 | n>0 每候选 1 帧 | `probeChainFor`：kwp `['1A9F']`、uds/未证 `['221409']` | 同上 `0x18f8c blx r3`（每候选 1 帧 mode=1） | `smoke [族探针链]` + `verify [H]` |
| 14 | 回帧 ID 校验 | `coder.uds` 对回帧 ID 与 `rx` 硬比对（mock 跳过） | 原厂 FilterId/SetAddress 只收该 ECU 帧 | `verify [H]` + e2e |
| 15 | 删除 alias 回退 | `app.js` 已删 `aliasEntryFor` 与调用 | 原厂无 alias 语义（RE-DISCOVERY §3） | `verify [H]` |
| 16 | 删除模糊键查找 | `familyFor` 只做精确键（SYSTEM/MODULE_TO_ECUID） | 原厂族由记录 SID 派生 | `verify [H]` |
| 17 | 删除低字节跨代平移 | `sysIdForLabel` 非 981 返回 null；`planSysIdFor` 只按模块名精确查 | 原厂无「家族低字节平移」 | `verify [H]` |
| 18 | 识别串原语 | `identTextMatch` 走 `identMatch`（strcmp/前缀≥4/strstr≥4，短键只全等） | `GetSubSysDataAddr @FILE:0x15c18` | `smoke [5b]` 5 条 |
| 19 | 会话流 | KWP `10 89` 直建；UDS `10 03→3E00→识别→10 89` | `RE-FLOWSPEC §1.3/§7` + GAG 3139 条 | e2e 帧序断言 |
| 20 | 读帧构造 | `21 <LID8>` / `22 <DID16be>` / `1A <LID8>`，正响应 SID+0x40 校验 | `SysTemReadData @READWRITE:0x0F830D` | e2e 逐帧 |
| 21 | 写帧构造 | `3B <LID8> <data>` / `2E <DID16be> <data>`，位宽随写 SID | `SysTemWriteData @READWRITE:0x0F855D` | e2e + `verify [G]` |
| 22 | 写序列 | 会话 → 备份读 → 安全访问 → 单项写 → 回读（**不重跑识别链**） | `RE-FLOWSPEC §4.0/§4.1` | 行为验证帧序 `1089→3E00→2101→170000→3B…→2101` |
| 23 | 回读不一致 = 记录失败 | 默认抛「记录失败，不自动回滚」 | `RE-FLOWSPEC §4.7` | `verify [H]` |
| 24 | 无读服务不写 | `restoreCoding` 无 readSid 跳过并计失败 | `McrCodeChileWrite` 读失败即中止 | `verify [H]` |
| 25 | 服务集闸 | `READ_SIDS=[21,22,1A]`、`WRITE_SIDS=[3B,2E]` | 原厂读写包装只打包这些 SID | `verify [G]` + e2e |
| 26 | seed/key 帧 | UDS `27 09 0100` / `27 0A`；KWP `17 00 00` / `17 40` | GAG rec#2/#949/#950、SPECF rodata | e2e 帧序 |
| 27 | 7F 78 续等 | `pendingWait` 原帧重发、其余 NRC 单发上浮 | `Set7F78Ctrl @COMM:0x039511` | e2e「7F 78 续等」 |
| 28 | 写入二次确认 | `doWrite` confirm「警告:请再次确认是否需要编此编码」 | TEXT_CN 语言库原文 | 代码 + walkthrough |

## 2. 有意偏离（安全增强，`src/schema.js:SAFETY` 默认全关）

> 这些是**本项目为防写坏车加的保护**，原厂没有。默认 `false` 时运行时不生效，
> 逐帧/逐判定与原厂一致；需要时显式 `setSafety({...})` 开启。
> 默认行为已由 `verify-all-models [H]` 断言（SAFETY 默认全关 + 各闸门 opt-in 写法）。

| 开关 | 行为 | 默认 | 原厂行为 | 开启方式 |
|---|---|---|---|---|
| `range` | 值域门禁 `fieldInRange`（UI+API 双拦） | **关** | 无值域门禁（`RE-FLOWSPEC §4.0`） | `setSafety({range:true})` |
| `level` | `level/WRITE_ENABLED` 严格门禁（要求 write-confirmed） | **关** | 无 level 门禁 | `setSafety({level:true})` + `WRITE_ENABLED=false` |
| `addrState` | 地址态拒写（未知/未核验态拒绝） | **关** | 无地址态闸门 | `setSafety({addrState:true})` |
| `autoRestore` | 回读不一致自动写回备份 | **关** | 只记录失败，不回滚 | `setSafety({autoRestore:true})` |
| `span` | 变更字节越界检查（变更必须落在字段区间） | **关** | 无此检查 | `setSafety({span:true})` |

> UI 层的输入校验（`renderParamDetail`/`showParam` 的 `fieldInRange` 提示）**保留**：
> 它只影响按钮可用性，不发帧、不改变协议行为，不属于「写入门禁」。

### 2.1 执行器目录禁驱动（**默认生效**，本项目策略，非 431 行为）

> 与上表 `SAFETY` 开关不同：这里的拦截**默认开启**，且已下沉到执行层
> （`src/routine-gate.js` + `src/coder.js:2075 assertDrivableRoutine()`），
> 绕过 DOM 的 `disabled` 也不会发帧；stop(0x02)/查结果(0x03) 显式放行，
> 否则已启动的例程无法停止。
> **来源例外**：原厂功能序列整条回放时显式带 `oemSequence:true`（`app.js:4514`），
> 逐字节回放不受本闸约束——那种调用没有猜参数，命令形态由原厂序列定型；
> 687 条序列 / 8047 个 31 帧零拒绝。菜单 / `execRoutine` / `.actRun` 不带该标记，
> 空参触发禁用 RID 仍 4/4 红且 `txLog` 为空（反向断言 `unmarkedAllowed=0`）。
> **这不是从 431 抄来的行为**：至少 24 条有 ① 级证据表明 431 会发。
> 按 PRD 铁律，本节只记录当前状态与下一载体，**不得作为结案理由**。

| 桶 | 条数 | 当前策略 | 431 侧证据（分级） | 补证方向（可复跑） |
|---|---|---|---|---|
| 无 31 模板 | 94（92 纯 + 2 兼地址歧义） | `driveDisabled=true`；UI/菜单/execRoutine 拦，原厂序列回放按来源例外放行 | ①：GAG 3139 条 / SEQ 687 功能 / 主模板表均 0 命中；②：由表内缺席外推「431 不发」；③：431 UI 是「不提供 / 发空参 / 手填」——静态资料不足以判定。反例候选 `0x051A`：第三张表有 `sub=01 params='06 40 01 F4 00 00 00'` 孤证（②级），当前仍拒 | 找第二源交叉印证；`grep -n '051A' data/*.json` |
| 参数多候选 | 39 | 非序列路径拒；`params` 留空，候选只在 `paramsCandidates`；原厂序列回放逐字节放行 | ①：39/39 在 SEQ 同一 `(sub,rid)` 有 ≥2 种载荷，其中 24 条另有 4 字节空参变体；431 把多载荷**写死在同一功能序列里顺序跑完**（`ICM_Set_Total_Mileage`），不是按上下文选一个 | 把功能级多载荷序列接进 app；`grep -n 'ICM_Set_Total_Mileage' data/function-sequences.json` |
| 模块内地址歧义 | 7（5 纯 + 2 兼无模板） | 按钮灰 + 执行层拦 | ①：BIN 同模块同 group0 并列两条同名记录，11B 块无禁用位，`driveDisabled` 是我方字段；②：`ECU-ADDRESSING-20261019.md:110` 把「复刻探测」标为「对齐 431」 | 探测细化到非模块粒度 / 逆 `DAT_0017df17`、`DAT_00182af0` 报文格式 |
| 记录布局冲突 | 8 | **不是拒绝**：4 条灰是因为「无 31 模板」，另 4 条按 11B 规范值照发；27B 值只进 `rawLayoutCandidates` | ①：27B 的 `+6` 值实测为 5–103、7/8 出现次数 30；②：语义推断为索引而非地址 | 解 27B 尾部重复字段语义；`grep -n 'layoutConflictItems' data/actuator.json` |

**对账**：`138 = 94 + 39 + 5`；`133 = 94 + 39`（只数 0x31；5 条 0x2F 无参数概念）。
**覆盖**：138/2506 = 5.51%；卡片全部列出、按钮置灰、hover 显示数据给的理由，不是「找不到功能」。
**已知数据质量项**：`0x051A` 的 `driveDisabledReason`（原句主张两张主模板表都没有该 `(sub,rid)` 的 31 模板、原厂记录也未出现）与 `data/routine-templates.json` 里实际存在的 `sub=01` 模板不符；正确表述应为「两张主模板表均无命中；第三张表有一条但无第二源交叉印证」。仍保持禁用（单表孤证），文案待下一笔修正。

## 3. 未对齐 / 数据缺口（如实列出，不猜）

| # | 项 | 状态 | 原因 | 影响 | 补证方向 |
|---|---|---|---|---|---|
| 1 | OBD VIN 通道 `21 09 05` / `21 09 01` | **历史结论，已推翻（0xFBE0FD00→0x7DF/0x7E8）** | 2026-11-11 复核：`open_readVinByObd()` 零参数、走 VCI「一对多」发送；APK/.so/资源三层均无目的 CAN ID（`libReadOBDVIN` 自身用 `09 02`） | 已实现 `Coder.readVinByObd()`：标准 OBD 功能地址 `0x7DF` 广播 + 只认 `61 09 05`/`49 02` + 17 位 VIN，失败不扫描 | 盒子固件或总线抓包（包内已到边界，见 `RE-CLOSURE §2`） |
| 2 | n=0 链路层绑定 | **能力差异** | 原厂 `send(0x10000359,A,2)` 是 VCI 链路层绑定；ELM 的等价物是 ATSH/ATCRA（已回执断言） | 已用 ATSH/ATCRA 回执 OK 作为绑定成功判据，帧数=0 与原厂一致；「绑定」语义在适配器层而非 ECU 层 | 无（适配器架构决定） |
| 3 | 24 键车型名表 | **已收口（注：vid 非原厂返回值，匹配含归一化，见 AUDIT-20261112.md）** | 逆出 `PorscheGetVehicleNameID @SYSP:0x24DE4` → 表 `0x5E42C`：24 条 **车型名 + vehicleId**，`strcmp` 全等（不是语言表） | 已落地 `src/model-name-table.js`，`pickModelByName` 白名单全等优先、基名兜底 | 无需补证；文本随语言库变化时按模块文本表复导 |
| 4 | 会话号数据驱动 | **历史结论，已推翻：逐 ECU 证据会话（见文件头）** | 会话类别字节在 `PORSCHE_SYS_DATA.BIN` 的**加密记录体**里，静态不可导出；`securityModel param_1` 实为 **seed 族**，不是会话号（2026-11-11 纠正） | 固定 `0x89` 与抓包主模板一致；其它服务类型由 `SESSION_FOR_SERVICE` 选择；写入仍只放开 981 DME | 解 SYS_DATA 容器加密后才可能数据驱动 |
| 5 | 9X6/9X7/CS1/E1 平台 sysId | **历史结论，已推翻：DSN 22 项索引（见文件头）；§3.5 再收窄（RE-GAPVERIFY §1）** | 同名子系统在**每一代** comm 子表都注册 → 名字 join 天然一对多；ALLDATA 目录无代际字节；name-9 投票对已知平台即失效 | 低字节 100% 静态（DSN 模块表 29/41）；高字节=运行时 BV 域（`GetSysIdFromBv` 入参）。**共享子集收 A**（9X6 0x03 同记录+0x26/0x29 仅 echo 共 3/10；9X7 0x05↔0x06 7 条同记录含 DME+12 条仅 echo 共 19/30）——任选高字节不改通讯参数，数据级无害；**真差异子集标 B**（9X6 7 条 0x01/02/04/07/08/12/16、9X7 0x05↔0x06 11 条、0x04 参与 20/20 全异）=**运行时 BV 域语义边界**（GetSysIdFromBv 运行时入参，431 同界，非待办） | 共享子集已收 A；真差异子集无需补办（431 同界）；剩余可锤方向=逆 BV 域调用方 `blx rN` 分发注册表 / 实车 VIN 日志（记档不挂账） |

## 4. 本轮改造清单（代码级）

| 文件 | 改动 | 对应偏离项 |
|---|---|---|
| `src/coder.js` | `readVehicleIdentity` 去自创形态层 + 留存键固定长度；1A84/87/94 件号分词；`uds` 回帧 ID 硬校验；`applyChange` 写序列 skipIdent + 值域/越界/回滚 opt-in；头注释重写（去掉「SID 必须成对」旧叙述） | §2.1①③、§3.1③、§4.2⑨、§5.2①②③ |
| `src/app.js` | `autoSearch` 去预建会话 + 去 ISO 正则；`decodeVinYear` 三档 + modelId；`guessModelFromVin` 去 year/死代码；`familyFor` 去模糊键；`identTextMatch` 用 identMatch；删 `aliasEntryFor`；`probeChainFor` 单帧；n=0 零探针；`addrSafeForAction`/`fieldInRange` opt-in；`restoreCoding` 无读服务拒写；`sysIdForLabel` 去低字节平移；会话/地址态注释收口 | §2.1②③、§3.1①②④⑥、§4.1①②、§4.2④⑥⑧、§5.2④⑤ |
| `src/schema.js` | 新增 `SAFETY` 开关（默认全关）+ `setSafety`；`canWrite` 保留原厂服务集/ LID 闸；删除旧 `WRITE_ENABLED` 政策注释 | §5.2① |
| `src/probe.js` | 删 `probeDecision`（零调用旧模型）；头注释改为「发现阶段只看回帧存活、身份由读帧裁决」 | §4.2⑤ |
| `src/variant.js` | `pickModelByName` 基名全等（不再 includes） | §3.1② |
| `src/mock-adapter.js` | 加 `mock=true`（回帧 ID 校验在 mock 上跳过） | §4.2⑨ |
| `tools/build-model-sysid-map.mjs` | 删 `platformSysIdByLowByte`；`planSysIdFor` 只按模块名精确查 + 981 标签基值 | §4.2⑧ |
| `tools/verify-all-models.mjs` | 新增 [H] 19 条改造回归断言（共 66 条门禁） | 全部 |
| `smoke-fixes.mjs` / `e2e-flow.mjs` | 年款三档/族链单帧/去 probeDecision/年款调用顺序同步 | — |

## 5. 验收结果

| 项 | 结果 |
|---|---|
| `npm test` | **全绿**：36 + 359 + 105 + 84 + 66，0 失败 |
| `node --check` 全量 | 通过 |
| 写序列行为验证（mock） | `1089 → 3E00 → 2101(备份) → 170000(安全) → 3B0109000000(写) → 2101(回读)`，**无识别链** |
| 越界写入默认行为 | 不拦截（原厂语义），写入成功 |
| 回读不一致默认行为 | 抛「记录失败，不自动回滚」 |
| 源码第三方工具字样 | 无（`[H]` 断言） |
| 981 回归 | 44/48 静态解出、DME 0x7E0、PASM 含 0x7D0、IC≠PSM 全部保持 |
| 全车型回归 | 566 sysId / 351/601 静态候选保持 |

## 6. 如何开启安全增强（示例）

```js
import { setSafety } from './src/schema.js';
setSafety({ range: true, addrState: true, autoRestore: true, span: true });
// 严格模式（要求 write-confirmed）：
// import { setSafety, WRITE_ENABLED } from ...（WRITE_ENABLED 为常量，需改代码为 false）
setSafety({ level: true });
```

> 开启后行为与「已对齐」路径不同，**不再计入原厂 1:1 验收**；
> 测试中如需验证保护逻辑，请显式开启并在断言名里注明「安全增强」。
