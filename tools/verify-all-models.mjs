#!/usr/bin/env node
/**
 * verify-all-models.mjs — RE-CODINGADDR §6 五步规则「推广到全量车型」的回归门禁。
 *
 * 覆盖：
 *  [A] 步骤1 换表：all-model-sysids.json 平台→代际（精确交集）、代际一致性、
 *      981 回归、low/unresolved 不覆盖。
 *  [B] 运行时：src/model-sysid-map.js 按车型解析（Macan/G1/992/Taycan/981/986）。
 *  [C] 步骤2 路由：sysdata-routing.json 22 锚点 / byGeneration / 根表 22 type。
 *  [D] 步骤3 绑定计划：bind-plan.json 981 五项验收 + 全代条目 + 0x0B 对账基线。
 *  [E] 步骤4 编码地址：coding-address-sources.json 全库无 SYS_DATA 流 → ALLDATA coding 池。
 *  [F] 步骤5 comm 键：comm-shared-keys.json 共享键 0x03A7 锚点。
 *
 * 跑法： node tools/verify-all-models.mjs （已接入 npm test 末尾）
 */
import { readFileSync } from 'node:fs';
import { sysIdForModule, platformSysIdByLowByte, modulesForSysId, MODEL_SYSID_INDEX } from '../src/model-sysid-map.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); }
};
const J = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));

const allm = J('all-model-sysids.json');
const routing = J('sysdata-routing.json');
const rootTable = J('sysdata-root-table.json');
const plan = J('bind-plan.json');
const cas = J('coding-address-sources.json');
const comm = J('comm-shared-keys.json');

console.log('\n[A] 步骤1 换表（全车型 sysIds）');
{
  ok('14 平台 / 25 车型', Object.keys(allm.platforms).length === 14 && Object.keys(allm.models).length === 25);
  const p981 = allm.platforms['9X1'];
  ok('9X1 → 0x0e（981 定案自证）', p981?.gen === '0x0e' && p981.confidence === 'high');
  ok('9X1 → 48 模块已验收表', p981?.modulesResolved === 48 && Object.keys(p981.modules).length === 48);
  const badGen = [];
  for (const [p, e] of Object.entries(allm.platforms)) {
    if (!e.gen) continue;
    for (const [n, m] of Object.entries(e.modules)) {
      if (!m.sysId) continue;
      if (m.sysId.slice(0, 4) !== e.gen && !(p === '9X1' && m.sysId === '0x0f4d')) badGen.push(`${p}/${n}/${m.sysId}`);
    }
  }
  ok('所有模块 sysId 代际与平台一致（LCA 0x0f4d 已验收特例除外）', badGen.length === 0, badGen.slice(0, 3).join(','));
  const weak = Object.entries(allm.platforms).filter(([, e]) => !['high', 'medium'].includes(e.confidence));
  ok('low/unresolved 平台不启用覆盖（不猜）', weak.length >= 4 && weak.every(([, e]) => e.gen === null || e.confidence !== 'high'));
  const applied = Object.values(allm.models).filter((m) => m.applyPlatformSysIds).length;
  ok(`车型启用平台专属映射 ≥17（实际 ${applied}）`, applied >= 17);
}

console.log('\n[B] 运行时按车型解析（src/model-sysid-map.js）');
{
  ok('981 IC 与全局表一致', sysIdForModule('Kombiinstrument_MM', 'Cayman（981）') === '0x0e08');
  ok('Macan ACC3 → 0x0f40', sysIdForModule('ACC3', 'Macan') === '0x0f40');
  ok('Cayenne 9PA ACC3 → 0x0c40', sysIdForModule('ACC3', 'Cayenne-9PA（至2010年款止）') === '0x0c40');
  ok('992 BV_AirbaUDS → 0x14xx', /^0x14/.test(sysIdForModule('BV_AirbaUDS', '911（992）') || ''));
  ok('Taycan → 0x15 代', MODEL_SYSID_INDEX['Taycan']?.gen === '0x15');
  ok('中文标签按家族低字节平移：IC(仪表) Macan → 0x0f08',
    platformSysIdByLowByte('0x0e08', 'Macan') === '0x0f08');
  ok('中文标签 981 不变：IC(仪表) → 0x0e08',
    platformSysIdByLowByte('0x0e08', 'Cayman（981）') === '0x0e08');
  ok('986（unresolved）→ null（回退全局，不猜）', sysIdForModule('Airbag', 'Boxster（986）') === null);
  ok('平台 sysId 反查模块名', modulesForSysId('0x0f40', 'Macan').includes('ACC3'));
  ok('未选车型 → 平台函数不启用', platformSysIdByLowByte('0x0e08', null) === null);
}

console.log('\n[C] 步骤2 路由表（全代）');
{
  ok('721 条 / 110 owner', routing.stats.records === 721 && routing.stats.owners === 110);
  ok('22/22 锚点通过', routing.stats.anchorsPassed === 22 && routing.stats.anchorsChecked === 22);
  ok('byGeneration ≥10 代', Object.keys(routing.byGeneration || {}).length >= 10,
    Object.keys(routing.byGeneration || {}).length + ' 代');
  ok('根表 22 type 且代际自证 ≥18', rootTable.stats.types === 22 && rootTable.stats.genConsistentTypes >= 18,
    `${rootTable.stats.genConsistentTypes}/22`);
  ok('0x0E0C DME 路由组有 0x7E1', routing.byOwner['0x0E0C']?.some((r) => r.can.toLowerCase() === '0x7e1'));
}

console.log('\n[D] 步骤3 绑定计划（全代多源）');
{
  const cands = (sid) => (plan.ecu[sid]?.cands || []).map((c) => parseInt(c, 16));
  ok('981 DME=0x7E0', cands('0x0e01').includes(0x7E0));
  ok('981 PASM 含 0x7D0（跨代路由行）', cands('0x0e13').includes(0x7D0));
  ok('981 IC=0x7F1', cands('0x0e08').includes(0x7F1));
  ok('981 IC ≠ PSM（集合无交集）',
    !cands('0x0e08').some((c) => cands('0x0e05').includes(c)));
  const s981 = J('981-sysids.json');
  const resolved = Object.values(s981.modules).filter((m) => (m.sysIds || []).some((s) => cands(s).length)).length;
  ok(`981 ≥40/48 静态解出（实际 ${resolved}）`, resolved >= 40);
  ok('0x0B 对账基线：IC cands=[0x07F1]',
    JSON.stringify(plan.ecu['0x0b08']?.cands) === '["0x07F1"]');
  ok('0x0B 对账基线：PASM 含 0x07D0', cands('0x0b13').includes(0x7D0));
  const allSids = Object.keys(plan.ecu);
  ok('新代 0x10+ 条目已建立', allSids.some((s) => s.startsWith('0x10')) && allSids.some((s) => s.startsWith('0x14')));
  ok('全车型 coverage 已算且 ≥300 模块静态',
    Object.values(plan.coverage || {}).reduce((a, c) => a + (c.static || 0), 0) >= 300);
  ok('候选全部落在诊断段 0x600-0x7FF',
    Object.values(plan.ecu).every((e) => (e.cands || []).every((c) => {
      const v = parseInt(c, 16); return v >= 0x600 && v <= 0x7ff;
    })));
}

console.log('\n[E] 步骤4 编码地址来源');
{
  ok('全库 name 记录 3958 条', cas.stats.nameRecords === 3958);
  ok('无 SYS_DATA 编码地址流（全车型统一走 ALLDATA coding 池）',
    (cas.stats.sysDataStream || 0) === 0 && cas.streams.length === 0);
  ok('981/9X1 来源=allDataCodingPool', cas.platforms['9X1']?.source === 'allDataCodingPool');
  ok('所有平台来源均有证据（无 unresolved）',
    Object.values(cas.platforms).every((p) => p.source !== 'unresolved'));
}

console.log('\n[F] 步骤5 comm 共享键');
{
  ok('comm 记录 ≥400 条', comm.stats.parsedCommRecords >= 400);
  ok('共享键 0x03A7 锚点（≥2 个 sysId）', (comm.sharedKeys['0x03A7']?.sysIdCount || 0) >= 2);
  ok('flag 只含 0x10/0x20', Object.keys(comm.stats.flagCounts).every((f) => ['0x0010', '0x0020'].includes(f)));
}

console.log(`\n===== 全车型推广门禁：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
