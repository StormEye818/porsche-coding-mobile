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
 * ★ 2026-11-20（阶段 A）：[D] 段的 `can/requestKey` 合成 fixture 已替换为真实
 *   data/bind-plan.json → sweepPlan/selectAddrRows 消费者测试（见 verify-bindplan-
 *   runtime-contract.mjs）；[A]/[B]/[C]/[E] 断言全部保留。
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

console.log('\n[D] 枚举器（src/sweep.js）—— 阶段 A：只测真实 bind-plan 数据消费者');
{
  // ★ 2026-11-20：旧 in-memory `can/requestKey` fixture 恰好命中不存在于生产的
  //   单数形状，造成 47/0 假绿。本段改为直接读 data/bind-plan.json 调真实
  //   sweepPlan/selectAddrRows；不复制适配逻辑、不注入合成条目。
  const { readFileSync } = await import('node:fs');
  const plan = JSON.parse(readFileSync(new URL('../data/bind-plan.json', import.meta.url), 'utf8'));
  const e23 = plan.ecu['0x0e23'];
  const plan23 = sweepPlan({ bindPlan: plan, sysIds: ['0x0e23'] });
  ok('真实数据：0x0e23 选中本代真值行（非空，首行 0x070D/0x0777）',
    plan23.length > 0 && plan23[0].tx === 0x070d && plan23[0].rx === 0x0777,
    `rows=${plan23.length} first=0x${(plan23[0]?.tx ?? 0).toString(16)}/0x${(plan23[0]?.rx ?? 0).toString(16)}`);
  ok('真实数据：rx 取 truth 的 +0x6A，不是 tx+8',
    plan23.length > 0 && /0x6[aA]/.test(plan23[0].rxRule || '') && plan23[0].rx !== plan23[0].tx + 8,
    plan23[0]?.rxRule);
  ok('真实数据：requestKey 来自 requestKeys[] 完整键空间（低 16 位不当 CAN）',
    plan23.length === e23.requestKeys.length
      && plan23.every((r) => e23.requestKeys.includes(r.requestKey)
        && /^0x(0030|FF60)[0-9A-Fa-f]{4}$/.test(r.requestKey)),
    `keys=${new Set(plan23.map((r) => r.requestKey)).size}`);
  ok('真实数据：同 blockOff + 同请求键只留真值首枚（derived 不冒充）',
    plan23.length > 0 && plan23.every((r) => r.source === 'truth' && r.provable === 'static')
      && new Set(plan23.map((r) => `${r.blockOff}|${r.requestKey}`)).size === plan23.length,
    `rows=${plan23.length}`);
  ok('真实数据：0x0e08 七枚请求键可读',
    sweepPlan({ bindPlan: plan, sysIds: ['0x0e08'] }).length === 7
      && plan.ecu['0x0e08'].requestKeys.length === 7);
  ok('真实数据：0x1408 无请求键仍产出显式 fail-closed 候选行',
    (plan.ecu['0x1408']?.requestKeys || []).length === 0
      && selectAddrRows(plan, ['0x1408']).length === 1
      && selectAddrRows(plan, ['0x1408'])[0].requestKey === null);
  const macan = sweepPlan({ bindPlan: plan, sysIds: ['0x0f23', '0x0f34'] });
  ok('真实数据：不同 blockOff 不合并（Macan 0x0f23/0x0f34 双绑）',
    macan.some((r) => r.tx === 0x070d && r.blockOff === '76554')
      && macan.some((r) => r.tx === 0x0723 && r.blockOff === '78214'),
    JSON.stringify(macan.map((r) => ({ tx: r.tx, blockOff: r.blockOff }))));
  ok('真实数据：skip 按 CAN tx 排除，不用 derived 顶替',
    sweepPlan({ bindPlan: plan, sysIds: ['0x0e23'], skip: [0x070d] }).length === 0
      && plan23.length === 33);
  ok('无 bindPlan/sysIds 时返回空（不默认枚举全段）',
    sweepPlan().length === 0 && sweepPlan({ bindPlan: plan }).length === 0);
  const f4d = selectAddrRows(plan, ['0x0f4d']);
  ok('真实数据：0x0f4d 四元对象与 altIdentitySysIds 原样保留',
    plan.ecu['0x0f4d']?.fourTuple?.sysId === '0x0f4d'
      && f4d.length > 0 && f4d[0].altIdentitySysIds.join() === '0x0e5f,0x0e60',
    JSON.stringify(f4d[0]?.altIdentitySysIds || []));
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
