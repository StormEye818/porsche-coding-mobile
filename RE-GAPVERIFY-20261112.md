# RE-GAPVERIFY-20261112 — B-TO-A-CLOSURE §3 两缺口证据核验（只查证据，不改代码）

> 核验对象：`B-TO-A-CLOSURE-20261112.md` §3.1（9X6/9X7 type 高字节归属）与 §3.3（2 条 recOff 越界）。（历史快照：现行定论以 `PRD-FULLALIGN-431-20261113.md` 与 `npm run audit:align431` 为准）
> 证据源：`~/porsche-mapper/ref/decoded/*.BIN`（解密件）、`~/porsche-coder/ref/x431-porsche-v24.58/V24.58/*.so`、
> `data/*.json`、既有 RE-* 逆向记录。本文所有数字可按文中 偏移/命令 复算。

---

## 0. 判定一览

| 缺口 | 原结论复核 | 判定 |
|---|---|---|
| ① 9X6/9X7 type 高字节归属 | **部分对**：「需运行时」定性成立且消费点已锤死；但「10/10、20/20 全不同、任选拿错通讯参数」**错**（大半共享/仅 echo 差异）；「VIN 可判」缺 model→domain 一跳 | **维持缺口（缩窄）**：仅差异子集需运行时定 type；4 条阴性记档 |
| ③ 2 条 recOff 指向异文件 | **错**：不是跨文件引用，是**解析错位 1 字节**（块 count 多 1，第 3 条目实际是邻块头部），幻影 recOff = 邻块真 recOff 左移 8 位拼上 count 字节 | **可锤死**：修正解析边界即归零，GFS_CONFIG/ALL_EXDTCFILE「范围吻合」纯属巧合 |

---

## 1. 缺口① 9X6 / 9X7 的 type 高字节归属

### 1.1 原结论复核

| 原文断言 | 复核 | 结论 |
|---|---|---|
| 低字节 100% 静态可解（DSN 模块表 9X6 29 / 9X7 41） | 表记录 `[u8 sysIdLow][u16 nlen][name\0][u32 recPtr][u16 flag]` 逐条复算（9x6 @DSN:0x3A5EF、9x7 @0x3E31F），low 与权威 sysIds 集合吻合 | **对** |
| 高字节 ∈{0x01,0x02}/{0x04,0x05,0x06} 需运行时决定 | 消费点已找到：**sysId = (BV域<<8)｜sysIdLow，BV域 = `GetSysIdFromBv` 的 u8 入参**（§1.2）；包内无任何静态载体可产高字节 | **对（且可更精确：高字节=调用方入参）** |
| 已排除 6 个静态载体 | 全部复证，并补第 7 条：**DSN 模块表与身份记录跨域字节级共享**（§1.4） | **对** |
| 同低字节跨 type comm 记录体 10/10、20/20 全不同，任选拿错通讯参数 | **错**。逐字节对比（§1.5）：9X6 仅 7/10 真差异（1 条共享同记录体、2 条仅 sysId echo 差）；9X7 0x05↔0x06 仅 11/30 真差异（7 含 DME 共享、12 仅 echo），0x04↔0x05/0x06 才是 20/20 全不同 | **部分对**（仅差异子集「任选有害」） |
| 唯一率 9X6 3/29、9X7 3/41 | 与 `data/dsn-module-sysids.json` 一致 | **对** |

### 1.2 type 高字节消费代码（方向②）——已锤死

- **函数**：`GetSysIdFromBv`，libPORSCHE_READWRITE.so:0x15205c（Thumb 入口 0x15205d）。
  dynsym demangle（本机实测）：`_Z14GetSysIdFromBvhRSt3mapISshSt4lessISsESaISt4pairIKSshEEERSt6vectorIsSaIsEE`
  → 签名 **`GetSysIdFromBv(uint8_t BV域, std::map<string,short>&, std::vector<short>&)`** —— 高字节就是第一个 u8 入参。
- **指令级语义**（disasm-elf.py 0x15205c+，VA=文件偏移）：
  - `0x1520b2 blx` MyFopen("DSN.BIN")；头表 22 条循环 **`0x15213a cmp byte,[sp+0x3e] vs param0` 命中取 payloadOff**（0x15214e `ldr sb,[sp,#0x38]`）——即 **BV域 = DSN 头索引 id**。
  - `0x15217c lsls r0,#8`（param0<<8 → sp+4）；模块记录流循环至 **byte@rec+0 == 0xFF 终止**（0x1521e2）；名字 std::map find，未命中插入。
  - `0x152254 orr.w r3, r0, r1` = **记录 low ｜ (BV域<<8)** → `strh` 压入 vector（0x152266）。记录号=表行首字节=权威 sysIdLow（G1 30/30、992 60/60 `id==low` 既有交叉验证同源）。
- **归属来源（上游）**：BV域 是**调用方入参**，但**全包静态零调用点**（本轮三重扫描）：
  1. 27 个 .so 逐字节 Thumb-2 BL/BLX 目标扫描 → 0 命中（解码器经 `0x15222e bl #0x1d9ab8` 实测自证正确）；
  2. MOVW/MOVT 构造 0x15205c/0x15205d 扫描 → 0；数据段函数指针 `5d 20 15 00` 全包仅 dynsym 表项自身 1 处；
  3. 他库 dynstr 未定义符号（mangled 名含 `GetSysIdFromBv`）→ 0。
  → 调用走 `blx rN` 运行时分发（与 RE-TRACEABILITY「分发器」族一致），**归属源=运行时会话/车型选择态，包内静态不可见**。
- 附注：`Get9x1_Cs1ForVin`（SYSP:0x261f8）只管 9X1/CS1 家族，与 9X6/9X7 无关；其跳转表也不是本缺口的归属源。

### 1.3 方向①复核：「type 分布各归各代」→ 前提不存在，分布退化为 comm 目录差

- **9X6_ALLDATA / 9X7_ALLDATA（解密件）里根本没有 type 字段**。逐层实测：
  - 顶级目录 = `[u8 count][ [u16 nlen][name\0][u32 dataOff][u32 aux] × count ]`（9X6 count=29 @0x0、9X7 count=41）；aux ∈ {0,3}（BaseSys=3），无 type。
  - 变体块 = 指针头 + `[u32 keyId][u16 nlen]["0x70000001" 编码键串]…` 行——即已排除的「编码键串」载体，无 type。
- **type 字段唯一存在处 = PORSCHE_SYS_DATA.BIN 根表/comm 子表**（type=根表条目=comm sysId 高字节）。各 type 的模块目录（低字节集合）分布：

| 平台 | type | 模块低字节目录（comm 子表 sysId 全量） | 目录差 |
|---|---|---|---|
| 9X6 | 0x01 | {01,02,03,04,07,08,12,16,**24,27**,26,29}（12） | 0x01 独有 0x24=UEB、0x27=TargaDach/Verdeck |
| 9X6 | 0x02 | {01,02,03,04,07,08,12,16,26,29}（10） | — |
| 9X7 | 0x04 | {01,02,05,07,08,09,0B,0C,11,12,19,1B,1D,1E,1F,20,21,22,23,26}（20） | 最小目录 |
| 9X7 | 0x05 | 0x06 全集+{25=PTM,27=VDST,28=Targa}+0x41/0x44/BB–C0（34，另有 1 条 0x011E 解析溢出伪行） | 最大目录 |
| 9X7 | 0x06 | 0x04∪{0A,29,41,44,BB–C0}（30） | 无 25/27/28 |

- 目录「各归各代」**成立为装备清单差异**（9X6：0x01=含车顶 ECU 的一代，0x02=无；9X7：0x04⊂0x06⊂0x05 递增），
  但**全数据无任何 type↔车型/年款标签**：
  - `data/model-map.json`/`all-model-sysids.json`：车型→平台（9X6=911(964/993)/911(996)/Boxster(986)；9X7=911(997)/Boxster(987)/Cayman(987)），gen=null，不分 type；
  - `data/models/911_996_` 与 `911_964_993_` 与 `Boxster_986_` 变体集**逐文件相同（54/54 diff=0）**——平台级共享，不分车型；
  - DSN 头 id1/id2 同名 "9x6" 同 payloadOff，id4/id6 同名 "9x7" 同 payloadOff——**头表名字也消歧不了域**。
- `PorscheGetYearAndModel`（SYSP:0x22ad4）VIN[7]/VIN[11] TBB → modelId、VIN[9] → 年款，流程内确实拿到 车型+年款；
  但 **modelId/年款 → BV域(DSN id) 这一跳在包内无表、无名字、无年款标注**（Get9x1_Cs1ForVin 不覆盖 9X6/9X7）。
  装备推断假说（0x01=996/986 代、0x02=964/993 代；0x05=PTM/Targa 装备代）**只是推断，不作锤死依据**。

### 1.4 静态载体排除复证 + 第 7 条（新）

| # | 载体 | 本轮复核 |
|---|---|---|
| 1-6 | flag / dataOff / 变体块 / recPtr / .so 表 / sysDataOff | 维持排除（flag=0/0x1000/0x0200/0x01FF 位标志；dataOff 纯偏移；变体块编码键串；sysDataOff 纯 u32） |
| 7 | **DSN 模块表与身份记录跨域共享** | 9x6 id1≡id2 指同一表 @0x3A5EF；9x7 id4≡id6 @0x3E31F、id5 @0x3DFBE 为逐字节副本（41 行全同、recPtr 全同）→ 模块行/身份记录/识别串在候选域之间**字节级相同**，结构上不可能携带高字节 |

### 1.5 「不能任选」量化修正（comm 记录体逐字节对比，sysData-root-table commOff 全量）

对比口径：两 type 同低字节的 comm 记录体集合（按 commOff 起至下一记录首字节），三档判定：
SHARED-IDENTICAL（同 commOff 或逐字节同）/ ECHO-ONLY-DIFF（仅内嵌 sysId echo 不同）/ DIFFER（参数流真不同）。

| 平台 | type 对 | IDENTICAL | ECHO-ONLY | DIFFER（任选有害） |
|---|---|---|---|---|
| 9X6 | 0x01↔0x02 | 1（low 0x03 ABS/PSM，双记录 commOff 0x1456/0x187B 两 type 共用） | 2（0x26 SitzMemo、0x29 lwr） | **7**（0x01 DME、0x02 Tiptronic、0x04 Airbag、0x07 Klima、0x08 Kombi、0x12 pdc、0x16 Alarm） |
| 9X7 | 0x05↔0x06 | 7（0x01 DME + 0xBB–0xC0 共用 0x05 的 commOff） | 12（0x05/09/0B/0C/11/19/1B/1D/1F/21/22/26） | **11**（0x02/07/08/0A/12/1E/20/23/29/41/44） |
| 9X7 | 0x04↔0x05、0x04↔0x06 | 0 | 0 | **20/20 全不同**（原结论对此对成立） |

（差异内容核样：0x0107 vs 0x0207 记录头 `02 98 f1 b0 28…` 完全相同，差异=sysId echo + 尾部指针流
`0x0002330a…` vs `0x000229f6…`，指针目标区仅 1 字节差（`01 06 03 01` vs `01 06 03 00`）。
0x0501 与 0x0601 记录体逐字节相同（含 echo 0x0501）。）

**含义**：低字节正确时，9X6 有 3/10、9X7(05↔0x06) 有 19/30 的模块**任选高字节不改变通讯参数**；
真正「任选即拿错参数」的只有 9X6 7 条 + 9X7 0x04 参与的 20 条 + 0x05↔0x06 的 11 条。

### 1.6 识别串代际线索（方向③）——阴性

- 1A 9F 识别串（如 DME 的「P200」= ODX 版本码，AUDIT-20261110-IC-CHAIN R2 已证）住在模块身份记录（recPtr）的变体表里；
  身份记录跨域**共享同一 recPtr**（§1.4），识别串集在 0x01/0x02（或 0x04/0x05/0x06）之间**完全相同** → 形态区分平台可以（9x6 "A00/B04/9001" vs 9x7 "PDK_1000/ME78_40_Mj5/CDR30"），**区分不了同平台的 type**。
- 全 DSN `P[0-9]{3}` 521 处扫描：P200/P300/P400/P100 三簇（DSN 0x1C526/0x1DC15/0x6E8A8 附近，55B 定长行 `idx,0x33,串`）归属 9x1/CS1 域模块记录，与 9X6/9X7 无关。
- 9x6/9x7 模块变体名里的 Mj5/Mj6/Mj7（Modelljahr）只区分**变体**（变体选择层），不含 type 字段。

### 1.7 阴性证据记档（4 条）+ 判定

1. 9X6/9X7_ALLDATA 解密件**无 type 字段**（目录行/变体块结构实测，§1.3）——「type 全量分布对比」无对象，退化为 comm 目录差；
2. DSN 模块表/身份记录跨域字节级共享（§1.4）——静态载体归零；
3. comm 目录/记录体**无车型、年款标签**；车型数据目录 54/54 全同（§1.3）——type↔车型代映射在包内不存在；
4. type 高字节唯一产点是 `GetSysIdFromBv` 入参 BV域，**调用方静态不可见**（三重扫描 0 命中，§1.2）——model→domain 一跳无包内依据。

**判定：维持缺口，但缩窄。**
- 「需运行时」定性**成立**（且已精确到 BV域 入参=DSN 域 id）；
- 「需 VIN 决定」**尚不可证**：VIN→车型/年款已在流程内，车型/年款→BV域 这一跳包内无据；
- 「任选拿错通讯参数」**只对差异子集成立**（9X6 7/10、9X7 见 §1.5 表）；共享/echo 子集在低字节正确前提下任选无害——收 A 可先按「差异子集保持回退、共享子集直接落地」切分，无需实车。
- 剩余可锤死方向：继续逆 BV域 调用方（`blx rN` 分发注册表/JNI 边），或实车 VIN 日志比对 GetSysIdFromBv 实参。

---

## 2. 缺口③ 2 条 recOff「指向异文件」——可锤死（原结论错）

### 2.1 原结论复核

原结论：0x0f41/0x0f51 末条 recOff = 18537735 / 19267858 落在 GFS_CONFIG(26MB)/ALL_EXDTCFILE(19MB) 范围，判「异文件引用/抽取越界」，显式拒写。
**复核：错。是解析错位 1 字节，不是跨文件引用。**

### 2.2 新证据（字节级）

- 两条目原始字节（PORSCHE_DRIVELINKS.dec.bin，118172B）：
  - ecu 0x0f41 block@0x1122 count=3：`03 | 70 41 b1 25 01 00 | 71 41 b1 25 01 00 | 02 8d 07 dd 1a 01`
    「第 3 条目」@0x112F = `02 8d 07 dd 1a 01` → 幻影 bk=0x8D02、recOff=**0x011ADD07=18537735**。
  - ecu 0x0f51 block@0x116D count=3：「第 3 条目」@0x117A = `03 74 12 01 26 01` → 幻影 bk=0x7403、recOff=**0x01260112=19267858**。
- **块边界实测**（179 块 × 目录 blockOff 全量）：176/179 满足 span==1+6×count；仅这 2 块 count=3 而 span=13（=1+2×6）——**物理上只容 2 条目，第 3 条目字节=下一目录块的头部**：
  - 0x112F 是 **ecu 0x0f07 的块**：`02 | 8d 07 dd 1a 01 00 | 8e 07 f6 1b 01 00` → 真条目 bk=0x078D recOff=**0x00011ADD=72413**、bk=0x078E recOff=**0x00011BF6=72694**；
  - 0x117A 是 **ecu 0x0f12 的块**：`03 | 74 12 01 26 01 00 | 75 12 2c 26 01 00 | 76 12 01 26 01 00` → 真 recOff=**75265/75308/75265**。
- **幻影 recOff=真 recOff 移位拼装（恒等式成立）**：
  `0x011ADD07 == (0x00011ADD<<8)|0x07`（0x07=邻块 count 字节）、`0x01260112 == (0x00012601<<8)|0x12` ✓✓
  —— 幻影值是 1 字节错位的纯算术伪影，与任何文件无关。
- **结构不变量**：全部 1070 条正常条目满足 `bk>>8 == sysId低字节`（ECU-ADDRESSING「blockKey=0xNNxx，NN=sysId 低字节」同款）；仅这 2 条幻影违反（0x8d、0x74 无对应 sysId）。邻块真条目全部合规（0x078D/0x078E→0x0f07 ✓、0x1274…→0x0f12 ✓）。
- **真 recOff 全部在体内且是合法记录**：@0x11ADD mode=0x4c、@0x11BF6 mode=0x4c、@0x12601 **mode=0x1d state=u32@+4=0x18BD**（恰=已知 3 条 0x1D 记录状态 0x18BD/0x623D/0x4E86 之一，互证）、@0x1262C mode=0x2e；family=0x01、session=0x0304 全部正常。
- **范围巧合澄清**：18537735 与 19267858 **同时落在两个大文件的范围内**（GFS_CONFIG 26,129,956B、ALL_EXDTCFILE 19,533,960B；18537735 < 两文件、19267858 < 两文件）——「各指一个文件」的归属无字节依据，任何 ~18-19M 数值都「命中范围」。
- **两文件格式（表头 dump）**：
  - GFS_CONFIG.BIN：`74 4a 65 01 | 08 00 00 00 | 0b 06 00 "de_DE" 00 8d 00 00 00 | 06 00 "en_GB"…` = 多语言键值/偏移表（de_DE/en_GB/en_US…），@18537735 处是 u32 偏移流（`3a 01 00 9a…`）——非记录体；
  - ALL_EXDTCFILE.BIN：`10 03 03 00 "E1" 00 50 d5 86 00 | 04 04 00 "9x7" 00 ad 00 00 00…` = 平台标记的 DTC 码表（码串如 `1AD0F$0xF001AD14`、`0013698$0xF0010824`），@18537735/19267858 处是 DTC 码串——非 drivelinks 记录。
- **431 读取循环的边界处置**（libPORSCHE_FILE.so `Xml_GetDriveLinksEntry` @0x188e4，逐指令）：
  MyFopen(**单个** PORSCHE_DRIVELINKS.BIN 句柄) → 目录 8B/条扫描（终止符 0x7FFFFFFF，0x1893a）→
  读块 count 字节 → **按 blockKey（入参 r3）逐条目匹配**（0x18998+ 循环）→ 命中才 fseek(recOff) 读记录
  （`Xml_GetDriveLinksAddress` @0x18a0c：fseek(recOff)+freadEx×2，同一句柄）。
  - **无跨文件分派**（全程一个句柄，recOff 只是该文件内偏移）；也无「按文件类型分派」代码；
  - count 驱动循环同样会读到幻影行，但**选行受 blockKey 约束**（bk=0xNNxx，NN=sysIdLow）——幻影行（bk=0x8D02/0x7403）永不匹配、永不 fseek；未命中回落「块首条目」也是真行（0x4170/0x5167）。
  - 即 431 既不是「拒写」也不是「特殊处理」——**幻影行在 431 里天然不可达**。

### 2.3 判定

**可锤死：解析错位，修边界即归零。**
- 正确口径：块条目数以 目录 blockOff 间距为准（或校验 `bk>>8==sysIdLow` / `0xFF` 记录终止），0x0f41/0x0f51 块各 2 条；
- 修复后 0x0f41/0x0f51 的 mode=null 两条消失（75185/75224 的正常行保留），0x0f07/0x0f12 各得 2/3 条在体记录（含一条 0x1D+state 0x18BD，可按既有 0x1D 口径接入）；
- `tools/rebuild-drivelinks.py` 的「越界→mode=null（异文件引用）」注释与 `B-TO-A-CLOSURE §3.3` 表述应更正（本任务只核验不动代码）。

---

## 3. 附：本轮可复算命令/偏移索引

| 证据 | 位置 |
|---|---|
| GetSysIdFromBv 签名 | `libPORSCHE_READWRITE.so` dynsym `_Z14GetSysIdFromBvhRSt3map…` st_value=0x15205d |
| BV域<<8 拼装 | 同 so VA 0x15217c（lsls #8）、0x152254（orr）、0x152266（strh 压 vec） |
| DSN 头域匹配 | 同 so VA 0x15213a（cmp id vs param0）；DSN 头 22 项 @DSN.BIN:0x1 起 |
| 9x6/9x7 模块表 | DSN.BIN 0x3A5EF / 0x3E31F（id5 副本 0x3DFBE） |
| comm 目录/记录体 | PORSCHE_SYS_DATA.BIN 根表 @0x0（type→off），commOff/sysDataOff 见 §1.5 表 |
| 幻影/真条目字节 | PORSCHE_DRIVELINKS.dec.bin @0x112F↔0x1130、@0x117A↔0x117B |
| 真记录 | @0x11ADD、@0x11BF6、@0x12601（0x1D, state 0x18BD）、@0x1262C |
| 两文件表头 | GFS_CONFIG.BIN @0x0、ALL_EXDTCFILE.BIN @0x0、幻影偏移处 dump 见 §2.2 |
