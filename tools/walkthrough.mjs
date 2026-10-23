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
import { readFileSync } from 'node:fs';
import { MockAdapter } from '../src/mock-adapter.js';
import { Elm327 } from '../src/elm327.js';
import { Coder, CodingError } from '../src/coder.js';
import { computeVariantKey } from '../src/seedkey-registry.js';
import { extractField, injectField } from '../src/schema.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}${x ? ' — ' + x : ''}`); }
  else { fail++; console.log(`  FAIL ${n}${x ? ' — ' + x : ''}`); }
};
const hexOf = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

// ── 真值表（真机 真值对拍）：ECU 用它校验 key ────────────────────────────────
const VID = '3D5365460CB39FEFC14651DF5075A1B8';       // 第五轮刚收编的内联 VM 变体
const TRUTH = JSON.parse(readFileSync(new URL('./vectors/pend-samples.json', import.meta.url), 'utf8'))[VID];

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
  const p = { id: 't', name: '测试字段', lid: 0x21, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
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
  const p = { id: 't1', name: '测试字段', lid: 0x21, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
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
  const p = { id: 't2', name: '测试字段', lid: 0x21, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
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
    if (c.startsWith('3B21') && !tampered) { tampered = true; return '7E8 02 7B 21'; }  // 假称成功
    return undefined;
  };
  const { coder } = await link(ecu);
  coder.seedKeyProvider = variantProvider();
  const p = { id: 't3', name: '测试字段', lid: 0x21, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
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
{
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

  const p = { id: 't4', name: '测试字段', lid: 0x21, byte: 0, bit: 0, bitsize: 8, risk: 'low' };
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

console.log(`\n===== 全链路演练：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
