#!/usr/bin/env node
/**
 * verify-fullchain-audit.mjs — 第十阶段全量审计门禁（2026-11-12）。
 *
 * 用户在写闸门全量打开后要求复核：整条链路是否真的 0 卡点、有没有实现 bug、
 * 代码与文档是否一致。本审计发现并修复了 2 个真实卡点，这里逐条钉住防止回归：
 *
 *   BUG-1（严重）：写/恢复路径一律传 strictSession:true，覆盖了「本次目标会话正是
 *     该 ECU 的 GAG flag=0 会话」这一事实。PASM 0x0e13 等 32 个 10 03 模块在
 *     ECU 不回 50 03 时会直接抛错，写流程卡死。修：requirePositive = !oemSoft。
 *   BUG-2（严重）：_applyChangeInner 的 sessionless 跳过分支只覆盖自己这一条路径；
 *     app.js 有 5 处 enterSessionFor('coding',{strictSession:true}) 与多处 ('ident')，
 *     加上 _restore，在老代 KWP ECU 上仍会误发 10 89 吃 NRC 0x12。
 *     修：enterSessionFor 统一跳过 + 备份记录带 sessionless 标志供 _restore 使用。
 *
 * 以及文档一致性：历史审计文档必须带推翻标注，正文残留的旧结论必须标为历史状态。
 *
 * 跑法：node tools/verify-fullchain-audit.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder } from '../src/coder.js';
import { extractField } from '../src/schema.js';
import { WRITE_ALIGNMENT } from '../src/write-alignment.js';

const R = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = R('../src/app.js');
const coderSrc = R('../src/coder.js');
let pass = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ''}`);
  pass++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
};
const mkCoder = (m, family, tx = 0x7e0, rx = 0x7e8) => {
  const c = new Coder(new Elm327(m, { timeoutMs: 2000 }), { tx, rx, family });
  c.diagProfile = { verified: true, reason: '审计' };
  c.seedKeyProvider = {
    name: 'audit', verified: true, seedWidths: [2, 4],
    calc: () => new Uint8Array([0x12, 0x34]),
  };
  return c;
};
const frames = (m) => m.txLog.filter((x) => !x.startsWith('AT'));
const P_UDS = { id: 'a', module: 'Audit', name: '审计写', lid: 0x21,
  readSid: 0x22, writeSid: 0x2e, byte: 0, bit: 0, bitsize: 8,
  level: 'source-defined', risk: 'low' };
const P_KWP = { ...P_UDS, readSid: 0x21, writeSid: 0x3b };

// ── ① BUG-1：flag=0 会话无正响应不卡写流程 ─────────────────────
console.log('\n[1] BUG-1：原厂 flag=0 会话（尽力而为）不得被 strictSession 卡死');
{
  const m = new MockAdapter({ latencyMs: 0, hooks: {
    uds: (cmd) => (cmd.toUpperCase().startsWith('1003') ? 'NO DATA' : undefined),
  } });
  const c = mkCoder(m, 'uds', 0x755, 0x7bf);
  c.setOemContext('0x0e13', 0x755);     // PASM：会话 10 03，GAG flag=0
  ok('上下文确为 flag=0 证据会话', c.oemSession === 0x03 && c.oemSessionStrict === false);
  const before = await c.readBlock(0x21, 0x22);
  const v = extractField(before, P_UDS) === 0x5a ? 0x3c : 0x5a;
  m.txLog.length = 0;
  let err = '';
  try { await c.applyChange(P_UDS, v, { dryRun: false }); } catch (ex) { err = ex.message; }
  ok('1003 无正响应时写流程仍跑通（不抛错）', !err, err);
  const f = frames(m);
  ok('写帧序列仍为 会话→备份→安全→写→回读', f.length === 7
    && f[1] === '1003' && f.some((x) => x.startsWith('2E'))
    && f[f.length - 1] === '220021', f.map((x) => x.slice(0, 10)).join(' → '));
  ok('回读一致', extractField(await c.readBlock(0x21, 0x22), P_UDS) === v);
}
{
  // 反向：flag=1 的会话（981 DME 10 89）必须保持硬要求，不能为了修卡点而放松安全
  const m = new MockAdapter({ latencyMs: 0, hooks: {
    uds: (cmd) => (cmd.toUpperCase().startsWith('1089') ? 'NO DATA' : undefined),
  } });
  const c = mkCoder(m, 'kwp');
  c.setOemContext('0x0e01', 0x7e0);
  ok('981 DME 上下文为 flag=1', c.oemSession === 0x89 && c.oemSessionStrict === true);
  const before = await c.readBlock(0x21, 0x21);
  const v = extractField(before, P_KWP) === 0x5a ? 0x3c : 0x5a;
  let err = '';
  try { await c.applyChange(P_KWP, v, { dryRun: false }); } catch (ex) { err = ex.message; }
  ok('flag=1 会话无正响应仍硬报错（安全边界未放松）', !!err, err.slice(0, 70));
  ok('协议层 requirePositive 由证据 flag 决定', /const requirePositive = !oemSoft;/.test(coderSrc));
}

// ── ② BUG-2：老代 sessionless 的全部入口都不发 UDS 会话 ─────────
console.log('\n[2] BUG-2：68 个老代 KWP sysId 的所有写入口不建 UDS 会话');
{
  const m = new MockAdapter({ latencyMs: 0 });
  const c = mkCoder(m, 'kwp');
  c.setOemContext('0x0101', 0x7e0);
  ok('上下文确为 sessionless', c.oemSessionless === true);
  m.txLog.length = 0;
  await c.applyChange(P_KWP, 0x5a, { dryRun: false });
  ok('applyChange 不发 10 xx', !frames(m).some((x) => /^10[0-9A-F]{2}$/i.test(x)),
    frames(m).map((x) => x.slice(0, 10)).join(' → '));

  for (const kind of ['coding', 'ident']) {
    const m2 = new MockAdapter({ latencyMs: 0 });
    const c2 = mkCoder(m2, 'kwp');
    c2.setOemContext('0x0101', 0x7e0);
    m2.txLog.length = 0;
    await c2.enterSessionFor(kind, { skipIdent: true, strictSession: true });
    ok(`enterSessionFor('${kind}') 不发 10 xx`,
      !frames(m2).some((x) => /^10[0-9A-F]{2}$/i.test(x)),
      frames(m2).join(' → ') || '(空)');
  }
  // 服务专属会话（例程/IO）不受 sessionless 影响，仍按 UDS 服务发帧
  const m3 = new MockAdapter({ latencyMs: 0 });
  const c3 = mkCoder(m3, 'kwp');
  c3.setOemContext('0x0101', 0x7e0);
  m3.txLog.length = 0;
  await c3.enterSessionFor('routine', { skipIdent: true });
  ok("enterSessionFor('routine') 不被误跳过（服务专属会话保留）",
    frames(m3).includes('1040'), frames(m3).join(' → '));
}
{
  // 备份与恢复：sessionless 标志必须随备份持久化，_restore 必须读它
  ok('备份记录写入 sessionless 标志', /sessionless: this\.oemSessionless === true/.test(coderSrc));
  ok('_restore 按备份标志跳过会话', /bk\.sessionless \|\| this\.oemSessionless/.test(coderSrc));
  const m = new MockAdapter({ latencyMs: 0 });
  const c = mkCoder(m, 'kwp');
  c.setOemContext('0x0101', 0x7e0);
  await c.applyChange(P_KWP, 0x5a, { dryRun: false });
  const bk = c.backups[c.backups.length - 1];
  ok('实际备份对象带 sessionless:true', bk.sessionless === true);
  m.txLog.length = 0;
  await c._restore(bk);
  ok('_restore 实跑不发 10 xx',
    !frames(m).some((x) => /^10[0-9A-F]{2}$/i.test(x)),
    frames(m).map((x) => x.slice(0, 10)).join(' → '));
}

// ── ③ 帧序对齐复核（修 bug 后不能破坏主写模板） ─────────────────
console.log('\n[3] 帧序对齐复核');
{
  ok('对齐矩阵仍为 aligned=true / 13 项 A',
    WRITE_ALIGNMENT.aligned === true && WRITE_ALIGNMENT.checks.length === 13);
  const m = new MockAdapter({ latencyMs: 0 });
  const c = mkCoder(m, 'kwp');
  const before = await c.readBlock(0x21, 0x21);
  const v = extractField(before, P_KWP) === 0x5a ? 0x3c : 0x5a;
  m.txLog.length = 0;
  await c.applyChange(P_KWP, v, { dryRun: false });
  const f = frames(m);
  ok('KWP 6 帧主写模板未变',
    f.length === 6 && f[0] === '1089' && f[1] === '3E00'
    && f[3] === '170000' && f[4].startsWith('3B') && f[5] === '2121',
    f.map((x) => x.slice(0, 10)).join(' → '));
}

// ── ④ 第十阶段审计其余修复的回归 ───────────────────────────────
console.log('\n[4] 审计其余修复回归');
{
  // C2：app.js 两处备份路径的裸 enterSession() 必须被协议层统一护栏覆盖
  const m = new MockAdapter({ latencyMs: 0 });
  const c = mkCoder(m, 'kwp');
  c.setOemContext('0x0101', 0x7e0);
  m.txLog.length = 0;
  await c.enterSession();
  ok('裸 enterSession() 在 sessionless 上不发 UDS 会话（统一护栏）',
    !frames(m).some((x) => /^10[0-9A-F]{2}$/i.test(x)), frames(m).join(' → ') || '(空)');
  ok('协议层含统一 sessionless 护栏', /统一护栏跳过会话建立/.test(coderSrc));

  // C3：写帧收到 7F 78 不得重发原请求（重复写入红线）
  let hits = 0;
  const m2 = new MockAdapter({ latencyMs: 0, hooks: {
    uds: (cmd) => {
      if (cmd.toUpperCase().startsWith('3B') && hits++ === 0) return '7E8 03 7F 3B 78';
      return undefined;
    },
  } });
  const c2 = mkCoder(m2, 'kwp');
  let err = '';
  try { await c2.applyChange(P_KWP, 0x5a, { dryRun: false }); } catch (ex) { err = ex.message; }
  const writeFrames = m2.txLog.filter((x) => x.toUpperCase().startsWith('3B'));
  ok('写帧收到 7F 78 只发 1 次、明确报错不重发',
    writeFrames.length === 1 && /不自动重发/.test(err),
    `写帧×${writeFrames.length} / ${err.slice(0, 60)}`);

  // 重复免探针直绑（0x07F1 肇事地址）已由生成器全局后处理取消
  const plan = JSON.parse(R('../data/bind-plan.json'));
  const byPair = new Map();
  for (const [sid, rec] of Object.entries(plan.ecu)) {
    if (!rec.bindDirect || (rec.pairs || []).length !== 1) continue;
    const key = `${rec.pairs[0].tx}/${rec.pairs[0].rx}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(sid);
  }
  const dup = [...byPair.entries()].filter(([, sids]) => sids.length > 1);
  ok('无同一地址被多个 sysId 免探针直绑', dup.length === 0,
    dup.length ? JSON.stringify(dup) : `${byPair.size} 个直绑地址均为唯一`);
  ok('生成器含重复直绑后处理与硬门禁',
    /duplicateDirectUnbound/.test(R('../tools/export-bind-plan.py')));

  // probe.js 与 bind-plan/app 的低段地址口径统一
  const probeSrc = R('../src/probe.js');
  ok('probe.js 不再静默丢弃 <0x600 的合法 11 位地址',
    !/tx < 0x600/.test(probeSrc) && /tx <= 0 \|\| tx > 0x7F7/.test(probeSrc));

  // C1：对齐矩阵必须同时含「无上下文」与「按证据会话」两类实测
  ok('WRITE_ALIGNMENT 含 measuredWithContext 两类帧序',
    WRITE_ALIGNMENT.measuredWithContext?.kwp?.frames?.length === 6
    && WRITE_ALIGNMENT.measuredWithContext?.uds?.frames?.length === 7
    && WRITE_ALIGNMENT.measuredWithContext.kwp.evidenceSession === '0x86'
    && WRITE_ALIGNMENT.measuredWithContext.uds.evidenceSession === '0x03');
  ok('13 项判定含 oem-context 两项',
    WRITE_ALIGNMENT.checks.length === 13
    && WRITE_ALIGNMENT.checks.some((x) => x.id === 'oem-context-kwp')
    && WRITE_ALIGNMENT.checks.some((x) => x.id === 'oem-context-uds'));
  ok('对齐矩阵写明「会话帧按证据驱动，非会话号字面值」',
    /会话帧按 SYS_DATA comm 逐 ECU 证据驱动/.test(R('../src/write-alignment.js')));

  // app 两处备份记录都带 sessionless，_restore 不会因换模块丢标志
  ok('app 两处备份记录带 sessionless 标志',
    (app.match(/sessionless: coder\.oemSessionless === true/g) || []).length >= 2);
  ok('两个安全访问入口对 needsKey:false 同口径（均拒写）',
    !/原厂无 case 不发 key —— 继续写入/.test(coderSrc)
    && /两个安全访问入口同口径/.test(coderSrc));
  ok('22 11 02 补帧如实标注为未实现（不冒充已对齐）',
    /当前实现\*\*没有发帧路径\*\*/.test(app));
  ok('bind-plan rule 如实写明 comm 自带 rx 优先',
    /comm cat=0x10 记录自带 rx 优先/.test(R('../tools/export-bind-plan.py')));
}

// ── ⑤ 代码 ↔ 文档一致性 ─────────────────────────────────────────
console.log('\n[5] 文档一致性');
{
  const docs = {
    'ACCEPTANCE-MATRIX-431.md': '第十阶段全量审计标注',
    'CODE-AUDIT-FULLCHAIN-20261111.md': '第十阶段全量审计标注',
    'FULLCHAIN-ALIGN-20261112.md': '第十阶段补充',
    'FULLCHAIN-CLOSURE-20261112.md': '第九阶段更新',
    'TAKEOVER.md': '第十阶段全量审计',
    'WRITE-GATE-OPEN-20261112.md': '闸门已按对齐矩阵打开',
  };
  for (const [f, marker] of Object.entries(docs)) {
    ok(`${f} 带最新状态标注`, R(`../${f}`).includes(marker));
  }
  ok('ACCEPTANCE-MATRIX 不再把「固定 0x89」当现行结论（有明确推翻说明）',
    /已被推翻/.test(R('../ACCEPTANCE-MATRIX-431.md').slice(0, 1600)));
  ok('FULLCHAIN-CLOSURE 正文把旧白名单标为历史状态',
    /历史状态/.test(R('../FULLCHAIN-CLOSURE-20261112.md')));
  ok('coder.js 顶部注释不再写「DRIVELINKS 342/980」',
    !/342\/980|334\/980/.test(coderSrc));
  ok('app.js 写闸门仍委托对齐矩阵', /writeProfileFromAlignment\(sys, model, addr, family\)/.test(app));
  // 所有写/恢复入口都走统一的 enterSessionFor（协议层修一次即可全覆盖）
  const codingCalls = (app.match(/enterSessionFor\('coding'/g) || []).length;
  ok(`app.js ${codingCalls} 处 coding 会话入口全部经统一方法`,
    codingCalls >= 5 && /Coder\.prototype\.enterSessionFor/.test(coderSrc));
  // 正文残留旧结论（不只是文件头有标注）也必须清掉
  const takeover = R('../TAKEOVER.md');
  const closure = R('../FULLCHAIN-CLOSURE-20261112.md');
  const align = R('../FULLCHAIN-ALIGN-20261112.md');
  const reclos = R('../RE-CLOSURE-20261111.md');
  const accept = R('../ACCEPTANCE-MATRIX-431.md');
  // analysis/ 被 .gitignore 忽略（本地工作台），跨环境 clone 后可能不存在
  let analysis = '';
  try { analysis = R('../analysis/seedkey-coverage-audit-20261108.md'); } catch { /* 不入仓，跳过 */ }
  ok('TAKEOVER 当前边界不再把 0x050c 列为「无候选」',
    !/0x050c` 无候选/.test(takeover) && /已补齐 comm 本 ECU 地址对/.test(takeover));
  ok('FULLCHAIN-CLOSURE §5#5 标为历史结论', /历史结论，第九阶段已收口/.test(closure));
  ok('FULLCHAIN-ALIGN §7 明确标为历史快照', /历史快照/.test(align));
  ok('RE-CLOSURE 顶部补注覆盖 OBD VIN 与 §2 内部矛盾', /第十阶段补注/.test(reclos));
  ok('ACCEPTANCE OBD VIN 行内标注已推翻', /历史结论，已推翻（0xFBE0FD00/.test(accept));
  ok('analysis/ 覆盖率审计口径（存在则检查，目录被 .gitignore 忽略）',
    !analysis || /第十阶段全量审计标注/.test(analysis),
    analysis ? '本地已标注（不入仓）' : '目录未随仓库分发，跳过');
  ok('WRITE-GATE-OPEN 修正「不是所有 ECU 都发 1089」口径',
    /会话帧不是所有 ECU 都等于/.test(R('../WRITE-GATE-OPEN-20261112.md')));
}

console.log(`\n===== 全链路审计门禁：${pass} 通过 / 0 失败 =====`);
