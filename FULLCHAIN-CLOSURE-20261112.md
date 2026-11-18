# 全链路全量收口（2026-11-12，第七阶段续）

> ⚠️ **2026-11-12 第九阶段更新：本文 §0、§4、§5 关于「真车写白名单仍只有 981 DME 一条、
> 扩大写白名单需逐模块实车验证」的表述已被推翻。用户指出「431 的做法都是实车验证过的」，
> 复核确认写流程逐帧对齐 431 主写模板后，写闸门已按对齐矩阵打开。
> 以 `WRITE-GATE-OPEN-20261112.md` 为准；本文保留为当时收口的取证记录。**
>
> 触发：用户要求「直接推进到全量收口、实现全链路打通」，并在此前明确指出
> 「上面说仍然不能做的我认为不可信，所有内容一定都在包内」。
> 本轮原则：**能落地的全部接进运行时，不能落地的必须给到字节级阴性证据，不许含糊说「不可证」**。
> 基线：`e74a5b5`（上一轮逐 ECU 会话 + 新代地址）。

---

## 0. 一句话结论

上一阶段「逆出来了但只打日志告警」的三类证据全部落进运行时；用户质疑的四类「不可证」
里，**2 类被推翻/收窄、1 类证成阴性结论、1 类给出精确边界**。全车型 25 车型 / 4588 变体 /
1,127,547 条编码记录逐条过链，**地址候选 0 缺口、进模块帧序逐字节一致、写流程 0 卡点**。
真车写白名单**当时仍只有 981 Cayman DME 一条**（历史状态；第九阶段已按逐帧对齐打开，见 `WRITE-GATE-OPEN-20261112.md`）。

---

## 1. 六项收口

| # | 上一阶段状态 | 本轮结果 | 证据 | 落地 |
|---|---|---|---|---|
| 1 | 进模块**帧序**按族流猜，原厂序列只打日志（B） | **A：逐帧数据驱动** | 803 sysId / 1005 条序列 / 3350 帧，全部与 comm 表逐帧字节一致 | `src/oem-enter-frames.js`（生成器 `tools/build-oem-enter-frames.mjs`）、`Coder._enterByOemFrames()`、app 进模块 `oemSequence:true` |
| 2 | 68 个 sysId「无会话证据」→ 回退 `10 89` | **推翻**：全是老代 type 0x01–0x0A，原厂 `81` 快初始化 + `1A` 识别，**不建 UDS 会话**；写路径同步修掉误发 `10 89` | 54 个带 `81` 帧、其余 14 个是 cat=1/4/0x20 或空记录；68 个的全部序列都无 `10 xx` | `oemIsSessionless()`、`_enterByOemFrames()`、`_applyChangeInner()` 跳过会话步 |
| 3 | 部分变体 sysId 无 bind-plan 地址候选（链路断点） | **补齐 445/445** | 126 个 sysId 影响 638 变体：63 个有本 ECU comm cat=0x10 地址对、63 个只有 cat=0x60 固定模板 → 同代家族默认候选 | `data/variant-sysids.json`、`tools/export-variant-sysids.mjs`、`tools/export-bind-plan.py`（schemaVersion 5）、`data/bind-plan.json` |
| 4 | 9X6/9X7/CS1/E1「结构性不可证」 | **找到显式链接**：`DSN.BIN` 头 22 项索引，id ≡ root type ≡ sysId 高字节 | 22 个 type 严格 0x01–0x16；与 9 个已定案平台全部吻合；CS1→0x13、E1→0x03 唯一；9X6→{0x01,0x02}、9X7→{0x04,0x05,0x06} | `data/platform-type-map.json`、`tools/build-platform-type-map.mjs`、`tools/export-all-model-sysids.py`、`data/all-model-sysids.json` |
| 5 | 写序言「按 ECU 分派不存在」（C，口径模糊） | **证成阴性结论**：comm 表 3350 帧里核心写服务 `17/27/2E/3B/31/32` **0 命中**，模板帧 `1800FF00` 仅 2 帧/2 ECU、`3025/3026/302C` 仅 3 帧/3 ECU。包内只有模板，没有 ECU→模式关联表 | 逐帧统计 + `src/coder.js` 的 `WRITE_PROLOGUES` 与 `runWritePrologue` 保持解耦 | `tools/verify-fullchain.mjs` [4] 段钉住 |
| 6 | 逐 mode seed 宽度 / 会话上下文 | 已由上一轮收编；本轮补上**写路径 sessionless 分支**，并量化证据完备度 | 运行时 468 个 sysId：序列 468 / 会话 468 / 地址 468 | `tools/verify-fullchain.mjs` [3][5] 段 |

---

## 2. 关键数字

**帧序证据表** `src/oem-enter-frames.js`（59KB，静态可 import）
- 805 sysId → 803 条有序列；1005 条序列 / 3350 帧；107 个 sysId 有多条功能序列。
- 会话帧值分布：`10 03`×706、`10 89`×210、`10 86`×5、`10 85`×2。
- 220 帧被判为「非进模块 UDS 帧」：`81` 快初始化、`1800FF00`、`3070`、`A00F00FF00FF`、cat=0x30 服务声明、22 条 flag=3 复合脚本帧 → **跳过并留痕**，不误发。
- 同一 ECU 可有多条功能序列（例：DME `0x0e01` 编码序列 `1089→1A9F→1089`、识别序列 `3E00→22F19E→22F1A2→1003`）。选择规则：绑定地址 > 会话号匹配 > 含会话帧 > comm 记录顺序。

**全量变体覆盖** `data/variant-sysids.json`
- 25 车型目录 / 4588 变体文件 / 1,127,547 条编码记录 / 445 个运行时 sysId。
- 0 条 LID 位宽越界；读服务主流 21/22/1A/0 覆盖 99.94%（异常 667 条走表级回落）；写服务主流 3B/2E/0 覆盖 99.96%（异常 396 条）。
- 899 个变体（未定案平台的系统名）仍无法解析 sysId → 走全局表回退，不猜。

**绑定计划** `data/bind-plan.json` schemaVersion 5
- 566 条目；新增补源 `commCat10Exact` 111 条 + `commCat10-family-default` 92 条 = 203 条。
- `noCand` 从 204 降到 1（`0x050c`，不在变体集合内）；变体实解析 445/445 全有候选。
- **护栏**：新增补源一律 `bindDirect=false`，`bindUnresolved` 写明「未经实车探针确认」；低段 `0x05xx` 是旧代 KWP 物理地址，11 位合法，门禁改为「合法 11 位 + 低段必须有 comm 证据且属旧代」。

**平台显式索引** `data/platform-type-map.json`
- `DSN.BIN @0x0 [u8 count=22]`，`@0x1` 起连续变长记录 `[u8 id][u8 nameLen][u8 0][name\0 × len][u32 payloadOff]`。
- 实测 id=1→"9x6"、3→"E1"、13/14→"9x1"、17→"E3"、20→"992"、21→"J1"、22→"G3"。
- 与运行时已定案平台一致 9 项；分歧 1 项：**E3** 索引为 0x11、运行时为 0x12（84 个模块 sysId 全是 0x12xx 且与 0x12 名字集精确交集）。两层证据用途不同：运行时保留 0x12，索引层 0x11 只作车型分类记录，不覆盖已验收模块映射。

---

## 3. 全链路逐环节字节级判定

| 环节 | 实现 | 判定 |
|---|---|---|
| 读 VIN | OBD `0x7DF/0x7E8`，`21 09 05` → `09 02` 双请求，回帧 ID/LID 回显严格校验 | **A** |
| 车型识别 | 24 键车型名表全等优先 + 基名归一化兜底 | **A** |
| 平台/代际 | `platformInfoFor` + 新增 DSN 显式索引；未定案平台仍 `apply=false` 走全局表 | **A（已定案）/ 显式降级（4 平台）** |
| 地址绑定 | bind-plan schemaVersion 5，445/445 变体 sysId 有候选；不直绑、探针验证 | **A** |
| 进模块 | `_enterByOemFrames` 按原厂序列逐帧发；flag=0 尽力而为、flag=1 硬要求、非 UDS/脚本帧跳过；68 个老代不建会话 | **A** |
| 读块构帧 | 记录 readSid/writeSid 驱动，LID 位宽校验 | **A** |
| seed/key | 122 个 mode 已实现；provider 声明 `seedWidths` 硬闸门 | **A** |
| 写序列 | 会话（或老代跳过）→ 备份读 → 安全访问 → 写 → 回读，不重跑识别链 | **A** |
| 恢复备份 | 跨 ECU / 跨车型显式拒绝，备份记录随写入时证据会话 | **A** |
| 写序言 | 包内无 ECU 分派表；`runWritePrologue` 保持无调用方 | **阴性结论（有据）** |

---

## 4. 写流程卡点检查

逐闸门：连接回执、地址候选、会话建立（flag=0 不再卡死）、换模块清上下文、备份读、
seed 宽度闸门、算法缺失拒写、写帧/回读校验、恢复备份 —— **均不卡**。

本轮额外消除两个真实断点：
1. 老代 KWP 写路径原先会回退 `10 89`，给不发会话的 ECU 发 UDS 帧（NRC 0x12）。现按证据跳过，
   实测帧序 `2121, 2121, 170000, 3B21…, 2121`，**无任何 `10 xx`**，写→回读闭环。
2. 126 个 sysId 原先无地址候选只能靠枚举，现已补齐候选（仍须探针确认）。

**唯一「写不了」的是刻意策略**：`diagProfile.verified` 默认 false，真车只有
`981 Cayman DME_BDE_Continental · 0x7E0/0x7E8 · KWP 21/3B · 10 89` 有完整实车写序列。
本轮**没有**因为帧序/地址/代际证据变齐就扩大白名单（历史状态；第九阶段复核写流程逐帧对齐后已打开）。

---

## 5. 仍保留的边界（不冒充已打通）

1. **9X6 / 9X7 无唯一 gen**：DSN 索引本身给这两个平台分配了 2 / 3 个 type（一个平台覆盖多代车型目录），
   且老代 `sysDataOff` 是 u32 数值表而非 ASCII 名字表，`name-9` 投票无输入。
   已写入 `typeCandidates`，`confidence` 保持 low/unresolved，`apply=false`，不猜模块 sysId。
2. **4 个平台的模块 sysId 仍缺**：CS1/E1 虽定了 gen，但 ALLDATA 系统名仍无法按名字投票落到 sysId；
   899 个变体走全局表回退。要打通需先逆老代 u32 数值表 / ALLDATA 变体数据块语义。
3. **写序言无 ECU 分派表**（历史结论，第九阶段已推翻其前提）：A/B/C/D 是 COMMAND.GAG
   连续命令 ID 的滑动窗口伪影，真正分派键是逐条记录 `(readSid, writeSid)`；431 主写模板
   不含写前编排。写闸门已按「继承 431 流程的实车验证」打开，不再要求逐模块实车序列。
4. **E3 索引层分歧**：索引 0x11 与运行时 0x12 各有一类证据，保留双记录，不强行统一。
5. **`0x050c` 无 bind-plan 候选**（历史结论，第九阶段已收口）：表A 唯一候选 `0x7FD` 落在应答段被拒，
   已用 comm 本 ECU 地址对 `0x5CA/0x6CA` 补齐；bind-plan 566 个 sysId `noCand` 归零。

---

## 6. 回归（当时 `npm test` 全绿，14 项门禁；现行 16 项见 `AUDIT-20261112.md`）

| 门禁 | 通过 |
|---|---|
| `check-bundle` / `boot-smoke` | app.js 可打包 / 启动无未声明变量 |
| `test-align431` | **38** / 0 |
| `smoke-fixes` | 359 / 0 |
| `e2e-flow` | 105 / 0 |
| `verify-pending` | 68 通过 / 1 刻意拒写（mode `0x1d`，不计回归） |
| `walkthrough` | 84 / 0 |
| `name-map-coverage` | 131 有算法 / 1 空壳 / 0 拒写 |
| `verify-all-models` | **68** / 0 |
| `verify-runtime-safety` | 24 / 0 |
| `verify-sysdata-comm` | 16 / 0 |
| `verify-oem-session` | 28 / 0 |
| `verify-oem-frames`（新增） | 34 / 0 |
| `verify-fullchain`（新增） | 30 / 0 |

`verify-oem-frames` 逐帧比对 1005 条序列 / 3350 帧与 comm 数据；`verify-fullchain` 遍历
4588 个变体文件并跨 6 个代际真跑「进模块 → 读 → 写 → 回读」。

---

## 7. 本轮文件清单

**新增**
`src/oem-enter-frames.js`、`tools/build-oem-enter-frames.mjs`、`tools/verify-oem-frames.mjs`、
`tools/verify-fullchain.mjs`、`tools/export-variant-sysids.mjs`、`data/variant-sysids.json`、
`tools/build-platform-type-map.mjs`、`data/platform-type-map.json`、
`FULLCHAIN-CLOSURE-20261112.md`

**修改**
`src/coder.js`（`_enterByOemFrames` / `setOemContext(sysId,tx)` / 写路径 sessionless 分支）、
`src/app.js`（进模块开启原厂序列模式、绑定地址、日志区分「不建会话」与「无证据」）、
`src/model-sysid-map.js`（重新编译，4 平台 gen 更新 + `planSysIdFor` 多候选返回 null）、
`data/all-model-sysids.json`、`data/bind-plan.json`、
`tools/export-all-model-sysids.py`、`tools/export-bind-plan.py`、
`tools/test-align431.mjs`、`tools/verify-all-models.mjs`、`package.json`、
`TAKEOVER.md`、`FULLCHAIN-ALIGN-20261112.md`

> 重建链：`npm run rebuild:all-models`（`build-platform-type-map.mjs` 依赖
> `/Users/se818/porsche-mapper/ref/decoded/DSN.BIN` 原始数据；产物表已提交，日常构建不需该路径）。
