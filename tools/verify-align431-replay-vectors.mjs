#!/usr/bin/env node
/**
 * verify-align431-replay-vectors.mjs — 阶段 E「强制纳管回放向量」独立 gate。
 *
 * 纪律：
 *   - 8 组 mustReplay 向量缺 manifest / expected / replay / sourceLog 任一文件即 exit 1；
 *   - expected / replay / sourceLog 三份摘要按**文件字节**逐一核对，改字节不改 sha 即红；
 *   - 历史失败现场向量（981 BCM 实车 / 991 IC 模拟 / 11-22 981 BCM NRC31）必须保留
 *     各自 observedFailure 标记，且 expected/replay 不得出现日志中从未发生的正响应；
 *     mustNotContain 只扫帧字节，mustContain 可命中逐帧 note / summary；
 *   - e2e flow 必须真跑并逐组输出 `VECTOR <id> frames=n diff=[]`，且汇总 count=8。
 *
 * 用法：node tools/verify-align431-replay-vectors.mjs
 * stdout 成功：`REPLAY_VECTOR_MANIFEST_PASS count=8`
 * 失败：`REPLAY_VECTOR_MANIFEST_FAIL count=N` + 逐条 `REPLAY_VECTOR_FAIL ...`
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, VECTOR_DIR, VECTOR_IDS, digest, readVector,
} from './align431-eval.mjs';

const REAL_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
/** 三条历史失败现场向量：e2e 必须输出独立机器行，gate 必须核对为 PASS。 */
const HISTORICAL_IDS = Object.freeze([
  'REPLAY_REALCAR981_BCM', 'REPLAY_SIM991_IC', 'REPLAY_REALCAR981_BCM_NRC31',
]);
/** @type {string[]} */
const failures = [];
const fail = (message) => failures.push(message);
const readText = (rel) => {
  if (typeof rel !== 'string' || !rel) return null;
  const p = join(REAL_ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const norm = (s) => String(s).toLowerCase().replace(/[^0-9a-z]/g, '');
const hex = (s) => String(s).replace(/[^0-9a-fA-F]/g, '').toUpperCase();

for (const id of VECTOR_IDS) {
  const manifestRel = `${VECTOR_DIR}/${id}.json`;
  const manifestText = readText(manifestRel);
  if (manifestText === null) {
    fail(`MANIFEST_MISSING ${id}`);
    continue;
  }
  /** @type {any} */
  let m;
  try { m = JSON.parse(manifestText); } catch { fail(`MANIFEST_JSON_BROKEN ${id}`); continue; }
  if (m.vectorId !== id || m.mustReplay !== true || m.sampleOnly !== true
      || m.grade !== 'R' || m.provable !== 'runtime') {
    fail(`MANIFEST_META ${id}`);
  }

  const pinned = [
    ['EXPECTED', m.expectedFile, m.expectedSha256],
    ['REPLAY', m.replayFile, m.replaySha256],
    ['SOURCE_LOG', m.sourceLogFile, m.sourceLogSha256],
  ];
  for (const [kind, rel, sha] of pinned) {
    const text = readText(rel);
    if (text === null) {
      fail(`${kind}_MISSING ${id}`);
      continue;
    }
    if (digest(text) !== sha) fail(`${kind}_SHA_MISMATCH ${id}`);
  }

  const got = readVector(id);
  if (!got.ok) {
    fail(`READ_VECTOR ${id}`);
    continue;
  }
  const v = got.vector;
  const expectedText = readText(m.expectedFile);
  const replayText = readText(m.replayFile);
  if (expectedText === null || replayText === null) continue;
  /** @type {any} */
  let expectedDoc;
  /** @type {any} */
  let replayDoc;
  try { expectedDoc = JSON.parse(expectedText); } catch { fail(`EXPECTED_JSON_BROKEN ${id}`); continue; }
  try { replayDoc = JSON.parse(replayText); } catch { fail(`REPLAY_JSON_BROKEN ${id}`); continue; }
  if (!Array.isArray(expectedDoc.frames) || expectedDoc.frames.length === 0) {
    fail(`EXPECTED_FRAMES_EMPTY ${id}`);
    continue;
  }
  if (!Array.isArray(replayDoc.steps) || replayDoc.steps.length === 0) {
    fail(`REPLAY_STEPS_EMPTY ${id}`);
    continue;
  }
  // ★ 历史失败现场：不得把「修复后应成功」写成日志证据。
  if (m.kind === 'historical-failure-replay') {
    // 新向量的每条观测帧都由 e2e 直接按 expected.frames 逐条驱动，必须能在 replay 中命中。
    const replayReq = new Set(v.replay.map((step) => hex(step.req)));
    for (const frame of expectedDoc.frames) {
      if (!replayReq.has(hex(frame))) fail(`REPLAY_FRAME_UNDRIVABLE ${id}`);
    }

    const fa = m.failureAssertion;
    if (!fa || !Array.isArray(fa.mustContain) || !Array.isArray(fa.mustNotContain)) {
      fail(`FAILURE_ASSERTION_MISSING ${id}`);
      continue;
    }
    // mustNotContain 只针对真实帧字节（伪造正响应检测），不能靠 note 自证清白。
    const emitted = norm([
      ...expectedDoc.frames,
      ...replayDoc.steps.flatMap((step) => [step.req, step.resp]),
    ].join(' '));
    for (const token of fa.mustNotContain) {
      if (emitted.includes(norm(token))) fail(`FORGED_POSITIVE_RESPONSE ${id}`);
    }
    // mustContain 是失败现场标记，可落在 observedFailure、逐帧 note、summary 或帧字节里。
    const markerEvidence = norm([
      emitted,
      expectedDoc.observedFailure || '',
      expectedDoc.note || '',
      replayDoc.note || '',
      replayDoc.summary || '',
      ...replayDoc.steps.flatMap((step) => [step.note || '']),
    ].join(' '));
    for (const token of fa.mustContain) {
      if (!markerEvidence.includes(norm(token))) fail(`FAILURE_MARKER_MISSING ${id}`);
    }
  }
}

/* ── e2e 真执行 stdout：逐组 VECTOR 行 + 汇总计数 ── */
let stdout = '';
const stdoutFile = process.env.ALIGN431_REPLAY_STDOUT_FILE || '';
if (stdoutFile && existsSync(stdoutFile)) {
  stdout = readFileSync(stdoutFile, 'utf8');
} else {
  const run = spawnSync(process.execPath, ['e2e-flow.mjs'], {
    cwd: REAL_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  stdout = run.stdout || '';
  if (run.error || run.status !== 0) fail(`E2E_EXIT ${run.status === null ? -1 : run.status}`);
}
const lines = stdout.split('\n');
/** @type {Map<string, boolean>} VECTOR 行逐条真执行结果，用于交叉核对历史回放机器行。 */
const vectorLineOk = new Map();
for (const id of VECTOR_IDS) {
  const line = lines.find((l) => l.startsWith(`VECTOR ${id} `));
  if (!line) {
    vectorLineOk.set(id, false);
    fail(`E2E_VECTOR_LINE_MISSING ${id}`);
    continue;
  }
  const mFrames = /\bframes=(\d+)\b/.exec(line);
  if (!mFrames || !/\bdiff=\[\]/.test(line)) {
    vectorLineOk.set(id, false);
    fail(`E2E_VECTOR_DIFF ${id}`);
    continue;
  }
  const got = readVector(id);
  if (got.ok && Number(mFrames[1]) !== got.vector.expected.length) {
    vectorLineOk.set(id, false);
    fail(`E2E_VECTOR_FRAME_COUNT ${id}`);
    continue;
  }
  vectorLineOk.set(id, true);
}
if (!lines.some((l) => l.trim() === `E2E_VECTOR_DIFF_EMPTY count=${VECTOR_IDS.length}`)) {
  fail(`E2E_VECTOR_COUNT_NOT_${VECTOR_IDS.length}`);
}

/* ── [16] 历史失败现场回放机器行：存在、count、逐条状态 + VECTOR 行交叉核对 ── */
const historicalLine = lines.find((l) => l.startsWith('HISTORICAL_FAILURE_REPLAY '));
if (!historicalLine) {
  fail('HISTORICAL_REPLAY_LINE_MISSING');
} else {
  const mCount = /\bcount=(\d+)\b/.exec(historicalLine);
  if (!mCount || Number(mCount[1]) !== HISTORICAL_IDS.length) {
    fail('HISTORICAL_REPLAY_LINE_COUNT');
  }
  for (const id of HISTORICAL_IDS) {
    const mStatus = new RegExp(`\\b${id}=(PASS|FAIL)\\b`).exec(historicalLine);
    if (!mStatus) {
      fail(`HISTORICAL_REPLAY_STATUS_MISSING ${id}`);
    } else if (mStatus[1] !== 'PASS') {
      fail(`HISTORICAL_REPLAY_STATUS_FAIL ${id}`);
    } else if (vectorLineOk.get(id) !== true) {
      // 机器行声称 PASS 但该组 VECTOR 行缺失/diff≠空 —— 视为机器行自证失败。
      fail(`HISTORICAL_REPLAY_LINE_INCONSISTENT ${id}`);
    }
  }
}

if (failures.length) {
  console.log(`REPLAY_VECTOR_MANIFEST_FAIL count=${failures.length}`);
  for (const message of [...new Set(failures)].sort()) console.log(`REPLAY_VECTOR_FAIL ${message}`);
  process.exit(1);
}
// ROOT 仅用于确认与共享内核同一根；输出中绝不出现绝对路径。
void ROOT;
console.log(`REPLAY_VECTOR_MANIFEST_PASS count=${VECTOR_IDS.length}`);
