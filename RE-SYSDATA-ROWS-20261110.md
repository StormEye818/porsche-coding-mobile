# RE-SYSDATA-ROWS-20261110 · SYS_DATA 统一行格式 + 981 sysId 代际修正（第三轮深挖）

> 承接 ANSWERS-20261110.md 的三问答复。本轮把「地址数值来源」从「表在包内」推进到
> 「哪张表、哪个字段、为什么之前 join 不对」。所有结论都有字节偏移证据。

---

## 1. PORSCHE_SYS_DATA.BIN（解码副本）行格式统一

### 1.1 三种 16B 行族（全部实测）

**A 族（sig 行）**：`[00 00 03 02][u8 sel][u8 ff][u16 K][u16 0][u16 M][u16 0][u16 T]`
- 证据：DME @90471 `00 00 03 02 17 ff df 07 00 00 10 01 00 00 09 0c`
- K=can 时：M=internal、T=attr（旧「表A」）；K=0x0C08 时：M=internal 0x2F9（sysId 行）。
- 全文件 1315 行（sig 对齐口径）。

**B 族（ff 行，无 sig 前缀）**：`[u8 ff][u16 A][u16 0][u16 B][u16 0][u16 C][u16 0][u8 x][u8 y][u8 sel]`
- 证据：PSM 键行 @117572 `00 00 03 02 08 ff 39 03 00 00 20 00 00 00 05 0c`（A 族形态，K=0x339 请求键、M=0x20、T=0x0C05=PSM sysId）
- ff 对齐口径全文件 4636 行（z1=z2=z3=0 过滤）。
- A=can(0x600–0x7FF) → B=internal/组键：748 行（全局路由，跨车型）。
- A=sysId → B=internal：1294 行（含 0x0C08→0x2F9）。

**C 族（新发现，01 01 t ff 行）**：`[u32 X][u8 01][u8 01][u8 t][u8 ff][u16 K][u16 0][u32 internal]`
- 证据：@149041 `d2 19 00 00 01 01 03 ff 08 0e 00 00 37 04 00 00` → K=**0x0E08**、internal=**0x437**
- @133177 `74 18 00 00 01 01 03 ff e0 0f 00 00 f9 04 00 00` → internal=0x4F9（IC 另一 internal）
- X（0x18ED/0x19D2/0x1A46…）疑似名字表偏移；t=类型字节(02/03/04/06/07)。

### 1.2 请求键语义修正（推翻旧解释）

- **DRIVELINKS 记录候选全是 0x0030xxxx 请求键**（PASM 0x003005C4…、DME 0x003005BF…、IC 0x00300335），
  含「正常模块」——旧「候选=CAN 地址」解释**不成立**。
- 请求键 = `(行 flags 0x0030)<<16 | 低16键值`。链路层 `send(key, 0xFF001409, 1)` 把键交给通讯层解析
  （DriveLinksMode_1001 @LINK:0x18f00 逐指令，见 RE-DISCOVERY-20261110 §1）。
- **0x0E 代（UDS 新一代）的键低 16 位有时本身就是 CAN**（Lift_VA 0x00300771→0x771、
  SWSG 0x00300763→0x763、Verdeck 0x00300765→0x765）——这就是这些模块能直连的原因。
- 旧代（0x0B/0x0C）键需走 SYS_DATA 键行间接：PSM 0x337→internal 0x1CC→can 簇（0x6DE…0x7C2，PSM 家族）。
  DME 0x5BF/0x5D0 的键行是 B 族变体（B=0x29F/0x2E、C=0x1906/0x0C0A），链路不完整——见 §4。

## 2. 981 sysId 代际修正（本轮最重要发现）

SYS_DATA 名字表按**平台代际分段**，同名模块在不同段有不同 name-9 sysId：

| 名字 | 0x0B 代 | 0x0C 代 | **0x0E 代（9X1 段）** | 0x0F 代 |
|---|---|---|---|---|
| Kombiinstrument_MM | — | — | **0x0E08** @66224 | 0x0F08 @220016 |
| PSM | — | 0x0C05 @45929 | **0x0E05** @65208 | — |
| Rueckfahrkamera_II | 0x0B51 @41859 | 0x0C51 @60721 | **0x0E51** @80334 | — |
| SCHEINWERFER | 0x0B58 @37630 | 0x0C58 @52625 | **0x0E58** @73855 / 0x0E2F @73543 / 0x0E30 @74109 | 0x0F58 @227496 |
| ERA_GLONASS | 0x0BA5 @37884 | — | 0x0EA5 @80991 | 0x0FA5 @231599 |
| Lift_VA | — | — | **0x0E5B** @79601 | — |
| PASM_PADM | — | — | 0x0E13 @68794 | — |

- **9X1 段 ≈ 偏移 57900–81000**（“9x1”×78、“981”×24 标记密集；段内名字与 9X1_ALLDATA
  顶级目录 48 系统名一一对应：PSM_BaseSys/PSM_a1…、Kombiinstrument_MM_BaseSys…、
  PDCC_9x1_a2_2、SCHEINWERFER_LED_DK2F_001、Lift_VA_Gen2、Frontkamera、Rueckfahrkamera_II…）。
- **`src/module-ecu-map.js` 现把 981 模块映射到 0x0B/0x0C 代的 sysId（0x0B08 IC、0x0C05 PSM、
  0x0B51/0x0B58/0x0B57/0x0BA5）——错代。** 其中 0x0B51/0x0B57/0x0B58/0x0BA5 在
  DRIVELINKS 目录里根本不存在（209 键全表核对）。
- 这直接解释了上车现象「0x7F1 回 NRC 但不是 IC」：0x0B08 的候选来自组键 0x00BC（0x0B 代
  组地址），根本不是 981 IC（0x0E08）的通道。

## 3. DRIVELINKS / bind-plan 事实核对（981 48 模块）

- 目录 209 键（含 0x501–0x626 旧代、0x0B–0x0F 各代），**bind-plan 204 键全部在目录内**。
- 48 模块经 MODULE_TO_ECUID：33 有候选、15 空。15 个拆解：
  - **9 个** = 0x0E 代记录存在且 **n=0 直接绑定**（0x0F4D/0x0E59/0x0E5B/0x0E13/0x0C05/0x0C37/0x0E27 等）
    ——这是 431 行为本身（cbz 分支），不是缺口；
  - **4 个** = 名字映射到不存在的 sysId（§2 错代）；
  - **其余** = 0x0E 代地址未入 bind-plan（ecu-addresses 的表A join 只覆盖旧代——
    0x0E internal（0x437/0x4F9…）在全局 can-行里**没有**对应，见 §1.2/§4）。
- **export-bind-plan.py 的 cands 来源是 ecu-addresses（表A），不是 v3 记录键**——
  「无候选」是导出 join 的覆盖问题，不是 431 缺数据。

## 4. libPORSCHE_FILE.so 解析链（逐指令）

- `GetSubSysDataAddr` @0x15c19：子系统记录 = `[名字\0][u32×6]`（+flag&0x51 时再读 2 个 u32
  → ctx+0x61c、ctx+0x638=编码数据流）；ctx+0x600=模块基址；ctx[2]≤0xA 走 IdSearch 键搜索分支。
- `Xml_GetCodingAddress` @0x17dc1：编码数据流头部 = **`[u8 n][u32×n][u32×n]` 两组平行数组**
  （ctx+0x4075a8 / ctx+0x407670）——**这就是「编码地址对」的包内形态**。
- `GetCommData` @0x15581：读 ctx+0x5fc/0x600 区域，按类型字节 1/2/3/4/0x20/0x60 分派，
  u32 数组入 ctx+0x670——通讯参数（键→通道）的真实消费者。
- PLT 映射（修正）：0x13e5c=`move_lib_data(lib,off,dst,n)`、0x13ebc=`ReadStrFromFile`、
  0x13ec8=`strcmp`、0x13e44=`OpenSearchIDDll`、0x13e50=`MyFopen`。GOT 基址 0x69a84。
- `CODINGFILECFG.BIN` 解码后是明文 XML（`SYSINFOR Car="992"→MAPFILE FileBase=…xml`），
  仅新车（992 等）使用；981 走 BIN 路径。

## 5. 9X1_ALLDATA.BIN 结构（已定案部分）

- 顶级目录：首条 `[u24 off][名字\0]`，其余 `[u32 off][u16 nlen][名字]`（9X1 索引见
  porsche-mapper/ref/analysis/9X1_ALLDATA-index.json，与手工解析一致）。
- 二级目录（变体行）：`[u32 dataOff][u32 count][u16 nlen][名字]`
  （ACC3_BaseSys→0x32DC、ACC3_A2→0x36F97A、Airbag_A2_4_9x1→0x34F16A…）。
- 变体块：`[5×u32 指针][u32 计数][记录…]`，记录含 `[22 2e …]["0x…" 键串]`（coding-v2 的源头）。
- 命令行区（0x6D1000–0x790000，3344 行）：`[u16 can][02 f0][flag][00][idx][命令字节…]`
  ——DME 16 变体表 cans 0x7DC–0x7EA/0x6054–0x6059；约 19 份重复（疑似按车型变体一份）。
  **归属（哪张表属于哪个模块）未定案**——这是地址静态化的最后一跳。

## 6. 修正对照（旧说法 → 本轮事实）

| 旧说法 | 本轮事实 | 证据 |
|---|---|---|
| IC = sysId 0x0B08 | **981 IC = 0x0E08**（0x0B08 是 0x0B 代/其他平台） | §2 name-9 + 9X1 段字符串 |
| 981 PSM = 0x0C05 | **981 PSM = 0x0E05**（0x0C05 是 970 段） | §2 |
| 候选 = CAN 地址 | 候选 = 0x0030xxxx 请求键；0x0E 代低 16 位常为 CAN 本身 | §1.2 |
| 71 个「无候选」是数据缺失 | 9 个= n=0 直绑（431 行为）；4 个= sysId 错代；其余= 表A join 不覆盖 0x0E 代 | §3 |
| 地址只在车型文件 | 0x0E 代 internal 无全局 can 行 → **0x0E 地址确在车型文件/通讯层**；旧代在 SYS_DATA | §1.2/§4 |

## 7. 剩余开放项（收敛后清单）

> ✅ **2026-11-10 全部关闭**（执行与验收记录见 `RE-CODINGADDR-20261110.md` §5，
> 换表/路由/绑定计划产物：`data/981-sysids.json`、`data/sysdata-routing.json`、
> `data/bind-plan.json` v2；npm test 全绿）。

1. **981 sysId 重映射**：✅ `tools/export-981-sysids.py` 48/48（name-9 投票 + adjacency/
   isomorphic/drivelinks-key 收口），`src/module-ecu-map.js` 顶层块换 0x0E 代。
2. **0x0E 代地址静态化**：✅ 路由表 16B 记录提取（owner=代际前缀+系统低字节）+
   bind-plan 多源分级；44/48 静态解出（DME 0x7E0 四源收敛、PASM 0x7D0 跨代路由行）。
3. `Xml_GetCodingAddress` 的 `[u8 n][u32×n]×2`：✅ 格式定案（fseek ctx+0x638 →
   u8 n + 两组 u32×n）；981 无该流扩展（6×u32 后直接下一条记录）→ 981 编码地址走
   9X1_ALLDATA coding 池。

> 以上 3 项都是**有明确方法、有字节证据、只差执行**的工程项，不再存在「信息不在包内」的假设。
