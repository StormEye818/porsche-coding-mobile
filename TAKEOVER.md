# 接手文档 — 保时捷编码工具（porsche-coder）

> **新 agent 从这里开始读。** 读完这一份就能接着干，不用翻别的。
> 细节在 `HANDOFF.md`（按时间追加的完整记录，78KB+），**别从头读它**，查具体踩坑时再 grep。
>
> 最后更新：**2026-11-12** · 第七阶段把 SYS_DATA comm 表接进运行时，收口进模块会话与新代地址
> （完整审计见 `FULLCHAIN-ALIGN-20261112.md`；历史收口见 `RE-CLOSURE-20261111.md`）
>
> ⚠️ 本页及续篇中的旧覆盖率/「已全对齐」表述均为历史资料，不再作为实车写入验收。
> 当前真实行为门禁（`npm test` 全绿）：`test-align431` 37、`smoke-fixes` 359、
> `verify-all-models` 67、`e2e-flow` 105、`walkthrough` 84、`verify-runtime-safety` 24、
> `verify-sysdata-comm` 16、`verify-oem-session` 28，均 0 失败；真车默认只读，
> 只有 981 Cayman DME 示例 profile 可写，其余未证 ECU 不得因测试通过而放行。
>
> **第七阶段（本轮）新增**：
> - `src/oem-session-table.js`（生成器 `tools/build-oem-session-table.mjs`）：逐 ECU 原厂会话表，
>   805 sysId / 737 会话证据；运行时用到的 468 个零缺口；981 = 32×`10 03` + 16×`10 89`。
> - `Coder.setOemContext(sysId)` / `resolveSession()`：进模块会话不再一律 `10 89`；
>   GAG 帧 flag=0 的会话按原厂「尽力而为」处理；`setAddress` 换模块清空上下文。
> - `data/bind-plan.json` schemaVersion 4：新代 0x14-0x16 的 112 个 comm cat=0x10 本代地址对
>   接入为首选候选（保留原候选回退、不直绑），推翻「新代无地址证据」。981 不受影响。
> - 两个生产 provider 显式声明 `seedWidths`，宽度闸门从降级变硬约束。
>
> **仍未证**：进模块完整帧序位置差异、老平台 9X6/9X7/CS1/E1 的车型→type 唯一链接、
> 写序言按 ECU 分派（包内是固定模板+类别键）、OBD `21 09 05` 目的 CAN ID（盒固件层）。
> `npm run sync` 的 `www/data` 删除仍受 safe-delete 护栏限制，不能绕过。
>
> ⚠️ **已有续篇：`TAKEOVER-20261018.md`。** 第二轮把待逆收编 + 功能审查 + REA/431 对照都推完了，
> 现状数字（覆盖率 / 回归数）**以续篇为准**。本篇的 §5 待办清单大部分已销项，仍可用作方法论与踩坑参考。
> 续篇 §9 记的是第四轮：**字长 VM（mode 0x6E–0x77 族）9 个全部收编**，拒写 20 → 6 条。
> 续篇 §10–§11 记的是第五轮：**内联 VM 家族 4 个变体收编**（含 `3D536546` = mode `0xb1`）拒写 6 → 4 条，并新建 `tools/walkthrough.mjs`（38/38）用真机真值表校验 key 跑通读写 + 特殊功能。
>
> ⚠️ **第三轮（最新）：`TAKEOVER-20261018-R3.md`。** 本轮修了 30+ 个功能 bug、补 0x79/0x7a/0x7b、
> 修 KWP `17 40`/UDS `27 09 01 00`/真机 `ATAL`+流控/单帧截断/DTC 混解析等；
> 现状数字（**642 有算法 / 334 无 case / 4 拒写；smoke 223/0**）**以 R3 为准**。本篇 §0 的“还差 53”是第二轮旧口径。

---

## 0. 一句话现状

**读**：全通。**写**：协议/闸门/映射全好了，**算法覆盖还差 53 个**（29 mode + 24 变体）。
剩余是**体力活 + 三种不同骨架**，方法论已打通，工具链已沉淀。回归 94/94，已装 iPhone818。

---

## 1. 这是什么

自研 iOS app，与 X431 保时捷包**代码级 1:1 对齐**（连接→选车型→选模块→选功能→编码/特殊功能→执行）。

**用户铁律**（违反会被打回）：
- **不走黑盒**，每个细节理解清楚；**离线验证为主**，只上车一次
- **和 431 对齐前先看 431 怎么做的**，拒绝闷头改（见记忆 `align-with-431-deep-dive`）
- **算不出 key 就明确拒写，绝不猜**（猜错 = NRC 0x35 → 0x36 锁死）
- **发版面零泄漏**：不能出现 X431/YZJM/Unicorn/逆向/破解/libPORSCHE 等字样
- 本机重活控制 **40W** 左右；音频/ML 内存铁律见记忆

---

## 2. 仓库与关键路径

| 路径 | 用途 |
|---|---|
| `~/porsche-coder/` | 主仓库（iOS app + 逆向产物） |
| `~/porsche-coder/src/` | app 源码（esbuild 打成 `www/app.bundle.js`） |
| `~/porsche-coder/HANDOFF.md` | 完整历史记录（**查踩坑用 grep，别通读**） |
| `~/porsche-coder/tools/` | 逆向/拟合工具链（见 §6） |
| `~/porsche-mapper/ref/porche-v24.58/V24.58/` | X431 原始数据 + `.so` |
| `~/porsche-mapper/ref/analysis/` | 已抽的分析 JSON（`SEEDKEY-*.json` 等） |
| `~/mes-reverse/` | REA 工具笔记 / 证据（含 x431-apk-findings.md） |

**关键源文件**：
- `src/seedkey-pswcalc.js` — mode → 算法（`securityModel` 路径）
- `src/seedkey-registry.js` — 变体 ID → 算法（名字路径）
- `src/seedkey-nonasap.js` — 非 ASAP1A 入口（9x7 族 / Airbag / 992）
- `src/seedkey-name-map.js` — 名字 → 变体 ID（171 条，原厂 nameTable）
- `src/seedkey-resolver.js` — 端到端密钥解析（写入闸门）
- `src/coder.js` — UDS/KWP 协议层
- `src/app.js` — UI + 业务流

---

## 3. 怎么跑（必做验证）

```bash
cd ~/porsche-coder
node smoke-fixes.mjs        # 回归，当前 150/150（2026-10-18 第二~六轮）
node e2e-flow.mjs           # 端到端，当前 33/33
node tools/verify-pending.mjs  # 待逆项，当前 通过 65 / 失败 1（只剩刻意拒写的 mode 0x1d）
node tools/walkthrough.mjs     # 全链路演练（严格模拟车），当前 38/38
node tools/coverage.mjs     # DRIVELINKS 覆盖：有算法 635 / 原厂无 case 341 / 拒写 4 = 980
node tools/name-map-coverage.mjs  # 名字表覆盖：有算法 131 / 空壳 1 / 拒写 0 = 132
```

**装机到 iPhone**：
```bash
npm run sync                                   # esbuild 打包 + 同步 data/
# 泄漏检查（装机脚本会自动跑，也可以手动）
grep -rniE "X431|YZJM|DSTREAM|Unicorn|oracle|逆向|破解|libPORSCHE|flat-six|rijndael|反汇编|LFSR" www/app.bundle.js
npx cap sync ios && node scripts/sync.mjs --refill
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/pc-build-device-fresh \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device 00008130-0004141828E1401C \
  /tmp/pc-build-device-fresh/Build/Products/Debug-iphoneos/App.app
```
设备 UDID `00008130-0004141828E1401C`（iPhone818 / iPhone 15 Pro Max）。
⚠️ `/tmp/pc-build-device` 的 SourcePackages 会烂掉（报 `Package.swift doesn't exist`）——
`install-device.sh` 已加构建前清理；手动跑用 `-derivedDataPath /tmp/pc-build-device-fresh` 也行。

---

## 4. 已完成（不要重做）

### 能力面
- **读全通**：连接 L1–L5、选车型/系统/浏览菜单、读块/回读/故障码/数据流/备份
- **写协议**：KWP `0x3B` 写 / 安全访问 `0x09→0x0A` / 会话 `10 89`（照抄 431）
- **ECU→变体映射**：171 条名字表闭环（`PorscheGetAsapCalcType`）
- **写入闸门**：算不出就明确拒写，绝不猜
- **特殊功能安全访问**：`27 09` → `31`（431 实测顺序），已接进执行路径
- **非 ASAP1A 入口**：9x7 族 3 个 + Airbag ARX + 992 SA2，全 oracle 验证
- **平台限定映射**：`BV_SteerAssisUDS`(992) / `_9x7_psm` / `_9x7_pcm2_*`×6

### 算法覆盖（mode 95 / 变体 111）

| 表 | 数量 | 说明 |
|---|---|---|
| `INLINE_MODES` | 65 | 内联公式（ADD/XOR/NOT/MULADD…） |
| `ROTATE_COMBINE_MODES` | 18 | 16 位 rotate+combine（含 RC_SX 7 个） |
| `ROTATE_COMBINE32_MODES` | 6 | 32 位 |
| `FEISTEL_MODES` | 2 | 2 轮 ARX |
| `WORDVM_PROGRAMS` | 4 | 字长 VM（复用 SA2 指令集） |
| `SA2_PROGRAMS` | 50 | SA2 虚拟机小程序（含 992 SteerAssisUDS） |
| `INLINE_ADD` | 44 | `key = seed + c` |
| `INLINE_SPECIAL` | 3 | EMPTY / NOT_TOP / BYTES_NOT |
| `INLINE_MULADD` | 6 | `imul(seed,A)+B`（含 CB4E06 = Allrad 9 个名字） |
| `INLINE_XOR_MULADD` | 7 | `imul(seed^K,A)+B` |
| `RC32_VARIANTS` | 1 | 32 位旋转，方向用 `n=0x20-n` 取补 |

### 已修的真 bug（别再犯）
1. **PSM8 输出是大写 hex**（`sprintf("%02X")`）—— 小写会混过对拍
2. **2 字节 seed 会被丢** —— 压成 32 位再解回来变 `[0,0]`
3. **`securityAccessEx` 默认 `keyBytes=2` 会截断 4 字节 key** → 0x36 锁死隐患（已改默认不截断）
4. **`_9x7_PCM2_TEL` 手误小写** —— 查找两侧 `.toUpperCase()`，小写 key **静默查不到**
5. **`Porsche_Mode_1D` 是 2 字节空壳**，合成器给的 identity 是假解 —— **收编前必查函数 size**

---

## 5. 还剩什么（精确清单）

### 5.1 mode 待逆 ~~29 个~~ → **剩 7 个未覆盖**（2026-10-18 第二轮已销 26 个）

> ✅ **第二轮已收编 26 个**（全部 32 点 oracle 对拍）：
> `0x02 0x09 0x0b 0x0d 0x0e 0x13 0x15 0x16 0x17 0x19 0x1b 0x1f 0x28 0x29 0x2d 0x30
>  0x35 0x42 0x47 0x48 0x4f 0x5b 0x5c 0x5d 0x65 0x67 0x68`
> 收编家族：`RC_SX`(符号扩展 16 位) / `RC_VAR`(变宽) / `BYTELOOP` / `LFSR32` / `RORADD26` / `CRC24`。
> ⛔ `0x1d` **刻意不收**（运行时状态，非纯函数）。
>
> 下面原文保留作**方法论**参考（骨架分类与线索仍有效）。

**当前仍未覆盖**（以 DRIVELINKS 覆盖度为准，2026-10-18 第五轮后）：**只剩 `0x00`（1 条，库里无此函数）和 `0x1d`（3 条，刻意拒写）= 4 条记录 / 2 个 mode**
（`0x6e 0x6f 0x70 0x71 0x72 0x73 0x75 0x76 0x77` 已由字长 VM 全部收编，见续篇 §9）

⚠️ **口径**：DRIVELINKS 980 条要分三类，别只看「抛不抛异常」——
**有算法 635（64.8%）/ 原厂无 case 341（34.8%，本来就不发 key）/ 拒写 4（0.4%）**。
`mode > 0x77` 里那 341 条是原厂 `stdSeedKey` 没 case，**不是缺口也不是已收编**（详见续篇 §1.1）。

原清单（已过时，别照着做）：
```
0x13 0x15 0x16 0x19 0x1b 0x1d 0x1f 0x28 0x29 0x2d 0x30 0x35 0x42 0x47 0x4f
0x5b 0x5c 0x5d 0x65 0x68 0x6e 0x73 0x75 0x76 0x77 0x79 0x7a 0x7b 0xa0
```
按骨架分三组：

**A. rotate+combine 16 位（约 16 个）** — `0x13 0x15 0x16 0x19 0x1b 0x1f 0x29 0x35 0x42 0x47 0x5b 0x5c 0x5d 0x68 …`
骨架已破解（见 §7），生成器对它们报 `no-fit` = **位提取形态没覆盖到**，不是语义问题。
→ 继续扩 `tools/fit-rc-standalone.mjs` 的 `parseTerms`。

**B. 变长移位旋转（约 10 个）** — `E70BF466…` 这类变体 + `0x65`
`x << (n)` / `x >> (0x20 - n)`，**n 是变量**（从 seed 算出）。另一种骨架，要单独写执行器。

**C. 特殊入口（有明确线索）**
| mode | 线索（PENDING_MODES 注释） |
|---|---|
| `0x1d` | `(token+0x408838) + seed` — **运行时状态，非纯函数**，`Porsche_Mode_1D` size=2 空壳。**可能无法离线实现** |
| `0x28` | `h75643070(4, seed, 0x2341972)` — 找 `h75643070` |
| `0x4f` | `h7565116C(seed)` — 找 `h7565116C` |
| `0xa0` | `computeKeyByVariant(seed, 4, "SWSG_Single_Seedkey")` — **直接复用现有变体表**，好做 |
| `0x6e 0x6f 0x70 0x71 0x72 0x73 0x75 0x76 0x77` | ✅ **第四轮已全部收编**（字长 VM，64 位累加器解释器 `src/seedkey-wordvm.js`），32×9=288 点对拍全过 |
| `0x79 0x7a 0x7b` | **algoA/B 族**，函数名不是 `Porsche_Mode_*`（是 algo-cayenne / algo-me711 / algo-9x7），要另找入口 |

### 5.2 变体待逆 ~~24 个~~ → **0 个**（2026-10-18 第六轮全清）

> ✅ **第二轮已收编 18 个**（全部 32 点 oracle 对拍）：
> `E70BF466 C1CBA4AF 2BF9206C D2ACD9A3 3EF21C75 C5A5A0A7 01A56221 9E46569F
>  CF204DC3 ED8C844E 42FFC7E0 76F77EB4 9316E2B4 1C6D5638 0A8B1B4C 11747BDA
>  E006B2FF F7297A9C`
>
> ✅ **第五轮**：`3D536546` → 内联 VM（`INLINE_VM_PROGRAMS`）。
>
> ✅ **第六轮收官**：最后 2 条也收编了，`INLINE_OTHER_PENDING` **清空**：
> | 变体 | 落点 | 关键坑 |
> |---|---|---|
> | `7F6DED18…` | `INLINE_CRC32` | 不是「收尾置换没对上」，是 **rodata 表地址差 2 字节**（`add r3,pc` 是 16 位 Thumb，PC 按 **2** 对齐）→ 真后缀 `53 4e 70 6f 66`("SNpof")，之前取成 `00 00 53 4e 70` |
> | `_NEW9x1BKE` | `INLINE_NOT_MULADD` | @0x250ec 74 字节，`mla` 直接给常量；**只读 4 字节 seed**（`seedkey.js` 里的 `seedBytes:2` 是 stub 默认值，不是证据） |
>
> 复跑：`node tools/name-map-coverage.mjs`（132 变体：131 有算法 + 1 空壳 + 0 拒写）。
> 详细过程见 `TAKEOVER-20261018.md` §12。

原清单（已过时）：
```
01A562214A910B9312F157A8D16F298E  0A8B1B4CF68DD51755634664F2E4F0D5
11747BDA7E076A2E7ECA0D533DF540EC  1C6D563854E4E1F195DAF5890F96177B
2BF9206CB1FA70E8D1C9333C6F06F725  3D5365460CB39FEFC14651DF5075A1B8
3EF21C75E1573EFC3E203052A35BEE5A  42FFC7E0DF51DDD877EBCB99DE05677D
76F77EB427B6238B2536CC4B6A8A13DE  7F6DED184289B009A3EBCF9DB4EE46F7
91C0B71C660408DF11A4C211006FB913  9316E2B47FC693876FA1EA72F38CA015
9E46569F8CC58E505F04D1ABE3B7602D  9E95AD479750DBABF9068A886EC37CE7
C1CBA4AF901F97C36CAEE016A5CC0E7B  C5A5A0A78AACB928950975C88E19CF7C
CF204DC3E999C2DA3C824397DE7EDE89  D2ACD9A34442B6428EF95114B14C95DB
E006B2FF19D9E1784A4B1E156444432B  E70BF466EE7EC94D7CA91F163898FEE5
ED8524ED02C73B97FF5D4E4DED031495  ED8C844E819F6BE1506FF5260ABF394E
F7297A9C7AA868AE333F42BCD132C428  _NEW9x1BKE
```
同上，rotate+combine 族为主，加变长移位（`E70BF466` `C1CBA4AF` `2BF9206C` `1C6D5638` `0A8B1B4C` `D2ACD9A3` `11747BDA` `9E46569F` `01A56221`）。

**⚠️ 两个清单是不同维度**：29 是「mode 号」（`resolveKey(mode)` 路径），24 是「变体 ID」（`resolveKeyByName` 名字路径）。别混。

### 5.3 推不出来的（**宁可拒写，别造**）
| 项 | 原因 |
|---|---|
| `SecurityAccess_9x7_ALLRAD` 的模块桥 | 9X7 平台 41 个模块**没有 allrad**（`Allrad` 只在 9X1/CAJUN/E2），原始 BIN 也搜不到 |
| `ASAM_seedkey_Airbag_Upload_CONFIDENTIAL` 的模块桥 | 名字里是 **Upload 操作**不是模块；特殊功能数据里无「上传」动作 |

---

## 6. 工具链（已沉淀，直接用）

```bash
# 1. 批量反编译 → /tmp/decompiled.txt
bash tools/batch-decompile.sh          # 慢（Ghidra headless），建议后台跑

# 2. 出 oracle 采样（32 点/函数）—— 见下「怎么出采样」
# 3. 拟合
node tools/fit-rc-standalone.mjs mode      # 16 位 rotate+combine
node tools/fit-rc-standalone.mjs variant   # 16 位 rotate+combine
node tools/gen-rc32.mjs                    # 32 位 rotate+combine（n 取补方向）
node tools/fit-muladd.mjs                  # XOR_MULADD（从 C 抄常量）
```

**怎么出 oracle 采样**（关键，参考 `HANDOFF.md` 里的脚本）：
- mode：调 `Porsche_Mode_<HEX>`，签名 `uint f(uint seed)` — R0=seed，返回 R0
- 变体：调 `ASAP1A_CCP_ComputeKeyFromSeed_<ID>`，签名 `(uchar* seed, ushort len, uchar* key, ushort klen, ushort* outLen)`
- 跑 Unicorn，符号地址用 `tools/sa2-call-taxonomy.py` 的 `load_symbols()` + `tax.BASE`
- **32 点**（6 个固定 + 26 个随机），seed 固定 `random.seed(20261018)` 可复现

---

## 7. rotate+combine 的完整语义（**这是最难挖到的，别再踩**）

```
n == 0  → A = 初值（seed 或 w），**仍要走组合**（不是直接返回 A）
n  > 0  → A = 旋转结果，形式三选一（因函数而异）：
            signext  A = (v & 0x8000) ? 0xFFFF0000|v : v      ← C: `(uint)(short)uVar1`
            zext     A = v & 0xffff
            keephi   A = (seed & 0xFFFF0000) | v
组合    → A OP B，B = seed 或 w=seed&0xffff（因函数而异）
方向极性 → 因函数而异：`==0` 分支是 `<<1`+`>>0xf` 则 bit 清=ROL（invert）
           是 `>>1`+`<<0xf` 则 bit 清=ROR。**Mode_2 与 Mode_D 相反**。
finalMask → 结尾 `& 0xffff`（有的有有的没有）
n0W     → n==0 时 A 是 w 还是 seed（因函数而异）
mode→组合 → **不解析 C 分支**（正则太脆，翻车 3 次），暴力枚举 8^4
```

**踩坑对照**（漏一条就对不全）：
| 漏什么 | 结果 |
|---|---|
| 漏符号扩展 | 17/32 |
| 漏 n==0 仍要组合 | 31/32 |
| 方向极性反 | 5/32 |
| 6 点采样（不加点） | 假阳性，同族能拟合出两个不同公式 |

### C 解析的坑
| 坑 | 表现 |
|---|---|
| `(p & m) >> k` vs `p >> k & m` | 语义**相反**，混了 n 从 11 变 18651 |
| n 和 mode **共用变量** `uVar2` | 按变量名区分会把 mode 排除 |
| n 是**循环计数器**不是第一个赋值 | 第一个常是工作字 `uVar4 = p & 0xffff` |
| `while (a < b)` 里 **b 才是 n** | a 是步进器 |
| 主体变量名（`param_1`/`local_18`/`uVarX`） | 要自动适配；捕获组会让 `m[1]/m[2]` 索引错位 |

---

## 8. 验证纪律（**最重要的原则**）

1. **oracle 真值，不是 JS 自己抄自己** —— 期望值必须来自 Unicorn 实跑。
   上一轮就是拿 JS 输出当期望，让小写 bug 混过去了。
2. **32 点，不是 6 点** —— 6 点会假阳性。
3. **收编前查函数 size** —— size<16 的空壳（如 `Porsche_Mode_1D` size=2）oracle 结果不可信。
4. **独立复核** —— 合成器求值器和最终实现分开写，防同源 bug 蒙混过关。
5. **模糊匹配会把对的算成错的** —— `ASAM_seedkey_Airbag`（ASAP1A 正解）和
   `ASAM_seedkey_Airbag_Upload_CONFIDENTIAL`（非 ASAP1A）是两个东西。
   非 ASAP1A 只做**精确匹配**。
6. **平台限定** —— `BV_SteerAssisUDS` 跨 992/E3/G2/G3/J1 五个平台，不分平台会算错。
   `model→platform` 表在 `src/seedkey-nonasap.js`，**有测试对照车数据校验**。

---

## 9. 建议推进顺序

1. **`0xa0`**（最好做）：`computeKeyByVariant(seed, 4, "SWSG_Single_Seedkey")` —
   直接复用现有变体表，半小时能收。
2. **rotate+combine 剩余 16 个 mode + 22 个变体** — 扩 `parseTerms` 位提取形态，
   语义已定，纯工程活。价值最高（解锁最多 ECU 写入）。
3. **变长移位族 10 个** — 写新执行器（`x << (n)`，n 从 seed 算）。
4. ~~**字长 VM 6 个**（`0x6e/73/75/76/77`）~~ → **第四轮已做完**（9 个 mode 全收）。剩下的 `3D536546`（= `0xb1`）：
   复用 SA2 指令集，转字节程序后 `sa2Run` 直接跑。0x6E 无 HALT 要先定终止条件。
5. **algoA/B 3 个**（`0x79/7a/7b`）— 函数名不是 `Porsche_Mode_*`，先找入口符号。
6. **`0x1d`** — 运行时状态，**可能无法离线实现**，评估后决定放弃或留拒写。

**每收一批**：跑 `node smoke-fixes.mjs && node e2e-flow.mjs` → 重建装机 → 更新本文件 §5 的清单。

---

## 10. 常见疑问

**Q: 上一轮说「非 ASAP1A 全破」，怎么还有剩？**
A: 「破」指 5 个入口的算法都逆出来并 oracle 验证了（9x7 族 3 + Airbag + 992）。
剩下的 53 个是**另一批**（mode 号 / ASAP1A 变体 ID），是不同维度。

**Q: 为什么不用 AI 自动把 53 个全解了？**
A: 线性族（MULADD/XOR_MULADD）能合成出来，已收 13 个。
rotate+combine 的**位提取**每个函数都不同，得解析 C 或逐个逆，工具链已能批量做一部分。
变长移位 / 字长 VM 是**不同骨架**，要各写一个执行器。

**Q: 装机失败 `Package.swift doesn't exist`？**
A: SourcePackages 缓存烂了。清 `/tmp/pc-build-device/SourcePackages` 或换
`-derivedDataPath /tmp/pc-build-device-fresh`。

**Q: 设备连不上？**
A: `xcrun devicectl list devices` 看状态。`available (paired)` 但装不上就重试一次，
偶发连接失效。

---

## 11. 2026-11-08 覆盖率终审计收口（seed/key 算法面）

> 任务：§5 精确剩余清单（29 mode + 24 变体）全部实现+验证 + 980 条逐条「E→算法→可算性」终审计。
> **结论：算法面已收口** —— 需要 key 的条目 642/642 可算（另 3 条 0x1d 走名字分发回落，见下）。

### 11.1 清单销项（29 mode + 24 变体 = §5 原清单，逐个核对过）

| 组 | 项 | 状态 | 证据 |
|---|---|---|---|
| A rotate+combine | `0x13 0x15 0x16 0x19 0x1b 0x1f 0x28 0x29 0x2d 0x30 0x35 0x42 0x47 0x4f 0x5b 0x5c 0x5d 0x65 0x68`（19 个） | ✅ | mode-samples 32/32（verify-pending） |
| B 变长移位/字长 VM | `0x6e 0x73 0x75 0x76 0x77` | ✅ | wordvm-samples 9×32（smoke 内对拍） |
| C-1 | `0x79 0x7a 0x7b` | ✅ | mode-samples 32/32 |
| C-2 | `0xa0` | ✅ | 变体分发 `SWSG_Single_Seedkey`→`F7297A9C`（XOR_MULADD）32/32；名字表 = 原厂 nameTable 171 条 |
| C-3 | `0x1d` | ⛔ 刻意拒写 | 见 §11.3（431 同路径 = seed+TOKEN 运行时态；运行时回落名字分发 EPS 可算） |
| 变体 24 个 | `01A56221 … _NEW9x1BKE`（§5.2 原清单全列） | ✅ | pend-samples 逐个 32/32；selfcheck 135/135 |

### 11.2 验证与生成物（全绿）

- `tools/verify-pending.mjs` **68 通过 / 0 失败 / 1 刻意拒写**（32 点 oracle 真值）
- `tools/sa2-registry-selfcheck.py`（Unicorn 真 .so）**135/135 变体 · 675/675 用例 · 0 失败**
- `smoke-fixes.mjs` **343/0** · `name-map-coverage` **131 可算 + 1 空壳 + 0 拒写**
- **registry 生成物重生成（v2）**：`tools/gen-seedkey-registry.py` 重写 ——
  生成段（SA2 50 = verify 46 + oracle 补跑 4 / ADD 44 / 特殊 3 / INLINE_VM 4 = rodata 重提取）
  + 维护段 `analysis/seedkey-registry-extra.js`（RC/循环/CRC/MULADD 族，32 点对拍冻结）。
  新旧对拍 **135 ID × 8 种子 = 1080 点 0 差异**；VM 4 个不再混进 SA2 表（v1 手抄冗余已清）。

### 11.3 覆盖率终审计（980 条全表）

**`analysis/seedkey-coverage-audit-20261108.md` / `.json`**（`node tools/sa2-coverage-audit.mjs` 可复跑）：

| 桶 | 条数 | 判定 |
|---|---|---|
| 可算 key | 642 | ✅ 逐条路由到 mode 表/变体/内联，算法全 oracle 验证 |
| 不需 key（原厂无 case，含 mode 0x00×1） | 335 | ✅ 431 同路径：outLen=0 不发 key（0x00 的 switch 无 case 0，2026-10-19 REA 实证） |
| 拒写 | 3（0x1d×3，ECU 0x0c45） | ⛔ 刻意，见下 |

**0x1d×3 留档**：431 同路径 = securityModel `case 0x1d: key = seed + *(TOKEN+0x408838)`
（PORSCHESecurityModel.c 实证）；TOKEN 态在解析**地址记录 firstByte==0x1d** 时装载后 4 字节
（Xml_GetDriveLinksAddress 逐指令实证），本包 3 条该类记录装载值 `0x18BD / 0x623D / 0x4E86`
（0x623D 恰= EPB 变体 ADD 常量，互证）；0x0c45 自身记录不装状态 → 会话运行时态，离线不可纯函数化。
**不猜**（空壳 identity 是假解）；运行时按 RE-WRITEGATES-20261105 #2a **回落名字分发**
（识别串 token 精确对 `ASAP1A_CCP_ComputeKeyFromSeed_EPS` 后缀，dlsym 语义）→ EPS 可算，不锁不拒。

### 11.4 ⚠️ 口径风险 → ✅ 2026-11-09 已收口（mode 真源=记录字节级）

**mode 传递链（逐指令定案）**：`SendSysSeedKey`(READWRITE:0x109cb4) →
`Xml_GetDriveLinksEntry`(FILE:0x188e4，6B 条目=[u16 blockKey][u32 recOff]) →
`Xml_GetDriveLinksAddress`(FILE:0x18a0c)：fseek(recOff) 后 freadEx×2（**非推进**，读回 rec+0..3）
→ TOKEN+0x360950=u32@rec+0（复合 P）→ `PorscheKeySendCmd(P)`(ENTER:0x21280)：
P&0xff=mode、(P>>8)&0xff=模板族、P>>16=会话 → `PORSCHESecurityModel(P>>16,P&0xff)`。
rec[0]==0x1d 时 u32@rec+4→TOKEN+0x408838（0x1d 态；3 条装载值 0x18BD/0x623D/0x4E86 逐字复证 ✓）。
条目选择：`GetSubSysDataAddr`(FILE:0x15c18) 识别串经 GAG IdSearch 命中行键→TOKEN+0x28，
未命中回落组首行键（=app hit[0]）。**旧 m=recOff 低字节、l=recOff>>8（垃圾 mode）**。
修复：tools/rebuild-drivelinks.py 重建 schemaVersion 2（m/l→recOffsetLo/Hi + mode/family/session[/state]），
app.js `hit[0].mode` 路由、e2e 981 DME/718 双断言（真值 0x08/0x08）。
981 DME（P200 98161864015 SDI9_1_981_3_4L_EU5）真 mode=**0x08**（0x0b01 块首行 blockKey 0x0160→
记录 0x1F59→rec[0]；复合 0x03040208）——旧 0x59=0x1F59&0xff 垃圾，全块 39 行真 mode∈{08,61,62,63,64} 无 0x59。
0x1d 真记录=0x0f12/0x0f32/0x0f54 共 4 条（旧「0x0c45 t=100..102 mode 0x1d」是 m 假象，真 mode 0x45）。

### 11.5 其他备注

- `0xa0` 直调 `PorscheComputeKeyFromSeed` 的 mode 层单点 oracle **不可行**（函数入口即 dlsym 宿主
  插件脚手架 `InitStd/CommunicationPacketFormat/…`，需宿主回调仿真）；链路分段验证留档：
  case 0xa0 → 名字分发（dlsym）→ nameTable → 变体 32/32。该实验顺带**运行时实证**了
  「算法按名字 dlsym 动态取」（RE-WRITEGATES #2a 的核心论据）。
- 当前 `e2e-flow` 2 失败 / `walkthrough` 4 失败 = **NRC 0x78 轮询语义**（coder.js/app.js 线在改，
  不属 seedkey 线；seedkey 回归 smoke/verify-pending/selfcheck 全绿）。
