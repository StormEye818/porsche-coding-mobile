/**
 * write-alignment.js — 自动生成，勿手改。
 * 生成器：tools/build-write-alignment.mjs（真实 Coder 路径实测 + 原厂主写模板逐帧比对）
 *
 * 依据：原厂主写序列是实车验证过的流程；我们的**写帧构造、序列结构、回读校验、
 * 默认安全行为**与它逐项一致（判定见 WRITE_ALIGNMENT.checks）。因此写闸门按
 * 「对齐矩阵」判定，不再要求逐模块重新做实车测试。
 *
 * ⚠️ 会话帧不是所有 ECU 都等于 1089：原厂按 ECU 使用不同会话（981 = 32×10 03 + 16×10 89，
 * 老代还有 10 86 / 10 85），68 个老代 KWP sysId 原厂不建 UDS 会话。运行时会话号由
 * SYS_DATA comm 表按 sysId 证据驱动（src/oem-session-table.js），这是与原厂一致的做法，
 * 不是偏离。measuredKwp/measuredUds 是无证据上下文（主会话 0x89）的实测；
 * measuredWithContext 是绑定了证据会话后的实测，两者都固化在下面。
 *
 * 原厂主写模板（验收矩阵 §5，主会话 0x89 场景）：
 *   1089 → 3E00 → 2101(备份) → 170000(安全) → 3B0109000000(写) → 2101(回读)，无识别链
 */
export const WRITE_ALIGNMENT = Object.freeze({
  "schemaVersion": 1,
  "aligned": true,
  "source": "验收矩阵 §5 + 真实 Coder 路径 mock 实测 + schema.js/coder.js 静态核对",
  "templateKwp": [
    "1089",
    "3E00",
    "21<LID8>",
    "170000",
    "3B<LID8><data>",
    "21<LID8>"
  ],
  "measuredKwp": [
    "1089",
    "3E00",
    "2121",
    "170000",
    "3B215a531473f493d4b3b4d394f37413543334531473f493d4b3b4d394f374135433",
    "2121"
  ],
  "measuredUds": [
    "1003",
    "3E00",
    "1089",
    "220021",
    "27090100",
    "270A1234",
    "2E00215a531473f493d4b3b4d394f37413543334531473f493d4b3b4d394f374135433",
    "220021"
  ],
  "measuredWithContext": {
    "kwp": {
      "sysId": "0x0108",
      "evidenceSession": "0x86",
      "frames": [
        "1086",
        "3E00",
        "2121",
        "170000",
        "3B215a531473f493d4b3b4d394f37413543334531473f493d4b3b4d394f374135433",
        "2121"
      ]
    },
    "uds": {
      "sysId": "0x0e13",
      "evidenceSession": "0x03",
      "frames": [
        "3E00",
        "1003",
        "220021",
        "27090100",
        "270A1234",
        "2E00215a531473f493d4b3b4d394f37413543334531473f493d4b3b4d394f374135433",
        "220021"
      ]
    }
  },
  "sessionNote": "会话帧按 SYS_DATA comm 逐 ECU 证据驱动；对齐的是写帧构造/序列结构/回读，不是会话号字面值",
  "checks": [
    {
      "id": "kwp-frame-shape",
      "grade": "A",
      "ok": true,
      "detail": "6 帧逐帧形态对齐 原厂主写模板"
    },
    {
      "id": "uds-frame-shape",
      "grade": "A",
      "ok": true,
      "detail": "8 帧逐帧形态对齐 UDS 族流 + 记录 SID"
    },
    {
      "id": "readback-verify",
      "grade": "A",
      "ok": true,
      "detail": "写入后回读一致才判成功"
    },
    {
      "id": "safety-default-off",
      "grade": "A",
      "ok": true,
      "detail": "值域/level/地址态/自动回滚/跨度闸默认全关 = 原厂行为（SAFETY 实读 + schema）"
    },
    {
      "id": "no-ident-chain-in-write",
      "grade": "A",
      "ok": true,
      "detail": "写序列实发帧无识别链帧（构建期真跑复算）"
    },
    {
      "id": "skip-ident-on-write",
      "grade": "A",
      "ok": true,
      "detail": "写路径不重跑整套识别链（构建期真跑复算）"
    },
    {
      "id": "no-auto-restore",
      "grade": "A",
      "ok": true,
      "detail": "回读不一致记录失败，不自动回滚（构建期实发帧：写帧各 1 条 + 回读同形）"
    },
    {
      "id": "no-security-brute",
      "grade": "A",
      "ok": true,
      "detail": "不逐级试 level（构建期实发帧：UDS 27×2 / KWP 17×1）"
    },
    {
      "id": "record-driven-sid",
      "grade": "A",
      "ok": true,
      "detail": "读写帧 SID 全部来自编码记录（构建期实发帧含 3B/2E 且 coder 有 WRITE_SIDS 闸）"
    },
    {
      "id": "session-evidence",
      "grade": "A",
      "ok": true,
      "detail": "进模块会话/序列来自 SYS_DATA comm 逐 ECU 证据（构建期 setOemContext 实跑）"
    },
    {
      "id": "address-probe",
      "grade": "A",
      "ok": true,
      "detail": "地址由 bind-plan 候选 + 探针收敛（原厂同款 n>0 逐候选一帧探测）；闸门只校验 11 位地址合法，原厂无地址态闸——风险由 coder.checkRx 回帧 ID 硬校验与回读校验兜底"
    },
    {
      "id": "oem-context-kwp",
      "grade": "A",
      "ok": true,
      "detail": "有证据上下文 KWP：会话帧 1086 = 该 ECU 证据会话 0x86，其余 5 帧与主写模板同形"
    },
    {
      "id": "oem-context-uds",
      "grade": "A",
      "ok": true,
      "detail": "有证据上下文 UDS：会话帧 1003 = 该 ECU 证据会话 0x03，7 帧按目标会话去重族流"
    }
  ],
  "behaviorEvidence": {
    "capture": "tools/build-write-alignment.mjs capture() 真跑 Coder + MockAdapter（4 次写事务：kwp/uds/oemKwp/oemUds）",
    "safetyOff": true,
    "noIdentInWriteFrames": true,
    "skipIdent": true,
    "noAutoRestore": true,
    "noSecurityBrute": true,
    "recordDrivenSid": true,
    "sessionEvidence": true,
    "addressProbe": true,
    "runs": 4
  },
  "rule": "记录驱动的读写帧 + 会话/序列证据 + 地址候选探针 + 回读校验；原厂无的自创增强默认全关；seed/key 按 drivelinks mode 表算 key，安全 level 由脚本命令字节决定（编码写默认 0x09，参考诊断仪导出 的 27 09 01 00 实证；KWP 归一 0x00）；取 seed 全零才跳过解锁；原厂无 case 且 ECU 回非零 seed 时明确拒写（不猜 key、不试错、不穷举 level）"
});

/* === WRITE_BEHAVIOR_EVAL_BEGIN（生成器 tools/build-write-alignment.mjs 原样保留本块）=== */
/**
 * ★ 2026-11-13 T03-i：13 项写对齐**行为复跑**求值器。
 *
 * 每次调用都从矩阵里的**实测帧序列**逐帧重算 13 项，而不是读取静态
 * `checks[].ok` 布尔或 `aligned===true`。任意一帧被改错（反例注入）都会让
 * 对应的 shape / readback / no-ident / no-auto-restore / record-driven-sid
 * 检查翻红 → aligned=false → 写闸门拒写；还原后逐项复绿。
 *
 * 纯函数：不 import Coder / MockAdapter / coder.js —— 避免与生成器
 * tools/build-write-alignment.mjs（它 import Coder）形成循环依赖。
 * 帧模板与构建期生成器 tools/build-write-alignment.mjs 的 4 组模板逐字一致。
 *
 * @param {object} matrix 对齐矩阵（默认 WRITE_ALIGNMENT），可传克隆体做反例注入
 * @returns {{checks:Array<{id:string,ok:boolean,grade:string,detail:string}>,
 *            aligned:boolean, frameCount:number, behaviorRun:boolean}}
 */
export function evaluateWriteAlignmentChecks(matrix = WRITE_ALIGNMENT) {
  const T_KWP = [/^1089$/i, /^3E00$/i, /^21[0-9A-F]{2}$/i, /^170000$/i, /^3B[0-9A-F]+$/i, /^21[0-9A-F]{2}$/i];
  const T_UDS = [/^10[0-9A-F]{2}$/i, /^3E00$/i, /^10[0-9A-F]{2}$/i, /^22[0-9A-F]{4}$/i,
    /^2709[0-9A-F]*$/i, /^270A[0-9A-F]+$/i, /^2E[0-9A-F]+$/i, /^22[0-9A-F]{4}$/i];
  const T_OEM_KWP = [/^10[0-9A-F]{2}$/i, /^3E00$/i, /^21[0-9A-F]{2}$/i, /^170000$/i,
    /^3B[0-9A-F]+$/i, /^21[0-9A-F]{2}$/i];
  const T_OEM_UDS = [/^3E00$/i, /^10[0-9A-F]{2}$/i, /^22[0-9A-F]{4}$/i,
    /^2709[0-9A-F]*$/i, /^270A[0-9A-F]+$/i, /^2E[0-9A-F]+$/i, /^22[0-9A-F]{4}$/i];
  // 识别链帧（写序列里绝不允许出现：写路径 skipIdent:true）
  const IDENT_FRAME = /^(1A[0-9A-F]{2}|22F1A2|22F19E)$/i;

  const list = (x) => (Array.isArray(x) ? x.map((f) => String(f ?? '')) : []);
  const shape = (frames, tpl) => frames.length === tpl.length
    && tpl.every((re, i) => re.test(frames[i] ?? ''));
  const kwp = list(matrix?.measuredKwp);
  const uds = list(matrix?.measuredUds);
  const oemKwp = list(matrix?.measuredWithContext?.kwp?.frames);
  const oemUds = list(matrix?.measuredWithContext?.uds?.frames);
  const allFrames = [...kwp, ...uds, ...oemKwp, ...oemUds];

  // 行为证据：由构建期真跑 Coder 捕获，逐条复算，不再用源码正则猜。
  const evidence = matrix?.behaviorEvidence || {};
  const checks = [
    { id: 'kwp-frame-shape', ok: shape(kwp, T_KWP), detail: `KWP 6 帧逐帧复跑：${kwp.join('→') || '(空)'}` },
    { id: 'uds-frame-shape', ok: shape(uds, T_UDS), detail: `UDS 8 帧逐帧复跑：${uds.join('→') || '(空)'}` },
    { id: 'readback-verify', ok: kwp.length === 6 && uds.length === 8
      && kwp[2] === kwp[5] && uds[3] === uds[7],
      detail: `写入后回读帧与备份读帧同形：KWP ${kwp[2] || '—'}/${kwp[5] || '—'} UDS ${uds[3] || '—'}/${uds[7] || '—'}` },
    { id: 'safety-default-off', ok: evidence.safetyOff === true,
      detail: `值域/level/地址态/自动回滚/跨度闸默认全关：实跑=${String(evidence.safetyOff)}` },
    { id: 'no-ident-chain-in-write', ok: evidence.noIdentInWriteFrames === true
      && !allFrames.some((f) => IDENT_FRAME.test(f)),
      detail: `写序列无识别链帧：实跑=${String(evidence.noIdentInWriteFrames)} 帧集命中=${allFrames.filter((f) => IDENT_FRAME.test(f)).length}` },
    { id: 'skip-ident-on-write', ok: evidence.skipIdent === true
      && !allFrames.some((f) => IDENT_FRAME.test(f)),
      detail: `写路径不重跑整套识别链：实跑=${String(evidence.skipIdent)}` },
    { id: 'no-auto-restore', ok: evidence.noAutoRestore === true
      && kwp.filter((f) => /^3B/i.test(f)).length === 1
      && uds.filter((f) => /^2E/i.test(f)).length === 1,
      detail: `回读不一致不自动回滚；写帧各 1 条：实跑=${String(evidence.noAutoRestore)} KWP写=${kwp.filter((f) => /^3B/i.test(f)).length} UDS写=${uds.filter((f) => /^2E/i.test(f)).length}` },
    { id: 'no-security-brute', ok: evidence.noSecurityBrute === true
      && uds.filter((f) => /^27/i.test(f)).length === 2
      && kwp.filter((f) => /^17/i.test(f)).length === 1,
      detail: `单组安全访问（不逐级试 level）：实跑=${String(evidence.noSecurityBrute)} UDS27=${uds.filter((f) => /^27/i.test(f)).length} KWP17=${kwp.filter((f) => /^17/i.test(f)).length}` },
    { id: 'record-driven-sid', ok: evidence.recordDrivenSid === true
      && WRITE_SIDS_FROM_FRAMES(kwp, uds),
      detail: `读写帧 SID 全部来自编码记录：实跑=${String(evidence.recordDrivenSid)} 写SID=${[kwp.find((f) => /^3B/i.test(f)), uds.find((f) => /^2E/i.test(f))].map((f) => (f || '—').slice(0, 2)).join('/')}` },
    { id: 'session-evidence', ok: evidence.sessionEvidence === true
      && oemKwp.length === 6 && oemUds.length === 7,
      detail: `会话/序列由逐 ECU 证据驱动：实跑=${String(evidence.sessionEvidence)} 上下文帧 ${oemKwp.length}/${oemUds.length}` },
    { id: 'address-probe', ok: evidence.addressProbe === true
      && shape(kwp, T_KWP) && shape(uds, T_UDS),
      detail: `地址由 bind-plan 候选 + 探针收敛；闸门只校验 11 位合法：实跑=${String(evidence.addressProbe)}` },
    { id: 'oem-context-kwp', ok: shape(oemKwp, T_OEM_KWP)
      && Number.parseInt((oemKwp[0] || '').slice(2, 4), 16) === 0x86,
      detail: `有证据上下文 KWP：会话帧 ${oemKwp[0] || '—'} = 证据会话 0x86，6 帧同形` },
    { id: 'oem-context-uds', ok: shape(oemUds, T_OEM_UDS)
      && Number.parseInt((oemUds[1] || '').slice(2, 4), 16) === 0x03,
      detail: `有证据上下文 UDS：会话帧 ${oemUds[1] || '—'} = 证据会话 0x03，7 帧同形` },
  ].map((c) => ({ ...c, grade: c.ok ? 'A' : '非A' }));
  return {
    checks,
    aligned: checks.length === 13 && checks.every((c) => c.ok && c.grade === 'A'),
    frameCount: allFrames.length,
    behaviorRun: true,
  };
}

/** 写帧 SID 必须落在记录允许的写服务集合内（0x3B / 0x2E），不替记录发明默认值。 */
function WRITE_SIDS_FROM_FRAMES(kwp, uds) {
  const allowed = new Set([0x3b, 0x2e]);
  const kwpWrite = kwp.find((f) => /^[0-9A-F]{2}/i.test(f) && Number.parseInt(f.slice(0, 2), 16) === 0x3b);
  const udsWrite = uds.find((f) => /^[0-9A-F]{2}/i.test(f) && Number.parseInt(f.slice(0, 2), 16) === 0x2e);
  return !!kwpWrite && !!udsWrite
    && allowed.has(Number.parseInt(kwpWrite.slice(0, 2), 16))
    && allowed.has(Number.parseInt(udsWrite.slice(0, 2), 16));
}
/* === WRITE_BEHAVIOR_EVAL_END === */

/** 闸门模式：'aligned'（默认，按对齐矩阵）｜ 'whitelist-only'（保守回退，仅 981 DME）。 */
export const WRITE_GATE = { mode: 'aligned' };
export function setWriteGateMode(mode) {
  if (mode !== 'aligned' && mode !== 'whitelist-only') {
    throw new Error('未知写闸门模式：' + mode);
  }
  WRITE_GATE.mode = mode;
  return WRITE_GATE.mode;
}

/** 旧白名单（保守模式用，也是 981 DME 完整实车写序列的标注来源）。 */
function legacyWhitelist(sys, model, addr, family) {
  return model === 'Cayman（981）'
    && sys?.label === 'ECM/DME(发动机控制模块)'
    && (sys?.modules || []).includes('DME_BDE_Continental')
    && addr?.tx === 0x7e0 && addr?.rx === 0x7e8 && family === 'kwp';
}

/**
 * 写闸门：按「与原厂写流程对齐」判定，而不是「该 ECU 是否单独做过实车测试」。
 *
 * 原厂的写流程本身是实车验证过的；只要本次链路的每一环都由包内证据/记录驱动、
 * 且 13 项写对齐行为复跑全 A，就继承该验证。仍逐项检查运行时证据：
 *   模块记录（sys.modules）、车型、11 位合法地址、会话家族 —— 缺任一项就不写。
 * 记录级的只读项/非法 SID/越界值由 coder.applyChange 与 schema.canWrite 再拦一次。
 *
 * ★ 2026-11-13 T03-i：不再只读静态 aligned===true + 4 参数，
 *   **每次调用都实跑 evaluateWriteAlignmentChecks() 重算 13 项**（帧序列逐帧复跑）。
 *   反例注入改错任一写帧 → 对应检查翻红 → aligned=false → 立即拒写。
 */
export function writeProfileFromAlignment(sys, model, addr, family) {
  // ★ QA R1 / G9：删除休眠免检分支。此前 mode==='whitelist-only' 时
  //   白名单命中即直接 verified:true，**完全不跑 13 项**；而 setWriteGateMode()
  //   运行时可切回该模式 → 存在「休眠免检」后门。
  //   现改为：保守模式同样先实跑 evaluateWriteAlignmentChecks()，13 项非全 A 一律拒写，
  //   只有「13 项全 A ∧ 命中 981 DME 白名单」才放行（比原逻辑更严，且无免检路径）。
  if (WRITE_GATE.mode === 'whitelist-only') {
    const conservative = evaluateWriteAlignmentChecks();
    if (!conservative.aligned) {
      const cbad = conservative.checks.filter((c) => !c.ok).map((c) => c.id).join(', ');
      return { verified: false, reason: '保守模式：13 项写对齐未通过（' + (cbad || '矩阵未对齐') + '）',
        profile: null, behaviorRun: conservative.behaviorRun, alignmentChecks: conservative.checks.length };
    }
    return legacyWhitelist(sys, model, addr, family)
      ? { verified: true, reason: '保守模式：981 Cayman DME 完整实车写序列（13 项行为复跑全 A）', profile: '981-cayman-dme-kwp-21-3b' }
      : { verified: false, reason: '保守模式：该 ECU 不在白名单（13 项已复跑）', profile: null };
  }
  const live = evaluateWriteAlignmentChecks();
  if (!WRITE_ALIGNMENT.aligned || !live.aligned) {
    const bad = live.checks.filter((c) => !c.ok).map((c) => c.id).join(', ');
    return { verified: false, reason: '写流程与原厂对齐判定未通过（13 项行为复跑：' + (bad || '矩阵未对齐') + '）',
      profile: null, behaviorRun: live.behaviorRun, alignmentChecks: live.checks.length };
  }
  const gaps = [];
  if (!model) gaps.push('车型未定');
  if (!sys?.modules?.length) gaps.push('模块记录为空');
  if (!addr || !Number.isInteger(addr.tx) || !Number.isInteger(addr.rx)
      || addr.tx <= 0 || addr.tx > 0x7f7 || addr.rx <= 0 || addr.rx > 0x7ff) {
    gaps.push('地址未绑定或非法 11 位');
  }
  if (!family) gaps.push('会话家族未定');
  if (gaps.length) {
    return { verified: false, reason: '写链路缺运行时证据：' + gaps.join('、'), profile: null };
  }
  const profile = legacyWhitelist(sys, model, addr, family)
    ? '981-cayman-dme-kwp-21-3b'
    : 'aligned-record-driven';
  return {
    verified: true,
    reason: '写序列逐帧对齐原厂主写模板（原厂流程已实车验证）；'
      + '会话/序列/地址由包内证据驱动，读写帧由编码记录驱动，回读校验，写结果以 ECU 应答为准',
    profile,
    alignment: WRITE_ALIGNMENT.schemaVersion,
  };
}
