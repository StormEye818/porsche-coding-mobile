# 未收口项逆取收口（2026-11-11）

> 🔴 **2026-11-12 续：本文多处「不可证」结论已被进一步复核与落地，最新有效结论见
> [`FULLCHAIN-ALIGN-20261112.md`](./FULLCHAIN-ALIGN-20261112.md)。**
>
> 用户「所有内容一定都在包内」的质疑继续成立，本轮又推翻/收窄 4 项：
>
> 1. **§0/§3.1「逐 ECU 会话不可静态导出」→ 已落地**。comm 表 805 sysId 中 737 个有会话帧，
>    运行时实际用到的 **468 个零缺口**；`src/oem-session-table.js` + `Coder.setOemContext()`
>    让 `enterSession`/`enterSessionFor`/`applyChange` 按证据取会话，不再一律 `10 89`。
>    GAG 帧 flag（0=尽力而为 / 1=要求正响应）一并接入，避免把 `10 03` 当硬要求卡死写流程。
> 2. **§4.3「0x14-0x16 路由 owner 0 行 = 无地址证据」→ 推翻**。证据换了载体：comm
>    cat=0x10 子表内嵌本代 (A,C) 地址对，**112 个 sysId** 全部合法 11 位，DME `0x1401→0x7E0/0x7E8`、
>    网关 `0x1409→0x710/0x77A` 与实车一致。已接入 `data/bind-plan.json`（`commCat10`），
>    此前这些 sysId 只有一串跨代平移候选、命中率 0。
> 3. **§7「seed 族逐 mode 算法未逐个实现」→ 部分推翻**。生产 provider 的 `calc` 已写死
>    宽度契约，本轮显式声明 `seedWidths`，闸门从降级警告变硬约束。
> 4. **§3.2 / §5 维持「不可证」但收窄口径**：cat 是 comm 类别键（cat=0x60 为 185 个 ECU
>    共享的固定 4 帧模板），不是逐 ECU 写序言分派；老平台缺的是「车型→type 唯一链接」，
>    不是「包内无代际字节」（22 个 type 子表就是代际索引）。
>
> 回归：`npm test` 全绿（详见新文档 §6）。**本文下半部分的判定分级表与「仍未证」清单
> 保留为历史快照，不得再作为当前实现依据。**

> ⚠️ **2026-11-11 19:15 复核更新（重要：推翻本文两处结论）**
>
> 用户质疑「所有内容一定都在包内」——复核后**确认质疑成立**，两处结论被推翻：
>
> 1. **「SYS_DATA 记录体加密不可读」是错的**。加密的只是原始包
>    （`V24.58/PORSCHE_SYS_DATA.BIN`，YZJM 容器），而
>    `~/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN` 是**已解码副本**——
>    路由表 / comm 子表 / 名字记录一直读的就是它。按 `GetCommData @FILE:0x15580`
>    逐指令语义解析 comm 记录（874 条、805 sysId、全部 22 个 type）后：
>    - **逐 ECU 会话表已全量导出**（`data/sysdata-comm.json` +
>      `tools/export-sysdata-comm.py` + `tools/verify-sysdata-comm.mjs` 10/10）。
>      981 的 48 个模块：**16 个 `10 89`、32 个 `10 03`**——原厂并非一律 10 89。
>    - 命令 ID 全部经 **COMMAND.GAG**（3350 条，0 缺失）解析成真实帧，
>      如 `0x00200007→10 89`、`0x00200006→1A 9F`、`0x0020000A→10 03`。
>    - comm 记录还带**地址对**（(tx<<5)<<16|(rx<<5)）：DME=0x7E0/0x7E8 ✓（实车）、
>      网关=0x710/0x77A ✓（实车）——但它是**家族默认值**（同低字节跨代相同；
>      PSM=0x713 在 992 集合、不在 981 集合），不能当按车型地址。
> 2. **「OBD 目的 CAN ID 包内不存在」升级为强证据**：`PorscheReadVehicleVin`
>    硬编码 `token+0x65c=0xFBE0FD00`，按同款编码解出 **tx=0x7DF（功能广播）/
>    rx=0x7E8**；失败回退 `0xE200EF40` = 网关 0x710/0x77A（实车已证）。
>    即原厂读 VIN 首选链路 = 0x7DF 广播期望 0x7E8 回帧——与 `readVinByObd` 的
>    实现选值一致（现在有包内依据，不再是纯标准值）。
>
> **由此产生的新对齐缺口（如实记录）**：当前 `enterSession` 仍按族流程一律
> 目标 `10 89`，与原厂逐 ECU 会话（2/3 模块为 10 03）不一致；进模块时已在日志中
> 显式暴露该差异（`原厂会话=10 xx … 未对齐`），按 ECU 重排进模块序列是下一步工作。
> 逐 ECU 写入白名单也因此有了数据基础（会话证据齐了），但写入放开仍需逐模块验证。

> 对象：`main@63101c4` 之后的工作区。
> 范围：HANDOFF / CODE-AUDIT §11.6 列出的五项——OBD VIN 地址、24 键表、逐 ECU 会话与写序言、
> 多 sysId 归属、老平台代际；附带表 A 的 rx 规则与 seed 宽度。
> 判定分级：**A = 已证可落地**（有字节/指令/原始记录）；**B = 强证据但缺一环**（写清缺什么）；
> **C = 包内不可证**（给出证明边界，不再重复尝试）。所有地址若无特别说明，
> 均为 **ELF VA = 文件偏移**（该包 `.text`/`.rodata` 的 `sh_offset == sh_addr`）。

---

## 0. 一页结论

| 项 | 判定 | 结论 | 本轮落地 |
|---|---|---|---|
| 24 键表 | **A（已全量导出）** | 不是「语言表」，是 **24 条车型名 + vehicleId 的白名单**，`strcmp` 全等 | `src/model-name-table.js` + `pickModelByName` 精确匹配优先 |
| OBD VIN 地址 | **C（地址不可证）/ B（可实现）** | 原厂零参数、走「一对多」VCI 发送；**目的 CAN ID 不在包内**；包内三层扫描均无 | `Coder.readVinByObd()`：0x7DF 广播 + 严格 `61 09 05`/`49 02` 校验 |
| 逐 ECU 会话 | **B（生产者已定位，载体加密）** | 会话类别字节来自 `PORSCHE_SYS_DATA.BIN` 的 `GetCommData` 记录，**该文件是加密容器** | 不放开写入；固定 10 89 仍标「未证」 |
| 写序言 A/B/C/D | **C（按 ECU 分派不存在）** | 在 `SysTemWriteData`/`PorscheMcrCodeWrite`/`WriteCodeEx`/`McrCodeChileWrite` 内**没有**分派读；只有不同入口各自的固定序列 | 维持 `runWritePrologue` 无调用方 |
| 多 sysId 归属 | **A（981 已钉死）/ B（全量）** | 平台内只有 **5 个** 双 sysId 模块，且两值地址候选**完全相同**；LCA 是「身份 ≠ 地址键」 | 记录 `identitySysIds`，不合并语义 |
| 老平台代际 | **C（结构性不可证）** | 9X6/9X7/CS1/E1 的变体名在**每一代**都注册，名字 join 天然一对多；ALLDATA 目录无代际字节 | 保持 `unresolved`，运行时走枚举 |
| 表 A rx | **A（规则唯一）** | 表 A **没有独立 rx 字段**；`rx = tx+8`；`0x7F8-0x7FF` 是应答段、`0x800+` 是 12 位空间 | 生成器硬拒绝 + `rejectedPairs` 留证 |
| seed 宽度 | **B（口径已纠）** | `PORSCHESecurityModel` 第一参数是 **seed 族**，不是会话号；宽度 2/3/4 | 宽度闸门 + 声明式 `seedWidths` |

---

## 1. 24 键表：不是语言表，是车型名白名单（A）

### 1.1 表位置与结构（逐指令）

`libPORSCHE_SYSP.so`：

- `PorscheGetVehicleNameID @0x24DE4`
  - `0x24E02 ldr.w r9,[pc,#0x60]` → 字面量 `0x0003961E`（位于 `0x24E64`）
  - `0x24E0A add r9, pc`，PC = `0x24E0E` → **r9 = 0x5E42C**
  - `0x24E10 cmp r4,#0x17` → 循环 **24 次**（0..23）
  - `0x24E1C add.w r0,r9,r4,lsl#2` → `0x24E28 ldr r6,[r0,#4]` ⇒ 第 i 项 = `u32@(0x5E42C+4+4i)`
  - `0x24E26/0x24E2C` 以 `0x1E` 字节缓冲解析该键文本；`0x24E32 blx strcmp`
  - `0x24E3A bne 0x24E10` ⇒ **逐字节全等，不命中就下一条**；命中返回该键（vehicleId）

`0x5E42C` 在 `.rodata`（VMA `0x566A0-0x62148`）。表头 `u32 count = 24`，随后 24 个 `u32` 文本键。

### 1.2 24 条（GBK 原文 + vehicleId）

| # | vehicleId | 文本键 | 文本 |
|---|---|---|---|
| 1 | 1 | `0xFF000001` | Carrera GT（CS1） |
| 2 | 2 | `0xFF000002` | 918 Spyder（918） |
| 3 | 15 | `0xFF00000F` | Macan（J1） |
| 4 | 4 | `0xFF000004` | Cayman（通用名，不带代际） |
| 5 | 5 | `0xFF000005` | Taycan（J1） |
| 6 | 23 | `0x00300152` | 911（996） |
| 7 | 7 | `0xFF000007` | 911（997） |
| 8 | 8 | `0xFF000008` | 911（991） |
| 9 | 9 | `0xFF000009` | 911（992） |
| 10 | 10 | `0xFF00000A` | 911（964/993） |
| 11 | 16 | `0xFF000010` | Cayenne（9PA） |
| 12 | 29 | `0xFF00001D` | Cayenne（92A） |
| 13 | 29 | `0x000003FB` | Cayenne（92A）（同文本第二条，命中序在 12 之后） |
| 14 | 18 | `0xFF000012` | Panamera（970） |
| 15 | 30 | `0xFF00000E` | Panamera（971） |
| 16 | 19 | `0xFF00001E` | Panamera（YA） |
| 17 | 20 | `0xFF000013` | Boxster（986） |
| 18 | 21 | `0xFF000014` | Boxster（987） |
| 19 | 22 | `0xFF000015` | Boxster（981） |
| 20 | 24 | `0xFF000016` | Boxster（982） |
| 21 | 28 | `0xFF000017` | Cayman/Boxster（987） |
| 22 | 31 | `0xFF000018` | Cayman/Boxster（981） |
| 23 | 25 | `0xFF00001C` | Cayman（982） |
| 24 | 27 | `0xFF00001F` | Cayman GT4 Clubsport（982） |

### 1.3 这条逆出来纠正了什么

旧文档（`ACCEPTANCE-MATRIX-431.md:79`、旧 `variant.js` 注释）把它叫「24 键**语言**表」，
于是运行时用「车型目录基名归一化」当等价物——**方向错了**：

- 它是**厂商名白名单**，比较对象是车上 `22 11 02 / 22 11 01` 的应答串；
- `strcmp` 是全等，连大小写都不归一；
- 它自带 `vehicleId`，即原厂在「自动搜索」阶段就已经拿到车型 id，不需要我们反推。

**落地**：`src/model-name-table.js` 保存 24 条（键、vehicleId、GBK 文本、可选目录映射）；
`pickModelByName` 第一层走全等白名单，命中且能唯一映射到目录车型才返回；
通用名（如 `Cayman`）返回 null 交用户确认；第二层才用原有的「基名全等」兜底，
并在 `how` 里标注「扩展兜底」，与原厂行为区分。

---

## 2. OBD VIN：地址在包内不可证，但可实现（C + B）

### 2.1 三层扫描都没有地址

1. **APK 层**：`DiagnoseService.open_readVinByObd()` **零参数**（smali
   `open_readVinByObd()V`），只把 `21 09 05` 交给「一对多发送」(ONE_TO_MORE) 的盒子；
   同层的 `21 09 01` 是应答确认，回空、不带 VIN。
2. **.so 层**：`libReadOBDVIN.so` 的 `OBD_ReadVIN @0x7434` 走协议循环，
   `ShowTitleVin @0x7324` 构造的是 `09 02`（`0x734A-0x7350`），**不是** `21 09 05`。
3. **资源层**：全包 `.so` 字节扫描没有 `21 09 05` 模板；`3E07E2` 处的真实模板是
   `21 09 01 05`（四字节），也与 `21 09 05` 不同。

结论：`21 09 05` 的目的 CAN ID 由 **VCI 盒子固件**在「一对多」通道内填，
包内不存在该映射。任何写成「原厂固定 0x7DF / 固定 7E0」的说法都是猜测。

### 2.2 可实现方案（明确标注为适配层）

ISO 15765-4 的 OBD 功能地址是 `0x7DF`（标准值，非包内常量）。我方：

- `ATSP6` + `ATSH7DF` + 清 `ATCRA`，发 `21 09 05`；
- **只认** `61 09 05` + 17 位 VIN 字母表（`[A-HJ-NPR-Z0-9]{17}`，无 I/O/Q）；
- 失败再发 `09 02`，只认 `49 02` + 17 位；
- NRC / 空 / 长度不符 / 含非法字符一律判负；不扫描、不换地址重试；
- 结束后**恢复原物理寻址**，不影响后续读写。

`Coder.readVinByObd()` 已实现；`autoSearch` 只在主链读不到 VIN 时调用一次，
日志标注来源（`21 09 05@0x7DF` / `09 02@0x7DF`）。

---

## 3. 逐 ECU 会话与写序言（B / C）

### 3.1 会话类别字节的生产者已定位，但载体加密

- 会话类别来自 `PORSCHE_SYS_DATA.BIN` 的 comm/`GetCommData` 记录（每个 ECU 一条）。
- 该文件的**正文是加密容器**：解码后的 `PORSCHE_SYS_DATA.BIN` 只有目录/名字/路由行可读，
  会话类别所在的记录体尚未解出。
- 因此「逐 ECU 会话号表」在当前包内**不可静态导出**；固定 `10 89` 只能继续标注为
  「主编码会话模板 / 未逐 ECU 验证」。

**影响**：写入白名单不扩大。981 Cayman DME 仍是唯一 `verified` 写 profile。

### 3.2 写序言 A/B/C/D：不存在「按 ECU 选择」

复核 `SysTemWriteData @READWRITE:0x0F855C`、`PorscheMcrCodeWrite @0x0F2F88`、
`PorscheWriteCodeEx @0x0F8D4C`、`McrCodeChileWrite @0x0FE678`：

- 四个函数内**没有**读取 ECU/记录字段来选择序言的指令；
- 它们是**不同入口各自的固定序列**，不是一张分派表；
- `RE-FLOWSPEC §9.5` 所说「形态已实证、分派表未提取全」，实际应修正为
  **分派表不存在**（至少不在这四个写入口里）。

因此 `runWritePrologue` 保持无调用方是正确状态；不要为了「补齐」把它挂进写路径。

### 3.3 口径纠偏：`PORSCHESecurityModel(param_1, param_2)`

- `param_1` 是 **seed 族**（`0 / 0x100 / 0x102 / 0x304 / 0x506`），决定取 seed 命令与
  **seed 宽度**（2/3/4）；`param_2` 才是 mode。
- 旧文档把它写成「session（会话号）」，会导致把 `0x304` 拼成 `10304` 这种畸形帧。
- 宽度未声明的 provider 拿到 3/4 字节 seed 时，key 正确性无法离线保证。
  **本轮**：`securityAccessEx` 增加宽度闸门——provider 声明 `seedWidths` 后为硬约束；
  未声明时只对「原厂 seed 族已知宽度（2/3/4/6/8）」放行，其余拒绝计算。

---

## 4. 多 sysId 归属（A / B）

### 4.1 平台内真正的「双 sysId」只有 5 个，且地址候选相同

按 `data/all-model-sysids.json` 逐平台统计（平台内，不跨代）：

| 平台 | 模块 | sysIds |
|---|---|---|
| 9X1 | Hinterachslenkung | `0x0E59 / 0x0E5A` |
| 9X1 | SCHEINWERFER_LED | `0x0E2F / 0x0E30` |
| 9X1 | Sitzsteuergeraet | `0x0E4C / 0x0E4E` |
| 9X1 | TUER_HINTEN | `0x0E4F / 0x0E50` |
| 9X1 | TUER_VORNE | `0x0E1E / 0x0E1F` |

对 `data/bind-plan.json` 逐对核对：**每一对的两个 sysId 的 `pairs` 完全相同**
（例如 `0x0E4F/0x0E50` 都是 `0x07DB→0x07E3`）。
所以「只展开首枚导致第二地址不可达」在这 5 个模块上**没有实际后果**——
不是地址丢了，而是两个 sysId 本来就指向同一组记录。

### 4.2 真正的坑是「身份 sysId ≠ 地址键」

`BV_ContrUnitLaneChangAssis2UDS`（981 车道变换）：

- **身份**：`0x0E5F / 0x0E60`，证据是 0x0E 代 comm 子表精确 join
  （`BV_ContrUnitLaneChangAssis2UDS_BaseSys`，`parse_comm_subtable` 名前缀精确匹配）。
- **地址键**：`0x0F4D`，证据是 DRIVELINKS 中唯一持有直连键 `0x003006CC-0x003006CF`
  （车道变换惯用段）的 ECU 键。

两者语义不同，**不能互相替代**：用 0x0E5F 去查地址会查空；用 0x0F4D 当身份会跨代。
本轮把两者同时写进 `data/981-sysids.json` 的 evidence 字段，运行时仍用 0x0F4D 取地址
（与现状一致），但不再让文档暗示「0x0F4D 就是它的 sysId」。

### 4.3 新代 0x14-0x16 没有路由 owner 行

`data/sysdata-routing.json` 的 `byOwner` 中，`0x14 / 0x15 / 0x16` 开头 owner **各 0 条**。
即 992 / Taycan / Cayenne 9YA 的静态候选只能来自：
`drivelinks-v3` 的直连键、跨代同系统表 A ∩ 路由表、DME 路由组。
这些来源在 `bind-plan.json` 的 `provenance` 里已逐条标注，**不能当成 owner 级证据**。

---

## 5. 老平台代际（C，结构性不可证）

对 9X6 / 9X7 / CS1 / E1 分别做了三种尝试，全部失败，且失败原因是**结构性的**：

1. **名字交集**（现有方法）：`9X6 = 0 交集`、`E1 = 7:7:7 平票`、`CS1 = 218:218 平票`、
   `9X7 = 10:10:10 平票`。
2. **去平台前缀后再交集**：`9X6_` / `E1_` / `_9x7_` 前缀可以剥掉，但结果仍是平票
   （3:3:3、7:7:7、10:10:10）——因为同名子系统在**每一代**的 comm 子表里都注册。
3. **name-9 投票**：对已知平台校准就不可靠（918S 投出 0x0E 而非 0x10，992 投出 0x0B 而非 0x14），
   不能用于未定案平台。

另外：ALLDATA 顶级目录只有 `[u16 nlen][name][u32 off]`，**没有代际字节**；
变体记录的 8 字节尾部是 `(数据偏移, 数量)`，也不含 sysId。

结论：**用包内现有已解码结构无法定这 4 个平台的代际**。要么继续解 `PORSCHE_SYS_DATA.BIN`
的加密记录体，要么按车型实测反推。当前运行时保持 `unresolved → 不走平台专属 sysId，
用全局表/枚举**，这是正确且安全的降级。

---

## 6. 表 A 的 rx 规则（A）

- 原始路由行是 16 字节：`[u32 owner][u8 sigA][u8 sigB][u8 sel][u8 ff][u32 can][u32 m]`。
  **没有 rx 字段**；`data/ecu-addresses.json` 里的 `rx` 是导出器用 `tx+8` 算出来的。
- 全表 209 条里只有 2 条 `rx != tx+8`：`0x07FC→0x0804`、`0x07FD→0x0805`。
  两者都只是 `tx+8 > 0x7FF` 的溢出值，而路由表里确实存在 `0x0800` 这样的值
  （原始记录 `02 06 00 00 03 02 0B FF 00 08 00 00 6D 00 00 00`）——
  说明该字段是 **12 位地址空间**，不是 11 位 CAN ID。
- 生成器本轮改为：
  - `tx > 0x7F7` → `rejectedPairs: tx-in-response-range`（0x7F8-0x7FF 是应答段）；
  - `tx > 0x7FF` → `tx-not-11bit-request`；
  - `rx > 0x7FF` → `rx-not-valid-for-11bit`；
  - **绝不 `&0x7FF` 回绕**（旧实现会把 `0x7FC→0x0804` 变成 `0x07FC→0x0004`）。

复算结果：`rxRejected = 2`，`pairs` 中不再存在任何 `tx > 0x7F7` 或 `rx > 0x7FF`。

---

## 7. 仍未证项（明确列表）

- OBD `21 09 05` 的**目的 CAN ID**：包内不存在，需盒子固件或总线抓包。
- 逐 ECU 会话号：被 `PORSCHE_SYS_DATA.BIN` 的加密记录体挡住。
- 写序言与 ECU 的对应关系：不是在写入口分派，来源未定位。
- 9X6 / 9X7 / CS1 / E1 代际：结构性不可证（见 §5）。
- 0x14-0x16 路由 owner：数据里就是 0 行，需原厂更新的数据包。
- seed 族 → 2/3/4 字节宽度的**逐 mode 算法**：宽度已证，算法未逐个实现。

以上都不能用「测试全绿」替代。当前策略保持一致：**未证即只读，未证即不猜地址**。
