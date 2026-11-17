#!/usr/bin/env node
/**
 * verify-drive-disabled-gate.mjs —— 执行层 driveDisabled 闸的可判伪回归。
 *
 * 背景（2026-11-17）：UI 把 133 条 form=31 的 driveDisabled 条目置灰，
 * 但 `.actRun → runRoutine()` 不经过 schema.featureFramesFor 的 0x2F 闸。
 * 绕过 DOM 后每条都会发 `31 <sub> <rid>`（params 必然为空串）——
 * 即我们判定「不能定型」的那批裸帧。
 *
 * 本脚本同时验三层：
 *   ① 纯策略 drivableReason() 对真实 data/actuator.json 的 133 条逐条给理由；
 *   ② 源码结构：app.js 的 4 个 runRoutine 调用点**每一个**前面都有同一个
 *      assertDrivableRoutine()（不允许在四处各抄判断）；
 *   ③ 动态注入：4 个调用点各触发一次禁用 rid，断言
 *      - 抛错且理由来自数据；
 *      - coder 的 txLog（fake ELM 的 calls）**一条都没有**；
 *      恢复后允许 rid 能正常发出 31 帧。
 *
 * 跑法：node tools/verify-drive-disabled-gate.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Coder } from '../src/coder.js';
import { drivableReason, buildActuatorRoutineIndex } from '../src/schema.js';
import {
  setRoutineGateItems, getRoutineGateReason, assertDrivableRoutine,
} from '../src/routine-gate.js';

let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};

const here = new URL('./', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, here), 'utf8');
const act = JSON.parse(read('../data/actuator.json'));
const items = Array.isArray(act.items) ? act.items : [];
const disabled31 = items.filter((e) => e && e.form === '31' && e.driveDisabled === true
  && Number.isInteger(e.rid));
const sample = disabled31.find((e) => String(e.name || '').includes('滑动天窗'))
  || disabled31.find((e) => e.paramsResolved === 'multi')
  || disabled31[0];
assert.ok(sample, 'data/actuator.json 里必须有 form=31 的 driveDisabled 条目');

// ① 纯策略：理由必须逐条来自数据，不许编
{
  ok('真实数据规模：driveDisabled 的 0x31 条目 133 条 / 多候选 39 条',
    disabled31.length === 133 && disabled31.filter((e) => e.paramsResolved === 'multi').length === 39,
    `实测 ${disabled31.length} / ${disabled31.filter((e) => e.paramsResolved === 'multi').length}`);
  const bad = disabled31.filter((e) => drivableReason('routine', e) !== String(e.driveDisabledReason).trim());
  ok('drivableReason() 对 133 条逐一返回数据里的理由', bad.length === 0,
    `不符 ${bad.length} 条`);
  ok('drivableReason() 未知类别不默认放行',
    typeof drivableReason('unknown', {}) === 'string');
  const idx = buildActuatorRoutineIndex(items);
  ok('buildActuatorRoutineIndex() 覆盖全部 133 条禁用 rid',
    disabled31.every((e) => idx.get(e.rid)?.driveDisabled === true), `索引 ${idx.size} 项`);
}

// ② 源码结构：4 个调用点必须共用同一个闸（不是各抄一遍）
{
  const app = read('../src/app.js');
  const coder = read('../src/coder.js');
  const calls = [...app.matchAll(/coder\.runRoutine\(/g)].map((m) => m.index);
  const guards = [...app.matchAll(/assertDrivableRoutine\(/g)].map((m) => m.index);
  ok('app.js 恰好 4 个 coder.runRoutine 调用点', calls.length === 4, `实测 ${calls.length}`);
  ok('app.js 恰好 3 个早置 assertDrivableRoutine()（序列回放交给 coder 层逐帧闸）',
    guards.length === 3, `实测 ${guards.length}`);
  // 前 3 个调用点（菜单 / execRoutine / .actRun）严格配对：guard[i] < call[i] < guard[i+1]。
  const early = [calls[0], calls[1], calls[3]];
  const paired = early.every((pos, i) => guards[i] < pos
    && (i + 1 >= guards.length || pos < guards[i + 1] || i === 1));
  ok('3 个早置闸按序紧邻各自调用点（序列调用点无整序列预扫）', paired,
    `guards=[${guards}] calls=[${calls}]`);
  // 闸还必须在会话帧之前，否则「txLog 为空」只是没发 31 而发了 10 40。
  const sessions = [...app.matchAll(/enterSessionFor\('routine'\)/g)].map((m) => m.index);
  const beforeSession = [0, 1, 3].every((ci, i) => sessions.some((s) => guards[i] < s && s < calls[ci]));
  ok('3 处早置闸都在 enterSessionFor 之前（禁用项连会话帧也不发）', beforeSession,
    `sessions=[${sessions}]`);
  ok('coder 层闸把 params 传进策略（序列逐帧判断，不做整序列预扫）',
    /assertDrivableRoutine\(subFunc, routineId, params\)/.test(coder));
  ok('.actRun 带 data-drive-disabled / data-disable-reason',
    /data-drive-disabled=/.test(app) && /data-disable-reason=/.test(app));
  ok('coder.runRoutine 发帧前调用执行侧闸',
    /async function runRoutine[\s\S]{0,400}?assertDrivableRoutine\(/.test(coder));
}

// ③ 动态注入：同一策略在 4 个调用点处都拦住，且 txLog 为空
setRoutineGateItems(items);
const reason = String(sample.driveDisabledReason).trim();
ok('装载真实索引后，样例 rid 被拦且理由来自数据',
  getRoutineGateReason(1, sample.rid) === reason, `rid=${sample.rid}`);
ok('stop(02)/查结果(03) 不受闸约束（正在跑的例程仍可停止/查询）',
  getRoutineGateReason(2, sample.rid) === null && getRoutineGateReason(3, sample.rid) === null);
ok('参数敏感：同一禁用 rid，显式参数非空即放行（431 序列是独立 caller）',
  getRoutineGateReason(1, sample.rid, '01') === null);

const isoTp = (can, payloadHex) => {
  const b = payloadHex.trim().split(/\s+/).map((x) => parseInt(x, 16));
  const h = (x) => x.toString(16).padStart(2, '0');
  if (b.length <= 7) return `${can} ${h(b.length)} ${b.map(h).join(' ')}`;
  const out = [`${can} 10 ${h(b.length)} ${b.slice(0, 4).map(h).join(' ')}`];
  for (let i = 4, seq = 1; i < b.length; i += 7, seq = (seq + 1) & 0xf) {
    out.push(`${can} ${h(0x20 | seq)} ${b.slice(i, i + 7).map(h).join(' ')}`);
  }
  return out.join('\r');
};
/** 假 ELM：calls 就是 txLog；任何写帧都先记在这里。 */
const coderFor = (ridForReply) => {
  const calls = [];
  const elm = {
    mock: true,
    calls,
    async cmd(hex) {
      calls.push(hex);
      // Coder 交给适配器的已经是 payload（CAN 头由 ELM/适配层加），如 `31010400`
      if (/^31/i.test(String(hex))) {
        return isoTp('7E8', `71 01 ${(ridForReply >>> 8).toString(16).padStart(2, '0')} ${(ridForReply & 0xff).toString(16).padStart(2, '0')}`);
      }
      return /^AT/i.test(String(hex)) ? 'OK' : 'NO DATA';
    },
  };
  return { calls, coder: new Coder(elm, { tx: 0x7e0, rx: 0x7e8, ecuName: 'GATE', verbose: false }) };
};

const callSites = [
  '菜单特殊功能 run(sf,verb)',
  '统一入口 execRoutine()',
  '功能序列 runSequence() 31 01',
  '.actRun handler',
];
for (const site of callSites) {
  const toasts = [];
  let guardErr = null;
  try {
    // app.js 在 enterSessionFor 之前调用的同一个函数
    assertDrivableRoutine(1, sample.rid, '', (msg) => toasts.push(msg));
  } catch (e) {
    guardErr = e;
  }
  ok(`${site}：执行侧闸抛出数据里的理由`,
    guardErr && guardErr.message.includes(reason) && toasts.length === 1,
    guardErr ? guardErr.message : '(未抛错)');

  const { calls, coder } = coderFor(sample.rid);
  let runErr = null;
  try {
    await coder.runRoutine(1, sample.rid, '', { poll: false });
  } catch (e) {
    runErr = e;
  }
  ok(`${site}：绕过 UI 直调 runRoutine 也被 coder 层拦住`,
    runErr && runErr.message.includes(reason));
  ok(`${site}：txLog 为空（未发出任何 31 帧）`,
    calls.length === 0 && !calls.some((c) => /31/i.test(String(c))),
    `txLog ${calls.length} 条`);
}

// ③-b 回归：431 功能序列自带参数的 31 帧不能被误伤（2026-11-17）
{
  const seq = JSON.parse(read('../data/function-sequences.json'));
  const fns = Array.isArray(seq) ? seq : (seq.functions || []);
  const disabled = new Set(disabled31.map((e) => e.rid));
  let hit = 0;
  let hitWithParams = 0;
  let example = null;
  for (const f of fns) {
    let blocked = false;
    let blockedWithParams = false;
    for (const c of (f.cmds || [])) {
      const raw = String(c).replace(/\s/g, '').toUpperCase();
      if (!/^31/.test(raw)) continue;
      const sub = parseInt(raw.slice(2, 4), 16);
      const rid = parseInt(raw.slice(4, 8), 16);
      const params = raw.slice(8);
      if ((sub === 0x02 || sub === 0x03) || !disabled.has(rid)) continue;
      blocked = true;
      if (params && getRoutineGateReason(sub, rid, params) === null) {
        blockedWithParams = true;
        if (!example) example = { sub, rid, params, fn: f.name };
      }
    }
    if (blocked) hit += 1;
    if (blockedWithParams) hitWithParams += 1;
  }
  ok('参数敏感闸不再误伤带显式参数的 431 序列帧',
    hit === 186 && hitWithParams === 158 && example !== null,
    `波及序列 ${hit}、其中带参数 ${hitWithParams}；样例 ${example?.fn} 31 ${example?.sub.toString(16).padStart(2, '0')} ${example?.rid.toString(16).padStart(4, '0')} ${example?.params}`);
  if (example) {
    const { calls, coder } = coderFor(example.rid);
    assert.equal(getRoutineGateReason(example.sub, example.rid, example.params), null);
    await coder.runRoutine(example.sub, example.rid, example.params, { poll: false });
    ok('序列样例真的发出 31 帧（整序列预扫已移除）',
      calls.some((c) => /^31/i.test(String(c))), `txLog ${calls.length} 条`);
  }
}

// 恢复：同一个索引下，未禁用的 rid 必须能正常发出 31 帧
{
  const allowed = items.find((e) => e && e.form === '31' && e.driveDisabled !== true
    && Number.isInteger(e.rid) && e.rid !== sample.rid);
  const rid = allowed ? allowed.rid : 0x1234;
  setRoutineGateItems(items);
  assert.equal(getRoutineGateReason(1, rid), null);
  const { calls, coder } = coderFor(rid);
  const r = await coder.runRoutine(1, rid, '', { poll: false });
  ok('恢复后允许 rid 正常执行', !!r.result, `rid=${rid}`);
  ok('恢复后确实发出 31 帧（不是闸把所有例程都关了）',
    calls.length > 0 && calls.some((c) => /^31/i.test(String(c))),
    `txLog ${calls.length} 条`);
}

// 严格模式：索引没装上时不默认放行
{
  setRoutineGateItems([]);
  const why = getRoutineGateReason(1, sample.rid);
  ok('严格模式下索引为空 = 拒绝，理由说明「不许默认放行」',
    typeof why === 'string' && why.includes('不许默认放行'), String(why));
}

console.log(`\n===== 执行侧 driveDisabled 闸：${pass} 通过 / 0 失败 =====`);
