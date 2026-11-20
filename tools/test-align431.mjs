#!/usr/bin/env node
/**
 * 参考诊断仪对齐线 · 新机制的单元测试（与 smoke-fixes.mjs 分开，避免污染既有断言集）。
 *
 * 覆盖 2026-11-10 审计后的 P0 基础设施：
 *   [A] frameIdsOf —— 回帧 CAN ID 抽取（空格 / 11 位连写 / 29 位）
 *   [B] atCmdOk   —— 绑定回执（`?` 报死，空回执不阻断）
 *   [C] 绑定计划  —— T02 全代真值（IC 0x0714/0x077E，不再 0x7F1 唯一真值）
 *   [D] 枚举器    —— T03 新契约：静态 addrBlock 选行 + rx 取表（无 rxFor / 无 +8 推导）
 *   [E] 探活判据  —— NO DATA 不是应答
 *
 * ★ 2026-11-20（impl-contract-fix）：T03 删除了 rxFor 与逐地址扫描，旧断言导入即失败
 *   导致整文件 0 断言执行。本版同步新 431 真值与新运行时 API，逐条钉住防止回归，
 *   不放宽任何旧判据。
 *
 * 跑法: node tools/test-align431.mjs
 */
import { frameIdsOf, atCmdOk } from '../src/coder.js';
import {
  PROBE_FRAME,
  PROBE_FRAMES_PER_CANDIDATE,
  RAW_IDENTITY_COLLISIONS,
  classifyProbe,
  selectAddrRows,
  sweepPlan,
  moduleFromIdent,
  identityFromNameAndPart,
  buildModuleMap,
  cacheFresh,
} from '../src/sweep.js';
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

console.log('\n[C] 绑定计划（data/bind-plan.json）—— T02 全代真值');
{
  const { readFileSync } = await import('node:fs');
  const plan = JSON.parse(readFileSync(new URL('../data/bind-plan.json', import.meta.url), 'utf8'));
  const ic = plan.ecu['0x0b08'];
  ok('IC 混合 n → 禁止直绑（不能跨行吞并）', ic && ic.nMixed === true && ic.bindDirect === false, JSON.stringify(ic));
  ok('所有直绑条目均为全行 n=0 且唯一合法地址',
    Object.values(plan.ecu).filter((e) => e.bindDirect)
      .every((e) => e.n === 0 && e.nMixed === false && e.pairs?.length === 1));
  // ★ T02 真值：IC 首选候选必须是 comm cat=0x10 的 0x0714（A>>5/C>>5 可离线复算），
  //   旧代表A 0x7F1 只作为保留候选，不再是唯一真值。
  ok('IC 候选含 431 真值 0x0714（不再把 0x7F1 当唯一真值）',
    ic && ic.cands.some((c) => c.toLowerCase() === '0x0714')
      && !(ic.cands.length === 1 && ic.cands[0].toLowerCase() === '0x07f1'),
    JSON.stringify(ic && ic.cands));
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
  // ★ T02 真值：pairs 首枚必须是 0x0714/0x077E，rx=tx+0x6A（来自 comm cat=0x10 原值），
  //   0x7F1/0x7F9 退居 derived 保留位，不再当首选/唯一真值。
  ok('pairs 首枚为 431 真值 0x0714/0x077E（rx=tx+0x6A，静态可复算）',
    ic && ic.pairs && ic.pairs.length >= 1
      && ic.pairs[0].tx.toLowerCase() === '0x0714'
      && ic.pairs[0].rx.toLowerCase() === '0x077e'
      && /0x6[aA]/.test(ic.pairs[0].rxRule || '')
      && ic.pairs[0].provable === 'static',
    JSON.stringify(ic && ic.pairs));
  ok('pairs 不再把 0x7F1/0x7F9 当唯一/首选真值',
    ic && ic.pairs && !(ic.pairs.length === 1
      && ic.pairs[0].tx.toLowerCase() === '0x07f1'
      && ic.pairs[0].rx.toLowerCase() === '0x07f9'));
  ok('firstRead 是合法读帧（22 xxxx / 21 xx / 1A xx）',
    ic && /^(22[0-9A-F]{4}|21[0-9A-F]{2}|1A[0-9A-F]{2})$/.test(ic.firstRead || ''), ic && ic.firstRead);
}

console.log('\n[D] 枚举器（src/sweep.js）—— T03 新契约：静态选行 + rx 取表');
{
  // ★ T03：不再逐地址扫描（0x7e0..0x7e3）、不再 rxFor(tx)=tx+8 推导。
  //   候选只来自 bindPlan 的静态 addrBlock；rx 原样取记录 C>>5（本例 +0x6A）。
  //   用最小 in-memory fixture 真执行，避免把旧 D 级「全段枚举」写回测试。
  const fixture = {
    ecu: {
      '0xaaaa': {
        can: { tx: 0x0714, rx: 0x077e, rxRule: 'rx=tx+0x6A', provable: 'static' },
        requestKey: ['0x003006CC'], blockOff: '21100', name: 'FIXTURE_A',
      },
      '0xbbbb': {
        can: { tx: 0x0714, rx: 0x077e, rxRule: 'rx=tx+0x6A', provable: 'static' },
        requestKey: ['0x003006CC'], blockOff: '21183', name: 'FIXTURE_B',
      },
      '0xcccc': {
        can: { tx: 0x0730, rx: 0x0738, rxRule: 'rx=tx+8', provable: 'static' },
        requestKey: ['0x003006CC'], blockOff: '21100', name: 'FIXTURE_DUP',
      },
      '0xdddd': {
        can: { tx: 0x0740, rx: 0x0748, rxRule: 'rx=tx+8', provable: 'derived' },
        requestKey: ['0x003006DD'], blockOff: '21500', name: 'FIXTURE_DERIVED',
      },
    },
  };
  const sysIds = ['0xaaaa', '0xbbbb', '0xcccc', '0xdddd'];
  const plan = sweepPlan({ bindPlan: fixture, sysIds });
  ok('sweepPlan 按静态 addrBlock 选行（非 0x7e0..0x7e3 逐地址枚举）',
    plan.length === 2 && plan.some((r) => r.blockOff === '21100') && plan.some((r) => r.blockOff === '21183'),
    JSON.stringify(plan.map((r) => ({ tx: r.tx, rx: r.rx, blockOff: r.blockOff }))));
  ok('sweepPlan 的 rx 取自静态表 C>>5（+0x6A），不是 tx+8',
    plan.length === 2 && plan.every((r) => r.rx === 0x077e && r.rx !== r.tx + 8),
    JSON.stringify(plan.map((r) => ({ tx: r.tx, rx: r.rx, rxRule: r.rxRule }))));
  ok('sweepPlan 不同 blockOff 不共用（Macan 双绑语义）',
    plan.filter((r) => r.tx === 0x0714 && r.rx === 0x077e).length === 2
      && new Set(plan.map((r) => r.blockOff)).size === 2);
  ok('sweepPlan 同 blockOff + 同请求键去重',
    plan.length === 2 && !plan.some((r) => r.tx === 0x0730),
    JSON.stringify(plan.map((r) => r.tx)));
  ok('sweepPlan 只收 provable=static（derived 候选被拒）',
    !plan.some((r) => r.tx === 0x0740) && selectAddrRows(fixture, ['0xdddd']).length === 0);
  ok('sweepPlan 保留请求键作绑定入参（不取低 16 位当 CAN）',
    plan.length === 2 && plan.every((r) => r.requestKey === '0x003006CC' && r.tx === 0x0714),
    JSON.stringify(plan.map((r) => r.requestKey)));
  ok('sweepPlan 支持 skip（按 CAN tx 排除，不生成）',
    sweepPlan({ bindPlan: fixture, sysIds, skip: [0x0714] }).length === 0
      && sweepPlan({ bindPlan: fixture, sysIds, skip: [0x0730] }).length === 2);
  ok('无 bindPlan/sysIds 时返回空（不默认枚举全段）',
    sweepPlan().length === 0 && sweepPlan({ bindPlan: fixture }).length === 0);
  ok('每候选仅 1 帧探针 221409（非 9 帧枚举）',
    PROBE_FRAME === '221409' && PROBE_FRAMES_PER_CANDIDATE === 1,
    `${PROBE_FRAME}/${PROBE_FRAMES_PER_CANDIDATE}`);
  ok('0x0f4d 与 0x0e5f 同 CAN raw 不合并（身份碰撞表）',
    RAW_IDENTITY_COLLISIONS.some((c) => c.raw === '0xE9C0F700'
      && c.entries.some((e) => e.sysId === '0x0f4d')
      && c.entries.some((e) => e.sysId === '0x0e5f')),
    JSON.stringify(RAW_IDENTITY_COLLISIONS.map((c) => c.raw)));
  ok('identityFromNameAndPart 按名字串裁决（match）',
    identityFromNameAndPart('P200', null, {
      identToVariant: { P200: [{ module: 'DME_BDE_Continental' }] }, partToModule: {},
    }).modules.join() === 'DME_BDE_Continental');
  // 以下旧断言全部保留。
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
