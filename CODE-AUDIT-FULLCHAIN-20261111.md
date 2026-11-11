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
