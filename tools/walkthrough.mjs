#!/usr/bin/env node
/**
 * 全链路演练 —— 用「会真正校验 key 的模拟 ECU」跑完整上车流程。
 *
 * 与 e2e-flow.mjs 的区别
 * ──────────────────────
 * e2e-flow 用的是**宽容**模拟车：`27` 永远回 `67`（key 不校验）、`31` 永远成功。
 * 它能验「报文格式对不对」，但**验不出 key 算错、长例程被误判失败**这类问题。
 *
 * 本脚本把模拟车切成**严格模式**：
 *   · key 校验用**真机 真值对拍 真值表**（tools/vectors/pend-samples.json，
 *     由 仿真 实跑 .so 采集），不是拿自己的算法自证 —— 算错就吃 NRC 0x35
 *   · `31 01` 前 N 次回 `7F 31 78`（响应挂起），验跟随轮询
 *   · 写入可被 ECU 拒绝 / 可被篡改，验「写入失败」与「回读不一致 → 恢复」
 *
 * 跑法: node tools/walkthrough.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder, CodingError } from '../src/coder.js';
import { computeVariantKey } from '../src/seedkey-registry.js';
import { extractField, injectField } from '../src/schema.js';

// ── 按「依赖真值表与否」拆分（2026-11-17）──────────────────────────
// `tools/vectors/` 整目录被 `.gitignore:118` 排除（本地真机对拍表，不入库），干净
// clone 上必然不存在。本脚本 84 条断言里，**54 条**的存在前提是那张真值表：
//   · `[3]` 前半 3 条（`:119` `TRUTH.filter(...).slice(0,10)` 逐点校验 key）
//   · `[9]` 完整上车序列 5 条（`TRUTH[5]` 做 seed/key）
//   · ui-sim 遍历 46 条（15 模块 × 3 + 汇总 1；`:368` `keyVerifier: () => bytesOf(TRUTH[0].key)`）
// 其余 **30 条**不读真值表，资产缺失时照跑。
//
// ⚠️ 三条硬约束（别为了多跑几条而破）：
//   · **不许**把 ui-sim 的 `keyVerifier` 换成 `computeVariantKey(VID, seed)`：
//     ECU 拿工具算的 key 去校验工具算的 key ⇒ 永远相等、永远绿。文件 `:12` 那句
//     「不是拿自己的算法自证 —— 算错就吃 NRC 0x35」会被自己破掉。
//   · `TOTAL_EXPECTED` 必须是**常量**：拆分最容易死人的方式不是拆错，是某条断言
//     被顺手删掉、总数从 84 掉到 83，而汇总照样绿。末尾自证把这条堵死。
//   · 那 30 条**不含 key 正确性**（用的是宽容 ECU），汇总下面必须明说，
//     否则「30 通过」会被读成「解锁验过了」——比 0 通过更危险。
const VECTORS_PEND = new URL('./vectors/pend-samples.json', import.meta.url);
const REQUIRE_LOCAL_ASSETS = /^(1|true|yes)$/i.test(String(process.env.ALIGN431_REQUIRE_LOCAL_ASSETS || ''));
const LOCAL_ASSET_WHY = 'tools/vectors/ 属 .gitignore:118 本地真机对拍表，不入库（缺 pend-samples.json）';
/** 本脚本**固定** 84 条断言：30 条不依赖真值表 + 54 条依赖。不许改成运行时推导。 */
const TOTAL_EXPECTED = 84;

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); }
};
/**
 * 一条因「缺本地资产」而没跑的断言。
 * 宽松模式记 SKIP（可见、计入 skip），`ALIGN431_REQUIRE_LOCAL_ASSETS=1` 时记 FAIL。
 * 禁止 try/catch 静默吞 —— 吞掉就成了「永远绿」的假断言（禁令见 verify-comm-timeouts.mjs:26）。
 */
const skipped = (name, why) => {
  if (REQUIRE_LOCAL_ASSETS) {
    fail++;
    console.log(`  FAIL ${name} -- 严格模式 ALIGN431_REQUIRE_LOCAL_ASSETS=1：${why}`);
    return;
  }
  skip++;
  console.log(`  SKIP ${name} -- ${why}`);
};
const hexOf = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

// ── 真值表（真机 真值对拍）：ECU 用它校验 key ────────────────────────────────
// 缺失时为 null（不是空表）：空表会让 `TRUTH.filter(...)` 得到空数组、
// 循环零次、`good === total` 变成 `0 === 0` —— 假绿。
const VID = '3D5365460CB39FEFC14651DF5075A1B8';       // 第五轮刚收编的内联 VM 变体
const TRUTH = existsSync(VECTORS_PEND)
  ? JSON.parse(readFileSync(VECTORS_PEND, 'utf8'))[VID]
  : null;

/** 建一台严格 ECU */
function strictEcu(opts = {}) {
  return new MockAdapter({
    latencyMs: 0,
    seedBytes: opts.seedBytes || [0x12, 0x34, 0x56, 0x78],
    keyVerifier: opts.keyVerifier,
    routinePending: opts.routinePending || 0,
    writeVerify: opts.writeVerify,
  });
}
/** 工具侧的 seed/key provider（走 registry 正常分发路径） */
function variantProvider(id = VID) {
  return {
    name: `test:${id.slice(0, 8)}`, verified: true,
    calc(seedBytes) { return computeVariantKey(id, seedBytes).key; },
  };
}

async function link(ecu) {
  const elm = new Elm327(ecu, { timeoutMs: 3000 });
  await elm.init({ protocol: 6 });
  const coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: '演练ECU', verbose: false });
  coder.setAddress(0x7E0, 0x7E8, '演练ECU');
  // 演练使用独立 mock profile，真实地址/车型证据不足时的默认只读门禁另行测试。
  coder.diagProfile = { verified: true, reason: 'walkthrough mock profile' };
  return { elm, coder };
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] 连接 + 协议初始化');
{
  const ecu = strictEcu();
  const { elm } = await link(ecu);
  ok('ELM327 init 成功', !!elm);
  ok('发了 ATCAF1（ELM327 自动 ISO-TP PCI）', elm.log.some(([c]) => c.includes('ATCAF1')) && !elm.log.some(([c]) => c.includes('ATCAF0')));
  ok('发了流控三件套', elm.log.some(([c]) => c.includes('ATCFC1')) &&
     elm.log.some(([c]) => c.includes('ATFCSM0')));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] 会话建立');
{
  const { coder } = await link(strictEcu());
  // enterSession 成功返回 true（内部 10 03 是尽力而为，目标会话才是硬要求）
  const r = await coder.enterSession(0x89);
  ok('10 89 建立成功', r === true, `ret=${r}`);
  const r2 = await coder.enterSession(0x03);
  ok('10 03 建立成功', r2 === true);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] 安全访问 —— key 用真机真值表逐点校验');
{
if (!TRUTH) {
  // ↓ 这 3 条是 [3] 前半：全都以 `TRUTH.filter(...)` 取种子点，缺表无从下手。
  skipped('真机 seed 逐点通过 ECU 校验（且确实各发了 1 次 key）', LOCAL_ASSET_WHY);
  skipped('key 错 → ECU 回 NRC 0x35 且工具抛错', LOCAL_ASSET_WHY);
  skipped('ECU 侧确实拒绝了', LOCAL_ASSET_WHY);
} else {
  // ⚠️ 全零 seed 是「ECU 已解锁/无需解锁」的合法应答（coder.js 里显式处理），
  //    那一轮不会发 key —— 不能拿来验 key 校验，否则断言是虚的。
  const rows = TRUTH.filter((r) => r.seed !== '00000000').slice(0, 10);
  let good = 0, total = 0;
  const bad = [];
  for (const row of rows) {
    total++;
    const seed = bytesOf(row.seed);
    const ecu = strictEcu({
      seedBytes: Array.from(seed),
      // ECU 期望值来自 真值对拍，与工具侧算法**无关**
      keyVerifier: () => bytesOf(row.key),
    });
    const { coder } = await link(ecu);
    coder.seedKeyProvider = variantProvider();
    try {
      await coder.securityAccessEx({ level: 0x09, kwp: false });
      if (ecu.stats.keyRejects === 0 && ecu.stats.keyTries === 1) good++;
      else bad.push(`${row.seed} keyTries=${ecu.stats.keyTries} 拒=${ecu.stats.keyRejects}`);
    } catch (e) {
      bad.push(`${row.seed} 抛错 ${e.message.slice(0, 40)}`);
    }
  }
  ok(`${total} 个真机 seed 全部通过 ECU 校验（且确实各发了 1 次 key）`,
     good === total, bad.length ? bad.slice(0, 3).join(' | ') : `${good}/${total}`);

  // 反向：故意给错 key，ECU 必须拒绝且工具要报错（不能静默当成功）
  {
    const row = rows[0];
    const ecu = strictEcu({
      seedBytes: Array.from(bytesOf(row.seed)),
      keyVerifier: () => bytesOf(row.key),          // ECU 认的是 真值对拍 真值
    });
    const { coder } = await link(ecu);
    coder.seedKeyProvider = { name: 'bad', verified: false, calc: () => Uint8Array.of(1, 2, 3, 4) };
    let threw = null;
    try { await coder.securityAccessEx({ level: 0x09, kwp: false }); } catch (e) { threw = e; }
    ok('key 错 → ECU 回 NRC 0x35 且工具抛错', threw instanceof CodingError && threw.nrc === 0x35,
       threw ? `nrc=0x${threw.nrc?.toString(16)}` : '没抛错（静默放行 = 危险）');
    ok('ECU 侧确实拒绝了', ecu.stats.keyRejects === 1, `rejects=${ecu.stats.keyRejects}`);
  }
}   // ← 结束「真值表存在」分支：下面是 [3] 后半，不读 TRUTH，照跑

  // 全零 seed = 无需解锁，不该发 key
  {
    const ecu = strictEcu({ seedBytes: [0, 0, 0, 0] });
    const { coder } = await link(ecu);
    coder.seedKeyProvider = variantProvider();
    const r = await coder.securityAccessEx({ level: 0x09, kwp: false });
    ok('全零 seed → 判为无需解锁', r === true);
    ok('全零 seed 时不发 key', ecu.stats.keyTries === 0, `keyTries=${ecu.stats.keyTries}`);
  }

  // 无 case 的 mode 不该发 key（P0 回归）
  {
    const ecu = strictEcu({ seedBytes: [1, 2, 3, 4] });
    const { coder } = await link(ecu);
    coder.seedKeyProvider = null;
    let threw = null;
    try { await coder.securityAccessEx({ level: 0x09, kwp: false }); } catch (e) { threw = e; }
    ok('没有 seedKeyProvider → 抛 MissingSeedKey（不发空 key）', !!threw, threw?.constructor?.name);
    ok('一个 key 都没发出去', ecu.stats.keyTries === 0, `keyTries=${ecu.stats.keyTries}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] 读编码');
{
  const { coder } = await link(strictEcu());
  const b = await coder.readBlock(0x21, 0x21);
  ok('21 21 读回数据', b && b.length > 0, `${b?.length} 字节`);
  const p = { id: 't', name: '测试字段', lid: 0x21, readSid: 0x21, writeSid: 0x3B, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
  const v = extractField(b, p);
  ok('能按位取出字段', v !== null && v >= 0, `v=${v}`);
  const nb = injectField(b, p, 0x5A);
  ok('能按位写回字段', nb && extractField(nb, p) === 0x5A);
  ok('写回不改动原数组', hexOf(b) !== hexOf(nb));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] 写入成功 + 回读一致');
{
  const ecu = strictEcu();
  const { coder } = await link(ecu);
  coder.seedKeyProvider = variantProvider();
  const p = { id: 't1', name: '测试字段', lid: 0x21, readSid: 0x21, writeSid: 0x3B, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
  const before = await coder.readBlock(0x21, 0x21);
  const oldV = extractField(before, p);
  const newV = oldV === 0x5A ? 0x3C : 0x5A;
  const r = await coder.applyChange(p, newV, { dryRun: false, session: 0x89 });
  ok('applyChange 返回', !!r);
  const after = await coder.readBlock(0x21, 0x21);
  ok('回读值 == 写入值', extractField(after, p) === newV,
     `期望 ${newV} 实读 ${extractField(after, p)}`);
  ok('备份已记录', coder.backups.length === 1);
  ok('ECU 侧确实发生了一次写', ecu.stats.writes === 1, `writes=${ecu.stats.writes}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[6] ECU 拒写 → 必须报错，且原块不被改坏');
{
  const ecu = strictEcu({ writeVerify: () => false });   // ECU 一律拒写
  const { coder } = await link(ecu);
  coder.seedKeyProvider = variantProvider();
  const p = { id: 't2', name: '测试字段', lid: 0x21, readSid: 0x21, writeSid: 0x3B, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
  const before = await coder.readBlock(0x21, 0x21);
  let threw = null;
  try { await coder.applyChange(p, 0x11, { dryRun: false, session: 0x89 }); } catch (e) { threw = e; }
  ok('写入被拒 → 抛错（不是静默成功）', !!threw, threw?.message?.slice(0, 50));
  ok('ECU 记录到拒写', ecu.stats.writeRejects === 1, `rejects=${ecu.stats.writeRejects}`);
  const after = await coder.readBlock(0x21, 0x21);
  ok('块内容未被改坏', hexOf(before) === hexOf(after));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[7] 回读不一致 → 触发恢复，且错误要说清');
{
  // ECU 接受了写请求，但存的是**篡改后**的值 → 回读必然不一致
  const ecu = strictEcu({ writeVerify: null });
  let tampered = false;
  const origWrite = Object.getOwnPropertyNames(MockAdapter.prototype);
  ecu.hooks.uds = (cmd) => {
    const c = cmd.replace(/\s+/g, '').toUpperCase();
    if (c.startsWith('3B21') && !tampered) { tampered = true; return '7E8 7B 21'; }  // 假称成功（CAF1：纯数据，无 PCI）
    return undefined;
  };
  const { coder } = await link(ecu);
  coder.seedKeyProvider = variantProvider();
  const p = { id: 't3', name: '测试字段', lid: 0x21, readSid: 0x21, writeSid: 0x3B, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
  let threw = null;
  try { await coder.applyChange(p, 0x77, { dryRun: false, session: 0x89 }); } catch (e) { threw = e; }
  ok('回读不一致 → 抛错', !!threw, threw?.message?.slice(0, 60));
  ok('错误信息提到「回读」', !!threw && /回读/.test(threw.message), threw?.message?.slice(0, 40));
  ok('恢复了备份（块回到原值）', !!threw && !/恢复备份失败/.test(threw.message),
     /恢复备份失败/.test(threw?.message || '') ? '恢复也失败了' : '恢复成功');
  void origWrite;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[8] 特殊功能：长例程（NRC 0x78 → 跟随轮询）');
{
  // ECU 前 3 次例程请求都回 0x78（含 31 03 查结果），靠跟随轮询等到成功
  const ecu = strictEcu({ routinePending: 3 });
  const { coder } = await link(ecu);
  const r = await coder.runRoutine(0x01, 0x0203, '', { intervalMs: 1, maxMs: 5000 });
  ok('轮询后拿到结果', !!r.result, `polled=${r.polled}`);
  ok('ECU 确实回了 3 次 0x78', ecu.stats.nrc78 === 3, `nrc78=${ecu.stats.nrc78}`);
  ok('没有被当场判失败', r.result && r.result.kind === 'ok');
}
{
  // 不加轮询时，必须失败（证明轮询是必需的，不是装饰）
  const ecu = strictEcu({ routinePending: 3 });
  const { coder } = await link(ecu);
  let threw = null;
  try { await coder.runRoutine(0x01, 0x0203, '', { poll: false }); } catch (e) { threw = e; }
  ok('关掉轮询 → 长例程确实会失败（证明轮询必需）', !!threw && threw.nrc === 0x78,
     threw ? `nrc=0x${threw.nrc?.toString(16)}` : '没抛错');
}
{
  // stopRoutine(0x02) 是「取消」，不该轮询 —— 即使 ECU 回 0x78 也立刻返回/抛错，
  // 不能出现「点了停止还在那儿转半天」。
  const ecu = strictEcu({ routinePending: 5 });
  const { coder } = await link(ecu);
  let threw = null;
  try { await coder.runRoutine(0x02, 0x0203, '', { intervalMs: 1 }); } catch (e) { threw = e; }
  ok('stopRoutine 遇到 0x78 直接返回（不轮询）', !!threw && threw.nrc === 0x78,
     threw ? `nrc=0x${threw.nrc?.toString(16)}` : '没抛错');
  ok('stop 只发了 1 次请求，没有跟随查询', ecu.stats.routineCalls === 1,
     `calls=${ecu.stats.routineCalls}`);
}
{
  // 查结果（31 03）走轮询
  const ecu = strictEcu({ routinePending: 2 });
  const { coder } = await link(ecu);
  const r = await coder.runRoutine(0x03, 0x0203, '', { intervalMs: 1, maxMs: 3000 });
  ok('31 03 查结果能轮询到成功', !!r.result && r.result.kind === 'ok' && r.polled >= 2,
     `polled=${r.polled}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[9] 完整上车序列（会话 → 解锁 → 读 → 写 → 特殊功能）');
if (!TRUTH) {
  // ↓ 这 5 条整段挂在 `TRUTH[5]` 上（seed 与期望 key 都来自那一行）
  skipped('① 进会话 + 解锁通过（key 经真值校验）', LOCAL_ASSET_WHY);
  skipped('② 读编码', LOCAL_ASSET_WHY);
  skipped('③ 写入 + 回读一致', LOCAL_ASSET_WHY);
  skipped('④ 特殊功能跑通（含 0x78 轮询）', LOCAL_ASSET_WHY);
  skipped('⑤ 全程 ECU 没拒过 key / 没拒过写', LOCAL_ASSET_WHY);
} else {
  const row = TRUTH[5];
  const ecu = strictEcu({
    seedBytes: Array.from(bytesOf(row.seed)),
    keyVerifier: () => bytesOf(row.key),
    routinePending: 2,
  });
  const { coder } = await link(ecu);
  coder.seedKeyProvider = variantProvider();

  await coder.enterSession(0x89);
  await coder.securityAccessEx({ level: 0x09, kwp: false });
  ok('① 进会话 + 解锁通过（key 经真值校验）', ecu.stats.keyRejects === 0);

  const p = { id: 't4', name: '测试字段', lid: 0x21, readSid: 0x21, writeSid: 0x3B, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
  const before = await coder.readBlock(0x21, 0x21);
  ok('② 读编码', before.length > 0);

  const newV = extractField(before, p) === 0x5A ? 0x3C : 0x5A;
  await coder.applyChange(p, newV, { dryRun: false, session: 0x89 });
  ok('③ 写入 + 回读一致', extractField(await coder.readBlock(0x21, 0x21), p) === newV);

  const rr = await coder.runRoutine(0x01, 0x0100, '', { intervalMs: 1, maxMs: 3000 });
  ok('④ 特殊功能跑通（含 0x78 轮询）', !!rr.result && rr.result.kind === 'ok');

  ok('⑤ 全程 ECU 没拒过 key / 没拒过写',
     ecu.stats.keyRejects === 0 && ecu.stats.writeRejects === 0,
     `keyRejects=${ecu.stats.keyRejects} writeRejects=${ecu.stats.writeRejects}`);
}

// ────────────────────────────────────────────────────────────────────────
// ui-sim：任意车型 → 任意模块 遍历（抽样 ≥3 车型 × ≥5 模块）
//   通用规则全链路：记录 SID 派生家族（familyOfItems）→ 记录读帧形态（21/22/1A）→
//   读写帧可按记录成帧（配对表已拆，参考诊断仪直接用记录 readSid/writeSid 发帧）→
//   严格 mock 读块 + 写块回读。零特判：全部走记录字段，无车型/模块分支。
// ────────────────────────────────────────────────────────────────────────
{
  const { familyOfItems, familyOfReadSid } = await import('../src/coder.js');
  const { READ_SIDS, WRITE_SIDS, resolveBlockReadSid } = await import('../src/schema.js');
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const SAMPLE_MODELS = ['Cayman_981_', 'Boxster_982_', '911_992_'];
  let walked = 0, moduleGaps = [];
  for (const model of SAMPLE_MODELS) {
    const dir = join('data/models', model);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch { moduleGaps.push(`${model}: 目录缺失`); continue; }
    const picked = files.slice(0, 5);   // 抽样 ≥5 模块
    for (const f of picked) {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const items = (j.items || []).filter((it) => it && it.lid != null && it.readSid != null);
      const modName = items[0]?.module || f.replace(/\.json$/i, '');
      if (!items.length) { moduleGaps.push(`${model}/${f}: 无记录`); continue; }
      const fam = familyOfItems(items);
      // ② 读写帧可按记录成帧（2026-11-08 覆盖审计②：配对表已拆，参考诊断仪无此闸）
      //   读帧服务={21,22,1A}，写帧服务={3B,2E}（SendUdsReadSidPidCmd/SendUdsWriteSidPidCmd 实证）；
      //   writeSid∈写服务的记录 LID 必须放得进帧（2E→≤0xFFFF / 3B→≤0xFF）。
      const writable = items.filter((it) => WRITE_SIDS.includes(Number(it.writeSid)));
      const badWrite = writable.filter((it) =>
        (Number(it.writeSid) === 0x2E ? it.lid > 0xffff : it.lid > 0xff));
      if (!TRUTH) {
        // 本块 46 条（15 模块 × 3 + 汇总）随真值表一起 SKIP。
        // ⚠️ 其中「写帧可按记录成帧」「LID 位宽合法」两条**本可**不读 TRUTH 独立跑，
        //    之所以不拆：本块的语义是「在严格 mock 上走完整上车链路」，只跑一半会让
        //    读的人以为「这个模块验过了」。宁少跑、不误导。
        skipped(`${model} → ${modName}：写帧可按记录成帧（${writable.length} 条可写 / ${items.length} 条记录）`,
          LOCAL_ASSET_WHY);
        skipped(`${model} → ${modName}：LID 位宽合法（读 SID ${items[0].readSid.toString(16)}）`,
          LOCAL_ASSET_WHY);
        skipped(`${model} → ${modName}：读帧=记录 SID 形态（未取 ECU 帧）`, LOCAL_ASSET_WHY);
        walked++;
        continue;
      }
      ok(`${model} → ${modName}：写帧可按记录成帧（${writable.length} 条可写 / ${items.length} 条记录）`,
        badWrite.length === 0,
        badWrite.length ? `LID 超位宽 ×${badWrite.length}` : '无配对表（记录 writeSid 直发）');
      // ④ LID 位宽
      const wide = items.filter((it) => (it.readSid === 0x22 ? it.lid > 0xffff : it.lid > 0xff));
      ok(`${model} → ${modName}：LID 位宽合法（读 SID ${items[0].readSid.toString(16)}）`, wide.length === 0);
      // 严格 mock 走读+写（记录 SID 驱动帧形态；readSid=0 记录走表级回落读服务）
      const sample = items.find((it) => READ_SIDS.includes(Number(it.readSid))) || items[0];
      const rdSid = READ_SIDS.includes(Number(sample.readSid)) ? Number(sample.readSid) : resolveBlockReadSid(items);
      const ecu = strictEcu({ seedBytes: [0x12, 0x34, 0x56, 0x78], keyVerifier: () => bytesOf(TRUTH[0].key) });
      const { coder } = await link(ecu);
      coder.family = fam;
      await coder.enterSession(0x89, { family: fam });
      const blk = await coder.readBlock(Number(sample.lid) & (rdSid === 0x22 ? 0xffff : 0xff), rdSid);
      const frames = ecu.txLog.filter((c) => !c.startsWith('AT'));
      const wantFrame = (rdSid === 0x22 ? '22' : rdSid.toString(16))
        + (Number(sample.lid) & (rdSid === 0x22 ? 0xffff : 0xff)).toString(16)
          .padStart(rdSid === 0x22 ? 4 : 2, '0');
      ok(`${model} → ${modName}：读帧=记录 SID 形态（${wantFrame.toUpperCase()}）`,
        frames.includes(wantFrame.toUpperCase()) && blk.length > 0, frames.join(','));
      walked++;
    }
  }
  if (!TRUTH) {
    skipped(`ui-sim 遍历抽样（3 车型 × ≥5 模块，共 ${walked} 个模块全链路）`, LOCAL_ASSET_WHY);
  } else {
    ok(`ui-sim 遍历抽样（3 车型 × ≥5 模块，共 ${walked} 个模块全链路）`, walked >= 15, moduleGaps.join(' | '));
  }
}

// ── 自证闭合 + 汇总 ────────────────────────────────────────────────────────
// `TOTAL_EXPECTED` 是**常量**而不是运行时推导：推导出来的数永远等于实跑的数，
// 等于没查。这条断言防的是「某条断言被顺手删掉 / 某个分支忘了计 skip」——
// 那种情况下汇总照样绿、exit 照样 0，只有这里会红。
{
  const accounted = pass + fail + skip;
  if (accounted !== TOTAL_EXPECTED) {
    fail++;
    console.log(`  FAIL 断言总数自证：实跑 ${pass} + 失败 ${fail - 1} + 跳过 ${skip} = ${accounted}`
      + ` ≠ 预期 ${TOTAL_EXPECTED}（差 ${TOTAL_EXPECTED - accounted} 项 —— 有断言被删或被漏计）`);
  }
}
console.log(`\n===== 全链路演练：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 =====`);
if (!TRUTH) {
  // 这一行不是装饰：缺真值表时那 30 条用的是**宽容** ECU（`strictEcu()` 不传 keyVerifier
  // ⇒ MockAdapter 收任何 key），所以它们通过 ≠ key 算对了。不写明，「30 通过」会被读成
  // 「解锁验过了」——那比 0 通过更危险，因为 0 通过没人会误解。
  console.log('  本轮通过的项**不含 key 正确性**（用宽容 ECU 跑会话/读写/轮询语义）；'
    + 'key 逐点对拍见 `npm run test:full`（需 tools/vectors/，.gitignore:118 不入库）。');
}
process.exit(fail ? 1 : 0);
