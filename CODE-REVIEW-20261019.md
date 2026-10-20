# 代码审查报告 — porsche-coding-mobile

**审查对象**：`github.com/StormEye818/porsche-coding-mobile` @ `6044d9e`
（feat: ECU 寻址接入 + 全量审计修复 + 显示/写入对齐）
**审查时间**：2026-10-19
**方法**：克隆后补全被 .gitignore 排除的数据 → 跑全部回归 → 逐模块静态审查 → 关键点写脚本实测验证

> ⚠️ 先说明：仓库 clone 下来 **`npm test` 直接崩**（缺 4 类数据，见 P1-1）。
> 我补了 `data/models`、`tools/vectors`、`menu-tree-v3.json` 并生成了 `www/` 之后，
> 回归才是全绿的：**smoke 233/233 · e2e 33/33 · walkthrough 38/38 · verify-pending 65 通过**。
> 下面 8 个问题**全部在测试覆盖盲区里** —— 绿灯不代表没问题。

---

## P0-1 特殊功能：67 条**未核实**的 routineId 被做成默认可执行按钮

**位置**：`src/app.js:2638-2647`（渲染）、`src/app.js:2834-2843`（绑定）

```js
<button class="spRun" data-rid="${esc(f.routineId)}" ...>执行</button>
```
```js
$('paramBox').querySelectorAll('.spRun, .vRun').forEach((b) => {
  if (b.disabled) return;
  b.onclick = () => execRoutine({ rid: parseHex(b.dataset.rid), sub: 01, ... });
});
```

**问题**：`data/special-functions.json` 里 **67 条全部 `routineIdVerified: false`**，
且该文件自己的 `source.routineIdNote` 写着：

> routineId 是手工分配的菜单索引（0x200-0x34E 连续块），与实测例程 ID
> (GAG 79 个唯一 RID) 几乎零重叠（**交集仅 1 个**）。执行前必须真车核对。

但 UI **完全忽略** `routineIdVerified`：
- 没有「未核实」标记；
- 按钮默认可点，确认框只写「确认执行『机油加注』？例程会真的让 ECU 动作」——
  用户看到的是中文功能名，**看不到 RID 是假的**；
- 同时**可信的 79 个 实测基准 RID 被收进「高级/调试」折叠区**，默认不可见。

**后果**：用户点「机油加注」实际发 `31 01 0301`（手工编号）。两种结局：
1. 该 RID 不存在 → NRC 0x31（无害，但功能等于没有）；
2. **恰好命中同一 ECU 上另一个真实例程** → 执行了完全无关的动作（复位/学习/驱动），
   `special-functions.json` 里这些项本身标着 `risk: high`。

这是**用「看起来像诊断仪」换掉了安全性**，且比之前的做法更危险：
之前是禁用（功能缺失但安全），现在是默认可执行（功能假、风险真）。

**建议**（两种选一，不要折中）：
- **A（推荐）**：恢复 `routineIdVerified === false` 的拦截，但不要死按钮 ——
  渲染成「试执行（未核实）」，确认框里写明「手工菜单索引，与实测 RID 交集仅 1 个，
  可能 NRC 0x31 或命中别的语义」；同时把 79 个实测 RID 提到主区。
- **B**：拿到 `SPECFG.INI` 的 `[SYS_SPEC]` 做权威对账，把 verified 转正。

⚠️ 注意：`smoke-fixes.mjs` 里【曾经有过】「67 条必须全部 verified=false」的防退化断言，
这一版没有对应断言了 —— 建议补回来，否则同类回归会再发生一次。

---

## P0-2 多变体写入闸门**形同虚设**（97.4% 的模块受影响）

**位置**：`src/app.js:1782-1784`（填充）、`src/app.js:2313-2317`（闸门）

```js
// enterSystem()
const auto = autoPickVariant(mi, coder.lastIdent);
state.selectedVariant[mod] = auto.name;        // ← 无条件赋值，包括"未识别"
```
```js
// doWrite()
if (state.multiVariantModules?.has(p.module) && !state.selectedVariant?.[p.module]) {
  toast('err', ... '变体未自动识别' ... '写入被拒绝'); return;
}
```

**问题**：`autoPickVariant()`（`src/variant.js:51`）在识别失败时**也会返回一个名字**：

```js
return { name: names.includes(def) ? def : names[0], how: '未识别，用 参考诊断仪默认变体' };
```

于是 `selectedVariant[mod]` 永远有值 → `doWrite` 里那个 `!state.selectedVariant[...]`
**永远为 false** → 闸门从不触发。

**影响面实测**：`models-catalog` 里 **1146 个模块中 1116 个是多变体（97.4%）**，
典型如 `BCM_vorne` 14 个变体、`BCM_hinten` 8 个、`ACC3` 6 个。
`variant.js` 的注释自己写着「不同变体的 byte/bit 映射**可能完全不同**」。

**后果**：车上是 A2 变体、默认是 BaseSys 时，`injectField` 会按错误映射改字节，
写进 ECU 的是「看起来改对了、实际改错位」的数据 —— 而回读校验**也会通过**
（回读用的是同一套错误映射），这是最难发现的一类错误。

**建议**：
```js
// enterSystem
const auto = autoPickVariant(mi, coder.lastIdent);
if (auto.how.startsWith('未识别') || auto.how.startsWith('无识别文本')) {
  delete state.selectedVariant[mod];           // 保持闸门关闭（只读）
} else {
  state.selectedVariant[mod] = auto.name;
}
```
并把 `doWrite` 的提示改成「已用默认变体显示，但写入被拒绝 —— 请核对 1A9F/94 识别串」。

---

## P1-1 仓库不能自举：`npm test` 崩在第一步

**位置**：`.gitignore` vs `smoke-fixes.mjs:282 / 416 / 1102 / 1138`

`.gitignore` 排除了：`data/models/`、`data/menu-tree-v3.json`、`tools/vectors/`、`www/`。
但 smoke 硬依赖这四样：

| 缺失项 | 崩点 |
|---|---|
| `data/models/` | `readdirSync('data/models')` → ENOENT |
| `tools/vectors/mode-samples.json` | ENOENT |
| `data/menu-tree-v3.json` | ENOENT |
| `www/app.bundle.js` | ENOENT（需先 `npm run sync`） |

**后果**：任何人（包括未来的你 / 别的 agent）clone 下来都**跑不了回归**，
只能盲改。现在这个仓库实际上是「源码 + 半套数据」。

**建议**（任一）：
- 把 `data/models` 等做成 `npm run data` 能从公开源重建的脚本，并在 README 写清引导顺序；
- 或 smoke 里对缺失目录做 `existsSync` 守卫，缺就 `skip` 并显式打印「跳过 N 组（缺数据）」。

第二种成本低，至少不会让人误以为测试是绿的。

---

## P1-2 例程执行把安全访问**写死成 UDS**

**位置**：`src/app.js:2805-2807`

```js
if (coder.seedKeyProvider && sub !== 0x02) {
  await coder.securityAccessEx({ level: 0x09, kwp: false });   // ← kwp 写死 false
}
```

**问题**：`coder.js` 里 `securityAccessEx` 明确支持 KWP（`17` 系，`level` 归一成 0x00），
且注释写着「KWP 的 level 和 UDS 不是一套，发错会白吃一次安全尝试计数」。
但这个调用点写死 `kwp: false` → **KWP 模块（21/3B 那 55 个）执行例程前会发 `27 09 01 00`**，
必然 NRC 0x12/0x13，例程根本发不出去。

**建议**：在 `Coder` 上记录最近一次读用的 SID：

```js
// readBlock() 里
this.lastReadSid = readSid;
```
```js
// execRoutine()
const kwp = coder.lastReadSid != null && coder.lastReadSid !== 0x22;
await coder.securityAccessEx({ level: kwp ? 0x00 : 0x09, kwp });
```

---

## P1-3 地址扫描**扫不到 2/6 个已实测的 proven 地址**

**位置**：`src/link-doctor.js:256-258`

```js
for (let tx = 0x700; tx <= 0x7F0; tx += 1) {
  if (!((tx & 0x0F) === 0 || (tx & 0x0F) === 1 || (tx & 0x0F) === 2)) continue;
```

**问题**：步进过滤只保留低 4 位为 0/1/2 的地址。拿 `ecu-addresses.json` 的 6 个
`proven` 锚点一验：

| sysId | tx/rx | 在扫描范围 |
|---|---|---|
| 0x0B01 DME | 7E0/7E8 | ✅ |
| 0x0B09 网关 | 710/77A | ✅ |
| 0x0B12 PDC | **7CF**/7D7 | ❌ **低 4 位 = F** |
| 0x0B13 PASM | 7D0/7D8 | ✅ |
| 0x0B20 BCM_vorne | 7D1/7D9 | ✅ |
| 0x0B23 BCM_hinten | **74F**/757 | ❌ **低 4 位 = F** |

**后果**：地址扫描是「模块没有内置地址时唯一的出路」（`enterSystem` 的提示语就是
「先跑地址扫描实测该 ECU 的 tx/rx」）。但它**永远发现不了 PDC 和 BCM_hinten**，
用户会以为这两个模块不在这台车上。

**建议**：把步进改成 `tx & 0x0F` 全覆盖，或至少补上 `0x0F`；
扫描时长用「连续 N 次无应答就跳到下一个十位」来控，而不是砍地址空间。

**另外**：`RX_OFFS = [0x08, 0x6A, 0x00]` 里的 `0x00` 会让 `rx === tx`，
而 `addr.js` 的 `parseAddrPair` 明确拒绝 `tx === rx` —— 这里扫出来的这对是废的，
建议删掉或改成别的偏移。

---

## P2-1 `addr.js` 三条路径的校验强度不一致

**位置**：`src/addr.js:13-43`

1. **`parseAddrPair` 只校验 tx，不校验 rx**：
   ```js
   if (tx > 0x7ff) { ...29-bit 校验... } else if (tx < 0x700) return null;
   if (rx === tx) return null;
   ```
   → `7E0/1`、`7E0/0`、`7E0/1FFFFFFF` 全部通过。rx 是实际用来 `ATCRA` 的门，
   错的 rx 会收不到任何应答（表现为「ECU 未响应」，很难排查）。

2. **`overrideFor` 完全不校验**（只查 `isFinite` 和 `tx !== rx`）：
   localStorage 里的旧值/手改值/损坏值会被直接信任，
   而 `parseAddrPair` 的边界（0x700–0x7FF / 29-bit）在这里失效。

3. **29-bit 地址没切协议**：`addr.js` 允许 `0x18xxxxxx`，但 `coder.address()`
   用的是 `ATSP${this.protocol ?? 6}`（6 = 11bit/500k）。
   29-bit 必须 `ATSP7`，否则发出去的是错的帧格式。

**建议**：抽出 `validatePair(tx, rx)` 单一实现，`parseAddrPair` / `overrideFor` 共用；
29-bit 时把 `protocol` 一起定下来（`7`），并在 UI 上明示。

---

## P2-2 `parseResp` 的帧状态机有两个边界漏洞

**位置**：`src/coder.js:149-192`

1. **单帧会覆盖已拼好的多帧**：`type === 0x00` 分支直接 `body = f.slice(1, 1+n)`，
   不复位 `sawFirstFrame`。若适配器先吐多帧、再吐一个单帧（重复响应/迟到帧），
   前面的重组结果会被**整段覆盖**。
2. **单帧后接连续帧会拼接垃圾**：`sawFirstFrame` 仍是 false，seq 校验被跳过，
   `body = body.concat(f.slice(1))` 会把两段不相关的载荷接在一起。

正常单请求单响应下不会触发；但 `ATCRA` 没锁住、或 ECU 主动上报时会发生。
建议：单帧分支里 `sawFirstFrame = false; expectedSeq = null;`，
且**已收到单帧后**再来的连续帧直接忽略（`continue`）。

> 附：我怀疑过 `NO DATA` / `STOPPED` 会被当成十六进制载荷（`DA` / `ED`），
> 实测**不会** —— 逐 token 的 `/^[0-9A-Fa-f]+$/` 把关挡住了纯字母单词，这块是安全的。

---

## P2-3 车型→平台映射里 996 家族自相矛盾

**位置**：`src/seedkey-nonasap.js:152-178`

```js
'911（996）': '9X6',
'GT2（996）': '9X1',
'GT3（996）': '9X1',
```

同一个 996 平台，普通 911 映射到 `9X6`，GT2/GT3 却是 `9X1`。
平台码会决定 seedkey 变体的选择（`NON_ASAP_BY_MODULE` 按 `${platform}:${MODULE}` 查），
**用错平台 = 算错 key = NRC 0x35 = 可能锁死**。

要么是 GT2/GT3（996）的 DME 确实用 9x1 系列算法（那就是注释没写清），
要么是填错了。建议在注释里补证据（函数名/抓包），否则这是一个静默的雷。

（另外：`'918 Spyder': '918S'` 不在 `special-catalog.js` 的 `NEW_PLATFORMS` 里，
918 的特殊功能会走「981 老平台」分支 `n <= 0x0314`，可能显示错项。）

---

## 附：代码风格问题（不影响功能，但影响可维护性）

`src/app.js` 的 `import` 语句散落在文件中部（第 40-44 行、第 186 行
`import { registerPlugin } from '@capacitor/core';` 夹在 `addrFor()` 和 `statusBar` 之间）。
ESM 会提升，语法合法，但：
- 读代码时很容易漏看；
- 有些静态分析/打包器会告警；
- 第 144 行用 `typeof MODULE_TO_ECUID !== 'undefined'` 来防 TDZ，就是在给这个结构打补丁。

建议全部移到文件头。

---

## 修复优先级建议

| 顺序 | 问题 | 理由 |
|---|---|---|
| 1 | P0-2 变体闸门 | 会导致**静默写错字节**，且回读校验也发现不了 |
| 2 | P0-1 特殊功能假 RID | 会让 ECU 执行未知例程，不可逆 |
| 3 | P1-1 仓库自举 | 不修的话后面所有人都在盲改 |
| 4 | P1-2 KWP 安全访问 | KWP 模块例程全废 |
| 5 | P1-3 扫描漏地址 | 用户会误判「车上没这个模块」 |
| 6 | P2-1 / P2-2 / P2-3 | 健壮性，可在实车前补 |

---

## 测试盲区（比单个 bug 更值得补）

现在 233 条 smoke 覆盖了 seedkey / 协议 / 数据一致性，但**没有一条**覆盖：

1. `routineIdVerified` 的语义（67 条 false 却可执行）；
2. `autoPickVariant` 未识别时 `selectedVariant` 的状态（闸门是否真的关）；
3. `link-doctor` 扫描范围与 `ecu-addresses.json` proven 地址的一致性；
4. `parseAddrPair` 的 rx 校验 / 29-bit 协议切换。

这四条都能写成纯函数断言（不需要 DOM、不需要真车），建议补进 `smoke-fixes.mjs`。
