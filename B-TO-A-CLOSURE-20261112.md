# B 级差异 → A 级收口（2026-11-12，第十一阶段）

> 触发：用户问「几个 B 对齐成 A 有卡点么？」。两路独立只读逆向 + 主线独立复算/反汇编复现。
> 基线：`247cfb7`（第十阶段全量审计）→ 本轮工作区。
> **结论：10 项 B 中 8 项零卡点已落地收成 A；2 项真卡点按证据边界保留。**
> 同时更正第十阶段报告中的三处错误判定（见 §1）。

---

## 0. 直接回答

| 问题 | 回答 |
|---|---|
| 把 B 对齐成 A 有卡点吗？ | **8 项没有卡点**（缺的只是代码/口径，字节证据全在包内或已由反汇编逐指令坐实）；**2 项有真卡点**（9X6/9X7 的 type 高字节归属需运行时 VIN；92 个 family-default 候选的地址收敛缺逐 ECU 唯一地址证据） |
| 需要实车测试吗？ | 这 8 项都不需要；2 项真卡点里，9X6/9X7 需 VIN/实车识别应答或继续逆 `Get9x1_Cs1ForVin`，候选收敛需逐地址身份核验 |
| 真车行为变了吗？ | 变了几处，但都是有字节证据的对齐：CS1/E1 模块 sysId 接入、`22 11 02` 绑定失败补帧、统一写事务；**写闸门与会话号判定未放宽**，seed/key `0x1D` 生产路径仍受 `modeVerified` 闸门约束 |

---

## 1. 更正第十阶段的三处错误判定

| # | 第十阶段的说法 | 更正 | 证据 |
|---|---|---|---|
| 1 | 「老代 4 平台模块→sysId = 纯 u32 数值表、无 ASCII 名字集、**结构性不可证**」 | **错，载体找错了**。老代 `sysDataOff` 确实是纯数值表（与 ALLDATA/DSN 偏移精确交集 0），但 `DSN.BIN` **每个平台都有一张模块名索引表**，记录首字节就是 sysId 低字节 | 主线独立复算：DSN 头 22 项 + 14 平台模块表 821 条；模块名与 ALLDATA 目录 29/29、41/41、15/17、47/48 吻合；G1 30/30、992 60/60 的 `id==sysId低字节` 交叉验证 |
| 2 | 「4 条 mode 0x1D 依赖**运行时 TOKEN 内存态**、静态包里没有」 | **错**。加数就是 `drivelinks.json` 已导出的 `state`（记录 `rec+4` u32），静态可算 | 主线独立反汇编：`libPORSCHE_FILE.so:0x18A74 cmp r0,#0x1d → move_lib_data(rec+4 → TOKEN+0x408838)`；`PORSCHESecurityModel:0x209DE ldr r0,[r0,#0x408838]` + `0x209E0 add.w r9,r0,r5`（r5=seed）。离线 32 点真值表 `want==seed` 正是 TOKEN 态=0 的情形 |
| 3 | 「`22 11 02` 是普通 DID 读、注释误读，大概率是伪缺口」 | **错**。确实是绑定失败补帧 | 主线独立反汇编：`libPORSCHE_LINK.so DriveLinksMode_1001`，`0x18FC0 cmp r0,#1 / beq 0x194B8`（=1 走成功）；≠1 时 `0x18FE2 movw r0,#0x1102` + `movt r0,#0xFF00` → 命令 ID `0xFF001102`，`blx r3` 发出。COMMAND.GAG index 470 = `01 03 22 11 02` |

---

## 2. 已落地的 8 项（零卡点）

| # | B 项 | 落地方式 | 验收 |
|---|---|---|---|
| 1 | 平台代际运行时接入 **CS1 / E1** | 新增 `tools/build-dsn-module-sysids.mjs` → `data/dsn-module-sysids.json`（14 平台 821 条）；`tools/export-all-model-sysids.py` 对原本 0 模块且单 type 的平台补 `dsn-module-index` 映射，`confidence` 升 high → 编译进 `src/model-sysid-map.js` | CS1 **14/16** 唯一映射（1 组同名多 id 排除）、E1 **35/48**（12 个 `id=0` 无独立 sysId 子模块 + 1 歧义）；运行时 `sysIdForModule('Airbag','Carrera GT')=0x1304`、`('E1_EDC17','Panamera-970…')=0x0301`。车型启用平台专属映射 17→19/25 |
| 2 | 地址候选缺口（接入 E1 后暴露） | 重建链顺序补入 `export-variant-sysids.mjs`（479 个 sysId）与 `export-bind-plan.py`；31 个 `0x03xx` 老代 sysId 全部补上候选 | `bind-plan` 硬门禁：变体实解析 **479/479 全有地址候选（缺 0）**，`noCand` 归零；新增补源一律 `bindDirect=false` |
| 3 | seed/key **mode 0x1D** | `pswCalc(0x1D, seed, {state})` 实现 `key = seed + state`；**未装载 state 一律抛错拒写**（防止把 identity 当正解吃 NRC 0x35）；`PENDING_MODES` 移除 0x1D；`coverage`/`verify-pending` 按记录 state 对拍 | 离线真值 32/32 通过；覆盖率 real 962→**966**、拒写 6→**2**；`verify-pending` 刻意拒写 1→**0**；smoke-fixes 新增 3 条安全断言 |
| 4 | `22 11 02` 绑定失败补帧 | `src/app.js` 的 `ATSH/ATCRA` 回执失败分支补发一帧 `221102`；**补帧响应不作为绑定成功依据**，仍跳过候选（R4 安全约束保持） | 门禁断言 `cmd('221102', 800)` + 「补帧响应不作为成功依据」+ 仍 `return null` |
| 5 | family 未定 → 写闸门关闭 | `familyOfItems` 加 `writeSid` 兜底（`0x3B`→kwp、`0x2E`→uds，全库 0 条 `0x22+0x3B`，互斥证据） | 33 个 `writeSid=0x3B` 变体由 items 可定族；19 个 `0/0` 是只读项，闸门本就不该放行。另 type 0x0B–0x16 共 645 sysId **100% 有 `10 xx`、0 个 `81` KWP 帧**，可作代际兜底 |
| 6 | `_writeBusy` 只保护 `applyChange` | `Coder.withWriteLock(fn)` 统一写事务；`applyChange` 改走它；恢复页、含写命令的功能序列、编程页写类操作三处裸 `uds` 全部纳入；纯读序列不加锁 | 门禁断言 4 处 `withWriteLock`；全套回归 16 项 0 失败 |
| 7 | 读 VIN 回帧 ID 不校验 | **口径更正**：原厂 OBD 也是 `0x7DF` 功能广播 + 任意 ID + 固定响应头 `61 09 05`/`49 02` + ISO3779 内容校验；当前实现本就是 A，不改代码 | 门禁不再把 `anyRx:true` 记为「差异」 |
| 8 | 24 键 `vid` / 归一化 vs strcmp | **口径更正**：`vid` 是项目自造的辅助字段（`PorscheGetVehicleNameID@0x24DE4` 命中返回的是 key 本身 `0xFF0000xx`）；trim/括号归一化是有意兜底，不参与原厂分派 | 文档/注释如实标注，不改运行时行为 |

**未随之改动的两项（刻意）**：
- **地址态闸默认关**：原厂本无地址态闸，AUDIT §4 已写明「默认关才是对齐 431」，加严反而是自创增强。
- **sessionless 上的服务专属会话**（routine/io/measure 仍发 `1040/1085/1003`）：零真实卡点，但「老代 KWP ECU 执行 UDS 例程时原厂用什么会话」缺逐条脚本证据，队友判 B（部分靠推断）。**不擅自改**，按 B 保留。

---

## 3. 保留的 2 项真卡点

### 3.1 9X6 / 9X7 的模块 → type 高字节归属

- 低字节 **100% 静态可解**（DSN 模块表：9X6 29 条、9X7 41 条）。
- 但高字节在 `{0x01,0x02}` / `{0x04,0x05,0x06}` 之间必须由**运行时 VIN/识别应答**决定。逐一排除 6 个可能载体：模块 flag（位标志，非零值不落 type 集合）、ALLDATA `dataOff`（纯偏移）、变体数据块（编码键串）、`recPtr` 身份记录、`.so` 静态表（4 平台模块名 0 命中）、`sysDataOff` u32（与 ALLDATA/DSN 偏移精确交集 0）。
- **不能任选**：同低字节跨 type 的 comm 记录体 10/10（0x01 vs 0x02）、20/20（0x04/05/06）**全不同**，选错会拿到不同通讯参数。
- 唯一率：9X6 3/29、9X7 3/41。生成器 `runtimeModules` 故意留空，`gen=null`、`apply=false`，这两个平台的 6 个车型继续走全局表回退。
- 要收成 A 只能靠实车 VIN 日志，或继续逆 `libPORSCHE_SYSP.so:0x261F8 Get9x1_Cs1ForVin` 的跳转表 —— **这是运行时态，不是包内静态字节**。

### 3.2 92 个 family-default 候选的地址收敛

- `ident-registry.json` 覆盖 **12/92（13%）**，且语义错配：它解决「已知地址 → 哪个变体」，这里要解「多候选 → 哪个是本 sysId」，构成循环依赖；其 148 个变体名平台标记只有 9x1/E2/G1/981/991/918S，**无老代平台**。
- 探针链只验证「有应答」，首个应答即绑定。但这 92 个里 **74 个是 cat=0x60 固定模板**（`22F1A2`×86、`1003`×81、`22F19E`×78），原厂自己可能就是「有应答即绑」——所以这项更接近**参照系判错**而非「我们缺实现」。
- 可收敛方向：comm 精确 tx/rx 配对（已有 111 条 `commCat10Exact`）或实车逐地址身份核验。**provenance 已诚实标注「非按车型唯一，必须探针验证」，不冒充收敛**。

### 3.3 另 2 条 seed/key 边界（非真卡点，但保持拒写）

`drivelinks.json` 里 `0x0f41` / `0x0f51` 的 `recOff` 是 18537735 / 19267858，指向 `GFS_CONFIG.BIN`(26MB) / `ALL_EXDTCFILE.BIN`(19MB) 范围，是**异文件引用/抽取越界**，不是本解密体（118KB）内的记录。不靠猜补 mode，保持显式拒写并在文档中标注。

---

## 4. 回归与交付

`npm test` 全绿，**16 项门禁**：
`test-align431` 38 / `smoke-fixes` **362** / `e2e-flow` 105 / `verify-pending` **69（刻意拒写 0）** /
`walkthrough` 84 / `verify-all-models` **72** / `verify-runtime-safety` 24 / `verify-sysdata-comm` 16 /
`verify-oem-session` **29** / `verify-oem-frames` 34 / `verify-fullchain` 30 /
`verify-write-gate` 36 / **`verify-fullchain-audit` 53** / `check-bundle` / `boot-smoke` / `name-map-coverage`。

`node tools/coverage.mjs`：1072 条记录 → real **966** / noAlgo **104** / 拒写 **2**（0.2%）。

**新增/修改文件**：
- 新增 `tools/build-dsn-module-sysids.mjs`、`data/dsn-module-sysids.json`、`B-TO-A-CLOSURE-20261112.md`（本文）
- 数据重建：`data/all-model-sysids.json`（schemaVersion 2）、`data/variant-sysids.json`、`data/bind-plan.json`、`src/model-sysid-map.js`
- 源码：`src/coder.js`（withWriteLock / familyOfItems / 0x1D）、`src/app.js`（补帧 / 三处写锁）、`src/seedkey-pswcalc.js`、`src/seedkey-resolver.js`
- 工具/门禁：`export-all-model-sysids.py`、`coverage.mjs`、`verify-pending.mjs`、`smoke-fixes.mjs`、`verify-all-models.mjs`、`verify-oem-session.mjs`、`verify-fullchain-audit.mjs`、`package.json`（rebuild 链接入 DSN 生成器）
- 文档：`TAKEOVER.md`、`AUDIT-20261112.md` 顶部指向本文

> 口径纪律：A = 有原始字节/指令证据且实现一致；B = 有证据但存在差异；C = 确认缺陷。
> 「测试全绿」不作为对齐证据。本文所有数字均可由文中命令/文件:偏移复算。
