#!/usr/bin/env node
/**
 * verify-align431-p0-runtime.mjs — 批次 C「11-22 实车 NRC31 现场」P0 真执行断言门禁。
 *
 * 不复制任何判定实现：三处致命点全部**真执行**前两批已定稿的门禁，只读其机器行；
 * 「全 NRC31 不算有应答」直接复用 tools/align431-eval.mjs 的生产函数（answerBackedByReplay /
 * evaluateRuntimeVector / liveFactsForRow / evaluateProvableTag），并做正响应反例注入证明可判伪。
 *
 * P0 断言：
 *   (a) 221409→7F2231 不得绑定        ← tools/verify-nrc-bind-failclosed.mjs（批次 A）
 *   (b) 未识别变体不得静默落 GT5       ← tools/verify-identity-dsn-gate.mjs（批次 B）
 *   (c) 身份 DSN「050」不得误配 GT4    ← tools/verify-identity-dsn-gate.mjs（批次 B）
 *   (d) 31/31 全 NRC31 的 runtime 行 answerBacked=false、不得标 A（批次 C）
 *
 * stdout：逐条 `PASS|FAIL P0_<name> <detail>` + 汇总机器行；
 *   末行 `P0_RUNTIME_PASS count=N` 或 `P0_RUNTIME_FAIL failed=N`，退出码 0/1。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  answerBackedByReplay, evaluateProvableTag, evaluateRuntimeVector,
  liveFactsForRow, readVector,
} from './align431-eval.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const VECTOR_ID = 'REPLAY_REALCAR981_BCM_NRC31';
/** 反例注入用的合成向量 id：只在内存里，不落盘、不进 VECTOR_IDS。 */
const SYNTH_ID = 'NRC31_ONLY_ASSERT';

const results = [];
const ck = (name, pass, detail = '') => {
  const ok = Boolean(pass);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`.trimEnd());
  return ok;
};

/** 真跑一个 gate，返回 exit code 与完整 stdout（不伪造、不复用文档结论）。 */
function runGate(scriptRel) {
  const r = spawnSync(process.execPath, [scriptRel], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return { exit: r.status === null ? -1 : r.status, stdout: String(r.stdout || '') };
}

/** gate 机器行是否明确 PASS 某断言名（末尾行与逐条断言行都认）。 */
const hasPassLine = (stdout, name) => stdout.split('\n').some(
  (line) => line === `PASS ${name}` || line.startsWith(`PASS ${name} `),
);
/** 取以 prefix 开头的末行。 */
const lastLine = (stdout, prefix) => stdout.split('\n').find((line) => line.startsWith(prefix)) || '';

/* ── (a) NRC 负响应不得绑定：真执行批次 A gate ───────────────────────── */
{
  const run = runGate('tools/verify-nrc-bind-failclosed.mjs');
  const summary = lastLine(run.stdout, 'NRC_BIND_FAIL_CLOSED_');
  ck('P0_NRC_BIND_GATE_EXIT_ZERO', run.exit === 0, `exit=${run.exit}`);
  ck('P0_221409_NRC_NOT_BOUND',
    summary.startsWith('NRC_BIND_FAIL_CLOSED_PASS')
      && hasPassLine(run.stdout, 'CLEAN_SENDFN_NRC_BIND_FAILCLOSED'),
    `summary=${summary}`);
}

/* ── (b)(c) 身份裁决：真执行批次 B gate，逐条核对致命断言 ─────────────── */
{
  const run = runGate('tools/verify-identity-dsn-gate.mjs');
  const summary = lastLine(run.stdout, 'IDENTITY_DSN_GATE_');
  ck('P0_IDENTITY_GATE_EXIT_ZERO', run.exit === 0, `exit=${run.exit}`);
  ck('P0_UNRECOGNIZED_VARIANT_NOT_GT5',
    summary.startsWith('IDENTITY_DSN_GATE_PASS')
      && hasPassLine(run.stdout, 'APP_UNRECOGNIZED_FAILS_CLOSED')
      && hasPassLine(run.stdout, 'APP_UNRECOGNIZED_LOADS_NO_ITEMS')
      && hasPassLine(run.stdout, 'VARIANT_HONEST_HOW'),
    `summary=${summary}`);
  ck('P0_DSN_050_NOT_GT4',
    summary.startsWith('IDENTITY_DSN_GATE_PASS')
      && hasPassLine(run.stdout, 'DSN_050_NO_PREFIX_FALLBACK'),
    '050 截断串不得靠前缀命中 050018 → GT4');
}

/* ── (d) 全 NRC31 不得算应答 / 不得标 A：生产函数真执行 + 反例注入 ─────── */
{
  const got = readVector(VECTOR_ID);
  ck('P0_NRC31_VECTOR_LOADED', got.ok, got.ok ? `${VECTOR_ID} 摘要一致` : (got.detail || ''));
  if (got.ok) {
    const v = got.vector;
    // 只取日志中真实观测到的 NRC 帧：探 221409 的 7F2231 + 31 个编码块 7F2231。
    const nrcSteps = v.replay.filter((s) => s.verdict === 'nrc' && /7F2231/i.test(String(s.resp)));
    ck('P0_NRC31_STEPS_FROM_LOG', nrcSteps.length === 32,
      `nrc7F2231=${nrcSteps.length}（1 绑定探针 + 31 编码块）`);

    const backed = answerBackedByReplay(nrcSteps);
    ck('P0_NRC31_ANSWER_BACKED_FALSE', backed === false,
      `answerBackedByReplay(nrcOnly)=${backed}`);
    console.log(`P0_NRC31_ANSWER_BACKED=${backed ? 1 : 0}`);

    // 反例注入：把一帧改成正响应 62140901，同一函数必须转真 —— 证明不是恒 false。
    const injectedSteps = nrcSteps.map((s, i) => (i === 0
      ? { ...s, verdict: 'ok', resp: '62140901' } : s));
    const injectedBacked = answerBackedByReplay(injectedSteps);
    ck('P0_NRC31_POSITIVE_INJECTION_FLIPS_TRUE', injectedBacked === true,
      `answerBackedByReplay(injected)=${injectedBacked}`);
    console.log(`P0_NRC31_INJECTED_POSITIVE=${injectedBacked ? 1 : 0}`);

    // 内存覆写向量（只含 NRC 帧）+ 模拟 e2e stdout：production 求值必须拒绝给应答举证。
    const nrcOnly = {
      ...v,
      vectorId: SYNTH_ID,
      expected: nrcSteps.map((s) => s.req),
      replay: nrcSteps,
    };
    delete nrcOnly.sha256; // 改名后的内存向量不沿用旧摘要
    const ctx = {
      vectors: { [SYNTH_ID]: nrcOnly },
      e2eStdout: `VECTOR ${SYNTH_ID} frames=${nrcSteps.length} diff=[]\n`,
    };
    const rv = evaluateRuntimeVector({ vectorId: SYNTH_ID }, ctx);
    ck('P0_NRC31_RUNTIME_VECTOR_NOT_A', rv.ok === false && /正响应举证=0/.test(rv.detail || ''),
      `ok=${rv.ok} detail=${(rv.detail || '').slice(0, 90)}`);
    console.log(`P0_NRC31_VECTOR_NOT_A=${rv.ok === false ? 1 : 0}`);

    const row = {
      rowId: 'P0_NRC31_SYNTHETIC_RUNTIME_ROW',
      verdict: 'A',
      runtimeRequired: true,
      provable: 'runtime',
      runtimeAnswerBacked: false,
      symbolHitOnly: true,
      sampleGeneralized: false,
      vectorId: SYNTH_ID,
      check: { kind: 'all', of: [{ kind: 'runtimeProbeVector', vectorId: SYNTH_ID }] },
    };
    const facts = liveFactsForRow(row, ctx);
    ck('P0_NRC31_LIVE_ANSWER_FALSE', facts.runtimeAnswerBacked === false,
      `runtimeAnswerBacked=${facts.runtimeAnswerBacked} vecOk=${facts.vecOk}`);
    const pt = evaluateProvableTag(row, { ...ctx, live: facts });
    ck('P0_NRC31_ROW_NON_A_WITH_REAL_LIVE', pt.ok === false,
      `ok=${pt.ok} detail=${(pt.detail || '').slice(0, 90)}`);
    // 隔离「零应答」这一条：用 ctx.live 显式置 symbolHitOnly=false（生产内核允许的
    // live 覆写口），只留 runtimeAnswerBacked=false，断言必须命中「零应答举证」。
    const isolatedLive = { ...facts, symbolHitOnly: false };
    const pt2 = evaluateProvableTag(
      { ...row, symbolHitOnly: false }, { ...ctx, live: isolatedLive },
    );
    ck('P0_NRC31_ROW_NOT_A', pt2.ok === false && /零应答举证/.test(pt2.detail || ''),
      `ok=${pt2.ok} detail=${(pt2.detail || '').slice(0, 90)}`);
    console.log(`P0_NRC31_ROW_NOT_A=${pt2.ok === false && /零应答举证/.test(pt2.detail || '') ? 1 : 0}`);
  }
}

const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.log(`P0_RUNTIME_FAIL failed=${failed} total=${results.length}`);
  process.exit(1);
}
console.log(`P0_RUNTIME_PASS count=${results.length}`);
process.exit(0);
