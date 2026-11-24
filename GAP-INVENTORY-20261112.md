# GAP-INVENTORY-20261112 — 全链缺口/待办清点表（第十二阶段交付②）

> 三修复（RE-GAPVERIFY-20261112 落地）后的**整条链**逐条清点（本文为历史快照，现行定论以 `PRD-FULLALIGN-431-20261113.md` 与 `npm run audit:align431` 为准；§2 41 行基线原文逐字保留，U-2 单一真值见文末 §5）：
> 连接→VIN→车型→平台代→寻址→变体→会话→读→写→seed/key→恢复/批量/编程页→数据层。
> 分类：**A 已清** / **B 运行时边界（431 同界，非缺口）** / **C 承诺外** / **D 真待办**。
> 来源全扫（不许粉饰）：`ACCEPTANCE-MATRIX-431` §3、`AUDIT-20261112` §4 八项已知边界、
> `B-TO-A-CLOSURE` §2/§3 保留项与两项刻意保留、`AUDIT-PROTOCOL` 4 待办、`AUDIT.md` L1/L2、
> `HANDOFF` 全部「待办/待修/未决/未证」、`RE-*` 未决清单（TRACEABILITY/ICADDR/DISCOVERY）、
> `BUCKET-LISTS` 未决、代码 TODO 注释（src/*.js **0 条**）、`analysis/sa2` 留档。

---

## 0. 总判

| 问题 | 答案 |
|---|---|
| 全链还有代码级缺口吗？ | **无**。三修复归位后，所有曾经的「缺口/拒写/越界」项均落入 A/B/C，**D 里没有代码级缺口**（5 条 D 全部是取证/低危数据项，见 §3）。 |
| 全链还有待办吗？ | **有 5 条真待办（D）**：纯取证/真车语义/低危数据清洗级，全部零真实卡点；另 5 条承诺外（C，含 6 对孪生「不承诺左右」）与 14 条运行时边界（B，431 同界）。 |

**计数（§2 全表 41 行）：A 17 · B 14 · C 5 · D 5**（逐条见 §2，D 逐条见 §3）。

---

## 1. 三修复落地 + 回归数字

| 修复 | 落地 | 断言（全部通过） |
|---|---|---|
| ③ 块边界错位 1 字节 | `tools/rebuild-drivelinks.py` / `export-drivelinks-v3.py` / `export-ecu-address.py` 三处解析统一：条目数以目录 blockOff 间距为准 + `bk>>8==sysId低字节` 不变量；「异文件引用」注释更正（RE-GAPVERIFY §2） | 原 2 条 recOff 越界拒写**归零**（nulls=0）；真 recOff 72413/72694/75265/75308 全在体内（75265=0x1D+state 0x18BD 互证）；选行不变量 **1070/1070**（431 语义不变）；recordCount 1072→1070（`verify-fullchain-audit [6]` 6 条 + smoke 口径行） |
| ② 绑定后身份裁决 | `src/probe.js`（identityFramesFor/identityVerdict/identityAdjudicate/TWIN_GROUPS）+ `src/app.js` tryAddr `finish()` + `src/mock-adapter.js` 身份帧（1A9B 系统名/22F19E ODX 文件标识） | mock 身份不符→**换下一候选**（0x7E0 拒→0x7E1 绑定）；**孪生对进哪个都过**（互换身份 twin-match 双向）；KWP 只发 1A9B 不发 0x22；app 接线钉死（`verify-fullchain-audit [7]` 8 条） |
| ① 共享子集收 A / 真差异标 B | `ACCEPTANCE-MATRIX-431` §3 #5 行 + `B-TO-A-CLOSURE` §3.1/§3.3 顶部核验标注；**不动运行时代码**（现成域 id 传递链核查：`platform-type-map.typeCandidates` 仅在数据层、`MODEL_SYSID_INDEX` 未编译域候选 → **无链可接，按「无就标注」处理**） | 共享子集 9X6 0x03（同记录）+0x26/0x29（仅 echo）3/10、9X7 0x05↔0x06 7 条同记录（DME 等）+12 条仅 echo 共 19/30 → **任选无害，数据级收 A**；真差异 9X6 7 条（0x01/0x02/0x04/0x07/0x08/0x12/0x16）+9X7 0x05↔0x06 11 条+0x04 参与 20/20 全异 → **运行时 BV 域语义边界**（GetSysIdFromBv 运行时入参，431 同界，非待办）。口径注：任务表述「9X6 真差异 3 条」与 RE-GAPVERIFY §1.5 逐条复算（7 条）不一致，按证据 7 条落表（3=共享子集条数），逐模块名单如上可点验 |

回归：`verify-fullchain-audit` **89/0**（历史 53→67→89）、`smoke-fixes` **373/0**、`e2e-flow` **118/0**；
drivelinks 1070 条 / mode=null 0 / 违规 0；coverage 口径 有算法 966 / 无 case 104 / 拒写 0（=mode 0x1D 有 state 即算，越界 2 条已随幻影消失）。

---

## 2. 逐阶段清点表

| 阶段 | 项 | 类 | 依据/现状 |
|---|---|---|---|
| 连接 | ELM AT 层 + 回帧 ID 硬校验（mock 跳过）；VCI 命令族全表收口 | **A** | RE-TRACEABILITY 未决计数=0（照抄级） |
| 连接 | 适配器目标解析=适配器内部映射（calcLinkCode 同式 7/7；SetAddress/FilterId≡ATSH/ATCRA） | **B** | 机制边界=适配器层，**431 同界**（HANDOFF 2026-11-09(6) 终态） |
| 连接 | n=0 链路绑定用 ATSH/ATCRA 回执等价（VCI `send(0x100359,A,2)` 无 ELM 对应物） | **B** | 适配器能力差异；帧数=0 与原厂一致（矩阵 §3 #2） |
| VIN | 0x7DF/0x7E8 广播 + `21 09 05`/`49 02` + ISO3779 校验；模板链 8 帧序；年款三档；VIN 分派 TBB 17 槽 | **A** | 0xFBE0FD00 解出；OBD 通道历史结论已推翻后落地 readVinByObd |
| VIN | 广播路径回帧 ID 不校验（anyRx） | **B** | 有意：OBD 广播语义 + 固定响应头/内容校验兜底（B-TO-A #7 口径更正） |
| VIN | VIN 字符集主链与 OBD 链口径不一 | **D** | AUDIT-20261112 §4 #7 残留；低危统一项（§3 D-4） |
| 车型 | 24 键车型名表逐项一致；车型名全等匹配 | **A** | SYSP 0x5E42C 24 条复算一致 |
| 车型 | `vid` 非原厂返回值、匹配含 trim/括号归一化（非 strcmp） | **B** | 有意兜底已如实标注（B-TO-A #8 口径更正，不参与原厂分派） |
| 平台代 | DSN 头 22 项索引 / platform-type-map / CS1→0x13、E1→0x03 接入（14/16、35/48 唯一映射） | **A** | B-TO-A #1 落地 |
| 平台代 | 共享子集（任选高字节无害） | **A** | 修复①：9X6 3/10 + 9X7 05↔06 19/30，数据级收 A（RE-GAPVERIFY §1.5 逐字节） |
| 平台代 | 真差异子集 + model→BV 域一跳无包内据（阴性 4 条：ALLDATA 无 type 字段/身份记录跨域共享/无车型年款标签/调用方静态不可见） | **B** | **运行时 BV 域语义边界**：GetSysIdFromBv 运行时入参，431 同界；剩余可锤方向=逆 `blx rN` 分发注册表/实车 VIN 日志（记档不挂账） |
| 平台代 | 9X6/CS1 老平台模块就那些（源包数据量） | **C** | 源包限制（AUDIT-431-3） |
| 寻址 | bind-plan 全量候选（479/479、noCand=0）；重复直绑 6 例已强制探针+身份；probeList 低段地址统一；alias/低字节平移删除 | **A** | B-TO-A #2 + AUDIT-20261112 #4/#6 |
| 寻址 | 92 个 family-default 候选收敛 | **A** | 修复②落地后按身份裁决收敛（应答即绑+身份比对，不匹配换候选） |
| 寻址 | `22 11 02` 绑定失败补帧（原厂 0x18FE2，补帧响应不作成功依据） | **A** | B-TO-A #4 |
| 寻址 | 9X1 KWP IC（internal 0x02F9）/ 0x0C08 静态一选不存在（表A 缺 KWP 代行） | **B** | **431 亦运行时探测**（RE-ICADDR 未决计数 0）；矛盾保留不换 join 再猜 |
| 寻址 | ECU_ADDR `candidate`（OBD 标准位猜测）表项 | **B** | 运行时探测/身份裁决自证（431 同界发现循环） |
| 寻址 | R6 网关/总线路径假说（三假说需实验判定）；「internal→CAN 无换算⇒运行时探测」推断 | **B** | 推断已由 DriveLinksMode_1000/1001 逐指令坐实（RE-DISCOVERY）；残余=真车实验自证 |
| 寻址 | **6 对孪生（数据互换）**：前门/后门/座椅/前照灯/变道/后桥转向 | **C** | 修复②显式标注**「不承诺左右」**（TWIN_GROUPS，AUDIT-431-3 侧条目互为镜像）；孪生对进哪个都过 |
| 变体 | 变体=JOB.BIN memcmp/件号分词（1A84/87/91/92/94）/平台限定/identMatch 原语 | **A** | RE-VARIANT/RE-FLOWSPEC 转写 |
| 会话 | 逐 ECU 会话数据驱动（805 sysId、1005 序列/3350 帧）；GAG flag=0 不卡写；sessionless 统一护栏 | **A** | AUDIT-20261112 #1/#2 已修 + 会话表落地 |
| 会话 | 68 个老代 KWP 原厂不建 UDS 会话 | **B** | 数据驱动即对齐（不是所有 ECU 都发 1089） |
| 会话 | sessionless 上服务专属会话（routine/io/measure 发 1040/1085/1003）：老代 KWP 执行 UDS 例程的原厂会话缺逐条脚本证据 | **D** | 零真实卡点、纯取证（§3 D-1；B-TO-A 两项刻意保留之二） |
| 读 | 读帧构造（21/22/1A）+ 识别链 + 回读 | **A** | RE-FLOWSPEC §3 + e2e 逐帧 |
| 写 | 写闸门按对齐矩阵 3817/3817 放行；13 项写帧判定 A；7F78 写 SID 不重发；回读不一致记录失败；withWriteLock 统一写事务（含恢复/批量/编程页）；双入口拒写统一 | **A** | B-TO-A #5/#6 + WRITE-GATE-OPEN |
| 写 | 地址态闸默认关（默认关即对齐 431）；family 未定→闸门保守关闭 | **B** | 有意边界（原厂无地址态闸）；结果由 ECU 裁决+回读兜底（AUDIT §4 #1/#2） |
| 写 | 写结果由 ECU 裁决（NRC/回读） | **B** | 运行时不确定性，431 同界 |
| seed/key | 算法面 100%（29 mode+24 变体、wordvm 9×288 点、新旧 1080 点 0 差异）；0x1D=seed+state（未装载拒写）；mode 路由=记录真值 | **A** | B-TO-A #3 + sa2 收口 |
| seed/key | 修复③后 mode=null/越界拒写归零（1070/1070） | **A** | 本文 §1 |
| seed/key | DRIVELINKS 无记录的 5 个 sysId（0x0e57/0x0ea5/0x0e02/0x0e58/0x0e44，981 映射中 6 行） | **B** | 包内无记录 → mode 不猜、写路径保守（431 同界：同一 DRIVELINKS 文件） |
| seed/key | needsKey:false 生产路径不可达（104 条 mode 0x00 均未标 modeVerified；实跑 962/1070 条 modeVerified=true） | **B** | 记档（安全设计，非缺口） |
| 恢复/批量/编程页 | 5 处 diagProfile 一致；3 处裸 uds 入写锁；无读服务不写；备份 sessionless 标志 | **A** | B-TO-A #6 |
| 恢复/批量/编程页 | 例程 ID 合法性（79 条真机通信取证、252 请求） | **B** | ID 层已证；**语义层=真车确认边界** |
| 恢复/批量/编程页 | 例程 ID→功能语义未定（routines-verified caveat；与手工索引交集仅 1） | **D** | 真车确认待办（§3 D-2） |
| 恢复/批量/编程页 | 编程/特殊功能源包只给清单不给例程 ID 的项（noRid 16 条） | **C** | 源包限制（承诺外） |
| 数据层 | drivelinks 1070/1070 结构不变量+幻影归零；条目去重/bit 校验；859 模块全映射；枚举值落地（580/961，其余为数值域） | **A** | 修复③ + 数据层历轮收口 |
| 数据层 | addrBlock 行 u16=A 低16 打包形态（请求键坐标，⑤ 定案）；14B 记录族仅作运行时候选 | **A** | RE-TRACEABILITY ⑤ 定案（旧「语义未证」撤销） |
| 数据层 | SPECFG.INI [SYS_SPEC] 对账（外部 SD 卡不在包内）；`1A 87 XX` 3 字节仅 SPECF 验证链 | **C** | HANDOFF「留白 3 项（证据级非待办）」 |
| 数据层 | BUCKET-LISTS 归桶依据未决（逐条目桶归属离线不可解） | **C** | 定案「不造规则」，如实标未决 |
| 数据层 | 枚举 34 条 maxText 异常值（如 '次' 计数项 maxText=超长数字） | **D** | 低危清洗项（§3 D-5） |
| 数据层 | 代码-数据断接（itemIds 格式/浏览态 coding-v2 口径/500 截断） | **D** | 非主链路（per-model 主数据源可用）（§3 D-3） |

---

## 3. D 真待办逐条（5 条，全部零真实卡点）

| # | 项 | 性质 | 要点 |
|---|---|---|---|
| D-1 | 老代 KWP 上 UDS 例程/IO/measure 的原厂会话取证 | 纯取证 | 现发 1040/1085/1003；缺逐条脚本证据，不擅自改（B-TO-A 两项刻意保留之二） |
| D-2 | 例程 ID→功能语义真车确认 | 真车验证 | routines-verified 79 条只证 ID 合法；与 special-functions 手工索引交集仅 1，语义以真车为准 |
| D-3 | 代码-数据断接（itemIds↔coding-v2 口径、非 981 浏览态、500 截断） | 低危数据 | 主链路（进模块读块/写）不受影响；浏览态一致性待统一 |
| D-4 | VIN 字符集主链/OBD 链口径统一 | 低危 | AUDIT-20261112 §4 #7 残留 |
| D-5 | 枚举 34 条 maxText 异常值清洗 | 低危数据 | Boxster 981 抽样 34/961；不影响读写帧 |

## 4. 来源覆盖（逐个扫过，可复查）

- `ACCEPTANCE-MATRIX-431` §3 #1-5 → 本文 VIN/连接/车型/平台代各行；
- `AUDIT-20261112` §4 八项：#1→写 B、#2→写 B、#3→寻址 A+C、#4→寻址 A、#5→写 A、#6→会话 D-1、#7→VIN/车型 B+D-4、#8→seed/key A；
- `B-TO-A-CLOSURE`：§2 八项均已 A；§3.1→平台代 A/B（修复①）；§3.2→寻址 A+C（修复②）；§3.3→seed/key A（修复③）；两项刻意保留→写 B / 会话 D-1；
- `AUDIT-PROTOCOL` 4 待办：换会话号→会话 A；写前编排按 ECU 分派→D-1 同族（runWritePrologue 无调用方、cat 语义表待坐实，并入 D 范畴，见 FULLCHAIN-ALIGN #125「维持不挂+待坐实」）；level/key 长度→seed/key A；地址扫描填表→寻址 A+B；
- `AUDIT.md` L1（缺 lid/sid）→数据层 A（per-model 已 100% 带 lid/readSid/writeSid）；L2（硬编码 0x7E0）→寻址 A；
- `HANDOFF` 待修项：枚举表→数据层 A（580/961 已落地）；侧别合并→C（孪生）；代码-数据断接→D-3；9X1 KWP IC/0x0C08 未决→寻址 B；u16 语义未证→数据层 A（⑤ 定案）；留白 3 项→C；
- `RE-*`：TRACEABILITY 未决=0、ICADDR 未决=0（0x02F9/0x0C08 终态=B）、DISCOVERY Mode_1000/1001 已锤死、RE-GAPVERIFY 阴性 4 条→平台代 B；
- `analysis/sa2-coverage-audit` 风险留档→seed/key A（2026-11-09 已收口）；
- 代码 TODO 注释：src/*.js 全扫 **0 条**。

> 写序言 cat 分派一项口径说明：FULLCHAIN-ALIGN #125 原文「维持 C（分派表不存在），但收窄口径…记录 cat 语义表待后续坐实、runWritePrologue 维持无调用方」——
> 在本清点口径下归 **D-1 同族**（真待办=坐实 cat 语义；当前无调用方=不生效、零卡点）。

---

## 5. U-2 单一真值（2026-11-15 收口，现行定论）

> 本节是**现行唯一真值**。§2 的 41 行基线是 2026-11-12 历史快照、原文逐字保留，
> 其内出现的旧数字一律按本节作废并指向本节；权威数字清单由
> `tools/align431-eval.mjs:measureNumberSources()` 从 `data/*.json` **动态机读**（不硬编码份数），
> 复跑：`node tools/verify-u2-numbers.mjs`、`node tools/coverage.mjs`、`npm run audit:align431`。

| 历史值（作废） | 现行实测值 | 口径 / 来源 | 复跑命令 |
|---|---|---|---|
| 362/53（历史） | **50** | 唯一 `gate#assertion` 组合数（逐行 gate 表以 `npm run audit:align431` 输出为准）；复跑：`node -e "const r=require('./tools/align431-rows.json');const s=new Set([...r.baselineRows,...r.addedRows].map(x=>x.gate+'#'+x.assertion));console.log(s.size)"` | `npm run audit:align431` |
| 1072 / 拒写 2 | **1070 / 0** | drivelinks 记录数 / 拒写 | `node tools/coverage.mjs` |
| 962（旧值） / 拒写 4 | **966 / 0** | 真·有算法 / 拒写 | `node tools/coverage.mjs` |
| 92（候选数） | **120** | family-default sysId 数；92 另为 `GAP §2:60` 的 LID 字节（合法白名单，不是候选数） | `node tools/verify-d3-id-union.py` |
| 3817 | **4588** | 有静态地址证据的写闸门放行变体 | `npm test` |
| 34 | **13873** | `data/models/*` 的 maxText 现值条目（位宽显示，数据现值一字未改） | `node tools/verify-u2-numbers.mjs`（U2_D5_13873 实跑） |
| 45 个伪 RID | **44（动态值）** | 旧取证报告 45 为历史口径；按 `31 10/B8/B9/BA` 的 b[4:6] 逐字节动态算得 44，禁止为凑 45 放宽判据或补假记录 | `python3 tools/build-routines-verified.py --verify` |
| 99.8872%（历史值） | **Y/Y 动态值** | 归一前中间量；归一后 `distinct_itemids=292574`、`entity_resolvable_Y/Y=292574/292574` | `python3 tools/verify-d3-id-union.py` |
| 119657（归一前） | **292574（归一后）** | 119657=归一前 distinct itemids（500 截断口径）；292574=153 个节点回填后的归一后动态值；两种口径各自标源、不可混算 | `python3 tools/verify-d3-id-union.py` |

### 5.1 U-1 三件套补证（原 §2 :50/:54/:65/:68 四处高估，7 条缺件行重填）

> **本表由 `tools/align431-rows.json` 机读生成**（脚本见 §5.1 复跑命令），与 JSON 逐字段一致。
> 以下 7 行按 PRD §5 U-1 补齐「`src/` 代码路径 + `tools/verify-*` 断言名 + 431 证据坐标」，
> 逐行由 `node tools/verify-u1-triple.mjs` 按磁盘实况校验（三件套缺失=0）。
> §2 对应 41 行原文不改，本节为追加行（不删行、不合并行）。

| 缺件行 | U-1 ① `src/` 代码路径 | U-1 ② 门禁断言名 | U-1 ③ 431 证据坐标 |
|---|---|---|---|
| L41 | `src/elm327.js:cmdOk` | `tools/verify-fullchain-audit.mjs#FULLCHAIN_AT_LAYER` | `libPORSCHE_SYSP.so:0x24DE4` |
| L50 | `src/model-sysid-map.js:MODEL_SYSID_INDEX` | `tools/verify-hb1.mjs#HB1-T5-01` | `data/dsn-module-sysids.json:canonicalType` |
| L54 | `src/app.js:probeChainFor` | `tools/verify-oem-probe-diff.mjs#OEM_DIFF_PROBE_PHASE` | `libPORSCHE_LINK.so:0x18F2C` |
| L65 | `src/write-alignment.js:writeProfileFromAlignment` | `tools/verify-write-gate.mjs#WRITE_GATE_13_CHECKS` | `libPORSCHE_READWRITE.so:0x0F855D` |
| L68 | `src/seedkey-sa2.js:computeKey` | `tools/verify-write-gate.mjs#SEEDKEY_PRODUCTION_REACHABLE` | `libPORSCHE_FILE.so:0x18A74` |
| L72 | `src/coder.js:runWritePrologue` | `tools/verify-fullchain-audit.mjs#WRITE_PROLOGUE_WIRED` | `PORSCHE_SYS_DATA.BIN:0x649` |
| L77 | `src/schema.js:validateParam` | `tools/verify-u2-numbers.mjs#U2_NUMBER_DIFF_ZERO` | `data/sysdata-root-table.json:types` |

### 5.2 U-6 注释 / 时序一致性

> `src/app.js:426/435/646-650`、`src/probe.js:8/63/131`、`22 11 02` 三处注释与
> `data/bind-plan.json` 的 `rule` 字段已由 **T03 定稿代码覆盖**（T03 阶段完成，本批次禁碰 `src/`）。
> 本节不改代码，只如实标注；断言一律指向**实际帧序**而非注释文字：
> ②-a 探针阶段每候选 1 帧 `221409`/`1A9F`，②-b 身份裁决在 `enterSystem` 后按
> `3E00→22F19E→22F1A2→1003` 四帧 + `data/ident-registry.json` 判据，
> 由 `tools/verify-oem-probe-diff.mjs` 的 `OEM_DIFF_IDENTITY_PHASE_2B` 硬断言逐帧复跑。

### 5.3 681→454 口径证明

> `data/menu-tree-v3.json` 的 `911（991）` ECM/DME 节点 `codingCount431=681`
> 是 **431 侧含重复 + 跨模块计数**口径；HEAD 版该节点 `itemIds` 500 条中仅 343 唯一（157 重复），
> 按包内 `coding-v2.json ∪ data/models/*/*.json` 的 modelSeg+module 前缀+chain 同源扩集、
> 去重排序后得**唯一 id 全集 454**（`codingCount=454` 与 `itemIds.length` 一致）。
> 227 的差额是 431 重复计数与跨模块口径，不是丢数据。
> 复跑：`python3 rebuild-all.py --explain-911-991`（见 `MENU_911_681_TO_454_PROOF`）。
