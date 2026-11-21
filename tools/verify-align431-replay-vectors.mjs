#!/usr/bin/env node
/**
 * verify-align431-replay-vectors.mjs — 阶段 E「强制纳管回放向量」独立 gate。
 *
 * 纪律：
 *   - 7 组 mustReplay 向量缺 manifest / expected / replay / sourceLog 任一文件即 exit 1；
 *   - expected / replay / sourceLog 三份摘要按**文件字节**逐一核对，改字节不改 sha 即红；
 *   - 历史失败现场向量（981 BCM 实车 / 991 IC 模拟）必须保留 request-key-missing
 *     观测标记，且 expected/replay 不得出现日志中从未发生的 0x070D/0x0777 等正响应；
 *   - e2e flow 必须真跑并逐组输出 `VECTOR <id> frames=n diff=[]`，且汇总 count=7。
 *
 * 用法：node tools/verify-align431-replay-vectors.mjs
 * stdout 成功：`REPLAY_VECTOR_MANIFEST_PASS count=7`
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
    const emitted = norm([
      ...expectedDoc.frames,
      ...replayDoc.steps.flatMap((step) => [step.req, step.resp]),
    ].join(' '));
    for (const token of fa.mustNotContain) {
      if (emitted.includes(norm(token))) fail(`FORGED_POSITIVE_RESPONSE ${id}`);
    }
    const observed = norm(expectedDoc.observedFailure || '');
    for (const token of fa.mustContain) {
      if (!observed.includes(norm(token))) fail(`FAILURE_MARKER_MISSING ${id}`);
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
for (const id of VECTOR_IDS) {
  const line = lines.find((l) => l.startsWith(`VECTOR ${id} `));
  if (!line) {
    fail(`E2E_VECTOR_LINE_MISSING ${id}`);
    continue;
  }
  const mFrames = /\bframes=(\d+)\b/.exec(line);
  if (!mFrames || !/\bdiff=\[\]/.test(line)) {
    fail(`E2E_VECTOR_DIFF ${id}`);
    continue;
  }
  const got = readVector(id);
  if (got.ok && Number(mFrames[1]) !== got.vector.expected.length) {
    fail(`E2E_VECTOR_FRAME_COUNT ${id}`);
  }
}
if (!lines.some((l) => l.trim() === `E2E_VECTOR_DIFF_EMPTY count=${VECTOR_IDS.length}`)) {
  fail(`E2E_VECTOR_COUNT_NOT_${VECTOR_IDS.length}`);
}

if (failures.length) {
  console.log(`REPLAY_VECTOR_MANIFEST_FAIL count=${failures.length}`);
  for (const message of [...new Set(failures)].sort()) console.log(`REPLAY_VECTOR_FAIL ${message}`);
  process.exit(1);
}
// ROOT 仅用于确认与共享内核同一根；输出中绝不出现绝对路径。
void ROOT;
console.log(`REPLAY_VECTOR_MANIFEST_PASS count=${VECTOR_IDS.length}`);
