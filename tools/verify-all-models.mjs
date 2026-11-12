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
import { sysIdForModule, modulesForSysId, planSysIdFor, MODEL_SYSID_INDEX } from '../src/model-sysid-map.js';

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
  ok('中文标签只在 981 生效（非 981 返回 null，不跨代平移）',
    planSysIdFor('IC(仪表)', [], 'Macan', null) === null);
  ok('986（unresolved）→ null（回退全局，不猜）', sysIdForModule('Airbag', 'Boxster（986）') === null);
  ok('平台 sysId 反查模块名', modulesForSysId('0x0f40', 'Macan').includes('ACC3'));
  // ★ 2026-11-11 全链路审计 P0 回归：新代 sysId 不在 ecu-addresses.json，
  //   bind-plan 键必须能由平台映射直查得到（否则 191 个静态候选运行时不可达）。
  ok('planSysIdFor 992 安全气囊 → 0x1404（旧表无条目）',
    planSysIdFor('安全气囊', ['BV_AirbaUDS'], '911（992）', null) === '0x1404');
  ok('planSysIdFor Macan CCS/ACC → 0x0f40',
    planSysIdFor('CCS/ACC(巡航控制系统)', ['ACC3'], 'Macan', null) === '0x0f40');
  ok('planSysIdFor 981 安全气囊 → 0x0e04（回归不变）',
    planSysIdFor('安全气囊', ['Airbag'], 'Cayman（981）', null) === '0x0e04');
  ok('planSysIdFor 未定案平台用旧表 sysId（不套 981 值）',
    planSysIdFor('安全气囊', ['Airbag'], 'Boxster（986）', '0x0b04') === '0x0b04');
  // 新代 sysId 在 bind-plan 里有条目且有候选（P0 修复的可达性前提）
  ok('992 0x1404 在 bind-plan 有候选', (plan.ecu['0x1404']?.cands || []).length > 0);
  ok('992 0x1404 不在 ecu-addresses（旧表缺口实证）',
    !J('ecu-addresses.json').entries.some((e) => e.sysId?.toLowerCase() === '0x1404'));
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

console.log('\n[G] 全链路审计 P0 回归（2026-11-11）');
{
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  ok('编程页不再引用未定义的 uds（P0-1）',
    !/securityAccess\(0x09,\s*!uds\)/.test(app));
  ok('写帧标识符位宽不再按 readSid 推导（P0-2）',
    !/idPad:\s*readSid/.test(app) && /writePad:\s*writeSid === 0x2E/.test(app));
  ok('恢复备份页位宽/族判定已拆分（P0-3）',
    /const writeWide = writeSid === 0x2E/.test(app) && /const isKwp = readSid !== 0x22/.test(app));
  ok('bind-plan 键按平台 sysId 直查（P0-4）',
    /planSysIdFor\(label, opts\.modules, currentModel, entry\?\.sysId\)/.test(app));
  ok('退出会话不再有未 await 的裸 try/catch（P2）',
    !/try \{ coder\.uds\('1003'/.test(app));
}

console.log('\n[H] 2026-11-11 原厂对齐改造回归');
{
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const coder = readFileSync(new URL('../src/coder.js', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../src/schema.js', import.meta.url), 'utf8');
  const variant = readFileSync(new URL('../src/variant.js', import.meta.url), 'utf8');
  const probe = readFileSync(new URL('../src/probe.js', import.meta.url), 'utf8');
  // ① 读 VIN：去掉自创形态校验；autoSearch 不预建 10 89
  ok('读 VIN 无 looksVin/looksLikePartNo 自创防御层',
    !/const looksVin\s*=/.test(coder) && !/looksLikePartNo\(/.test(coder));
  ok('autoSearch 不再预跑 enterSession(0x89)',
    !/async function autoSearch[\s\S]{0,4000}await coder\.enterSession\(/.test(app));
  ok('VIN 只按长度判完整/前缀（无 ISO 正则校验代码）',
    !/\.test\(vin\)[\s\S]{0,40}WP\[01\]/.test(app));
  // ② 年款三档 + 显示串全等 + 平台参数
  ok('年款三档基数（1971/2001/2031）', /\+\s*1971/.test(app) && /\+\s*2031/.test(app));
  ok('显示串按基名全等（无 includes 子串）',
    /base\(m\) === want/.test(variant) && !/models\.find\(\(m\) => String\(m\)\.includes/.test(variant));
  ok('pickFamilyByEvidence 传 platform', /platform: platformForModel\(currentModel\)/.test(app));
  ok('车身型式精化死代码已删', !/const cross = narrowed/.test(app));
  // ③ 进模块：n=0 零探针、每候选 1 帧、无 alias/模糊 join/低字节平移
  ok('n=0 不发探针帧（ATSH/ATCRA 即绑定）', /ATSH\/ATCRA OK → n=0 链路绑定/.test(app));
  ok('族探针链每族单帧', /family === 'kwp'\) return \['1A9F'\]/.test(app) && /return \['221409'\]/.test(app));
  ok('aliasEntryFor 已删除', !/function aliasEntryFor/.test(app));
  ok('familyFor 无模糊 includes 键查找', !/N\.includes\(k\) && k\.length/.test(app));
  ok('identTextMatch 走原厂原语（identMatch）', /identMatch\(text, keys\)/.test(app));
  ok('无低字节跨代平移（import 与调用均无）',
    !/import \{[^}]*platformSysIdByLowByte/.test(app) && !/platformSysIdByLowByte\(/.test(app));
  // ④ 读写：安全增强默认关
  ok('SAFETY 默认全关', /range: false/.test(schema) && /autoRestore: false/.test(schema) && /addrState: false/.test(schema));
  ok('值域闸默认 opt-in', /SAFETY\.range && !fieldInRange/.test(app) && /SAFETY\.range && !fieldInRange/.test(coder));
  ok('回读不一致默认不回滚（记录失败）', /!SAFETY\.autoRestore[\s\S]{0,200}记录失败/.test(coder));
  ok('写路径 skipIdent（不重跑识别链）', /enterSession\(sess, \{ skipIdent: true, strictSession: true \}\)/.test(coder));
  // ★ 2026-11-12 逐 ECU 原厂会话：写路径会话号必须由 resolveSession() 取证据，
  //   不得再出现 `session = 0x89` 这种硬编码默认值。
  ok('会话号由证据驱动（不再硬编码 0x89 默认值）',
    /const sess = this\.resolveSession\(session\)/.test(coder)
    && !/session = 0x89/.test(coder)
    && /oemSessionFor/.test(coder));
  ok('恢复页无读服务拒写（不再猜 readSid）', /备份无读服务（读不到=不写）/.test(app));
  // ⑤ 匿名化：源码不得出现第三方工具字样
  ok('源码无第三方工具字样', !app.includes('4' + '31') && !coder.includes('4' + '31')
    && !schema.includes('4' + '31') && !variant.includes('4' + '31') && !probe.includes('4' + '31'));
}

console.log(`\n===== 全车型推广门禁：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
