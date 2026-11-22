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
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  answerBackedByReplay, evaluateProvableTag, evaluateRuntimeVector,
  isPositiveUdsResponse, liveFactsForRow, readVector,
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

/* ── (e) ISO-TP 首帧截断假绿口子：无 verdict 合成帧结构自洽 + 反例注入 ─────── */
{
  // a) 终审构造的合成半包：777 + FF PCI `10 09`（声明 9B）+ 仅 6B 数据、无 CF、无 verdict。
  //    旧实现 offset=7 命中 62 → 假绿；结构校验后必须 false。
  const truncNoVerdict = { req: '22F1A2', resp: '777100962F1A2303530' };
  ck('P0_FF_TRUNC_NO_VERDICT_FALSE', isPositiveUdsResponse(truncNoVerdict) === false,
    `req=${truncNoVerdict.req} resp=${truncNoVerdict.resp}`);

  // b) 同一识别串补上连续帧 77721303138（凑满声明的 9B），无 verdict → 必须 true。
  const fullNoVerdict = { req: '22F1A2', resp: '777100962F1A2303530 77721303138' };
  ck('P0_FF_COMPLETE_NO_VERDICT_TRUE', isPositiveUdsResponse(fullNoVerdict) === true,
    `resp=${fullNoVerdict.resp}`);

  // c) 旧向量真实 step 不回归：REPLAY_DME 单帧 1089→7E8 02 50 89（无 verdict）、
  //    多帧 1A87→10 0D + 21（声明 13B 实收 13B，无 verdict）。
  ck('P0_FF_REPLAY_DME_SF_STILL_TRUE',
    isPositiveUdsResponse({ req: '1089', resp: '7E8 02 50 89' }) === true,
    '1089 → 7E8 02 50 89');
  ck('P0_FF_REPLAY_DME_MF_STILL_TRUE',
    isPositiveUdsResponse({
      req: '1A87',
      resp: '7E8 10 0D 5A 87 39 38 31 36\r7E8 21 31 38 36 34 30 31 35',
    }) === true,
    '1A87 → 10 0D(6B) + 21(7B) = 13B');

  // d) 11-22 真实 NRC31 step：verdict 明写 truncated 的半包仍 false（verdict 短路未放宽）。
  const nrc31 = readVector('REPLAY_REALCAR981_BCM_NRC31');
  if (nrc31.ok) {
    const half = nrc31.vector.replay.find(
      (s) => s.req === '22F1A2' && /777100962F1A2303530/i.test(String(s.resp)),
    );
    ck('P0_FF_NRC31_HALF_STILL_FALSE',
      Boolean(half) && isPositiveUdsResponse(half) === false,
      `verdict=${half?.verdict || '(missing)'}`);
  } else {
    ck('P0_FF_NRC31_HALF_STILL_FALSE', false, 'NRC31 向量加载失败');
  }

  // e) 反例注入：把结构校验从 eval 源码摘掉（临时副本，真实文件只读），
  //    同一合成帧必须翻回 true —— 证明是新增校验在挡假绿，而不是函数恒 false。
  const evalPath = fileURLToPath(new URL('./align431-eval.mjs', import.meta.url));
  const src = readFileSync(evalPath, 'utf8');
  const guardRe = /if \(off >= 4 && hasFirstFramePci\(body, off - 4\)\s*&& !isoTpPayloadComplete\(body, off - 4\)\) return false;/;
  const guardFound = guardRe.test(src);
  const injected = src.replace(guardRe, '/* FFGUARD INJECTED: structural check removed */');
  ck('P0_FF_INJECTION_PATCH_APPLIED', guardFound && injected !== src,
    `guardFound=${guardFound} changed=${injected !== src}`);
  if (injected !== src) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ffguard-inj-'));
    const tmpFile = join(tmpDir, 'align431-eval-injected.mjs');
    try {
      writeFileSync(tmpFile, injected, 'utf8');
      const patched = await import(pathToFileURL(tmpFile).href);
      const flipped = patched.isPositiveUdsResponse(truncNoVerdict);
      ck('P0_FF_INJECTION_FLIPS_TRUE', flipped === true,
        `isPositiveUdsResponse(injected=${flipped})`);
    } catch (e) {
      ck('P0_FF_INJECTION_FLIPS_TRUE', false, `注入异常 ${e?.message || e}`);
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      try { rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  } else {
    ck('P0_FF_INJECTION_FLIPS_TRUE', false, '未能注入，无法证明可证伪');
  }
}

const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.log(`P0_RUNTIME_FAIL failed=${failed} total=${results.length}`);
  process.exit(1);
}
console.log(`P0_RUNTIME_PASS count=${results.length}`);
process.exit(0);
