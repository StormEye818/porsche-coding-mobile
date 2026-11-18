# RE-CODINGADDR-20261110 — SYS_DATA 根表 / comm 表 / GetSubSysDataAddr / Xml_GetCodingAddress 定位链

> 承接 RE-SYSDATA-ROWS-20261110 §7 开放项 ②③（0x0E 代地址静态化、编码地址数组定位）。
> 全部证据来自包内字节与 libPORSCHE_FILE.so Thumb 反汇编（capstone 5.0.7，
> 环境 `/Users/se818/.workbuddy/binaries/python/envs/default/bin/python`）。
> 逐指令复核：GetSubSysDataAddr 头 26 指令 + 字符串 0x60cd0 本轮重验一致。

## 0. 结论摘要

1. `GetSubSysDataAddr`（FILE:0x15c18）打开 **PORSCHE_SYS_DATA.BIN**（串 @0x60cd0），
   按名字或键检索子系统记录；`ctx[2] > 0xA` 走名字路径，`≤ 0xA` 走 IdSearch 键路径。
2. `Xml_GetCodingAddress`（FILE:0x17dc1）同样 fopen 该文件，`fseek(ctx+0x638)`，
   读 `[u8 n][u32 × n][u32 × n]` —— **编码地址对流的确切消费格式**。
3. SYS_DATA 根表 = `[u8 count=22][[u8 type][u32 off] × 22]`（22 平台）；
   type 0x0E = 981 代 → comm 子表 @0xe6f。
4. comm 子表 = `[u8 count=42][[u16 sysId][u8 nComm][nComm × [u32 commOff][u32 sysDataOff]]]`；
   sysDataOff → 子系统记录表（name-9 投票源）；commOff → comm 记录。
5. **981 无 ctx+0x638 编码地址流扩展**：9X1 段 name 记录后 6×u32 池指针后**直接是
   下一条 [len][name]**（Airbag 实测）→ 981 编码地址走 **9X1_ALLDATA coding 池**
   （变体块 `[22 2e …]["0x…" 键串]`，RE-SYSDATA-ROWS §5），不消费 SYS_DATA 流。

## 1. GetSubSysDataAddr @libPORSCHE_FILE.so:0x15c18（逐指令）

```
0x15c18: push.w {r4-r11,fp,lr}          ; 保存
0x15c1e: sub sp,#0x16c                  ; ctx 结构 ≈0x16C
0x15c20: mov r8,r0                      ; ctx 指针
…        canary 栈保护（__stack_chk_guard）→ 0x15c3a blx 0x13e44（__stack_chk_fail）
fopen("PORSCHE_SYS_DATA.BIN","rb")      ; 串 @0x60cd0（本轮复验：0x60CD0→"PORSCHE_SYS_DATA.BIN"）
读根表 → 按 ctx 匹配平台/子系统：
  A) ctx[2] > 0xA：名字搜索路径
     遍历 [u8 count][[u16 len][name\0][6×u32]] 记录表，strcmp 命中
     → 6 个 u32 池指针写 ctx+0x604..0x618（六池）
  B) ctx[2] ≤ 0xA：IdSearch 键搜索路径
     记录 stride 0x1a / 0x22（两种记录长度）
     flag & 0x51 时：
       record+0x1b → ctx+0x61c
       record+0x1f → ctx+0x638          ; ★ 编码数据流偏移（Xml_GetCodingAddress 的 seek 目标）
```

> name-9 法（RE-SYSDATA-ROWS §2）即路径 A 记录的字段反推：
> flag u16@name-11、sysId u32@name-9、len u16@name-2（len==strlen+1 校验）。

## 2. Xml_GetCodingAddress @0x17dc1（逐指令）

```
fopen(PORSCHE_SYS_DATA.BIN,"rb")        ; 同文件；串同样落在 0x60cd0 附近的 ldr/add 对
fseek(f, ctx+0x638, SEEK_SET)           ; ★ GetSubSysDataAddr 路径 B 填入的编码流偏移
fread(&n, 1, 1, f)        → ctx+0x4075a5   ; u8  n
fread(buf, 4, n, f)       → ctx+0x4075a8   ; u32 × n  （地址组 1）
fread(buf, 4, n, f)       → ctx+0x407670   ; u32 × n  （地址组 2）
```

**消费格式定案**：编码地址对 = `[u8 n][u32 addr_1 × n][u32 addr_2 × n]`，
两组按 index 配对（0x4075a5 基址 +0x4075a8/+0x407670 两个缓冲，正是 v-table
回调里成对取址的布局）。这就是「编码地址定位数组」在 431 侧的真实形态。

## 3. SYS_DATA 根表 → 0x0E comm 子表 → 子系统记录表（GetCommData @0x15581 消费）

```
根表（文件头）: [u8 count=22][ [u8 type][u32 off] × 22 ]       ; 22 平台
  type 0x0E = 981 代 → off = 0xe6f（comm 子表）

comm 子表 @0xe6f: [u8 count=42][ [u16 sysId][u8 nComm]
                   [ nComm × [u32 commOff][u32 sysDataOff] ] × 42 ]
  GetCommData：根表按 ctx[2]（平台 type）匹配 → 子表按 ctx+0x24(u16 sysId) 匹配 →
  arg2 选 comm 条目 → u32 对 → ctx+0x5fc/0x600；首字节分派 1/2/3/4/0x20/0x60，
  首字节 0x10 走默认分支 @0x1595e（键值数组入 ctx+0x2330/0x2344/0x670）。

sysDataOff → 子系统记录表: [u8 count][ [u16 len][name\0][6×u32] × count ]
  = name-9 投票源（tools/export-981-sysids.py 直接消费同构格式）。

commOff → comm 记录: [10 03 01][u32 a][u32 b=a+0xD40 常量差][03][u8 n]
                     [ [u16 key][u16 0x20] × n ]
  key 0x03A7 + flag 0x10 出现在 PASM/PSM/IC/SWSG/BKE 等**共享键**模块 ——
  即「一个键多个模块都行」的包内证据（B/C 行族 A=请求键语义的源头）。
```

## 4. 981 结论：无 ctx+0x638 扩展

9X1 段（≈57900–81500）name 记录的 6×u32 之后**没有 +2 扩展**：Airbag 记录后直接
`[u16 len][下一 name]`。路径 B 的 `record+0x1f`（ctx+0x638）在该记录布局里不落位
→ **981 的 Xml_GetCodingAddress 读不到有效编码地址流**；981 编码地址的真实载体是
**9X1_ALLDATA coding 池**（变体块记录 `[22 2e …][键串]`，coding-v2 已全量提取）。
此结论把 RE-SYSDATA-ROWS §5「命令行区 3344 行归属未定」收口：
那些 `[u16 can][02 f0]` 行经池归属复验**全部属于 ECM 系**
（BV_EnginContrModul1UDS 100 can、BV_ECM/DME/MED17 0x785-787），非全局地址表。

## 5. 换表落地记录（开放项 ①② 执行，2026-11-10）

### ① 981 sysId 重映射 → 0x0E 代（48/48）
- `tools/export-981-sysids.py`：9X1_ALLDATA 目录/变体 + name-9 全表扫描 + 变体名投票
  + OVERRIDES 收口（adjacency/isomorphic/drivelinks-key 证据注释）→ `data/981-sysids.json`。
- `src/module-ecu-map.js` 顶层块与 SYSTEM_TO_ECUID 换 0x0E 代（双记录模块取首枚，
  旧 0x0B 值留注释与 git 历史）。

### ② 0x0E 代地址静态化（44/48 静态解出）
- `tools/export-sysdata-routing.py` → `data/sysdata-routing.json`：
  路由表 16B 记录 `[u32 owner][sigA sigB][sel][ff][u32 can][u32 m]`，721 条 / 110 owner，
  14/14 锚点自检（0x0E02 Getriebe 0x725-0x72A、0x0E05 PSM 0x6E6-0x6EA、0x0E08 IC 0x7F1、
  0x0E0C DME 路由组、0x0C05/0x0C02 拥有 0x7D0…）。旧「表A A-sig 行」= 本记录错位 2 字节读法
  （decode-can-routing.py 保留对账，交集验证）。
- `tools/export-bind-plan.py` 重写为多源分级（tierA：v3 直连键 bindKey 低16位=CAN
  ∪ v3 候选 rx→tx=rx-8 ∪ 路由表 owner==sysId ∪ DME 路由组 0x_0C；
  空→跨代表A候选∩路由表 can 精确交集；再空→枚举兜底；候选序=多源收敛数降序）
  → `data/bind-plan.json` schemaVersion 2。

**验收（RE-SYSDATA-ROWS §7 / ANSWERS 口径，脚本内自检全过）：**

| 验收项 | 结果 |
|---|---|
| DME=0x7E0 | ✅ 四源收敛：v3 候选 0x7E8-0x7EC(rx) → tx=rx-8=0x7E0 + 路由 0x0E0C 组 + 网关 0x0C09 拥有 0x7E0 + 0x0b01 跨代 proven tx |
| PASM=0x7D0 | ✅ 0x0b13 表A候选 ∩ 路由表 can（owner 0x0C05/0x0C02 跨代行）；**无静态直达如实落档**（0x13 家族任何代无路由 owner 行） |
| IC 与 PSM 可区分 | ✅ IC 0x7F1（owner 0x0E08）vs PSM 0x6E6-0x6EA（owner 0x0E05），集合零交集 |
| 48 模块 ≥40 静态解出 | ✅ **44/48**（未解出 4：SCHEINWERFER(0x0e58)、ERA_GLONASS(0x0ea5)×2、BV_ActuaForStrucBorneSoundUDS(0x0e57)——包内确无候选，走枚举兜底） |
| 不许用锚点表补 | ✅ 全部候选带 provenance；PASM 的 0x7D0 由路由行+表A join 交集得出，锚点仅对账 |

### ③ 编码地址数组
见 §2（格式定案）+ §4（981 不消费该流）。9X1_ALLDATA coding 池侧 coding-v2.json 已有，
无新增工程项。

## 6. 全车型复用规则（推广步骤）

1. **换表**：对目标车型 X 找 9X*_ALLDATA 目录 + SYS_DATA 对应段（name-9 投票；
   name 记录格式通用：flag/len 校验）。产出 X-sysids.json，改 module-ecu-map.js 顶层块。
2. **路由**：`export-sysdata-routing.py` 的 16B 记录格式跨车型通用（owner=代际前缀+系统
   低字节）。对 X 代查 owner==sysId 行得直连 can；DME 家族用 0x_0C 路由组（各代同构）。
3. **绑定计划**：`export-bind-plan.py` 多源分级零车型特判（唯 FAMILY_ROUTE_OWNERS
   注入 X 代的 0x_0C 代码）；跨代候选 = 同系统旧代 sysId 表A 候选 ∩ 路由表 can。
4. **编码地址**：先查 name 记录后 6×u32 有无 +2 扩展（ctx+0x638 流）；
   无扩展（如 981）→ 走 ALLDATA coding 池（变体块键串）。
5. **comm 键**：comm 记录 `[10 03 01][a][b=a+0xD40][03][n][[key][0x20]×n]`
   的 key 集合可判「共享键模块」（0x03A7 族），用于解释多模块同键现象。

> 以上 5 步即「981 上解决、全车型复用」的完整规则；接手 agent 按 §6 顺序执行即可。
> ✅ **2026-11-11 已按本 §6 全部执行完毕**：25 车型 / 14 平台 / 10 平台定案代际 /
> 601 模块 sysId / 566 个 bind-plan 键 / 351 模块静态候选 / 981 44/48 保持 /
> `npm test` 全绿（新增全车型门禁 38/38）。完整执行记录、逐平台覆盖与剩余开放项见
> **`RE-ALLMODELS-20261111.md`**；一键复现 `npm run rebuild:all-models`。
