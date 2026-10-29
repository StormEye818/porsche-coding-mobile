# 代码审计 — alfaproxi 更新（36a4542 → e649014）

审计日期：2026-10-29
范围：`git diff 36a4542..e649014`，共 4 个提交、10 个文件、+671/−94
方法：逐行读 diff + 关键路径静态推演 + 用 `parseResp` 做实测复现 + 跑现有回归

回归基线：`smoke-fixes 264/264`、`e2e-flow 33/33`、`walkthrough 38/38` 全绿。
**下面的问题现有测试一条都没覆盖**（见文末「测试盲区」）。

---

## 总清单（TL;DR）

| 编号 | 级别 | 问题 | 位置 | 修法（一句话） |
|---|---|---|---|---|
| P0-1 | 数据正确性 | `ATCAF1` 后 `parseResp` 仍按 ISO-TP 解析，多帧读到错块/截断 | `elm327.js:90`、`coder.js:155-197` | 保留 CAF1 并加「纯数据拼接」解析模式；或回 CAF0 并手动补 PCI |
| P0-2 | 寻址 | 身份验证在 `setAddress()` 后未 `address()`，请求打在上一个地址；误判会清正确地址、扫 248 地址、存错邻居 | `app.js:1760-1810` | `setAddress()` 后 `await coder.address()`；更彻底：验证挪到 `enterSession()` 之后用 `lastIdent` |
| P0-3 | 可用性 | candidate 被禁止写入/例程，而 129 个模块全是 candidate，无解除入口 | `app.js:2531`、`196-200` | 验证通过后把 state 提升为 `verified` 并入白名单；或改 `confirm` 二次确认 |
| P0-4 | 仓库完整性 | `www/index.html` 未被跟踪，仓库里 0 个 index.html，clone 不可构建 | `.gitignore`、`scripts/sync.mjs` | 入口移到仓库根并让 sync 拷贝；ignore 收敛为只排除产物 |
| P1-1 | 探测质量 | 归属校验只认 DME 签名，其余模块会被定到第一个有应答的地址 | `app.js:246-258` | 扩到 6 个 proven 模块；对不上标「未确认」且不持久化 |
| P1-2 | 探测性能 | 248 个候选、最坏 22.7 分钟、无进度/取消；`0x7F8→rx 0x800` 溢出；`0x7E2` 重复 | `app.js:236-278` | 先 20 个已知地址命中即停；全量扫描独立入口 + `n/248` + 取消；过滤溢出/去重 |
| P1-3 | 协议分派 | `lastReadSid` 常为 null，KWP 模块例程发 `27 09` 而非 `17 00` | `app.js:3072`、`coder.js:327` | `enterSession()` 读完 1A 后置 `lastReadSid=0x1A`；或 null 时按模块名判 |
| P1-4 | 合规 | UI 日志仍出现「第三方工具名」两处 | `app.js:1731/1735` | 改成「参考诊断仪/探测」 |
| P1-5 | 自检 | L5 把任何 `ok`/`7F` 都算 alive，模块可达永远绿 | `link-doctor.js:209-215` | 只认 `5Axx/62xxxx`；`7F` 单独标「有应答但服务不支持」 |
| P2-1 | 数据 | `983→Cayman(981)`、`984→Cayman(982)` 标签可疑 | `app.js:1043-1044` | 核对 VIN 车型位后再定 |
| P2-2 | 风格 | `ECU_NUM_TO_ADDR` 混用 `0X` 前缀 | `ecu-num-addr.js:18,26,28...` | 统一小写 `0x` |
| P2-3 | 覆盖 | `PROBE_CMD_BY_ECU` 是空表，探测永远只发 1A9F，纯 UDS 模块探不到 | `app.js:24-28`、`262` | 补每 ecu 的 probeCmd；或加 `22F190` 二段探针 |
| P2-4 | 性能 | `enterSession` 读 10 条 1A，无响应时最多 +30s | `coder.js:299` | 无响应时提前 break，或并发/缩短超时 |
| P2-5 | 死代码 | `probeModules()` 已不跑，但文档/注释仍说 L5 | `link-doctor.js:186` | 删掉或标注仅手动 |
| P2-6 | 可用性 | 探测 `model` 参数未使用 | `app.js:214` | 删参或用于车型特定候选 |
| P2-7 | 一致性 | `state.currentAddr` 失败后保留 candidate，再操作只说「未实测」 | `app.js:2531` | 提示里加「重新进模块或手工指定」 |

修法细节见下文各条。

---


## P0-1 ATCAF1 与 parseResp 的 ISO-TP 重组不兼容 —— 多帧读必错

**位置**：`src/elm327.js:90`（`ATCAF0` → `ATCAF1`）、`src/coder.js:155-197`（`parseResp` 重组）

**现象**：改 `ATCAF1` 后，适配器收发都自动加/剥 PCI，应答是多行**纯数据**；
但 `parseResp` 仍按 ISO-TP 帧解析，把数据首字节当 PCI：

| 数据行首字节 | parseResp 判定 | 结果 |
|---|---|---|
| 0x0X | 单帧 | 截断，只取前 n 字节 |
| 0x1X | 首帧 | 期望长度错，后续拼错 |
| 0x2X | 连续帧 | `sawFirstFrame=false` → **整行丢弃** |
| 0x3X | 流控帧 | 整行跳过 |

**复现**（4 行 × 7 字节，共 27 字节真实数据）：

```
输入  59 0A 01 02 03 04 05 06 / 20 21 22 23 24 25 26 / 10 11 12 13 14 15 16 / 30 31 32 33 34 35 36
输出  kind=truncated  len=5  body=12 13 14 15 16
```

**影响**：所有 >7 字节的读都踩——编码块（21/22 读）几乎全是二进制，首字节落
0x0X–0x3X 的概率约 25%。轻则报「多帧截断」读不了，重则返回错块；
而 `applyChange` 的 before/after 比对只校长度不校内容，**错块会被写回 ECU**。
单帧读（1A9F 等）不受影响，所以自检、识别看起来都正常。

**修法（二选一）**：
1. 回 `ATCAF0`，请求侧手动补 PCI 和 padding（`02 1A 9F 00...`），恢复旧解析口径；
2. 保留 `ATCAF1`，给 `parseResp` 加 `caf1` 模式：**不做 PCI 分派，所有行直接拼接**，
   只在首字节 == 0x7F 时判 NRC。方案 2 更简单，但要同时删掉多帧截断校验
   （CAF1 下适配器已保证完整性）。

---

## P0-2 身份验证用了**上一个模块的地址**，且误判会删掉用户地址

**位置**：`src/app.js:1766`（`coder.setAddress(...)`）→ `1771`（直接 `coder.uds('1A9F')`）

`setAddress()` 只改 `this.tx/rx/protocol` 三个属性，**不发 AT 命令**；
真正下发 `ATSP/ATSH/ATCRA/ATFCSH` 的是 `Coder.address()`（`coder.js:239`）。
这段身份验证在 `setAddress()` 之后、`enterSession()` 之前直接发 `uds`，
适配器仍停在**上一步的寻址**上：

- 刚自检完：停在 `ATSH7E0/ATCRA7E8`（DME）
- 刚探测完：停在探测循环**最后一个候选地址**

**后果链**（首次进任意模块必现）：
1. 点「组合仪表」→ `setAddress(0x7E4)`，但请求发到 0x7E0（DME）
2. DME 回 `P200` → 判定「身份不匹配」
3. 清掉该模块的 override → `probeAddressFor()` 扫 ~240 个地址（10–20 分钟）
4. 命中第一个回 `5A` 的地址（多半是 0x7E1 PDK）→ **存成组合仪表的地址**
5. 重识别仍在旧寻址上做，不再校验 → 直接放行

即：进 IC 实际连到 PDK，且错地址被持久化。这比原来的「不验证」更危险。

**修法**：`setAddress()` 后立刻 `await coder.address()`；更好的做法是把整个
身份验证块移到 `await coder.enterSession(0x89)`（`app.js:1968`）之后，
直接用 `coder.lastIdent` 比对——那时寻址已正确、识别串也已采全。

---

## P0-3 写入门禁把「候选地址」全拒了，且没有解除路径

**位置**：`src/app.js:2537`（`addrSafeForAction`）、`196-200`（`ecuAddrFromNum`）

```js
if (st && !['measured', 'probed', 'manual'].includes(st)) → 拒绝
```

而新的 ecu 号桥接对**所有**非实测模块返回 `state: 'candidate'`
（`ECU_ADDR` 里只有 DME、网关是 `measured`）。结果：

- 组合仪表 / 空调 / ABS / 气囊 / PDK…… 能进、能读，**不能写、不能跑例程、不能执行特殊功能**
- 提示让用户「先探测或手工确认 tx/rx」，但候选地址有 tx，不会触发探测；
  手工输入只在探测**失败**时才弹 → **无 UI 路径可解除**

这是功能回归：36a4542 之前这些模块可以写。特殊功能 58 项同样被整体挡住。

**修法**：候选地址 + 身份验证通过 → 允许写（把 `currentAddr.state` 提升为
`'probed'`/`'verified'`）；或对 candidate 改为 `confirm` 二次确认，
而不是硬拒。门禁本身保留，但不该没有出口。

---

## P1-1 探测没有归属校验，除 DME 外都可能定错

`KNOWN_SIGS` 只有 `P200` / `98161864015` 两条（都是 DME）。探测只要求
「正响应 5A/62」，任何活着的 ECU 都算命中 → 第一个有应答的地址就是「目标模块」。
未知地址模块（驻车制动器、KESSY 等）会被稳定定位到 0x7E1 之类的邻居。
建议把 6 条 proven 模块的 DSN/零件号特征都补进签名表，并用 参考诊断仪 目录里的
零件号做二次核对；对不上就报「候选未确认」，不要直接持久化。

## P1-2 探测耗时 10–20 分钟且不可取消

`probeAddressFor` 全量扫 0x700–0x7F8（约 240 个地址），每个地址
`ATSH(1500) + ATCRA(1500) + 1A9F(2500)` 最坏 5.5s → 22 分钟；
期间只有一句 loading，没有进度百分比、没有取消按钮。真车上很容易被当成死机强杀。
建议：先只试已知 20 个地址（8 标准 OBD + 12 proven/扩展），命中即停；
全量扫描改成用户显式点「深度扫描」，并显示 `n/240`。

## P1-3 `lastReadSid` 为空 → KWP 模块的例程用错协议

`lastReadSid` 只在 `_readBlockImpl()` 成功后赋值（`coder.js:432`），
`setAddress()` 会重置为 `null`，而身份验证/识别走的是 `uds()` 直发，不经过 readBlock。
于是「进模块 → 直接点例程」时 `lastReadSid === null` → `kwp=false` →
对 KWP 模块（IC/AC）发 `27 09 0100`，而它们要的是 `17 00 00`，直接 NRC。
`enterSession` 已经读过全套 1A（全是 KWP 服务），却没把这件事记下来。

## P1-4 UI 日志里出现第三方工具名

`app.js:1731` `` log(`…启动 参考诊断仪 探测…`) `` 会直接显示在用户日志区；
`1735` 的 `note: '参考诊断仪 探测命中'` 也可能被带到提示里。此前已按你的要求把
用户可见文案全部中性化，这次更新又漏回来两处。其余 24 处都在注释里（不进 bundle）。

## P1-5 自检 L5 的「模块可达」判定过宽

`link-doctor.js:209-215`：`kind==='ok' && body.length` 或 `7F` 都算 `alive`。
任何噪声字节都会让模块显示「有应答」——L5 从此不可能失败。
目前 `probeModules()` 已从 `run()` 摘掉（变成死代码），所以只影响手动调用；
若要保留，应只认 `5Axx`/`62xxxx` 正响应，`7F` 单独标「有模块但服务不支持」。

---

## P2 / 观察

- `guessModelFromVin` 新增 `983 → Cayman（981）`、`984 → Cayman（982）`，
  与既有 `98B/98C` 标签重复；983/984 更像 718 代，建议核对 VIN 车型位再定。
- `ECU_NUM_TO_ADDR` 混用 `0x` / `0X` 前缀。`parseInt(...,16)` 能认，但换成
  `Number()` 就是 `NaN`，建议统一小写。
- `probeAddressFor(label, probeCmd, model)` 的 `model` 参数未使用。
- `PROBE_CMD_BY_ECU` 是空对象，探测永远只发 `1A9F`；参考诊断仪 主力是 UDS `22F190`，
  纯 UDS 模块永远探不到。
- `probeAddressFor` 里扩展地址表与标准段有重复（0x7E2 会出现两次），只多花一次超时。
- `state.currentAddr` 在 `enterSystem` 失败返回时保留 `needs-probe`/`candidate`，
  下次动作会被门禁拦——行为正确，但提示文案没告诉用户「重新进模块」。

## 测试盲区（建议补）

1. `parseResp` 在 CAF1 多行输入下的行为（本次用 27 字节复现，可固化成用例）
2. `setAddress()` 是否真的把 AT 命令下发（断言 `coder.address()` 被调用）
3. `addrFor()` 返回 candidate 时，`addrSafeForAction()` 的预期（当前逻辑互相矛盾，
   测试里应明确「允许」还是「拒绝」）
4. 探测命中后是否写入了 override（mock 适配器可以喂固定应答）

## 建议修复顺序

1. **P0-2**（一行 `await coder.address()`，或整体挪到 enterSession 之后）——风险最低、收益最大
2. **P0-1**（CAF1 解析或回退 CAF0）——决定所有读写正确性
3. **P0-3**（给 candidate 一条出路）——决定功能可用性
4. P1-1、P1-2（探测质量与耗时）
5. 其余 P1/P2

---

# 复查：本地未推送的 `iphone-duo` 分支（2026-10-29 11:30）

## 未推送的内容是什么

`git log --branches --not --remotes`：5 个提交，全部在 `iphone-duo` 上（main 已与 origin 同步）。

| 提交 | 内容 | 与本次审计的关系 |
|---|---|---|
| 875a4cb | Duo 安全区留白误判 + 装机钉死新机 | UI/装机 |
| d9ee430 | 装机 0xe8008012：destination 写 id + 设备注册 | 装机 |
| 55d52c7 | Duo 横屏状态栏：删 JS 量测，改 env()，overlay=true | UI |
| 3f3b2f0 | 与上游 3444465 同内容 | 通信/寻址，**与 main 一字不差** |
| 01a4924 | 与上游 e649014 同内容 | 同上 |

等价性验证：`git diff e649014 01a4924` 只剩 4 个文件 +50/−35（三个 iOS 提交的净效果），
说明 **01a4924 的通信/寻址代码与 audit 过的 e649014 完全相同**——本地没有另一套修复。

## 三个 P0 在 iphone-duo 上的实际状态

| 问题 | 证据（iphone-duo） | 状态 |
|---|---|---|
| P0-1 CAF1 解析不兼容 | `git show iphone-duo:src/elm327.js` 第 90 行仍 `ATCAF1` | **未修** |
| P0-2 身份验证用错地址 | `git show iphone-duo:src/app.js` 第 1760 行 `setAddress`，之后无 `address()` | **未修** |
| P0-3 candidate 门禁死锁 | 第 2531 行 `addrSafeForAction` 原样 | **未修** |

P1 五项同样原样保留。

## 对 iOS 三个提交的评估

**安全区（55d52c7 + 875a4cb）——方向正确，但只做了一半入库**

- 删掉 `fitSafeTop()`（用 `innerHeight/innerWidth > 2.0` 猜刘海，Duo 的 1.42–1.46 长宽比必判错）
  和 `setOverlaysWebView({overlay:false})`（会让 `env()` 归零），改 `overlaysWebView: true`
  + 纯 CSS `env(safe-area-inset-*)`——这是 WKWebView 的标准解法，判断正确。
- 但 CSS 那一半在 **`www/index.html`，该文件没有被 git 跟踪**（`git ls-files` 里 0 个 index.html）。
  10-25 20:04 改的 `#safeTop{height:env(safe-area-inset-top,0px)}`、body 左右 padding、
  main 底部 padding 全部只存在于本机。
- 也就是说：这次「修好了」只在当前工作区成立；换机器 clone 仓库，`www/` 整个不存在
  （`.gitignore` 有 `www/`），app 连入口页都没有。

→ 新增 **P0-4：仓库缺少 HTML 入口，clone 不可构建**。`www/index.html` 是手写源文件，
  却和构建产物一起被忽略。修法：把入口移到仓库根 `index.html` 或 `src/index.html`，
  让 `scripts/sync.mjs` 拷贝到 `www/`；`.gitignore` 收敛为只忽略 `www/app.bundle.js`
  和 `www/data/`。

**装机脚本（875a4cb + d9ee430）——修得对，但有两处脆弱点**

- 0xe8008012 的根因判断准确：团队 profile 没有新机 UDID，必须
  `-destination "id=$UDID"` + `-allowProvisioningDeviceRegistration` 同时给。
  用 `generic/platform=iOS` 时 destination device 不存在，注册开关等于没开——这条注释是对的。
- 脆弱点 1：`DEFAULT_UDID="00008160-000C043A1420000A"` 硬编码 iPhone Duo。
  换机、换线、或 Duo 不在线时脚本直接退出；建议回落「取第一台 physical」并打印候选。
- 脆弱点 2：`grep -q "Developer Mode is turned off"` 依赖 devicectl 的英文原文，
  系统语言或 Xcode 版本变化就失效（失效时只是少一条友好提示，不阻断，可接受）。

## 复查结论

1. 本地没有「已经修过 P0」的提交——三个 P0、五个 P1 在 `iphone-duo` 上全部仍在。
2. 未推的 5 个提交是 iOS 安全区 + 装机脚本，与我审的通信/寻址问题不重叠。
3. 安全区修复思路正确，但 CSS 落在未跟踪文件里，**并且暴露了 P0-4（仓库缺入口页）**。
4. 装机脚本可用，硬编码 UDID 建议改成可回落。

---

# 对三个提交说明的逐条核验（2026-10-29 11:35）

远程 `origin/main` 仍是 `e649014`（没有更新推上来），所以核验对象就是这三个提交
自己写的修复清单。结论：**绝大多数条目都有对应代码，不是空话；但有 3 处与说明不符，
其中 2 处是反效果**。

## a1ec3bb「安全门禁 + 解析正确性 + 扫描覆盖」

| 说明 | 代码事实 | 判定 |
|---|---|---|
| NRC 7F 不再算命中，只认 5A/62 | `probeAddressFor` 只对 `5A/62` return，7F 只记日志 | ✅ |
| 候选地址禁止写入/例程 | 已实现，但没留解除路径 | ⚠️ 就是 P0-3 |
| ECU_NUM 标 candidate 不冒充实测 | 全部 candidate | ✅ 但与上一条互相矛盾 |
| 变体未识别保持写入锁定 | `delete selectedVariant` + `doWrite` 拒写 | ✅ |
| KWP/UDS 安全访问分派 | `securityAccessEx` 内部归一正确；但 app 侧用 `lastReadSid` 判断，它常为 `null` | ⚠️ 部分（P1-3） |
| parseResp 孤立 CF 不拼接、单帧重置 | 代码有 | ⚠️ 逻辑对，但 CAF1 下整段不适用（P0-1） |
| 扫描覆盖 7CF/74F、去重、rx 溢出保护 | `scanEcuAddresses` 有；`probeAddressFor` **没有** rx 保护 | ⚠️ 只做了一半 |
| 扫描结果持久化 | 仅「唯一候选」才 `saveAddrOverride` | ✅ |
| 多候选不自动归属 | 已实现 | ✅ |
| setAddress 29-bit 切 ATSP7 | 只改属性，AT 命令要等 `address()` 才下发 | ⚠️ 名义实现 |
| validatePair 收紧 | 已实现 | ✅ |

## 3444465「全量 129 ecu 探测 + 变体手动 + VIN 全系」

| 说明 | 代码事实 | 判定 |
|---|---|---|
| 全量 129 ecu | 152 个不同 ecu 号 − 23 个有地址 = **129** | ✅ 数字准确 |
| 探测覆盖 0x700–0x7FF | 实际 `0x700..0x7F8`；0x7F8 的 rx=0x800 超出 11-bit；0x7E2 重复一次 | ⚠️ 差 7 个地址 + 1 条溢出 |
| 只跳过 measured | 是 | ✅ |
| 已知候选地址优先于探测 | 代码顺序相反：`fromRe needs-probe` 在 `ecuAddrFromNum` **之前** | ❌ 不符 |
| 探测 2.5s、只发 1A9F | 是；但 248 个候选、最坏 22.7 分钟 | ✅ 但代价没写进说明 |
| 变体手动选择器 | 已实现，选中即解锁写入 | ✅ |
| VIN 21 码 | 表里正好 21 条 | ✅（983/984 标签仍待核） |

## e649014「身份验证 + 全套识别 + SID 回退 + 探测验证」

| 说明 | 代码事实 | 判定 |
|---|---|---|
| A 身份验证：签名不匹配清 override + 重探测 | 逻辑在，但发生在 `setAddress()` 之后、`address()` 之前，**请求打在旧地址上**；签名只有 DME 两条 | ❌ 反效果（P0-2） |
| B 全套 1A xx 识别 | 10 条（9F/87/84/94/95/91/92/93/97/9A） | ✅ |
| C readBlock SID 回退 | 仅 NRC 0x12 时 22↔21 | ✅（范围窄） |
| D 探测身份验证 | 只认 DME 的 `P200`/零件号 | ⚠️ 只防住 DME（P1-1） |
| E 变体手选兜底 | 与 3444465 重复 | ✅ |

## 核验结论

1. 说明里的条目基本都能在代码里找到落点，作者不是空写。
2. **三处名不副实**：
   - 「身份验证」实际在错误地址上执行 → 首次进非 DME 模块会误判、清掉正确地址、
     再扫 248 个地址并把邻居 ECU 存成目标（P0-2）。
   - 「候选地址优先于探测」与 `addrFor` 的实际顺序相反。
   - 「解析正确性」只改了 `parseResp` 的边角，没处理 `ATCAF0→ATCAF1` 带来的
     整段不兼容（P0-1）。
3. a1ec3bb 里「candidate 不冒充实测」和「候选禁止写入」是两条互相咬死的规则：
   前者把 129 个模块全标 candidate，后者把它们全挡在写门外，且没有解除入口（P0-3）。
4. 三条提交的测试都只跑 smoke/e2e/walkthrough，这三条链路都走 mock 适配器，
   不会暴露 CAF1 多帧、错误寻址、门禁死锁——「264 全绿」不能作为这些修复有效的证据。

---

# 修复记录（2026-10-29 12:05）

## 修复前新发现的两个 P0（原文没说，但阻断发布）

**P0-5｜`src/app.js` 语法错误，源码根本打不出包**
`app.js` 变体手选提示里 `.join('\n')` 被写成了**真实换行**（单引号字符串里换行），
`node --check` 直接报 `Invalid or unexpected token`。`www/app.bundle.js` 停在 10-27，
说明 `e649014` 之后从未成功 esbuild 过。已改回转义 `\n`，现在 `npm run sync` 正常产出 212KB。

**P0-6｜`CodingError` 只有 `.nrc`，`readBlock` 却判断 `e.code`**
`this.nrc = nrc` 没有 `this.code`，所以「NRC 0x12 → 22↔21 回退」这条**从未生效**。
已在构造里补 `this.code = nrc`（两个名字都留），并加了真实回退用例。

## 逐条修复

| 编号 | 改法 | 验证 |
|---|---|---|
| P0-1 | 新增 `parseRespCaf1()`：CAF1 下不做 PCI 分派，按行拼纯数据，只判 NRC/STOPPED；`Coder.uds`、探测、L5、地址扫描全部切过去；`parseResp()` 保留给 CAF0 | `[20]` 28 字节 4 行含 0x10/0x20/0x30 首字节完整拼接；mock 32 字节块完整读回 |
| P0-2 | `setAddress()` 改 async，内部 `await this.address()`；进模块、重探测两处都 await；身份验证因此落在正确地址上 | `[20]` 断言 ATSH7E4/ATCRA7EC 真的发出、换址后请求落在新 tx |
| P0-3 | 门禁白名单加 `verified`；身份验证通过即提升；candidate 改为 `confirm` 二次确认（不再硬拒，也不再无出路） | `[20]` 源码断言 + 白名单存在性 |
| P0-4 | 入口页移到仓库根 `index.html`（受版本控制），`sync.mjs` 负责拷进 `www/`；缺文件直接报错 | `[20]` 根 index.html 含 `#safeTop`/`env(safe-area-inset-top)`，sync 有拷入逻辑 |
| P1-1 | 探测结果标 `probed-unverified`，**不再自动持久化**；进模块时弹 confirm 展示 tx/rx + 识别串，确认后才 save；DME 签名命中直接跳过 | `[20]` 断言 confirm 在 save 之前 |
| P1-2 | 探测分两阶段（常用 ~19 个 → 深度 229 个，命中即停）；loading 带 `n/total` 和取消按钮；`rx > 0x7FF` 过滤；`seen` 去重 | `[20]` probeAbort / 深度扫描 / rx 过滤断言 |
| P1-3 | `enterSession` 读完 1A 后置 `lastReadSid = 0x1A` | `[20]` 真跑 `enterSession(0x89)` 后断言 = 0x1A |
| P1-4 | UI 日志「启动 参考诊断仪 探测」→「启动地址探测」；`参考诊断仪 探测命中` → 「探测命中（人工确认）」；全部源码 0 命中 | `[20]` `!app.includes('参考诊断仪')` |
| P1-5 | L5 只认 `5Axx/62xxxx` 为正响应；7F 单独计 `nrcOnly`，不再置 alive，也不进 found | `[20]` 源码断言 + 解析器切换 |
| P2-1 | 983/984 标「待核对」，不再伪装成已知车型 | 人工核对 |
| P2-2 | `'0X...'` 全部改小写 `0x` | `[20]` 无 `'0X` 残留 |
| P2-3 | 1A9F 回 NRC 0x11/0x12 时自动补发 `22F190`（纯 UDS 模块可被探到） | 代码路径 |
| P2-4 | 识别循环连续 3 条无数据即 break（最坏 30s → ~9s） | `[20]` `identMiss >= 3` |
| P2-5 | `probeModules()` 标 `@deprecated`，说明已不在自检里跑 | 注释 |
| P2-6 | `probeAddressFor` 删除未使用的 `model` 参数 | 调用点 |
| P2-7 | 门禁拒绝文案补「先跑地址扫描或手工指定 tx/rx」 | 文案 |

## 测试基础设施：让 mock 更像真车

这是本轮改动最大的一块，之前「264 全绿」之所以没发现问题，就是因为 mock 和真车不是一套口径：

1. **`MockAdapter` 默认 `caf=1`**：应答按真车 ELM327 行为输出——自动剥 PCI，
   多帧拆成「每行 ≤7 字节的纯数据」，CAN ID 11-bit 用 3 位、29-bit 用 8 位。
   `caf:0` 保留旧的带 PCI 输出，供 CAF0 解析器回归。
2. **地址拓扑**：新增 `strictAddress + ecus`。给了拓扑就只回应表里存在的 tx，
   其余地址回空（真车就是 NO DATA）；还按 `kwp` 标记做协议分派——
   KWP 模块收到 22/2E/27 回 NRC 0x11，UDS 模块收到 21/3B/17 回 NRC 0x11。
3. **测试数据去 PCI**：`smoke` 的 SEED_SF、扫描 fake、`walkthrough` 的 3B 假响应
   原来都写成 `04 67 09 12 34` / `02 7B 21` 这种 CAF0 格式，全部改成纯数据。
4. **新增 `[20] 真车链路` 一节 30 条断言**：CAF1 多帧（含 0x10/0x20/0x30 首字节）、
   mock 编码块完整读回、setAddress 真的下发 AT、严格拓扑、协议分派、
   22↔21 回退、lastReadSid、门禁/入口文件等硬约束。

## 回归

- `smoke-fixes` **297 / 297**
- `e2e-flow` **33 / 33**
- `walkthrough` **38 / 38**
- `npm run sync` 产出 `www/app.bundle.js` 212KB（修复前源码无法打包）

## 仍需真车验证（代码层面已尽力）

1. CAF1 长响应：部分山寨适配器对 >100 字节的多帧会截断，`STOPPED` 已判截断但没实测过。
2. 身份验证只认 DME 签名；其他模块的归属仍靠用户 confirm（没有可靠 DSN 样本）。
3. 深度扫描 229 个地址在真车上的实际耗时（估 15–20 分钟）。

---

# 流程分层复查（2026-10-29 12:30，按「自检只验接头」的要求）

## 结论

| 阶段 | 要求 | 实际 | 判定 |
|---|---|---|---|
| 连接自检 | 只验配件/会话/协议，不读车模块 | `run()` = L1 配件 → L2 EA 会话 → L3 ELM → L4 协议锁定，L5 已摘掉 | ✅ 基本对齐 |
| 自动搜索 | 读 VIN 匹配车型 | 只读 `22F190` → 兜底 `1A 90/9F/97/87/91/88`，再按 VIN 7–9 位匹配 | ✅ |
| 进模块 | 触达该模块并读**全部**设码项 | 原来只预读前 8 个块，其余滚到分组才补 | ❌ 已修 |

## 唯一「会在自检里发车」的动作

L4 协议锁定会向 DME（`ATSH7E0/ATCRA7E8`）发一条 `1A9F`：

- 不发就无法判断 11/29-bit、500k/250k —— 波特率错时后续全是 CAN ERROR；
- 它只读一条识别，不读模块数据、不探测其他 ECU，和「自检只验接头」不冲突；
- 参考诊断仪的自检同样要一条请求才能确认协议。

如果要求连这一条都不发，只能靠适配器 `ATDPN` 猜协议，真车可靠性会明显下降。建议保留。

## 顺带发现的 P0-7：`updateLoading` 从未定义

`app.js` 里两处调用 `updateLoading(...)`（进模块读块前、执行特殊功能序列时），
但**全文件没有定义**（`git log -S` 显示 5637dad 就有调用）。后果：

- `enterSystem` 在 `try` 里调用 → `ReferenceError` 被 catch 吞掉 → **返回 false，点模块永远进不去**；
- `runSequence` 执行到第一条命令就断。

已补 `updateLoading(title, detail, onCancel)`（复用 loading 的 DOM 与取消按钮），
并加 smoke 断言防止再次丢定义。

## 进模块改为全量读取

- 去掉 `lids.slice(0, 8)`，改为遍历全部 `lids`；
- loading 显示 `n/total`，可点「取消」中止（已读的保留）；
- 失败块继续逐条记日志，最后 toast 汇总 `失败数/总数`；
- 就绪提示改成「N 个参数 / M 个编码块已读」。

代价：真车上块多的模块（20–40 块）进模块会多花十几秒，这是对齐「进模块即读全量」的必要成本；
嫌慢可以中途取消，已读部分照常显示。

---

# 运行时回归：启动即 `Can't find variable: tree`（2026-10-29 14:30）

## 根因

`1c3271c` 重写 loading（`showLoading`/`hideLoading`/`updateLoading`）时，替换区间一直覆盖到
`// ---------- ① 连接 ----------`，把夹在中间的**整块模块级状态声明**一起删掉了。
`e649014` 里原本有：

```js
let doctor = null, elm = null, coder = null;
let tree = null;
let coding = [];
let stack = [];
let currentParam = null;
let simMode = false;
let modelsCatalog = null;
let currentModel = null;
const loadedVariants = new Map();
const state = { multiVariantModules, selectedVariant, currentAddr };
```

ESM 是严格模式，`loadAll()` 里 `tree = t` 对**未声明的标识符赋值**会直接抛
`ReferenceError: Can't find variable: tree`（Safari 文案），被
`loadAll().catch(...)` 捕获后打印「载入失败: Can't find variable: tree」——
所以一启动就报，什么都还没做。

`node --check` 只查语法、esbuild 只做打包，两者都不会发现未声明赋值，所以整轮测试全绿也没拦住。

## 修复

- 补回上述 10 个声明 + `state` 对象（放在 `// ---------- ① 连接 ----------` 之前）；
- smoke 新增 14 条断言：
  - 「顶层没有未声明赋值」（用声明集合与 `^name =` 赋值做差集，通用兜底）；
  - 12 个状态变量逐个断言已声明（防止再次被整段替换误删）。

## 回归

`smoke 314/314`、`e2e 33/33`、`walkthrough 38/38`、`sync` 212KB。

## 教训

`1c3271c` 之后任何一次装机都会启动即崩——这类「严格模式未声明变量」只能靠运行时暴露。
后续再动 app.js 的大段结构，除了跑 smoke，至少要人工看一眼被替换区间的**起止锚点**是否吃掉了声明。
