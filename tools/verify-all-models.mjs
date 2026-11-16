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
import { readFileSync, readdirSync } from 'node:fs';
import { sysIdForModule, modulesForSysId, planSysIdFor, MODEL_SYSID_INDEX } from '../src/model-sysid-map.js';
import { isCharNum, vinCharsetFilter } from '../src/coder.js';
import { MODEL_NAME_TABLE, matchModelNameExact } from '../src/model-name-table.js';

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
      // HB-1：E1_ 跨代模块按静态规则归 type 0x03（m.type 与平台 canonicalType 不同属预期）。
      const expectedGen = String(m.type || e.gen).toLowerCase();
      if (m.sysId.slice(0, 4).toLowerCase() !== expectedGen && !(p === '9X1' && m.sysId === '0x0f4d')) badGen.push(`${p}/${n}/${m.sysId}`);
    }
  }
  ok('所有模块 sysId 代际与 (m.type | 平台 gen) 一致（E1_ 跨代 0x03 / LCA 0x0f4d 特例除外）',
    badGen.length === 0, badGen.slice(0, 3).join(','));
  // ★ 2026-11-13 HB-1 收口：全 14 平台均由 DSN.BIN 模块索引表 +
  //   canonicalType 严格超集硬校验产出唯一 (module,type,fullSysId)，
  //   无 low/unresolved 平台、无 gen=null、无「未启用覆盖」。
  //   改为唯一映射断言：所有平台 gen 非空、模块表非空、车型全部启用。
  const weak = Object.entries(allm.platforms).filter(([, e]) => !['high', 'medium'].includes(e.confidence));
  const noGen = Object.entries(allm.platforms).filter(([, e]) => !e.gen);
  const emptyModules = Object.entries(allm.platforms).filter(([, e]) =>
    !e.modules || Object.keys(e.modules).length === 0);
  const unapplied = Object.entries(allm.models || {}).filter(([, m]) => !m.applyPlatformSysIds);
  ok('全 14 平台均有唯一静态映射（无 low/unresolved、无 gen=null、无未启用覆盖）',
    weak.length === 0 && noGen.length === 0 && emptyModules.length === 0 && unapplied.length === 0,
    `弱平台=${weak.length} genNull=${noGen.length} 空模块=${emptyModules.length} 未启用车型=${unapplied.length}`);
  for (const p of ['CS1', 'E1']) {
    const e = allm.platforms[p];
    ok(`${p} 由 DSN 模块索引表显式定案并接入运行时`,
      !!e && e.confidence === 'high' && e.modulesResolved > 0 && !!e.dsnModuleIndex
      && Object.values(e.modules).every((m) => m.method === 'dsn-module-index'),
      e ? `${e.modulesResolved} 模块 @${e.dsnModuleIndex?.payloadOff}` : '缺失');
  }
  for (const [p, canon, expectedMods, expectedMappings] of [['9X6', '0x01', 29, 29], ['9X7', '0x05', 40, 41]]) {
    const e = allm.platforms[p];
    const mods = Object.values(e?.modules || {});
    const allCanonical = mods.every((m) => m.method === 'dsn-module-index' && !!m.sysId);
    // 41/41 映射表：40 条进 runtimeModules + 1 条网关 gatewayNoSysId（不进运行时）。
    const gw = e?.gatewayNoSysId || [];
    ok(`${p} 按 canonicalType ${canon} 唯一映射 ${expectedMappings}/${expectedMappings}（无全局表回退 / 不猜高字节）`,
      !!e && e.gen === canon && e.canonicalType === canon
      && e.confidence === 'high' && e.modulesResolved === expectedMods
      && allCanonical && e.applyPlatformSysIds === true
      && e.dsnModuleIndex?.mappings === expectedMappings
      && mods.length + gw.length === expectedMappings
      && gw.every((g) => g.gatewayNoSysId && !g.inRuntimeModules),
      e ? `gen=${e.gen} canonicalType=${e.canonicalType} 运行时模块=${e.modulesResolved} 映射行=${e.dsnModuleIndex?.mappings} 网关=${gw.length}` : '缺失');
  }
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
  // ★ HB-1 收口：986（9X6）按 canonicalType 0x01 已静态定案；
  //   src/model-sysid-map.js 由生成器统一重建（本批次不碰 src），此处断言数据层唯一映射。
  const p986 = allm.platforms['9X6'];
  ok('986（9X6）→ canonicalType 0x01 唯一映射（无 null 回退）',
    !!p986 && p986.gen === '0x01' && p986.confidence === 'high'
    && Object.keys(p986.modules || {}).length === 29
    && Object.values(p986.modules).every((m) => /^0x[0-9a-fA-F]{4}$/.test(m.sysId || '')),
    p986 ? `gen=${p986.gen} 模块=${Object.keys(p986.modules).length} 车型986=${JSON.stringify(allm.models['Boxster（986）'])}` : '缺失');
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
  // ★ 2026-11-12：旧代 KWP 的 comm cat=0x10 地址对确实落在 0x05xx/0x06xx（如
  //   0x05F1→0x06F1），不是 UDS 的 0x600-0x7FF 段。原「一刀切 ≥0x600」把包内精确
  //   证据误判成脏数据。改为更严格的双闸：全部合法 11 位 + 低段必须有 comm 证据且属旧代。
  ok('全部地址对合法 11 位请求/应答（0<tx≤0x7F7, 0<rx≤0x7FF）',
    Object.values(plan.ecu).every((e) => (e.pairs || []).every((p) => {
      const tx = parseInt(p.tx, 16), rx = parseInt(p.rx, 16);
      return tx > 0 && tx <= 0x7f7 && rx > 0 && rx <= 0x7ff;
    })));
  const lowSeg = Object.entries(plan.ecu).flatMap(([sid, e]) => (e.cands || [])
    .filter((c) => parseInt(c, 16) < 0x600)
    .map((c) => ({ sid, c, prov: JSON.stringify(e.provenance || []) })));
  ok('非 UDS 段候选 (<0x600) 全部来自旧代 comm 地址证据且带 rx',
    lowSeg.every((x) => (parseInt(x.sid, 16) >> 8) <= 0x0f
      && /commCat10/.test(x.prov)),
    `低段候选 ${lowSeg.length} 条 / 涉及 ${new Set(lowSeg.map((x) => x.sid)).size} 个 sysId`);
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
  // ★ 行为断言（替代源码正则）：planSysIdFor 按当前车型平台映射直查，
  //   未定案平台不跨代平移（返回旧表 sysId 兜底），与 981 回归不变。
  ok('planSysIdFor 按平台 sysId 直查（行为断言，非源码正则）',
    planSysIdFor('安全气囊', ['BV_AirbaUDS'], '911（992）', null) === '0x1404'
    && planSysIdFor('CCS/ACC(巡航控制系统)', ['ACC3'], 'Macan', null) === '0x0f40'
    && planSysIdFor('安全气囊', ['Airbag'], 'Cayman（981）', null) === '0x0e04'
    && planSysIdFor('IC(仪表)', [], 'Macan', null) === null);
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
  // ★ 2026-11-16：等待/保活常量数据驱动后新增 src/comm-timeouts.js（值来自原厂侧取证）。
  // ★ 2026-11-17：本文件已不再**点名**它 —— ⑤ 匿名化断言改为扫 src/*.js 全目录，
  //   点名清单只证明「这几个文件干净」，证明不了「要发布的代码干净」。
  //   原注释担心的「长 hex 串被误判」（如 0x4310 含 431）在 ⑤ 里用「先剥 0x 字面量再扫」解决，
  //   不需要退回点名。commTimeouts 变量本身也不再单独保留（⑤ 扫全目录已覆盖它）。
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
  // ★ G7：源码字面量 → 实跑。构造只有一个地址候选的 Coder，断言地址绑定后无探针业务帧。
  {
    const { Coder: CoderCls } = await import('../src/coder.js');
    const { Elm327: ElmCls } = await import('../src/elm327.js');
    const { MockAdapter: MA } = await import('../src/mock-adapter.js');
    const mN = new MA({ latencyMs: 0 });
    const cN = new CoderCls(new ElmCls(mN, { timeoutMs: 40 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    mN.txLog.length = 0;
    try { await cN.address(); } catch { /* 空回执按发帧判定 */ }
    const nFrames = mN.txLog.filter((x) => !x.startsWith('AT'));
    ok('WRITE_G7_N0_NO_PROBE 实跑 address() 后未发探针业务帧（ATSH/ATCRA 即绑定）',
      nFrames.length === 0 && mN.txLog.some((x) => x.startsWith('ATSH')),
      `业务帧=${nFrames.join(',') || '(空)'}`);
  }
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
  // ★ G7：源码字面量 → 实跑。无读服务的参数在写前必须被拒（零发帧）。
  {
    const { Coder: CC } = await import('../src/coder.js');
    const { Elm327: EE } = await import('../src/elm327.js');
    const { MockAdapter: MM } = await import('../src/mock-adapter.js');
    const mA = new MM({ latencyMs: 0 });
    const cA = new CC(new EE(mA, { timeoutMs: 40 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    cA.diagProfile = { verified: true, reason: 'G7 测试授信' };
    mA.txLog.length = 0;
    let rejected = false;
    let reason = '';
    try {
      // readSid 传 0x00（不在 READ_SIDS）→ 必须拒写
      await cA.applyChange({ name: 'x', lid: 0x30, readSid: 0x00, writeSid: 0x2e,
        byte: 0, bit: 0, bitsize: 8 }, 1, { dryRun: false });
    } catch (e) { rejected = true; reason = String(e.message); }
    ok('WRITE_G7_NO_READ_SID 无读服务参数实跑拒写且零业务发帧',
      rejected && mA.txLog.filter((x) => !x.startsWith('AT')).length === 0,
      `rejected=${rejected} reason=${reason.slice(0, 50)}`);
  }
  // ⑤ 匿名化：源码不得出现第三方工具字样
  //
  // ⚠️ 2026-11-17 收紧：原来**点名 6 个文件**，等价于「只检查我们恰好想到的文件」——
  //    实测 src/elm327.js 新增注释里带了一个工具名、src/model-sysid-map.js 从 HEAD
  //    起就有一个，两者都因为不在名单里而全绿。规则是「src/ 不得出现」，就必须扫全目录。
  //    点名清单与全目录扫描的差别不是覆盖面大小，是**断言强度**：
  //    前者只证明「这 6 个文件干净」，后者才证明「要发布的代码干净」。
  const SRC_DIR = new URL('../src/', import.meta.url);
  // 递归取：今天是 33 个平铺文件、零子目录，但用非递归写法等于把「将来加子目录」
  // 变成一处静默漏检 —— 正是这条断言刚被批评过的那种弱点。
  // ⚠️ `扫描 N 个文件` 是**必须打印的扫描面**（见下面 ok 的 detail）：CI 机器的 Node
  //    未必是这台（本机 v22.22.2，`readdirSync(..., {recursive:true})` 必然生效）。
  //    万一退回平铺，N 会从 33 掉到平铺数 —— 数字变了就有人看得见，而不是静默变窄。
  const srcFiles = readdirSync(SRC_DIR, { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.js'))
    .sort();
  const offenders = [];
  for (const f of srcFiles) {
    // 先剥掉 0x 十六进制字面量：`0x4310` / `0x1431` 这类常量里含 "431"，
    // 是**数值**不是工具名。不剥就会把地址常量误判成工具字样——这正是旧注释
    // 里「目录级扫描会误判」的真实原因；解法是剥字面量，不是退回点名清单。
    // ⚠️ 大小写两种前缀都要剥：`0X4310` 与 `0x4310` 是同一个常量，只写小写会让
    //    大写写法假红一次（纯正确性修复，方向是消除假红）。
    const text = readFileSync(new URL(f, SRC_DIR), 'utf8').replace(/0[xX][0-9A-Fa-f]+/g, '0x');
    // ⚠️ 刻意接受的**假红方向**（已裁，别当漏改）：本行只剥十六进制字面量，
    //    十进制 `14310` / 长度常量 `4310` 里的连续 "431" 仍会命中。收紧成
    //    `(?<![0-9A-Za-z_])431(?![0-9A-Za-z_])` 会连 `MODEL_431`、`'431'` 这类
    //    真命中一起放过 —— 那是把假红换成假绿，而假绿没人看。宁可假红：
    //    假红逼人来看一眼并留下解释，假绿永远不会有人打开。
    const lines = text.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => l.includes('4' + '31'))
      .map(([i]) => `${f}:${i}`);
    if (lines.length) offenders.push(...lines);
  }
  ok('源码无第三方工具字样（递归扫 src/**/*.js + 剥 0x 字面量，非点名）', offenders.length === 0,
    `扫描 ${srcFiles.length} 个文件 · 命中 ${offenders.length} 处`
    + (offenders.length ? ` · ${offenders.slice(0, 6).join(', ')}` : ''));
}

// ── T04-d：U-1 三件套断言名落地为实跑行为断言（不是字符串占位）────────
// VIN_CHAIN_CONSISTENT：D-4 主链（原始 17 字节）与 OBD 链（IsCharNum 过滤）
// 对含 I/O/Q 与小写字母的 VIN 必须逐字节一致；含非法字符时不得混入主链。
{
  const vin = 'WP0ZZZ98Z4L000IOQ';   // 17 位，含 I/O/Q；另测小写
  const lower = 'wp0zzz98z4l000ioq';
  const filtered = vinCharsetFilter(vin);
  const mainChain = filtered.slice(0, 17);
  const obdChain = (filtered.match(/[A-Za-z0-9]{17}/) || [''])[0];
  ok('VIN_CHAIN_CONSISTENT 两链对含 I/O/Q 的 17 位 VIN 逐字节一致',
    mainChain === vin && obdChain === vin, `${mainChain} / ${obdChain}`);
  ok('VIN_CHAIN_CONSISTENT 小写 VIN 两链同样一致（IsCharNum 含小写）',
    vinCharsetFilter(lower).slice(0, 17) === lower
      && (vinCharsetFilter(lower).match(/[A-Za-z0-9]{17}/) || [''])[0] === lower);
  const chars = [...'IOQioq09-_'];
  ok('VIN_CHAIN_CONSISTENT IsCharNum 语义含 I/O/Q 与小写、排除非字母数字',
    chars.every((c) => isCharNum(c.charCodeAt(0)) === /[A-Za-z0-9]/.test(c)),
    `[A-Za-z0-9] 口径 ${chars.length} 字符全对`);
  const coderSrcAllModels = readFileSync(new URL('../src/coder.js', import.meta.url), 'utf8');
  const activeVIN_RE = coderSrcAllModels.split('\n')
    .filter((l) => /const VIN_RE\s*=/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  ok('VIN_CHAIN_CONSISTENT OBD 链正则为 /[A-Za-z0-9]{17}/（无 ISO3779 排除）',
    activeVIN_RE.length === 1 && activeVIN_RE[0].includes('/[A-Za-z0-9]{17}/'),
    activeVIN_RE[0]?.trim().slice(0, 70) || '未找到生效行');
}
// MODEL_NAME_TABLE_24：SYSP:0x5E42C 24 键车型名表，逐项 strcmp 全等匹配实跑。
{
  ok('MODEL_NAME_TABLE_24 表长 24 且每项带 id/text',
    MODEL_NAME_TABLE.length === 24
      && MODEL_NAME_TABLE.every((e) => e && typeof e.text === 'string' && e.text.length > 0),
    `${MODEL_NAME_TABLE.length} 条`);
  const hit = MODEL_NAME_TABLE.find((e) => e.text && e.text.length >= 4);
  ok('MODEL_NAME_TABLE_24 matchModelNameExact 逐字节全等命中已知车型名',
    !!hit && matchModelNameExact(hit.text) != null, hit ? hit.text : '无样本');
  ok('MODEL_NAME_TABLE_24 非表内串不误命中（strcmp 非归一化）',
    matchModelNameExact('__NOT_A_MODEL_NAME__') == null);
}

console.log(`\n===== 全车型推广门禁：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
