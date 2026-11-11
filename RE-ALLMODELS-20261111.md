# RE-ALLMODELS-20261111 — 981 修复方案按 §6 五步规则推广到全量车型（执行记录）

> 承接 `RE-CODINGADDR-20261110.md` §6（全车型复用 5 步规则）。本轮**全部执行完毕**，
> 零上车实验，全部证据来自包内字节（`~/porsche-mapper/ref/decoded/*.BIN` 与 X431 `.so`）。
> 一键复现：`npm run rebuild:all-models`；全量门禁：`node tools/verify-all-models.mjs`
> （已接入 `npm test` 链末尾）；`npm test` 全绿（36+359+105+84+49，0 失败；
> 门禁数随 2026-11-11 全链路审计新增 [G] 组由 38 增至 49）。

## 0. 范围与结果概览

| 维度 | 981 上轮 | 本轮全量 |
|---|---|---|
| 车型 / 平台 | 1 / 1（9X1） | **25 / 14** |
| 定案代际 | 1（0x0E） | **10 平台定案**（8 high + 2 medium；根表 22 type） |
| 模块 → sysId | 48/48 | **601 条**（10 平台，代际一致性 100%） |
| 车型启用平台专属映射 | 981 | **17/25** 车型 |
| bind-plan 键 | 209 sysId | **566 sysId**（含 0x10–0x16 新代） |
| 静态地址解出 | 44/48 | **351/601（58.4%）**；981 保持 44/48 |
| 路由表 | 721 条 / 110 owner / 14 锚点 | 同表 + 16 代索引 + 22 根表 type + **22 锚点** |
| 编码地址来源 | 981 无 ctx+0x638 流 | **全库 3318 条无扩展 / 0 条流** → 全车型统一 coding 池 |
| comm 共享键 | 0x03A7 单点 | **400 条 comm 记录 / 11 种共享键 / 0x03A7 锚点** |

## 1. 五步逐项落地

### 步骤1 换表（`tools/export-all-model-sysids.py` → `data/all-model-sysids.json`）

**平台 → 代际**用**精确 internal join**（用户纪律：禁止任何近似 join）：
```
SYS_DATA 根表 [u8 count=22][[u8 type][u32 off]×22]
  type = 代际前缀本身（实测 20/22 type 的 comm 子表 sysId 高字节 == type）
comm 子表 sysDataOff → 子系统记录表 [u8 count][[u16 len][name\0][6×u32]]（名字集）
平台 ALLDATA 变体名集 ∩ type 子系统名字集 → top1 且 gap≥15% high / ≥5% medium
```
结果（9X1 → 0x0E 380 票/次高 352 与 981 已验收定案**自证规则有效**）：
918S→0x10、992→0x14、9X1→0x0E、CAJUN→0x0F、E2→0x0B、E3→0x12、G1→0x0C、
G2→0x12、G3→0x16、J1→0x15；9X6/9X7/CS1/E1 为 low/unresolved（**保持全局表不猜**）。

**模块 → sysId**：①该代 name-9 变体名投票（flag u16@name-11、sysId u32@name-9、
len u16@name-2）；②新代 0x10+ 的 flag 记录稀少 → 用 **comm 子表 sysId→名字精确 join**
（同一子表按 sysId 组织，名字是精确键，非近似）。9X1 沿用 `981-sysids.json` 的 48/48
已验收结果（含 adjacency/isomorphic/drivelinks-key 收口），保证推广不回退 981。

**车型 → 平台**：`model-map.json`（多平台车型取 isDefault / variantCount 最大）。
只有 high/medium 才 `applyPlatformSysIds=true`。

### 步骤2 路由（`tools/export-sysdata-routing.py` 增强）

- 16B 记录格式跨车型通用，全库 721 条 / 110 owner 不变；锚点自检 14→**22**（新增
  0x0B02/0x0C02/0x0D08/0x0F05/0x1008/0x0A00/0x0607/0x0302 跨代锚点）。
- 新增 `byGeneration`（16 代）与 `rootTypeGen`；另出 `data/sysdata-root-table.json`
  （22 type 的 comm 子表 sysId 清单 / sysDataOff 名字集 / commOff），供步骤 1/3/5 复用。
- owner 语义推广确认：`owner = 代际前缀 + 系统低字节`；DME 路由组代码 = **`0x_0C`
  各代同构**（0x0B0C/0x0C0C/0x0D0C/0x0E0C/0x0F0C 全部存在）。

### 步骤3 绑定计划（`tools/export-bind-plan.py` 泛化，schemaVersion 3）

- `gen = sysId>>8`；**gen≥0x0E 全部走多源分级**（含 0x10–0x16 新代，即使 drivelinks-v3
  无键，也由 comm 子表 sysId 建条目）；旧代 0x05/0x06/0x0B–0x0D 保留表A join 逻辑
  （`test-align431` 对账基线 0x0b08/0x0b12/0x0b13 逐键不变）。
- **DME 路由组零特判**：按「该代 owner=(g<<8)|0x0C 是否存在」自动注入，优先取
  0x7E0–0x7EF can 行（0x0E0C 自证），无则退全量 —— 自动注入 5 个代。
- 跨代候选泛化：同名模块在**所有平台**的 sysId 作为「同系统跨代 sysId」→
  旧代表A 候选 ∩ 路由表 can（精确交集）；前缀多命中时按存活数取并列 top 全部
  （旧代同系统常共享同一候选集，provenance 逐条注明）。
- `coverage` 字段按平台输出静态解出数；981 五项验收内嵌自检全过。

### 步骤4 编码地址（`tools/export-coding-address-sources.py` → `data/coding-address-sources.json`）

通用判定：每条 len-checked name 记录的 6×u32 之后
- 合法 `[u16 len][name\0]` → **无 +2 扩展** → 编码地址走 ALLDATA coding 池；
- 严格 `[u8 n][u32×n][u32×n]` → SYS_DATA 流（解析地址对）；
- 其余 → unknown（如实标注，不猜）。

实测全库 **3958 条 name 记录：3318 无扩展、640 unknown、0 条编码流**；14 个平台的
ALLDATA 变体块 `[22 2e]` 行均充足（9X1 80903 行 / 992 109534 行 …）→
**全车型统一走 ALLDATA coding 池**（coding-v2.json 已按车型提取）。
`Xml_GetCodingAddress` 的 `[u8 n][u32×n]×2` 消费格式见 RE-CODINGADDR §2；
981 之外也没有落位的 name 记录流 → IdSearch 路径的流仍是连接期运行时产物，静态不猜。

### 步骤5 comm 键（`tools/export-comm-shared-keys.py` → `data/comm-shared-keys.json`）

comm 记录格式（全代解析）：
```
[10 03 01][u32 a][u32 b=a+0xD40][03][u8 n][[u16 key][u16 flag]×n]
flag ∈ {0x10,0x20}
```
400 条解析 / 478 条跳过（旧代 0x01–0x0A 头不同或 flag=0，如实统计）；
**11 种共享键**：0x03A7 出现在 280 个不同 sysId / 8 个 type，证实「一个键多模块共用」
（PASM/PSM/IC/SWSG/BKE 等键重叠的包内解释）。运行时**不得**把共享键当模块独占地址证据。

### 运行时接入（`src/model-sysid-map.js` + `src/app.js`）

- `tools/build-model-sysid-map.mjs` 把 `all-model-sysids.json` 编译成**静态 ES module**
  （零 fetch / 零竞态，981 确定性行为不变），导出 `sysIdForModule` /
  `platformSysIdByLowByte` / `modulesForSysId` / `MODEL_SYSID_INDEX`。
- 中文菜单标签按「**系统家族低字节跨代不变**」精确平移（IC 0x0?08、PSM 0x0?05、
  ACC3 0x0?40 …）：Macan `IC(仪表)` → 0x0f08、981 → 0x0e08。
- app.js 全部 `SYSTEM_TO_ECUID[label]` / `MODULE_TO_ECUID[m]` 查表点统一换成
  `sysIdForLabel` / `sysIdForMod` / `modsForSysId` 包装；`currentModel` 未选或
  low/unresolved 平台 → 回退全局 981 表（**宁可不覆盖也不猜**）。
- 地址链 `addrEntryFor → bindPlanFor(sysId) → plan.pairs` 自动按车型选代际条目，
  app.js 无需分支改动。

## 2. 验收（`npm test`，全绿）

| 门禁 | 结果 |
|---|---|
| 981 五项（DME 0x7E0 / PASM 0x7D0 / IC 0x7F1 / IC≠PSM / ≥40） | ✅ 44/48，与上轮一致 |
| 0x0B 对账基线（0x0b08 cands=[0x07F1]、0x0b13 含 0x07D0） | ✅ 逐键不变 |
| 全车型推广门禁 `verify-all-models.mjs` [A–F] + 审计回归 [G] | ✅ **49/49**（[A–F] 38 + [B] P0-4 六条 + [G] 五条，见 `CODE-AUDIT-FULLCHAIN-20261111.md`） |
| 全量既有套件 | ✅ 36 + 359 + 105 + 84，0 失败 |
| app.js 打包（check-bundle） | ✅ |
| 一键复现 `npm run rebuild:all-models` | ✅ 全流程重跑结果一致 |

平台静态覆盖（`bind-plan.json.coverage`）：
918S 19/28、992 25/58、9X1 44/48、CAJUN 43/55、E2 44/59、E3 44/84、
G1 29/46、G2 48/90、G3 28/64、J1 27/69 → **351/601（58.4%）**。

## 3. 剩余开放项（如实落档，不掩盖）

1. **4 个平台未定代际**：9X6（986/996，与全部 type 子系统名字集零交集）、
   9X7（987/997）、CS1（Carrera GT）、E1（Panamera 970）——精确交集平票或无交集，
   按纪律保持全局表；老平台模块名（`9x6_*` / `E1_*`）在 `module-ecu-map.js`
   disposition 块里已有映射，运行时行为不变。补证方向：老平台的 KWP/旧通讯表。
2. **新代静态覆盖偏低**：0x14/0x15/0x16 的路由表无 owner 行（992 0/、J1 0/、
   G3 0/ 路由 owner），只能靠跨代表A∩路由候选；运行时仍有 `app.js` 枚举兜底
   （live-map，按 VIN 缓存 24h），与 RE-DISCOVERY「地址连接期建立」模型一致。
3. **640 条 unknown name 记录**（步骤4）：记录表边界/其它结构，未消费、未判定，
   不猜编码流；若后续发现 IdSearch 侧的 `[u8 n][u32×n]×2` 静态流，按 §2 格式接入。
4. **478 条 comm 记录跳过**（步骤5）：旧代 0x01–0x0A 头格式不同或 flag=0x0000，
   不影响 0x03A7 共享键判定；需要旧代 comm 语义时另做格式解析。
5. 上车实验仍**禁止**；以上全部为离线字节证据，真车地址由探测/枚举终审。

## 4. 接手者最短路径

```bash
npm run rebuild:all-models    # 5 步工具链全量重跑（按依赖顺序）
npm test                      # 981 回归 + 全车型门禁 + 审计 P0 回归（49 条）
```

数据文件（全部由工具生成，勿手改）：
`data/sysdata-routing.json`（v2）、`data/sysdata-root-table.json`、
`data/981-sysids.json`、`data/all-model-sysids.json`、`src/model-sysid-map.js`（编译产物）、
`data/bind-plan.json`（v3）、`data/coding-address-sources.json`、
`data/comm-shared-keys.json`。

要新增/修正一个车型：
① 在 `data/model-map.json` 补车型→平台；
② 重跑 `export-all-model-sysids.py`（平台→代际是数据驱动，无车型特判）；
③ `npm run rebuild:all-models` 全链重算；
④ 若该平台 `confidence=low/unresolved`，先补包内精确交集证据（comm 子表名字集），
   **不要**手工写死 sysId。
