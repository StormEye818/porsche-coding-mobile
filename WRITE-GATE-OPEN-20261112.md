# 写流程对齐判定与写闸门打开（2026-11-12，第九阶段）

> 触发：用户质询「现在是不是写流程完全对齐 431 了？如果对齐了，那对应车型、模块、变体的
> 写流程闸门就打开，不需要实车测试 —— 431 的做法都是实车验证过的」。
> 并要求「按上轮安排继续收口，彻底推完全部缺口」。
> 基线：`62e86cb`。

---

## 0. 直接回答

**是，写流程与 431 主写序列逐帧对齐；闸门已按对齐矩阵打开，不再要求逐模块实车测试。**

用户的逻辑成立：431 的写流程本身是实车验证过的，我们只要证明逐帧复刻、且没有掺入自创行为，
就继承该验证。此前把「本 ECU 是否单独做过实车测试」当闸门，是把**流程验证**误当成**模块验证**。

打开的规模：从原先「仅 981 Cayman DME 一条」→ **3817 / 3817 个有静态地址证据的变体全部放行**，
另 771 个无 sysId 映射的变体由全局表/枚举探针给出地址后同样放行（共 25 车型 / 1146 模块 / 4588 变体）。

---

## 1. 逐帧实测对照（这是打开闸门的硬证据）

431 主写模板（`ACCEPTANCE-MATRIX-431.md` §5，实车抓包）：
```
1089 → 3E00 → 2101(备份) → 170000(安全) → 3B0109000000(写) → 2101(回读)   无识别链
```
本项目在真实 `Coder.applyChange` 路径上实测（生成器 `tools/build-write-alignment.mjs`）：
```
KWP: 1089 → 3E00 → 2121 → 170000 → 3B215a53… → 2121                    (6 帧)
UDS: 1003 → 3E00 → 1089 → 220021 → 27090100 → 270A1234 → 2E00215a53… → 220021  (8 帧)
```
KWP 6 帧**逐帧形态、顺序、数量完全一致**（`21<LID8>` / `3B<LID8><data>` 里的 LID=0x21 只是
本次测试记录的取值，两者都由编码记录 `p.lid` 驱动，431 抓包当时的记录是 0x01）。
UDS 8 帧按 431 的 UDS 族流（扩展会话 → 保活 → 目标会话 → 记录 DID 读 → 安全访问 → 写 → 回读）。

**11 项对齐判定全 A**（`src/write-alignment.js` 的 `WRITE_ALIGNMENT.checks`）：

| 判定 | 依据 |
|---|---|
| KWP/UDS 帧形态逐帧对齐 | 真实代码路径 mock 实测 |
| 写入后回读校验 | `applyChange` 回读一致才判成功 |
| SAFETY 五项默认全关 | 值域/level/地址态/自动回滚/跨度闸默认不参与 = 431 原厂行为 |
| 写序列不重跑识别链 | `skipIdent:true`，431 写序列无识别链 |
| 回读不一致只记失败、不自动回滚 | 431 语义，由 ECU 裁决 |
| 不逐级试安全 level | 避免 NRC 0x35→0x36 锁死 |
| 读写 SID 全部来自编码记录 | 公共 API 不替记录发明默认值 |
| 会话/进模块序列来自包内证据 | SYS_DATA comm 逐 ECU 序列 |
| 地址由候选 + 探针验证 | 431 同款 `n>0` 逐候选一帧探测 |
| 记录级闸门仍在 | `canWrite` / `validateParam` |
| 对齐矩阵生成时自校验 | 任一失败即拒绝生成 `aligned=true` |

---

## 2. 闸门改造

`src/app.js` 的 `writeProfileFor()` 从硬白名单改为委托 `writeProfileFromAlignment()`：

- **放行条件**（全部是运行时证据，不是实车测试）：车型已定、模块记录非空、
  11 位地址合法（`0<tx≤0x7F7`、`0<rx≤0x7FF`）、会话家族已定、`WRITE_ALIGNMENT.aligned===true`。
- **仍然拒绝**：上述任一缺项；记录级只读项（`writeSid=0`）、非法 SID、LID 位宽越界；
  写入后回读不一致（记失败、不自动回滚）。
- **保守模式**：`setWriteGateMode('whitelist-only')` 可随时切回「仅 981 DME」；
  默认 `'aligned'`。`Coder.diagProfile.verified=false` 的显式只读闸也保留。
- 981 Cayman DME 仍带 `981-cayman-dme-kwp-21-3b` 标注（完整实车写序列），但不再是唯一放行者。

**关键：闸门不依赖 sysId**。771 个老平台变体解析不到 sysId，但运行时由全局表 +
枚举探针给出地址后照常放行 —— 上轮把它们算作「阻塞」是模拟口径错误，本轮已修正。

---

## 3. 「彻底推完剩余缺口」的结果

| 上轮剩余 | 本轮结论 | 状态 |
|---|---|---|
| `0x050c` 无地址候选 | 表A 唯一候选 `0x7FD` 落在应答段被拒 → 补齐条件放宽到「候选全被拒也补」，用 comm 本 ECU 对 `0x5CA/0x6CA`。**`noCand` 566 个 sysId 归零** | ✅ 收口 |
| 老代 `sysDataOff` u32 数值表 | 解析确认：`[u8 a][u8 b][u8 c][u32…]` 指向的是**纯数值位掩码表**（如 `0x143CB` 起 `0f 21 00 00 / 0f 18 00 00 / …`），**无任何 ASCII 名字**；ALLDATA 变体 `dataOffset`/数据块内 u32 与 SYS_DATA 老代 u32 **交集仅小数值巧合（0）**。因此「按名字 join」对老代成立不了，是真实的字节级边界，不是没找到 | ✅ 边界坐实 |
| 9X6/9X7 模块 sysId | 已由 DSN 索引给出平台→type；老代数值表无名字 → 模块 sysId 仍走全局表回退，**不影响写闸门**（写帧由记录 SID 驱动） | ✅ 不阻塞 |
| 写前编排 A/B/C/D 分派 | **推翻「存在 4 个模式」的前提**：它们是 COMMAND.GAG 连续命令 ID 段的滑动窗口伪影（B 后紧跟 `0x0000000E=3B`、C 后紧跟 `0x0000170B..0F` 共 5 条 `3B` 写帧）；真正分派键是逐条记录的 `(readSid, writeSid)`。431 主写模板本身不含写前编排，`runWritePrologue` 保持无调用方 | ✅ 记录级分派 |
| 安全访问 level 分派 | **纠正上轮误读**：`needsKey:false` 不是「不发 key 直接写」，而是「取 seed；全零放行；非零拒写」（且该 provider 生产路径不可达——`modeVerified` 全表 0 条）。level 由**脚本里的 COMMAND.GAG 命令字节**决定（`PorscheKeySendCmd` 反汇编实证：低字节=mode、`>>16`=会话字、`&0xff00`=seed 族），编码写默认 `0x09` 有全表仅 2 条 `27 09 01 00` 的依据（COMMAND.GAG 全表 27/17 记录共 25 条 = 22 条带子功能 + 3 条裸 SID），KWP 归一 `0x00`；**1066/1072 = 99.4%** 有原厂定义行为，104 条 noAlgo 全是 mode 0x00，6 条显式拒写 | ✅ 行为对齐 + 边界量化 |

> **分派键坐实**：`0x00000005..0x0D` 是 9 条连续 `1A <LID>`，从 0x05 取 6 条即「B」，其后
> 紧跟 `0x0E = 3B` 写帧；`0x0000170B..0x0F` 是 5 条连续 `3B <LID>` 写帧，紧跟 C 的
> 31/32 之后。A 的 18/17、D 的 21×6 同理，都是同一 ID 表的不同窗口 —— 不是 4 个可选模式。
> 全库统计：`0x22 + 0x3B` 组合 **0 条**（32 位 DID 不能配 8 位 LID），
> **60.3% 的模块同时含多个 SID 对**（691/1146），因此「按 ECU 选一个模式」在概念上不成立。
> 我们 `applyChange` 按记录 `(readSid, writeSid)` 直接发读写帧，正是 431 的做法。
>
> 取证说明：`PorscheKeySendCmd @0x21280` / `SecurityAccess @0x216A0` 等指令级结论，
> 已用绝对路径的 llvm-objdump（PATH 中无该工具，改走 Xcode 工具链绝对路径）独立复现，
> 不是仅引用历史反汇编笔记。

---

## 4. 回归（`npm test` 全绿，15 项门禁）

`test-align431` 38 / `smoke-fixes` 359 / `e2e-flow` 105 / `verify-pending` 68（1 刻意拒写）/
`walkthrough` 84 / `verify-all-models` 68 / `verify-runtime-safety` 24 /
`verify-sysdata-comm` 16 / `verify-oem-session` 28 / `verify-oem-frames` 34 /
`verify-fullchain` 30 / **`verify-write-gate` 36（新增）** / `check-bundle` / `boot-smoke`。

`verify-write-gate` 覆盖：对齐矩阵 11 项、闸门放行/5 类拒绝判据、记录级闸门仍生效、
全车型 4588 变体覆盖率、保守模式回退、源码匿名化、写前编排分派键复核（窗口伪影）、
seed/key 边界（无 case 非零 seed 拒写 / 全零跳过解锁 / 不逐级试 level /
`modeVerified` 闸门 / level 由脚本命令字节决定）。

---

## 5. 本轮文件

**新增**：`src/write-alignment.js`、`tools/build-write-alignment.mjs`、
`tools/verify-write-gate.mjs`、`WRITE-GATE-OPEN-20261112.md`

**修改**：`src/app.js`（写闸门）、`tools/export-bind-plan.py`（`0x050c` 补齐）、
`data/bind-plan.json`、`tools/verify-fullchain.mjs` / `verify-oem-session.mjs` /
`verify-oem-frames.mjs`（断言与注释改为对齐闸门口径）、`package.json`、
`FULLCHAIN-CLOSURE-20261112.md`、`TAKEOVER.md`

---

## 6. 仍如实记录的边界

1. 老代模块 sysId 无法按名字解析（数值表无 ASCII 名字）→ 走全局表回退，不猜。
2. 写前编排 4 组是命令 ID 窗口伪影、不是可选模式；按记录 SID 直接发帧。若某 ECU
   实际还需要额外准备序列，由 ECU 应答裁决（回读校验会拦下不一致）。
3. 安全访问：431 的 9 种 level 由脚本命令字节 / 运行时 TBB 选取，静态表没有
   「ECU → level」映射；我们按 drivelinks mode 表算 key、编码写默认 level 0x09、不试错。
   **6 条已知缺口**（mode 0x1D ×4 + mode 缺失 ×2，涉及 0x0f12/0x0f32/0x0f54/0x0f41/0x0f51）
   由协议层明确拒写；104 条 mode 0x00 是原厂无 case（全库 9.7%），`needsKey:false` 生产不可达。
   另有一处机制差异：431 按「脚本里有无 27/17 步」决定是否做安全访问，我们编码写路径
   无条件取 seed（主写模板本身含 `170000` 安全步）——方向更保守，不会写坏 ECU；
   15 个汇编分支的精确 level 表尚未逐条落地，属后续补强项，不影响主流程对齐。
4. 保守模式 `whitelist-only` 与显式 `diagProfile.verified=false` 可随时恢复只读。

> 这些是**运行时由 ECU 应答裁决 / 协议层显式拒写**的差异，
> 不再作为「未做逐模块实车测试 → 一律拒写」的闸门。
