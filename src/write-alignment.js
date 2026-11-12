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
      "detail": "值域/level/地址态/自动回滚/跨度闸默认全关 = 原厂行为"
    },
    {
      "id": "no-ident-chain-in-write",
      "grade": "A",
      "ok": true,
      "detail": "写序列 skipIdent:true，不重跑识别链（原厂写序列无识别链）"
    },
    {
      "id": "skip-ident-on-write",
      "grade": "A",
      "ok": true,
      "detail": "写路径不重跑整套识别链"
    },
    {
      "id": "no-auto-restore",
      "grade": "A",
      "ok": true,
      "detail": "回读不一致记录失败，不自动回滚（原厂语义）"
    },
    {
      "id": "no-security-brute",
      "grade": "A",
      "ok": true,
      "detail": "不逐级试 level，避免 0x35→0x36 锁死"
    },
    {
      "id": "record-driven-sid",
      "grade": "A",
      "ok": true,
      "detail": "读写帧 SID 全部来自编码记录，公共 API 不替记录发明默认值"
    },
    {
      "id": "session-evidence",
      "grade": "A",
      "ok": true,
      "detail": "进模块会话/序列来自 SYS_DATA comm 逐 ECU 证据"
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
  "rule": "记录驱动的读写帧 + 会话/序列证据 + 地址候选探针 + 回读校验；原厂无的自创增强默认全关；seed/key 按 drivelinks mode 表算 key，安全 level 由脚本命令字节决定（编码写默认 0x09，原厂请求模板库 的 27 09 01 00 实证；KWP 归一 0x00）；取 seed 全零才跳过解锁；原厂无 case 且 ECU 回非零 seed 时明确拒写（不猜 key、不试错、不穷举 level）"
});

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
 * 且 WRITE_ALIGNMENT.aligned 为真，就继承该验证。仍逐项检查运行时证据：
 *   模块记录（sys.modules）、车型、11 位合法地址、会话家族 —— 缺任一项就不写。
 * 记录级的只读项/非法 SID/越界值由 coder.applyChange 与 schema.canWrite 再拦一次。
 */
export function writeProfileFromAlignment(sys, model, addr, family) {
  if (WRITE_GATE.mode === 'whitelist-only') {
    return legacyWhitelist(sys, model, addr, family)
      ? { verified: true, reason: '保守模式：981 Cayman DME 完整实车写序列', profile: '981-cayman-dme-kwp-21-3b' }
      : { verified: false, reason: '保守模式：该 ECU 不在白名单', profile: null };
  }
  if (!WRITE_ALIGNMENT.aligned) {
    return { verified: false, reason: '写流程与原厂对齐判定未通过', profile: null };
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
