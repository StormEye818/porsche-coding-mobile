# CODE-AUDIT-FULLCHAIN-20261111 — 全链路代码级 431 对齐审计

> 审计对象：`/Users/se818/porsche-coder` 当前工作树（含本轮 P0 修复）。
> 审计范围：**①读 VIN → ②定具体年款/车型 → ③进模块 → ④读写编码** 全链路，
> 逐代码行核对「发了什么帧 / 怎么解析 / 输出什么」，并与 431 包内证据（.so 逐指令、
> BIN 字节、实车日志、已有 RE 文档）逐项对照；附全量代码审查（设计偏离 + bug）。
> 方法：4 路并行代码/证据调研 + 主审逐行复核 + `node --check` 全量语法 + `npm test` 回归。
> **行号基准**：本轮修复后的最终磁盘；子代理快照因插入 4–7 行注释存在 ±偏移，
> 关键行号已在写入前重新定位。零上车实验，结论均为离线可复核证据。

---

## 0. 总结论（先回答用户的问题）

> ⚠️ **历史结论警示（2026-11-11 第三轮独立复核）**：§10 及 `ACCEPTANCE-MATRIX-431.md`
> 所称「默认路径自创行为 = 0 / 文档已收口 / 全绿」经本轮复验**不成立，已废止**。
> 最新结论见本文件 **§11**：当前仍有可复现 P0、P1 bug 和多项未逆/未收口项；
> 分开执行的测试主体通过不等于 `npm test` 可复现通过，也不等于真车链路正确。

**不是「完全和 431 对齐」。** 分环节判定：

| 环节 | 对齐度 | 一句话结论 |
|---|---|---|
| ① 读 VIN | **部分对齐** | 主/备 `22 11 02/22 11 01` 与模板表 8 帧序有逐指令证据；但 **OBD VIN 通道 `21 09 05` 完全没实现**、请求固定打连接自检地址（0x7E0/0x7E8）、`enterSession` 先行导致会话/识别帧重复多发，另有自创防御层（已如实标注） |
| ② 定年款/车型 | **部分对齐** | `PorscheGetYearAndModel` TBB 17 槽分派 1:1 转写；但 **431 年款表三档基数（1971/2001/2031）我方只实现一档**、`year` 参数从未参与裁决、显示串用的**子串匹配而非 24 键 strcmp 全等**、`pickFamilyByEvidence` 漏传平台导致跨平台误选 |
| ③ 进模块 | **主干对齐、细节多处偏离** | 表A/路由表/bind-plan 数据源与会话流主干有据；但 **n=0 我方发 3E00/firstRead/族链（431 是链路层 0 帧直绑）**、probe.js 严格判定层在主链路被旁路、会话字只进日志、`AT` 回执/回帧 ID 校验未覆盖业务读写链、多处近似 join |
| ④ 读写 | **帧构造/解析 1:1，写策略自创** | `21/22/1A` 读帧、`3B/2E` 写帧、ISO-TP 重组、7F78 续等、seed/key 族分派对齐；但 **值域/level/服务集闸门、回读不一致自动回滚、每次写重跑整套识别链** 均为我方安全增强，431 无此行为 |

**本轮修复 4 个 P0 + 1 个 P2**（详见 §5），修复后 `npm test` 全绿（36+359+105+84+49，0 失败）。
**仍有 P1 12 项 / P2 9 项 / P3 6 项**待处理（§6、§7），其中多项是「文档写xxx、代码做yyy」的
设计规划偏离，不是崩溃型 bug，但直接影响「与 431 1:1」的验收口径。

---

## 1. 证据分级与审计口径

| 级别 | 含义 | 本审计引用示例 |
|---|---|---|
| A | .so 逐指令反汇编（函数名@地址） | `DriveLinksMode_1001 @libPORSCHE_LINK.so:0x18f00`、`PorscheGetYearAndModel @SYSP:0x22ad4` |
| B | 包内 BIN 字节结构（可复算） | 根表 22 type、路由表 16B 记录、9X*_ALLDATA 目录、COMMAND.GAG 3139 条 |
| C | 实车抓包/日志 | `7F 10 12`、`5A 9F "P200"`、`0x7F1` 回帧头 `7E8`、`1A90 → WP0AB2983EK190083` |
| D | 项目已有 RE/AUDIT 文档的结论 | RE-FLOWSPEC、RE-TRACEABILITY、RE-MODELID、AUDIT-20261110-IC-CHAIN |
| E | 代码注释自称（无独立证据） | 「对齐 参考诊断仪」类注释，**不作为对齐证据** |

判定标签：✅逐帧对齐 / ⚠️部分对齐（有证据但有偏离） / ❌无证据或未实现 / 🔧本轮已修。

---

## 2. 阶段① 读 VIN —— 逐代码行对照

### 2.1 我方实现链（最终磁盘行号）

| 代码 | 发帧 / 动作 | 解析 | 输出 |
|---|---|---|---|
| `src/app.js:1100` `autoSearch()` | `ensureModuleFamily()` → `familyFor()` → `await coder.enterSession(0x89,{family})` (1114) → `await coder.readVehicleIdentity(family)` (1115) | — | `idn.vin` / `idn.name` / `idn.steps[]` |
| `src/coder.js:476-581` `enterSession()` | `address()`(419-449)：`ATSP6` / `ATSH<tx>` / `ATCRA<rx>` / `ATFCSH<tx>`；KWP 流：`10 89`；UDS 流：`10 03`→`3E00`→识别链→`10 89` | `uds()`(684-720) → `parseRespAuto()`(359-380) | `lastIdent`、`identByCmd`、`lastPartNo/Tokens/HwPart/SwNo`、`lastReadSid` |
| `src/coder.js:599-648` `readVehicleIdentity()` | ① `22 11 02`；无 name 才 `22 11 01`；② UDS 模板链 `1003,22F190,1A90,1A87,1A9B,2150,2151,1A9A`；KWP 段去掉 `1003/22F190` | `asciiOf(body, skip)`：头 `5A/61` 剥 2 字节、`62` 剥 3 字节；`VIN_RE=/^[A-HJ-NPR-Z0-9]{11,17}$/` + 必含字母 + 排除 `^9[0-9]{10}$`；`RETAIN={22F190,2151,1A90}` | `out.vin`（≤17 位）、`out.name`（≤32 字符）、`steps` 日志 |
| `src/app.js:1123-1139` | — | `isValidVin()`(1079) 严格 17 位；否则 11–17 位 `WP0/WP1` 前缀 → `vinPrefix=true` | `state.vin`、`toast(VIN=…)` |
| `src/app.js:1145-1204` | — | `guessModelFromVin(vin,year)`、`designationFrom`、`pickModelByName` | 车型候选 / `confirm` / `pushModel` |

### 2.2 431 侧证据与逐项判定

| 431 证据 | 内容 | 我方 | 判定 |
|---|---|---|---|
| `RE-TRACEABILITY-20261109 §车名链` / `RE-MODELADDR-20261108 §1.5④` / `PorscheReadVinAndGetVehicleID @SYSP:0x29fb8`（A） | 三处 `ShowMessageBoxID(0xff001102, 0xff001101, 5)` = 主/备双请求 `22 11 02` / `22 11 01`；应答文本 == trim 车名 | `coder.js:636-637` 主备双请求、仅主未得 name 才发备 | ✅ |
| `PorscheReadVehicleVin @SYSP:0x2a4b4` 模板表 `@0x56a66`（A） | 序 `10 03 / 22 F1 90 / 1A 90 / 1A 87 / 1A 9B / 21 50 / 21 51 / 1A 9A`；**留存键** `22F190(+2)`、`2151(+3)`、`1A90(+1)`；`10 03`/`1A87`/`1A9B`/`2150`/`1A9A` 应答即清（不进车名） | `coder.js:610 RETAIN`、`640-646` 模板序与 KWP 段 | ✅（含 fire-and-forget 语义） |
| `RE-TRACEABILITY §OBD 通道` / `AUDIT-20261110-IC-CHAIN §4`（D/C） | 读 VIN 走 **OBD 功能寻址 `21 09 05`（主）/ `21 09 01`（备）**；实车 KWP 车 `1A90 → WP0AB2983EK190083` | 我方**无 `09 02`/`21 09 05` 实现**；`autoSearch` 用 `coder.tx/rx` = 连接自检遗留地址（`link-doctor` L4 固定 0x7E0/0x7E8 DME） | ❌ **未实现 + 地址写死** |
| `AUDIT-20261110-IC-CHAIN §4`（D，项目自认） | 「我方先发 `221102/221101` 在 KWP 车白等（顺序浪费）+ 固定打 0x7E0/0x7E8」= 未对齐 | 同上 | ❌ 项目文档已承认 |
| `RE-FLOWSPEC-20261108 §1.3/§2.1`（D） | KWP 车请求集只有 `1A xx/21 xx`，`22 xx` 全拒（`7F 22 12`） | `coder.js:640-642` KWP 段去掉 22 ✓，但**主请求 221102/221101 仍在最前无条件发**（636-637），KWP 车先吃两个 NRC/超时 | ⚠️ 顺序浪费 |
| `RE-MODELADDR §3.3-3.4`（D） | 件号 `98161864015` 出现在 `1A87/1A94`；`checkPartNumber @ACTF:0x4e00c` 分词全等 | `coder.js:544-553` 采集 ✓ | ✅ |
| 代码注释 `coder.js:611-613` | 自注「防御层(自创)·不计入对齐」：`looksLikePartNo`、`looksVin` 必含字母 | `coder.js:607-613` | ⚠️ 自创，已如实标注 |

**新增发现（本审计）**：`autoSearch` 先 `enterSession(0x89)`（内含 `10 03`→`3E00`→10 帧识别→`10 89`），
再 `readVehicleIdentity` 的 UDS 模板链**首帧又发 `10 03`**（`coder.js:641`）——
即 `10 89` 之后重发 `10 03` 把会话切回扩展会话，与 431 模板序「`10 03` 在 `22 F1 90` 之前」不一致，
且整套识别链在 VIN 读取前多发一次。属 ⚠️ 会话/帧序偏离（P1-1）。

---

## 3. 阶段② 定具体年款 / 具体车型 —— 逐代码行对照

### 3.1 我方实现链

| 代码 | 逻辑 | 输出 |
|---|---|---|
| `src/app.js:1090-1097` `decodeVinYear()` | `alpha='123456789ABCDEFGHJKLMNPRSTVWXY'`（30 槽）；`i<9 ? 2001+i : 2010+(i-9)` | 单一基数年款（如 `E` → 2014） |
| `src/app.js:1137-1140` | `yearCode=vin[9]`、`year=decodeVinYear(vin)`、`guessModelFromVin(vin,year)` | 年款日志 |
| `src/app.js:1229-1338` `guessModelFromVin()` | `c7=V[7]` TBB 17 槽 + `c11=V[11]`（前缀 `<16` 位时 ZZZ 取 `V[8]`）+ `c6=V[6]`；`VEH_TABLE`（1273-1278）；`ID_MODELS`（1289-1307）；`series=(c6+c7+c11)` 收窄（1316-1332） | `{models[], how, modelId, series, vehName}` |
| `src/variant.js:138-149` `pickModelByName()` | 遍历 `MODEL_LABELS` 与应答文本做**子串 includes** | 命中的车型名 |
| `src/variant.js:166-170` `designationFrom()` | `yy款 + 应答名` | 显示串「14款 Cayman」 |
| `src/app.js:1153-1197` | `autoAccept` 直取首候选 / `confirm` / `prompt` 序号 | `pushModel()`(3120+) → `currentModel` |
| `src/app.js:2744-2757` `pickFamilyByEvidence()` | 识别串 token + 件号 + 注册表 + 协议族 → 数据家族 | `state.selectedVariant[mod]` |
| `src/app.js:2781-2816` 变体落定 | `pickVariantByPart()` → `autoPickVariant()` → 默认 `*_BaseSys` | 变体名 |
| `src/app.js:2822` / `2826-2848` | `validateParam` 过滤 + `readBlock(lid, blockReadSidOf())` | `coding` / `currentBlocks` |

### 3.2 431 侧证据与判定

| 431 证据 | 内容 | 我方 | 判定 |
|---|---|---|---|
| `PorscheGetYearAndModel @SYSP:0x22ad4`，TBB `@0x22b08`（A，`RE-MODELID-20261107 §2`） | `VIN[7]` 17 槽分派 + `VIN[11]` 二段 + `VIN[6]`（`'A'` 分支）；id=13/14 等 22 条 DSN 名表 | `app.js:1245-1267` 逐分支转写 | ✅ 1:1 |
| `Get9x1_Cs1ForVin`（A） | VIN 前缀库二分 + `VIN[7]` 判 9x1/CS1；前缀 <16 位现代 VDS 尾规则 | `app.js:1243`、`1267` | ✅ |
| `GetVehicleForVin @SYSP:0x147c80` 车型表（A） | `(VIN[7],VIN[11])` → 平台名 + DSN id | `app.js:1273-1286 VEH_TABLE` | ✅（**但** `data/vin-vehicle-map.json` 从未被 `fetch`，为死数据；其 `yearCodes 2009-2020` 与硬编码 `2001-2030` 不一致） |
| `PorscheGetYearByModel @SYSP:0x261a8`（A，`RE-MODELID §3`） | 年款表 30 字符 + **三档基数**：`modelId≤10 → idx+1971 或 idx+2001`；`>10 → idx+2001 或 idx+2031`；本车 `id=13, VIN[9]='E' → 2001+13=2014` | `decodeVinYear` 只有一档 `2001/2010`；且 `year` 传入 `guessModelFromVin` 后**函数体内完全未引用** | ❌ **P1-2：1980–2000/2031+ 年款全错；年款不参与车型/显示裁决**（与 `app.js:1081` 注释「970/971、958/9YA 分界靠年款」直接矛盾） |
| `RE-MODELID §1.5④ / TEXT_CN 24 键语言表`（A/D） | 显示串 = `yy款 + 应答名`，车型条目由**strcmp 全等**落定 | `pickModelByName` 用 `includes` 子串 + `includes(w)` 双向弱匹配 | ❌ **P1-3：非全等，存在误命中** |
| `checkPartNumber @ACTF:0x4e00c` / `IsMatchName @ACTF:0x5f8ba`（A） | 件号分词 → `byPart` **字节精确全等** | `coder.js:550` 把 `1A87/1A94` 整串 `txtRaw` 赋给 `lastPartNo`（未分词），`byPart` 全等查几乎必不命中 | ❌ **P1-4：件号键污染** |
| `RE-TRACEABILITY §家族选择` / `seedkey-nonasap.js:181-`（D） | 变体/算法**必须平台限定**（`BV_SteerAssisUDS` 跨 5 平台，不分平台会算错 key → NRC 0x36） | `app.js:2744-2752` 调 `pickFamilyByEvidence` **未传 `ev.platform`** → `variant.js:228` 平台过滤恒真 | ❌ **P1-5：跨平台件号候选不裁剪**（与 seed/key 路径的平台限定口径不一致） |
| 代码自身 | `series` 收窄后的「车身型式精化」`app.js:1329-1333`：`cross = narrowed.filter(m => byId.includes(m))`，而 `byId = ID_MODELS[id]`、`narrowed` 本来就是它的子集 → `cross ≡ narrowed` | 外层要求 `narrowed.length>1` → `cross.length===1` **永不成立** | ❌ **P1-6：死代码**，注释声称「交叉唯一 → 单选」从未生效（9X1 恒返回 Boxster/Cayman 双候选） |
| 代码自身 | `app.js:1157-1161` `autoAccept` 无应答名时 `modelGuess.models[0]` 静默取首候选 | 测试/程序化调用专用 | ⚠️ 与「不猜」纪律冲突（P2-1） |

---

## 4. 阶段③ 进模块 —— 逐代码行对照

### 4.1 我方实现链（最终磁盘）

| 代码 | 发帧 / 动作 | 解析 | 输出 |
|---|---|---|---|
| `src/app.js:204-215` 包装函数 | — | `sysIdForLabel` = `SYSTEM_TO_ECUID[label]` → `platformSysIdByLowByte()` 按家族低字节平移；`sysIdForMod` = 平台映射 `model-sysid-map.js` → 全局表 | 当前车型代际 sysId |
| `src/app.js:352-370` `ecuAddrFromTable()` | — | `ecuAddrTable.entries.find(sysId===key)`；proven→`{tx,rx,state:'measured'}`；`needsProbe`→`{state:'needs-probe',probeCmd}` | 地址或 null |
| `src/app.js:428-443` `addrEntryFor()` | — | 同上，返回原条目 | `entry.sysId/cands/candsAux` |
| `src/app.js:467-487` `aliasEntryFor()` | — | 归一化系统名前缀/后缀，**唯一命中**才回退 | 别名 sysId |
| `src/app.js:546-725` `probeAddressFor()` | `ATSH<tx>`/`ATCRA<rx>`（607-608，`atCmdOk` 要求 OK）；n=0：`3E00`/`3E`（620）→ `plan.firstRead`（638-652）；族链 `probeChainFor(fam)`(414-426)：kwp=`1A9F,3E`、uds=`221409,221102`、null=`221409,1A9F,221102` | `frameIdsOf`(coder.js:336) 校验回帧 ID == 候选 rx；`parseRespAuto` 取 body；**有 body 即绑定**（正响应或 NRC 都算） | `{tx,rx,cmd,ident,confidence:'bound'}` |
| `src/app.js:562-563` 🔧 | — | `planSysIdFor(label, opts.modules, currentModel, entry?.sysId)` 直查 bind-plan | 新代 sysId 的 `plan.pairs/cands` |
| `src/app.js:2412-2419` `enterSystem()` | `addrFor()`(727-735) → `addrTableUnique()`(489-498) 表唯一直进 → 必要时 `probeAddressFor` | — | `addr` |
| `src/app.js:2497-2504`（原快照 2497，现 +7） | `await coder.setAddress(tx,rx,label,{family})` → `ATSP6/ATSH/ATCRA/ATFCSH` | — | `coder.tx/rx/family` |
| `src/app.js:2505-2522` | 身份帧 `1A9F`(kwp) / `22F1A2`(uds)，`uds(...,{allowEmpty:true})` | `5A`→slice(2)、`62`→slice(3)，ASCII 过滤 → `identTextMatch` | `state.currentAddr.state='verified'`（命中时） |
| `src/app.js:2523-2695` | seed/key 五级回落：mode 表（仅 `modeVerified`）、非 ASAP1A 平台限定、NAME_TO_VARIANT 全等、识别串 token `ASAP1A_CCP_..._<tok>`、`pickVariant` | `resolveKey` 预检 | `coder.seedKeyProvider` |
| `src/app.js:2709-2713`（现 +7） | `await coder.enterSession(0x89,{family})` | 见 §2.1 | 会话就绪 / `sessDead` |
| `src/app.js:2722-2821` | 变体分派/落定 → `loadModuleItems()` | `ident-registry`/`ecu-part-map`/`moduleFamily` | `state.selectedVariant` |
| `src/app.js:2826-2858` | 逐 LID `coder.readBlock(lid, blockReadSidOf())` | `extractField` | `currentBlocks`、`readFail` |
| `src/app.js:2899-2901` | — | `readFail===0` → `state.currentAddr.state='verified'` | 写入闸门依据 |

### 4.2 431 侧证据与判定

| 431 证据 | 内容 | 我方 | 判定 |
|---|---|---|---|
| `DriveLinksMode_1001 @libPORSCHE_LINK.so:0x18f00`（A，`RE-DISCOVERY §1`） | `n==0` → **直接 `send(0x10000359,A,2)` 绑定，0 帧探针**；`n>0` → 每候选 **1 帧** `22 14 09`，失败补 `22 11 02`；64% 模块 0 探针 | n=0 我方发 `3E00/3E` + `firstRead` + 最多 3 帧族链；n>0 发 2–3 帧 | ⚠️ **P1-7：不对齐**（注释自称「ELM 无链路层绑定，只能拿一帧代替」，属适配器能力差异，有标注但非 1:1） |
| `RE-ICADDR-20261109 §2/§3`、ANSWERS-20261110（D） | **禁止任何形式近似 join**；精确 internal join 才允许 | `familyFor`(300-317) 模糊 `includes`、`identTextMatch`(521-533) 双向 includes 无长度下限、`aliasEntryFor`(467-481) 前缀/后缀、`variantMatchedInternals`(500-513) includes、`platformSysIdByLowByte` 低字节推断 | ⚠️ **P1-8**：与字面纪律冲突（口径辨：验收原话针对表A/表B **地址 join**，名字匹配层是否适用需在文档澄清；但 alias 回退到旧代地址确属跨代推断） |
| `probe.js:1-16` 头注释 + `probeDecision:53-82`（D/代码） | 「NRC = 有 ECU 但身份不符，**不算候选**」；`identMatch` strcmp/前缀(≥4)/strstr(≥4)；`joinState=unresolved` 才并入全库族 | **app.js 只 import `probeList`**；`probeDecision / identMatch / familyCandidates / normIdent` 在 src 内**零外部调用**；主链路改为「有 body 即绑定」(app.js:692-694) | ❌ **P1-9：严格判定层被旁路 + 数据 `probeRule` 文本与运行行为冲突**（`app.js:658-659` 说明改用回帧 ID 校验兜住，属有意修正但未同步 probe.js 文档） |
| `RE-FLOWSPEC §1.3/§7`、`GAG COMMAND.GAG 3139 条`（A/B/C） | KWP=`10 89` 直建（不发 `10 03`）；UDS=`10 03`→`3E00`→识别→`10 89`；`7F 10 12`=不支持该会话号→**换会话号模板，不重试同号**；会话 ID 分布 `10 89×6 / 10 03×3 / 10 86×3 / 10 85/81/C0/00/4F` | `coder.js:485-499/576-579` 两族流 ✅；但 `10 89` 失败**直接抛**（无换会话模板），会话字 `lid/fam` 只写日志（app.js:2584-2590），会话号硬编码 `0x89` | ⚠️ **P1-10**：与「会话字节=ODX SESSIONS 数据驱动」注释（2702-2707）及 `coder.js SESSION_FOR_SERVICE` 多会话表矛盾 |
| `RE-FLOWSPEC §5 Set7F78Ctrl`（A/D） | `7F xx 78` 续等、重发帧逐字节一致；其余 NRC 单发即败 | `coder.js:690-719` `pendingWait` 仅 `readBlock`/写帧传；识别/会话不传 | ✅ |
| `RE-FLOWSPEC §2.3`（D） | KWP 车绝不发 `0x22` | `coder.js:516-518` identChain 按族过滤 ✅；但 `enterSystem` 2505 身份帧在 UDS 族发 `22F1A2` ✅ | ✅ |
| `GetSubSysDataAddr @FILE:0x15c18`（A） | 名字搜索接受 strcmp/前缀 memcmp/strstr | `identTextMatch`(521-533) 双向 includes **无 ≥4 下限** | ⚠️ P2-2（短 label 如 `IC`、`PDC` 易误命中） |
| `RE-ICADDR §4 枚举` / `src/sweep.js` | 地址连接期建立，按识别码找到模块 | `sweepAndMap`(90-148) / `ensureLiveMap`(150-164) 24h 缓存 | ✅（但 `state.vin || ''` 空串键跨车共用一个缓存条目 → P2-3） |
| `elm327.js:50-72` `cmdOk` 注释（代码） | 「真正的错地址由调用方 frameIdsOf 兜住」 | **逐行复核：有回执断言的仅 8 处 `atCmdOk` 调用** —— `coder.js:427 ATSP` / `:438 ATSH` / `:439 ATCRA`，`app.js:94 ATSP6` / `:110 ATSH` / `:122 ATSH` / `:611 ATSH` / `:612 ATCRA`（均经 `coder.js:323` → `elm327.js:58 cmdOk`）。**其余全裸 `elm.cmd`**：`coder.js:447 ATFCSH`（还带 `.catch(()=>{})` 吞错）、`app.js:97 ATAR` / `:98 ATST08` / `:112 221409` / `:124 22F1A2` / `:134 ATSTFF` / `:707 ATSP6` / `:712 ATST0F` / `:725 ATSTFF` / 探测帧 `:626/:645/:673`。同命令同职责不同口径共 **3 例**（均经全库 Grep `atCmdOk(`/`cmdOk(` + 逐行读盘钉死）：`ATSP6` — `app.js:94` 走 `atCmdOk` ↔ `app.js:707` 裸发且 `.catch(()=>{})` 吞错；`ATSH` — `app.js:110/122/611` 走 `atCmdOk` ↔ 探测帧 `app.js:626/645/673` 裸发；`ATFCSH` — `coder.js:447` 是唯一一次下发却裸发吞错，而同一 `address()` 内 `ATSP/ATSH/ATCRA` 三条都断言。`frameIdsOf` 只在探测路径（app.js:113/126/623/642/673）与 sweep 用；**`coder.uds()/readBlock()/applyChange()` 全链无回帧 ID 校验** | ❌ **P1-11：cmdOk 空回执不阻断所依赖的兜底在读写主链路不存在**（ATSH 未落地时会把别的 ECU 的块读出来并写回）；`ATFCSH` 失败静默 → 多帧流控头未落地无感 |
| 数据加载 | — | `ensureBindPlan`(37-45)/`ensureModuleFamily`(60-78) 1.5s 超时 → null 且**无日志**；`ecuAddrTable` 预取失败 → 静态链静默降级为枚举 | ⚠️ P1-12 可观测性缺口 |

### 4.3 本轮修复的 P0（进模块/编程页）

| # | 位置（修复后） | 问题 | 影响 | 修法 |
|---|---|---|---|---|
| P0-1 | `app.js:562-563` + `model-sysid-map.js planSysIdFor` | 旧写法 `bindPlanFor(entry?.sysId)`，而 `addrEntryFor` 查的 `ecu-addresses.json` **不含 0x10/0x12/0x14–0x16 新代 sysId**（实测 0 条） | 上轮推广生成的 **191 个新代静态候选运行时完全不可达**，且 `aliasEntryFor` 回退到旧代地址（错代） | 平台 sysId 直查；未定案平台优先用旧表实际命中值；新增 6 条回归断言 |
| P0-2 | `app.js:4411-4486` 编程页 | `await coder.securityAccess(0x09, !uds)` 的 `uds` **在该作用域未定义**（4463/4476 旧行号） | 点「写编程块」必抛 ReferenceError，功能完全不可用 | 改用 `progProto().isKwp = readSid !== 0x22` |
| P0-3 | `app.js:4412` / `3686-3696` | 写帧标识符位宽 `idPad` 按 **readSid** 推导；恢复备份页 `uds` 按 **writeSid** 判族 | 混族记录（`readSid=0x21, writeSid=0x2E`）会把 2 字节 DID 拼成 1 字节写错地址；KWP ECU 被发 `27 09`（应 `17 00`） | 拆分 `readPad/writePad/writeWide` 与 `isKwp`，并加 LID 位宽拒写闸 |
| P2-4 | `app.js:2368-2376` `exitSystem` | `try { coder.uds('1003'…) } catch {}` **缺 await** → Promise 拒绝不被捕获 | 未处理拒绝；退出帧与后续操作并发 | 改 `Promise.catch()` 链（函数保持同步） |

---

## 5. 阶段④ 读写编码 —— 逐代码行对照

### 5.1 我方实现链

| 代码 | 发帧 | 解析 | 输出 |
|---|---|---|---|
| `src/app.js:3557-3580` `doRead()` | 缓存命中不发帧；否则 `coder.readBlock(lid, blockReadSidOf(null,p))` | `extractField(block,p)`(schema.js:135+) BigInt 位域、LSB 起可跨字节 | `p.currentValue`、`toast(decodeValue)` |
| `src/coder.js:742-792` `readBlock()` | `21 <LID8>` / `22 <DID16be>` / `1A <LID8>`（位宽 768-771）；`pendingWait:true` | 期望正响应 SID = `readSid+0x40`（774-779）；头长 `0x22→3`、其余 `2`（784-785）；`lastReadSid` | 数据字节数组 |
| `src/coder.js:144-252` `parseResp()` | — | 回显剔除、ATS0 连写剥 ID、ISO-TP SF/FF/CF/FC 重组、序号跳变/截断 → `truncated`、`7F`→`nrc` | `{kind,body}` |
| `src/coder.js:262-300` `parseRespCaf1()` | — | CAF1 纯数据拼接（不套 ISO-TP 分派） | `{kind,body}` |
| `src/coder.js:359-380` `parseRespAuto()` | — | 按 `reqSid+0x40`/`7F` 落在 body[0] 选解释；都像时取未截断/更完整者 | 统一解析结果 |
| `src/app.js:3412-3480` `doWrite()` | `addrSafeForAction()`(3391) → seedKeyProvider 存在 → `confirm` 二次确认 → `canWrite/fieldInRange` → `coder.applyChange(p,v,{session:0x89,secLevel:0x09})`(3467) | — | `p.currentValue` + 缓存失效 |
| `src/coder.js:875-1044` `applyChange()` | `enterSession(0x89)`(955) → `readBlock` 备份(956) → `securityAccessEx({level:0x09,kwp:readSid!==0x22})`(1004) → `3B/2E <id><整块>`(1011-1013) → `readBlock` 回读(1024) | `injectField`(schema.js:157) 位域注入、`fieldByteSpan` 变更越界检查(980-986)、正响应 SID 校验(1015-1020)、逐字节回读比对(1025-1041) | `{before,after,readback,diffs}`；不一致 → `_restore` 回滚 |
| `src/coder.js:798-864` `securityAccess()` | UDS `27 09 0100` 取 seed / `27 0A <key>`；KWP `17 00 00` / `17 40 <key>` | `67/57` 正响应 SID 校验、`seed.slice(2)/slice(1)`、空 seed 拒写、全零跳过 | 解锁 |
| `src/app.js:4443-4492` 编程页写 | `3B/2E` 整块写 + 回读 + 失败恢复 | 见 P0-2/P0-3 | — |

### 5.2 431 侧证据与判定

| 431 证据 | 内容 | 我方 | 判定 |
|---|---|---|---|
| `SysTemReadData @READWRITE:0x0F830D` / `SysTemWriteData @0x0F855D`（A），`RE-FLOWSPEC §2/§3/§4.4-4.5`（D） | 读帧打包仅 `1A/21 <LID8>`、`22 <DID16be>`；写帧仅 `3B <LID8> <data>`、`2E <DID16be> <data>`；GAG 3139 条写服务 `3B×14 / 2E×3` | `READ_SIDS/WRITE_SIDS`(schema.js:85-86)、`coder.js:758-770/909-921/1010-1013` | ✅ 帧构造 1:1 |
| GAG `COMMAND.GAG`（B/C） | `27 09 01 00` 带 2 字节尾参；KWP `17 00 00` / `17 40 00`（无 `17 09`）；`3E 00` 无 `3E 80` | `coder.js:801-857` | ✅ |
| `RE-FLOWSPEC §5 Set7F78Ctrl`（A/D） | `7F xx 78` 续等重发原帧、其余 NRC 单发即败 | `coder.js:690-706`、`readBlock`/写帧传 `pendingWait` | ✅ |
| `McrCodeChileWrite @READWRITE:0x0F8093`（A）/`RE-FLOWSPEC §4.1`（D） | 写序列 **备份 →（安全访问）→ 单项写 → 回读**；读失败即中止 | `coder.js:948-1043` 主干 ✅ | ✅ |
| `RE-FLOWSPEC §4.0/§4.1`（D） | **431 无值域/level 门禁、无拒写项概念**；回读不一致 = 记录失败，**不自动回滚** | `schema.js:258-264 WRITE_ENABLED/canWrite`、`fieldInRange`、`validateParam`(51-74)、`coder.js:1027-1040 _restore 自动回滚` | ❌ **P1-13：自创安全增强，不是 1:1**（`schema.js:16-18/250-256` 注释已部分标注「政策」但未标「不对齐」） |
| `RE-FLOWSPEC §1.3/§7`（D） | 会话序列 `10 03 → 3E → 识别 → 10 89 → 读写`（每模块一次） | `applyChange` **每次写都调 `enterSession`**（955），内部重跑 10 帧识别链（516-563）+ `3E00` + `10 89`；与 `coder.js:953` 注释「会话 → 读备份 → 安全访问 → 写 → 回读」不符 | ⚠️ **P1-14：帧序/性能偏离**（每次写最多 +9s，且识别链清空 `lastIdent` 影响后续变体证据） |
| `RE-FLOWSPEC §4.1`（D） | 读不到 = 不写 | `app.js:3690` 恢复备份页无 readSid 时按 **writeSid 猜** `0x22/0x21`；`coder.js:927-936` 正式写路径则拒写 | ❌ **P1-15：两处口径相反**（恢复路径可能用错读服务读回并误判成功） |
| `RE-FLOWSPEC §3.1`（D） | 记录自带 `readSid/writeSid`，同 ECU 混族常态 | `app.js:4582-4587 blockReadSidOf()`：`hasReadService` → `blockReadSid` → `resolveBlockReadSid(items)`（首记录 SID） | ✅ |
| `ANSWERS-20261110` / `ECU-ADDRESSING`（D） | 歧义 → 禁写（宁可拒写不猜） | `addrSafeForAction`(3391-3409)：`candidate`/`probed-unverified` 一律放行；`!st`（无地址状态）也 `return true`；`doWrite`(3433-3443) 变体未确认按默认变体落定放行 | ❌ **P1-16：写闸门与验收文档冲突**；且 `app.js:3393-3395` 注释「无二次确认弹窗」与 `app.js:3414-3422` 注释/代码「写入**有**二次确认」自相矛盾 |
| `schema.js` 注释自述 | 变体未确认锁写 | `app.js:2877-2878` 注释「写入闸门=§5 宁可拒写不猜」 vs `2884-2892` 实际「多/无拟合 → 默认变体落定，不锁写」 | ❌ **P1-17：同文件内设计叙述互斥** |
| 代码自身 | — | `doRead` 的 `extractField`(3566) 无 try/catch，`enterSystem`(2862) 有 | ⚠️ P3-1：解析异常无 toast |
| 代码自身 | — | `securityAccess`(839-848) 空 key + `needsKey:false` 继续写；`securityAccessEx`(1339-1346) 同条件**抛异常** | ⚠️ **P1-18：两条安全访问路径口径相反** |

---

## 6. 全链路帧序对照（我方 vs 431）

| 步骤 | 431（逐指令证据） | 我方（代码） | 差异 |
|---|---|---|---|
| 连接 | ELM/协议模板（ATH/CAF/CFC） | `prepareLink()`(elm327.js:114-122) `ATE0/ATL0/ATS0/ATAL/ATH1/ATCAF1/ATSTFF/ATAT0/ATCFC1/ATFCSD/ATFCSM0` | 近似；`ATCAF1` 与 `coder.parseRespAuto` 的 CAF0/CAF1 双解释并存 |
| 读 VIN | OBD `21 09 05`→`21 09 01`；Porsche 模板 `10 03/22F190/1A90/1A87/1A9B/2150/2151/1A9A` | 先 `enterSession(0x89)`（10 03→3E→识别→10 89）→ `221102/221101` → 模板链（首帧又 `10 03`） | **多发整套会话+识别**、OBD 通道缺失、`10 03` 时序倒置 |
| 定车型 | VIN TBB 分派 + 年款三档 + 24 键 strcmp 全等 + 件号分词全等 | TBB ✅ / 年款一档 ❌ / 子串 includes ❌ / 件号整串 ❌ | 见 §3 |
| 进模块寻址 | `DriveLinksMode_1001`：n=0 直绑 0 帧；n>0 每候选 1 帧 `22 14 09`，失败补 `22 11 02` | `ATSH/ATCRA` + `3E00/3E` + `firstRead` + 族链 2–3 帧 | **探针帧数不对齐** |
| 会话 | KWP `10 89`；UDS `10 03 → 3E00 → 识别 → 10 89` | `coder.enterSession` 同构 ✅ | ✅（但写时重跑） |
| seed/key | mode 表 / ASAP1A 名字表，平台限定 | 五级回落（含 modeVerified 闸） | 近似，平台限定在家族分派处缺失 |
| 读块 | `21/22/1A`，ISO-TP 重组，`7F78` 续等 | 同构 ✅ | ✅ |
| 写 | 备份 →（安全访问）→ 单项写 → 回读；不一致=记录失败 | 值域/服务集/变更越界闸 + 写 + 回读 + **自动回滚** | 自创增强（非 1:1） |

---

## 7. 全量代码审查：bug 与设计偏离清单

### 7.1 本轮已修（🔧，均有回归断言）

| 级别 | 项 | 位置 | 回归保护 |
|---|---|---|---|
| P0 | 新代 bind-plan 候选运行时不可达（191 个） | `app.js:562`、`model-sysid-map.js` | `verify-all-models.mjs [B]` 6 条 + `[G]` 1 条 |
| P0 | 编程页 `uds` 未定义 → 写编程块必抛 | `app.js:4411-4492` | `[G]` 静态源码断言 |
| P0 | 写帧位宽/族判定按错 SID | `app.js:4412`、`3686-3696` | `[G]` 静态源码断言 |
| P2 | `exitSystem` 未 await 的异步帧 | `app.js:2368-2376` | `[G]` 静态源码断言 |
| P2 | `SECURITY note` 类注释冲突 | — | — |

### 7.2 P1（待修，影响「完全对齐」验收）

1. **年款三档基数缺失 + `year` 参数未使用**（app.js:1090-1097 / 1229）：按 `PorscheGetYearByModel @0x261a8` 补 `modelId` 分档，并让 `year` 真正参与 `ID_MODELS` 收窄。
2. **显示串非 strcmp 全等**（variant.js:138-149）：`pickModelByName` 改 24 键语言表精确相等。
3. **件号整串污染 `lastPartNo`**（coder.js:550）：按 `checkPartNumber` 分词取 token。
4. **`pickFamilyByEvidence` 漏传 `ev.platform`**（app.js:2744-2752）：补平台，避免跨平台变体误选。
5. **车身型式精化死代码**（app.js:1329-1333）：删或改成有效交叉（当前 `cross≡narrowed`）。
6. **OBD VIN 通道缺失 + 请求地址写死**（autoSearch / readVehicleIdentity）：需先决定功能寻址地址来源（不猜）。
7. **会话/识别帧重复 + `10 03` 时序倒置**（app.js:1114-1115 / coder.js:641）：把 `enterSession` 从 autoSearch 主链移除或按模板序重排。
8. **n=0 探针帧数不对齐**（app.js:619-695）：ELM 层无链路绑定，建议在文档明确标为「能力差异、不计入 1:1」，或改为不发探针直接采纳表地址（需证据）。
9. **probe.js 严格判定层被旁路 + `probeRule` 文本冲突**：统一文档或恢复调用。
10. **会话字 `lid/fam` 只进日志、会话号硬编码 0x89**（app.js:2584-2590 / 2709）：与 ODX SESSIONS 数据驱动叙述冲突。
11. **`cmdOk` 空回执的 frameIdsOf 兜底在读写主链缺失**（coder.js:684-720）：在 `uds()` 加「有 CAN ID 头时必须匹配 rx」校验。
12. **写策略自创**：值域/level 闸门、`_restore` 自动回滚、写时重跑识别链、恢复页猜 readSid、`securityAccess` 两路径口径相反、`addrSafeForAction` 与「歧义禁写」冲突、变体未确认放行 —— 建议统一写成《有意安全增强清单》并与 431 原行为分栏标注，避免再被当作「已对齐」。

### 7.3 P2（可观测性/边界）

- `ensureBindPlan`/`ensureModuleFamily`/`ecuAddrTable` 加载失败静默 null，无任何日志（app.js:37-45/60-78/2546-2556）。
- `state.vin || ''` 空串键 → live-map 24h 缓存跨车串台（app.js:587）。
- `addrTableUnique` 表唯一直进分支（app.js:2443-2449）**先于** `probeAddressFor` 判定：新代平台若 `ecu-addresses.json` 里恰好存在同 sysId 的旧候选，会绕过本轮 bind-plan 的新代多源候选（P2，优先级口径需统一）。
- `probeAddressFor` 的 `void probeCmd`（app.js:664）丢弃 `ecuAddrFromTable` 返回的 6 条 `needsProbe` 帧；那些帧经 2026-11-10 审计已判定为旧导出器猜测（含前导长度字节、SID 不在首字节），**丢弃是正确的**，但 `probeCmd` 参数与 `needsProbe` 分支仍留在代码里，容易下次被误当权威帧复用（P2 清理项）。
- 模拟车 `simMock.identTextTx` / `identText`（app.js:2417-2431）与 `simMode` 静默选变体（2806-2815）只写日志：需核 `mock-adapter.js` 是否真的消费 `identTextTx`（本轮未逐行验证，标为**待核 P3**，不作为结论）。
- `addrFor(label, model=currentModel, sys)` 的 `model` 参数函数体内未使用（app.js:727）。
- `addrCandsFor`（app.js:445）零调用死代码；`void probeCmd`（app.js:664）丢弃 6 条 needsProbe 探测帧。
- `probeAddressFor` 失败前 `state.currentAddr = addr` 已赋值（app.js:2487 前后），与 2434「进模块失败不能沿用地址证据」矛盾。
- `identTextMatch` 双向 `includes` 无 ≥4 下限（app.js:521-533）。
- 模拟模式三处硬编码 `[0x7e0,0x7e8,0x7e1]`（app.js:1037-1040 等，测试专用但与真车拓扑不一致）。
- `autoAccept` 静默取首候选（app.js:1157-1161）。
- `coder.js:447` `ATFCSH` 裸 `elm.cmd` + `.catch(()=>{})` 吞错 → 多帧流控头未落地无感；同命令不同口径（`app.js:94 ATSP6` 走 `atCmdOk` ↔ `app.js:707 ATSP6` 裸发）。精确清单见 §4.2 P1-11。

### 7.4 P3（清理项）

- `vin-vehicle-map.json` 从未 fetch（死数据）且其 `yearCodes` 与硬编码冲突。
- `doRead` 的 `extractField` 无 try/catch（app.js:3566）。
- `progRun` 的 `probeCmd` 参数、`addrCandsFor` 等遗留 API。
- 代码中大量「参考诊断仪」占位符（RE 文档用匿名化），不影响运行但影响可读性。
- `probe.js` 头注释仍描述「joinState=unresolved 并入全库族并集」，与 app.js:553-555「不再用全库族并集」矛盾。

---

## 8. 验收与回归

| 检查 | 结果 |
|---|---|
| `node --check` 全量 `src/*.js` | ✅ 0 语法错误 |
| `npm test`（sync + check-bundle + test-align431 + smoke-fixes + boot-smoke + e2e-flow + verify-pending + walkthrough + name-map-coverage + verify-all-models） | ✅ **EXIT=0**；36 + 359 + 105 + 84 + **49**，0 失败 |
| `tools/verify-all-models.mjs [G]` 新增 5 条 P0 回归静态断言 | ✅ 5/5 |
| `npm run rebuild:all-models` 一键复现 | ✅ 通过（本轮未改数据链） |
| `build-acceptance-981.py` | ✅ 48 模块四元组无缺项（上轮已验） |
| app.js esbuild 打包（check-bundle） | ✅ |

> 注：`npm test` 输出里的 `FAIL mode 0x1d 0/32` 是 `smoke-fixes.mjs` 的**信息行**
> （断言「mode 0x1d 仍 PENDING」的计数展示），不是失败；该套件汇总为 359 passed / 0 failed。

---

## 9. 结论与建议

1. **可以明确回答：目前不是完全 1:1 对齐 431。** 帧级「读 VIN 主备双请求、模板表 8 帧序、TBB 分派、会话双族流、21/22/1A 与 3B/2E 帧构造、ISO-TP 重组、7F78 续等、seed/key 族分派」都有 A/B/C 级证据支撑；但**读 VIN 地址与 OBD 通道、年款三档基数、显示串全等、n=0 探针、写策略闸门与回滚**等环节存在 ❌/⚠️，详见 §2–§5。
2. **本轮修掉的 4 个 P0 是真实功能缺陷**（尤其 P0-1 让上一轮全车型推广的 191 个静态候选在运行时不可达），不是纸上问题；已加回归门禁。
3. **最大的系统性风险不是崩溃，而是「文档写 A、代码做 B」**：`addrSafeForAction` 与验收「歧义禁写」、`probe.js` 严格判定层与 app.js 有 body 即绑定、变体落定注释互斥、`cmdOk` 兜底承诺落空。建议下一轮先做一次**「注释/文档 ↔ 代码」一致性收口**，再逐项补 431 证据。
4. **不建议为了「看起来 1:1」删掉安全增强**（值域闸/回读/回滚）：它们防止写坏车，但必须在验收矩阵里单列「有意偏离 431」并写明理由，避免下一次审计再次判为 bug。
5. 接手顺序建议：§7.2 的 1–5（纯代码可修、有 A 级证据）→ 6–7（需地址/会话证据，先补 RE）→ 11（回帧 ID 校验，安全收益最高）→ 12（文档口径统一）。

> 审计产物：本报告 + `tools/verify-all-models.mjs [G]` 回归断言 + `src/app.js`/`src/model-sysid-map.js` 的 P0 修复。
> 全部结论可由 `npm test` 与本报告列出的 `文件:行号` 逐条复核。

---

## 10. 改造后二次审计（2026-11-11 同日第二轮）

> 触发：用户要求「偏离都修成和原厂完全一致、去掉任何自创内容、文档写 A 代码做 B 一起解决、
> 安全增强在验收矩阵单列、修复全部 bug，都做完再审计一次」。
> 本轮改动的逐项清单见 `ACCEPTANCE-MATRIX-431.md §4`；本节只记「改造后复检结论」。

### 10.1 四阶段改造前后对照

| 阶段 | 首轮审计结论 | 本轮改造 | 改造后复检 |
|---|---|---|---|
| ① 读 VIN | ❌ OBD `21 09 05` 未实现；地址固定 0x7E0/0x7E8；autoSearch 预建 10 89 导致模板链首帧再发 10 03；`looksVin/looksLikePartNo` 自创防御层 | 去自创形态层（留存键按原厂固定长度取原始字节）；autoSearch 只下发链路绑定，由模板首帧建会话；VIN 仅按长度判完整/前缀 | ✅ 主备双请求 + 8 帧模板序 + 3 留存键全部逐帧一致。**OBD 通道仍未实现（数据缺口：smali 未给寻址地址，不猜）** |
| ② 定年款/车型 | ❌ 年款只一档基数；`year` 从未使用；显示串子串 includes；1A87/94 整串污染；`pickFamilyByEvidence` 漏 platform；车身精化死代码 | `decodeVinYear(vin, modelId)` 三档（1971/2001/2031，无 modelId→null）；先分派 id 再算年款；`pickModelByName` 基名全等且**唯一才认**；件号按 0x20 分词；补 platform；删死代码 | ✅ 三档与 `PorscheGetYearByModel @0x261a8` 指令表逐条一致（E→2014、F→2015、A→2010、数字→2031）。**24 键语言表未导出（数据缺口，用目录基名全等作可观测等价）** |
| ③ 进模块 | ⚠️ n=0 发 3E00/firstRead/族链；n>0 每候选 2–3 帧；alias 近似回退；familyFor 模糊键；identTextMatch 双向 includes；低字节跨代平移；probe.js 旧判定层零调用；会话字只进日志；`cmdOk` 空回执兜底承诺在读写链落空 | n=0 **0 探针帧**（ATSH/ATCRA 回执即绑定）；`probeChainFor` 每族 **1 帧**；删 `aliasEntryFor`；familyFor 只精确键；`identTextMatch` 走 `identMatch` 原语；删低字节平移；删 `probeDecision`；会话注释收口为「固定 0x89 主模板 + 数据缺口」；`uds()` 加回帧 ID 校验（单 ID 不符判死、多 ID 混流留痕） | ✅ 探针帧数与 `DriveLinksMode_1001 @0x18f00` 一致（n=0 零帧、n>0 每候选 1 帧）；无近似 join / 无 alias / 无跨代平移。n=0 的「链路绑定」由 ATSH/ATCRA 等价（**适配器能力差异，非代码偏离**） |
| ④ 读写 | ⚠️ 值域/level/地址态闸门、回读自动回滚、每次写重跑 10 帧识别链、恢复页猜 readSid | 新增 `SAFETY`（默认全关=原厂）：range/level/addrState/autoRestore/span 全部 opt-in；写路径 `skipIdent:true` 不重跑识别链；恢复页无读服务拒写 | ✅ 写序列实测 `1089→3E00→2101(备份)→170000(安全)→3B0109000000(写)→2101(回读)`，**无识别链**；越界值默认不拦；回读不一致默认抛「记录失败，不自动回滚」。服务集闸（21/22/1A、3B/2E）与位宽校验**保留**（有原厂证据，属对齐） |

### 10.2 二次审计新发现并修复（3 个改造引入问题）

| # | 问题 | 影响 | 修法 |
|---|---|---|---|
| 1 | 读 VIN 的 VIN 键仍走 `asciiOf`（过滤非打印+trim）后再截 17，与原厂 `memcpy 17B` 不符 | VIN 含分隔/零字节时长度不足 → 判「读不到 VIN」 | 改为 `body.slice(skip, skip+17)` 取原始字节（仅去 0x00） |
| 2 | `pickModelByName` 基名全等后直接取 `find` 首个 | 981/982 的 Boxster/Cayman 基名相同 → 可能选错代（属「猜」） | 改为**唯一才认**；多命中返回 null → 走多候选确认 |
| 3 | `uds()` 回帧 ID 校验对「多 ID 混流」直接抛错 | EA 通道 ATCRA 未生效时（真车实测）会把整条读写链全灭 | 只有**单一回帧且 ID 不符**才判死（明确串线）；多 ID 混流只留痕 |

### 10.3 剩余未对齐（全部为数据缺口/适配器差异，不猜）

见 `ACCEPTANCE-MATRIX-431.md §3`：① OBD VIN 通道地址（smali 未给）② n=0 链路绑定（ELM 无
链路层绑定 API，ATSH/ATCRA 等价）③ 24 键语言表（未导出）④ 会话号数据驱动（固定 0x89 主模板）
⑤ 9X6/9X7/CS1/E1 平台 sysId（精确交集零/平票）。

### 10.4 验收（改造后）

| 项 | 结果 |
|---|---|
| `npm test` | **全绿**：36 + 359 + 105 + 84 + **66**，0 失败 |
| `node --check` 全量 `src/*.js` | 通过 |
| 新增门禁 `[H]` 21 条 | 全部通过（无自创层 / 三档年款 / 全等显示 / 单帧探针 / 无 alias / 无平移 / SAFETY 默认关 / 不重跑识别链 / 无第三方字样） |
| 981 回归 | 44/48 静态解出、DME 0x7E0、PASM 含 0x7D0、IC≠PSM 保持 |
| 全车型回归 | 566 sysId / 351/601 静态候选保持 |
| 源码匿名化 | `src/*.js` 无第三方工具字样（`[H]` 断言） |

### 10.5 结论

**默认路径已无自创行为**：四阶段所有代码级偏离均改为原厂做法，安全增强全部收敛到
`SAFETY`（默认全关）并在验收矩阵单列；「文档写 A 代码做 B」的 6 处（addrSafeForAction 注释
互斥、probe.js 旧模型、变体落定政策、会话数据驱动、cmdOk 兜底承诺、vin-vehicle-map 数据源）
已逐条收口。剩余 5 项均为**包内数据缺口或适配器架构差异**，已在矩阵中如实标注，不做猜测。

---

## 11. 第三轮独立复核（当前有效结论）

> 对象：commit `93819491d115fcff5ed320ac42497543eeadf73f`，复核开始时工作区干净。
> 方法：4 路只读审计 + 主审重读当前磁盘 + 数据生成器/产物对账 + 最小运行用例。
> 本节取代 §10.5 与验收矩阵的「无自创 / 已收口」结论。**本轮未改协议源码。**

### 11.1 对用户三问的直接回答

1. **全链路没有完全对齐 431。** 帧格式和若干模板已经对齐，但 VIN 主链、车型/变体证据、
   n=0/n>0 绑定、跨模块 seed/key、备份恢复、同 LID 多服务读取仍有实质偏离与 bug；
   OBD VIN 地址、24 键语言表、逐 ECU 会话、部分 seed/mode 与多 sysId 归属仍未收口。
2. **自创逻辑没有清干净，文档↔代码也没有收口。** `isValidVin`、件号防御函数、
   多变体取首/默认放行、platform 恒真、扫描取首模块等仍在；验收矩阵把会阻止写入的 UI
   值域闸写成「仅提示」，把默认不回滚写成全路径一致，均与代码相反。
3. **仍有 bug，且多项是 P0。** 下面只列本轮能用当前代码/数据/最小用例证明的项；
   不再用「测试全绿」替代行为审查。

### 11.2 四阶段当前判定

| 阶段 | 当前判定 | 关键事实 |
|---|---|---|
| 读 VIN | **未对齐** | fresh 连接 `familyFor('DME')=null`，UDS 分支不走 `22F190`；UDS 显式分支实际首帧仍是 `221102`，`1003` 在其后；`221102` 若回 VIN 会同时污染 `name`；OBD 通道与正确寻址未实现 |
| 年款/车型/变体 | **年款表对齐，车型/变体未收口** | 三档年款与 `PorscheGetYearByModel` 一致；24 键语言表未导出；`trim()` 破坏 856 个尾空格件号键，逗号变体 750 键不能全等命中，platform 过滤仍恒真 |
| 进模块 | **存在 P0，不可称对齐** | `n_min` 混行得到 88 个错误直绑条目；运行时 n=0 取首候选；生成器把 rx 重算并绕回 0x0000；KWP 车道变换模块被发 221409；首模块 sysId 与多 sysId 归属可错代 |
| 编码读写 | **存在写错 ECU/块的风险** | 备份不带 ECU 身份可跨模块恢复；同 LID 跨 SID 混缓存；缺 SID/LID 默认值仍可发写帧；回帧过滤可漏多帧错地址；读块不校验 LID/DID 回显 |

### 11.3 P0：可复现的高危问题

| # | 位置 | 问题与证据 | 影响 |
|---|---|---|---|
| P0-1 | `tools/export-bind-plan.py:289-290,368` + `app.js:595-597` | 88 个 sysId 同时含 n=0/1 行，`min(n)=0` 被整体直绑；运行时对 bindDirect **不探测、直接取 pairs[0]**。981 IC `0x0e08` pairs 为 `060A/0612`、`0646/064E`、`07F1/07F9`，当前会选 `060A`，验收期望 `07F1` 仅在第三项。门禁只查「包含」不查实际选择 | 直接进错模块；n=0 语义被错误解释成「首候选免验证」 |
| P0-2 | `tools/export-bind-plan.py:165-177,364` | 表 A 原始 rx 已读入但生成 pairs 时丢弃，统一 `(tx+8)&0x7FF`。实测表 A `07FC→0804` 变成 `07FC→0004`，`07FD→0805` 变成 `07FD→0005` | 11 位 ATCRA 指向错误/非法接收 ID，可能收别的 ECU 帧 |
| P0-3 | `app.js:2573` + `coder.js:684-695` | 换模块前没有清 `seedKeyProvider`；本模块无 drivelinks hit 且旧 provider 非空时，`:2573` 直接跳过新模块名字分派。`lastIdent` 在本次识别前也可用于旧算法分派 | 上一模块算法/识别串用于下一模块，错 key 有 0x35/0x36 风险 |
| P0-4 | `app.js:3618-3622,3638,3649-3680` + `coder.js:1004-1008` | 备份只存 lid/readSid/writeSid/raw，不存车型、模块、tx/rx、VIN；restoreCoding 在当前 ECU 上恢复全部历史备份，也不检查 `WRITE_SIDS`。实测 343 条备份 readSid 有效但 writeSid=0，EPB 可拼 `00 87…`；另有 6 条备份因未保存 blockReadSid 而永久不可恢复 | 可把 A 模块/另一辆车的块写进 B 模块，且绕过只读服务闸 |
| P0-5 | `app.js:150-161,2284-2308,2790-2827,4551-4555` | `currentBlocks` 只按 lid 缓存；`loadVariantItems` 给全文件统一 `blockReadSid`。实测 `911_991_/Allrad_Gen2_a1.json` 同 lid=144 同时要求 `readSid=34` 与 `readSid=26`；扫描统计 350 文件、698 个 lid 组跨 SID | 后读块直接不读，旧块/错误服务的数据冒充当前值并参与写入 |
| P0-6 | `coder.js:712-726` | 回帧校验用 `ids.length` 而不是不同 ID 数，且包含期望 ID 就立即接受混流。最小用例：期望 rx=0x7E8，两个错帧均来自 0x7E9，`uds()` 返回 `ok`，`frameIdsOf=[2025,2025]` | 多帧错地址可漏过 FilterId 等价校验，错块可进入读写 |
| P0-7 | `app.js:1060,2499-2501` + `coder.js:647-665` | fresh DME 定族为 null；`familyFor` 在 `ensureModuleFamily()` 前调用。非 uds 链不含 `22F190`；UDS 主名 `221102` 又在 `1003` 前发出。最小复现 `221102` 回 VIN 时输出 `name=VIN`、`vin=VIN` | fresh UDS 自动搜索读不到 VIN 或把 VIN 当车名，后续车型识别失真 |
| P0-8 | `src/module-ecu-map.js` | esbuild 报 24 组重复键，16 组值冲突，后者静默覆盖前者。例 `Allrad 0x0e52→0x0b35`、`PDCC_2 0x0e2b→0x0b2b`、`RDK3 0x0e37→0x0c37`、`BV_EnginContrModul1UDS 0x0e01→0x0b01` | 全局/回退/反查表拿错代 sysId；测试只警告不失败 |
| P0-9 | `coder.js:937-978,1110` | 公共写 API 对缺 writeSid 默认 0x3B，绕过只读闸；`Number(null)=0`，null lid 可进入 `3B 00…`；自动恢复还对缺 writeSid 默认 3B | 调用方可绕开 UI，发出源记录并未定义的写帧 |
| P0-10 | `app.js:2515-2556` | `let hit` 定义在 2515 的 inner try 内，2556 在块外求值。当前 drivelinks 记录 mode 非空，因此必走到 `hit` 并抛 `ReferenceError`，被 2648 外层 catch 吞成「无算法」；旧 provider 同时被清掉 | 原厂 mode 路径在当前数据下不可达，并可能把本来可用的名字分派算法一并清掉 |

### 11.4 P1/P2：功能错误、431 偏离与安全策略不一致

| # | 位置 | 问题 |
|---|---|---|
| P1-1 | `app.js:2463-2469,622-633` + `probe.js:34-46` | 已知 UDS 的 `BV_ContrUnitLaneChangAssis2UDS` 发 KWP `1A9F`，KWP 实证只答 `221409`；fresh 首次探测也在 moduleFamily 加载前定族 |
| P1-2 | `app.js:359-365,898-906` + `981-sysids.json` | 地址解析在识别前取首个有 sysId 的模块；5 个双 sysId 模块只展开首枚，其余静态候选不可达；平台缺失时可回退全局旧代表 |
| P1-3 | `coder.js:541,546` + `variant.js:106-124,246-251,278` | `trim()` 破坏 856 个尾空格件号键；750 个逗号变体键未先拆分，`names.includes(整串)` 永远 false；platform 过滤仍恒真；partHit 可能来自别的模块 |
| P1-4 | `app.js:3202,3332` | 两个主参数 UI 仍无条件 `fieldInRange` 并 return，SAFETY.range=false 也拦；验收矩阵所称「只是提示」不成立 |
| P1-5 | `app.js:4453-4471,4454,4464` | 编程页不看 SAFETY.autoRestore，任何写/回读异常都自动恢复；写帧与恢复帧不传 `pendingWait:true`，NRC 0x78 直接失败 |
| P1-6 | `coder.js:190,215-231` | FF 后未设 `expectedSeq=1`，第一个 CF 不校序号。最小用例 FF 后首 CF=2 仍返回 `kind:'ok'` |
| P1-7 | `coder.js:816-828,1063-1067` | 只校验正响应 SID，不校验 LID/DID 回显；最小用例请求 LID=1、应答 `61 99 22` 被接受并返回 `[0x22]` |
| P1-8 | `app.js:2379,4404-4406` | 模拟路径仍用旧 entry 查 plan；编程页 progRun 按 readPad 做写前预检，混族记录可在进入 writePad 检查前被误拒 |
| P1-9 | `app.js:251` + `variant.js:67-125,215-289` | 多件号/变体歧义仍取首；默认变体可放行写入；`variantFitsBlocks` 对 object enum 恒生成空 keys，枚举约束失效（coding-v2 中 3802 条为 object） |
| P1-10 | `app.js:37-45,48-51,90-147,150-161` | bind-plan/枚举可静默回退；内存 liveMap 不重新比 VIN，换车仍可能用上一辆；KWP 枚举统一 221409/22F1A2，覆盖不完整 |
| P1-11 | `app.js:2530,2556` + `data/drivelinks.json` | 当前 1072 行 `modeVerified` 全空，但 mode 本身非空，所以「无 modeVerified 就不用」不能解释失败；真正原因是 P0-10 的块作用域 ReferenceError。会话仍固定 0x89，drivelinks 会话字只进日志 |
| P1-12 | `app.js:589-597` + `e2e-flow.mjs:355-383` | n=0 没有 ECU 任何应答也可判 bound；注释称绑定失败补 221102，实际 ATSH/ATCRA catch 直接 return。e2e 仍自写 3E00 测旧行为，并未调用 app 的 probeAddressFor |
| P1-13 | `coder.js:1484-1530` | 原厂写序言 A/B/C/D 有实现函数但无调用方；applyChange 对所有 ECU 固定会话→安全访问→写→回读，写前分派未收口 |
| P1-14 | `app.js:2596-2602` + `seedkey-resolver.js:295-358` | 非 ASAP 预检带 `{platform,module}` 能通过，真正 calc 却只传 name；实测 `BV_SteerAssisUDS` 在写入时才抛「名字不在已证实表里」，日志却先报算法就绪——非 ASAP 写入路径不可达，测试未覆盖真实 calc |
| P1-15 | `tools/export-all-model-sysids.py:205-215,238-249` + `model-sysid-map.js:867-870` | 8 个模块 top=second 平票仍输出 `sysId/confidence=low`，平台级 high/medium 后直接 apply；例如 918S 三个模块 5:5 或 4:4 平票仍选首代际 sysId——平票被当成精确证据 |
| P1-16 | `tools/export-bind-plan.py:218-253` | 仍保留模块名前缀/最佳交集跨代推断，当前 151 个 crossgen 条目；与「无近似 join」口径冲突，需逐项区分精确证据与启发式 |
| P1-17 | `src/mfi-port.js:67-73,88-90` + 恢复/编程/例程路径 | addListener 句柄未保存，close 不移除，重连可累积 data/closed 回调；恢复/编程/例程不统一使用 `_writeBusy`，Elm 只保证单命令串行，不保证写事务完整，真机重连后可能重复处理或交错 |
| P1-18 | `app.js:37-46,60-69,166-183` | bind-plan/module-family/part-map/ident-registry 首次异常静默写 null 且永不重试；一次网络/打包失败会让整个生命周期降级 |
| P2-1 | `app.js:1014,2349` + `variant.js:196` + `schema.js:206` | `isValidVin`、`identMatchesSys`、`looksLikePartNumber`、`encodeValue` 等死代码/自创防御层仍在；测试还在验证运行时不再调用的 VIN 正则 |
| P2-2 | `schema.js:173` | 负数按绝对值 mask，不是补码：8 位写 -1 得 `[1]`，16 位写 -2 得 `[2,0]`；当前数据未发现负 min，故列 P2 |
| P2-3 | `app.js:3352-3355` | 开启 addrState 后 `!st` 仍 return true，与「未知地址拒绝」注释不符 |
| P2-4 | 多处 `catch{}`/`.catch(()=>{})` | ATFCSH、ATSP6、识别、加载失败等仍可静默降级；排障与验收无法区分「不支持」和「没执行」 |
| P2-5 | `schema.js:224-242,158-183` | 即使显式开启 range，也只比较 min/max，不检查位宽/有限数；实测 1 位字段写 2 被认为在范围内，随后 mask 成 0——安全增强开启也不能防非法值 |
| P2-6 | `tools/export-all-model-sysids.py:23` + `scripts/sync.mjs:106-110` + `rebuild:all-models` | 工具引用另一项目绝对路径，批量删除当前 project data/www data，无执行前清单/备份/小批校验；clean checkout 不可独立重建，当前 npm test 也因批量删除护栏中断 |
| P2-7 | `README.md:62-99,230` | 仍介绍值域拦截、可变 LID、19 失败切 18 等与当前实现不符的行为；`model-sysid-map.js:893` 仍有第三方工具名，匿名化门禁只覆盖 5 个文件，文档不是可信规范 |

### 11.5 「文档写 A、代码做 B」仍未收口的直接例子

1. `ACCEPTANCE-MATRIX-431.md:10-12` 称默认无自创、仅剩 1 项缺口，但同文件 §3 实际列 5 项，且本轮新增多项代码级偏离。
2. 同文件 `:63-64` 称 UI 值域检查「只影响提示、不是门禁」，实际 `app.js:3202-3205,3332-3335` 直接 return，写帧不会发生。
3. 同文件把 autoRestore/range 描述成全路径默认关闭，但编程页仍自动恢复，主 UI 仍拦值域。
4. `app.js:194-202` 仍宣传「低字节跨代平移」，下一函数已删除该行为；`doWrite` 头注释仍写「变体未确认拒绝」，实现却默认变体放行。
5. `app.js:2829-2831` 称歧义保持未确认/拒写，随后代码默认落定并放行；`addrSafeForAction` 头注释仍称无确认，doWrite 实际有 confirm。
6. `CODE-AUDIT §10` 与 HANDOFF 顶部称「默认无自创、全绿」，被本轮实际代码、生成器产物和最小用例直接推翻。

### 11.6 尚未逆出 / 未得出结论 / 数据缺口

- OBD VIN 通道 `21 09 05/21 09 01` 的寻址与完整调用条件未证，当前未实现；Porsche 模板链固定使用当前 coder 地址，fresh 为 DME，可能是任意前模块。
- `SYSP:0x5E42C` 24 键语言表未导出，目录基名归一化不是原厂 strcmp 的完整等价物。
- 逐 ECU ODX SESSIONS 不在包内；会话固定主模板，不能声称全 ECU 数据驱动。
- `drivelinks.json` 没有 `modeVerified=true` 条目，原厂 securityModel mode 主路径未真正落地；写序言分派表也未提取全。
- 9X6/9X7/CS1/E1 平台代际未定；新代 0x14–0x16 路由 owner 缺口仍在；静态候选不是全车型完整覆盖。
- 多 sysId 的第二地址归属、n=0 行键到唯一 CAN 的运行时解析、表 A 非 +8 rx 的完整保留规则仍需按原始记录重建。
- 原审计中的 640 条 unknown name 记录、478 条旧代 comm 跳过、部分无可读/可写服务文件仍是数据侧开放项。

### 11.7 测试与验收真相

- 当前直接执行 `npm test`：**失败于 `scripts/sync.mjs:110` 的 www/data 删除安全护栏**，并没有跑完测试链；因此不能再写「npm test 当前全绿」。
- 绕过 sync 分开执行的主体套件观察为 **36 + 359 + 105 + 84 + 66 通过**，且 `node --check src/*.js` 全过；但这些结果**没有覆盖上述 P0**。
- `verify-all-models` 的 IC 断言只检查 cands 包含 07F1，没检查运行时实际选择 pairs[0]；静态源码 regex 也不能证明发帧顺序。
- `e2e-flow.mjs:355-383` 自写 3E00 验证旧 n=0 模型；`tools/walkthrough.mjs:220-221` 只凭错误串不含「恢复备份失败」就宣称恢复成功，未检查 ECU 块，默认不回滚也能通过。
- sync 还暴露 24 个 duplicate-key warning，但门禁不失败；这些 warning 是实质数据冲突，不应忽略。
- `tools/boot-smoke.mjs` 启动实际抛出 `StatusBar UNIMPLEMENTED`，输出仍为 `ok bundle 可加载`；它只证明没有某类未声明变量，不证明启动无运行时错误。
- `tools/verify-pending.mjs` 对 `mode 0x1d` 打印 `FAIL 0/32`，最终仍 exit 0；`e2e-flow` 多处绕过真实入口，模拟旧版 `runSequence` 输出、构造源码不存在的 `runReadBack`/`out` 等对象，不能把「参数存在且能跑通」当成实现一致。
- 项目已有实车诊断 `RE-RECOVERY-20261105` 本身记录 32 失败、0 可写，不是 0 失败；e2e 把通过数写成 105，HANDOFF/验收表又写成 84，是同一套件不同快照的混写。
- `probeAddressFor` 在 raw `elm.cmd` 改适配器地址后，`.setAddress` 仍显式改 tx/rx，不能把「没有 ReferenceError」当成链路已验证；必须检查实际候选和回帧。

### 11.8 建议修复顺序（先安全，再对齐）

1. **立即禁止实车写入**：先修备份 ECU 身份/跨服务缓存/缺 SID 默认值/seed provider 串模块/回帧过滤；为恢复与公共写 API 加真实拒绝测试。
2. **重建 bind-plan**：逐行保留 n，n 缺失不得当 0；直绑必须有唯一地址证据；保留表 A 原始 rx；运行时禁止 bindDirect 任意取首。
3. **修自动搜索与证据选择**：fresh/UDS/KWP 各自帧序；主名 VIN 同串归一；件号尾空格与逗号变体；platform 与 variant 证据同候选；删除取首/默认冒充证据。
4. **统一写政策**：UI、applyChange、restore、program、特殊功能同一 SAFETY 语义；明确哪些是有意偏离 431，不允许各路径各自实现。
5. **最后才更新验收矩阵**：门禁必须调用真实运行时函数并断言实际帧/实际选择，不再只匹配注释或 cands 包含关系。
