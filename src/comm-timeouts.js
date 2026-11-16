/**
 * comm-timeouts.js —— 通讯等待参数的**唯一出处**，分两个命名空间：
 *
 *   · `EVIDENCE_OEM` —— 原厂包内**有字节证据**的取值（可复跑取证，见数据表）
 *   · `OUR_DESIGN`   —— **我方设计值**（原厂包内没有对应字节，不要写成「原厂值」）
 *
 * 为什么要分成两块
 * ────────────────
 * 审计最容易出错的地方不是算错数，而是**把两件事混成一件**：
 * 「原厂诊断仪的等待上限是多少」和「我们收到 78 之后隔多久补一次保活」。
 * 前者有字节证据，后者是我们按 ISO 14229-2 的会话保持定时器推出来的工程选择。
 * 混在一起的后果是：以后有人拿我们的 2500ms 去当「原厂参数」引用，
 * 或者反过来以为原厂有周期 TesterPresent。所以这里用命名空间硬隔离。
 *
 * EVIDENCE_OEM 的数据来源（单一真值 = `data/comm-timeouts-oem.json`）
 * ─────────────────────────────────────────────────────────────────
 * 下方 `COMM_TIMEOUT` 的值是**内联常量**（浏览器 bundle 里读不了文件），
 * 由 `tools/verify-comm-timeouts.mjs`（断言名以 `COMM_TIMEOUT_` 开头，只在 tools/ 下
 * 出现、不进产物）做三层校验：
 *   (a) 解码数据表里记录的指令立即数**字节**做算术自证（任何环境都跑）；
 *   (b) 回读原厂库现场字节 + 重定位表（`ref/` 存在时；缺失打印 `SKIP_REF` 并跳过，
 *       干净克隆上 `ref/` 被 gitignore，不伪造通过）；
 *   (c) 本文件与数据表**双向相等**（任改一边不改另一边，门禁立刻红）。
 *
 * ⚠️ 单位是**毫秒**，语义是「单次请求 → 最终响应」的等待上限。
 *    不是 ATST 的 4ms tick（那是适配器侧，见 `elm327.js` 的 `ATSTFF`）；
 *    也不是 78（responsePending）之后的保活节拍 —— 后者是 `OUR_DESIGN.KEEPALIVE_MS`。
 *
 * ⚠️ 替换原则：只允许「不小于原硬编码值」的替换。
 *    把等待时间调短会造成假超时 → 误报「结果不明」→ 让操作者去重试写入，
 *    反而踩「超时≠未执行」红线。所以映射时逐点核对过 (旧值 ≤ 新值)。
 *
 * ⚠️ 取值维度是「平台库 × 初始化分支」，**不是**按 ECU 模块。
 *    包内没有 PSM/BCM 的库；DME / PAB 自己也从不设这个值（对 setter 的调用点为 0），
 *    它们继承主链开端口时写入的值。所以本文件**不提供** `timeoutFor('dme')` 之类的
 *    模块名维度 —— 那个维度在原厂包里不存在，造出来就是无源之水。
 */

/**
 * 原厂包内**有字节证据**的取值。
 *
 * `COMM_TIMEOUT`：通讯层里那 8 个写入点用到的三档（5000 ×1 / 8000 ×3 / 16000 ×4）。
 * 这里内联成常量而不是运行时读 JSON：浏览器 bundle 里没有 fs。
 * 两份拷贝由门禁做双向相等校验，改一边漏另一边必红。
 *
 * · `LINK_DEFAULT` 链路基线档 5000：`TOPIV_SetIoLine` 下发；同时是 `.data` 全局初值
 * · `IDENTIFY`     识别/复位档 8000：`Connector_Identify`(×2) / `Super16ResetConnector`
 *                  / `SetParaToComm(ptype==1)`
 * · `RESET`        复位/IO 线切换档 16000：`CanResetConnector` / `CANII_SetCanIOLine`
 *                  / `CANII_SetCanVolvoKLine` / `Super16_SetIOLine`
 *
 * ⚠️ 数据表里另有 5 条 `unresolvedCandidates`（18000 / 25000 / 3000 / 20000）：
 *    字节与重定位两层已证，但「函数指针是否被初始化 / 分支是否可达」未证，
 *    **不接线**。想把它们接进来，必须先补第三层证据，再改这里。
 */
export const COMM_TIMEOUT = Object.freeze({
  LINK_DEFAULT: 5000,
  IDENTIFY: 8000,
  RESET: 16000,
});

/** 档位名（稳定排序，供门禁与 UI 枚举）。 */
export const COMM_TIMEOUT_KINDS = Object.freeze(Object.keys(COMM_TIMEOUT).sort());

/** 语义角色 → 档位。调用点只写角色，不写数字。 */
export const COMM_TIMEOUT_ROLE = Object.freeze({
  /** 诊断请求-应答（读块 / 写帧 / 回滚写 / key 提交 / 例程结果查询）。 */
  REQUEST: 'IDENTIFY',
  /** 短请求（识别链单帧读 / 会话切换 / 保活 3E 00）。 */
  SHORT: 'LINK_DEFAULT',
  /** 链路复位 + IO 线切换（本工具不做硬件复位，保留档位以备将来）。 */
  LINK_RESET: 'RESET',
});

/**
 * 原厂取证命名空间 —— 只放**包内能指到字节**的东西。
 *
 * `COMM_TIMEOUT` 就是上面那三档；`DATA_FILE` 是单一真值表的相对路径；
 * `SETTER_API` / `GLOBAL_VAR` 是定位这两个名字所用的符号名。
 * 想引用「原厂等待上限」的地方一律走这里，不要直接写 5000/8000/16000。
 */
export const EVIDENCE_OEM = Object.freeze({
  /** 数据表（单一真值）。 */
  DATA_FILE: 'data/comm-timeouts-oem.json',
  /** 原厂 setter 符号名（`libCOMM_ABSTRACT_LAYER.so` 里是唯一 `T` 定义）。 */
  SETTER_API: 'SetCommunicationMaximumWaitTime',
  /** 该 setter 写入的全局变量名。 */
  GLOBAL_VAR: 'iCommunicationMaximumWaitTime',
  /** 三档取值（与 `COMM_TIMEOUT` 同一个冻结对象）。 */
  COMM_TIMEOUT,
});

/**
 * 我方设计命名空间 —— **原厂包内没有对应字节**，看到这里的数不要往原厂身上安。
 *
 * `KEEPALIVE_MS`（78 挂起后的保活节拍）
 *   取值理由：ISO 14229-2 的 S3server = 5000ms 会话保持定时器，取一半 2500ms。
 *   · 必须 ≤ S3/2：保证「ECU 判会话超时之前，我们一定先补过一次 3E 00」
 *   · 它同时决定「收到 78 之后等多久再问一趟」，所以不能取得比 S3/2 更大
 *   ⚠️ 原厂包内**不存在**周期性 TesterPresent：1008 条序列 / 501 个 `3E` 帧，
 *      100% 位于序列索引 0、100% 在会话帧之前 —— 即只在建链时发一次。
 *
 * `MAX_PENDING_MS`（因为 78 而延长等待的**总上限**，从第一次 78 起算）
 *   超过即判「结果不明」并**报错上浮**，绝不重发原帧。60s 覆盖真实长例程
 *   （排气/校准/匹配实测 3~10s）并留足余量。
 */
export const OUR_DESIGN = Object.freeze({
  /** 78 挂起后的保活节拍（ms）。设计值 = ISO 14229-2 S3server(5000ms) 的一半。 */
  KEEPALIVE_MS: 2500,
  /** 78 延长的等待总上限（ms），从首次 78 起算；超限报「结果不明」，不重发。 */
  MAX_PENDING_MS: 60000,
});

/** 78 挂起后的保活节拍（ms）—— `OUR_DESIGN.KEEPALIVE_MS` 的具名导出。 */
export const KEEPALIVE_MS = OUR_DESIGN.KEEPALIVE_MS;

/** 78 续等总上限（ms）—— `OUR_DESIGN.MAX_PENDING_MS` 的具名导出。 */
export const MAX_PENDING_MS = OUR_DESIGN.MAX_PENDING_MS;

/**
 * 取某档等待上限（毫秒）。
 *
 * @param {string} role  `COMM_TIMEOUT_ROLE` 里的角色名，或 `COMM_TIMEOUT` 的档位名
 * @returns {number} 毫秒；入参非法直接抛错（**不返回兜底值** —— 静默兜底会让
 *          「写错档位名」退化成「用了某个默认超时」，是最难查的一类 bug）
 */
export function timeoutFor(role) {
  if (typeof role !== 'string' || role === '') {
    throw new Error(`timeoutFor: 角色名必须是非空字符串（收到 ${String(role)}）`);
  }
  const kind = Object.prototype.hasOwnProperty.call(COMM_TIMEOUT_ROLE, role)
    ? COMM_TIMEOUT_ROLE[role]
    : role;
  if (!Object.prototype.hasOwnProperty.call(COMM_TIMEOUT, kind)) {
    throw new Error(
      `timeoutFor: 未知角色/档位 ${JSON.stringify(role)}；`
      + `合法角色=${JSON.stringify(COMM_TIMEOUT_KINDS.map((k) => k))}，`
      + `合法档位=${JSON.stringify(Object.keys(COMM_TIMEOUT).sort())}`);
  }
  const v = COMM_TIMEOUT[kind];
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`timeoutFor: 档位 ${kind} 的值非法（${String(v)}）`);
  }
  return v;
}

/**
 * 只读快照（门禁/UI/日志用）。返回新对象，防止调用方改到模块内常量。
 *
 * @returns {{unit:string, kinds:Object<string,number>, roles:Object<string,string>,
 *            design:Object<string,number>}}
 */
export function commTimeoutTable() {
  const kinds = {};
  for (const k of Object.keys(COMM_TIMEOUT).sort()) kinds[k] = COMM_TIMEOUT[k];
  const roles = {};
  for (const r of Object.keys(COMM_TIMEOUT_ROLE).sort()) roles[r] = COMM_TIMEOUT_ROLE[r];
  const design = {};
  for (const d of Object.keys(OUR_DESIGN).sort()) design[d] = OUR_DESIGN[d];
  return { unit: 'ms', kinds, roles, design };
}
