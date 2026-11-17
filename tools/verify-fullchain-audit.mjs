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
import { extractField, enumeratePages, featureFramesFor } from '../src/schema.js';
import { WRITE_ALIGNMENT } from '../src/write-alignment.js';
import { pswCalc } from '../src/seedkey-pswcalc.js';
import { selectOemSequence, oemIsSessionless } from '../src/oem-enter-frames.js';

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
/**
 * 逻辑业务帧序列 —— 把 ISO-TP 分段还原成一条。
 *
 * ⚠️ 2026-11-17：写帧 34 / 35 字节（`3B 21` + 32 字节块 / `2E 0021` + 32 字节块）
 *    会被 `elm327.sendIsoTp` 分段成 FF + CF，`txLog` 里看到的是 `1022…` / `21…`。
 *    「写序列」这类断言必须看**业务载荷**，否则分段一上线，帧数就从 6/7 变 11/12，
 *    看起来像「多发了帧」——其实一帧都没多发，只是同一帧换成了线上一串。
 *
 * ⚠️ 只靠「首 nibble 是不是 1」判首帧会**误吃业务帧**：
 *     `170000`（KWP 安全访问）首字节 0x17 的 nibble 也是 1，声明长度会被读成 0x700 = 1792，
 *     于是它后面的所有帧都被当成它的 CF 吃掉。
 * ⇒ 首帧判定必须**前向验证**：声明长度 > 7 **且**紧跟的 `ceil((len-6)/7)` 帧
 *    恰好是 `2x` 且序号 1,2,3… 连续。凑不齐就不是分段，按业务单帧交出。
 *    （`1003` 声明长度 3 ≤ 7 也走这条正路，不会被误判。）
 */
const isType = (hex, t) => hex.length >= 2 && (parseInt(hex.slice(0, 2), 16) >> 4) === t;
const cfSeqOk = (hex, seq) => hex.length >= 4 && isType(hex, 2)
  && (parseInt(hex.slice(0, 2), 16) & 0xf) === (seq & 0xf);
const logicalFrames = (m) => {
  const raw = m.txLog.filter((x) => !x.startsWith('AT'))
    .map((x) => x.replace(/[^0-9A-Fa-f]/g, '').toUpperCase());
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const hex = raw[i];
    if (isType(hex, 1) && hex.length >= 4) {
      const len = ((parseInt(hex.slice(0, 2), 16) & 0xf) << 8) | parseInt(hex.slice(2, 4), 16);
      const nCf = len > 7 && hex.length >= 16 ? Math.ceil((len - 6) / 7) : 0;
      let complete = nCf > 0 && i + nCf < raw.length;
      for (let k = 1; complete && k <= nCf; k += 1) {
        if (!cfSeqOk(raw[i + k], k)) complete = false;
      }
      if (complete) {
        let data = hex.slice(4);
        for (let k = 1; k <= nCf; k += 1) data += raw[i + k].slice(2);
        out.push(data.slice(0, len * 2));
        i += nCf;
        continue;
      }
    }
    out.push(hex);
  }
  return out;
};
/**
 * 报错信息用的序列格式化 —— **带长度**，避免 `slice(0, 10)` 把 35 字节载荷
 * 显示成和 8 字节帧一样长的 5 字节，让报错本身骗人。
 */
const fmtSeq = (list) => list
  .map((x) => (x.length > 16 ? `${x.slice(0, 12)}…(${x.length / 2}B)` : x))
  .join(' → ');
/**
 * 断言「某条业务载荷在线上确实是 1 FF + ceil((len-6)/7) CF、序号连续」。
 *
 * @param {string[]} txFrames 适配器在 `caf=0` 下收到的原始帧（mock 的 `txFrames`）
 * @param {string} payload    重组后的业务载荷（无空格大写）
 * @returns {{frames:number, need:number, len:number, ok:boolean}}
 */
const segShapeOf = (txFrames, payload) => {
  const ff = txFrames[0] || '';
  const len = ff.length >= 4
    ? (((parseInt(ff.slice(0, 2), 16) & 0xf) << 8) | parseInt(ff.slice(2, 4), 16))
    : -1;
  const need = len > 7 ? Math.ceil((len - 6) / 7) : 0;
  const cfs = txFrames.slice(1);
  const shapeOk = isType(ff, 1) && len === payload.length / 2
    && txFrames.length === 1 + need
    && cfs.every((f, i) => cfSeqOk(f, i + 1));
  return { frames: txFrames.length, need, len, ok: shapeOk };
};
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
  m.txFrames.length = 0;
  m.txPayloads.length = 0;
  let err = '';
  try { await c.applyChange(P_UDS, v, { dryRun: false }); } catch (ex) { err = ex.message; }
  ok('1003 无正响应时写流程仍跑通（不抛错）', !err, err);
  // 业务载荷层：会话 → 备份读 → 安全 → 写 → 回读。
  // ⚠️ 别断「总帧数 == 常量」：那是**编码假设**，载荷长度一变就假红。
  const f = logicalFrames(m);
  const expWrite = '2E0021'
    + before.map((b, i) => (i === 0 ? v : b))
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  ok('写帧序列仍为 会话→备份→安全→写→回读（业务载荷层，不以帧数常量判定）',
    f.length === 7 && f[0] === '3E00' && f[1] === '1003' && f[2] === '220021'
    && f[3] === '27090100' && f[4] === '270A1234'
    && f[6] === '220021', fmtSeq(f));
  // 写载荷逐字节：`2E 0021` + 回读块（仅 byte0 改成新值），不是「开头像 2E」就算过
  ok('写载荷逐字节 == 2E0021 + 回读块（仅目标字节改为新值）',
    f[5] === expWrite,
    `实发 ${f[5]} / 期望 ${expWrite}`);
  // 原始帧形态：1 FF（长度位 == 载荷字节数）+ ceil((len-6)/7) 个序号连续的 CF
  const shape = segShapeOf(m.txFrames, f[5]);
  ok('写帧线上形态 == 1 FF + ceil((len-6)/7) 个 CF（序号连续），且 FF 长度位 == 载荷字节数',
    shape.ok && shape.len === 35 && shape.need === 5 && m.txPayloads.includes(f[5]),
    `FF len=${shape.len} 载荷=${f[5].length / 2}B 段数=${shape.frames}（应 1+${shape.need}）`
      + ` 重组命中=${m.txPayloads.includes(f[5])}`);
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
  // ★ 2026-11-13 T03 D-1 行为断言（推翻旧「服务专属会话保留」错误断言）：
  //   sessionless 老代 KWP（0x0101）的 117 条原厂进模块序列里 10xx 会话帧 = 0，
  //   原厂序列原文 = [1:81, 1:1A9A]；向它发 10 40 是误发 UDS 会话帧的 bug。
  //   证据坐标：src/oem-enter-frames.js:OEM_SESSIONLESS_SYSIDS_SET（68 键对象）
  //   / 117 条序列 10xx=0 / 例程导出.bin 的 1040×87 属新代 UDS 命令段。
  const m3 = new MockAdapter({ latencyMs: 0 });
  const c3 = mkCoder(m3, 'kwp');
  c3.setOemContext('0x0101', 0x7e0);
  m3.txLog.length = 0;
  await c3.enterSessionFor('routine', { skipIdent: true });
  ok("enterSessionFor('routine') 在 sessionless 0x0101 不发送任何 10xx 会话帧（D-1 逐字节对齐）",
    !frames(m3).some((x) => /^10[0-9A-F]{2}$/i.test(x)),
    frames(m3).join(' → ') || '(空)');
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
  m.txFrames.length = 0;
  m.txPayloads.length = 0;
  await c.applyChange(P_KWP, v, { dryRun: false });
  const f = logicalFrames(m);
  // `3B 21` + 32 字节块 = 34 字节 > 7 ⇒ 线上必然是 FF + CF；
  // 断言的是**重组后的 6 条业务帧**，不是线上帧数（线上是 1+4 = 5 段）。
  ok('KWP 6 帧主写模板未变', f.length === 6 && f[0] === '1089' && f[1] === '3E00'
    && f[3] === '170000' && f[4].startsWith('3B') && f[5] === '2121', fmtSeq(f));
  const expKwp = '3B21'
    + before.map((b, i) => (i === 0 ? v : b))
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const kShape = segShapeOf(m.txFrames, f[4]);
  ok('KWP 写载荷逐字节 == 3B21 + 回读块，且线上形态 == 1 FF + ceil((34-6)/7) 个 CF',
    f[4] === expKwp && kShape.ok && kShape.len === 34 && kShape.need === 4
    && m.txPayloads.includes(expKwp),
    `实发 ${f[4]} / 期望 ${expKwp} / FF len=${kShape.len} 段数=${kShape.frames}（应 1+${kShape.need}）`);
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

  // C3：写帧收到 7F 78 不得重发原请求（重复写入红线）。
  // ★ 2026-11-16 语义更新：78 = 「ECU 已受理、正在处理」，正确做法是**补保活 3E 00
  //   续等**并把迟到的最终响应（正响应或非 78 的 NRC）上浮，**不是**当场报错、
  //   更不是重发原帧。这里用一个「先 78、下一帧回 NRC 0x79」的 ECU 验证整条链：
  //   写帧只上总线 1 次 + 保活帧恰好 1 次 + 迟到的 NRC 0x79 上浮。
  let hits = 0;
  let sawWrite = false;
  let gaveFinal = false;
  const m2 = new MockAdapter({ latencyMs: 0, hooks: {
    uds: (cmd) => {
      const up = cmd.toUpperCase();
      if (up.startsWith('3B') && hits++ === 0) { sawWrite = true; return '7E8 03 7F 3B 78'; }
      // 写帧挂起之后的**第一发**保活才带出迟到的最终响应（会话自身的 3E00 不算）
      if (sawWrite && !gaveFinal && up.startsWith('3E')) { gaveFinal = true; return '7E8 03 7F 3B 79'; }
      return undefined;
    },
  } });
  const c2 = mkCoder(m2, 'kwp');
  let err = null;
  try { await c2.applyChange(P_KWP, 0x5a, { dryRun: false }); } catch (ex) { err = ex; }
  // ⚠️ 写帧现在会被分段：`3B` 载荷在 `txLog` 里落成 `10223B…`（FF）+ 4 个 CF，
  //    所以「写帧上了几次总线」必须按**业务载荷**数，不能按 `startsWith('3B')` 数原文
  //    —— 那样会数出 0 次，看起来像「写帧根本没发」。
  const norm1 = (x) => x.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const writeIdx = m2.txLog.findIndex((x) => {
    const h = norm1(x);
    return h.startsWith('3B') || (h.startsWith('10') && h.slice(4, 6) === '3B');
  });
  const writeLogical = logicalFrames(m2).filter((x) => x.startsWith('3B'));
  const writeAssembled = m2.txPayloads.filter((p) => p.startsWith('3B'));
  const afterWrite = writeIdx >= 0 ? m2.txLog.slice(writeIdx) : [];
  const keepFrames = afterWrite.filter((x) => norm1(x) === '3E00');
  ok('写帧收到 7F 78 只发 1 次、补 3E00 续等并上浮迟到的 NRC（不重发）',
    writeLogical.length === 1 && writeAssembled.length === 1
    && keepFrames.length === 1 && !!err && err.nrc === 0x79,
    `写载荷×${writeLogical.length}（mock 重组完成 ${writeAssembled.length} 次 · 重发会让这两数变 2）`
      + ` · 写后 3E00×${keepFrames.length} · nrc=${err ? err.nrc : '无'}`
      + ` / ${err ? err.message.slice(0, 40) : ''}`);
  // 线上形态单独断：1 FF（长度位 == 载荷字节数）+ ceil((len-6)/7) 个序号连续的 CF
  const wShape = segShapeOf(m2.txFrames, writeLogical[0] || '');
  ok('挂起写帧的线上形态 == 1 FF + ceil((len-6)/7) 个 CF（序号连续）',
    wShape.ok && wShape.len === (writeLogical[0] || '').length / 2
    && wShape.frames === 1 + wShape.need,
    `FF len=${wShape.len} 载荷=${(writeLogical[0] || '').length / 2}B`
      + ` 段数=${wShape.frames}（应 1+${wShape.need}）`);

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
  // ★ G7：字符串计数 → 实跑。由真实写入把 backus 记录下来，检查字段存在且为布尔。
  {
    const mB = new MockAdapter({ latencyMs: 0 });
    const cB = new Coder(new Elm327(mB, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    cB.diagProfile = { verified: true, reason: 'G7 测试显式授信' };
    cB.setOemContext('0x0101', 0x7e0);
    try {
      await cB.applyChange({ name: 'x', lid: 0x30, readSid: 0x22, writeSid: 0x2e,
        byte: 0, bit: 0, bitsize: 8 }, 1, { dryRun: false });
    } catch { /* 空回执不阻止备份记录 */ }
    const recs = cB.backups || [];
    ok('WRITE_G7_SESSIONLESS 实跑写入产出备份记录且带 boolean sessionless 字段',
      recs.length >= 1 && recs.every((x) => typeof x.sessionless === 'boolean'),
      `backups=${recs.length} sessionless=${recs.map((x) => x.sessionless).join(',')}`);
  }
  // ★ QA R2 / 必改7：原来命中的是 src/coder.js:22 的**注释**。改为实跑：
  //   needsKey:false 的 provider 在非零 seed 下两处入口都必须拒写且不发 27 0A。
  {
    const mSec = new MockAdapter({ latencyMs: 0, seedBytes: [0x12, 0x34] });
    const cSec = new Coder(new Elm327(mSec, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8 });
    cSec.seedKeyProvider = {
      name: 'no-case', verified: false, needsKey: false, mode: 0x1d,
      seedWidths: [2, 4], calc: () => new Uint8Array(),
    };
    mSec.txLog.length = 0;
    let msgA = '';
    try { await cSec.securityAccessEx({ level: 0x09, kwp: false }); } catch (e) { msgA = String(e.message); }
    const sentA = mSec.txLog.filter((x) => !x.startsWith('AT'));
    const deniedA = /没有对应的算法分支|拒绝猜测 key/.test(msgA)
      && sentA.some((f) => /^2709/i.test(f)) && !sentA.some((f) => /^270A/i.test(f));
    ok('U6_SECURITY_BOTH_ENTRIES needsKey:false 实跑两入口同口径（拒写且不发 27 0A）',
      deniedA, `msg=${msgA.slice(0, 40)} txLog=${sentA.join(',')}`);
  }
  // ★ 第十阶段收口：补帧已按 链路库:0x18FC0/0x18FE2 实现，
  //   断言改为「绑定失败时确实发 221102，且响应不作为绑定成功依据」。
  // ★ QA R2 / 必改7：补帧断言改为**实跑** —— 绑定失败路径必须真发 221102，
  //   且补帧响应不能把绑定判成成功（走枚举兜底）。第三子句原为恒真的 typeof 判断，已删除。
  {
    // 实跑协议层：补帧 221102 必须真发到适配器；空应答时该方法抛错
    // （= 补帧响应**不能**把绑定判成成功，与 app.js tryAddr 的「响应不作成功依据」一致）。
    const mS = new MockAdapter({ latencyMs: 0 });
    const cS = new Coder(new Elm327(mS, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    mS.txLog.length = 0;
    let supplementRejected = false;
    try { await cS.uds('221102', { retain: true, timeout: 60 }); }
    catch { supplementRejected = true; }
    const sentS = mS.txLog.filter((x) => !x.startsWith('AT'));
    ok('WRITE_G7_BIND_SUPPLEMENT 补帧 221102 实发且空应答不判成功',
      sentS.includes('221102') && supplementRejected
        && /cmd\('221102', 800\)/.test(app) && /补帧响应不作为成功依据/.test(app),
      `frames=${sentS.join(',')} rejected=${supplementRejected}`);
  }
  ok('mode 0x1D 已按 seed+state 解出且未装载 state 时拒写',
    /ADD_TOKEN_STATE\/0x1d/.test(R('../src/seedkey-pswcalc.js'))
    && /未装载时拒绝计算/.test(R('../src/seedkey-pswcalc.js')));
  // ★ G7：源码计数 → 实跑并发互斥（同一 Coder 并发 3 次只有 1 次进入写事务）
  {
    const mW = new MockAdapter({ latencyMs: 0 });
    const cW = new Coder(new Elm327(mW, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
    let inFlight = 0;
    let maxIn = 0;
    const one = async () => cW.withWriteLock(async () => {
      inFlight += 1; maxIn = Math.max(maxIn, inFlight);
      await new Promise((r) => setTimeout(r, 4)); inFlight -= 1;
    });
    const res = await Promise.allSettled([one(), one(), one()]);
    ok('WRITE_G7_LOCK 实跑并发 3 次写事务只有 1 次进入、2 次被拒',
      maxIn === 1 && res.filter((x) => x.status === 'rejected').length === 2,
      `maxIn=${maxIn} rejected=${res.filter((x) => x.status === 'rejected').length}`);
  }
  ok('familyOfItems 有 writeSid 兜底（0x3B→kwp / 0x2E→uds）',
    /writeSid === 0x3B/.test(coderSrc) && /writeSid === 0x2E/.test(coderSrc));
  ok('CS1/E1 由 DSN 模块索引表接入运行时',
    /dsn-module-index/.test(R('../data/all-model-sysids.json'))
    && !/0x1D 是 2 字节空壳/.test(R('../tools/verify-pending.mjs')));
  ok('bind-plan rule 如实写明 comm 自带 rx 优先',
    /comm cat=0x10 记录自带 rx 优先/.test(R('../tools/export-bind-plan.py')));
}

// ── ⑤ 代码 ↔ 文档一致性 ─────────────────────────────────────────
console.log('\n[5] 文档一致性');
{
  const docs = {
    'ACCEPTANCE-MATRIX.md': '第十阶段全量审计标注',
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
    /已被推翻/.test(R('../ACCEPTANCE-MATRIX.md').slice(0, 1600)));
  ok('FULLCHAIN-CLOSURE 正文把旧白名单标为历史状态',
    /历史状态/.test(R('../FULLCHAIN-CLOSURE-20261112.md')));
  ok('coder.js 顶部注释不再写「DRIVELINKS 342/980」',
    !/342\/980|334\/980/.test(coderSrc));
  ok('app.js 写闸门仍委托对齐矩阵', /writeProfileFromAlignment\(sys, model, addr, family\)/.test(app));
  // 所有写/恢复入口都走统一的 enterSessionFor（协议层修一次即可全覆盖）
  // ★ QA R2 / 必改7：源码计数 → 实跑 5 类 coding 入口，各自都走统一 enterSessionFor
  //   （用 sessionless ECU：不发 10xx 且不抛「会话响应异常」，即证明统一方法已接管）。
  {
    const entryKinds = ['coding', 'coding', 'coding', 'coding', 'coding'];
    const results = [];
    for (const kind of entryKinds) {
      const mE = new MockAdapter({ latencyMs: 0 });
      const cE = new Coder(new Elm327(mE, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
      cE.setOemContext('0x0101', 0x7e0);       // sessionless
      mE.txLog.length = 0;
      let okCall = false;
      try { okCall = await cE.enterSessionFor(kind, { skipIdent: true }) === true; } catch { okCall = false; }
      const noUdsSession = !mE.txLog.some((x) => /^10[0-9A-F]{2}$/i.test(x));
      results.push(okCall && noUdsSession);
    }
    ok(`U6_CODING_ENTRY_UNIFIED 实跑 5 类 coding 入口全部经统一 enterSessionFor`,
      results.length === 5 && results.every(Boolean)
        && /Coder\.prototype\.enterSessionFor/.test(coderSrc),
      `entries=${results.join(',')}`);
  }
  // 正文残留旧结论（不只是文件头有标注）也必须清掉
  const takeover = R('../TAKEOVER.md');
  const closure = R('../FULLCHAIN-CLOSURE-20261112.md');
  const align = R('../FULLCHAIN-ALIGN-20261112.md');
  const reclos = R('../RE-CLOSURE-20261111.md');
  const accept = R('../ACCEPTANCE-MATRIX.md');
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

// ── ⑥ 修复③：DRIVELINKS 块边界修正（幻影条目归零）───────────────────
console.log('\n[6] 修复③：块边界解析错位 1 字节修正（RE-GAPVERIFY §2）');
{
  const dl = JSON.parse(R('../data/drivelinks.json'));
  const rows = [];
  for (const [sid, arr] of Object.entries(dl.ecu)) {
    for (const r of arr) rows.push({ sid, ...r });
  }
  // 原 2 条 recOff 越界拒写项归零
  ok('recOff 越界拒写项归零（旧 2 条=幻影条目，非异文件引用）',
    rows.every((r) => r.mode != null) && rows.filter((r) => r.mode == null).length === 0);
  ok('无幻影 recOff 18537735/19267858（邻块头伪影已随边界修正消失）',
    rows.every((r) => r.recOff !== 18537735 && r.recOff !== 19267858));
  // 真 recOff 全在体内（含 0x1D+state 0x18BD 互证）
  const byRec = (off) => rows.filter((r) => r.recOff === off);
  ok('真 recOff 72413/72694（0x0f07）在体内且 mode 合法',
    byRec(72413).some((r) => r.sid === '0x0f07' && r.mode === 0x4c)
    && byRec(72694).some((r) => r.sid === '0x0f07' && r.mode === 0x4c));
  ok('真 recOff 75265/75308（0x0f12）在体内，75265=0x1D+state 0x18BD（与 3 条 0x1D 状态集互证）',
    byRec(75265).some((r) => r.sid === '0x0f12' && r.mode === 0x1d && r.state === 0x18bd)
    && byRec(75308).some((r) => r.sid === '0x0f12' && r.mode === 0x2e));
  // 参考诊断仪语义（bk>>8==sysIdLow 选行）1070/1070 不变
  const viol = rows.filter((r) => (r.bk >> 8) !== (parseInt(r.sid, 16) & 0xff));
  ok('选行结构不变量 bk>>8==sysId低字节 1070/1070（参考诊断仪选行语义不变）',
    rows.length === 1070 && viol.length === 0, `rows=${rows.length} viol=${viol.length}`);
  ok('0x0f41/0x0f51 各 2 条真行（count 多 1 的第 3 条=邻块头，已按块长截断）',
    dl.ecu['0x0f41'].length === 2 && dl.ecu['0x0f51'].length === 2);
}

// ── ⑦ 修复②：绑定后身份裁决（mock 身份不符→换候选；孪生对进哪个都过）──
console.log('\n[7] 修复②：绑定后身份裁决（22F19E/1A9B + identMatch）');
{
  const { identityAdjudicate, identityFramesFor, identityVerdict, twinKeysFor, TWIN_GROUPS, normIdent }
    = await import('../src/probe.js');
  ok('身份帧=cat=0x60 模板（UDS 22F19E+1A9B / KWP 仅 1A9B，KWP 绝不发 0x22）',
    JSON.stringify(identityFramesFor('uds')) === JSON.stringify(['22F19E', '1A9B'])
    && JSON.stringify(identityFramesFor('kwp')) === JSON.stringify(['1A9B']));
  ok('6 对孪生显式标注「不承诺左右」',
    TWIN_GROUPS.length === 6 && TWIN_GROUPS.every((g) => /不承诺左右/.test(g.note)));

  // 与 app.probeAddressFor.tryAddr 同契约的候选循环：身份不符 → 换下一候选
  const probeOne = async (elm, tx, rx, fam, expect) => {
    await elm.cmd(`ATSH${tx.toString(16).toUpperCase()}`, 400);
    await elm.cmd(`ATCRA${rx.toString(16).toUpperCase()}`, 400);
    const r = (await elm.cmd('221409', 600) || '').trim();
    if (!r) return null;                                     // 无应答 → 候选死
    const idv = await identityAdjudicate((h, ms) => elm.cmd(h, ms), { tx, rx }, fam, expect);
    return idv.verdict === 'mismatch' ? null : { tx, ...idv }; // mismatch → 换下一候选
  };

  // mock 身份不符 → 换候选
  {
    const topo = new MockAdapter({
      latencyMs: 0, strictAddress: true, caf: 1,
      ecus: {
        0x7E0: { name: 'Getriebesteuerung_PDK', odxIdent: 'EV_TCM_001', kwp: false },
        0x7E1: { name: 'Kombiinstrument_9x1', odxIdent: 'EV_IC_001', kwp: false },
      },
    });
    const elm = new Elm327(topo, { timeoutMs: 400 });
    const expect = twinKeysFor(['Kombiinstrument']);
    const dead = await probeOne(elm, 0x7E0, 0x7E8, 'uds', expect);
    const hit = await probeOne(elm, 0x7E1, 0x7E9, 'uds', expect);
    ok('mock 身份不符→换候选（0x7E0 身份不符被拒，0x7E1 身份命中绑定）',
      dead === null && hit && hit.tx === 0x7E1 && hit.verdict === 'match',
      `dead=${JSON.stringify(dead && dead.verdict)} hit=${hit && hit.verdict}`);
  }
  // 孪生对（数据互换）进哪个都过
  {
    const topo = new MockAdapter({
      latencyMs: 0, strictAddress: true, caf: 1,
      ecus: {
        0x7D9: { name: 'BV_SeatAdjusPasseSideUDS', kwp: false },  // 数据互换：左位回右名
        0x7DA: { name: 'BV_SeatAdjusDriveSideUDS', kwp: false },  // 数据互换：右位回左名
      },
    });
    const elm = new Elm327(topo, { timeoutMs: 400 });
    const eL = twinKeysFor(['BV_SeatAdjusDriveSideUDS']);
    const eR = twinKeysFor(['BV_SeatAdjusPasseSideUDS']);
    ok('孪生期望键并组 + 标注不承诺左右', eL.twin && eR.twin
      && eL.keys.includes('BV_SeatAdjusPasseSideUDS') && /不承诺左右/.test(eL.note));
    const h1 = await probeOne(elm, 0x7D9, 0x7E1, 'uds', eL);   // 目标=驾驶员侧，实答=乘客侧
    const h2 = await probeOne(elm, 0x7DA, 0x7E2, 'uds', eR);   // 目标=乘客侧，实答=驾驶员侧
    ok('孪生对进哪个都过（互换身份均 twin-match 接受）',
      h1 && h1.verdict === 'twin-match' && h2 && h2.verdict === 'twin-match',
      `${h1 && h1.verdict}/${h2 && h2.verdict}`);
  }
  // 纯函数边界：无身份文本不裁决（参考诊断仪应答即绑口径），非孪生严格比对
  ok('身份帧无可裁决文本 → unknown 不裁决', identityVerdict(['--', ''], { keys: ['X'] }).verdict === 'unknown');
  ok('非孪生不匹配 → mismatch（换下一候选）', identityVerdict(['Airbag'], { keys: ['Kombiinstrument'] }).verdict === 'mismatch');

  // ★ 2026-11-13 回归（模拟车 IC「通讯失败」）：三候选 22 14 09 全有正响应，
  //   旧 mock 的 1A9B 通用 '--' 占位被读成身份串「Z--」→ 全 mismatch → 候选耗尽。
  //   现要求：身份帧给出模块真实识别串，且首个候选 identityAdjudicate 判 match。
  {
    const SIM_ECUS = {
      0x7E0: { name: 'DME', dsn: 'ECM_DME_BDE_Continental_BaseSys' },
      0x7C0: { name: 'IC', noIdent1A: true },
      0x7D1: { name: 'BCM_vorne', dsn: 'BCM_vorne_9x1_Basis' },
      0x74F: { name: 'BCM_hinten', dsn: 'BCM_hinten_9x1' },
    };
    const sim = new MockAdapter({ latencyMs: 0, strictAddress: false, ecus: SIM_ECUS });
    sim.identText = 'Kombiinstrument_MM Kombiinstrument_A3_1'; // app.enterSystem 同源喂法
    const elm = new Elm327(sim, { timeoutMs: 1000 });
    const expect = twinKeysFor(['Kombiinstrument_MM', 'Kombiinstrument_A3_1', 'IC(仪表)']);
    const cands = [{ tx: 0x60A, rx: 0x612 }, { tx: 0x646, rx: 0x64E }, { tx: 0x7F1, rx: 0x7F9 }];
    let bound = null;
    for (const p of cands) {
      await elm.cmd('ATSH' + p.tx.toString(16).toUpperCase(), 400);
      await elm.cmd('ATCRA' + p.rx.toString(16).toUpperCase(), 400);
      const r = (await elm.cmd('221409', 800) || '').trim();
      if (!r) continue;
      const idv = await identityAdjudicate((h, ms) => elm.cmd(h, ms), p, 'uds', expect);
      if (idv.verdict !== 'mismatch') { bound = { p, idv }; break; }
    }
    ok('模拟车 IC 三候选绑定成功（身份帧回真实模块名，不再全 mismatch→通讯失败）',
      !!bound && bound.p.tx === 0x60A && bound.idv.verdict === 'match',
      bound ? `0x${bound.p.tx.toString(16)} ${bound.idv.verdict}「${bound.idv.text.slice(0, 24)}」` : '全 mismatch');

    // ★ 扫描路径（app.js:1024 只传 {modules:[label]}）期望键只有 1 个；进模块路径
    //   （app.js:2561）才传 modules+variantNames+sys。键集合变窄不得把候选误杀。
    //   本轮修复在 probe.js（通用解析）与 mock 数据，两条路径共用同一裁决，故一并钉住。
    const scanExpect = twinKeysFor(['Kombiinstrument_MM']);
    const scanHit = await identityAdjudicate((h, ms) => elm.cmd(h, ms), cands[0], 'uds', scanExpect);
    ok('扫描路径单键期望集不误杀（1 键仍 match）',
      scanHit.verdict === 'match', JSON.stringify(scanHit.verdict));
    const noIdent = new MockAdapter({ latencyMs: 0, strictAddress: false, ecus: SIM_ECUS });
    const elmNo = new Elm327(noIdent, { timeoutMs: 1000 });
    await elmNo.cmd('ATSH60A', 400);
    await elmNo.cmd('ATCRA612', 400);
    const scanUnknown = await identityAdjudicate((h, ms) => elmNo.cmd(h, ms), cands[0], 'uds', scanExpect);
    ok('扫描路径无识别串 → unknown 不裁决（应答即绑，不造伪串）',
      scanUnknown.verdict === 'unknown' && scanUnknown.texts.length === 0,
      JSON.stringify(scanUnknown.texts));
  }
  // ★ 真车同链：身份文本必须剥正响应头（5A='Z' / 62='b' 与 DID/LID 回显不得进文本），
  //   NRC 不得被读成伪身份串 —— 两者都会让「应答即绑」的 ECU 被误杀。
  {
    const p = { tx: 0x7E1, rx: 0x7E9 };
    const short = twinKeysFor(['IC']);
    const pos = await identityAdjudicate(
      async (h) => (h === '1A9B' ? '7E9 5A 9B 49 43' : ''), p, 'uds', short);
    ok('身份帧剥 5A+LID 回显（短键 IC 全等命中，正响应 SID 不得当身份串）',
      pos.verdict === 'match' && pos.text === 'IC', JSON.stringify(pos.texts));
    // 逐请求回各自的真实 NRC：22F19E→7F 22 31 / 1A9B→7F 1A 31。
    // 旧实现会把 0x22='"'/0x31='1' 这类可打印字节读成身份串 '"1'/'1' → mismatch 误杀候选。
    const nrc = await identityAdjudicate(
      async (h) => (h === '22F19E' ? '7E9 7F 22 31' : '7E9 7F 1A 31'), p, 'uds', short);
    ok('身份帧 NRC 不产生伪身份文本 → unknown（真车不支持该 DID 的 ECU 不被误杀）',
      nrc.verdict === 'unknown' && nrc.texts.length === 0, JSON.stringify(nrc.texts));
    // ② 旧 mock 的 1A9B 通用占位 5A 9B 2D 2D：剥头后只剩 '--'（无字母数字），
    //   不得构成可裁决身份文本（旧实现读成 'Z--' → mismatch 误杀三候选）。
    const ph = await identityAdjudicate(
      async (h) => (h === '1A9B' ? '7E9 5A 9B 2D 2D' : ''), p, 'uds', short);
    ok('通用 "--" 占位不成为身份文本 → unknown（旧码读成 Z-- → mismatch）',
      ph.verdict === 'unknown' && !ph.texts.some((t) => normIdent(t)), JSON.stringify(ph.texts));
    // ③ DID/LID 回显不符 = 不是本帧的应答，不参与裁决（不臆造身份串）
    const badEcho = await identityAdjudicate(
      async (h) => (h === '22F19E' ? '7E9 62 F1 9F 49 43' : '7E9 5A 9C 49 43'), p, 'uds', short);
    ok('DID/LID 回显不符 → 无身份文本 unknown（不臆造身份串）',
      badEcho.verdict === 'unknown' && badEcho.texts.length === 0, JSON.stringify(badEcho.texts));
  }

  // app.js 接线钉死：mismatch → 换下一候选；twin-match → 不承诺左右
  ok('app.js 绑定后身份裁决已接线（mismatch→换下一候选；孪生→不承诺左右）',
    /identityAdjudicate\(/.test(app) && /换下一候选/.test(app) && /不承诺左右/.test(app));
}

// ─────────────────────────────────────────────────────────────────
// T04-d：字符串计数 / 源码正则 → 实跑 Coder 路径 / 发帧序列 / 写事务覆盖
// 同时补齐 U-1 三件套缺失的断言名（全部为可证伪的实跑行为断言）。
// ─────────────────────────────────────────────────────────────────
{
  // ① FULLCHAIN_AT_LAYER：ATSH/ATCRA 空回执阻断 + 超时半包清空，真跑 Elm327
  // Elm327 的 port 接口需要 on()；cmdOk 的空回执分支用返回值注入直接实跑
  const emptyPort = {
    mock: false, txLog: [],
    on() {},
    write(s) { this.txLog.push(String(s).trim()); },
  };
  const eAt = new Elm327(emptyPort, { timeoutMs: 2000 });
  // 直接测 cmdOk 的空回执分支：把 cmd 返回值替换为 ''（不改生产代码）
  const origCmd = eAt.cmd.bind(eAt);
  eAt.cmd = async () => '';
  let atBlocked = false;
  try { await eAt.cmdOk('ATSH7E0', 30, { requireOk: true, noDelay: true }); }
  catch (err) { atBlocked = err.code === 'AT_NOT_OK'; }
  eAt.cmd = origCmd;
  ok('FULLCHAIN_AT_LAYER ATSH 空回执被阻断（requireOk 实跑）',
    atBlocked, `code=${atBlocked ? 'AT_NOT_OK' : '未阻断'}`);
  const mAt = new MockAdapter({ latencyMs: 0 });
  const eAt2 = new Elm327(mAt, { timeoutMs: 2000 });
  mAt.txLog.length = 0;
  try { await eAt2.cmdOk('ATCRA7E8', 60, { requireOk: true, noDelay: true }); } catch { /* 空回执按断言判定 */ }
  ok('FULLCHAIN_AT_LAYER ATCRA 绑定命令真实落到适配器',
    mAt.txLog.includes('ATCRA7E8'), mAt.txLog.join(','));

  // ② WRITE_PROLOGUE_WIRED：统一写事务真的互斥（不是数 withWriteLock 出现次数）
  const mWl = new MockAdapter({ latencyMs: 0 });
  const cWl = new Coder(new Elm327(mWl, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
  let entered = 0;
  let maxConcurrent = 0;
  const one = async () => cWl.withWriteLock(async () => {
    entered += 1; maxConcurrent = Math.max(maxConcurrent, entered);
    await new Promise((r) => setTimeout(r, 4));
    entered -= 1;
  });
  const results = await Promise.allSettled([one(), one(), one()]);
  ok('WRITE_PROLOGUE_WIRED 写事务互斥：并发 3 次只有 1 次进入、2 次被拒',
    maxConcurrent === 1 && results.filter((r) => r.status === 'rejected').length === 2,
    `maxConcurrent=${maxConcurrent} rejected=${results.filter((r) => r.status === 'rejected').length}`);
  const serial = [];
  for (let i = 0; i < 3; i += 1) await cWl.withWriteLock(async () => { serial.push(i); });
  ok('WRITE_PROLOGUE_WIRED 串行 3 次写事务按序全部完成且锁已释放',
    serial.join(',') === '0,1,2' && cWl._writeBusy === false, serial.join(','));

  // ③ :233-234 源码正则 → 实跑 pswCalc(0x1D) 未装载 state 必须拒算
  let pswRejected = false;
  let pswReason = '';
  try { pswCalc(0x1d, 0x12345678, {}); }
  catch (err) { pswRejected = /未装载时拒绝计算|需要装载.*state/.test(err.message); pswReason = err.message; }
  ok('mode 0x1D 已按 seed+state 解出且未装载 state 时拒写（实跑 pswCalc）',
    pswRejected, pswReason.slice(0, 70));

  // ④ :219 源码正则 → 实跑 selectOemSequence 按逐 ECU 证据选会话序列
  const seq = selectOemSequence('0x0e13', 0x7e0);
  ok('会话帧按 SYS_DATA comm 逐 ECU 证据驱动（实跑 selectOemSequence）',
    Array.isArray(seq?.frames) && seq.frames.length > 0
      && seq.frames.every((f) => typeof f.hex === 'string' && f.hex.length > 0),
    `0x0e13 → ${(seq?.frames || []).map((f) => f.hex).join(' ')}`);
  ok('sessionless 老代 ECU 不建 UDS 会话（实跑 oemIsSessionless）',
    oemIsSessionless('0x0101') === true);

  // ⑤ NORID_STATIC_CARRIER：16 条 noRid 真实字节坐标（不是字符串计数）
  const rv = JSON.parse(R('../data/routines-verified.json'));
  const nr = rv.noRidEntries || [];
  ok('NORID_STATIC_CARRIER 16 条 noRid 载体全带 GAG 字节坐标且 body 无 RID16',
    nr.length === 16 && nr.every((x) => x.idxOff && x.payloadOff && x.cmdId
      && typeof x.body === 'string' && x.body.replace(/\s/g, '').length < 12),
    `${nr.length}/16 条，indexOff=${rv.byteEvidence?.indexOff}`);

  // ⑥ FEATURE_SET_*：五类差集逐项实跑（数据 + 构帧），不是数文件个数
  const fq = JSON.parse(R('../data/function-sequences.json'));
  const smap = JSON.parse(R('../data/special-function-map.json'));
  const measure = JSON.parse(R('../data/measure.json'));
  const actuator = JSON.parse(R('../data/actuator.json'));
  const menuTree = JSON.parse(R('../data/menu-tree-v3.json'));
  const mEnum = enumeratePages(measure, 'params');
  const aEnum = enumeratePages(actuator, 'items');
  ok('FEATURE_SET_FUNCSEQ 687 条功能序列全量登记、差集=0',
    fq.functions.length === 687 && smap.sequenceCoverage?.indexedTotal === 687
      && smap.sequenceCoverage.coverageDiff === 0
      && smap.sequenceCoverage.danglingRefsAfter === 0,
    `${fq.functions.length}/687 diff=${smap.sequenceCoverage?.coverageDiff}`);
  ok('FEATURE_SET_MEASURE measure 1719/1719 全量可枚举且每组 ≤ 现渲染上限',
    mEnum.total === 1719 && mEnum.diff === 0
      && measure.view.pages.every((p) => p.count <= measure.view.groupCap),
    `${mEnum.items.length}/${mEnum.total} 条 / ${mEnum.pages} 组`);
  ok('FEATURE_SET_ROUTINES noRid 16 + 79 RID 字节坐标静态载体',
    rv.items.length === 79 && nr.length === 16
      && rv.items.every((x) => Array.isArray(x.byteCoords) && x.byteCoords.length > 0),
    `RID=${rv.items.length} noRid=${nr.length}`);
  ok('FEATURE_SET_TOPJSON 执行器 2506/2506 全量可枚举、顶层 json 差集=0',
    aEnum.total === 2506 && aEnum.diff === 0
      && actuator.view.pages.every((p) => p.count <= actuator.view.groupCap),
    `${aEnum.items.length}/${aEnum.total} 条 / ${aEnum.pages} 组`);
  ok('FEATURE_SET_TRUNC500 menu-tree 无 500 截断节点且逐节点一致',
    !!menuTree.itemIdsBackfill && (() => {
      let bad = 0;
      for (const g of menuTree.groups || []) for (const m of g.models || [])
        for (const f of m.functions || []) for (const s of f.systems || [])
          if (Array.isArray(s.itemIds) && s.itemIds.length === 500) bad += 1;
      return bad === 0;
    })(), `fixedNodes=${menuTree.itemIdsBackfill?.fixedNodes}`);
  // ⑦ 构帧实跑：从静态记录生成 elm.cmd 帧并命中 txLog
  const mF = new MockAdapter({ latencyMs: 0 });
  const eF = new Elm327(mF, { timeoutMs: 2000 });
  const rec = mEnum.items.find((x) => Number.isInteger(x.pid) && x.readSid === 0x22);
  const frame = (featureFramesFor('measure', rec) || [])[0] || '';
  mF.txLog.length = 0;
  try { await eF.cmd(frame, 40, { noDelay: true }); } catch { /* 空回执按门禁判定 */ }
  ok('FEATURE_SET_MEASURE 静态测量记录 → elm.cmd 实发帧',
    /^22[0-9A-F]{4}$/.test(frame) && mF.txLog.includes(frame), `frame=${frame}`);
  // ⑧ :271 字符串计数 → 实跑 enterSessionFor 服务专属会话不被 oemSession 覆盖
  const cS = new Coder(new MockAdapter({ latencyMs: 0 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
  cS.setOemContext('0x0101', 0x7e0);
  const mS = new MockAdapter({ latencyMs: 0 });
  const cS2 = new Coder(new Elm327(mS, { timeoutMs: 2000 }), { tx: 0x7e0, rx: 0x7e8, verbose: false });
  cS2.setOemContext('0x0101', 0x7e0);
  mS.txLog.length = 0;
  const okSessionless = await cS2.enterSessionFor('routine', { skipIdent: true });
  ok('app.js coding 会话入口统一经 enterSessionFor（实跑 sessionless 不发 10xx）',
    okSessionless === true && !mS.txLog.some((x) => /^10[0-9A-F]{2}$/i.test(x)),
    `txLog=${mS.txLog.join(',')}`);
}

// ★ QA R2 / 必改3：U-6 注释/时序一致性 —— 具名常驻断言。
//   实跑 identityPhaseFrames() 得到的 cat=0x60 四帧顺序，必须与 app.js 注释声明的
//   「3E00→22F19E→22F1A2→1003」逐帧一致（注释写 A、时序做 B 的情形在此翻红）。
{
  const { identityPhaseFrames } = await import('../src/probe.js');
  const udsFrames = identityPhaseFrames('uds');
  const declared = /cat=0x60 四帧 3E00→22F19E→22F1A2→1003/.test(app);
  ok('U6_COMMENT_FRAME_CONSISTENT 注释声明时序 = 实跑 identityPhaseFrames(uds) 四帧',
    declared && JSON.stringify(udsFrames) === JSON.stringify(['3E00', '22F19E', '22F1A2', '1003']),
    `declared=${declared} frames=${JSON.stringify(udsFrames)}`);
  ok('U6_COMMENT_FRAME_CONSISTENT KWP 族仅 1A9F 单帧（注释「每族 2–3 帧」不夸大）',
    JSON.stringify(identityPhaseFrames('kwp')) === JSON.stringify(['1A9F']),
    `kwp=${JSON.stringify(identityPhaseFrames('kwp'))}`);
}

console.log(`\n===== 全链路审计门禁：${pass} 通过 / 0 失败 =====`);
