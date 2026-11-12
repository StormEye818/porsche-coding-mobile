#!/usr/bin/env node
/**
 * 431 对齐线 · 新机制的单元测试（与 smoke-fixes.mjs 分开，避免污染既有断言集）。
 *
 * 覆盖 2026-11-10 审计后的 P0 基础设施：
 *   [A] frameIdsOf —— 回帧 CAN ID 抽取（空格 / 11 位连写 / 29 位）
 *   [B] atCmdOk   —— 绑定回执（`?` 报死，空回执不阻断）
 *
 * 跑法: node tools/test-align431.mjs
 */
import { frameIdsOf, atCmdOk } from '../src/coder.js';
import { sweepPlan, rxFor, classifyProbe, moduleFromIdent, buildModuleMap, cacheFresh } from '../src/sweep.js';
import { Elm327 } from '../src/elm327.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); }
};

console.log('\n[A] frameIdsOf —— 回帧 ID 抽取');
{
  ok('空格分隔 11 位', JSON.stringify(frameIdsOf('7E8 03 7F 22 12')) === '[2024]',
    JSON.stringify(frameIdsOf('7E8 03 7F 22 12')));
  ok('ATS0 连写 11 位', JSON.stringify(frameIdsOf('7E8037F2212')) === '[2024]',
    JSON.stringify(frameIdsOf('7E8037F2212')));
  ok('多行多帧（含 SF/CF）',
    JSON.stringify(frameIdsOf('7E8 10 13 5A 90 57\r7E8 21 30 41 42')) === '[2024,2024]',
    JSON.stringify(frameIdsOf('7E8 10 13 5A 90 57\r7E8 21 30 41 42')));
  ok('29 位 ID', JSON.stringify(frameIdsOf('18DAF110 03 7F 22 12')) === '[417001744]',
    JSON.stringify(frameIdsOf('18DAF110 03 7F 22 12')));
  ok('NO DATA / 空 → 无 ID', frameIdsOf('NO DATA').length === 0 && frameIdsOf('').length === 0);
  ok('回显行不算 ID', frameIdsOf('ATSH7F1\rOK').length === 0, JSON.stringify(frameIdsOf('ATSH7F1\rOK')));
}

console.log('\n[B] atCmdOk —— 绑定回执');
{
  class P {
    constructor(reply) { this.reply = reply; this.handlers = []; }
    write() { const r = this.reply; setTimeout(() => this.handlers.forEach((h) => h(new TextEncoder().encode(r))), 0); }
    on(_e, cb) { this.handlers.push(cb); }
  }
  const mk = (reply) => new Elm327(new P(reply), { timeoutMs: 200 });

  let threw = false;
  try { await atCmdOk(mk('?\r>'), 'ATSH7F1', 200); } catch (e) { threw = e.code === 'AT_NOT_OK'; }
  ok('适配器回 `?` → 报死 AT_NOT_OK', threw);

  threw = false;
  try { await atCmdOk(mk('OK\r>'), 'ATSH7F1', 200); } catch { threw = true; }
  ok('适配器回 OK → 通过', !threw);

  // 空回执（超时）：不阻断 —— 真错址由回帧 ID 校验兜住
  threw = false;
  try { await atCmdOk(mk('\r>'), 'ATSH7F1', 200); } catch { threw = true; }
  ok('空回执不阻断（留痕）', !threw);

  // 没有 cmdOk 的旧桩：退回裸 cmd，不炸
  const bare = { cmd: async () => 'OK' };
  const r = await atCmdOk(bare, 'ATSH7F1', 100);
  ok('裸适配器（无 cmdOk）退回 cmd', r === 'OK');
}

console.log('\n[C] 绑定计划（data/bind-plan.json）');
{
  const { readFileSync } = await import('node:fs');
  const plan = JSON.parse(readFileSync(new URL('../data/bind-plan.json', import.meta.url), 'utf8'));
  const ic = plan.ecu['0x0b08'];
  ok('IC 混合 n → 禁止直绑（不能跨行吞并）', ic && ic.nMixed === true && ic.bindDirect === false, JSON.stringify(ic));
  ok('所有直绑条目均为全行 n=0 且唯一合法地址',
    Object.values(plan.ecu).filter((e) => e.bindDirect)
      .every((e) => e.n === 0 && e.nMixed === false && e.pairs?.length === 1));
  ok('IC 候选只含 0x7F1', ic && ic.cands.length === 1 && ic.cands[0].toLowerCase() === '0x07f1', JSON.stringify(ic && ic.cands));
  const pdc = plan.ecu['0x0b12'];
  ok('PDC 候选含已证 0x7CF', pdc && pdc.cands.some((c) => c.toLowerCase() === '0x07cf'), JSON.stringify(pdc && pdc.cands));
  const pasm = plan.ecu['0x0b13'];
  ok('PASM n=1 → 走探针（非直绑）', pasm && pasm.bindDirect === false && pasm.cands.some((c) => c.toLowerCase() === '0x07d0'), JSON.stringify(pasm));
  // ★ 2026-11-12：旧代 KWP 的 comm cat=0x10 地址对落在 0x05xx/0x06xx（包内精确证据），
  //   不属于 UDS 0x600-0x7FF 段。改为「合法 11 位 + 低段须有本 ECU/同代 comm 证据」双闸。
  ok('全部地址对合法 11 位请求/应答（0<tx≤0x7F7, 0<rx≤0x7FF）',
    Object.values(plan.ecu).every((e) => (e.pairs || []).every((p) => {
      const tx = parseInt(p.tx, 16), rx = parseInt(p.rx, 16);
      return tx > 0 && tx <= 0x7f7 && rx > 0 && rx <= 0x7ff;
    })));
  const lowSeg = Object.entries(plan.ecu).flatMap(([sid, e]) => (e.cands || [])
    .filter((c) => parseInt(c, 16) < 0x600)
    .map((c) => ({ sid, prov: JSON.stringify(e.provenance || []) })));
  ok('非 UDS 段候选 (<0x600) 全部来自旧代 comm 地址证据',
    lowSeg.every((x) => (parseInt(x.sid, 16) >> 8) <= 0x0f && /commCat10/.test(x.prov)),
    `低段候选 ${lowSeg.length} 条`);
  ok('pairs 保留原始 rx（IC = 0x7F1/0x7F9）',
    ic && ic.pairs && ic.pairs[0].tx.toLowerCase() === '0x07f1' && ic.pairs[0].rx.toLowerCase() === '0x07f9',
    JSON.stringify(ic && ic.pairs));
  ok('firstRead 是合法读帧（22 xxxx / 21 xx / 1A xx）',
    ic && /^(22[0-9A-F]{4}|21[0-9A-F]{2}|1A[0-9A-F]{2})$/.test(ic.firstRead || ''), ic && ic.firstRead);
}

console.log('\n[D] 枚举器（src/sweep.js）');
{
  const plan = sweepPlan({ from: 0x7e0, to: 0x7e3 });
  ok('sweepPlan 生成 4 个候选且 rx=tx+8', plan.length === 4 && plan[0].tx === 0x7e0 && plan[0].rx === 0x7e8,
    JSON.stringify(plan[0]));
  ok('sweepPlan 支持 skip', sweepPlan({ from: 0x7e0, to: 0x7e3, skip: [0x7e1] }).length === 3);
  ok('rxFor 11 位 +8', rxFor(0x7cf) === 0x7d7);
  ok('回帧 ID 不符 → wrong-id', classifyProbe({ tx: 0x7f1, rx: 0x7f9 }, [0x7e8], '7F2212') === 'wrong-id');
  ok('回帧 ID 相符 + 有 body → alive', classifyProbe({ tx: 0x7f1, rx: 0x7f9 }, [0x7f9], '7F2212') === 'alive');
  ok('无 body → silent', classifyProbe({ tx: 0x7f1, rx: 0x7f9 }, [0x7f9], '') === 'silent');
  ok('恰好没有 ID 时按 body 判', classifyProbe({ tx: 0x7f1, rx: 0x7f9 }, [], '621102') === 'alive');
  const iv = { P200: [{ module: 'DME_BDE_Continental', variant: 'x' }], '050018': [{ module: 'BCM_vorne' }] };
  ok('识别码 → 模块（精确）', moduleFromIdent('P200', iv).join() === 'DME_BDE_Continental');
  ok('识别码 → 模块（带空格/前缀）', moduleFromIdent('P200 extra', iv).includes('DME_BDE_Continental'));
  ok('未知识别码 → 空', moduleFromIdent('ZZZ', iv).length === 0);
  const live = [
    { tx: 0x7e0, rx: 0x7e8, ident: 'P200', modules: ['DME_BDE_Continental'] },
    { tx: 0x721, rx: 0x729, ident: '050018', modules: ['BCM_vorne'] },
  ];
  const map = buildModuleMap(live, ['DME_BDE_Continental']);
  ok('buildModuleMap 按菜单过滤', !!map.DME_BDE_Continental && !map.BCM_vorne);
  ok('缓存：同 VIN 新鲜', cacheFresh({ vin: 'A', ts: Date.now() }, 'A') === true);
  ok('缓存：换 VIN 失效', cacheFresh({ vin: 'A', ts: Date.now() }, 'B') === false);
  ok('缓存：过期失效', cacheFresh({ vin: 'A', ts: Date.now() - 25 * 3600e3 }, 'A') === false);
}

console.log('\n[E] 探活判据（NO DATA 不是应答）');
{
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const { parseRespAuto } = await import('../src/coder.js');
  ok('`NO DATA` → body 为空', parseRespAuto('NO DATA').body.length === 0);
  ok('`NO DATA` + 帧头 → body 为空', parseRespAuto('7E8 NO DATA').body.length === 0);
  ok('NRC 有 body（活着）', parseRespAuto('7F9 03 7F 22 12', '221409', 0x22).body.length === 3);
  // 源码口径：链上必须按 body 判，不能按原始文本非空判
  ok('探测链按 body 判空（不以原始文本为准）',
    /if \(!body\) \{ note\(`\$\{cmd\} → 无应答/.test(app));
  ok('A8 表已删除', !/PROBE_CMDS_BY_BLOCKKEY/.test(app));
}

console.log(`\n===== 对齐基础设施：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
