# 431 全车型/全变体/全模块静态数据真值证据账本（2026-11-20）

> 取证性质：**只读**。原始包 `/Users/se818/porsche-mapper/ref/decoded/`（解码副本），项目根 `/Users/se818/porsche-coder`。
> 目的：为「重写生成器 + 门禁」提供可复核的全车型静态真值坐标，并区分「原始包事实」与「项目自创推断」。
> 复现环境：`python3`（系统默认）；`.so` 反汇编用 `tools/disasm-elf.py`（capstone 5.0）。
> 所有偏移均为**文件内字节偏移（0-based）**；小端 LE。

---

## 0. 结论速览（先看这个）

| # | 问题 | 一句话结论 | 核心证据 |
|---|---|---|---|
| 1 | 全量静态真值在哪、怎么解 | **平台/type** 在 `DSN.BIN` 头 22 项 + `PORSCHE_SYS_DATA.BIN` 根表；**模块→sysId** 在 `DSN` 模块索引表 + `SYS_DATA` name-9；**变体/零件号** 在解密的 `JOB.BIN` XML；**VIN 分派** 在 `.so` 代码（非 BIN 表） | E01–E05,E09 |
| 2 | 「车型数据集相同才合并候选」 | 431 把 981/982 的 Boxster/Cayman **变体名合并成同一套 `Boxster_B4T_*`**：`JOB.BIN` 中 `Cayman_` 出现 **0 次**；`data/models` 两车型 231/218/122 文件 items 签名 **0 差异** | E06,E07 |
| 3 | label→code→sysId→request key→变体 | 五段分落五个载体：`MENU.BIN`(label) / MENU 节点(code) / `SYS_DATA` name-9(sysId) / `DRIVELINKS` SpecArray(request key) / `JOB.BIN`(变体)。**任务给的「DME 0x0b23」有误：0x0b23=BCM_hinten，DME 是 0x0b01/0x0e01** | E04,E08,E10,E11 |
| 4 | Macan 多模块菜单进入 | 431 **一个菜单项聚合多个模块**：Macan「后端电子设备」`modules=["BCM_hinten","Heckklappe"]`，是两个独立 sysId（0x0f23 / 0x0f34），各自独立进模块——**不是取一个** | E08,E14 |
| 5 | 静态能否独立证明全车型能力 | **不能全证**：平台/模块/变体/请求键/帧模板可静态证；但 **请求键→CAN 地址、trim 显示名、车型精确落定、探测成败** 靠运行时，包内三次负扫描 0 命中 | E12,E13 |

---

## 1. 问题 1：VIN→车型/年款→平台/type→模块→变体 的全量静态真值

### E01 — 平台/type 真值：`DSN.BIN` 头 22 项索引

- **做法/数据**：头 22 项，`id ≡ SYS_DATA root type ≡ sysId 高字节`。这是「平台→type」唯一的静态显式表。
- **原始文件**：`/Users/se818/porsche-mapper/ref/decoded/DSN.BIN`（674,172 B）
- **记录坐标/格式**：`[u8 count=0x16][ [u8 id][u16 nlen][name\0][u32 payloadOff] ×22 ]`，自 0x1 起、0xe7 结束。
- **实测全表**：
  ```
  id  1 name=9x6     payloadOff=0x03a5ef      id 12 name=G1    payloadOff=0x00e0ac
  id  2 name=9x6     payloadOff=0x03a5ef      id 13 name=9x1   payloadOff=0x019b8c
  id  3 name=E1      payloadOff=0x0328ec      id 14 name=9x1   payloadOff=0x019b8c
  id  4 name=9x7     payloadOff=0x03e31f      id 15 name=cajun payloadOff=0x027f67
  id  5 name=9x7     payloadOff=0x03dfbe      id 16 name=918s  payloadOff=0x044c28
  id  6 name=9x7     payloadOff=0x03e31f      id 17 name=E3    payloadOff=0x04a185
  id  7..10 name=0   payloadOff=0（占位）      id 18 name=G2    payloadOff=0x05c4f3
  id 11 name=E2      payloadOff=0x0000e7      id 19 name=CS1   payloadOff=0x06c3a0
                                                id 20 name=992   payloadOff=0x0735ca
                                                id 21 name=J1    payloadOff=0x089f77
                                                id 22 name=G3    payloadOff=0x094fe2
  ```
  注意 9x6(id1/2)、9x7(id4/6)、9x1(id13/14) 是**同 payloadOff 的双 id 别名**——这是静态等价集的来源。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import struct
  b=open('DSN.BIN','rb').read(); p=1
  for i in range(b[0]):
      id=b[p]; nlen=struct.unpack_from('<H',b,p+1)[0]
      name=b[p+3:p+3+nlen-1].decode('latin1'); off=struct.unpack_from('<I',b,p+3+nlen)[0]
      print(id,name,hex(off)); p+=3+nlen+4
  PY
  ```
- **当前 data/ 对应字段**：`dsn-module-sysids.json`（source 字段已声明来自 DSN.BIN 头）；`vehicle-id-type-map.json` 的 `canonicalType`(9X6=0x01/9X7=0x05)。
- **差异/建议**：`canonicalType` 的「严格超集」判定、`SR-1`/`SR-2` 特殊规则是**项目推断规则**（见 E14），不是包内显式字段；重写生成器时须把它标为 derived，不可当原始真值。

### E02 — 模块清单/模块→sysIdLow 真值：`DSN` 各 payloadOff 模块索引表

- **做法/数据**：每个 payloadOff 指向该平台的模块表，行内 `low` 即 sysId 低字节。
- **原始文件**：`DSN.BIN`（同 E01）
- **记录坐标/格式**：表头 `[u16 0x0000]`，其后 `[ [u8 low][u16 nlen][name\0][u32 recPtr][u16 flag] ×n ]`。
  - 9x6 `payloadOff=0x3a5ef`：表头 0x0000，**29 行**，首行 `low=0x03 name=9x6_ABS @0x3a5f1`。
  - 9x7 `payloadOff=0x3e31f`：**41 行**，首行 `low=0xc0 name=Dynamische_Aggregatelagerung @0x3e321`。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import struct
  b=open('DSN.BIN','rb').read()
  for plat,off in [('9x6',0x3a5ef),('9x7',0x3e31f)]:
      i=off+2; rows=[]
      while i+9<len(b):
          low=b[i]; nl=struct.unpack_from('<H',b,i+1)[0]
          if not 2<=nl<=60: break
          rows.append((low,b[i+3:i+3+nl-1].decode('latin1'))); i+=3+nl+6
      print(plat,len(rows),rows[:3])
  PY
  ```
- **当前 data/ 对应字段**：`dsn-module-sysids.json:platforms[*].modules[*].fullSysId`（low + 规范 type 拼成）。
- **差异/建议**：`flag` 是位标志**不编码 type**，生成器不得拿 flag 当高字节；高字节只能取 E01 的规范 type。

### E03 — SYS_DATA 根表 22 个 type

- **原始文件**：`PORSCHE_SYS_DATA.BIN`（440,820 B）
- **坐标/格式**：`[u8 count=0x16][[u8 type][u32 off]×22]`，type 0x01@0x73 … 0x16@0x64edc（完整值见下命令）。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import struct
  b=open('PORSCHE_SYS_DATA.BIN','rb').read()
  for i in range(b[0]): print(hex(b[1+i*5]),hex(struct.unpack_from('<I',b,2+i*5)[0]))
  PY
  ```
- **当前 data/ 对应字段**：`sysdata-root-table.json:types[*]`（每个 type 的 comm 子表/名字集/sysIds）。
- **差异/建议**：与 E01 的 DSN 头交叉核对一致（都 22 项）；可据此做一条门禁：`DSN.id 集合 == SYS_DATA.type 集合 == 0x01..0x16`。

### E04 — 模块 label→sysId 真值：`SYS_DATA` name-9 记录

- **做法/数据**：同名模块在不同代际段有不同 sysId（高字节=代际）。
- **原始文件**：`PORSCHE_SYS_DATA.BIN`
- **坐标/格式**：名字串起点 `p`；`flag=u16@p-11`、`sysId=u32@p-9`、`len=u16@p-2`，且 `len==strlen+1`、`flag∈{1,2,3}`。
- **代表证据（本题 3 的核心坐标，全部实测）**：
  | 模块名 | 文件偏移 | sysId | 含义 |
  |---|---|---|---|
  | `Kombiinstrument_BaseSys` | 28826 | **0x0b08** | 仪表 0x0B 代 |
  | `Kombiinstrument_MM_BaseSys` | 66224 | **0x0e08** | 仪表 9X1/0x0E 代 |
  | `Kombiinstrument_MM_BaseSys` | 220016 | 0x0f08 | 仪表 0x0F 代 |
  | `DME_BDE_Continental_BaseSys` | 23649 | **0x0b01** | DME 0x0B 代 |
  | `DME_BDE_Continental_BaseSys` | 43258 | 0x0c01 | DME 0x0C 代 |
  | `DME_BDE_Continental_BaseSys` | 60979 | **0x0e01** | DME 9X1/0x0E 代 |
  | `BCM_hinten_BaseSys` | 32213 | **0x0b23** | 后端电子设备 0x0B 代 |
  | `BCM_hinten_BaseSys` | 72004 | 0x0e23 | 后端电子设备 9X1 |
  | `Heckklappe_BaseSys` | 33534 | 0x0b34 | 尾门（独立模块） |
  | `PSM_BaseSys` | 65208 | 0x0e05 | PSM 9X1 |
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import re,struct
  b=open('PORSCHE_SYS_DATA.BIN','rb').read()
  for key in ('Kombiinstrument','DME','BCM_hinten','Heckklappe','PSM'):
      for m in re.finditer(re.escape(key.encode())+rb'[A-Za-z0-9_]*\x00',b):
          p=m.start()
          if p<11: continue
          ln=struct.unpack_from('<H',b,p-2)[0]; fl=struct.unpack_from('<H',b,p-11)[0]
          sid=struct.unpack_from('<I',b,p-9)[0]; nm=m.group()[:-1].decode('latin1')
          if ln==len(nm)+1 and fl in (1,2,3) and 0<sid<0x2000: print(p,hex(sid),nm)
  PY
  ```
- **当前 data/ 对应字段**：`981-sysids.json:modules[*].sysId`、`all-model-sysids.json:platforms[*].modules[*].sysId`、`dsn-module-sysids.json`。
- **差异/建议（重要）**：任务描述写「DME 0x0b23/0x0e01」——**0x0b23 是 BCM_hinten（后端电子设备），不是 DME**。DME 是 0x0b01/0x0c01/0x0e01/0x0f01。重写生成器时务必按 name-9 实测，不要按任务里的错标坐标。

### E05 — 请求键目录：`PORSCHE_DRIVELINKS.BIN`

- **原始文件**：`PORSCHE_DRIVELINKS.BIN`（118,172 B）
- **坐标/格式**：目录 `209 条 × 8B = [u32 sysId][u32 blockOff]`，自 0x0；`0x7fffffff` 终止于 0x688。
- **代表坐标**：
  | sysId | 目录项偏移 | blockOff | 含义 |
  |---|---|---|---|
  | 0x0b01 | 0x10 | 0x6f8 | DME 0x0B（blockCount 39） |
  | 0x0b08 | 0x30 | 0x816 | 仪表 0x0B |
  | 0x0b23 | 0xb8 | 0x9ef | BCM_hinten 0x0B |
  | 0x0e01 | 0x458 | 0x13a5 | DME 9X1（33 block） |
  | 0x0e08 | 0x470 | 0x14a4 | 仪表 9X1（14 block） |
  | 0x0f4d | 0x278 | 0x10c9 | 车道变换地址键（见 E11） |
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import struct
  b=open('PORSCHE_DRIVELINKS.BIN','rb').read(); i=0; n=0
  while i+8<=len(b):
      sid,off=struct.unpack_from('<II',b,i)
      if sid==0x7fffffff: break
      if sid in (0x0b01,0x0b08,0x0b23,0x0e01,0x0e08,0x0f4d): print(n,hex(sid),hex(off))
      n+=1; i+=8
  print('total',n)
  PY
  ```
- **当前 data/ 对应字段**：`bind-plan.json:plan[*].pairs`、`ecu-addresses.json`、`981-sysids.json:modules[*].sysIds`（229 键全集）。
- **差异/建议**：目录 209 键是 sysId 全集，绑定计划必须以它为边界；不要为不在目录内的 sysId 造地址。

### E06 — 变体与零件号真值：解密 `JOB.BIN`（XML）

- **做法/数据**：`JOB.BIN` 是 AES-128-CBC 解密后的明文 XML（RE-VARIANT §0：key=`$MakeCN~D0T@Grea`，IV=`sky\0×13`）。变体名作为 `ECU-REF` 与 PARTNUMBER 一一对应。
- **原始文件**：`JOB.BIN`（2,896,336 B，明文 `<?xml …`，见 0x0 头）
- **关键实测（车型合并证据）**：
  - `Boxster_` 开头的变体名 **9 个**（出现 84 次）：`Boxster_B4T_2_0L_RDW`×16、`Boxster_B4T_2_5L_RDW`×13、`Boxster_B4T_2_5L_GTS_RDW`×13、`Boxster_B4T_2_0L_USA`×9、`Boxster_B4T_2_5L_USA`×9、`Boxster_B4T_2_0L_EU6AG_mOPF`×8 …
  - **`Cayman_` 开头的变体名 0 个** ⇒ 981/982 的 Boxster 与 Cayman **共用同一份 Boxster_B4T_* 变体集**。
  - `ECU-REF` 全库 1197 个不同值；变体名通过它绑到模块 + 零件号。
  - 个案：`PARTNUMBER=98161864015` 记录文件偏移 **0xbc21**（grep 命中 48161/48211），变体 `SDI9_1_981_3_4L_EU5`、模块 `DME_BDE_Continental`（RE-MODELADDR §3.3）。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import re,collections
  b=open('JOB.BIN','rb').read()
  for kw in (b'Boxster_',b'Cayman_'):
      n=collections.Counter(m.group().decode() for m in re.finditer(re.escape(kw)+rb'[A-Za-z0-9_]+',b))
      print(kw.decode(),sum(n.values()),len(n),n.most_common(6))
  PY
  ```
- **当前 data/ 对应字段**：`ecu-part-map.json:byPart`（PARTNUMBER→变体）；`models-catalog.json:models[*].modules[*].variants[*]`。
- **差异/建议**：变体选择 = 零件号在 `JOB.BIN` 查表**自动落定，不弹菜单**（RE-VARIANT §d）；`models-catalog` 的车型聚合是项目目录层，431 原生只有变体名这一级。

### E07 — 车型数据集全等：Boxster/Cayman 合并候选的直接证据

- **做法/数据**：对 `data/models/*` 下两车型同名变体文件逐文件比对 `items` 的 `(module,lid,readSid)` 序列。
- **原始文件/坐标**：项目派生数据（源自各 `*_ALLDATA.BIN` 变体块），路径 `data/models/<slug>/*.json`。
- **实测**：
  ```
  Boxster_981_ vs Cayman_981_: 231 vs 231 文件，差集 0，items 签名不同 0/231
  Boxster_982_ vs Cayman_982_: 218 vs 218 文件，差集 0，items 签名不同 0/218
  Boxster_987_ vs Cayman_987_: 122 vs 122 文件，差集 0，items 签名不同 0/122
  Boxster_986_ vs Cayman_987_: 0 交集（不同平台，不可合并）
  ```
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-coder && python3 - <<'PY'
  import json,os
  r='data/models'
  for a,b in [('Boxster_981_','Cayman_981_'),('Boxster_982_','Cayman_982_'),('Boxster_987_','Cayman_987_')]:
      ta={f for f in os.listdir(f'{r}/{a}') if f.endswith('.json')}
      tb={f for f in os.listdir(f'{r}/{b}') if f.endswith('.json')}
      sig=lambda d,f: tuple((i.get('module'),i.get('lid'),i.get('readSid')) for i in json.load(open(f'{r}/{d}/{f}'))['items'])
      diff=sum(sig(a,f)!=sig(b,f) for f in ta&tb)
      print(a,b,len(ta),len(tb),'only',len(ta-tb),len(tb-ta),'sigdiff',diff)
  PY
  ```
- **当前 data/ 对应字段**：`src/app.js` autoSearch 的「数据集相同合并单确认」逻辑（RE-MODELID §②落地）。
- **差异/建议**：合并的**根因是 E06 的变体名合并**（431 数据层本就共用），不是项目主动合并；门禁应校验「候选车型的变体文件集合与 items 签名全等」才允许合并确认，986 vs 987 不得合并。

### E09 — VIN→车型/年款/平台：在 `.so` 代码，不在 BIN 表

- **做法/数据**：VIN 分派是**代码里的跳转表（tbb）**，不是包内一张可查表。
- **原始文件**：`ref/x431-porsche-v24.58/V24.58/libPORSCHE_SYSP.so`、`libPORSCHE_READWRITE.so`
- **坐标**：
  - `PorscheGetYearAndModel` @SYSP:**0x22ad4**，tbb 表 @0x22b08（VIN[7]→17 分支）；年款 `PorscheGetYearByModel` @0x261a8，年款字符表 @0x5E3A0=`123456789ABCDEFGHJKLMNPRSTVWXY`。
  - `GetVehicleForVin` @READWRITE:**0x147c80**、`GetYearForVin` @0x147a70（VIN[7]/VIN[11] 双字符 → 平台名 + DSN id）。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-coder && /Users/se818/.workbuddy/binaries/python/envs/default/bin/python3 \
    tools/disasm-elf.py ref/x431-porsche-v24.58/V24.58/libPORSCHE_SYSP.so 0x22ad4 96
  ```
- **当前 data/ 对应字段**：`vin-vehicle-map.json`（source 已声明「逐指令转写」，15 branches + yearCodes）。
- **差异/建议**：`vin-vehicle-map.json` 的 15 分支是 **.so 转写，不是原始包表**；且它只到**平台粒度**（Boxster/Cayman 同 9X1），trim 名靠车上识别串（E13）。重写生成器时不要把 VIN 分派伪装成「从 BIN 解出」。

---

## 2. 问题 3：label→code→sysId→request key→变体 全链映射

五段分落五个载体，**没有一张表包打天下**：

| 段 | 载体 | 坐标例（Macan BCM_hinten） |
|---|---|---|
| label（中文菜单名） | `MENU.BIN` 字符串 | 「后端电子设备」节点 @0x41cd(16845) |
| code（菜单内 ECU id） | MENU 节点字节 | @0x41cd+0x20 = 0x23（low byte），`0x0b00+code` 得 sysId 低段 |
| sysId | `SYS_DATA` name-9 | `BCM_hinten_BaseSys` @72004 → 0x0e23；CAJUN 段 0x0f23 |
| request key | `DRIVELINKS` SpecArray | 元素 `[u8 count][count×u32]`，如 IC `0x00300335` @0x5427 |
| 变体 | `JOB.BIN` XML | `Boxster_B4T_2_5L_USA` / `SDI9_1_981_3_4L_EU5` |

### E08 — label/code 真值：`MENU.BIN` 节点

- **原始文件**：`ref/x431-porsche-v24.58/V24.58/MENU.BIN`（35,223 B）
- **坐标/格式**（`tools/x431-address-port.py:53-68` 已证）：菜单项 `ref` 的 `|` 后整数是 `MENU.BIN` 偏移；节点 `+0x20` 的字节是 ECU code（low），`sysId_low = 0x0b00 + code`（旧代口径，新代按 E01 type 换高字节）。
- **实测**（Macan）：
  - 「后端电子设备」ref=`后端电子设备|16845` → @0x41cd 字节 `23 00 … 23 05 … 23 0f …`（含 0x0523/0x0f23 两代槽位），+0x20=0x23。
  - 「PTG(电动尾门)」ref=`…|17160` → @0x4308 字节 `34 05 … 34 0f`（0x0534/0x0f34 槽位）。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-coder && python3 - <<'PY'
  b=open('ref/x431-porsche-v24.58/V24.58/MENU.BIN','rb').read()
  for v in (16845,17160): print(hex(v),b[v:v+40].hex(' '))
  PY
  ```
- **当前 data/ 对应字段**：`menu-tree-v3.json` 的 `systems[*].ref / label / ecu / modules`。
- **差异/建议**：`menu-tree-v3` 的 `modules` 聚合（见 E14）是项目解析产物；重写时须回溯 `MENU.BIN` 节点字节，不可只信聚合后的 JSON。

### E10 — request key 真值：`DRIVELINKS` SpecArray

- **原始文件**：`PORSCHE_DRIVELINKS.BIN`
- **坐标/格式**：addrBlock 行 `[u8 idx][u16 internal][u16 flags][u32 cmdptr][u16 x1010]`；`cmdptr+3` 起 SpecArray=`[u8 count][count×u32]`，元素是请求键（`0x0030xxxx`/`0xFF60xxxx`），**不是 CAN 地址**。
- **实测**：PASM 记录 @0x8D74 元素 `0x003005C4`；DME @0x2FB0 元素 `0x003005BF`；IC 行键 `A=0xFF60026B`。候选数 n：0→2034 行（零探针直绑）、1→964 行、2→10 行。
- **可复核命令**：见 RE-DRIVELINKS-ARRAY §2 / RE-DISCOVERY §2（`tools/export-drivelinks-v3.py`）。`0x0f4d` 的三合一裁决与 CAN 真值 `0x74E/0x7B8` 见 E11。
- **当前 data/ 对应字段**：`bind-plan.json`、`ecu-addresses.json:entries[*].rows[*].candidates`。
- **差异/建议**：请求键空间 ≠ CAN 域（0x7xx）；门禁不得把 `0x0030xxxx` 当 CAN 校验。

### E11 — 车道变换 0x0f4d 三合一裁决（SYS_DATA sysId + DRIVELINKS 目录键 + 请求键）

> 与 linkmap 线 E-14 交叉裁决（2026-11-20 team-lead 指派）。原始字节结论已同步 research-431-linkmap。

- **裁决结论（纠正本账本旧措辞）**：`0x0f4d` **是合法的 SYS_DATA sysId**（模块名 **`SWA2_BaseSys`**，gen 0x0F），**同时**又是 DRIVELINKS 目录键 + 直连请求键 `0x003006CC–0x003006CF`——三个键空间**同一数值三合一**。旧措辞「0x0f4d 是地址键不是 sysId」**错误**，已废止。真正与之异名的是 `0x0e5f/0x0e60`（gen 0x0E，名字 `BV_ContrUnitLaneChangAssis2UDS_BaseSys`）。
- **原始坐标 A（DRIVELINKS 键空间）**：`/Users/se818/porsche-mapper/ref/decoded/PORSCHE_DRIVELINKS.BIN` 目录项 @0x278 → sysId=**0x0f4d** blockOff=0x10c9；addrBlock @**0x1148a** 头 `3e 01 04 03`，前 4 行 flags=`06cc/06cd/06ce/06cf`（直连键 `0x003006CC–0x003006CF`），原始字节：
  ```
  3e 01 04 03 05 00 01 cc 06 30 00 c7 14 01 00 10
  10 02 cd 06 30 00 0a 15 01 00 10 10 03 ce 06 30 …
  ```
- **原始坐标 B（SYS_DATA sysId 空间，决定性证据）**：`/Users/se818/porsche-mapper/ref/decoded/PORSCHE_SYS_DATA.BIN` `cat=0x10` 记录 @**0x35ebc**，`A=0xE9C0>>5=0x74E(tx)`、`C=0xF700>>5=0x7B8(rx)`；sysId 字段在记录 +0x24 = @**0x35ee0** 处 `u32=0x0f4d`，其后紧跟名字串 **`SWA2_BaseSys\0` / `SWA2_A2_1`**。全文件 `u32=0x0f4d` **仅此 1 处**，确证它是真 sysId。
- **异名同功能 sysId（gen 0x0E）**：@**0x1402f** sysId=`0x0e5f`、名字串 `BV_ContrUnitLaneChangAssis2UDS_BaseSys`、CAN raw 同为 `0xE9C0F700`→`0x74E/0x7B8`（与 0x0f4d **raw 逐字节相同但名字不同，禁止合并身份**）；@**0x14197** sysId=`0x0e60`、同名字串、CAN raw `0x9A404640`→`0x4D2/0x232`（另一 CAN 对）。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-mapper/ref/decoded && python3 - <<'PY'
  import struct,re
  b=open('PORSCHE_SYS_DATA.BIN','rb').read()
  for off in (0x35ebc,0x1402f,0x14197):
    print(hex(off), 'sysId@+0x24=', hex(struct.unpack_from('<I',b,off+0x24)[0]),
          'name=', re.search(rb'[A-Za-z][A-Za-z0-9_]{3,}\x00',b[off+0x2c:off+0x60]).group()[:-1].decode())
  d=open('PORSCHE_DRIVELINKS.BIN','rb').read(); print('DRIVELINKS @0x1148a:',d[0x1148a:0x1148a+32].hex(' '))
  PY
  ```
- **当前 data/ 对应字段**：`all-model-sysids.json:platforms.9X1.modules.BV_ContrUnitLaneChangAssis2UDS` = `{sysId:0x0f4d, method:drivelinks-key, evidence:"地址键=0x0F4D…；身份 sysId=0x0E5F/0x0E60…"}`；`platforms.CAJUN.modules.SWA2={sysId:0x0f4d, method:name9-vote}`。`981-sysids.json` 车道变换项 evidence 同时记两名。
- **差异/建议（门禁三元组与字段命名）**：
  - 门禁对象写成四元（不要叫「身份 sysId」单值）：`{ sysId: '0x0f4d', sysName: 'SWA2_BaseSys', requestKey: [0x06CC,0x06CF], can: {tx:0x74E, rx:0x7B8, rxRule:'rx=tx+0x6A'}, provable: 'static', altIdentitySysIds: ['0x0e5f','0x0e60'] }`。`0x0e5f/0x0e60` 字段名用 **`altIdentitySysIds`（同功能异名 sysId）** 或 `nameVariantSysIds`，**禁止**叫「身份 sysId」（易误解为唯一身份键）。
  - 进模块查 live map 用 **sysId=0x0f4d + 请求键 0x06CC-CF**（DRIVELINKS 目录键决定探测行）；身份裁决按 **名字串 `SWA2_BaseSys` vs `BV_ContrUnitLaneChangAssis2UDS_BaseSys` + 件号**，不是按单一 sysId 数值。
  - CAN 真值 `0x74E/0x7B8` 是 cat=0x10 静态可证；「请求键→该 CAN 的运行时绑定」是 runtime，不得静态写死（E20 分界）。
  - 0x0f4d 与 0x0e5f raw 相同但名字不同——**禁止因 raw 相同合并为同一 sysId**。

### E12 — 共享键旁证：`PORSCHE_SYS_DATA` comm 记录

- **数据**：400 条 comm 记录、11 种共享键；键 **0x03A7 出现在 280 个不同 sysId / 8 个 type**（PASM/PSM/IC/SWSG/BKE 等重叠）。
- **当前 data/ 对应字段**：`comm-shared-keys.json`。
- **差异/建议**：运行时**不得**把共享键当模块独占地址证据（RE-ALLMODELS §步骤5）。

---

## 3. 问题 4：多模块菜单进入（Macan BCM_hinten + Heckklappe）

### E13 — 一个菜单项聚合多模块

- **做法/数据**：431 菜单项到「模块集合」是**一对多**；一个菜单节点挂多个模块，各自独立 sysId，各自独立进模块。
- **原始/派生坐标**：
  - `menu-tree-v3.json`：Macan「后端电子设备」`ref=后端电子设备|16845`，**`modules=["BCM_hinten","Heckklappe"]`**，`codingCount=453`，itemIds 全部是 `Macan:BCM_hinten_E2_GT5:…`。
  - `MENU.BIN` @0x41cd 节点含 0x0523/0x0f23 两代 BCM_hinten 槽位；@0x4308「PTG(电动尾门)」含 0x0534/0x0f34。
  - `all-model-sysids.json`：Macan 平台 CAJUN(0x0f) 的 `BCM_hinten=0x0f23`、`Heckklappe=0x0f34`（**两个不同 sysId**，证据见 E04/E05）。
  - `PORSCHE_DRIVELINKS.BIN`：0x0f23 目录项 @0x2f8(blockCount13)、0x0f34 @0x340(blockCount3)——**各自独立 block 集**。
- **可复核命令**：
  ```bash
  cd /Users/se818/porsche-coder && python3 - <<'PY'
  import json
  j=json.load(open('data/menu-tree-v3.json'))
  for g in j['groups']:
    for m in g.get('models',[]):
      if m.get('label')=='Macan':
        for f in m['functions']:
          for s in f.get('systems',[]):
            if s.get('label')=='后端电子设备': print(s['ref'],s['modules'],s['codingCount'])
  PY
  ```
- **结论/建议**：
  - **应该取多个 sysId**：「后端电子设备」= BCM_hinten + Heckklappe 两个模块，进模块链要对 **0x0f23 与 0x0f34 分别绑定**，不是一个 sysId 二选一。当前 `menu-tree-v3.modules` 保留了两项，方向正确。
  - 与 RE-CLOSURE §4.1 的「双 sysId 同地址」区分：那 5 个模块（如 Hinterachslenkung 0x0E59/0x0E5A）的**两个 sysId 指向同一组地址记录**，只展开首枚无后果；Macan 这两枚是**不同模块、不同 block**，不可合并。门禁须按 `blockOff` 是否相同判别这两类。

---

## 4. 问题 5：静态可证范围 vs 必须 runtime live map

### E14 — 静态可证清单（原始包足以独立证明）

| 能力 | 原始载体 | 证据 |
|---|---|---|
| 22 平台/type | DSN 头 + SYS_DATA 根表 | E01,E03 |
| 各平台模块清单 | DSN 模块索引表 + ALLDATA 顶级目录 | E02（9X1 56 系统、CAJUN 64、9X6 29） |
| 模块→sysId | SYS_DATA name-9 + DSN low+type + comm-join | E04 |
| 变体名/零件号→变体 | JOB.BIN XML + CODINGFILECFG.BIN XML | E06 |
| 车型数据集集合 | 各 `*_ALLDATA.BIN` 二级变体表 | E07 |
| 请求键/帧模板/会话/DTC/例程 | DRIVELINKS + GFS_CONFIG + GAG_COMMAND | E05,E10 |

### E15 — 不能静态证明、必须运行时（包内证据）

| 缺口 | 包内证据 | 结论 |
|---|---|---|
| **请求键 → CAN tx/rx 地址** | RE-DISCOVERY §6 三次负扫描：6 锚点 64B 窗口 0 命中（243MB/77 文件）；4 真实请求键 ±64B 找 CAN 0 命中；DRIVELINKS 行 id↔SYS_DATA internal 桥表仅 3 处随机共现 | **不存在于任何产物**，是连接期枚举出的运行时事实（`showAddress("4000")`）。每次连接须枚举一次，进模块 0–1 帧 |
| **trim 显示名（Boxster/Cayman 精确款）** | RE-MODELID §①：GAG 全段 0xff0000xx 键零命中；trim 名来自 `22 11 02`(0xff001102)/`22 14 0A` 车上识别串 + 运行时文本库 | VIN 只能定平台 9X1；精确款靠车上应答文本（strcmp ⇒ 显示==应答），静态不可得 |
| **车型精确落定（25 车型中的哪一个）** | vin-vehicle-map.json 仅 15 分支到平台；`Cayman_` 变体名 0（E06） | 25 车型是项目/菜单目录聚合；VIN→平台后 trim 靠识别串，纯 VIN 无法唯一落到 25 车型 |
| **探测成败（谁应答）** | RE-DISCOVERY §1：`DriveLinksMode_1001` 逐候选发 `0xFF001409`，`uxth(返回)==1` 才绑定 | 候选是否有效由运行时应答决定，n==0 时零探针直绑 |
| **新代 0x14/0x15/0x16 路由 owner** | RE-CLOSURE §4.3：`sysdata-routing.json:byOwner` 中 0x14/0x15/0x16 各 0 条 | 992/Taycan/9YA 静态候选只能靠跨代表A∩路由，弱证据；运行时 live-map 兜底（RE-DISCOVERY） |
| **编码地址扩展流** | RE-ALLMODELS §步骤4：3958 条 name 记录中 640 unknown、0 条落位流；IdSearch ctx+0x638 流是连接期产物 | 981 及全库统一走 ALLDATA coding 池；扩展流静态不猜 |

---

## 5. data/ 字段溯源总表（哪些来自原始包，哪些项目自创）

| data 文件/字段 | 来源 | 判定 |
|---|---|---|
| `vin-vehicle-map.json` branches/yearCodes | .so 逐指令转写（E09） | 包相关但**非 BIN 表**，代码转写 |
| `models-catalog.json` 变体列表 | 各 `*_ALLDATA.BIN` 目录（E07） | 原始包派生 |
| `models-catalog.json` slug/车型名/25 车型聚合 | 项目目录命名 + menu-tree | **项目自创**（431 原生到变体名级） |
| `dsn-module-sysids.json` module/low/fullSysId | DSN.BIN（E02） | 原始包派生 |
| `dsn-module-sysids.json` canonicalType/SR-1/SR-2/staticEquivalence | 项目「严格超集」判定规则 | **项目推断**（静态等价，非显式字段） |
| `all-model-sysids.json` platforms[*].modules[*].sysId | SYS_DATA name-9/DSN/comm-join（E04,E12） | 原始包派生 |
| `all-model-sysids.json` applyPlatformSysIds / confidence | 项目投票 gap 阈值规则 | **项目推断** |
| `981-sysids.json` modules[*].sysId | 9X1_ALLDATA + name-9 投票（E04） | 原始包派生 |
| `variant-sysids.json` | `data/models/*` + `sysIdForModule()`（文件内 source 自述） | **纯项目派生**（运行时变体反推，非原始包） |
| `bind-plan.json` pairs/provenance | DRIVELINKS + 路由表（E05,E10） | 原始包派生 + 项目 provenance 标注 |
| `ecu-part-map.json` byPart | JOB.BIN（E06） | 原始包派生 |
| `menu-tree-v3.json` ref/label | MENU.BIN（E08） | 原始包派生 |
| `menu-tree-v3.json` modules 聚合 | 项目解析产物 | **项目派生**（须回溯 MENU.BIN 节点复核） |

---

## 6. 给重写生成器/门禁的可执行建议

1. **三门禁锚点**：① `DSN.id 集合 == SYS_DATA.type 集合 == 0x01..0x16`；② 每平台模块数 == DSN payloadOff 模块表行数（9X1 56/CAJUN 64/9X6 29/9X7 41）；③ 车型合并前校验两车型变体文件集 + items 签名全等（E07）。
2. **分开两类「多 sysId」**：同 blockOff（如 0x0E59/0x0E5A，可只取首枚）vs 不同 blockOff（如 Macan 0x0f23/0x0f34、菜单聚合 BCM_hinten+Heckklappe，必须分别绑定）。判据=DRIVELINKS blockOff 是否相同（E13）。
3. **sysId 高字节只用 DSN 规范 type**（E02 flag 不可当高字节）；9X6/9X7 的 canonicalType 必须标 derived 并保留严格超集证明。
4. **纠正坐标与身份口径**：0x0b23=BCM_hinten、DME=0x0b01/0x0e01（E04）；0x0f4d 是 SYS_DATA sysId（`SWA2_BaseSys`,gen 0x0F）+ DRIVELINKS 目录键 + 请求键 0x06CC-CF 三合一，CAN 真值 0x74E/0x7B8 静态可证；0x0e5f/0x0e60 是异名 sysId（`BV_ContrUnitLaneChangAssis2UDS_BaseSys`,gen 0x0E），字段名用 altIdentitySysIds 不叫「身份 sysId」（E11）。
5. **静态/运行时分栏**：生成器输出须带 `provable: static|runtime` 标记；请求键→CAN、trim 名、车型精确落定、探测成败四项一律标 runtime，禁止静态产物里写死 CAN 地址（E15）。
6. **VIN 链按 .so 转写复核**：`vin-vehicle-map.json` 的 15 分支须与 SYSP:0x22ad4 tbb + READWRITE:0x147c80 双字符分派逐项对账，标 `source=so-reverse`（E09）。

---

## 7. 数字口径复核（响应 team-lead 172/302/281 确认请求，2026-11-20）

**结论：team-lead 修正口径正确，三数全部复现 = 172 / 302 / 281**（linkmap 文档 §F 的 296 是归一 bug）。

- **623** = bind-plan ecu 全部 sysId；**408** = 有 cat=0x10 本代真值的 sysId（gen<0x14 296 + gen>=0x14 112）。
- **172** = 大小写归一化后 `gen<0x14` 真值 tx 未进 bind-plan cands 的 sysId 数。
- **302** = gen<0x14 的本 sysId 真值配对数；**281** = 其中 `rx != tx+8` 的配对数。
- **296 的来源**：linkmap §F 命令用 `t[0].upper()` 比较，但 cands 是 `0x06A7` 形式（`0x` 前缀 + hex 大写），truth tx 是 `0x070D`——`upper()` 未统一 `0x` 前缀大小写在部分条目上 miss，把 172 虚增成 296。**正确做法是大小写 + `0x` 前缀双重归一**（`str(x).lower().replace('0x','')`）。

- **可复核命令**（PRD P1-2 数字单一来源）：
  ```bash
  cd /Users/se818/porsche-coder && python3 - <<'PY'
  import json
  bp=json.load(open('data/bind-plan.json')); cat=json.load(open('data/comm-addr-table.json'))
  def norm(x): return str(x).lower().replace('0x','')   # 大小写+前缀归一（关键）
  truth={}
  for gv in cat['byGeneration'].values():
    for a in gv['addresses']: truth.setdefault(a['ownerSysId'].lower(),set()).add((a['tx'],a['rx'],a['rxRule']))
  gen=lambda s:int(s,16)>>8
  missing=[s for s,e in bp['ecu'].items() if gen(s)<0x14 and s.lower() in truth
           and not ({norm(t[0]) for t in truth[s.lower()]} & {norm(c) for c in (e.get('cands') or [])})]
  pairs=[(s,t) for s,e in bp['ecu'].items() if gen(s)<0x14 and s.lower() in truth for t in truth[s.lower()]]
  print('缺真值候选 sysId(归一后) =',len(missing))       # 172
  print('本sysId真值配对 =',len(pairs),'rx!=+8 =',sum(1 for _,t in pairs if t[2]!='rx=tx+8'))  # 302 / 281
  PY
  ```
- **建议**：把 linkmap §F 命令与本文档此段统一为归一版；PRD P0-1 判据「172→0」的基线数有效，可继续使用。

---

## 附：本账本未改任何 src/tools/data；全部结论可通过上述命令在原包复现。
