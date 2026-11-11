# ACCEPTANCE-MATRIX-431 — 与原厂逐项对照验收矩阵

> 2026-11-11 第二轮（按用户要求：偏离全部改成原厂行为、删除自创内容、文档↔代码收口）。
> 判定基准：`RE-CODINGADDR-20261010`/`RE-FLOWSPEC`/`RE-DISCOVERY`/`RE-MODELADDR` 的
> .so 逐指令（A）、BIN 字节（B）、实车日志（C）。行号基准：本轮改造后的最终磁盘。
> 复跑命令：`npm test`（含 `tools/verify-all-models.mjs` 66 条门禁）。

## 0. 一句话结论

> 🔴 **2026-11-11 第三轮复核：本矩阵的「无自创 / 全路径默认关闭 / 全绿」结论已废止。**
> 当前代码仍有 P0/P1 bug，UI/编程页与 SAFETY 也不一致；最新有效审计见
> [`CODE-AUDIT-FULLCHAIN-20261111.md §11`](./CODE-AUDIT-FULLCHAIN-20261111.md)。
> 本文件以下内容仅保留为第二轮改造时的历史快照，**不得再作为实车写入验收依据**。
> 当前实现请以 `HANDOFF.md` 顶部 2026-11-11 16:55 第五阶段记录为准；新增运行时安全回归为
> `node tools/verify-runtime-safety.mjs`（11/11），真车未证 profile 仍默认只读。

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

## 3. 未对齐 / 数据缺口（如实列出，不猜）

| # | 项 | 状态 | 原因 | 影响 | 补证方向 |
|---|---|---|---|---|---|
| 1 | OBD VIN 通道 `21 09 05` / `21 09 01` | **未实现** | smali `DiagnoseService.open_readVinByObd` 给出请求字节，但**未给出寻址地址**；包内无 smali 反编译产物，0x7DF/0x7E0 属猜测 | 仅走 Porsche 模板链（`22 11 02` + `1A90/22F190`），OBD 通道缺失 | 反编译 APK 的 `DiagnoseService` 取 ATSH/SetAddress 实参 |
| 2 | n=0 链路层绑定 | **能力差异** | 原厂 `send(0x10000359,A,2)` 是 VCI 链路层绑定；ELM 的等价物是 ATSH/ATCRA（已回执断言） | 已用 ATSH/ATCRA 回执 OK 作为绑定成功判据，帧数=0 与原厂一致；「绑定」语义在适配器层而非 ECU 层 | 无（适配器架构决定） |
| 3 | 24 键语言表（显示文本） | **数据缺口** | `SYSP:0x5E42C` 24 条 key→文本未从包内导出（运行时文本库） | 显示串用「车型目录基名全等」作为可观测等价；未命中走多候选确认（不猜） | 提取 GAG_TEXT_CN 或运行时文本库 |
| 4 | 会话号数据驱动 | **已收口为固定 0x89** | ODX SESSIONS 不在提取包；`securityModel param_1` 语义未证 | 固定 `0x89`（抓包 10 89×6 主模板）与原厂主路径一致；其它会话号模板（10 40/85/03）由 `SESSION_FOR_SERVICE` 按服务类型选择 | 提取 ODX SESSIONS 后可数据驱动 |
| 5 | 9X6/9X7/CS1/E1 平台 sysId | **未定案** | 精确交集零命中/平票（`RE-ALLMODELS §3`） | 这些车型保持全局表/枚举兜底，不做平台专属映射 | 老平台通讯表补证 |

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
