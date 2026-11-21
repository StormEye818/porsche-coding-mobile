#!/usr/bin/env node
/**
 * align431-eval.mjs — 「全链路字节级对齐 参考诊断仪」确定性审计求值内核（共享模块）。
 *
 * 被以下入口复用，保证「同一份证据、同一套判定」：
 *   tools/build-align431-rows.mjs  生成 tools/align431-rows.json
 *   tools/audit-align431.mjs       逐行审计 + sha256 + 退出码
 *   tools/verify-forbidden-words.mjs / verify-u1-triple.mjs / verify-u2-numbers.mjs
 *
 * 确定性纪律（PRD §3 P0-7 / §7 T2）：
 *   - 无 Date / Math.random / process.cwd / 绝对路径输出；
 *   - 所有遍历一律 Object.keys().sort()；
 *   - 只读仓库内相对路径文件，不写任何文件；
 *   - 所有计数由实际条目机读得出，禁止手填常数。
 *
 * 用法：本模块只导出函数与常量，不直接执行。
 */
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * 仓库根（仅内部使用；绝不出现在审计输出里）。
 *
 * T04 注入自检：允许通过 `ALIGN431_ROOT_OVERRIDE` 把同一套只读求值指向
 * 临时镜像（软链接 + 少量覆写文件），从而**不改真实仓库**即可验证 gate 会转红。
 * 正常执行（含 npm test / audit）该变量未设置，行为与原来逐字节一致。
 */
const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_ROOT = process.env.ALIGN431_ROOT_OVERRIDE || '';
export const ROOT = ENV_ROOT && existsSync(ENV_ROOT) ? join(ENV_ROOT, '.') : REAL_ROOT;

/** 权威文档文件名（相对仓库根），按 Q4 / U-7 的「本轮 6 份基线文档 + 现行 PRD」。 */
export const PRD_FILE = 'PRD-FULLALIGN-43\u0031-20261113.md';
export const GAP_FILE = 'GAP-INVENTORY-20261112.md';
export const CURRENT_SCOPE_DOCS = Object.freeze([
  'AUDIT-20261112.md',
  'B-TO-A-CLOSURE-20261112.md',
  GAP_FILE,
  'ACCEPTANCE-MATRIX.md',
  PRD_FILE,
  'RE-GAPVERIFY-20261112.md',
  'TAKEOVER.md',
]);

/** §0 不可协商前提列出的 10 类禁用结案词（原文分类 → 可机读的等价表述）。 */
export const FORBIDDEN_CLASSES = Object.freeze({
  '包内不存在': ['包内不存在', '包内无', '包里没有', '包内静态零调用点', '包内不可证'],
  '需要真车测试': ['需要真车测试', '需要真车', '需真车', '需实车', '实车 VIN 日志', '真车确认'],
  '运行时态无法静态复刻': ['运行时态无法静态复刻', '运行时态', '运行时 BV 域'],
  '43\u0031 同界': ['43\u0031 同界', '43\u0031同界'],
  '适配器能力差异': ['适配器能力差异', '适配器差异'],
  '有意偏离': ['有意偏离', '有意边界'],
  '结果由 ECU 裁决': ['结果由 ECU 裁决', '结果由ECU裁决', '由 ECU 裁决'],
  '源包限制': ['源包限制', '源包数据量'],
  '承诺外': ['承诺外'],
  '留白证据级': ['留白证据级', '留白 3 项', '精确留白'],
});

/** 否定 / 推翻 / 待挖线索标记：同行命中即不是「作为结案理由」（PRD U-3、R-3）。 */
export const OVERTURN_MARKERS = Object.freeze([
  '推翻', '已推翻', '禁止', '不得', '禁用', '历史', '旧结论', '旧值', '快照', '非缺口',
  '不适用', '一律', '失效', '作废', '误判', '误读', '更正', '保留作', '不再作为', '仅作',
  '并非', '不构成', '不作为', '已收口', '取证层', '旧判据', '待落盘', '不能当结论',
  '当前 B', '当前非 A', '待 #20', '待挖', '下一载体', '扫描命令', 'R-3', '不猜',
  '不瞎猜', '未证', '已证', '反证', '阴性', '零命中', '驳回', '不接受', '而不是',
  '被标', '现状', '错', '误', '待改', '引用', '须消除', '冲突', '统一到', '改为',
  '已更正', '已对齐', '已修', '已落地', '复跑', '沿革', '沿革', '基线', '当时',
]);

/** PRD 内「清单 / 禁令 / 判据」引用标记（这些行是在列举禁用词，不是在结案）。 */
export const PRD_QUOTATION_MARKERS = Object.freeze([
  '一律', '不得', '禁用', '结案词', 'R-4', 'U-3', '§0', '不可协商前提', '禁止',
  '引用旧值', '历史值', '须消除', '已知冲突', 'U-2', 'P0-6',
]);

/** U-5 顶部指向标记（用于单独统计「被推翻文档顶部指向缺失数」，不并入结案词命中）。 */
export const TOP_POINTER_MARKERS = Object.freeze([
  '历史快照', '已被推翻', '保留作', '不再作为', '以 `', '为准', '当前状态以',
  '历史资料', '旧覆盖率', '顶部核验标注', '以本 PRD', '现行',
]);

/** 读取仓库内相对路径文本；不存在返回 null（调用方负责判定）。 */
export function readText(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** 读取仓库内相对路径 JSON；不存在返回 null。 */
export function readJson(rel) {
  const t = readText(rel);
  return t === null ? null : JSON.parse(t);
}

/** 文件是否存在。 */
export function fileExists(rel) {
  return existsSync(join(ROOT, rel));
}

/** 稳定的键序遍历。 */
export function sortedKeys(obj) {
  return Object.keys(obj || {}).sort();
}

/* ──────────────────────────────────────────────────────────────────
 * T04 · 双举证机读底座
 *
 * 所有求值都接受可选 `ctx`（仅注入自检使用）：
 *   ctx.json   = {'<repo-rel-path>': object}      内存覆写 JSON
 *   ctx.text   = {'<repo-rel-path>': string}      内存覆写文本
 *   ctx.vectors= {vectorId: vectorObject}         内存覆写向量
 *   ctx.e2eStdout = string                        内存模拟 e2e 实跑输出
 * 未传 ctx 时全部走磁盘，结果与 T01-T03 完全一致。
 * ────────────────────────────────────────────────────────────────── */
/** E0 原始包根（从仓库相对位置推导，绝不写进输出）。 */
export const E0_ROOT = join(REAL_ROOT, '..', 'porsche-mapper', 'ref');
/** 纳管向量目录（相对仓库根）。 */
export const VECTOR_DIR = 'tools/align431-vectors';
/** ★ 阶段 E：强制纳管的 7 组回放向量（mustReplay:true，缺一不可）。 */
export const VECTOR_IDS = Object.freeze([
  'REPLAY_DME', 'REPLAY_IC', 'REPLAY_718', 'REPLAY_PSM', 'REPLAY_BCM',
  'REPLAY_REALCAR981_BCM', 'REPLAY_SIM991_IC',
]);
/** 参考诊断仪证据台账（T01）。 */
export const REGISTRY_FILE = 'data/align431-evidence-registry.json';
/** e2e 向量纳管执行器（T04）。 */
export const E2E_GATE = 'e2e-flow.mjs';

const E0_CACHE = new Map();

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 带 ctx 覆写的 JSON 读取（只读，不修改入参）。 */
export function readJsonCtx(rel, ctx) {
  if (hasOwn(ctx?.json, rel)) return ctx.json[rel];
  if (ctx?.root) {
    const p = join(ctx.root, rel);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }
  return readJson(rel);
}

/** 带 ctx 覆写的文本读取。 */
export function readTextCtx(rel, ctx) {
  if (hasOwn(ctx?.text, rel)) return ctx.text[rel];
  if (ctx?.root) {
    const p = join(ctx.root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  return readText(rel);
}

/** 规范化 sha256（与 sha256() 同一算法，便于 ctx 内比较）。 */
export const digest = sha256;

/** E0 坐标形状 + 回指原始文件/offset/VA/record 校验（不执行 reproduceCmd）。 */
export function e0CoordShape(entry) {
  const c = entry?.e0Coord;
  if (!c || typeof c.file !== 'string' || !c.file.trim()) {
    return { ok: false, detail: 'E0 缺 file' };
  }
  if (/(?:^|[/\\])(?:\.\.)(?:[/\\]|$)|^(?:\/|[A-Za-z]:[\\/])/.test(c.file)) {
    return { ok: false, detail: 'E0 file 越出仓库/含绝对路径' };
  }
  const hasOffset = Number.isInteger(c.offset) && c.offset >= 0;
  const hasVA = typeof c.VA === 'string' && /^0x[0-9a-fA-F]+$/.test(c.VA)
    && Number.parseInt(c.VA.slice(2), 16) > 0;
  const hasRecord = typeof c.recordId === 'string' && c.recordId.trim().length > 0;
  if (!hasOffset && !hasVA && !hasRecord) {
    return { ok: false, detail: 'E0 缺 offset/VA/recordId 或为 0 占位' };
  }
  if (!c.detail || String(c.detail).trim().length === 0) {
    return { ok: false, detail: 'E0 缺 detail（无法回指做法）' };
  }
  return {
    ok: true,
    locator: hasOffset ? `offset=${c.offset}` : hasVA ? `VA=${c.VA}` : `record=${c.recordId}`,
    detail: `${c.file}:${hasOffset ? c.offset : hasVA ? c.VA : c.recordId}`,
  };
}

/** 执行 registry 的 reproduceCmd，返回稳定 stdout digest；同一命令进程内只跑一次。 */
export function reproduceE0(entry, ctx) {
  const shape = e0CoordShape(entry);
  if (!shape.ok) return { ok: false, detail: shape.detail };
  if (entry.status !== 'verified') {
    return { ok: false, detail: `E0 ${entry.evidenceId} 未 verified（fail-closed）` };
  }
  const cmd = entry.reproduceCmd;
  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    return { ok: false, detail: 'E0 reproduceCmd 缺失' };
  }
  const key = `${digest(cmd)}|${entry.evidenceId}`;
  if (E0_CACHE.has(key)) return E0_CACHE.get(key);
  let result;
  try {
    const stdout = execFileSync('sh', ['-c', cmd], {
      cwd: ctx?.root || ROOT,
      env: { ...process.env, E0_ROOT, LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = { ok: true, digest: digest(stdout), detail: `${shape.detail} reproduce=exit0 diff=空` };
  } catch (error) {
    result = { ok: false, detail: `${shape.detail} reproduce≠0（status=${typeof error.status === 'number' ? error.status : 1}）` };
  }
  E0_CACHE.set(key, result);
  return result;
}

/**
 * `e0CoordVector`：registry 中存在 + 坐标合法 + reproduceCmd exit 0 + digest 与生成器钉住的期望相等。
 * `expectDigest` 省略时只要求复算成功（仍要求 registry 坐标真实）。
 */
export function evaluateE0Vector(spec, ctx) {
  if (!spec || !spec.evidenceId) return { ok: false, detail: 'e0CoordVector 缺 evidenceId' };
  const registry = readJsonCtx(REGISTRY_FILE, ctx);
  if (!registry || !Array.isArray(registry.entries)) {
    return { ok: false, detail: 'registry 不可读' };
  }
  const entry = registry.entries.find((e) => e.evidenceId === spec.evidenceId);
  if (!entry) return { ok: false, detail: `registry 无 ${spec.evidenceId}` };
  const r = reproduceE0(entry, ctx);
  if (!r.ok) return r;
  if (spec.expectDigest && spec.expectDigest !== r.digest) {
    return { ok: false, detail: `${spec.evidenceId} 复算摘要≠钉住值（${r.digest.slice(0, 12)}…）` };
  }
  return { ok: true, evidenceId: spec.evidenceId, digest: r.digest,
    detail: `${spec.evidenceId} ${r.detail}` };
}

/**
 * ★ 阶段 E：向量摘要分别钉住 expected / replay / sourceLog 三份文件。
 *
 * `expectedSha256` / `replaySha256` 是**文件字节摘要**（不是重组后的 payload 摘要），
 * `sourceLogSha256` 钉住人工语义来源（实车原始日志或既有五组的来源说明）。
 * 旧的单文件 `{vectorId,expected,replay}` 摘要口径已被三摘要取代：
 * 改 expected 或 replay 任一个字节而不更新对应 sha → 本摘要与 readVector() 立即转红。
 */
export function vectorDigest(v) {
  const expectedSha256 = v.expectedSha256 || digest(JSON.stringify(v.expected || []));
  const replaySha256 = v.replaySha256 || digest(JSON.stringify(v.replay || []));
  const sourceLogSha256 = v.sourceLogSha256 || '';
  return digest(JSON.stringify({
    vectorId: v.vectorId, expectedSha256, replaySha256, sourceLogSha256,
  }));
}

/** 路径必须在允许的目录内，防止 manifest 指向仓库外的任意文件。 */
function allowedVectorPath(rel, id, suffix) {
  if (typeof rel !== 'string' || !rel || /(?:^|[/\\])(?:\.\.)(?:[/\\]|$)|^(?:\/|[A-Za-z]:[\\/])/.test(rel)) {
    return false;
  }
  if (suffix === 'source') {
    return rel === `${VECTOR_DIR}/${id}.source.json`
      || /^docs\/realcar\/[^/\\]+\.(txt|log)$/.test(rel);
  }
  return rel === `${VECTOR_DIR}/${id}.${suffix}.json`;
}

/**
 * ★ 阶段 E：从磁盘（或 ctx 覆写）加载 manifest + expected + replay + sourceLog，
 * 逐字节校验三份摘要，再组装成共享内核沿用的 `{expected, replay}` 形状。
 * expected 与 replay 不再共存于同一份权威 JSON：manifest 只存路径与摘要。
 */
export function loadVectorPayload(vectorId, ctx) {
  if (!vectorId) return { ok: false, detail: 'runtimeProbeVector 缺 vectorId' };
  const manifestRel = `${VECTOR_DIR}/${vectorId}.json`;
  const manifestText = readTextCtx(manifestRel, ctx);
  if (manifestText === null) return { ok: false, detail: `向量未纳管：${manifestRel}` };
  let m;
  try { m = JSON.parse(manifestText); } catch { return { ok: false, detail: `向量 manifest JSON 损坏：${manifestRel}` }; }
  const shape = validateVector(m, vectorId);
  if (!shape.ok) return shape;
  if (m.mustReplay !== true) {
    return { ok: false, detail: `${vectorId} mustReplay≠true（未强制纳管）` };
  }
  if (!allowedVectorPath(m.expectedFile, vectorId, 'expected')
      || !allowedVectorPath(m.replayFile, vectorId, 'replay')
      || !allowedVectorPath(m.sourceLogFile, vectorId, 'source')) {
    return { ok: false, detail: `${vectorId} expected/replay/sourceLog 路径非法` };
  }
  const expectedText = readTextCtx(m.expectedFile, ctx);
  const replayText = readTextCtx(m.replayFile, ctx);
  const sourceText = readTextCtx(m.sourceLogFile, ctx);
  if (expectedText === null || replayText === null || sourceText === null) {
    return { ok: false, detail: `${vectorId} expected/replay/sourceLog 缺文件` };
  }
  if (digest(expectedText) !== m.expectedSha256) {
    return { ok: false, detail: `${vectorId} expected 字节摘要不符（改帧序未更新 expectedSha256）` };
  }
  if (digest(replayText) !== m.replaySha256) {
    return { ok: false, detail: `${vectorId} replay 字节摘要不符（改应答未更新 replaySha256）` };
  }
  if (digest(sourceText) !== m.sourceLogSha256) {
    return { ok: false, detail: `${vectorId} sourceLog 字节摘要不符（语义来源被改）` };
  }
  let expectedDoc;
  let replayDoc;
  try { expectedDoc = JSON.parse(expectedText); } catch { return { ok: false, detail: `${vectorId} expected JSON 损坏` }; }
  try { replayDoc = JSON.parse(replayText); } catch { return { ok: false, detail: `${vectorId} replay JSON 损坏` }; }
  const frames = expectedDoc?.frames;
  const steps = replayDoc?.steps;
  if (!Array.isArray(frames) || frames.length === 0 || !frames.every((f) => typeof f === 'string' && f.trim())) {
    return { ok: false, detail: `${vectorId} expected.frames 非法` };
  }
  if (!Array.isArray(steps) || steps.length === 0
      || !steps.every((s) => s && typeof s.req === 'string' && typeof s.resp === 'string')) {
    return { ok: false, detail: `${vectorId} replay.steps 非法` };
  }
  const vector = {
    ...m,
    expected: frames,
    replay: steps,
    failureAssertion: m.failureAssertion || null,
  };
  if (m.sha256 && m.sha256 !== vectorDigest(vector)) {
    return { ok: false, detail: `${vectorId} 向量总摘要不符（三份摘要与钉住值不一致）` };
  }
  return { ok: true, vector, expectedText, replayText, sourceText };
}

/** 读取并校验纳管向量（E1 一律 sampleOnly，禁止泛化全代）。 */
export function readVector(vectorId, ctx) {
  if (!vectorId) return { ok: false, detail: 'runtimeProbeVector 缺 vectorId' };
  if (hasOwn(ctx?.vectors, vectorId)) {
    const v = ctx.vectors[vectorId];
    const shape = validateVector(v, vectorId);
    if (!shape.ok) return shape;
    // ★ 阶段 D1：内存覆写的向量同样受钉住摘要约束（例：把 replay 改成全 NO DATA
    //   而不改 sha256 必须转红）。应答真值只从 e2e stdout 取，这里的摘要只是
    //   「向量文件未被篡改」的负向校验，不是应答举证。
    if (v.sha256 && v.sha256 !== vectorDigest(v)) {
      return { ok: false, detail: `${vectorId} 内存覆写向量摘要不符（replay 被改但 sha256 未更新）` };
    }
    return { ok: true, vector: v };
  }
  return loadVectorPayload(vectorId, ctx);
}

function validateVector(v, expectedId) {
  if (!v || typeof v.vectorId !== 'string' || !v.vectorId
      || (expectedId && v.vectorId !== expectedId)) {
    return { ok: false, detail: '向量缺 vectorId 或与文件名不符' };
  }
  const composed = Array.isArray(v.expected) && Array.isArray(v.replay);
  if (composed) {
    if (v.expected.length === 0 || v.replay.length === 0) {
      return { ok: false, detail: `${v.vectorId} expected/replay 为空` };
    }
  } else if (typeof v.expectedFile !== 'string' || typeof v.replayFile !== 'string'
      || typeof v.sourceLogFile !== 'string'
      || !/^[0-9a-f]{64}$/.test(v.expectedSha256 || '')
      || !/^[0-9a-f]{64}$/.test(v.replaySha256 || '')
      || !/^[0-9a-f]{64}$/.test(v.sourceLogSha256 || '')) {
    return { ok: false, detail: `${v.vectorId} manifest 缺 expectedFile/replayFile/sourceLogFile 或三份摘要` };
  }
  if (v.sampleOnly !== true || v.grade !== 'R' || v.provable !== 'runtime') {
    return { ok: false, detail: `${v.vectorId} E1/E2 样本未标 sampleOnly+grade:R+provable:runtime` };
  }
  if (typeof v.diffCmd !== 'string' || !v.diffCmd || !v.injection || typeof v.injection !== 'object') {
    return { ok: false, detail: `${v.vectorId} 缺 diffCmd/injection 反例` };
  }
  return { ok: true };
}

/**
 * ★ 阶段 D1：应答举证只认 e2e **真执行 stdout**，不再把向量 replay JSON 文本当应答。
 *
 * 证据优先级（逐条从 stdout 取，绝不读 v.replay.resp 作为正响应）：
 *   ① `VECTOR_ANSWER <id> ...` —— 新增的实际应答行（若 e2e 后续补发）；
 *   ② `VECTOR_DUMP <id> actual=[...]` —— e2e 现有 ALIGN431_VECTOR_DUMP=1 的真实帧 dump；
 *   ③ `VECTOR <id> frames=n diff=[]` —— e2e 真执行输出：diff 由实发帧与 expected 逐帧比对
 *      得出，frames>0 且 diff=[] 证明该 replay 脚本被 Coder 真正消费并发完 n 帧。
 * 缺 VECTOR 行一律返回空数组（删除该行 → 应答不成立，可证伪）。
 *
 * 兼容说明：`vectorAnswers(v)` 不传 stdout 的旧签名只服务 build 期快照
 * （tools/build-align431-rows.mjs 不可改）；审计 / QA / 注入路径一律传 stdout。
 */
export function vectorAnswers(v, stdout) {
  if (typeof stdout === 'string') return vectorAnswersFromStdout(v, stdout);
  // 仅 build 期生成 rows.json 快照使用；不得在审计/QA 中作为应答举证。
  return (v?.replay || []).filter((x) => x && x.resp && String(x.resp).trim() !== 'NO DATA');
}

/** 从 e2e stdout 提取某向量的 live 应答证明条目（每项含 source，便于审计自证来源）。 */
export function vectorAnswersFromStdout(v, stdout) {
  const id = v?.vectorId;
  if (!id || typeof stdout !== 'string') return [];
  const lines = stdout.split('\n');
  const vectorLine = lines.find((l) => l.startsWith(`VECTOR ${id} `));
  if (!vectorLine) return [];
  const framesM = /\bframes=(\d+)\b/.exec(vectorLine);
  if (!framesM) return [];
  const frames = Number(framesM[1]);
  if (!(frames > 0) || !/\bdiff=\[\]/.test(vectorLine)) return [];
  // 帧数与向量 expected 长度不一致时不给应答举证（防止拼接的假 stdout）。
  if (Array.isArray(v.expected) && v.expected.length && frames !== v.expected.length) return [];

  const answerLines = lines.filter((l) => l.startsWith(`VECTOR_ANSWER ${id} `)
    && !/NO DATA/.test(l));
  if (answerLines.length) {
    return answerLines.map((line, i) => ({ source: 'VECTOR_ANSWER', frame: `answer-${i + 1}` }));
  }
  const dumpLine = lines.find((l) => l.startsWith(`VECTOR_DUMP ${id} `));
  if (dumpLine) {
    const m = /actual=(\[[^\n]*\])/.exec(dumpLine);
    if (m) {
      try {
        const actual = JSON.parse(m[1]);
        if (Array.isArray(actual) && actual.length) {
          return actual.map((frame, i) => ({ source: 'VECTOR_DUMP', frame: `frame-${i + 1}:${String(frame)}` }));
        }
      } catch { /* dump 损坏则落到 VECTOR 行证据 */ }
    }
  }
  return Array.from({ length: frames }, (_, i) => ({ source: 'VECTOR', frame: `frame-${i + 1}` }));
}

/** 向量声明全 NO DATA 的负向断言（不是应答举证；举证仍只来自 e2e stdout）。 */
function vectorDeclaresAllNoData(v) {
  const replay = Array.isArray(v?.replay) ? v.replay : [];
  return replay.length > 0 && replay.every((x) => !x || !x.resp || String(x.resp).trim() === 'NO DATA');
}

/**
 * `runtimeProbeVector`：向量在册 + 摘要一致 + 帧序 diff=空 + e2e stdout 实跑应答举证。
 * 默认把 e2e-flow.mjs 真跑一次（runGate 缓存），从 stdout 取 VECTOR / VECTOR_ANSWER / VECTOR_DUMP。
 * 注入自检可传 ctx.e2eStdout 用内存输出替代，避免真跑。
 */
export function evaluateRuntimeVector(spec, ctx) {
  if (!spec || !spec.vectorId) return { ok: false, detail: 'runtimeProbeVector 缺 vectorId' };
  const got = readVector(spec.vectorId, ctx);
  if (!got.ok) return got;
  const v = got.vector;
  const vDigest = vectorDigest(v);
  if (spec.expectDigest && spec.expectDigest !== vDigest) {
    return { ok: false, detail: `${v.vectorId} 向量摘要≠钉住值` };
  }
  if (vectorDeclaresAllNoData(v)) {
    return { ok: false, detail: `${v.vectorId} 向量声明全 NO DATA：零运行时应答不得标 A` };
  }
  if (spec.consumedSource !== false && !ctx?.e2eStdout) {
    const src = readTextCtx(E2E_GATE, ctx) || '';
    if (!src.includes(`loadVector('${v.vectorId}').replay`)
        || !src.includes('E2E_VECTOR_DIFF_EMPTY')) {
      return { ok: false, detail: `${v.vectorId} 未接进 e2e 执行面（向量在门禁外）` };
    }
  }
  let stdout = ctx?.e2eStdout;
  if (typeof stdout !== 'string') {
    const run = runGate(E2E_GATE);
    if (!run.executable || run.exitCode !== 0) {
      return { ok: false, detail: `e2e 门禁未通过（exit=${run.exitCode}）` };
    }
    stdout = run.stdout;
  }
  const answers = vectorAnswersFromStdout(v, stdout);
  if (spec.requireAnswer !== false && answers.length === 0) {
    return { ok: false, detail: `${v.vectorId} e2e stdout 无 live 应答举证（VECTOR/VECTOR_ANSWER 缺失或 diff≠空）` };
  }
  const line = stdout.split('\n').find((l) => l.startsWith(`VECTOR ${v.vectorId} `));
  if (!line || !/\bdiff=\[\]/.test(line) || !/\bframes=\d+/.test(line)) {
    return { ok: false, detail: `${v.vectorId} 实发/期望 diff≠空：${(line || '').slice(0, 120)}` };
  }
  return { ok: true, vectorId: v.vectorId, answers: answers.length,
    answerSource: answers[0]?.source || '-', digest: vDigest,
    detail: `${v.vectorId} 帧序 diff=空 live应答=${answers.length} 来源=${answers[0]?.source || '-'} sampleOnly=${v.sampleOnly}` };
}

/**
 * ★ 阶段 D1：rows 快照（symbolHitOnly / runtimeAnswerBacked / sampleGeneralized /
 * e0Coord.reproduceDigest / vector expectDigest）与 live 重算值**任一不一致即非 A**。
 * ctx.live 由 liveFactsForRow() 从当前 E0 复算 + e2e stdout 真执行结果构造。
 */
export function snapshotMismatchOf(row, live) {
  const mm = [];
  if (!live || typeof live !== 'object') return mm;
  const boolPairs = [
    ['symbolHitOnly', 'symbolHitOnly'],
    ['runtimeAnswerBacked', 'runtimeAnswerBacked'],
    ['sampleGeneralized', 'sampleGeneralized'],
  ];
  for (const [k, snapshotKey] of boolPairs) {
    if (typeof live[k] !== 'boolean') continue;
    if ((row?.[snapshotKey] === true) !== live[k]) mm.push(`${snapshotKey}:快照=${row?.[snapshotKey] === true}live=${live[k]}`);
  }
  if (typeof live.e0Digest === 'string' && live.e0Digest
      && typeof row?.e0Coord?.reproduceDigest === 'string' && row.e0Coord.reproduceDigest
      && live.e0Digest !== row.e0Coord.reproduceDigest) {
    mm.push('e0Coord.reproduceDigest');
  }
  if (typeof live.vectorDigest === 'string' && live.vectorDigest) {
    const expected = findCheckValue(row?.check, 'runtimeProbeVector', 'expectDigest');
    if (typeof expected === 'string' && expected && expected !== live.vectorDigest) {
      mm.push('vectorDigest');
    }
  }
  return mm;
}

/** 在 check 描述符树中找第一个指定 kind 的字段值。 */
function findCheckValue(check, kind, field) {
  if (!check || typeof check !== 'object') return undefined;
  if (check.kind === kind && check[field] !== undefined) return check[field];
  if (check.kind === 'all') {
    for (const c of (check.of || [])) {
      const v = findCheckValue(c, kind, field);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * `provableTag`：静态/运行时标注与证据级别一致；E1 样本不得泛化全代；
 * 运行时行必须有应答举证且不得把 CAN 静态写死。
 * 有 ctx.live 时一律用 live 值覆盖 row 快照，并校验快照与 live 一致（不一致 → 非 A）。
 */
export function evaluateProvableTag(row, ctx) {
  const p = row?.provable;
  if (p !== 'static' && p !== 'runtime') {
    return { ok: false, detail: `缺 provable 标注（${p}）` };
  }
  const live = (ctx?.live && typeof ctx.live === 'object') ? ctx.live : {};
  const liveMode = Object.keys(live).length > 0;
  const mm = snapshotMismatchOf(row, liveMode ? live : null);
  if (mm.length) {
    return { ok: false, detail: `live 重算与 rows 快照不一致：${mm.join(', ')}`, snapshotMismatch: mm };
  }
  const symbolHit = typeof live.symbolHitOnly === 'boolean' ? live.symbolHitOnly : row?.symbolHitOnly === true;
  const answerBacked = typeof live.runtimeAnswerBacked === 'boolean'
    ? live.runtimeAnswerBacked : row?.runtimeAnswerBacked === true;
  const generalized = typeof live.sampleGeneralized === 'boolean'
    ? live.sampleGeneralized : row?.sampleGeneralized === true;
  if (symbolHit) {
    return { ok: false, detail: '仅符号命中不得判 A（live 重算）' };
  }
  if (row?.runtimeRequired === true) {
    if (row.planSysId === null) {
      return { ok: false, detail: 'planSysId=null 静默兜底：fail-closed，不得标 A' };
    }
    if (p !== 'runtime') return { ok: false, detail: '运行时语义行标成 static（runtime 静态写死）' };
    if (!answerBacked) {
      return { ok: false, detail: '运行时语义行零应答举证（live e2e stdout）' };
    }
  }
  if (row?.vectorId) {
    const got = readVector(row.vectorId, ctx);
    if (!got.ok) return got;
    if (got.vector.sampleOnly === true && generalized) {
      return { ok: false, detail: 'E1 样本被泛化为全代真值' };
    }
    if (got.vector.hardcodedCan === true) {
      return { ok: false, detail: '向量把 CAN 静态写死' };
    }
  }
  return { ok: true, liveMode: liveMode ? 1 : 0, snapshotMismatch: mm,
    detail: `provable=${p} runtimeAnswerBacked=${answerBacked} symbolHitOnly=${symbolHit} liveMode=${liveMode ? 1 : 0}` };
}

/**
 * `NO_ASSERTION_DELETED`：行断言清单与生成器钉住的摘要一致，且每行 gate/assertion 非空。
 * 注入自检通过 ctx.rows 覆写当前行集；审计传磁盘行集。
 */
export function assertionIntegrity(rows, recorded, ctx) {
  const list = Array.isArray(rows) ? rows : [];
  const pairs = list.map((r) => `${r.rowId}=${r.assertion || ''}`).sort();
  const current = digest(pairs.join('\n'));
  const expected = recorded?.sha256;
  const ok = list.length > 0 && list.every((r) => typeof r.gate === 'string' && r.gate
      && typeof r.assertion === 'string' && r.assertion.trim().length > 0)
    && (!expected || current === expected);
  return { ok, count: list.length, sha256: current,
    detail: ok ? `NO_ASSERTION_DELETED 断言 ${list.length} 条完整` : '断言清单被改/删除或存在空断言' };
}

/** 列出仓库根全部 .md（排序，确定性）。 */
export function markdownFiles() {
  return readdirSync(ROOT)
    .filter((f) => f.endsWith('.md') && statSync(join(ROOT, f)).isFile())
    .sort();
}

/**
 * **入库** .md 清单（`git ls-files '*.md'` 与仓库根实存取交集）。
 *
 * 为什么需要它（2026-11-17 实测）：`markdownFiles()` 扫的是**本机**根目录全部 .md。
 * 本地 60 份、干净 clone 18 份 —— 差的 42 份是被 `.gitignore` 排除的调研文档。
 * 而这份扫描的计数会**进审计的 sha256**，sha256 的用途是「换机器/换人可对照」；
 * 输入集随机器变，指纹就没有对照价值（实测同一 commit：本地 `7dc49fe0…`、clone `231c0a49…`，
 * diff 只差 20 行、全部来自这里）。
 *
 * 非 git 环境降级为「全部本地 .md」，并**显式返回 degraded** —— 绝不静默降级，
 * 否则「机器相关」这件事又变成没人看得见。
 *
 * @returns {{files: string[], tracked: boolean, ignoredCount: number, degraded: boolean}}
 */
export function markdownFilesTracked() {
  const all = markdownFiles();
  try {
    const out = execFileSync('git', ['ls-files', '--', '*.md'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tracked = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
    // git ls-files 会给出子目录路径；扫描口径只认仓库根（与 markdownFiles 一致）
    const files = all.filter((f) => tracked.has(f));
    return { files, tracked: true, ignoredCount: all.length - files.length, degraded: false };
  } catch {
    return { files: all, tracked: false, ignoredCount: 0, degraded: true };
  }
}

/**
 * 按 PRD §0 / U-3 / U-7 / Q4 分类扫描全库 .md 中 10 类禁用结案词。
 * 返回 { files, raw, byClass, buckets, asClosingReason, closingHits, topPointerMissing }。
 *
 * 分类优先级（先命中先归类，互斥）：
 *   1 PRD 清单/禁令引用          —— PRD 中列举禁用词、R-4/U-3/§0 判据的行；
 *   2 41 行基线原文              —— GAP §2 :41–:81（Q1 强制逐行原样保留，非现行结论）；
 *   3 已推翻/否定/待挖线索引用   —— 同行带 OVERTURN_MARKERS（U-3：作为待挖线索合法）；
 *   4 Q4 范围外历史取证文档      —— 6 份基线文档以外的历史文件（Q4：不必逐字清洗）；
 *   5 现行结案理由               —— 其余（6 份基线文档中被推翻但未带否定标记的旧结论，
 *                                  按 U-5/U-7 记为「待补顶部指向」，不计入结案词命中）。
 *
 * 「作为结案理由命中」只统计 PRD（现行权威文档）中未被 1/3 归类的行；
 * 历史基线文档的旧结论按 U-5 单列 topPointerMissing，供 T03/T04 收口。
 */
export function scanForbiddenWords() {
  const byClass = {};
  for (const k of sortedKeys(FORBIDDEN_CLASSES)) byClass[k] = 0;
  const buckets = {
    'PRD 清单/禁令引用': 0,
    '41 行基线原文(Q1 强制保留)': 0,
    '已推翻/否定/待挖线索引用': 0,
    'Q4 范围外历史取证文档': 0,
    'U-5/U-7 历史基线旧结论(待补顶部指向)': 0,
    '现行结案理由': 0,
  };
  const closingHits = [];
  let raw = 0;
  // ★ 扫描集 = **入库** .md（换机器可对照）；非 git 环境降级并标记，不静默降级。
  const scanSet = markdownFilesTracked();
  const files = scanSet.files;

  for (const f of files) {
    const lines = readText(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hits = [];
      for (const cls of sortedKeys(FORBIDDEN_CLASSES)) {
        for (const w of FORBIDDEN_CLASSES[cls]) {
          if (line.includes(w)) { hits.push(cls); byClass[cls] += 1; break; }
        }
      }
      if (!hits.length) continue;
      raw += hits.length;
      const lineNo = i + 1;
      let bucket;
      if (f === PRD_FILE && PRD_QUOTATION_MARKERS.some((m) => line.includes(m))) {
        bucket = 'PRD 清单/禁令引用';
      } else if (f === GAP_FILE && lineNo >= 41 && lineNo <= 81) {
        bucket = '41 行基线原文(Q1 强制保留)';
      } else if (OVERTURN_MARKERS.some((m) => line.includes(m))) {
        bucket = '已推翻/否定/待挖线索引用';
      } else if (!CURRENT_SCOPE_DOCS.includes(f)) {
        bucket = 'Q4 范围外历史取证文档';
      } else if (f !== PRD_FILE) {
        bucket = 'U-5/U-7 历史基线旧结论(待补顶部指向)';
      } else {
        bucket = '现行结案理由';
      }
      buckets[bucket] += hits.length;
      if (bucket === '现行结案理由') {
        closingHits.push(`${f}:${lineNo} [${hits.join(',')}] ${line.trim().slice(0, 160)}`);
      }
    }
  }

  // U-5：6 份基线文档 + 现行 PRD 之外的历史文档不检查；基线文档须有顶部指向。
  const topPointerMissing = [];
  for (const f of CURRENT_SCOPE_DOCS.filter((x) => x !== PRD_FILE)) {
    const t = readText(f);
    if (t === null) continue;
    const head = t.split('\n').slice(0, 16).join('\n');
    if (!TOP_POINTER_MARKERS.some((m) => head.includes(m))) topPointerMissing.push(f);
  }

  return {
    files: files.length,
    // ★ 扫描集来源必须随结果一起返回：调用方要把它打印出来，
    //   否则「本机 60 份 / clone 18 份」这种机器相关性没人看得见。
    scanTracked: scanSet.tracked,
    scanIgnoredCount: scanSet.ignoredCount,
    scanDegraded: scanSet.degraded,
    raw,
    byClass,
    buckets,
    asClosingReason: closingHits.length,
    closingHits: closingHits.sort(),
    topPointerMissing: topPointerMissing.sort(),
  };
}

/**
 * 求值单条 check 描述符（全部纯只读，确定性）。
 * 支持 kind：
 *   exists         {paths:[rel...]}                     全部存在 → A
 *   includes       {file, tokens:[...]}                全部命中 → A
 *   excludes       {file, tokens:[...]}                全不命中 → A
 *   jsonEquals     {file, path:[...], value}           相等 → A
 *   jsonCountEq    {file, path:[...], value}           数组/对象条目数相等 → A
 *   jsonCountGte   {file, path:[...], min}             条目数 ≥ min → A
 *   all            {of:[check...]}                     全部 A → A
 *   deferred       {carrier, phase}                    永远非 A（T03/T04 待落地）
 *   evidence       {verified:true, note}               由生成器实测标记（等价于已复跑）
 *   e0CoordVector  {evidenceId, expectDigest}          E0 坐标在册 + reproduceCmd 复算 diff=空
 *   runtimeProbeVector {vectorId, expectDigest, requireAnswer}
 *                                                      纳管向量在册 + e2e 帧序 diff=空 + 应答举证
 *   provableTag    {row}                               provable/E1 样本/符号命中一致性
 */
export function evaluateCheck(check, ctx) {
  if (!check || !check.kind) return { ok: false, detail: 'check 描述符缺失' };
  const miss = (rel) => `缺失文件 ${rel}`;
  switch (check.kind) {
    case 'exists': {
      const bad = (check.paths || []).filter((p) => !fileExists(p));
      return { ok: bad.length === 0, detail: bad.length ? bad.map(miss).join('; ') : `${(check.paths || []).length} 个载体齐备` };
    }
    case 'includes': {
      const t = readText(check.file);
      if (t === null) return { ok: false, detail: miss(check.file) };
      const bad = (check.tokens || []).filter((x) => !t.includes(x));
      return { ok: bad.length === 0, detail: bad.length ? `未命中 token: ${bad.join(', ')}` : `${(check.tokens || []).length} 个 token 全部命中` };
    }
    case 'excludes': {
      const t = readText(check.file);
      if (t === null) return { ok: false, detail: miss(check.file) };
      const bad = (check.tokens || []).filter((x) => t.includes(x));
      return { ok: bad.length === 0, detail: bad.length ? `仍存在禁用 token: ${bad.join(', ')}` : `${(check.tokens || []).length} 个 token 全部清除` };
    }
    case 'jsonEquals':
    case 'jsonCountEq':
    case 'jsonCountGte': {
      const d = readJson(check.file);
      if (d === null) return { ok: false, detail: miss(check.file) };
      let cur = d;
      for (const k of check.path || []) cur = cur == null ? undefined : cur[k];
      if (check.kind === 'jsonEquals') {
        const ok = JSON.stringify(cur) === JSON.stringify(check.value);
        return { ok, detail: ok ? `= ${JSON.stringify(cur)}` : `实得 ${JSON.stringify(cur)} ≠ 期望 ${JSON.stringify(check.value)}` };
      }
      const n = (cur && typeof cur === 'object') ? Object.keys(cur).length : (Array.isArray(cur) ? cur.length : 0);
      if (check.kind === 'jsonCountEq') {
        return { ok: n === check.value, detail: `计数 ${n} ${n === check.value ? '=' : '≠'} ${check.value}` };
      }
      return { ok: n >= check.min, detail: `计数 ${n} ${n >= check.min ? '≥' : '<'} ${check.min}` };
    }
    case 'all': {
      // ★ 阶段 D1：保留每个子结果（含 kind），供 live 事实自证；不新增任何放行分支。
      const rs = (check.of || []).map((c) => ({ ...evaluateCheck(c, ctx), kind: c.kind }));
      const bad = rs.filter((r) => !r.ok);
      return { ok: bad.length === 0, subResults: rs,
        detail: bad.length ? bad.map((r) => r.detail).join('; ') : `${rs.length} 项子检查全通过` };
    }
    case 'e0CoordVector':
      return evaluateE0Vector(check, ctx);
    case 'runtimeProbeVector':
      return evaluateRuntimeVector(check, ctx);
    case 'provableTag':
      return evaluateProvableTag(check, ctx);
    case 'deferred':
      return { ok: false, detail: `待 ${check.phase} 落地：${check.carrier}` };
    case 'evidence': {
      // 「已实测」不再是自证的布尔标记：必须给出真实文件 + 真实 token 并命中。
      if (!check.file || !check.token) return { ok: false, detail: 'evidence 缺 file/token（禁止自证）' };
      const t = readText(check.file);
      if (t === null) return { ok: false, detail: miss(check.file) };
      const ok = t.includes(check.token);
      return { ok, detail: ok ? `证据 ${check.file} 命中 ${check.token}` : `证据 ${check.file} 未命中 ${check.token}` };
    }
    default:
      return { ok: false, detail: `未知 check.kind=${check.kind}` };
  }
}

/* ──────────────────────────────────────────────────────────────────
 * ★ QA R1 / G1：门禁**真实执行器**（此前审计只查「文件存在 + 文本含断言名」，
 *   对真实回归零敏感度 —— 把写帧改错后 audit 仍全 A）。
 *
 * 每个 gate 一次审计内**只跑一次**（按 gate 名缓存），237 行共享结果。
 * 只采集两个稳定量：退出码 + stdout 是否含该行 assertion（易变内容如耗时/
 * 绝对路径不进审计正文），保证连续两次输出 sha256 相同。
 *
 * 拒绝「无执行器」的 gate：未登记的 gate 一律判不可执行（非 A），不许静默放行。
 * ────────────────────────────────────────────────────────────────── */
const GATE_TIMEOUT_MS = 180000;
const GATE_CACHE = new Map();

/** gate 路径 → 执行命令。返回 null 表示该 gate 没有登记执行器（判不可执行）。 */
function runnerFor(gate) {
  if (typeof gate !== 'string') return null;
  // 特例先于后缀分派：build-routines-verified.py 必须带 --verify 子命令才是门禁。
  if (gate === 'tools/build-routines-verified.py') {
    return { cmd: 'python3', args: [gate, '--verify'] };
  }
  if (gate.endsWith('.py')) return { cmd: 'python3', args: [gate] };
  if (gate.endsWith('.mjs')) return { cmd: 'node', args: [gate] };
  return null;
}

/**
 * 真实运行一个 gate 并缓存（一次进程内按 gate 名唯一）。
 * @returns {{executable:boolean, exitCode:number|null, stdout:string, timedOut:boolean}}
 */
export function runGate(gate, runnerOverride) {
  const key = runnerOverride ? `${gate}::${runnerOverride.cmd}::${runnerOverride.args.join(' ')}` : gate;
  if (GATE_CACHE.has(key)) return GATE_CACHE.get(key);
  const runner = runnerOverride || runnerFor(gate);
  if (!runner) {
    const r = { executable: false, exitCode: null, stdout: '', timedOut: false, preconditionMissing: false };
    GATE_CACHE.set(key, r);
    return r;
  }
  let exitCode = null;
  let stdout = '';
  let timedOut = false;
  try {
    // ★ QA R3 / 问题2：gate 必须**串行 + 环境无关**执行。
    //   execFileSync 天然串行（阻塞），但要把环境钉死，避免同一 gate 在
    //   「单独跑 vs audit 内跑」表现不同：
    //   · TZ/LANG/LC_ALL 固定 → 任何本地化/时区敏感断言不抖；
    //   · NO_COLOR / FORCE_COLOR=0 → 去掉 ANSI 转义，stdout 断言稳定；
    //   · ALIGN431_T03B 显式='1' → 显式固定 oem-probe-diff 的硬断言开关，
    //     不让调用方 shell 里的诊断回退变量把门禁悄悄降级；
    //   · NODE_OPTIONS 清空 → 不让外部注入的 --experimental-* 等改变行为；
    //   · TMPDIR 指向每个 gate 独立临时目录 → 杜绝 gate 之间共享临时文件。
    const gateTmp = join(tmpdir(), 'align431-gate', String(process.pid), gate.replace(/[^\w.-]+/g, '_'));
    try { mkdirSync(gateTmp, { recursive: true }); } catch { /* 已存在 */ }
    const deterministicEnv = {
      ...process.env,
      TZ: 'UTC',
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ALIGN431_T03B: '1',
      NODE_OPTIONS: '',
      TMPDIR: gateTmp,
      TEMP: gateTmp,
      TMP: gateTmp,
    };
    stdout = execFileSync(runner.cmd, runner.args, {
      cwd: ROOT,
      env: deterministicEnv,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: GATE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exitCode = 0;
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1;
    stdout = String(e.stdout || '');
    if (e.signal === 'SIGTERM' || /ETIMEDOUT|timed? ?out/i.test(String(e.message))) timedOut = true;
  }
  // ★ 退出码 2 是**前置未满足**（例：`www/` 未构建 → verify-www-data-identical 退出 2），
  //   必须与「跑完了但内容不一致」分开：
  //     · 前置未满足 → 先跑构建（npm run sync），不是代码缺陷；
  //     · 内容不一致（exit 1） → 真回归，去查代码。
  //   混进同一个「非 A」会让审计把「没构建」读成「有缺陷」，而处置方向完全相反。
  //   ⚠️ 仍然 ok:false、仍然非 A、仍然非 0 —— 不因为「只是没构建」就放绿。
  const r = {
    executable: true,
    exitCode,
    stdout,
    timedOut,
    preconditionMissing: exitCode === 2,
  };
  GATE_CACHE.set(key, r);
  return r;
}

/** 清空门禁执行缓存（生成器每次重算前调用，保证跨运行不复用陈旧结果）。 */
export function clearGateCache() {
  GATE_CACHE.clear();
  // 清理本次进程创建的 gate 临时目录（每个 gate 一个，杜绝跨 gate 共享临时状态）
  try { rmSync(join(tmpdir(), 'align431-gate', String(process.pid)), { recursive: true, force: true }); }
  catch { /* 不存在或不可删则忽略 */ }
}

/**
 * 该行门禁是否**真实通过**：可执行 + 退出码 0 + stdout 含断言名 + 未 timeout。
 * 返回 {ok, detail, exitCode}；detail 只含稳定量（退出码 / 命中布尔），
 * 不含 gate stdout 原文，保证审计输出确定性。
 */
export function gateVerdict(row) {
  const gate = row.gate;
  const assertion = row.assertion;
  const spec = row.gateRunner || null;
  const run = runGate(gate, spec);
  if (!run.executable) {
    return { ok: false, exitCode: null, preconditionMissing: false, detail: `门禁无执行器（未登记 ${gate}）` };
  }
  if (run.timedOut) {
    return { ok: false, exitCode: run.exitCode, preconditionMissing: false, detail: `gate timeout（exit=${run.exitCode}）` };
  }
  // ★ 前置未满足（exit 2）：独立状态，措辞必须让读者去做构建，而不是去查代码。
  if (run.preconditionMissing) {
    return {
      ok: false,
      exitCode: 2,
      preconditionMissing: true,
      detail: 'gate 退出码=2（前置未满足，未判内容 —— 需先 npm run sync，非内容缺陷）',
    };
  }
  const hit = typeof assertion === 'string' && assertion.trim() !== '' && run.stdout.includes(assertion);
  const ok = run.exitCode === 0 && hit;
  return {
    ok,
    exitCode: run.exitCode,
    preconditionMissing: false,
    detail: `gate 退出码=${run.exitCode} 断言名命中=${hit}`,
  };
}

/**
 * U-1 三件套载体真实状态（PRD §5 U-1 / §7 T4；团队审计阻断项修正）。
 *
 * 严禁用字符串形状冒充载体存在：
 *   - gate 必须是真实存在的 tools/verify-* 文件（fs.existsSync），且文件内
 *     确实含 row.assertion 断言名（Node .includes()）；
 *   - codePath 必须是 src/ 路径且该 src 文件真实存在；
 *   - evidence431 必须是合法 <file>:<offset|VA|recordId> 坐标。
 *
 * 返回 { status:'齐备'|'待落盘（#20）', missing:string[], reasons:string[] }。
 * 每次调用都按磁盘实况重算，绝不缓存；门禁落盘后自动转「齐备」。
 */
export function carrierStatusOf(row) {
  const missing = [];
  const reasons = [];
  const codePath = row.codePath;
  // ★ QA R1 / G2：codePath 不止查文件存在，还要查**符号/行号真实存在**。
  //   形如 `src/x.js:Symbol` → 符号须在文件文本内出现；`src/x.js:123` → 行号须在
  //   文件行数范围内。零命中的符号名（如旧 audit 的 identMatch@variant.js）一律判缺。
  if (typeof codePath !== 'string' || !codePath.startsWith('src/')) {
    missing.push('src代码路径');
    reasons.push('codePath 缺失或非 src/ 路径');
  } else {
    const idx = codePath.lastIndexOf(':');
    const srcFile = idx > 0 ? codePath.slice(0, idx) : codePath;
    const sym = idx > 0 ? codePath.slice(idx + 1) : '';
    if (!fileExists(srcFile)) {
      missing.push('src代码路径文件');
      reasons.push(`src 文件不存在 ${srcFile}`);
    } else if (!sym) {
      missing.push('src符号缺失');
      reasons.push(`codePath 缺符号/行号 ${codePath}`);
    } else {
      const text = readText(srcFile) || '';
      if (/^\d+$/.test(sym)) {
        const lineNo = Number.parseInt(sym, 10);
        const lineCount = text.split('\n').length;
        if (!(lineNo >= 1 && lineNo <= lineCount)) {
          missing.push('src行号越界');
          reasons.push(`codePath 行号 ${lineNo} 超出 ${srcFile} 行数 ${lineCount}`);
        }
      } else if (!text.includes(sym)) {
        missing.push('src符号不存在');
        reasons.push(`符号 ${sym} 不存在于 ${srcFile}`);
      }
    }
  }
  const gate = row.gate;
  const assertion = row.assertion;
  // 合法 gate = tools/verify-* 或 tools/build-routines-verified.py（后者带 --verify 子命令，
  // 是 PRD §5 U-1 三件套认可的生成期门禁；D2_RID_79_79 / D2_NAMESPACE_CLEAN 在其中）。
  const GATE_OK = (g) => typeof g === 'string'
    && (g.startsWith('tools/verify-') || g === 'tools/build-routines-verified.py');
  if (!GATE_OK(gate)) {
    missing.push('门禁断言名');
    reasons.push('gate 路径缺失或非 tools/verify-* / build-routines-verified.py 路径');
  } else if (!fileExists(gate)) {
    missing.push('门禁文件');
    reasons.push(`门禁未落盘 ${gate}`);
  } else {
    const gateText = readText(gate) || '';
    if (typeof assertion !== 'string' || !assertion.trim() || !gateText.includes(assertion)) {
      missing.push('门禁断言名');
      reasons.push(`断言名 ${JSON.stringify(assertion)} 不存在于 ${gate}`);
    }
  }
  // ★ QA R1 / G2：参考诊断仪坐标不许用 `PORSCHE_SYS_DATA.BIN:0x0` 这类占位冒充。
  //   合法 = `<file>:<非0 offset|recordId|range>`；`:0x0`/`:0`/`:0X0` 判非法。
  if (typeof row.evidence431 !== 'string' || !/^[^:\s]+:[^:\s]+/.test(row.evidence431)) {
    missing.push('43\u0031证据坐标');
    reasons.push('evidence参考诊断仪坐标非法');
  } else if (/:0[xX]?0+\b/.test(row.evidence431)) {
    missing.push('43\u0031证据坐标占位');
    reasons.push(`evidence431 用了 :0x0 占位（${row.evidence431}）`);
  }
  return {
    status: missing.length === 0 ? '齐备' : '待落盘（#20）',
    missing,
    reasons,
  };
}

/** 只保留指定 kind 的 check 子树（live 事实求值时跳过 provableTag，避免自指）。 */
function filterChecksByKind(check, kinds) {
  if (!check || typeof check !== 'object') return null;
  if (kinds.includes(check.kind)) return check;
  if (check.kind === 'all') {
    const of = (check.of || []).map((c) => filterChecksByKind(c, kinds)).filter(Boolean);
    return of.length ? { kind: 'all', of } : null;
  }
  return null;
}

/** 递归收集 evaluateCheck 结果树里带 kind 的子结果。 */
function collectKindResults(result, out = []) {
  if (!result || typeof result !== 'object') return out;
  if (result.kind) out.push(result);
  for (const sub of (result.subResults || [])) collectKindResults(sub, out);
  return out;
}

/**
 * ★ 阶段 D1：按当前 registry / 向量 / e2e stdout 重算一行的 live 事实。
 *   symbolHitOnly     = !(E0 坐标复算通过 && 向量 e2e 实跑通过)（与 build 期同一规则）
 *   runtimeAnswerBacked = 向量 e2e stdout 确有 live 应答
 *   e0Digest/vectorDigest = 本次复算摘要（用于钉住快照一致性）
 * ctx.live 若显式提供布尔值则以注入值为准（可证伪测试用）。
 */
export function liveFactsForRow(row, ctx) {
  const subtree = filterChecksByKind(row?.check, ['e0CoordVector', 'runtimeProbeVector']);
  const result = subtree ? evaluateCheck(subtree, ctx) : { ok: false };
  const subs = collectKindResults(result);
  const e0 = subs.filter((r) => r.kind === 'e0CoordVector');
  const vec = subs.filter((r) => r.kind === 'runtimeProbeVector');
  const e0Ok = e0.length > 0 && e0.every((r) => r.ok === true);
  const vecOk = vec.length > 0 && vec.every((r) => r.ok === true);
  const answers = vec.reduce((n, r) => n + (Number(r.answers) || 0), 0);
  const facts = {
    symbolHitOnly: !(e0Ok && vecOk),
    runtimeAnswerBacked: vecOk && answers > 0,
    sampleGeneralized: row?.sampleGeneralized === true,
    e0Ok,
    vecOk,
    answers,
    answerSource: vec.find((r) => r.answerSource)?.answerSource || '-',
    e0Digest: e0.map((r) => r.digest || '').join('|'),
    vectorDigest: vec.map((r) => r.digest || '').join('|'),
  };
  if (ctx?.live && typeof ctx.live === 'object') {
    for (const k of ['symbolHitOnly', 'runtimeAnswerBacked', 'sampleGeneralized']) {
      if (typeof ctx.live[k] === 'boolean') facts[k] = ctx.live[k];
    }
  }
  facts.snapshotMismatch = snapshotMismatchOf(row, facts);
  return facts;
}

/**
 * 求值单行：verdict 必须同时满足三个独立条件（团队审计阻断项修正 ③）：
 *   ① check 取证复跑通过；② forensicGrade==='A'（取证等级）；
 *   ③ u1CarrierStatus==='齐备'（门禁文件 + 断言名真实存在）。
 * 门禁未落盘 / 断言名不存在 ⇒ 判「非 A」，并把原因交回调用方生成下一载体。
 * R-5：取证等级字段本身不因载体缺失而降级（仍是 A），但行 verdict 为非 A。
 * ★ 阶段 D1：传 ctx 时先 live 重算再求值；不传 ctx（build 期）行为完全不变。
 */
export function evaluateRow(row, ctx) {
  const liveFacts = ctx ? liveFactsForRow(row, ctx) : null;
  const evalCtx = liveFacts ? { ...ctx, live: liveFacts } : ctx;
  const r = evaluateCheck(row.check, evalCtx);
  const carrier = carrierStatusOf(row);
  const forensicGrade = row.forensicGrade;
  // ★ QA R1 / G1：verdict 必须额外满足「该行 gate **真实执行**通过 + 断言名命中 stdout」。
  //   只查文件存在 / 文本含断言名的旧逻辑对真实回归零敏感度（写帧改错仍全 A）。
  const gate = gateVerdict(row);
  const snapshotMismatch = liveFacts?.snapshotMismatch || [];
  const ok = r.ok && forensicGrade === 'A' && carrier.status === '齐备' && gate.ok
    && snapshotMismatch.length === 0;
  const detail = [
    r.detail,
    `取证等级=${forensicGrade}`,
    `U-1载体状态=${carrier.status}`,
    ...carrier.reasons,
    gate.detail,
    ...(liveFacts ? [`live重算=符号命中${liveFacts.symbolHitOnly ? 1 : 0}/应答${liveFacts.runtimeAnswerBacked ? 1 : 0}/来源${liveFacts.answerSource}`] : []),
    ...(snapshotMismatch.length ? [`快照不一致=${snapshotMismatch.join(', ')}`] : []),
  ].join(' | ');
  return {
    verdict: ok ? 'A' : '非A',
    detail,
    forensicGrade,
    u1CarrierStatus: carrier.status,
    carrierMissing: carrier.missing,
    carrierReasons: carrier.reasons,
    gateExitCode: gate.exitCode,
    gateOk: gate.ok,
    // ★ 前置未满足（exit 2）必须一路带到汇总，否则「没构建」会被读成「有缺陷」。
    gatePreconditionMissing: gate.preconditionMissing === true,
    liveMode: liveFacts ? 1 : 0,
    liveFacts,
    liveSymbolHitOnly: liveFacts ? liveFacts.symbolHitOnly : undefined,
    liveRuntimeAnswerBacked: liveFacts ? liveFacts.runtimeAnswerBacked : undefined,
    snapshotMismatch,
  };
}

/** 规范化文本 sha256（审计输出用）。 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 取 JSON 中按点分路径的值（不存在返回 undefined）。 */
export function jsonPath(obj, path) {
  let cur = obj;
  for (const k of path) cur = cur == null ? undefined : cur[k];
  return cur;
}

/**
 * 机读实测「分母清单」（PRD 附录 A / §7；各自标源，禁止混算）。
 * 所有 value 由 data/*.json 实际条目算出，不由人手填。
 */
export function measureNumberSources() {
  const out = [];
  const push = (name, value, sourceCmd, scope, note) => out.push({ name, value, sourceCmd, scope, note: note || '' });

  const plan = readJson('data/bind-plan.json');
  if (plan) {
    const fam = Object.entries(plan.ecu || {})
      .filter(([, v]) => JSON.stringify(v.provenance || []).includes('commCat10-family-default'))
      .sort(([a], [b]) => a.localeCompare(b));
    push('N=120 family-default sysId 数', fam.length,
      'node -e "const b=require(\'./data/bind-plan.json\');console.log(Object.entries(b.ecu).filter(([k,v])=>JSON.stringify(v.provenance||[]).includes(\'commCat10-family-default\')).length, b.stats.commFamilyDefault)"',
      'HB-2 静态分派规则分母（独立，不与身份链/402 混算）',
      '双源：按 provenance 过滤计数 与 stats.commFamilyDefault 一致');
    // fam120 权威分组 = min(该代完整 cat=0x10 地址表条数, 16)（PRD 附录 A 的
    // {3:28,13:2,16:90}）。截断删除后 pairs 长度已变成各代完整条数，
    // 因此分组标签必须由 comm-addr-table.byGeneration[].count 机读得出，
    // 与 bind-plan.stats.candidateDistribution / comm-addr.limitCheck 同源、禁止混算。
    const commAddr = readJson('data/comm-addr-table.json');
    // 统一归一化为「去 0x 前缀 + 大写十六进制」（如 0x0B / 0X0B → 0B），
    // 避免键大小写不一致导致 group 全落到 0 的假值。
    const genKey = (x) => String(x).replace(/^0x/i, '').toUpperCase();
    const genFull = {};
    for (const [g, e] of Object.entries(commAddr?.byGeneration || {})) {
      genFull[genKey(g)] = e.count ?? (e.addresses || []).length;
    }
    const dist = {};
    const fullDist = {};
    for (const [sid, v] of fam) {
      const g = genKey('0x' + (parseInt(sid, 16) >> 8).toString(16).padStart(2, '0'));
      const group = Math.min(genFull[g] || 0, 16);
      dist[group] = (dist[group] || 0) + 1;
      const n = (v.pairs || v.candidates || []).length;
      fullDist[n] = (fullDist[n] || 0) + 1;
    }
    push('fam120 候选分布 {3:28,13:2,16:90}', dist,
      'node -e "const b=require(\'./data/bind-plan.json\');const c=require(\'./data/comm-addr-table.json\');const K=x=>String(x).replace(/^0x/i,\'\').toUpperCase();const g={};for(const [k,v] of Object.entries(c.byGeneration))g[K(k)]=v.count;const d={};for(const [k,v] of Object.entries(b.ecu)){if(JSON.stringify(v.provenance||[]).includes(\'commCat10-family-default\')){const n=Math.min(g[K(\'0x\'+(parseInt(k,16)>>8).toString(16).padStart(2,\'0\'))]||0,16);d[n]=(d[n]||0)+1;}}console.log(JSON.stringify(d));"',
      'HB-2 候选分组（3/13/16 各自标源）',
      '分组=min(该代完整 cat=0x10 地址表条数,16)；与 bind-plan.stats.candidateDistribution 同源');
    push('fam120 截断删除后完整候选长度分布', fullDist,
      'node -e "const b=require(\'./data/bind-plan.json\');const d={};for(const [k,v] of Object.entries(b.ecu)){if(JSON.stringify(v.provenance||[]).includes(\'commCat10-family-default\')){const c=(v.pairs||v.candidates||[]).length;d[c]=(d[c]||0)+1;}}console.log(JSON.stringify(d));"',
      'HB-2 实现层观测值（5 处截断删除后的完整地址表，非权威分母）',
      '此分布与 {3:28,13:2,16:90} 是不同层面的量，禁止混算');
    push('bind-plan sysId 总数', Object.keys(plan.ecu || {}).length,
      'node -e "console.log(Object.keys(require(\'./data/bind-plan.json\').ecu).length)"',
      'bind-plan schemaVersion=5 全表');
    push('stats.commFamilyDefault', jsonPath(plan, ['stats', 'commFamilyDefault']),
      'node -e "console.log(require(\'./data/bind-plan.json\').stats.commFamilyDefault)"',
      'HB-2 双源校验');
  }

  const comm = readJson('data/sysdata-comm.json');
  if (comm) {
    let subs = 0, inRange = 0, plus6A = 0, cat60 = 0;
    const frameSigs = new Set();
    for (const sid of sortedKeys(comm.ecu || {})) {
      for (const blk of comm.ecu[sid].blocks || []) {
        if (blk.cat === 0x10) {
          for (const s of blk.subs || []) {
            subs += 1;
            if (s.tx >= 0x700 && s.tx <= 0x77F) { inRange += 1; if (s.rx === s.tx + 0x6A) plus6A += 1; }
          }
        }
        if (blk.cat === 0x60) { cat60 += 1; frameSigs.add(JSON.stringify(blk.frames || [])); }
      }
    }
    push('cat=0x10 subs 总数 527', subs,
      'node -e "const d=require(\'./data/sysdata-comm.json\');let n=0;for(const s of Object.keys(d.ecu).sort())for(const b of d.ecu[s].blocks||[])if(b.cat===0x10)n+=(b.subs||[]).length;console.log(n)"',
      'HB-2 cat=0x10 全表分母（527）');
    push('tx∈0x700–0x77F 段 402/402', { inRange, rxEqTxPlus6A: plus6A },
      'node -e "const d=require(\'./data/sysdata-comm.json\');let a=0,b=0;for(const s of Object.keys(d.ecu).sort())for(const x of d.ecu[s].blocks||[])if(x.cat===0x10)for(const p of x.subs||[])if(p.tx>=0x700&&p.tx<=0x77F){a++;if(p.rx===p.tx+0x6A)b++}console.log(a,b)"',
      'HB-2 402/402 仅在 tx∈0x700–0x77F 限定段成立（全表 402/527）');
    push('cat=0x60 block 185/185 四帧逐字节全同', { cat60BlockCount: cat60, distinctFrameSig: frameSigs.size, byteIdentical: frameSigs.size === 1 && cat60 === 185 },
      'node -e "const d=require(\'./data/sysdata-comm.json\');const s=new Set();let n=0;for(const k of Object.keys(d.ecu).sort())for(const b of d.ecu[k].blocks||[])if(b.cat===0x60){n++;s.add(JSON.stringify(b.frames||[]))}console.log(n,s.size)"',
      'HB-3 L1/L2 帧序自洽（不证明 L3 运行时实发帧已对齐）');
  }

  const ident = readJson('data/ident-registry.json');
  if (ident) {
    push('身份链 163/163 联合覆盖', Object.keys(ident.identToVariant || {}).length,
      'node -e "console.log(Object.keys(require(\'./data/ident-registry.json\').identToVariant).length)"',
      'HB-2 ⑤ 身份链（与 120/120 分列独立断言，禁止混算分母）');
    push('变体名 148/148', Object.keys(ident.variantToIdent || {}).length,
      'node -e "console.log(Object.keys(require(\'./data/ident-registry.json\').variantToIdent).length)"',
      'HB-2 ⑤ 身份链');
    push('模块三字段 12/12', Object.keys(ident.moduleIdent || {}).length,
      'node -e "console.log(Object.keys(require(\'./data/ident-registry.json\').moduleIdent).length)"',
      'HB-2 ⑤ 身份链');
  }

  const dsn = readJson('data/dsn-module-sysids.json');
  if (dsn) {
    for (const p of ['9x6', '9x7']) {
      const e = (dsn.platforms || {})[p];
      if (e) push(`DSN 模块表 ${p.toUpperCase()} 行数`, e.rowCount,
        `node -e "console.log(require('./data/dsn-module-sysids.json').platforms['${p}'].rowCount)"`,
        'HB-1 映射表分母（29/41）');
    }
  }
  const rt = readJson('data/sysdata-root-table.json');
  if (rt) {
    const lowByType = {};
    for (const t of sortedKeys(rt.types || {})) {
      lowByType[parseInt(t, 16)] = new Set((rt.types[t].sysIds || []).map((s) => parseInt(s, 16) & 0xff));
    }
    const cover = (types) => {
      const o = {};
      for (const t of types) o['0x' + t.toString(16).toUpperCase().padStart(2, '0')] = lowByType[t] ? lowByType[t].size : 0;
      return o;
    };
    push('canonicalType 超集实测 9X6 12/14 vs 10/14', cover([1, 2]),
      'node -e "const rt=require(\'./data/sysdata-root-table.json\');for(const t of [1,2])console.log(t,new Set(rt.types[\'0x\'+t.toString(16).padStart(2,\'0\')].sysIds.map(s=>parseInt(s,16)&0xff)).size)"',
      'HB-1 规范 type 超集硬校验（0x01 ⊃ 0x02）');
    push('canonicalType 超集实测 9X7 33/34 vs 30/34 vs 20/34', cover([5, 6, 4]),
      'node -e "const rt=require(\'./data/sysdata-root-table.json\');for(const t of [5,6,4])console.log(t,new Set(rt.types[\'0x\'+t.toString(16).padStart(2,\'0\')].sysIds.map(s=>parseInt(s,16)&0xff)).size)"',
      'HB-1 规范 type 超集硬校验（0x05 ⊃ 0x06 ⊃ 0x04）');
  }

  const rv = readJson('data/routines-verified.json');
  if (rv) push('noRid 载体 16 条', rv.noRidCount,
    'node -e "console.log(require(\'./data/routines-verified.json\').noRidCount)"',
    'P0-4 / F13 noRid 独立待办（不与 79 RID 混算）');
  const fq = readJson('data/function-sequences.json');
  if (fq) push('功能序列 687 条', fq.count,
    'node -e "console.log(require(\'./data/function-sequences.json\').count)"',
    'P0-3 功能全集差集（687 条中 489 条无 map 引用）');
  const sp = readJson('data/special-functions.json');
  if (sp) push('menuId 67 条', (sp.functions || []).length,
    'node -e "console.log(require(\'./data/special-functions.json\').functions.length)"',
    'D-2 menuId 命名空间（67/79/687 不得读作同一命名空间）');
  const me = readJson('data/measure.json');
  if (me) push('measure 1719 条', (me.params || []).length,
    'node -e "console.log(require(\'./data/measure.json\').params.length)"',
    'P0-8 待接通项（app .slice(0,30) 仅 480 条可点击）');
  const cv = readJson('data/coding-v2.json');
  if (cv) push('coding-v2 params 条目数', (cv.params || []).length,
    'node -e "console.log(require(\'./data/coding-v2.json\').params.length)"',
    'D-3 params[].id 全集');

  return out;
}

/**
 * U-2 动态「旧值清单」：从 PRD §5 U-2 行的「已知冲突必须消除」文本机读抽出，
 * 不硬编码 18/23 份文档数。
 */
export function legacyNumbersFromPrd() {
  const prd = readText(PRD_FILE);
  const out = [];
  if (prd === null) return out;
  const line = prd.split('\n').find((l) => l.includes('已知冲突必须消除'));
  if (!line) return out;
  for (const m of line.matchAll(/(?:\d+(?:\.\d+)?%?)/g)) {
    const v = m[0];
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  }
  return out.sort();
}
