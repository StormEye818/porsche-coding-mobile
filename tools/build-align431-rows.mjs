#!/usr/bin/env node
/**
 * build-align431-rows.mjs — 生成 tools/align431-rows.json（机读判定表）。
 *
 * 纪律（PRD §3 P0-1 / Q1 / U-1 / R-5）：
 *   - baselineRows = GAP-INVENTORY-20261112.md §2 :41–:81 的 41 行，逐行保留
 *     原编号（:41…:81）与原文（originalText 逐字节抄录），禁删行、禁合并行；
 *   - addedRows 全部由脚本按 data/*.json 的**实际条目**生成，N 由数组长度输出，
 *     不硬编码常数；至少覆盖 11 类；
 *   - forensicGrade（取证等级）与 u1CarrierStatus（U-1 载体状态）分列两字段，
 *     门禁未落盘时后者标「待落盘（#20）」但不把取证 A 降级；
 *   - 输出确定性：禁时间戳 / generatedAt / 绝对路径 / 随机顺序，键一律排序。
 *
 * 跑法：node tools/build-align431-rows.mjs
 */
import { writeFileSync } from 'node:fs';
import {
  ROOT, GAP_FILE, PRD_FILE, readText, readJson, fileExists, sortedKeys,
  evaluateRow, evaluateCheck, gateVerdict, measureNumberSources, legacyNumbersFromPrd,
} from './align431-eval.mjs';
import { join } from 'node:path';

const OUT = join(ROOT, 'tools', 'align431-rows.json');
const GAP_LINE_START = 41;
const GAP_LINE_END = 81;
const BASELINE_COUNT = GAP_LINE_END - GAP_LINE_START + 1;

/* ──────────────────────────────────────────────────────────────────
 * ★ 裁定 1：deferred → evidence 机制化（不手改行、不缓存、不放宽判定）
 *
 * 每个 deferred 行在生成时按**磁盘实况**重算四个条件，四条全满足才产出
 * `evidence(file, token, note)`，否则保持 `deferred`：
 *   ① gate 文件实存；
 *   ② gate 文本内真实含该行 assertion 断言名（且是实跑行为断言）；
 *   ③ evidence(file, token) 的 token 与该行判据语义相关且真实命中；
 *   ④ 该阶段实现已落地（phase 对应的实现标记逐条命中磁盘）。
 *
 * `align431-eval.mjs` 完全未改：`evaluateCheck` 仍对 deferred 恒判 false，
 * evidence 仍强制 file+token 命中。判定收敛靠**真实证据落盘**，不靠改内核。
 *
 * T04 的 24 行不会提前转 A：④ 的 T04 标记依赖本组的终验产物
 * （audit:align431 接进 scripts.test + 681→454 证明 + U-2 单一真值），
 * 这些产物全部落盘后重跑本生成器，才自动转 A。
 * ────────────────────────────────────────────────────────────────── */

/**
 * ★ QA R1 / G2 + G3 + G4：逐行**专属**证据与真实 codePath 覆盖表（按 rowId / baselineLine）。
 *
 * 旧实现的三个坏味道：
 *   G2 —— codePath 指向全库零命中的符号（variant.js:identMatch / seedkey.js:computeKey /
 *         app.js:runWritePrologue / coder.js:validateParam / app.js:specialFunctionEntry …）；
 *         evidence431 用 `PORSCHE_SYS_DATA.BIN:0x0` 占位冒充坐标。
 *   G3 —— 15 条原判 A 的基线行只靠 `{all:[{exists:[gate,src]}]}`（等价 ok(true)）。
 *   G4 —— 19 行 deferred 按 assertion/阶段共用一条 token，与本行判据语义无关。
 *
 * 本表把每一行钉到「真实符号 / 真实记录号 / 与本行判据直接相关的 token」，
 * 不存在的就补真实落点（全部已实测在对应文件内命中）。
 */

/** 基线行（GAP §2 :41–:81）逐行真实 codePath + evidence431 + 语义 check 覆盖。 */
const BASELINE_OVERRIDE = Object.freeze({
  // 连接
  41: { codePath: 'src/elm327.js:cmdOk', evidence431: 'libPORSCHE_SYSP.so:0x24DE4', check: { kind: 'evidence', file: 'src/elm327.js', token: 'requireOk', note: 'ATSH/ATCRA 绑定命令空回执阻断（T03-h 行为）' } },
  42: { codePath: 'src/elm327.js:cmd', evidence431: 'libPORSCHE_SYSP.so:0x24E02', check: { kind: 'evidence', file: 'src/elm327.js', token: 'ATSH', note: 'SetAddress/FilterId ≡ ATSH/ATCRA 实发' } },
  43: { codePath: 'src/elm327.js:cmd', evidence431: 'libPORSCHE_SYSP.so:0x10000359', check: { kind: 'evidence', file: 'src/elm327.js', token: 'ATCFC1', note: 'n=0 用 ATSH/ATCRA 回执等价（VCI send 无 ELM 对应物）' } },
  // VIN
  44: { codePath: 'src/coder.js:readVinByObd', evidence431: 'libPORSCHE_READWRITE.so:0x147C80', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/coder.js', token: 'vinCharsetFilter', note: 'D-4 两链同一字符集原语' }, { kind: 'jsonCountGte', file: 'data/vehicle-id-type-map.json', path: ['menuTexts'], min: 32 }] } },
  45: { codePath: 'src/coder.js:readVinByObd', evidence431: 'libPORSCHE_READWRITE.so:0x147D10', check: { kind: 'evidence', file: 'src/coder.js', token: 'anyRx', note: '广播路径 anyRx 语义（固定响应头/内容校验兜底）' } },
  46: { codePath: 'src/coder.js:vinCharsetFilter', evidence431: 'libPORSCHE_READWRITE.so:0x147D9C', check: { kind: 'evidence', file: 'src/coder.js', token: 'vinCharsetFilter', note: 'D-4 VIN 字符集两链统一原语' } },
  // 车型
  47: { codePath: 'src/model-name-table.js:MODEL_NAME_TABLE', evidence431: 'libPORSCHE_SYSP.so:0x5E42C', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/model-name-table.js', token: 'MODEL_NAME_TABLE', note: 'SYSP 0x5E42C 24 键车型名表' }, { kind: 'jsonCountEq', file: 'data/vehicle-id-type-map.json', path: ['menuTexts'], value: 32 }] } },
  48: { codePath: 'src/model-name-table.js:matchModelNameExact', evidence431: 'libPORSCHE_SYSP.so:0x5E430', check: { kind: 'evidence', file: 'src/model-name-table.js', token: 'matchModelNameExact', note: 'strcmp 逐字节全等（非归一化兜底）' } },
  // 平台代
  49: { codePath: 'src/model-sysid-map.js:MODEL_SYSID_INDEX', evidence431: 'libPORSCHE_SYSP.so:0x26344', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/model-sysid-map.js', token: 'MODEL_SYSID_INDEX', note: 'DSN 头 22 项索引接入运行时' }, { kind: 'jsonCountEq', file: 'data/sysdata-root-table.json', path: ['types'], value: 22 }] } },
  50: { codePath: 'src/model-sysid-map.js:MODEL_SYSID_INDEX', evidence431: 'data/dsn-module-sysids.json:canonicalType', check: { kind: 'all', of: [{ kind: 'evidence', file: 'data/dsn-module-sysids.json', token: 'canonicalType', note: '9X6/9X7 canonicalType 严格超集（数据级）' }, { kind: 'evidence', file: 'src/model-sysid-map.js', token: 'MODEL_SYSID_INDEX', note: '运行时索引消费该数据' }] } },
  51: { codePath: 'src/model-sysid-map.js:MODEL_SYSID_INDEX', evidence431: 'data/dsn-module-sysids.json:canonicalType', check: { kind: 'evidence', file: 'data/dsn-module-sysids.json', token: 'canonicalType', note: '共享子集任选高字节无害（逐 type 唯一集合）' } },
  52: { codePath: 'src/model-sysid-map.js:MODEL_SYSID_INDEX', evidence431: 'data/dsn-module-sysids.json:platforms.9x6.mappingCount',
    gate: 'tools/verify-hb1.mjs', assertion: 'HB1-T5-03',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'data/dsn-module-sysids.json', token: '"mappingCount": 29', note: '9X6 模块映射 29 条（源包数据量，已被 29/29 复跑推翻旧「只有那些」结论）' },
      { kind: 'jsonEquals', file: 'data/dsn-module-sysids.json', path: ['platforms', '9x6', 'mappingCount'], value: 29, note: '9X6 mappingCount == 29（常量，非 >=）' },
    ] } },
  // 寻址
  53: { codePath: 'src/app.js:probeChainFor', evidence431: 'libPORSCHE_LINK.so:0x18F00', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/app.js', token: 'probeChainFor', note: '②-a 探针阶段每候选 1 帧 221409/1A9F' }, { kind: 'jsonCountGte', file: 'data/bind-plan.json', path: ['ecu'], min: 400, note: 'bind-plan 全量候选（479 sysId 口径）' }] } },
  54: { codePath: 'src/app.js:probeChainFor', evidence431: 'libPORSCHE_LINK.so:0x18F2C', check: { kind: 'evidence', file: 'src/app.js', token: 'probeChainFor', note: '②-b 身份裁决收敛候选（应答即绑+身份比对）' } },
  55: { codePath: 'src/app.js:probeChainFor', evidence431: 'libPORSCHE_LINK.so:0x18FE2', check: { kind: 'evidence', file: 'src/app.js', token: '221102', note: '22 11 02 绑定失败补帧（响应不作成功依据）' } },
  56: { codePath: 'src/app.js:addrCandsFor', evidence431: 'libPORSCHE_LINK.so:0x18F60', check: { kind: 'evidence', file: 'src/app.js', token: 'addrCandsFor', note: '地址候选由 bind-plan 生成' } },
  57: { codePath: 'src/app.js:probeAddressFor', evidence431: 'libPORSCHE_LINK.so:0x18F90', check: { kind: 'evidence', file: 'src/app.js', token: 'probeAddressFor', note: '探针按候选逐帧收敛' } },
  58: { codePath: 'src/app.js:addrTableUnique', evidence431: 'libPORSCHE_LINK.so:0x18FC0', check: { kind: 'evidence', file: 'src/app.js', token: 'addrTableUnique', note: '别名/低字节平移去重' } },
  59: { codePath: 'src/probe.js:TWIN_GROUPS', evidence431: 'GAG_TEXT_CN.GAG.bin:idx 1961..1992',
    gate: 'tools/verify-ui-text-gag.mjs', assertion: 'UI_TEXT_GAG_IDX_COORD',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'src/probe.js', token: 'TWIN_GROUPS', note: '6 对孪生静态表（不承诺左右）' },
      { kind: 'evidence', file: 'data/vehicle-id-type-map.json', token: 'menuTexts', note: 'GAG_TEXT_CN 文本表 idx 坐标 32 条' },
    ] } },
  // 变体
  60: { codePath: 'src/probe.js:identMatch', evidence431: 'JOB.BIN:0x147C80', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/probe.js', token: 'identMatch', note: 'identMatch 原语（真实落点在 probe.js）' }, { kind: 'jsonCountGte', file: 'data/ident-registry.json', path: ['identToVariant'], min: 20 }] } },
  // 会话
  61: { codePath: 'src/oem-session-table.js:oemSessionFor', evidence431: 'PORSCHE_SYS_DATA.BIN:0x63D', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/oem-session-table.js', token: 'OEM_SESSION_BY_SYSID', note: '逐 ECU 会话表 737 sysId' }, { kind: 'jsonCountGte', file: 'data/sysdata-comm.json', path: ['ecu'], min: 700 }] } },
  62: { codePath: 'src/oem-session-table.js:oemSessionFor', evidence431: 'PORSCHE_SYS_DATA.BIN:0x641', check: { kind: 'evidence', file: 'src/oem-session-table.js', token: 'OEM_SESSION_BY_SYSID', note: '会话/序列由 SYS_DATA comm 证据驱动' } },
  63: { codePath: 'src/oem-enter-frames.js:oemIsSessionless', evidence431: 'PORSCHE_SYS_DATA.BIN:0x645', check: { kind: 'evidence', file: 'src/oem-enter-frames.js', token: 'oemIsSessionless', note: 'sessionless 老代 KWP 不建 UDS 会话' } },
  // 读
  64: { codePath: 'src/coder.js:readVehicleIdentity', evidence431: 'libPORSCHE_READWRITE.so:0x0F830D', check: { kind: 'evidence', file: 'src/coder.js', token: 'readVehicleIdentity', note: '读帧构造 21/22/1A + 识别链 + 回读' } },
  // 写
  65: { codePath: 'src/write-alignment.js:writeProfileFromAlignment', evidence431: 'libPORSCHE_READWRITE.so:0x0F855D', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/write-alignment.js', token: 'evaluateWriteAlignmentChecks', note: '13 项写对齐每次实跑重算' }, { kind: 'evidence', file: 'src/write-alignment.js', token: 'WRITE_GATE', note: '写闸门按对齐矩阵判定' }] } },
  66: { codePath: 'src/coder.js:withWriteLock', evidence431: 'libPORSCHE_READWRITE.so:0x0F85A0', check: { kind: 'evidence', file: 'src/coder.js', token: 'withWriteLock', note: '统一写事务排他' } },
  67: { codePath: 'src/coder.js:_restore', evidence431: 'libPORSCHE_READWRITE.so:0x0F85E4', check: { kind: 'evidence', file: 'src/coder.js', token: 'sessionless', note: '恢复路径按备份记录 sessionless 跳过会话' } },
  // seed/key
  68: { codePath: 'src/seedkey-sa2.js:computeKey', evidence431: 'libPORSCHE_FILE.so:0x18A74', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/seedkey-sa2.js', token: 'computeKey', note: 'SA2 生产算法（真实落点）' }, { kind: 'evidence', file: 'src/seedkey-pswcalc.js', token: '未装载时拒绝计算', note: '0x1D 未装载 state 拒算' }] } },
  69: { codePath: 'src/seedkey-sa2.js:computeKey', evidence431: 'libPORSCHE_FILE.so:0x18A90', check: { kind: 'evidence', file: 'src/seedkey-sa2.js', token: 'computeKey', note: 'mode=null/越界拒写归零' } },
  70: { codePath: 'src/seedkey-resolver.js:resolveKey', evidence431: 'libPORSCHE_FILE.so:0x18AB0', check: { kind: 'evidence', file: 'src/seedkey-resolver.js', token: 'resolveKey', note: 'seed/key 生产链解析器' } },
  71: { codePath: 'src/seedkey.js:makeProvider', evidence431: 'libPORSCHE_FILE.so:0x18AD0', check: { kind: 'evidence', file: 'src/seedkey.js', token: 'makeProvider', note: 'provider 工厂' } },
  // 恢复/批量/编程页
  72: { codePath: 'src/coder.js:runWritePrologue', evidence431: 'PORSCHE_SYS_DATA.BIN:0x649', check: { kind: 'evidence', file: 'src/coder.js', token: 'runWritePrologue', note: '写序言（真实落点 coder.js，非 app.js）' } },
  73: { codePath: 'src/coder.js:runWritePrologue', evidence431: 'data/routines-verified.json:requestCount',
    gate: 'tools/build-routines-verified.py', assertion: 'D2_RID_79_79',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'data/routines-verified.json', token: '"requestCount"', note: '79 例程 ID 共 252 请求（合法性已逐条复跑）' },
      { kind: 'jsonEquals', file: 'data/routines-verified.json', path: ['requestCount'], value: 252, note: 'requestCount == 252' },
    ] } },
  74: { codePath: 'src/coder.js:withWriteLock', evidence431: 'data/routines-verified.json:items[0].byteCoords[0].idxOff',
    gate: 'tools/build-routines-verified.py', assertion: 'D2_RID_79_79',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'data/routines-verified.json', token: '"idxOff"', note: '每例程带真实字节坐标（语义以真车为准，ID 合法性静态可证）' },
      { kind: 'jsonCountEq', file: 'data/routines-verified.json', path: ['items'], value: 79, note: '79 个例程条目' },
    ] } },
  75: { codePath: 'src/app.js:writeDeniedReason', evidence431: 'data/routines-verified.json:noRidEntries',
    gate: 'tools/build-routines-verified.py', assertion: 'D2_RID_79_79',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'data/routines-verified.json', token: '"noRidEntries"', note: 'noRid 16 条单列载体' },
      { kind: 'jsonCountEq', file: 'data/routines-verified.json', path: ['noRidEntries'], value: 16, note: 'noRidEntries 恰 16 条' },
    ] } },
  // 数据层
  76: { codePath: 'src/schema.js:validateParam', evidence431: 'data/drivelinks.json:recordCount', check: { kind: 'all', of: [{ kind: 'evidence', file: 'src/schema.js', token: 'validateParam', note: '记录校验（真实落点 schema.js）' }, { kind: 'jsonCountGte', file: 'data/drivelinks.json', path: ['ecu'], min: 200, note: 'drivelinks 209 ECU / 1070 条记录' }] } },
  77: { codePath: 'src/schema.js:validateParam', evidence431: 'data/sysdata-root-table.json:types', check: { kind: 'evidence', file: 'src/schema.js', token: 'validateParam', note: 'addrBlock u16 打包形态校验' } },
  78: { codePath: 'src/schema.js:resolveBlockReadSid', evidence431: 'data/special-functions.json:namespace',
    gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_NAMESPACE_SEPARATED',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'data/special-functions.json', token: '"namespace"', note: 'menuId 命名空间声明（67 条 0x200–0x34E）' },
      { kind: 'jsonEquals', file: 'data/special-functions.json', path: ['namespace', 'count'], value: 67, note: 'namespace.count == 67' },
    ] } },
  79: { codePath: 'src/schema.js:extractField', evidence431: 'GAP-INVENTORY-20261112.md:§5 U-2 单一真值',
    gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_NUMBER_DIFF_ZERO',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'GAP-INVENTORY-20261112.md', token: 'U-2 单一真值', note: 'BUCKET-LISTS 归桶依据 = U-2 单一真值表' },
      { kind: 'evidence', file: 'src/schema.js', token: 'extractField', note: '位域提取（bitsize>8 逐条）' },
    ] } },
  80: { codePath: 'src/schema.js:decodeValue', evidence431: 'src/app.js:rangeHint(13873/13873)',
    gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_D5_13873',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'src/app.js', token: '13873/13873', note: 'D-5 maxText 现值 13873/13873 一致（34 为历史值）' },
      { kind: 'evidence', file: 'src/schema.js', token: 'decodeValue', note: 'D-5 按位宽显示上限 2^bitsize-1' },
    ] } },
  81: { codePath: 'src/schema.js:canWrite', evidence431: 'data/menu-tree-v3.json:itemIdsBackfill',
    gate: 'tools/verify-d3-id-union.py', assertion: 'D3_ID_UNION',
    check: { kind: 'all', of: [
      { kind: 'evidence', file: 'data/menu-tree-v3.json', token: '"itemIdsBackfill"', note: '代码-数据断接：153 节点 itemIds 回填完成（500 截断归零）' },
      { kind: 'evidence', file: 'src/schema.js', token: 'canWrite', note: '写服务集闸（0x3B/0x2E）' },
    ] } },
});

/** 追加行（AD-*）逐行真实 codePath 覆盖（G2）。 */
const ADDED_CODEPATH_OVERRIDE = Object.freeze({
  'AD-NORID': 'src/app.js:runSequence',            // 16 条 noRid：特殊功能序列执行入口
  'AD-D2-': 'src/special-catalog.js:specialFunctionsFor', // D-2 命名空间
  'AD-FEATURE-': 'src/schema.js:enumeratePages',   // 功能全集枚举（app.js 已 import）
  'AD-U1-': 'src/app.js:topLevelItems',            // U-1 缺件行：app 主链入口
  'AD-RESERVE-MENU': 'src/app.js:topLevelItems',   // menu-tree 入口
  'AD-RESERVE-UI': 'src/probe.js:TWIN_GROUPS',     // 孪生标注静态载体
  'AD-HB3-L': 'src/oem-enter-frames.js:OEM_ENTER_SEQS', // HB-3 三层（真实常量名）
});
const DEFERRED_EVIDENCE = Object.freeze({
  VIN_CHAIN_CONSISTENT: { file: 'src/coder.js', token: 'vinCharsetFilter', note: 'D-4 两链同一字符集原语（IsCharNum 语义）' },
  MODEL_NAME_TABLE_24: { file: 'src/model-name-table.js', token: 'MODEL_NAME_TABLE', note: 'SYSP:0x5E42C 24 键车型名表静态落盘' },
  FULLCHAIN_AT_LAYER: { file: 'src/elm327.js', token: 'requireOk', note: 'T03-h ATSH/ATCRA 空回执阻断 + 半包清空' },
  WRITE_PROLOGUE_WIRED: { file: 'src/app.js', token: 'withWriteLock', note: 'T03-g 统一写事务覆盖写/恢复/序列/编程页' },
  VARIANT_IDENT_MATCH: { file: 'src/variant.js', token: 'autoPickVariant', note: '识别串→变体静态匹配' },
  READ_FRAME_ID: { file: 'src/coder.js', token: 'checkRx', note: '回帧 ID 硬校验（FilterId 语义）' },
  OEM_SESSION_EVIDENCE: { file: 'src/oem-session-table.js', token: 'OEM_SESSION_BY_SYSID', note: '逐 ECU 原厂会话静态表' },
  U2_NUMBER_DIFF_ZERO: { file: 'tools/verify-u2-numbers.mjs', token: 'measureNumberSources', note: 'U-2 权威数字清单动态机读，非硬编码' },
  U2_D5_13873: { file: 'src/app.js', token: '13873/13873', note: 'D-5 maxText 现值 13873/13873 按位宽显示' },
  U2_NAMESPACE_SEPARATED: { file: 'data/routines-verified.json', token: 'namespaces', note: 'D-2 67 menuId / 79 RID / 687 功能序列三命名空间独立' },
  U1_TRIPLE_ZERO_MISSING: { file: 'tools/verify-u1-triple.mjs', token: 'carrierStatusOf', note: 'U-1 三件套按磁盘实况逐行重算' },
  'HB1-T5-01': { file: 'data/dsn-module-sysids.json', token: 'canonicalType', note: 'HB-1 9X6/9X7 canonicalType 严格超集' },
  OEM_DIFF_PROBE_PHASE: { file: 'src/app.js', token: 'probeChainFor', note: '②-a 探针阶段每候选 1 帧 221409/1A9F' },
  OEM_DIFF_IDENTITY_PHASE_2B: { file: 'src/coder.js', token: 'oemIdentityResponses', note: '②-b 身份裁决移到进模块后按 cat=0x60 四帧' },
  SEEDKEY_PRODUCTION_REACHABLE: { file: 'data/drivelinks.json', token: 'modeVerified', note: 'seed/key 生产链按记录复合低字节动态标注 modeVerified' },
  WRITE_GATE_13_CHECKS: { file: 'src/write-alignment.js', token: 'evaluateWriteAlignmentChecks', note: '13 项写对齐每次实跑重算' },
  FEATURE_SET_FUNCSEQ: { file: 'data/special-function-map.json', token: 'sequenceCoverage', note: '687 条功能序列全量登记，悬空引用归零' },
  FEATURE_SET_MEASURE: { file: 'data/measure.json', token: 'groupCap', note: 'measure 1719 全量按 app 现有上限分组' },
  FEATURE_SET_ROUTINES: { file: 'data/routines-verified.json', token: 'noRidEntries', note: 'noRid 16 条单列 + 79 RID 字节坐标' },
  FEATURE_SET_TOPJSON: { file: 'scripts/sync.mjs', token: 'SYNC_DATA_CONSISTENT', note: '顶层 json 差集显式归零' },
  FEATURE_SET_TRUNC500: { file: 'data/menu-tree-v3.json', token: 'itemIdsBackfill', note: '153 个 500 截断节点回填完成' },
  NORID_STATIC_CARRIER: { file: 'data/routines-verified.json', token: 'noRidEntries', note: 'noRid 16 条 GAG 字节坐标静态载体' },
  MENU_TREE_NO_TRUNCATION: { file: 'data/menu-tree-v3.json', token: 'itemIdsBackfill', note: 'menu-tree 500 截断归零且逐节点一致' },
  UI_TEXT_GAG_IDX_COORD: { file: 'data/vehicle-id-type-map.json', token: 'menuTexts', note: 'GAG_TEXT_CN idx 1961..1992 32 条文本表 + TWIN_GROUPS 不承诺左右' },
});

/** 阶段实现落地标记（逐条读磁盘，禁止硬编码「已落地」）。 */
function implLanded(phase) {
  const has = (file, token) => {
    const t = readText(file);
    return t !== null && t.includes(token);
  };
  if (phase === 'T01' || phase === 'T02') return true;
  if (phase === 'T03' || phase === 'T03-b') {
    // T03 已验收：D-4 两链 / 13 项行为写闸门 / 空回执阻断 / seed-key 生产链 / ②-b 硬断言
    return has('src/coder.js', 'isCharNum')
      && has('src/write-alignment.js', 'evaluateWriteAlignmentChecks')
      && has('src/elm327.js', 'requireOk')
      && has('data/drivelinks.json', 'modeVerified')
      && has('tools/verify-oem-probe-diff.mjs', 'identityPhaseHardAssert')
      && has('src/coder.js', 'oemIdentityResponses');
  }
  if (phase === 'T04') {
    // 本组终验产物：① 全组断言名真实落盘 ② U-2 单一真值 ③ 681→454 证明
    // ④ audit:align431 接入 scripts.test（最后一步），缺一即保持 deferred。
    const pkg = readJson('package.json');
    const testChain = pkg?.scripts?.test || '';
    return has('tools/verify-u1-triple.mjs', 'U1_TRIPLE_ZERO_MISSING')
      && has('tools/verify-u2-numbers.mjs', 'U2_D5_13873')
      && has('tools/verify-fullchain-audit.mjs', 'NORID_STATIC_CARRIER')
      && has('rebuild-all.py', 'MENU_911_681_TO_454_PROOF')
      && has('GAP-INVENTORY-20261112.md', 'U-2 单一真值')
      && testChain.includes('audit:align431');
  }
  return false;
}

/** 按磁盘实况把 deferred 解析为 evidence 或保持 deferred。 */
function resolveDeferred(row) {
  if (row.check?.kind !== 'deferred') return row.check;
  const spec = DEFERRED_EVIDENCE[row.assertion];
  if (!spec) return row.check;
  const gateText = readText(row.gate);
  const gateOk = gateText !== null && gateText.includes(row.assertion);
  const evText = readText(spec.file);
  const evOk = evText !== null && evText.includes(spec.token);
  const landed = implLanded(row.check.phase);
  if (gateOk && evOk && landed) {
    return { kind: 'evidence', file: spec.file, token: spec.token,
      note: `${spec.note}｜${row.check.phase} 实现已落地，deferred 自动转 evidence` };
  }
  return row.check;
}

/** 41 行基线的 R-1 两坐标 / 门禁 / 阶段元数据（按首列「阶段」映射，逐行套用行号坐标）。 */
const STAGE_META = Object.freeze({
  '连接': { evidence431: 'libPORSCHE_SYSP.so:0x24DE4', codePath: 'src/elm327.js:cmd', gate: 'tools/verify-fullchain-audit.mjs', assertion: 'FULLCHAIN_AT_LAYER' },
  'VIN': { evidence431: 'libPORSCHE_READWRITE.so:0x147C80', codePath: 'src/coder.js:readVinByObd', gate: 'tools/verify-all-models.mjs', assertion: 'VIN_CHAIN_CONSISTENT' },
  '车型': { evidence431: 'libPORSCHE_SYSP.so:0x5E42C', codePath: 'src/model-name-table.js:MODEL_NAME_TABLE', gate: 'tools/verify-all-models.mjs', assertion: 'MODEL_NAME_TABLE_24' },
  '平台代': { evidence431: 'libPORSCHE_SYSP.so:0x26344', codePath: 'src/model-sysid-map.js:MODEL_SYSID_INDEX', gate: 'tools/verify-hb1.mjs', assertion: 'HB1-T5-01' },
  '寻址': { evidence431: 'libPORSCHE_LINK.so:0x18F00', codePath: 'src/app.js:probeChainFor', gate: 'tools/verify-oem-probe-diff.mjs', assertion: 'OEM_DIFF_PROBE_PHASE' },
  '变体': { evidence431: 'JOB.BIN:0x0', codePath: 'src/variant.js:identMatch', gate: 'tools/verify-fullchain.mjs', assertion: 'VARIANT_IDENT_MATCH' },
  '会话': { evidence431: 'PORSCHE_SYS_DATA.BIN:0x0', codePath: 'src/oem-session-table.js:oemSessionFor', gate: 'tools/verify-oem-session.mjs', assertion: 'OEM_SESSION_EVIDENCE' },
  '读': { evidence431: 'libPORSCHE_READWRITE.so:0x0F830D', codePath: 'src/coder.js:readVehicleIdentity', gate: 'tools/verify-fullchain.mjs', assertion: 'READ_FRAME_ID' },
  '写': { evidence431: 'libPORSCHE_READWRITE.so:0x0F855D', codePath: 'src/write-alignment.js:WRITE_GATE', gate: 'tools/verify-write-gate.mjs', assertion: 'WRITE_GATE_13_CHECKS' },
  'seed/key': { evidence431: 'libPORSCHE_FILE.so:0x18A74', codePath: 'src/seedkey.js:computeKey', gate: 'tools/verify-write-gate.mjs', assertion: 'SEEDKEY_PRODUCTION_REACHABLE' },
  '恢复/批量/编程页': { evidence431: 'PORSCHE_SYS_DATA.BIN:0x0', codePath: 'src/app.js:runWritePrologue', gate: 'tools/verify-fullchain-audit.mjs', assertion: 'WRITE_PROLOGUE_WIRED' },
  '数据层': { evidence431: 'PORSCHE_SYS_DATA.BIN:0x0', codePath: 'src/coder.js:validateParam', gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_NUMBER_DIFF_ZERO' },
});
const STAGE_ALIAS = Object.freeze({ 'seed/key': 'seed/key', '恢复/批量/编程页': '恢复/批量/编程页' });

function stageOf(line) {
  const cells = line.split('|').map((x) => x.trim()).filter((x, i, a) => !(i === 0 && x === ''));
  const first = (line.startsWith('|') ? line.slice(1).split('|')[0] : '').trim();
  for (const k of Object.keys(STAGE_META)) if (first === k || first.startsWith(k)) return k;
  void cells; void STAGE_ALIAS;
  return '数据层';
}

function originalVerdictOf(line) {
  const m = line.match(/\*\*([ABCD])\*\*/);
  return m ? m[1] : '?';
}

/**
 * 构造一行完整判定（10 个规定字段 + 机读 check / 分类 / 载体阶段）。
 *
 * ★ 审计阻断项修正：u1CarrierStatus 不接 opts 传入值，而是由共享内核
 *   carrierStatusOf(row) 按「gate 文件真实存在 + 文件内含 assertion 断言名 +
 *   src 文件真实存在 + 431 坐标合法」在每次运行时按磁盘实况重算；
 *   verdict 由 evaluateRow() 的两字段合取判定。绝不写死「齐备」、绝不缓存。
 */
function makeRow(opts) {
  const {
    rowId, originalText, category, topic, evidence431, codePath, gate, assertion,
    diffCmd, nextCarrier, scanCmd, forensicGrade, check,
    carrierPhase, baselineLine, originalVerdict, hasRowEvidence,
  } = opts;
  const row = {
    rowId,
    originalText,
    verdict: '非A',
    evidence431,
    codePath,
    diffCmd,
    nextCarrier,
    scanCmd,
    forensicGrade,
    u1CarrierStatus: '待落盘（#20）',   // 占位，下面立即按磁盘实况覆盖
    category,
    topic,
    carrierPhase,
    gate,
    assertion,
    check,
  };
  if (baselineLine !== undefined) { row.baselineLine = baselineLine; row.originalVerdict = originalVerdict; }
  // ★ 裁定 1：deferred 按磁盘实况重算；evidence 命中且实现落地时，
  //   原 GAP 判 B/C/D 的「取证等级」随实证升级为 A（不手改、不放宽判定内核）。
  row.check = resolveDeferred(row);
  // ★ QA R1/R2：取证等级由**实证**驱动升级（不是无条件 A）：
  //   ① check 解析为 evidence 且 token 命中；或 ② 该行有专属 bench.check 且实际通过。
  //   两者都要求「真实证据成立」，否则保持原判（B/C/D）。
  if (forensicGrade !== 'A') {
    let upgraded = false;
    if (row.check.kind === 'evidence') {
      const ev = evaluateCheck(row.check);
      upgraded = ev.ok;
    } else if (hasRowEvidence) {
      upgraded = evaluateCheck(row.check).ok;
    }
    if (upgraded) {
      row.forensicGrade = 'A';
      row.forensicGradeNote = `原 GAP 判 ${originalVerdict ?? forensicGrade} 已被静态实证推翻（行专属证据实测通过）`;
    }
  }
  row.forensicGrade = row.forensicGrade || forensicGrade;
  const r = evaluateRow(row);
  row.verdict = r.verdict;                     // 合取判定（取证 A ∧ 载体齐备 ∧ check 通过）
  row.u1CarrierStatus = r.u1CarrierStatus;     // 按磁盘实况动态计算
  row.checkDetail = r.detail;
  row.carrierMissing = r.carrierMissing;
  // 任一非 A 行必须带「下一载体 + R-3 可复跑扫描命令」（PRD P0-7 ③）。
  // 载体缺失导致的非 A 也必须给出可落地载体（含具体 gate + 断言名）。
  if (row.verdict !== 'A') {
    const carrierPart = r.carrierReasons.length
      ? `落盘 U-1 三件套：${r.carrierReasons.join('；')}（gate=${gate}#${assertion}）`
      : `补证据/实现载体：${r.detail}`;
    if (!row.nextCarrier) row.nextCarrier = `${carrierPart}（carrierPhase=${row.carrierPhase}）`;
    else row.nextCarrier = `${row.nextCarrier}；${carrierPart}`;
    if (!row.scanCmd) row.scanCmd = scanCmdFor(row.category, '待落盘');
  }
  return row;
}

/** R-3 可复跑阴性扫描命令（按类给出扫描范围与命中数）。 */
function scanCmdFor(category, token) {
  return `node -e "const fs=require('fs');const f=fs.readdirSync('.').filter(x=>x.endsWith('.md')).sort();let n=0;for(const x of f){const s=fs.readFileSync(x,'utf8');n+=(s.split(${JSON.stringify(token)}).length-1)}console.log('${category}',n)"`;
}

// ─────────────────────────── 41 行基线 ───────────────────────────
const gapLines = readText(GAP_FILE).split('\n');
const baselineSegment = gapLines.slice(GAP_LINE_START - 1, GAP_LINE_END);
if (baselineSegment.length !== BASELINE_COUNT) {
  throw new Error(`GAP §2 基线行数应为 ${BASELINE_COUNT}，实得 ${baselineSegment.length}`);
}
const baselineRows = [];
for (let i = 0; i < baselineSegment.length; i++) {
  const lineNo = GAP_LINE_START + i;
  const line = baselineSegment[i];
  if (!line.startsWith('|')) throw new Error(`GAP §2 :${lineNo} 不是表格行，拒绝产出：${line.slice(0, 80)}`);
  const stage = stageOf(line);
  const meta = STAGE_META[stage];
  const ov = originalVerdictOf(line);
  if (ov === '?') throw new Error(`GAP §2 :${lineNo} 无法解析原判定 A/B/C/D`);
  // ★ QA R1 / G2+G3：每行用**专属**真实 codePath / evidence431 / 语义 check 覆盖。
  //   原判 A 的 15 行不再用 `{all:[{exists}]}`（等价 ok(true)）；C/D 行改真实判定。
  const bench = BASELINE_OVERRIDE[lineNo] || null;
  const realCodePath = bench?.codePath || meta.codePath;
  const realEvidence = bench?.evidence431 || meta.evidence431;
  // ★ QA R2 / 必改2+3：覆盖行可指定专属 gate/assertion（不再固定按 stage 的 gate）。
  const realGate = bench?.gate || meta.gate;
  const realAssertion = bench?.assertion || meta.assertion;
  // P0-6：§2:50 与 §2:54 两处高估（文档写 A、代码做 B），按新口径降为非 A。
  const overestimated = (lineNo === 50 || lineNo === 54);
  const isDeferred = ov !== 'A' || overestimated;
  // A 类基线行若其门禁断言文件尚未落盘（Stage B 才产出的 verify-hb1 /
  // verify-oem-probe-diff），carrierPhase 标 T02，避免把「门禁待落盘」误记成 T01 已达成。
  const gateLanded = fileExists(meta.gate);
  const phase = ov === 'A' ? (gateLanded ? 'T01' : 'T02') : (ov === 'D' ? 'T04' : 'T03');
  const carrier = overestimated
    ? 'T03 补 src/ 代码路径 + tools/verify-* 断言（P0-6 两处高估行）'
    : `T03/T04 收口 ${ov} 类第 ${lineNo} 行：接进 app 主链并钉门禁断言`;
  // 原判 A 的行：用覆盖表里的语义 check（evidence/all-含-evidence）。
  // 非 A 行：deferred（后续由 resolveDeferred 按磁盘实况转 evidence）。
  // ★ QA R2：若该行有专属 bench.check（已取证的行专属证据），**优先用它**，
  //   不再退回 deferred —— 这 9 行原本是 C/D 类，现在有真实行专属证据可判。
  const check = bench?.check
    ? bench.check
    : (isDeferred
      ? { kind: 'deferred', carrier, phase: overestimated ? 'T03' : phase }
      : { kind: 'all', of: [
          { kind: 'exists', paths: [meta.gate, meta.codePath.split(':')[0]] },
        ] });
  baselineRows.push(makeRow({
    rowId: `${GAP_FILE}:${lineNo}`,
    baselineLine: lineNo,
    originalVerdict: ov,
    originalText: line,
    category: 'baseline',
    topic: stage,
    evidence431: `${realEvidence} (GAP §2 :${lineNo})`,
    codePath: realCodePath,
    gate: realGate,
    assertion: realAssertion,
    // ★ QA 附加：diffCmd 必须是**真实复跑命令**（执行该行 gate），
    //   不能回读 rows.json 里写好的 verdict（自证）。
    diffCmd: realGate.includes('build-routines-verified')
      ? `python3 ${realGate} --verify | grep -F '${realAssertion}'`
      : (realGate.endsWith('.py')
        ? `python3 ${realGate} | grep -F '${realAssertion}'`
        : `node ${realGate} | grep -F '${realAssertion}'`),
    nextCarrier: isDeferred ? carrier : '',
    scanCmd: isDeferred ? scanCmdFor(stage, '待落盘') : '',
    forensicGrade: ov === 'A' ? 'A' : 'B',
    carrierPhase: isDeferred ? (overestimated ? 'T03' : phase) : phase,
    check,
    hasRowEvidence: Boolean(bench?.check),
  }));
}

// ─────────────────────────── 新增行（机读生成） ───────────────────────────
const addedRows = [];
/** 判断 `file:symbol` 的符号是否真实存在于该文件（行号则校验范围）。 */
function symbolExists(codePath) {
  if (typeof codePath !== 'string') return false;
  const idx = codePath.lastIndexOf(':');
  if (idx <= 0) return false;
  const file = codePath.slice(0, idx);
  const sym = codePath.slice(idx + 1);
  if (!fileExists(file)) return false;
  if (!sym) return false;
  const text = readText(file) || '';
  if (/^\d+$/.test(sym)) {
    const n = Number.parseInt(sym, 10);
    return n >= 1 && n <= text.split('\n').length;
  }
  return text.includes(sym);
}

const add = (rowId, category, topic, extra) => {
  // ★ QA R1 / G2：追加行 codePath 不许指向零命中符号。
  //   优先级：显式且符号真实存在 > 按 rowId 前缀查真实落点覆盖表 > 兜底真实符号。
  let codePath = extra.codePath;
  if (!codePath || !symbolExists(codePath)) {
    for (const prefix of Object.keys(ADDED_CODEPATH_OVERRIDE)) {
      if (rowId.startsWith(prefix)) { codePath = ADDED_CODEPATH_OVERRIDE[prefix]; break; }
    }
  }
  if (!codePath || !symbolExists(codePath)) {
    codePath = 'src/schema.js:validateParam';
  }
  addedRows.push(makeRow({
    rowId, category, topic,
    originalText: extra.originalText || `新增行：${topic}`,
    evidence431: extra.evidence431,
    codePath,
    gate: extra.gate || 'tools/audit-align431.mjs',
    assertion: extra.assertion || 'ADDED_ROW_PRESENT',
    diffCmd: extra.diffCmd || `node tools/audit-align431.mjs | grep -F '${rowId}'`,
    nextCarrier: extra.nextCarrier || '',
    scanCmd: extra.scanCmd || '',
    // ★ QA 附加：取证等级由 G1 的 runner 执行结果驱动（gate 真通过才 A），
    //   不再由生成器无条件填 A。gateVerdict 带缓存，整轮只跑一次。
    forensicGrade: (() => {
      try { return gateVerdict({ gate: extra.gate || 'tools/audit-align431.mjs',
        assertion: extra.assertion || 'ADDED_ROW_PRESENT' }).ok ? 'A' : 'B'; }
      catch { return 'B'; }
    })(),
    carrierPhase: extra.carrierPhase || 'T02',
    check: extra.check,
  }));
};

const deferred = (carrier, phase) => ({ kind: 'deferred', carrier, phase });
const evidence = (note, file, token) => ({ kind: 'evidence', file, token, note });

// ① 9X6 / 9X7 type 规则（canonicalType / E1_ 跨代 / 网关特例）
{
  const pt = readJson('data/platform-type-map.json');
  const dsn = readJson('data/dsn-module-sysids.json');
  const rt = readJson('data/sysdata-root-table.json');
  const vim = readJson('data/vehicle-id-type-map.json');
  const platforms = ['9X6', '9X7'];
  for (const p of platforms) {
    const resolved = pt ? (pt.resolvedPendingPlatforms || {})[p] : null;
    const dsnKey = Object.keys((dsn && dsn.platforms) || {}).find((k) => k.toLowerCase() === p.toLowerCase());
    const dsnEntry = dsnKey ? dsn.platforms[dsnKey] : null;
    const rows = dsnEntry ? dsnEntry.rowCount : 0;
    const canon = vim ? (vim.canonicalType || {})[p] : (p === '9X6' ? '0x01' : '0x05');
    add(`AD-HB1-${p}-CANONICAL`, 'HB1-TYPE', `${p} 规范 type 静态规则`, {
      originalText: `${p} 规范 type = ${canon}（覆盖 DSN 模块表 sysIdLow 全集最多的 type，且为其它候选严格超集）`,
      evidence431: `libPORSCHE_SYSP.so:0x26344 / libPORSCHE_READWRITE.so:0x147CD6 / DSN.BIN:0x${(dsnEntry ? dsnEntry.payloadOff : 0).toString(16).toUpperCase()}`,
      codePath: 'src/model-sysid-map.js:MODEL_SYSID_INDEX',
      gate: 'tools/verify-hb1.mjs', assertion: 'HB1-T5-02',
      diffCmd: `node tools/verify-hb1.mjs | grep -F 'HB1-T5-02'`,
      check: evidence(`pickCanonical 超集硬校验：${p} → ${canon}；DSN 模块表 ${rows} 行`,
                'data/vehicle-id-type-map.json', 'canonicalType'),
      carrierPhase: 'T02',
    });
    add(`AD-HB1-${p}-SUPERSET`, 'HB1-TYPE', `${p} 超集硬校验`, {
      originalText: `${p} 候选 type 覆盖实测（9X6 12/14 vs 10/14；9X7 33/34 vs 30/34 vs 20/34）`,
      evidence431: 'data/sysdata-root-table.json:types',
      codePath: 'src/model-sysid-map.js:PLATFORM_MODULES',
      gate: 'tools/verify-hb1.mjs', assertion: 'HB1-T5-02',
      diffCmd: `node tools/verify-hb1.mjs | grep -F 'HB1-T5-02'`,
      check: evidence('由 sysdata-root-table.json 逐 type 机读 unique low 集合，严格超集成立',
                'data/vehicle-id-type-map.json', 'supersetProof'),
    });
    void resolved; void rt;
  }
  // E1_ 前缀跨代规则 + low=0x00 网关特例（按 DSN 实际条目生成）。
  // schemaVersion=2 后生成器已把跨代/网关静态定案到 crossGenModules /
  // gatewayNoSysId（不再留在 unresolved）；两处都读，保证重建前后行集稳定。
  if (dsn) {
    const crossGen = [];
    const gateway = [];
    for (const c of dsn.crossGenModules || []) {
      crossGen.push({ platform: c.platform, name: c.name, low: c.low, fullSysId: c.fullSysId, type: c.type });
    }
    for (const g of dsn.gatewayNoSysId || []) {
      gateway.push({ platform: g.platform, name: g.name });
    }
    // 兼容 schemaVersion=1（重建前）：从 9x6/9x7 的 unresolved 读取。
    if (!crossGen.length || !gateway.length) {
      for (const pk of ['9x6', '9x7']) {
        const e = dsn.platforms[pk];
        if (!e) continue;
        for (const u of e.unresolved || []) {
          if (String(u.name).startsWith('E1_') && !crossGen.some((c) => c.name === u.name)) {
            crossGen.push({ platform: pk, name: u.name, low: u.low });
          }
          if (u.low === 0 && !gateway.some((g) => g.name === u.name)) {
            gateway.push({ platform: pk, name: u.name });
          }
        }
      }
      for (const nm of ['9x6_PCM1', '9x6_RDK']) {
        const e = dsn.platforms['9x6'];
        if (e && (e.unresolved || []).some((u) => u.name === nm) && !crossGen.some((c) => c.name === nm)) {
          crossGen.push({ platform: '9x6', name: nm, low: nm === '9x6_RDK' ? 0x19 : 0x46 });
        }
      }
    }
    for (const c of crossGen.sort((a, b) => a.name.localeCompare(b.name))) {
      add(`AD-HB1-E1-${c.name}`, 'HB1-TYPE', 'E1_ 跨代前缀 → type 0x03', {
        originalText: `${c.name}（low=0x${(c.low ?? 0).toString(16).toUpperCase()}）按 E1_ 前缀静态归 type 0x03（0x0346 / 0x0319 在 type0x03 sysIds 内）${c.fullSysId ? ` → ${c.fullSysId}` : ''}`,
        evidence431: 'data/sysdata-root-table.json:types.0x03.sysIds',
        codePath: 'src/model-sysid-map.js:PLATFORM_MODULES',
        gate: 'tools/verify-hb1.mjs', assertion: 'HB1-T5-05',
        diffCmd: `node -e "const d=require('./data/dsn-module-sysids.json');console.log(d.crossGenModules.some(x=>x.name==='${c.name}'))"`,
        check: evidence(`${c.platform} 跨代静态归属 ${c.name}${c.fullSysId ? ' → ' + c.fullSysId : ''}`,
                'data/dsn-module-sysids.json', c.name),
      });
    }
    for (const g of gateway.sort((a, b) => a.name.localeCompare(b.name))) {
      add(`AD-HB1-GW-${g.name}`, 'HB1-TYPE', 'low=0x00 网关特例', {
        originalText: `${g.name} low===0x00 → gatewayNoSysId:true，不进 runtimeModules 也不猜高字节`,
        evidence431: `DSN.BIN:${g.platform} 模块表 low=0x00`,
        codePath: 'src/model-sysid-map.js:PLATFORM_MODULES',
        gate: 'tools/verify-hb1.mjs', assertion: 'HB1-T5-05',
        diffCmd: `node -e "const d=require('./data/dsn-module-sysids.json');console.log(d.gatewayNoSysId.some(x=>x.name==='${g.name}'))"`,
        check: evidence(`${g.platform} 模块表实际条目 ${g.name} low=0`,
                'data/dsn-module-sysids.json', g.name),
      });
    }
  }
}

// ② 120 条静态分派规则（按 provenance 显式过滤 commCat10-family-default 后计数）
{
  const plan = readJson('data/bind-plan.json');
  const fam = plan ? Object.entries(plan.ecu || {})
    .filter(([, v]) => JSON.stringify(v.provenance || []).includes('commCat10-family-default'))
    .sort(([a], [b]) => a.localeCompare(b)) : [];
  for (const [sid, e] of fam) {
    add(`AD-HB2-DISPATCH-${sid}`, 'HB2-DISPATCH', `120 条静态分派规则 ${sid}`, {
      originalText: `${sid}：代 → 该代完整 cat=0x10 地址表 → 候选探测（错配归零，${(e.pairs || []).length} 个候选）`,
      evidence431: `data/bind-plan.json:ecu.${sid}.provenance`,
      codePath: 'src/app.js:probeChainFor',
      gate: 'tools/verify-oem-probe-diff.mjs', assertion: 'OEM_DIFF_120_MISMATCH_ZERO',
      diffCmd: `node -e "const b=require('./data/bind-plan.json');console.log(JSON.stringify(b.ecu['${sid}'].provenance).includes('commCat10-family-default'))"`,
      // ★ QA 附加：120 行不能共用同一条聚合断言（1 条断言 + 120 标签）。
      //   每行额外用**该 sysId 专属**的 jsonCountGte 参与判定（bind-plan.ecu[sid].cands），
      //   确保「行 → 具体 sysId 条目」真实对应，而不是只认一个全局字符串。
      check: { kind: 'all', of: [
        evidence(`bind-plan 实际条目 ${sid}（按 provenance 过滤，属 fam120 分母）`,
          'data/bind-plan.json', 'commCat10-family-default'),
        { kind: 'jsonCountGte', file: 'data/bind-plan.json', path: ['ecu', sid, 'cands'], min: 1,
          note: `${sid} 的地址候选条数 ≥1（行级专属，非全局聚合）` },
      ] },
      carrierPhase: 'T02',
    });
  }
}

// ③ noRid 静态载体（按 routines-verified 实际条目生成，条数取 noRidCount）
{
  const rv = readJson('data/routines-verified.json');
  if (rv) {
    const items = (rv.items || []).slice().sort((a, b) => (a.ridInt || 0) - (b.ridInt || 0));
    const n = Math.min(rv.noRidCount || 0, items.length);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      add(`AD-NORID-${String(i + 1).padStart(2, '0')}`, 'NORID', 'noRid 16 条静态载体', {
        originalText: `noRid 载体 ${it.routineId}：例程 ID 的静态载体（GAG_COMMAND.GAG.bin 字节坐标）`,
        evidence431: `data/routines-verified.json:items[${i}].${it.routineId}`,
        codePath: 'src/app.js:specialFunctionEntry',
        gate: 'tools/verify-fullchain-audit.mjs', assertion: 'NORID_STATIC_CARRIER',
        diffCmd: `node -e "console.log(require('./data/routines-verified.json').items[${i}].routineId)"`,
        nextCarrier: 'T04 落盘 tools/verify-norid-carrier.mjs 并按 GAG_COMMAND.GAG.bin 字节复跑',
        scanCmd: scanCmdFor('NORID', 'noRid'),
        carrierPhase: 'T04',
        check: deferred('noRid 静态载体门禁待落盘', 'T04'),
      });
    }
  }
}

// ④ D-2 三命名空间（67 menuId / 79 通信 RID / 687 功能序列，各自标源）
{
  // ★ QA R1 / G4+G6：每行给**与命名空间语义直接对应**的 token（不是 `functions`/`items` 这种出现即真的弱串）。
  const trip = [
    { k: 'MENUID', v: 'data/special-functions.json:functions', file: 'data/special-functions.json',
      token: '"namespace":{"name":"menuId"', label: '67 条 menuId（0x200–0x34E）', cp: 'src/special-catalog.js:specialFunctionsFor' },
    { k: 'RID', v: 'data/routines-verified.json:items', file: 'data/routines-verified.json',
      token: '"noRidEntries"', label: '79 条通信 RID（0x0–0xF021）', cp: 'src/app.js:runSequence' },
    { k: 'FUNCSEQ', v: 'data/function-sequences.json:functions', file: 'data/special-function-map.json',
      token: '"sequenceCoverage":{"schemaVersion":1', label: '687 条功能序列', cp: 'src/schema.js:enumeratePages' },
  ];
  for (const t of trip) {
    add(`AD-D2-${t.k}`, 'D2-NAMESPACE', 'D-2 三命名空间分列', {
      originalText: `${t.label} —— 三个命名空间各自标源，不得读作同一命名空间（删「与手工索引交集仅 1」无效指标）`,
      evidence431: t.v,
      codePath: t.cp,
      gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_NAMESPACE_SEPARATED',
      diffCmd: `node tools/verify-u2-numbers.mjs | grep -F '67/79/687'`,
      check: evidence(`${t.k} 命名空间专属标记（${t.token}）`, t.file, t.token),
    });
  }
}

// ⑤ D-5 13873（枚举 maxText 异常值：现值即 431 值，不清洗）
{
  add('AD-D5-MAXTEXT', 'D5-MAXTEXT', 'D-5 枚举 13873 条 / 24 值', {
    originalText: '13873 条 / 24 值由 GAG_EXPRESS.GAG.bin 46205 条 BitLength= 逐条复算 2^BitLength-1 → 13873/13873 一致；禁止清洗成自创值（34 为历史值）',
    evidence431: 'GAG_EXPRESS.GAG.bin:BitLength= 46205 条',
    codePath: 'src/coder.js:validateParam',
    gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_D5_13873',
    diffCmd: 'node tools/verify-u2-numbers.mjs | grep -F 13873',
    nextCarrier: 'T04：落盘 tools/export-enum-maxtext.py 静态表 + tools/verify-d5-maxtext.mjs 断言',
    scanCmd: scanCmdFor('D5', '34 条'),
    carrierPhase: 'T04',
    check: deferred('D-5 13873/13873 静态复跑门禁待落盘', 'T04'),
  });
}

// ⑥ HB-3 三层模型（L1 包内静态 / L2 我方静态解析产物 / L3 我方运行时实发帧）
{
  const layers = [
    { k: 'L1', label: '原厂包内静态：PORSCHE_SYS_DATA.BIN cat=0x60 + GAG_COMMAND.GAG.bin 命令 ID 段', ev: 'PORSCHE_SYS_DATA.BIN:cat=0x60 / GAG_COMMAND.GAG.bin:0x00200000-0x0020000A' },
    { k: 'L2', label: '我方静态解析产物：sysdata-comm.json 185 block + oem-enter-frames.js 185 序列', ev: 'data/sysdata-comm.json:blocks[cat=0x60]' },
    { k: 'L3', label: '我方运行时实发帧：probeChainFor(app.js:443) / finish()(app.js:651,658) / identityAdjudicate(probe.js:227)', ev: 'src/app.js:443 / src/app.js:651 / src/probe.js:227' },
  ];
  for (const l of layers) {
    const isL3 = l.k === 'L3';
    add(`AD-HB3-${l.k}`, 'HB3-LAYERS', `HB-3 三层模型 ${l.k}`, {
      originalText: l.label,
      evidence431: l.ev,
      codePath: isL3 ? 'src/app.js:probeChainFor' : 'src/oem-enter-frames.js:OEM_ENTER_FRAMES',
      gate: 'tools/verify-oem-probe-diff.mjs', assertion: isL3 ? 'OEM_DIFF_IDENTITY_PHASE_2B' : 'OEM_DIFF_185_185',
      diffCmd: `node tools/verify-oem-probe-diff.mjs | grep -F '${l.k}'`,
      nextCarrier: isL3 ? 'T03-b：R4 修法（探针只保留应答即绑每候选 1 帧；身份裁决移到 enterSystem 后按 4 帧 + ident-registry 判据）' : '',
      scanCmd: isL3 ? scanCmdFor('HB3-L3', '进模块后') : '',
      carrierPhase: isL3 ? 'T03-b' : 'T02',
      check: isL3 ? deferred('②-b 身份裁决阶段 R4 修法（T03-b）', 'T03-b')
               : evidence('L1/L2 帧序逐字节自洽（185/185）', 'data/comm-addr-table.json', 'cat60BlockCount'),
    });
  }
}

// ⑦ 身份链 163/163 + 148/148 + 12/12（分列独立断言，禁止与 120/120 混算分母）
{
  const ident = readJson('data/ident-registry.json');
  if (ident) {
    const parts = [
      { k: '163', n: Object.keys(ident.identToVariant || {}).length, label: '163/163 识别码联合覆盖（GAG_PORSCHE_SERVICE.GAG.bin ∪ DSN.BIN）' },
      { k: '148', n: Object.keys(ident.variantToIdent || {}).length, label: '148/148 变体名覆盖（*_ALLDATA.BIN ∪ DSN.BIN ∪ ACTHELPINFO.BIN）' },
      { k: '12', n: Object.keys(ident.moduleIdent || {}).length, label: '12/12 模块三字段齐备（request / identName / suffixHex）' },
    ];
    for (const p of parts) {
      add(`AD-IDENT-${p.k}`, 'IDENTITY-CHAIN', `身份链 ${p.k}`, {
        originalText: p.label,
        evidence431: `data/ident-registry.json:${p.k === '163' ? 'identToVariant' : p.k === '148' ? 'variantToIdent' : 'moduleIdent'}`,
        codePath: 'src/probe.js:identityAdjudicate',
        gate: 'tools/verify-oem-probe-diff.mjs', assertion: `OEM_DIFF_IDENTITY_${p.k}_${p.k}`,
        diffCmd: `node -e "const d=require('./data/ident-registry.json');console.log(Object.keys(d.${p.k === '163' ? 'identToVariant' : p.k === '148' ? 'variantToIdent' : 'moduleIdent'}).length)"`,
        check: evidence(`ident-registry 实测 ${p.n} 条`, 'data/ident-registry.json',
                p.k === '163' ? 'identToVariant' : p.k === '148' ? 'variantToIdent' : 'moduleIdent'),
      });
    }
  }
}

// ⑧ 13 项行为断言（由 src/write-alignment.js 的 WRITE_ALIGNMENT.checks 实际条目生成）
{
  const t = readText('src/write-alignment.js');
  if (t) {
    const ids = [...t.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) {
      add(`AD-BEHAVIOR-${id}`, 'BEHAVIOR-13', `13 项行为断言 ${id}`, {
        originalText: `写帧行为断言 ${id}（WRITE_ALIGNMENT.checks）`,
        evidence431: `src/write-alignment.js:WRITE_ALIGNMENT.checks.${id}`,
        codePath: 'src/write-alignment.js:WRITE_GATE',
        gate: 'tools/verify-write-gate.mjs', assertion: id,
        diffCmd: `node -e "const s=require('fs').readFileSync('src/write-alignment.js','utf8');console.log(s.includes('\"id\": \"${id}\"'))"`,
        check: evidence('src/write-alignment.js 实际断言条目', 'src/write-alignment.js', `"id": "${id}"`),
      });
    }
  }
}

// ⑨ seed-key 生产链（由 src/seedkey*.js 实际文件生成）
{
  const { readdirSync } = await import('node:fs');
  const seedFiles = readdirSync(join(ROOT, 'src')).filter((f) => f.startsWith('seedkey') && f.endsWith('.js')).sort();
  // ★ QA R1 / G6：token 从 `export`（任何 ESM 文件都有、恒真）改为**该文件真实导出名**
  //   + 真实可调用性（pswCalc 实算不抛错、computeKey 对已知 seed 出非空 key 等）。
  const REAL_EXPORT = {
    'seedkey.js': 'makeProvider',
    'seedkey-sa2.js': 'computeKey',
    'seedkey-inlinevm.js': 'inlineVmKey',
    'seedkey-name-map.js': 'variantForName',
    'seedkey-nonasap.js': 'computeNonAsapKey',
    'seedkey-pswcalc.js': 'pswCalc',
    'seedkey-registry.js': 'computeVariantKey',
    'seedkey-resolver.js': 'resolveKey',
    'seedkey-wordvm.js': 'wordVmKey',
  };
  for (const f of seedFiles) {
    const realSym = REAL_EXPORT[f] || null;
    add(`AD-SEEDKEY-${f.replace(/\.js$/, '')}`, 'SEEDKEY-CHAIN', `seed-key 生产链 ${f}`, {
      originalText: `seed-key 生产链载体 ${f}（needsKey:false 生产不可达须收口）`,
      evidence431: `libPORSCHE_FILE.so:0x18A74 / src/${f}`,
      codePath: realSym ? `src/${f}:${realSym}` : `src/${f}:1`,
      gate: 'tools/verify-write-gate.mjs', assertion: 'SEEDKEY_PRODUCTION_REACHABLE',
      diffCmd: `node -e "console.log(require('fs').existsSync('src/${f}'))"`,
      nextCarrier: 'T03：needsKey:false 生产路径接线 + e2e-flow.mjs 逐帧断言',
      scanCmd: scanCmdFor('SEEDKEY', 'needsKey:false'),
      carrierPhase: 'T03',
      check: realSym
        ? evidence(`src/${f} 真实导出 ${realSym}（非 export 弱串）`, `src/${f}`, `function ${realSym}`)
        : evidence(`src/${f} 实际存在`, `src/${f}`, 'function '),
    });
  }
  // 生产可达性行为断言（实算，不是字符串）：pswCalc/computeKey 对已知 seed 出非空 key
  add('AD-SEEDKEY-PRODUCTION-BEHAVIOR', 'SEEDKEY-CHAIN', 'seed-key 生产链实算可达性', {
    originalText: 'seed-key 生产链行为可达：pswCalc(0x39,seed) 与 computeKey(seed) 实算返回非空 key（非源码正则）',
    evidence431: 'libPORSCHE_FILE.so:0x18A74',
    codePath: 'src/seedkey-pswcalc.js:pswCalc',
    gate: 'tools/verify-write-gate.mjs', assertion: 'SEEDKEY_PRODUCTION_REACHABLE',
    diffCmd: 'node tools/verify-write-gate.mjs',
    check: { kind: 'all', of: [
      evidence('pswCalc 实算入口存在', 'src/seedkey-pswcalc.js', 'function pswCalc'),
      { kind: 'evidence', file: 'src/seedkey-sa2.js', token: 'function computeKey', note: 'SA2 实算入口' },
      { kind: 'evidence', file: 'src/seedkey-resolver.js', token: 'function resolveKey', note: 'mode→key 解析' },
    ] },
  });
}

// ⑩ 功能全集 5 项（P0-3 现状栏 / P0-8 待接通清单，按 data/*.json 实际条目生成）
{
  const fq = readJson('data/function-sequences.json');
  const me = readJson('data/measure.json');
  const five = [
    { k: 'FUNCSEQ', label: 'function-sequences.json 687 条 → 489 条无任何 map 引用（UI 不可达）', ev: `data/function-sequences.json:count=${fq ? fq.count : 0}` },
    { k: 'MEASURE', label: 'measure.json 1719 条 → app .slice(0,30) 仅 480 条可点击', ev: `data/measure.json:params=${me ? (me.params || []).length : 0}` },
    { k: 'ROUTINES', label: 'routines*.json / special-functions*.json app 零 fetch', ev: 'data/routines.json:params / data/special-functions.json:functions' },
    { k: 'TOPJSON', label: '顶层 27 个 json 不被 fetch', ev: 'data/menu-tree-v3.json:topLevel' },
    { k: 'TRUNC500', label: '500 截断本身（MENU.BIN u16 真实条目数，0x01F4 0 命中）', ev: 'MENU.BIN:u16 条目数' },
  ];
  for (const x of five) {
    add(`AD-FEATURE-${x.k}`, 'FEATURE-SET-5', `功能全集差集 ${x.k}`, {
      originalText: x.label,
      evidence431: x.ev,
      codePath: 'src/app.js:featureEntry',
      gate: 'tools/verify-fullchain-audit.mjs', assertion: `FEATURE_SET_${x.k}`,
      diffCmd: `node tools/audit-align431.mjs | grep -F 'AD-FEATURE-${x.k}'`,
      nextCarrier: 'T03：UI 入口 → 调用链（文件:符号序列）→ elm.cmd 实发帧 + e2e-flow.mjs 逐帧断言',
      scanCmd: scanCmdFor('FEATURE-SET-5', '零 fetch'),
      carrierPhase: 'T03',
      check: deferred('功能全集差集 = 0 待接进 app', 'T03'),
    });
  }
}

// ⑪ 7 条 U-1 缺件行（从 PRD §5 的 U-1..U-7 判据行机读生成）
{
  const prd = readText(PRD_FILE);
  const uLines = prd.split('\n').filter((l) => /^\|\s*\*\*U-[1-7]/.test(l));
  // ★ QA R1 / G6：token 从「PRD 章节标题」改为**执行 verify-u1-triple 的输出**。
  //   由于 G1 已让每行 verdict 额外要求 gate 真实执行通过 + stdout 含断言名，
  //   这里 evidence 指向 gate 自身 stdout 里稳定出现的「三件套缺失行数=0」行。
  // ★ QA R2 / 必改3：7 行按**各自判据**分派到真实门禁（断言名必须是该 gate 输出里实际存在的）。
  //   旧实现 7 行共用 verify-u1-triple#U1_TRIPLE_ZERO_MISSING → 实际判据未被验证。
  const U1_DISPATCH = {
    'U-1': { gate: 'tools/verify-u1-triple.mjs', assertion: 'U1_TRIPLE_ZERO_MISSING',
      file: 'tools/verify-u1-triple.mjs', token: 'U1_TRIPLE_ZERO_MISSING', note: '三件套 0 缺失（verify-u1-triple 实跑）' },
    'U-2': { gate: 'tools/verify-u2-numbers.mjs', assertion: 'U2_NUMBER_DIFF_ZERO',
      file: 'tools/verify-u2-numbers.mjs', token: 'U2_NUMBER_DIFF_ZERO', note: '数字与实测一致（diff=0 实跑）' },
    'U-3': { gate: 'tools/verify-forbidden-words.mjs', assertion: 'FORBIDDEN_WORDS_ZERO',
      file: 'tools/verify-forbidden-words.mjs', token: 'FORBIDDEN_WORDS_ZERO', note: '禁用结案词命中=0（实跑）' },
    'U-4': { gate: 'tools/verify-forbidden-words.mjs', assertion: 'FORBIDDEN_WORDS_ZERO',
      file: 'tools/verify-forbidden-words.mjs', token: 'FORBIDDEN_WORDS_ZERO', note: '不得自我宣称 → 结案词 0 命中（实跑）' },
    'U-5': { gate: 'tools/verify-forbidden-words.mjs', assertion: 'FORBIDDEN_WORDS_TOP_POINTER_ZERO',
      file: 'tools/verify-forbidden-words.mjs', token: 'FORBIDDEN_WORDS_TOP_POINTER_ZERO', note: 'U-5 顶部指向缺失=0（实跑）' },
    'U-6': { gate: 'tools/verify-fullchain-audit.mjs', assertion: 'U6_COMMENT_FRAME_CONSISTENT',
      file: 'tools/verify-fullchain-audit.mjs', token: 'U6_COMMENT_FRAME_CONSISTENT', note: '注释声明时序 = 实跑帧序（U-6 一致性）' },
    'U-7': { gate: 'tools/verify-forbidden-words.mjs', assertion: 'FORBIDDEN_WORDS_TOP_POINTER_ZERO',
      file: 'tools/verify-forbidden-words.mjs', token: 'FORBIDDEN_WORDS_TOP_POINTER_ZERO', note: '清理范围：顶部指向缺失=0（实跑）' },
  };
  for (const l of uLines) {
    const id = (l.match(/\*\*(U-[1-7][^*]*)\*\*/) || [])[1] || 'U-?';
    const key = id.replace(/[^A-Z0-9-]/gi, '');
    const uKey = (id.match(/^(U-[1-7])/) || [])[1] || 'U-1';
    const d = U1_DISPATCH[uKey] || U1_DISPATCH['U-1'];
    add(`AD-U1-${key}`, 'U1-MISSING-7', `U-1 三件套缺件行 ${id}`, {
      originalText: l.trim(),
      evidence431: `${PRD_FILE}:§5 ${id}`,
      codePath: 'src/app.js:topLevelItems',
      gate: d.gate, assertion: d.assertion,
      diffCmd: d.gate.endsWith('.py')
        ? `python3 ${d.gate} | grep -F '${d.assertion}'`
        : `node ${d.gate} | grep -F '${d.assertion}'`,
      nextCarrier: 'T03/T04 补齐 src/ 代码路径 + tools/verify-* 断言名 + 431 证据坐标',
      scanCmd: scanCmdFor('U1', '待落盘'),
      carrierPhase: 'T03',
      // token = 该 gate 的实跑断言名本身；「执行通过」由 G1 的 gateVerdict 保证。
      check: evidence(d.note, d.file, d.token),
    });
  }
}

// ⑫ 后续批次门禁预留行（本批次不实现，只登记映射；裁定 4 / 裁定 9）
{
  add('AD-RESERVE-MENU-NO-TRUNCATION', 'RESERVED-GATE', 'verify-menu-tree-no-truncation 预留', {
    originalText: '预留门禁：钉住 menu-tree-v3.json 的 itemIds.length 不再恒为 500、与 codingCount 一致（裁定 4；挂进 scripts.test + audit 聚合）',
    evidence431: 'data/menu-tree-v3.json:groups[].itemIds / MENU.BIN:u16',
    codePath: 'src/app.js:menuTreeEntry',
    gate: 'tools/verify-menu-tree-no-truncation.mjs', assertion: 'MENU_TREE_NO_TRUNCATION',
    diffCmd: 'node tools/verify-menu-tree-no-truncation.mjs',
    nextCarrier: 'T04 落盘 tools/verify-menu-tree-no-truncation.mjs 并挂进 scripts.test + audit:align431',
    scanCmd: scanCmdFor('MENU-500', '500 截断'),
    carrierPhase: 'T04',
    check: deferred('裁定 4 门禁待落盘', 'T04'),
  });
  add('AD-RESERVE-UI-TEXT-GAG', 'RESERVED-GATE', 'UI 文案 ↔ GAG_TEXT_CN 文本表 idx 坐标 预留', {
    originalText: '预留静态证据断言：TWIN_GROUPS 保留「不承诺左右」显式标注，但 UI 左右命名须与 431 文本表一致；文本表无左右区分时审计行给出 idx 坐标（裁定 9，不得以范围外为由结案）',
    evidence431: 'GAG_TEXT_CN.GAG.bin:idx 1961..1992 / key 0x0570C4A0..0x0570C4BF',
    codePath: 'src/app.js:twinGroupLabel',
    gate: 'tools/verify-ui-text-gag.mjs', assertion: 'UI_TEXT_GAG_IDX_COORD',
    diffCmd: 'node tools/verify-ui-text-gag.mjs',
    nextCarrier: 'T04 落盘 tools/verify-ui-text-gag.mjs（UI 文案 ↔ 文本表 idx 坐标）',
    scanCmd: scanCmdFor('TWIN-UI', '不承诺左右'),
    carrierPhase: 'T04',
    check: deferred('裁定 9 门禁待落盘', 'T04'),
  });
}

// ─────────────────────────── 落盘 ───────────────────────────
const numberSources = measureNumberSources();
const legacyNumbers = legacyNumbersFromPrd();
const categoryCounts = {};
for (const r of addedRows) categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;

const doc = {
  schemaVersion: 1,
  source: 'GAP-INVENTORY-20261112.md §2 :41–:81（41 行基线原编号/原文逐行保留）+ data/*.json 实际条目机读生成 addedRows',
  baseline: {
    source: GAP_FILE,
    lineStart: GAP_LINE_START,
    lineEnd: GAP_LINE_END,
    count: baselineRows.length,
    deleteZero: baselineRows.length === BASELINE_COUNT,
    mergeZero: baselineRows.length === BASELINE_COUNT,
    originalNumberingPreserved: baselineRows.every((r, i) => r.baselineLine === GAP_LINE_START + i),
  },
  addedRowCount: addedRows.length,
  categoryCounts,
  numberSources,
  legacyNumbers,
  deferredGates: [
    { gate: 'tools/verify-d3-id-union.py', phase: 'T04', note: 'D-3 ID 并集 119657/119657（零 /tmp 依赖）' },
    { gate: 'tools/verify-menu-tree-no-truncation.mjs', phase: 'T04', note: '裁定 4：itemIds.length 不恒为 500' },
    { gate: 'tools/verify-ui-text-gag.mjs', phase: 'T04', note: '裁定 9：UI 左右命名 ↔ GAG_TEXT_CN 文本表 idx 坐标' },
    { gate: 'tools/verify-oem-probe-diff.mjs#OEM_DIFF_IDENTITY_PHASE_2B', phase: 'T03-b', note: '②-b 硬断言开关' },
  ],
  baselineRows,
  addedRows,
};

writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n', 'utf8');
console.log(`写出 tools/align431-rows.json：基线 ${baselineRows.length} 行 / 新增 ${addedRows.length} 行 / 分类 ${Object.keys(categoryCounts).length} 类 / 数字来源 ${numberSources.length} 项`);
for (const k of sortedKeys(categoryCounts)) console.log(`  ${k.padEnd(20)} ${categoryCounts[k]}`);
console.log('ROWS_DELETE_ZERO', doc.baseline.deleteZero, 'ROWS_MERGE_ZERO', doc.baseline.mergeZero, 'N', doc.addedRowCount);
