#!/usr/bin/env node
/**
 * 2026-10-15 全量修复冒烟测试 —— 只验本次改动的代码路径。
 * 跑法: node smoke-fixes.mjs
 */
import { readFileSync } from 'node:fs';
import { Elm327 } from './src/elm327.js';
import { Coder, parseResp, CodingError } from './src/coder.js';
import { resolveKey, resolveKeyByName, makeResolverProvider } from './src/seedkey-resolver.js';
import { computeVariantKey, INLINE_OTHER_PENDING } from './src/seedkey-registry.js';
import { pswCalc } from './src/seedkey-pswcalc.js';
import { parseDtcPayload } from './src/dtc.js';
import { parseAddrPair, overrideFor } from './src/addr.js';
import { LinkDoctor } from './src/link-doctor.js';
import { parseFieldInput, fieldInRange, extractField, injectField } from './src/schema.js';
import { autoPickVariant } from './src/variant.js';
import { specialFunctionsFor } from './src/special-catalog.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}${extra ? ' -- ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -- ' + extra : ''}`); }
};

class FakePort {
  constructor() { this.sent = []; this.handlers = []; }
  write(s) { this.sent.push(String(s)); }
  on(_e, cb) { this.handlers.push(cb); }
  emit(text) { for (const h of this.handlers) h(new TextEncoder().encode(text)); }
}

// ===== 1. AT layer =====
console.log('\n[1] Elm327 AT layer');
{
  const p = new FakePort();
  const e = new Elm327(p, { timeoutMs: 500 });
  // 自动应答器：每条命令回一个 '>'，init 里命令条数会随实现变，别写死
  const auto = setInterval(() => {
    if (p.sent.length > p.replied) {
      p.replied = p.sent.length;
      const n = p.replied;
      const body = n === 3 ? 'ELM327 v2.3' : n === 4 ? '12.6V' : n === 5 ? 'A6'
        : n === 6 ? 'ISO 15765-4 CAN (11 bit ID, 500 kbit/s)' : 'OK';
      p.emit(body + '\r>');
    }
  }, 5);
  p.replied = 0;
  await e.init({ protocol: 6 }).catch((err) => { console.log('  (init threw: ' + err.message + ')'); });
  clearInterval(auto);
  const sent = p.sent.map((s) => s.replace(/\r/g, ''));
  ok('no invented ATFC0', !sent.includes('ATFC0'), sent.filter((s) => s.startsWith('ATFC')).join(','));
  ok('no ATSP0 (auto-detect always fails)', !sent.some((s) => s.startsWith('ATSP0')));
  ok('default protocol ATSP6', sent.includes('ATSP6'));
  ok('explicit ATCAF0 (parseResp needs PCI)', sent.includes('ATCAF0'));
  ok('flow control ATCFC1', sent.includes('ATCFC1'));
  ok('flow control recipe ATFCSD', sent.some((s) => s.startsWith('ATFCSD')));
  ok('flow control mode ATFCSM0', sent.includes('ATFCSM0'));
}

// ===== 2. request() serialization =====
console.log('\n[2] request() serial lock');
{
  const p = new FakePort();
  const e = new Elm327(p, { timeoutMs: 300 });
  const order = [];
  const r1 = e.request(new Uint8Array([0x22, 0x20, 0x23])).then(() => order.push('a'), () => order.push('a'));
  const r2 = e.request(new Uint8Array([0x22, 0x40, 0xa1])).then(() => order.push('b'), () => order.push('b'));
  const r3 = e.request(new Uint8Array([0x22, 0x40, 0xa2])).then(() => order.push('c'), () => order.push('c'));
  await Promise.all([r1, r2, r3]);
  ok('concurrent requests complete in submit order', order.join('') === 'abc', 'got ' + order.join(''));
  ok('reqChain lock present', typeof e.reqChain?.then === 'function');
}

// ===== 3. Coder addressing =====
console.log('\n[3] Coder address / session');
{
  const p = new FakePort();
  const e = new Elm327(p, { timeoutMs: 200 });
  const c = new Coder(e, { tx: 0x7E0, rx: 0x7E8, ecuName: 'DME' });
  // address() 现在会先发 ATSP<协议>（2026-10-17 真车修：不依赖 L4 留下的协议状态）。
  // ⚠️ 别用固定 setTimeout 喂 prompt —— reqChain 串行 + 每条 settle 120ms，
  //    固定时刻的 prompt 会被前面的命令吃光，后面的就超时（ATFCSH 写不出去）。
  //    改成按 `sent` 增长自适应回 prompt（和测试 [1] 同款）。
  p.replied = 0;
  const auto = setInterval(() => {
    if (p.sent.length > p.replied) { p.replied = p.sent.length; p.emit('OK\r>'); }
  }, 5);
  const ap = c.address().catch(() => {});
  await ap;
  clearInterval(auto);
  const sent = p.sent.map((s) => s.replace(/\r/g, ''));
  ok('ATSH uses module address', sent.includes('ATSH7E0'));
  ok('ATCRA uses module address', sent.includes('ATCRA7E8'));
  ok('ATFCSH follows module address', sent.includes('ATFCSH7E0'));
  ok('protocol pinned to ATSP6 before addressing', sent.includes('ATSP6'));
}

// ===== 4. VIN helpers =====
console.log('\n[4] VIN validate / year / model');
{
  const src = readFileSync('./src/app.js', 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    return m ? m[0] : '';
  };
  const code = grab('isValidVin') + '\n' + grab('decodeVinYear') + '\n' + grab('guessModelFromVin');
  ok('three VIN helpers present', code.split('function').length >= 4);
  const fn = new Function('tree', code + '\nreturn {isValidVin, decodeVinYear, guessModelFromVin};');
  const { isValidVin, decodeVinYear, guessModelFromVin } = fn(null);

  ok('valid VIN accepted', isValidVin('WP0AA2A99FS123456') === true);
  ok('VIN with I/O/Q rejected', isValidVin('WP0AA2A9IFS123456') === false);
  ok('short VIN rejected', isValidVin('WP0AA2A99FS1234') === false);
  ok('binary garbage rejected', isValidVin('xWP0AA2A99FS123') === false);

  ok('year F -> 2015', decodeVinYear('WP0AA2A99FS123456') === 2015);
  ok('year A -> 2010', decodeVinYear('WP0AA2A99AS123456') === 2010);
  ok('year 1 -> 2001', decodeVinYear('WP0AA2A991S123456') === 2001);

  const t1 = guessModelFromVin('WP0ZZZ970GL000001', 2016);
  ok('970 / 2016 -> Panamera-970', t1 && t1.label.includes('970'), t1 && t1.label);
  const t2 = guessModelFromVin('WP0ZZZ970GL000001', 2018);
  ok('970 but year 2018 -> rejected (out of range)', t2 === null, t2 && t2.label);
  const t3 = guessModelFromVin('WP0ZZZ971GL000001', 2018);
  ok('971 / 2018 -> Panamera-971', t3 && t3.label.includes('971'), t3 && t3.label);

  const t4 = guessModelFromVin('WP0ZZZ991GS000001', 2016);
  ok('991 exact match (duplicate removed)', t4 && t4.code === '991', t4 && t4.label);
  const t5 = guessModelFromVin('WP0ZZZ99999000001', 2016);
  ok('unknown model code does not false-match', t5 === null, t5 && t5.label);
}

// ===== 5. ECU address table =====
console.log('\n[5] ECU address table');
{
  const src = readFileSync('./src/app.js', 'utf8');
  const m = src.match(/const ECU_ADDR = \{[\s\S]*?\n\};/);
  const tbl = new Function(m[0] + '\nreturn ECU_ADDR;')();
  ok('IC 用标准 0x7E4（不是 DME 应答 0x7E8）', tbl['IC(仪表)'].tx === 0x7E4);
  ok('IC 是候选地址（标准顺序，进模块核验）', tbl['IC(仪表)'].state === 'candidate');
  ok('PASM 用 PORSCHE_SYS_DATA 1CB→7D0', tbl['水平高度控制/PASM'].tx === 0x7D0);
  ok('后端电子设备 1C6→74F', tbl['后端电子设备'].tx === 0x74F);
  {
    const ea = JSON.parse(readFileSync(new URL('./data/ecu-addresses.json', import.meta.url), 'utf8'));
    ok('CAN 地址证据表含 PASM/后端/前端/PDC/Gateway',
      ea.entries.length >= 5 && ea.entries.some((e) => e.system === 'PASM' && e.tx === '0x7D0'));
  }
  ok('座椅/摄像头/前照灯地址已补',
    tbl['驾驶员侧座椅存储器'].tx === 0x7D9 &&
    tbl['乘客侧座椅存储器'].tx === 0x7DA &&
    tbl['前摄像头'].tx === 0x7E2 &&
    tbl['左侧前照灯'].tx === 0x719);
  ok('前端电子设备 1C7→7D1', tbl['前端电子设备'].tx === 0x7D1);
  ok('DME still measured', tbl['ECM/DME(发动机控制模块)'].state === 'measured');
  ok('gateway 710/77A kept (rx != tx+8)', tbl['网关'].tx === 0x710 && tbl['网关'].rx === 0x77A);
  const used = new Map();
  for (const [k, v] of Object.entries(tbl)) {
    if (v.state !== 'measured') continue;
    used.set(v.tx, k); used.set(v.rx, k);
  }
  const clash = [];
  for (const [k, v] of Object.entries(tbl)) {
    if (v.state === 'unknown' || v.tx == null) continue;
    // 自己与自己不算冲突
    const hitTx = used.get(v.tx), hitRx = used.get(v.rx);
    if ((hitTx && hitTx !== k) || (hitRx && hitRx !== k)) clash.push(k);
  }
  ok('candidates do not clash with measured ids', clash.length === 0, clash.join(','));
}

// ===== 6. parseResp ISO-TP =====
console.log('\n[6] parseResp ISO-TP');
{
  const r = parseResp('7E8 03 62 F1 90');
  ok('single frame', r.kind === 'ok' && r.body[0] === 0x62, r.body.map((b) => b.toString(16)).join(' '));
  // 首帧带 6 字节，每条连续帧带 7 字节 → 6+7+7 = 20
  const m = parseResp('7E8 10 14 62 F1 90 57 50 30\n7E8 21 41 41 32 41 39 46 53\n7E8 22 31 32 33 34 35 36 37');
  ok('multi-frame reassembly', m.kind === 'ok' && m.body.length === 20, 'len=' + m.body.length);
  const n = parseResp('7E8 03 7F 22 31');
  ok('NRC detected', n.kind === 'nrc' && n.code === 0x31, 'code=' + n.code);
  const tr = parseResp('7E8 05 5A 9F');
  ok('单帧声明 5 字节、实收 2 字节 → truncated（不能当成功）',
     tr.kind === 'truncated' && tr.expected === 5 && tr.received === 2,
     `kind=${tr.kind} expected=${tr.expected} received=${tr.received}`);
}

// ===== 7. 非 ASAP1A seed/key（真值对拍 真值对拍）=====
console.log('\n[7] 非 ASAP1A seed/key —— 真值对拍 真值');
{
  const { computeNonAsapKey, nonAsapForName, nonAsapForModule, platformForModel, MODEL_PLATFORM, NON_ASAP_BY_MODULE }
    = await import('./src/seedkey-nonasap.js');
  const { resolveKeyByName } = await import('./src/seedkey-resolver.js');
  const { variantForName } = await import('./src/seedkey-name-map.js');

  // ⚠️ 期望值全部来自 仿真 真值对拍 实跑（原厂口令算法库），
  //    **不是** JS 自己算出来再抄回去 —— 否则实现错了也照样「通过」。
  //    PSM8 那条尤其要看大小写：C 是 sprintf("%02X") 大写。
  const CASES = [
    // [函数名, seed 字节, 期望 key 字节]
    ['SecurityAccess_9x7_ALLRAD', [0x12, 0x34], [0x00, 0x10]],
    ['SecurityAccess_9x7_ALLRAD', [0xff, 0xff], [0x00, 0x00]],
    ['SecurityAccess_9x7_ALLRAD', [0x80, 0x00], [0x00, 0x00]],
    ['SecurityAccess_9x7_ALLRAD', [0x01, 0x02], [0x01, 0x02]],
    ['SecM_9x7_PCMKey',           [0x12, 0x34], [0x26, 0x26]],
    ['SecM_9x7_PCMKey',           [0xff, 0xff], [0xff, 0xff]],
    ['SecM_9x7_PCMKey',           [0x80, 0x00], [0x88, 0x00]],
    ['SecM_9x7_PCMKey',           [0x01, 0x02], [0x02, 0x04]],
    // PSM8 输出是 ASCII 大写 hex —— ffffffff → "FFFF" 是唯一能区分大小写的点
    ['SeedAndKeyPag_9x7_SK_PSM8', [0x12, 0x34], [...'0004'].map((c) => c.charCodeAt(0))],
    ['SeedAndKeyPag_9x7_SK_PSM8', [0xff, 0xff], [...'FFFF'].map((c) => c.charCodeAt(0))],
    ['SeedAndKeyPag_9x7_SK_PSM8', [0x80, 0x00], [...'8000'].map((c) => c.charCodeAt(0))],
    ['SeedAndKeyPag_9x7_SK_PSM8', [0x01, 0x02], [...'2112'].map((c) => c.charCodeAt(0))],
    ['ASAM_seedkey_Airbag_Upload_CONFIDENTIAL', [0x12, 0x34, 0x56, 0x78], [0x14, 0x07, 0x79, 0xb7]],
    ['ASAM_seedkey_Airbag_Upload_CONFIDENTIAL', [0xff, 0xff, 0xff, 0xff], [0x90, 0x4a, 0xfb, 0xde]],
    ['ASAM_seedkey_Airbag_Upload_CONFIDENTIAL', [0x80, 0x00, 0x00, 0x00], [0x2b, 0xc6, 0xba, 0xf4]],
    ['ASAM_seedkey_Airbag_Upload_CONFIDENTIAL', [0x01, 0x02, 0x03, 0x04], [0x2d, 0xab, 0x90, 0x2e]],
    // 992 SA2（50 字节内联程序，2026-10-17 抽表 + 真值对拍 4/4）
    ['SecurityAccess_BV_SteerAssisUDS_992', [0x12, 0x34, 0x56, 0x78], [0x31, 0x7a, 0x1a, 0x3d]],
    ['SecurityAccess_BV_SteerAssisUDS_992', [0xff, 0xff, 0xff, 0xff], [0x03, 0xbe, 0x78, 0xea]],
    ['SecurityAccess_BV_SteerAssisUDS_992', [0x80, 0x00, 0x00, 0x00], [0x18, 0xc2, 0xfc, 0x5c]],
    ['SecurityAccess_BV_SteerAssisUDS_992', [0x01, 0x02, 0x03, 0x04], [0x01, 0xd6, 0x20, 0x38]],
  ];
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (const [name, seed, want] of CASES) {
    let got = null, err = null;
    try { got = computeNonAsapKey(name, Uint8Array.from(seed)).key; } catch (e) { err = e.message; }
    ok(`${name} seed=${hex(seed)}`,
       got && hex(got) === hex(want),
       err ? 'ERR ' + err : `真值对拍=${hex(want)} got=${hex(got)}`);
  }

  // PSM8 大小写专项（回归：上一轮小写实现混过了对拍）
  ok('PSM8 输出是大写 hex', (() => {
    const k = computeNonAsapKey('SeedAndKeyPag_9x7_SK_PSM8', Uint8Array.of(0xff, 0xff)).key;
    return String.fromCharCode(...k) === 'FFFF';
  })());

  // seed 长度不符必须拒算，绝不截断
  ok('PSM8 seedLen=2 才算（3 字节拒算）', (() => {
    try { computeNonAsapKey('SeedAndKeyPag_9x7_SK_PSM8', Uint8Array.of(1, 2, 3)); return false; }
    catch (e) { return /长度/.test(e.message); }
  })());
  ok('Airbag 5 字节 seed 拒算', (() => {
    try { computeNonAsapKey('ASAM_seedkey_Airbag_Upload_CONFIDENTIAL', Uint8Array.of(1, 2, 3, 4, 5)); return false; }
    catch (e) { return /长度/.test(e.message); }
  })());

  // 992 那个 SA2 已抽表（50 字节内联程序）
  ok('992 SteerAssisUDS 已实现（SA2 50 字节程序）', (() => {
    const r = computeNonAsapKey('SecurityAccess_BV_SteerAssisUDS_992', Uint8Array.of(0x12, 0x34, 0x56, 0x78));
    return hex(r.key) === '317a1a3d';
  })());

  // 名字分发：精确函数名 + **平台限定**模块名
  ok('精确函数名命中非 ASAP1A', nonAsapForName('SecurityAccess_9x7_ALLRAD')?.seedLen === 2);
  ok('992 平台 BV_SteerAssisUDS 命中（SPECF 证据）',
     nonAsapForModule('992', 'BV_SteerAssisUDS')?.name === 'SecurityAccess_BV_SteerAssisUDS_992');
  // ⚠️ 同名模块跨平台必须分开 —— 不分平台会把 E3/G2 用上 992 算法
  ok('E3 平台 BV_SteerAssisUDS **不**命中 992 算法', nonAsapForModule('E3', 'BV_SteerAssisUDS') === null);
  ok('G2 平台 BV_SteerAssisUDS **不**命中 992 算法', nonAsapForModule('G2', 'BV_SteerAssisUDS') === null);
  ok('9X7 平台 _9x7_psm 命中 PSM8', nonAsapForModule('9X7', '_9x7_psm')?.name === 'SeedAndKeyPag_9x7_SK_PSM8');
  ok('9X7 平台 _9x7_pcm2_mmi 命中 PCMKey', nonAsapForModule('9X7', '_9x7_pcm2_mmi')?.name === 'SecM_9x7_PCMKey');
  ok('9X1 平台 _9x7_psm **不**命中（模块本就只在 9X7）', nonAsapForModule('9X1', '_9x7_psm') === null);
  // ⚠️ 堵住手误：查找时两侧都 .toUpperCase()，表里的 key 必须**已经是大写**，
  //    否则 `_9x7_pcm2_tel` 这种会静默查不到（2026-10-17 真踩过：TEL 那条写成了小写 x）
  ok('NON_ASAP_BY_MODULE 的 key 全是大写（查找是大小写不敏感的）',
     Object.keys(NON_ASAP_BY_MODULE).every((k) => k === k.toUpperCase()),
     Object.keys(NON_ASAP_BY_MODULE).filter((k) => k !== k.toUpperCase()).join(','));
  ok('9X7 六个 pcm2 子模块全部命中', ['AMP', 'CDC', 'GW', 'MMI', 'NAVI', 'TEL']
     .every((s) => nonAsapForModule('9X7', `_9x7_pcm2_${s.toLowerCase()}`)?.name === 'SecM_9x7_PCMKey'));

  // model → platform（对照车数据校验，数据变了测试会红）
  ok('911（992）→ 992', platformForModel('911（992）') === '992');
  ok('911（997）→ 9X7', platformForModel('911（997）') === '9X7');
  ok('未知车型 → null（不猜）', platformForModel('不存在的车') === null);
  {
    // 用 data/models/*.json 的 items[].platform 反查 MODEL_PLATFORM 的正确性
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const seen = new Map();
    const walk = (d) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.json')) {
          try {
            const j = JSON.parse(readFileSync(p, 'utf8'));
            const plat = j?.items?.[0]?.platform;
            if (j?.model && plat) {
              if (!seen.has(j.model)) seen.set(j.model, new Set());
              seen.get(j.model).add(plat);
            }
          } catch { /* 坏文件跳过 */ }
        }
      }
    };
    walk('data/models');
    let bad = [];
    for (const [model, plats] of seen) {
      const want = platformForModel(model);
      // 数据里一个车型可能跨多平台（如 GT2（996）），只要表里的值在集合里就算对
      if (!want) bad.push(`${model} → null，数据是 ${[...plats]}`);
      else if (!plats.has(want)) bad.push(`${model} → ${want}，数据是 ${[...plats]}`);
    }
    ok(`model→platform 对照车数据（${seen.size} 个车型）`, bad.length === 0, bad.slice(0, 3).join(' | '));
    ok('MODEL_PLATFORM 无多余条目（表里每条都在数据里）',
       Object.keys(MODEL_PLATFORM).every((k) => seen.has(k)),
       Object.keys(MODEL_PLATFORM).filter((k) => !seen.has(k)).join(','));
  }
  // ⚠️ 这三个在 ASAP1A 表里已有正解，非 ASAP1A **绝不能抢**
  ok('Allrad 不被非 ASAP1A 抢走', nonAsapForName('Allrad') === null);
  ok('PSM 不被非 ASAP1A 抢走', nonAsapForName('PSM') === null);
  ok('Airbag 不被非 ASAP1A 抢走', nonAsapForName('Airbag') === null);
  ok('ASAM_seedkey_Airbag（ASAP1A）不被抢走', nonAsapForName('ASAM_seedkey_Airbag') === null
     && variantForName('ASAM_seedkey_Airbag') === 'B74881986F0C8ECE89CD36FB0EB54F84');

  // resolveKeyByName 端到端：2 字节 seed 不能丢字节
  ok('resolveKeyByName 2 字节 seed 不丢字节', (() => {
    const r = resolveKeyByName('SecurityAccess_9x7_ALLRAD', Uint8Array.of(0x12, 0x34));
    return hex(r.key) === '0010' && r.nonAsap === true;
  })());
  ok('resolveKeyByName 传 32 位也能算（回退路径）', (() => {
    const r = resolveKeyByName('SecurityAccess_9x7_ALLRAD', 0x12340000);
    return hex(r.key) === '0010';
  })());

  // —— 内联 MULADD（32 点 真值对拍 合成 + 独立复核）——
  const { computeVariantKey, INLINE_MULADD, INLINE_OTHER_PENDING } = await import('./src/seedkey-registry.js');
  ok('INLINE_MULADD 已收编（当前 ' + Object.keys(INLINE_MULADD).length + '）', Object.keys(INLINE_MULADD).length >= 6);
  ok('INLINE_OTHER_PENDING 仍在收窄（当前 ' + INLINE_OTHER_PENDING.length + '）', INLINE_OTHER_PENDING.length < 38);
  {
    const { readFileSync } = await import('node:fs');
    const samp = JSON.parse(readFileSync('/tmp/pend-samples.json', 'utf8'));
    let okN = 0, badN = 0, bads = [];
    for (const id of Object.keys(INLINE_MULADD)) {
      for (const r of (samp[id] || [])) {
        const seed = Uint8Array.from(r.seed.match(/../g).map((x) => parseInt(x, 16)));
        const got = [...computeVariantKey(id, seed).key].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        if (got === r.key) okN++; else { badN++; bads.push(`${id.slice(0, 8)}:${r.seed}`); }
      }
    }
    ok(`MULADD 六变体 × 32 点 真值对拍（${okN} 点）`, badN === 0, bads.slice(0, 3).join(' '));
  }
  // ⚠️ 高价值：`Allrad` / `KLSM` / `Dummy` 共用 CB4E06 —— 现在必须能算
  ok('Allrad（ASAM_seedkey_Allrad）现在能算 key', (() => {
    try {
      const r = resolveKeyByName('ASAM_seedkey_Allrad', Uint8Array.of(0x12, 0x34, 0x56, 0x78));
      return r.key?.length === 4 && r.algo === 'MULADD';
    } catch (e) { return false; }
  })());
  ok('CB4E06 与 C3E762 是同一算法（参数一致）',
     INLINE_MULADD['CB4E06CAEDC58D35B8055A240C1B1B89'].A === INLINE_MULADD['C3E7624220B63E3BE18878067DE4748C'].A
     && INLINE_MULADD['CB4E06CAEDC58D35B8055A240C1B1B89'].B === INLINE_MULADD['C3E7624220B63E3BE18878067DE4748C'].B);

  // —— mode 路径：0x48 = ~seed（mode 0x48  size=136 真函数）——
  {
    const { pswCalc, PENDING_MODES } = await import('./src/seedkey-pswcalc.js');
    ok('mode 0x48 已收编（不再 PENDING）', !(0x48 in PENDING_MODES));
    const { readFileSync } = await import('node:fs');
    const MS = JSON.parse(readFileSync('/tmp/mode-samples.json', 'utf8'));
    const rows = (MS['0x48'] || []).filter((r) => r.key != null);
    let okN = 0, badN = 0;
    for (const r of rows) {
      const got = pswCalc(0x48, parseInt(r.seed, 16) >>> 0).key >>> 0;
      if (got === (parseInt(r.key, 16) >>> 0)) okN++; else badN++;
    }
    ok(`mode 0x48 = ~seed 对拍 真值对拍（${okN} 点）`, badN === 0);
    // ⚠️ 0x1d 的 mode 0x1D 只有 2 字节空壳，「identity」是假解 —— 必须仍 PENDING
    ok('mode 0x1d 仍 PENDING（mode 0x1D 是 2 字节空壳，非真算法）', 0x1d in PENDING_MODES);
    // mode 0x02：rotate+combine **符号扩展**语义（n==0 保留完整 seed），32/32
    ok('mode 0x02 已收编', !(0x02 in PENDING_MODES));
    {
      const rows = (MS['0x02'] || []).filter((r) => r.key != null);
      let okN = 0, badN = 0;
      for (const r of rows) {
        const got = pswCalc(0x02, parseInt(r.seed, 16) >>> 0).key >>> 0;
        if (got === (parseInt(r.key, 16) >>> 0)) okN++; else badN++;
      }
      ok(`mode 0x02 对拍 真值对拍（${okN} 点）`, badN === 0);
      // n==0 时保留完整 seed —— 用 0x80000000 这个点卡住（它 n=0）
      ok('mode 0x02 n==0 时保留完整 seed',
         pswCalc(0x02, 0x80000000).key >>> 0 === 0x80000000);
    }
  }
}

// ===== 8. 特殊功能：安全访问必须在 0x31 之前 =====
console.log('\n[8] 特殊功能安全访问');
{
  const src = readFileSync('./src/app.js', 'utf8');
  // 实测基准：27 09 → 31 xx（FINDINGS「关键请求」）
  const iSec = src.indexOf('securityAccessEx({ level: 0x09');
  const iRout = src.indexOf('coder.runRoutine(sf, id');
  ok('特殊功能路径调用了 securityAccessEx(0x09)', iSec > 0);
  ok('securityAccessEx 在 runRoutine **之前**', iSec > 0 && iRout > 0 && iSec < iRout);
  ok('特殊功能用 UDS 27（不是 KWP 17）',
     /securityAccessEx\(\{\s*level:\s*0x09,\s*kwp:\s*false/.test(src));
  // MES 定论（REAUDIT-20261017）：跟随服务轮询直到响应不是 21/23/24/78
  ok('例程走 runRoutine（含 31 03 跟随轮询）', iRout > 0);
  ok('轮询可被打断（shouldStop）', /shouldStop:\s*\(\)\s*=>\s*routineAbort/.test(src));

  const coderSrc = readFileSync('./src/coder.js', 'utf8');
  ok('securityAccessEx 默认不截断 key（keyBytes=null）',
     /keyBytes\s*=\s*null/.test(coderSrc) && /if \(keyBytes != null && keyBytes > 0\) kHex = kHex\.slice/.test(coderSrc));
  // ⚠️ 断言签名里的默认值，别用宽松正则 —— 注释里也有 `keyBytes=2` 字样（踩过）
  ok('截断只在显式传 keyBytes 时发生（签名默认 null）',
     /async function securityAccessEx\(\{[^}]*keyBytes\s*=\s*null/.test(coderSrc));
  // keyBytes=0 是 SEC_PROFILES 里 KWP 项的取值，语义是「由算法决定」，不能截成空 key
  ok('keyBytes=0 不截断（不是截成 0 字节）', /keyBytes\s*>\s*0/.test(coderSrc));
}


// ===== 9. 2026-10-18 收编 mode + 三处回归 =====
console.log('\n[9] 原语 mode 收编 / 解析器 / 空 seed');
{
  const samples = JSON.parse(readFileSync('./tools/vectors/mode-samples.json', 'utf8'));
  // 新收编的 19 个 mode：直接拿 仿真 采样对拍（不只挑几个点）
  const modes = [0x13, 0x15, 0x16, 0x19, 0x1b, 0x1f, 0x28, 0x29, 0x2d, 0x30,
                 0x35, 0x42, 0x47, 0x4f, 0x5b, 0x5c, 0x5d, 0x65, 0x68];
  let bad = [];
  for (const m of modes) {
    const rows = samples['0x' + m.toString(16)];
    if (!rows) continue;
    for (const r of rows) {
      if (r.key == null) continue;
      let got;
      try { got = resolveKey(m, parseInt(r.seed, 16), {}).key >>> 0; } catch (e) { got = null; }
      if (got !== parseInt(r.key, 16)) { bad.push(`0x${m.toString(16)}/${r.seed}`); }
    }
  }
  ok('19 个原语 mode 全部进 resolveKey 并对拍 真值对拍', bad.length === 0,
     bad.slice(0, 4).join(','));
  // resolver 早先不认识 RAW_MODE_FNS —— 这条专防「实现了但接不上」
  ok('resolveKey(0x13) 不再抛「待逆」', (() => {
    try { resolveKey(0x13, 0x12345678, {}); return true; } catch (e) { return false; }
  })());

  // ASAM 变体全家族分发：0xB7 指向 MULADD 族（C3E76242），早先被误判「尚未逆出」
  ok('resolveKey(0xB7) 走 MULADD 变体不报错', (() => {
    try { return resolveKey(0xb7, 0x12345678, {}).key > 0; } catch (e) { return false; }
  })());

  // 名字路径也要覆盖 XOR_MULADD / RC32（早先白名单里没有这两个族）
  const n1 = resolveKeyByName('ASAM_seedkey_BCM_H', new Uint8Array([0x12, 0x34, 0x56, 0x78]), {});
  ok('名字→XOR_MULADD 变体能算 key', n1.key.length === 4 && n1.key.some((b) => b !== 0));
  const n2 = resolveKeyByName('ASAM_seedkey_BDE_CODING', new Uint8Array([0x12, 0x34, 0x56, 0x78]), {});
  ok('名字→RC32 变体能算 key', n2.key.length === 4 && n2.key.some((b) => b !== 0));

  // ISO-TP 流控帧：0x30 帧不能被当载荷拼进 body（旧代码里的判断是死代码）
  // 用**真实 ATH1 形态**（每行带 CAN ID）—— 无 ID 的连写行本来就靠长度启发式，
  // 18 字符会被当成「29 位 ID + 数据」，那种输入不是实车输出。
  const p1 = parseResp('7E8 10 0A 62 01 02 03 04 05\r7E8 30 00 00\r7E8 21 06 07 08 09\r');
  ok('parseResp 跳过流控帧（0x30）',
     p1.kind === 'ok' && p1.body.length === 10 && p1.body[0] === 0x62,
     `kind=${p1.kind} len=${p1.body.length}`);

  // 空 seed 绝不能当「无需解锁」
  const fakeElm = { cmd: async () => '' };
  const c = new Coder(fakeElm, { tx: 0x7e0, rx: 0x7e8, ecuName: 'T' });
  c.seedKeyProvider = { name: 'stub', calc: () => Uint8Array.of(1, 2) };
  let threw = false;
  try { await c.securityAccessEx({ level: 0x09 }); } catch (e) { threw = /取 seed 返回空/.test(e.message); }
  ok('securityAccessEx 空 seed 报错（不再静默「无需解锁」）', threw);
}

// ===== 10. 2026-10-18 第二轮：变体家族收编 =====
console.log('\n[10] 变体家族收编（RC16 / RC16B / BYTELOOP / 移位反馈32 / RORADD26 / CRC24 / RC_VAR）');
{
  const S = JSON.parse(readFileSync('./tools/vectors/pend-samples.json', 'utf8'));
  const ids = ['E70BF466', 'C1CBA4AF', '2BF9206C', 'D2ACD9A3', '3EF21C75', 'C5A5A0A7',
               'CF204DC3', 'ED8C844E', '42FFC7E0', '76F77EB4', '9316E2B4',
               '1C6D5638', '0A8B1B4C', '11747BDA', '01A56221', '9E46569F',
               'E006B2FF', 'F7297A9C',
               // 2026-10-18 第六轮收编：CRC32（EPB_VR7/VR8）+ NOT_MULADD（9x1 BKE）
               '7F6DED18', '_NEW9x1BKE'];
  const bad = [];
  for (const pre of ids) {
    const full = Object.keys(S).find((k) => k.startsWith(pre));
    if (!full) { bad.push(pre + ':无采样'); continue; }
    for (const r of S[full]) {
      if (r.key == null) continue;
      const v = parseInt(r.seed, 16) >>> 0;
      const bytes = Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      let got;
      try { got = Array.from(computeVariantKey(full, bytes).key).map((x) => x.toString(16).padStart(2, '0')).join(''); }
      catch (e) { got = 'ERR'; }
      if (got.toLowerCase() !== r.key.toLowerCase()) { bad.push(`${pre}/${r.seed}`); break; }
    }
  }
  ok('20 个变体 × 32 点全部对上 真值对拍', bad.length === 0, bad.slice(0, 5).join(','));

  // 位抽取里「数组顺序 ≠ 权重」是这次踩过的坑（E006B2FF 第一次就写反了）
  const e006 = computeVariantKey('E006B2FF19D9E1784A4B1E156444432B',
    Uint8Array.of(0x12, 0x34, 0x56, 0x78));
  ok('E006B2FF 位权重没写反（seed 12345678 → 7a36767e）',
     Array.from(e006.key).map((x) => x.toString(16).padStart(2, '0')).join('') === '7a36767e');

  // ✅ 2026-10-18 第六轮：最后两条待逆都收编了，INLINE_OTHER_PENDING 清空。
  //    现在断言反过来 —— **必须能算且等于 真值对拍**（不是「不抛错」就算过）。
  ok('INLINE_OTHER_PENDING 已清空（name-map 71/71 全可算）',
     INLINE_OTHER_PENDING.length === 0, `剩 ${INLINE_OTHER_PENDING.length} 条`);

  // 7F6DED18 —— 32 位位串行 CRC + 收尾半字节置换
  {
    const k = computeVariantKey('7F6DED184289B009A3EBCF9DB4EE46F7', Uint8Array.of(0x12, 0x34, 0x56, 0x78));
    const got = Array.from(k.key).map((x) => x.toString(16).padStart(2, '0')).join('');
    ok('7F6DED18 已收编（seed 12345678 → 70505f43）', got === '70505f43', `got=${got}`);
    // ⚠️ 反退化：判据必须是 m ^ bit。按「只看移出的位 m」建模会得到恒差 0x301A8951 的结果
    //    （差值恒定 = 数据/初值错，不是判据错），这条断言专治把判据改回去。
    const k0 = computeVariantKey('7F6DED184289B009A3EBCF9DB4EE46F7', Uint8Array.of(0, 0, 0, 0));
    ok('7F6DED18 seed 全 0 → 00bc842f（判据 m^bit 没被改回 m）',
       Array.from(k0.key).map((x) => x.toString(16).padStart(2, '0')).join('') === '00bc842f');
  }

  // _NEW9x1BKE —— NOT_MULADD(~s, 0xB548AD3E, 0x62A6FA29)，seed **必须是 4 字节**
  {
    const k = computeVariantKey('_NEW9x1BKE', Uint8Array.of(0x12, 0x34, 0x56, 0x78));
    const got = Array.from(k.key).map((x) => x.toString(16).padStart(2, '0')).join('');
    ok('_NEW9x1BKE 已收编（seed 12345678 → bc8243db）', got === 'bc8243db', `got=${got}`);
    let t2 = false;
    try { computeVariantKey('_NEW9x1BKE', Uint8Array.of(0x12, 0x34)); } catch (e) { t2 = true; }
    ok('_NEW9x1BKE 只读 4 字节 seed，2 字节一律拒算（C 里根本不看 param_2）', t2);
  }
  // 3D536546 现在要能算，且结果必须等于 真值对拍（不是「不抛错」就算过）
  {
    const k = computeVariantKey('3D5365460CB39FEFC14651DF5075A1B8', Uint8Array.of(0x12, 0x34, 0x56, 0x78));
    const got = Array.from(k.key).map((x) => x.toString(16).padStart(2, '0')).join('');
    const want = (JSON.parse(readFileSync('./tools/vectors/pend-samples.json', 'utf8'))
      ['3D5365460CB39FEFC14651DF5075A1B8'].find((r) => r.seed === '12345678') || {}).key || '';
    ok('3D536546 已收编且对上 真值对拍', got === want.toLowerCase(), `got=${got} want=${want}`);
  }
}

// ===== 11. 例程跟随轮询（MES 定论：NRC 21/23/24/78 → 31 03 轮询到完成） =====
console.log('\n[11] 例程跟随服务轮询（NRC 0x78 → 31 03）');
{
  const mkCoder = (handler) => {
    const c = new Coder(new Elm327(new FakePort(), { timeoutMs: 1 }),
      { tx: 0x6C0, rx: 0x6C8, verbose: false });
    c.uds = handler;
    return c;
  };

  // ① 31 01 回 0x78，31 03 先回 0x78 再回 0x21，第三次出正响应
  {
    let n3103 = 0;
    const seen = [];
    const c = mkCoder(async (hex) => {
      seen.push(hex);
      if (hex.startsWith('3101')) throw new CodingError('例程未完成', 0x78);
      n3103 += 1;
      if (n3103 === 1) throw new CodingError('响应挂起', 0x78);
      if (n3103 === 2) throw new CodingError('忙', 0x21);
      return { kind: 'ok', body: [0x71, 0x01, 0x02, 0x03] };
    });
    const { result, polled } = await c.runRoutine(0x01, 0x0203, '', { intervalMs: 1, maxMs: 5000 });
    ok('31 01 回 NRC 0x78 时不判失败，转 31 03 轮询', polled === 3, `polled=${polled}`);
    ok('轮询最终取到正响应 71', Array.from(result.body).join(',') === '113,1,2,3');
    ok('轮询只在「未完成」类 NRC 上继续', seen.filter((h) => h.startsWith('3103')).length === 3);
  }

  // ② 非「未完成」NRC 必须立刻抛，不许轮询（0x33 安全拒绝 → 轮询只会白吃尝试计数）
  {
    const c = mkCoder(async (hex) => {
      if (hex.startsWith('3101')) throw new CodingError('安全访问被拒', 0x33);
      throw new Error('不该走到 3103');
    });
    let threw = null;
    try { await c.runRoutine(0x01, 0x0203, '', { intervalMs: 1 }); } catch (e) { threw = e; }
    ok('NRC 0x33 立刻抛出，不转轮询', threw instanceof CodingError && threw.nrc === 0x33);
  }

  // ③ 轮询超时必须报错，且明确提示「不要重复点执行」
  {
    const c = mkCoder(async () => { throw new CodingError('忙', 0x21); });
    let threw = null;
    try { await c.runRoutine(0x01, 0x0203, '', { intervalMs: 1, maxMs: 30 }); } catch (e) { threw = e; }
    ok('轮询超时抛错而不是假成功',
       threw instanceof CodingError && /未完成/.test(threw.message), threw && threw.message);
    ok('超时提示禁止重复 startRoutine', threw && /不要重复点/.test(threw.message));
  }

  // ④ stopRoutine(0x02) 不轮询（「取消」等下去没意义）；查结果(0x03) 要轮询
  {
    let n = 0;
    const c = mkCoder(async (hex) => {
      n += 1;
      throw new CodingError('忙', 0x21);
    });
    let threw = null;
    try { await c.runRoutine(0x02, 0x0203, '', { intervalMs: 1 }); } catch (e) { threw = e; }
    ok('stopRoutine 不转轮询', threw instanceof CodingError && threw.nrc === 0x21 && n === 1, `n=${n}`);
  }
  {
    let n3103 = 0;
    const c = mkCoder(async (hex) => {
      // 第 1 次是 runRoutine 自己的 31 03，第 2 次是轮询第 1 圈，第 3 次才出结果
      if (hex.startsWith('3103') && ++n3103 >= 3) return { kind: 'ok', body: [0x71, 0x03, 0x00] };
      throw new CodingError('忙', 0x21);
    });
    const { polled } = await c.runRoutine(0x03, 0x0203, '', { intervalMs: 1, maxMs: 5000 });
    ok('查结果(0x03) 也转轮询', polled === 2, `polled=${polled}`);
  }

  // ⑤ 用户取消要能打断轮询（MES：取消后应发恢复命令）
  {
    let n = 0;
    const c = mkCoder(async () => { n += 1; throw new CodingError('忙', 0x21); });
    let threw = null;
    try {
      await c.runRoutine(0x01, 0x0203, '', { intervalMs: 1, maxMs: 5000, shouldStop: () => n >= 2 });
    } catch (e) { threw = e; }
    ok('shouldStop 能打断轮询', threw instanceof CodingError && /中止/.test(threw.message));
    ok('打断后不再继续敲 ECU', n === 2, `n=${n}`);
  }
}

// ===== 12. 原厂「无 case」mode 绝不能发出全零 key =====
console.log('\n[12] mode 无 case → 拒发 key（不得发 00 00 00 00）');
{
  const mkCoder = (resp) => {
    const c = new Coder(new Elm327(new FakePort(), { timeoutMs: 1 }),
      { tx: 0x6C0, rx: 0x6C8, verbose: false });
    c.elm.cmd = async () => resp;   // 固定应答
    return c;
  };
  // 单帧 `04 67 09 12 34` → body=[67 09 12 34] → seed=[12 34]（非零）
  const SEED_SF = '04 67 09 12 34';

  // ① 无 case mode（0x83，DRIVELINKS 里 29 条）：必须拒写，且**一条 key 都不许发**
  {
    const c = mkCoder(SEED_SF);
    const sent = [];
    const realCmd = c.elm.cmd;
    c.elm.cmd = async (h, t) => { sent.push(h); return realCmd(h, t); };
    c.seedKeyProvider = makeResolverProvider(0x83, {});
    let threw = null;
    try { await c.securityAccessEx({ level: 0x09, kwp: false }); } catch (e) { threw = e; }
    ok('无 case mode 拒写（不静默通过）', threw instanceof CodingError, threw && threw.message.slice(0, 40));
    ok('报错指向「模块/会话/寻址」而不是算法', threw && /没有对应的算法分支/.test(threw.message));
    // 只筛 UDS 请求（address() 还会发 ATSP6/ATSH/ATCRA/ATFCSH）
    const udsReq = sent.filter((h) => /^27/i.test(h));
    // UDS level 0x09 实测形态是 `27 09 01 00`（带 2 字节尾参）；securityAccessEx 必须对齐。
    ok('只发了取 seed 一条（27 09 01 00），没发 key',
       udsReq.length === 1 && udsReq[0] === '27090100', udsReq.join(','));
  }

  // ② 有算法 mode（0x59）仍要正常发 key
  {
    const c = mkCoder(SEED_SF);
    const sent = [];
    const realCmd = c.elm.cmd;
    c.elm.cmd = async (h, t) => { sent.push(h); return realCmd(h, t); };
    c.seedKeyProvider = makeResolverProvider(0x59, {});
    const okRun = await c.securityAccessEx({ level: 0x09, kwp: false });
    ok('有算法 mode 正常解锁', okRun === true);
    const udsReq = sent.filter((h) => /^27/i.test(h));
    ok('发出的 key 非空且非全零',
       udsReq.length === 2 && /^270A/i.test(udsReq[1]) && !/^270A0+$/i.test(udsReq[1]),
       udsReq.join(','));
  }

  // ③ provider.calc 必须按 outlen 返回长度，不能一律 4 字节
  {
    const p0 = makeResolverProvider(0x83, {});
    ok('无 case → calc 返回 0 字节（不是 4 个 0）', p0.calc(new Uint8Array([1, 2, 3, 4])).length === 0);
    ok('provider 暴露 needsKey=false', p0.needsKey === false);
    const p1 = makeResolverProvider(0x59, {});
    ok('有算法 → calc 返回 4 字节', p1.calc(new Uint8Array([1, 2, 3, 4])).length === 4);
    ok('provider 暴露 needsKey=true', p1.needsKey === true);
  }

  // ④ 覆盖率口径：ZERO 假成功不能算「已收编」
  {
    const dl = JSON.parse(readFileSync('./data/drivelinks.json', 'utf8'));
    let real = 0, noAlgo = 0, threw = 0, tot = 0;
    for (const [ecu, arr] of Object.entries(dl.ecu)) {
      for (const r of arr) {
        tot++;
        try {
          const x = resolveKey(r.m, 0x12345678);
          if (x.needsKey === false) noAlgo++; else real++;
        } catch (e) { threw++; }
      }
    }
    ok('DRIVELINKS 总数 980', tot === 980, `tot=${tot}`);
    ok('真·有算法 ≥ 600 条', real >= 600, `real=${real}`);
    ok('「原厂无 case」条目被单独计数，不混入已收编', noAlgo > 0 && noAlgo < tot, `noAlgo=${noAlgo}`);
    ok('明确拒写条目只剩 0x00/0x1d（0x7a/0x7b 已收编）', threw > 0 && threw <= 4, `threw=${threw}`);
    console.log(`       （口径：有算法 ${real} / 无 case ${noAlgo} / 拒写 ${threw} = ${tot}）`);
  }
}

// ── [13] 字长 VM（mode 0x6E–0x77 族）──────────────────────────────────────
// 真机 真值对拍 向量固化在 tools/vectors/wordvm-samples.json（9 mode × 32 点，
// 由 tools/sample-modes.py 跑 仿真 实跑 .so 采集）。
{
  console.log('\n[13] 字长 VM（64 位累加器解释器）');
  const { wordVmRun } = await import('./src/seedkey-wordvm.js');
  const { WORDVM_PROGRAMS, pswCalc } = await import('./src/seedkey-pswcalc.js');
  const v = JSON.parse(readFileSync('./tools/vectors/wordvm-samples.json', 'utf8'));
  const h2b = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

  ok('向量覆盖 9 个 mode', Object.keys(v).length === 9, Object.keys(v).join(','));
  let tot = 0, bad = 0; const badModes = [];
  for (const [name, rows] of Object.entries(v)) {
    const mode = parseInt(name.slice(-2), 16);
    const p = h2b(WORDVM_PROGRAMS[mode]);
    let okN = 0;
    for (const r of rows) {
      tot++;
      const got = (wordVmRun(parseInt(r.seed, 16), p) >>> 0).toString(16).toUpperCase().padStart(8, '0');
      if (got === r.key.toUpperCase()) okN++; else bad++;
    }
    if (okN !== rows.length) badModes.push(`0x${mode.toString(16)}(${okN}/${rows.length})`);
  }
  ok(`字长 VM 对拍 ${tot} 点全过`, bad === 0, bad ? badModes.join(' ') : `${tot} 点`);

  // 0x73 是字长 VM 的「分水岭」：字节版 sa2Run 只能对 28/32，
  // 差在 SHR1 的 bit31 还要吃「SUB 借位留下的 hi」。这条断言防止退回字节版。
  {
    const { sa2Run } = await import('./src/seedkey-sa2.js');
    const rows = v['mode_0x73'];
    const p = h2b(WORDVM_PROGRAMS[0x73]);
    let byteOk = 0;
    for (const r of rows) {
      const got = (sa2Run(parseInt(r.seed, 16), p) >>> 0).toString(16).toUpperCase().padStart(8, '0');
      if (got === r.key.toUpperCase()) byteOk++;
    }
    ok('0x73 字节版会错（证明必须用字长 VM）', byteOk < rows.length, `${byteOk}/${rows.length}`);
    ok('0x73 字长版全对', pswCalc(0x73, 0x3456789A).key === 0x7f5c8864,
       (pswCalc(0x73, 0x3456789A).key >>> 0).toString(16));
  }

  // 分发器必须走 wordVmRun，不是 sa2Run
  ok('pswCalc 对 0x6E 报 WORDVM 算法名', /WORDVM/.test(pswCalc(0x6e, 1).algo), pswCalc(0x6e, 1).algo);
  ok('0x6E/0x73/0x75/0x76/0x77 都不再走 PENDING',
     [0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x75, 0x76, 0x77]
       .every((m) => { try { pswCalc(m, 1); return true; } catch (e) { return false; } }));
}

// ── [14] 内联 VM 家族（解释器被编译器内联进变体函数体）──────────────────────
// 与 [13] 字长 VM、SA2 是**三套独立解释器**，语义相近但机制不同，不许合并。
// 向量来源 tools/vectors/pend-samples.json（真机 仿真 实跑 .so，32 点/变体）。
{
  console.log('\n[14] 内联 VM（40B 栈上程序 + do-while switch）');
  const { inlineVmRun } = await import('./src/seedkey-inlinevm.js');
  const { computeVariantKey, INLINE_VM_PROGRAMS, INLINE_OTHER_PENDING } =
    await import('./src/seedkey-registry.js');
  const { sa2Run } = await import('./src/seedkey-sa2.js');
  const pend = JSON.parse(readFileSync('./tools/vectors/pend-samples.json', 'utf8'));
  const h2b = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

  ok('登记 4 个内联 VM 变体', Object.keys(INLINE_VM_PROGRAMS).length === 4,
     String(Object.keys(INLINE_VM_PROGRAMS).length));

  let tot = 0, bad = 0; const badIds = [];
  for (const [id, hex] of Object.entries(INLINE_VM_PROGRAMS)) {
    const p = h2b(hex);
    const rows = pend[id];
    if (!rows) { badIds.push(id.slice(0, 8) + '(无向量)'); continue; }
    let okN = 0;
    for (const r of rows) {
      tot++;
      const seed = h2b(r.seed);
      const out = computeVariantKey(id, seed);
      const got = Array.from(out.key).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
      if (got === r.key.toUpperCase()) okN++; else bad++;
    }
    if (okN !== rows.length) badIds.push(`${id.slice(0, 8)}(${okN}/${rows.length})`);
  }
  ok(`内联 VM 经 registry 对拍 ${tot} 点全过`, bad === 0 && tot === 128,
     bad ? badIds.join(' ') : `${tot} 点`);

  // 程序必须以 0x4c 结尾（提取器校验项；防止拷错 rodata 偏移）
  ok('4 段程序都以 0x4C(HALT) 结尾',
     Object.values(INLINE_VM_PROGRAMS).every((h) => h.slice(-2).toLowerCase() === '4c'));

  // 3D536546 = DRIVELINKS mode 0xb1 的落点，必须已移出 PENDING
  ok('3D536546 已移出 INLINE_OTHER_PENDING',
     !INLINE_OTHER_PENDING.some((p) => p.id === '3D5365460CB39FEFC14651DF5075A1B8'));
  ok('mode 0xb1 现在能算（拒写里不再有它）',
     (() => { try { return resolveKey(0xb1, 0x12345678) != null; } catch (e) { return false; } })());

  // ⚠️ 三套解释器必须保持独立：这一族 FOR 是「计数器栈 + 回跳」，
  //    sa2Run 是「递归 count 次」，count<=0 时行为分叉（sa2 把 x 归零 / 内联会转 256 圈）。
  //    现在 4 段程序两者结果相同（count>0 且无跨循环跳转），但语义不许合并。
  ok('内联 VM 是独立模块（不是复用 sa2）',
     readFileSync('./src/seedkey-inlinevm.js', 'utf8').includes('export function inlineVmRun'));
  ok('registry 显式 import 了内联 VM',
     readFileSync('./src/seedkey-registry.js', 'utf8').includes("from './seedkey-inlinevm.js'"));
  {
    // 构造一个 count=0 的 FOR 程序，验证两套语义确实不同（防合并的关键证据）
    const p = Uint8Array.from([0x68, 0x00, 0x81, 0x49, 0x4c]);   // FOR 0; ROL1; FOREND; HALT
    const inline = inlineVmRun(0x12345678, p);
    const sa = sa2Run(0x12345678, p);
    ok('count=0 时两套解释器结果不同（证明语义真有分歧）',
       inline !== sa, `内联=${(inline >>> 0).toString(16)} sa2=${(sa >>> 0).toString(16)}`);
  }
  // 未定义指令必须返回 null（拒绝猜测），不能返回 0
  ok('未定义指令返回 null（不猜）',
     inlineVmRun(0x12345678, Uint8Array.from([0x83, 0x4c])) === null &&
     inlineVmRun(0x12345678, Uint8Array.from([0x99, 0x4c])) === null);
}

// ===== 15. 特殊功能（0x31 例程）可用性 =====
// 背景：special-functions.json 那 67 个 routineId 是手工菜单索引（0x200–0x34E），
// 与实测基准 RID（COMMAND.GAG，79 个）交集只有 1 个 —— 不能拿去发 31 01。
// 这组断言锁死三件事：① 实测库在且合法 ② 假 ID 不许被标成已核实 ③ UI 不再有死按钮。
console.log('\n[15] 特殊功能 / 例程 0x31');
{
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const ver = readJson('./data/routines-verified.json');
  const sf = readJson('./data/special-functions.json');

  ok('实测例程库存在且非空', ver.count > 0 && Array.isArray(ver.items) && ver.items.length === ver.count,
     `${ver.count} 个 RID / ${ver.requestCount} 次实测请求`);

  const badRid = ver.items.filter((r) => {
    const n = parseInt(String(r.routineId).replace(/^0x/i, ''), 16);
    return !Number.isFinite(n) || n < 0 || n > 0xffff || !(r.subFuncs || []).length;
  });
  ok('每个实测 RID 合法且至少有一个实测子功能', badRid.length === 0,
     badRid.slice(0, 3).map((r) => r.routineId).join(','));

  const hits = ver.items.reduce((s, r) => s + r.hits, 0);
  ok('hits 总和 + 无 RID 请求 = 0x31 请求总数（无重复计数）',
     hits + (ver.noRidCount ?? 0) === ver.requestCount,
     `${hits} + ${ver.noRidCount} = ${ver.requestCount}`);

  // ⛔ 核心防退化：不许有人为了「让按钮亮起来」把未核实的 ID 标成已核实
  const fns = sf.functions || [];
  ok('special-functions.json 的 67 条全部 routineIdVerified=false（不许假装已核实）',
     fns.length > 0 && fns.every((f) => f.routineIdVerified === false),
     `${fns.filter((f) => f.routineIdVerified !== false).length} 条被标成 true`);

  // 手工索引与实测 RID 的重叠必须极小 —— 若哪天变大，说明有人拿实测库回填了假表（同样不可信）
  const sfr = new Set(fns.map((f) => String(f.routineId).toLowerCase()));
  const overlap = ver.items.filter((r) => sfr.has(String(r.routineId).toLowerCase()));
  ok('手工索引与实测 RID 重叠 ≤ 1（证明两者确实不是一套）', overlap.length <= 1,
     `重叠 ${overlap.length} 个: ${overlap.map((r) => r.routineId).join(',')}`);

  // UI 不许再出现「已禁用」的死按钮 —— 用户装到手机上会以为功能坏了
  const appSrc = readFileSync('./src/app.js', 'utf8');
  ok('app.js 不再生成 disabled 的「执行（已禁用）」按钮',
     !appSrc.includes('执行（已禁用）'));
  ok('特殊功能页不再暴露原始 RID 池与手动输入（只留确认可执行的项）',
     !appSrc.includes('routines-verified.json') && !appSrc.includes('class="mRun"'));
  ok('参数详情有「读当前值」且 doRead 会回写 currentValue',
     appSrc.includes('id="pRead"') && appSrc.includes("$('pRead').onclick = () => doRead(p)")
     && appSrc.includes('p.currentValue = v;'));
  ok('编程页 handler 在 innerHTML 之后绑定（xProgRead 不会 null）',
     appSrc.indexOf("$('xProgRead').onclick") > appSrc.indexOf("$('paramBox').innerHTML"));
  ok('真机路径复用 Elm327.prepareLink（含 ATAL/流控）',
     readFileSync('./src/link-doctor.js', 'utf8').includes('prepareLink')
     && readFileSync('./src/elm327.js', 'utf8').includes('async prepareLink'));

  // 例程执行必须走 runRoutine（自动 31 03 轮询），不能发一次就判成败
  const spBlock = appSrc.slice(appSrc.indexOf('const execRoutine'), appSrc.indexOf('const RISK_TIP'));
  ok('例程执行统一走 coder.runRoutine（NRC 78 会转 31 03 轮询）',
     spBlock.includes('coder.runRoutine'));
  ok('例程执行前会做二次确认（危险操作）', spBlock.includes('confirm('));

  // ── 真实特殊功能目录（2026-10-20）：从诊断插件解析出来的 674 项 ──
  const real = readJson('./data/special-functions-real.json');
  ok('真实特殊功能目录存在且有内容', real.count > 500 && Object.keys(real.platforms || {}).length >= 10,
     `${real.count} 项 / ${Object.keys(real.platforms || {}).length} 平台`);
  ok('9X1（981/718）有模块目录', Object.keys(real.platforms?.['9X1'] || {}).length >= 15,
     `${Object.keys(real.platforms?.['9X1'] || {}).length} 模块`);
  ok('目录项带中文 label 与 action',
     Object.values(real.platforms || {}).some((mods) =>
       Object.values(mods).some((arr) => arr.every((f) => f.label && f.action))));
  ok('moduleAliases 存在（否则菜单树模块名匹配不上）',
     real.moduleAliases && Object.keys(real.moduleAliases).length > 10,
     `${Object.keys(real.moduleAliases || {}).length} 条`);
  const withRid = Object.values(real.platforms || {}).flatMap((mods) => Object.values(mods))
    .flat().filter((f) => (f.rids || []).length);
  ok('目录里有带真实 RID 的功能', withRid.length >= 15, `${withRid.length} 项带 RID`);
  ok('app.js 已改接特殊功能映射表 special-function-map.json',
     appSrc.includes('special-function-map.json'));
  ok('app.js 不再引用旧的 67 条手工索引（specialFunctionsFor）',
     !appSrc.includes('specialFunctionsFor('));
  ok('app.js 不再加载 674 项目录（只保留确认可执行的项）',
     !appSrc.includes('special-functions-real.json'));
  // 命令模板表：139 条 0x31 模板，是 RID 的来源
  const tmpl = readJson('./data/routine-templates.json');
  ok('命令模板表存在且含 0x31 例程', tmpl.items.length >= 100 && tmpl.uniqueRid >= 70,
     `${tmpl.items.length} 条模板 / ${tmpl.uniqueRid} RID`);

  // ── 完整命令序列（2026-10-20）──
  const seq = readJson('./data/function-sequences.json');
  ok('命令序列表存在', Array.isArray(seq.functions) && seq.functions.length > 300,
     `${seq.functions.length} 个函数`);
  const zm = (seq.zhMatches || []).filter((m) => m.candidates && m.candidates.length);
  ok('中文功能能对上函数序列（≥30 条）', zm.length >= 30, `${zm.length} 条`);
  ok('9X1（981）的功能优先匹配 P9x1_* 函数',
     zm.some((m) => m.candidates[0].name.startsWith('P9x1_')));
  // 序列里的 31 子功能必须合法（否则是数据被误判成命令）
  const OK_SUB = new Set([0x01, 0x02, 0x03, 0x04, 0x06, 0x0B, 0x0C, 0x0D, 0x10,
    0xB8, 0xB9, 0xBA, 0xBB]);
  const bad31 = [];
  for (const f of seq.functions) {
    for (const c of f.cmds || []) {
      const h = c.replace(/\s/g, '');
      if (h.startsWith('31') && !OK_SUB.has(parseInt(h.slice(2, 4), 16))) bad31.push(`${f.name}:${c}`);
    }
  }
  ok('序列里所有 31 子功能都合法', bad31.length === 0,
     bad31.slice(0, 3).join(' '));
  ok('app.js 有序列执行器（seqRun + runSequence）',
     appSrc.includes('class="seqRun"') && appSrc.includes('const runSequence'));
  ok('序列执行前会二次确认且提示写入条数',
     /runSequence[\s\S]{0,900}写入类/.test(appSrc));

  // ── 67 条菜单项 → 各平台实现（2026-10-20）──
  // 这张表决定「诊断仪有的功能，本 App 能不能做」。它是人工核对的，不是关键词猜的，
  // 所以要断言它没被改坏：条数、覆盖率、平台标注、以及几个已知的易错点。
  const map = readJson('./data/special-function-map.json');
  ok('菜单项映射表覆盖全部 67 条', map.count === 67 && map.maps.length === 67, `${map.count} 条`);
  const mappedOk = map.maps.filter((m) => m.status === 'ok');
  ok('大部分菜单项有可执行实现（≥60）', mappedOk.length >= 60, `${mappedOk.length}/67`);
  ok('每条有实现的项都带平台与命令数',
     mappedOk.every((m) => m.impls.length && m.impls.every((x) => x.platforms.length && x.cmdCount > 0)));
  // 981 只能做 9X1 上真正实现过、且映射已确认的那些（67 条是跨平台并集：
  // 里面包含 Panamera/992 的 TME、天窗、软顶等，981 本来就没有对应 ECU）
  const visible = map.maps.filter((m) => m.status === 'ok' && m.verified !== false);
  const p9n = visible.filter((m) => m.impls
    .some((x) => x.platforms.includes('9X1') || x.platforms.includes('ALL'))).length;
  ok('9X1 平台可执行项 ≥28（981/718 的实际覆盖面）', p9n >= 28, `${p9n}/67`);
  const g2n = visible.filter((m) => m.impls
    .some((x) => x.platforms.includes('G2') || x.platforms.includes('ALL'))).length;
  ok('G2（92A Cayenne）平台可执行项 ≥38', g2n >= 38, `${g2n}/67`);
  // 语义对不上的映射不能进 app（否则按钮会做错事）
  const unverified = map.maps.filter((m) => m.verified === false);
  ok('未确认的映射都带原因，且 app 会过滤掉',
     unverified.length >= 4 && unverified.every((m) => m.unverifiedReason)
     && appSrc.includes('it.verified === false'),
     `${unverified.length} 条`);
  ok('systemAliases 存在（中文系统名 ↔ 菜单树模块名）',
     Object.keys(map.systemAliases || {}).length >= 20, `${Object.keys(map.systemAliases || {}).length} 条`);
  const seqNames = new Set(seq.functions.map((f) => f.name));
  // 只校验「有命令」的实现；cmdCount=0 的是「有符号但序列在运行时拼」（HUD），不在序列表里属正常
  const missingImpl = map.maps.flatMap((m) => m.impls)
    .filter((x) => x.cmdCount > 0 && !seqNames.has(x.name));
  ok('映射里的实现函数都能在序列表里找到', missingImpl.length === 0,
     missingImpl.slice(0, 3).map((x) => x.name).join(' '));
  const oilItem = map.maps.find((m) => m.menuId === '0x0301');
  ok('机油加注优先 Tiptronic 实现（不是 DME）',
     /TIP_Oil_Filling/.test(oilItem.impls[0].name), oilItem.impls[0].name);
  const keyItem = map.maps.find((m) => m.menuId === '0x0327');
  ok('钥匙匹配不会命中钥匙保持电磁阀',
     !keyItem.impls.some((x) => /Key_Retaining/.test(x.name)));
  ok('app.js 用映射表做平台闸门（跨平台只给查看、不给执行）',
     appSrc.includes('special-function-map.json') && appSrc.includes('const implFor'),
     'implFor 决定当前平台是否有实现');

  // —— 真发一帧：实测 RID 经 coder 必须拼出合法 31 帧，且 NRC 0x78 会转 31 03 轮询 ——
  const mkC = (handler) => {
    const c = new Coder(new Elm327(new FakePort(), { timeoutMs: 1 }),
      { tx: 0x6C0, rx: 0x6C8, verbose: false });
    c.uds = handler;
    return c;
  };
  const top = ver.items.slice().sort((a, b) => b.hits - a.hits)[0];
  const ridInt = parseInt(String(top.routineId).replace(/^0x/i, ''), 16);
  const subInt = parseInt(String(top.subFuncs[0].sub).replace(/^0x/i, ''), 16);
  const hex4 = ridInt.toString(16).toUpperCase().padStart(4, '0');
  const subHx = subInt.toString(16).toUpperCase().padStart(2, '0');
  const seen = [];
  const c2 = mkC(async (hex) => {
    seen.push(hex);
    if (hex.startsWith(`31${subHx}${hex4}`)) throw new CodingError('响应挂起', 0x78);
    if (hex.startsWith('3103')) return { kind: 'ok', body: [0x71, 0x03, 0x00] };
    return { kind: 'ok', body: [0x71] };
  });
  const rr = await c2.runRoutine(subInt, ridInt, '', { maxMs: 1000, intervalMs: 10 });
  ok(`最高频实测 RID ${top.routineId} 拼出合法帧 31${subHx}${hex4}，且 NRC 78 转 31 03 轮询`,
     seen.some((h) => h === `31${subHx}${hex4}`) && seen.some((h) => h.startsWith('3103')) && rr.polled >= 1,
     `seen=${seen.join(',')}`);

  // 子功能不只有 1/2/3（GAG 实测有 0xB8/0xB9/0xBA/0xBB/0x10…），必须支持任意子功能
  const allSubs = new Set();
  for (const r of ver.items) for (const s of r.subFuncs) allSubs.add(parseInt(s.sub, 16));
  ok('实测子功能含厂商扩展（不只 1/2/3）', [...allSubs].some((s) => s > 0x03),
     `子功能: ${[...allSubs].sort((a, b) => a - b).map((s) => '0x' + s.toString(16)).join(' ')}`);
  ok('routineControl 支持任意子功能（不写死）',
     readFileSync('./src/coder.js', 'utf8').includes('async function routineControl(subFunc'));
}

// ── [16] 新增修复的防退化（2026-10-18 第三轮）────────────────────────────
console.log('\n[16] 0x79/0x7a/0x7b / DTC / CAN 地址 / LinkDoctor 真机配方');
{
  // ① 三个新收编 mode 的 32 点 真值对拍
  const vec = JSON.parse(readFileSync('./tools/vectors/mode-samples.json', 'utf8'));
  for (const [hex, mode] of [['0x79', 0x79], ['0x7a', 0x7a], ['0x7b', 0x7b]]) {
    const rows = vec[hex] || [];
    let good = 0;
    for (const r of rows) {
      try {
        if ((pswCalc(mode, parseInt(r.seed, 16)).key >>> 0) === parseInt(r.key, 16)) good++;
      } catch { /* count as bad */ }
    }
    ok(`${hex} 32 点 真值对拍（新收编）`, rows.length === 32 && good === 32, `${good}/${rows.length}`);
  }
  ok('0x79/0x7a/0x7b 不再 PENDING',
     (await import('./src/seedkey-pswcalc.js')).PENDING_MODES[0x79] === undefined
     && (await import('./src/seedkey-pswcalc.js')).PENDING_MODES[0x7a] === undefined
     && (await import('./src/seedkey-pswcalc.js')).PENDING_MODES[0x7b] === undefined);

  // ② DTC 两种协议头不能混
  {
    const uds = parseDtcPayload([0x59, 0x02, 0x08, 0x01, 0x23, 0x45]);
    ok('DTC UDS 59 头 → P0123', uds.protocol === 'uds' && uds.dtcs.length === 1
       && uds.dtcs[0].code === 'P0123' && uds.dtcs[0].status === 0x45, JSON.stringify(uds.dtcs));
    const kwp = parseDtcPayload([0x58, 0x01, 0x01, 0x23, 0x45]);
    ok('DTC KWP 58 头 → P0123（不再按 UDS 错位）', kwp.protocol === 'kwp' && kwp.dtcs.length === 1
       && kwp.dtcs[0].code === 'P0123' && kwp.dtcs[0].status === 0x45, JSON.stringify(kwp.dtcs));
    const unk = parseDtcPayload([0x62, 0x01]);
    ok('未知 DTC 头 → unknown，不猜', unk.protocol === 'unknown' && unk.dtcs.length === 0);
  }

  // ③ 手工地址解析 / 覆盖
  {
    const a = parseAddrPair('7E0/7E8');
    ok('parseAddrPair 7E0/7E8', a && a.tx === 0x7e0 && a.rx === 0x7e8, JSON.stringify(a));
    const b = parseAddrPair('0x7E0 0x7E8');
    ok('parseAddrPair 0x7E0 0x7E8', b && b.tx === 0x7e0 && b.rx === 0x7e8);
    ok('非法地址一律 null（不猜）',
       parseAddrPair('') === null && parseAddrPair('7E0') === null
       && parseAddrPair('7E0/7E0') === null && parseAddrPair('ZZZ/7E8') === null);
    const o = overrideFor('DME', { DME: { tx: 0x7e0, rx: 0x7e8 } });
    ok('overrideFor 返回 manual 地址', o && o.tx === 0x7e0 && o.rx === 0x7e8 && o.state === 'manual');
    ok('overrideFor 非法条目不采用', overrideFor('DME', { DME: { tx: 0x7e0, rx: 0x7e0 } }) === null);
  }

  // ④ BigInt 宽字段（>53 位）不能走 Number
  {
    const wide = { byte: 0, bit: 0, bitsize: 64, min: 0, max: null };
    const big = parseFieldInput(wide, '18446744073709551615');
    ok('64 位输入解析成 BigInt（不丢精度）', typeof big === 'bigint' && big === 18446744073709551615n,
       String(big));
    ok('fieldInRange 支持 BigInt', fieldInRange(wide, big) === true);
    const buf = new Uint8Array(8);
    const injected = injectField(buf, wide, big);
    const round = extractField(injected, wide);
    ok('64 位注入/提取往返一致', round === big, `${round}`);
    ok('窄字段仍返回 Number', typeof parseFieldInput({ bitsize: 8 }, '42') === 'number');
    ok('非法输入返回 null', parseFieldInput({ bitsize: 64 }, 'zzz') === null);
  }

  // ⑥ KWP 的 key 子功能必须是 0x40（不是 0x01）—— 实测 `17 40` / `17 40 00`
  {
    const c = new Coder(new Elm327(new FakePort(), { timeoutMs: 1 }),
      { tx: 0x6C0, rx: 0x6C8, verbose: false });
    c.address = async () => {};
    const sent = [];
    c.uds = async (h) => {
      sent.push(h);
      if (h === '170000') return { kind: 'ok', body: [0x57, 0x12, 0x34] };
      if (h.startsWith('1740')) return { kind: 'ok', body: [0x57] };
      throw new Error('unexpected ' + h);
    };
    c.seedKeyProvider = { name: 't', calc: () => Uint8Array.of(0xab, 0xcd) };
    const okKwp = await c.securityAccessEx({ level: 0x09, kwp: true });
    ok('KWP 取 seed 发 17 00 00', okKwp === true && sent[0] === '170000', sent.join(','));
    ok('KWP 发 key 用 17 40（不是 17 01）', sent.some((h) => h === '1740ABCD'), sent.join(','));
    ok('KWP 没有发 17 01', !sent.some((h) => h.startsWith('1701')), sent.join(','));
  }

  // ⑦ 0xA0 —— securityModel case 0xa0 递归到变体分发器（SWSG_Single_Seedkey）
  //    2026-10-19 REA 证实并实现；不能伪装成「原厂无 case」
  {
    let r = null, err = null;
    try { r = resolveKey(0xa0, 0x12345678, {}); } catch (e) { err = e; }
    ok('0xA0 已解析（VARIANT/SWSG_Single_Seedkey）', !!r && /SWSG_Single_Seedkey/.test(r.algo),
       err ? 'ERR ' + err.message.slice(0, 50) : r?.algo);
    ok('0xA0 needsKey=true（不是 NO_ALGO）', r?.needsKey === true);
  }
  // ⑦b mode 0x00 —— securityModel 无 case 0 → ASAM_SeedKey 无 case → 不发 key
  {
    const r = resolveKey(0x00, 0x12345678, {});
    ok('mode 0x00 归 NO_ALGO（参考诊断仪无 case 0，不发 key）', r.needsKey === false && r.outlen === 0);
  }

  // ⑧ 故障码请求形态对齐 参考诊断仪 GAG（不是 REA 的 190208）
  {
    const c = new Coder(new Elm327(new FakePort(), { timeoutMs: 1 }),
      { tx: 0x6C0, rx: 0x6C8, verbose: false });
    c.address = async () => {};
    const sent = [];
    c.uds = async (h) => {
      sent.push(h);
      if (h.startsWith('1902')) return { kind: 'ok', body: [0x59, 0x02, 0x89, 0x01, 0x23, 0x45] };
      if (h.startsWith('14')) return { kind: 'ok', body: [0x54] };
      throw new Error('unexpected ' + h);
    };
    await c.readDtc(0x02);
    ok('参考诊断仪 GAG 读码用 19 02 89', sent[0] === '190289', sent.join(','));
    await c.clearDtc();
    ok('参考诊断仪 GAG 清码默认 14 FF 00（不是 14 FF FF）', sent.includes('14FF00'), sent.join(','));
  }

  // ⑤ LinkDoctor 真机路径必须与 init 同一套 CAN 配方（ATAL / 流控 / ATSTFF / ATAT0）
  {
    const d = new LinkDoctor();
    const sent = [];
    const fakeCmd = async (c) => { sent.push(String(c).replace(/\r/g, '')); return c === '1A9F' ? '7E8 05 5A 9F 00 00' : 'OK'; };
    d.elm = {
      cmd: fakeCmd,
      // LinkDoctor 现在走 Elm327.prepareLink() 这一套公共配方；fake 里按同样命令序列实现。
      prepareLink: async function () {
        for (const a of ['ATE0', 'ATL0', 'ATS0', 'ATAL', 'ATH1', 'ATCAF0', 'ATSTFF', 'ATAT0',
          'ATCFC1', 'ATFCSD 30 00 00 00 00 00 00 00', 'ATFCSM0']) await this.cmd(a);
      },
    };
    await d.lockProtocol();
    const has = (x) => sent.some((s) => s.toUpperCase() === x.toUpperCase());
    ok('LinkDoctor 发 ATAL（长消息）', has('ATAL'));
    ok('LinkDoctor 发 ATSTFF（长超时）', has('ATSTFF'));
    ok('LinkDoctor 发 ATAT0（固定定时）', has('ATAT0'));
    ok('LinkDoctor 发流控三件套', has('ATCFC1') && has('ATFCSD 30 00 00 00 00 00 00 00') && has('ATFCSM0'));
    ok('LinkDoctor 探测后恢复 ATSP6/ATH1/ATS0',
       has('ATSP6') && has('ATH1') && has('ATS0'));
  }
}

// ===== 17. 自动选变体（参考诊断仪不弹窗） =====
console.log('\n[17] 自动选变体');
{
  const acc3 = {
    module: 'ACC3', variant: 'ACC3_BaseSys', default: 'ACC3_BaseSys.json',
    variants: [
      { name: 'ACC3_BaseSys', file: 'ACC3_BaseSys.json' },
      { name: 'ACC3_A2', file: 'ACC3_A2.json' },
      { name: 'ACC3_A4', file: 'ACC3_A4.json' },
    ],
  };
  ok('无识别文本 → 参考诊断仪默认变体',
    autoPickVariant(acc3, '').name === 'ACC3_BaseSys');
  ok('识别文本含完整变体名 → 精确命中',
    autoPickVariant(acc3, 'ACC3_A4').name === 'ACC3_A4');
  ok('识别文本只有模块名 → BaseSys',
    autoPickVariant(acc3, 'ACC3').name === 'ACC3_BaseSys');
  const kombi = {
    module: 'Kombiinstrument', variant: 'Kombiinstrument_BaseSys', default: 'Kombiinstrument_BaseSys.json',
    variants: [
      { name: 'Kombiinstrument_BaseSys', file: 'Kombiinstrument_BaseSys.json' },
      { name: 'Kombiinstrument_A2_10', file: 'Kombiinstrument_A2_10.json' },
    ],
  };
  ok('组合仪表识别串 → BaseSys（不选 A2_10）',
    autoPickVariant(kombi, 'Kombiinstrument').name === 'Kombiinstrument_BaseSys');
  ok('未知识别串 → 默认变体，不抛错',
    autoPickVariant(acc3, 'WP0ZZZ99ZGS123456').name === 'ACC3_BaseSys');
}

// ===== 18. 特殊功能目录过滤（参考诊断仪只显示当前系统） =====
console.log('\n[18] 特殊功能目录过滤');
{
  const fns = JSON.parse(readFileSync(new URL('./data/special-functions.json', import.meta.url), 'utf8')).functions;
  ok('SRS(安全气囊) → 2 项中文功能',
    specialFunctionsFor('SRS(安全气囊)', fns).map((f) => f.sub).join('|') === '安全气囊复位|RGS 复位');
  ok('TCM/PDK 别名 → Tiptronic 的 2 项',
    specialFunctionsFor('TCM/PDK(自动变速箱控制模块)', fns).length === 2);
  ok('IC(仪表) 别名 → 组合仪表 3 项',
    specialFunctionsFor('IC(仪表)', fns).length === 3);
  ok('空调 8 项，且全是中文子功能',
    specialFunctionsFor('AC(空调系统)', fns).length === 8 &&
    specialFunctionsFor('AC(空调系统)', fns).every((f) => /[\u4e00-\u9fff]/.test(f.sub)));
  ok('未知模块 → 0 项（不跨类别带出无关功能）',
    specialFunctionsFor('不存在的模块XYZ', fns).length === 0);
  // 981 基准：14 系统 / 27 子功能（0x0200–0x0314）
  ok('981 PCM 3 项（不混入新平台）',
    specialFunctionsFor('PCM/CDR（通信管理/CD、收音机）', fns, '9X1').length === 3);
  ok('981 PASM 4 项（水平高度别名）',
    specialFunctionsFor('水平高度控制/PASM', fns, '9X1').length === 4);
  ok('981 驻车制动器 5 项',
    specialFunctionsFor('驻车制动器', fns, '9X1').length === 5);
  ok('981 网关 1 项（0x0327 新平台项被过滤）',
    specialFunctionsFor('网关', fns, '9X1').length === 1);
  ok('981 Tiptronic 1 项（0x0333 新平台项被过滤）',
    specialFunctionsFor('Tiptronic 变速器控制', fns, '9X1').length === 1);
  ok('981 SRS/空调为 0（这两系统不在 981 特殊功能清单）',
    specialFunctionsFor('SRS(安全气囊)', fns, '9X1').length === 0 &&
    specialFunctionsFor('AC(空调系统)', fns, '9X1').length === 0);
  ok('981 后端电子设备 5 项（尾翼/后盖/后刮水器，0x0340–0x0344）',
    specialFunctionsFor('后端电子设备', fns, '9X1').length === 5 &&
    specialFunctionsFor('后端电子设备', fns, '9X1').some((f) => f.sub.includes('扰流器标准化')));
  ok('992 空调仍显示 8 项（新平台段 0x0320+）',
    specialFunctionsFor('AC(空调系统)', fns, '992').length === 8);
  // 981 硬基准：14 系统 / 27 子功能（按 981 菜单树的系统名逐项求和）
  {
    const tree = JSON.parse(readFileSync(new URL('./data/menu-tree-v3.json', import.meta.url), 'utf8'));
    const g = (tree.groups || []).find((x) => x.models?.some((m) => m.label === 'Boxster（981）'));
    const m = g?.models?.find((x) => x.label === 'Boxster（981）');
    const labels = new Set();
    for (const fn of m?.functions || []) for (const sy of fn.systems || []) labels.add(sy.label);
    let systems = 0, total = 0;
    for (const l of labels) {
      const a = specialFunctionsFor(l, fns, '9X1');
      if (a.length) { systems++; total += a.length; }
    }
    ok('981 特殊功能清单 = 18 系统 / 36 项（含后端尾翼 5 项）',
      systems === 18 && total === 36, `${systems} 系统/${total} 项`);
  // 新平台菜单里的泛称“辅助系统/车道变换辅助系统”不能整块为空
  ok('992 泛称辅助系统 → 左/右车道 2 项',
    specialFunctionsFor('辅助系统', fns, '992').length === 2);
  // Funcfg.so [SPECFUNC_CFG] 官方系统开关
  {
    const sf = JSON.parse(readFileSync(new URL('./data/special-systems.json', import.meta.url), 'utf8'));
    ok('Funcfg SF 标志 = 21 项（系统映射未确认）',
      sf.sf.length === 21 && sf.sf.includes(0x13) && sf.sf.includes(0x09) && sf.sf.includes(0x34),
      `${sf.sf.length} 项/未知 ${sf.unknown.length}`);
  }
  ok('Cayenne-92A 泛称车道变换 → 左/右 2 项',
    specialFunctionsFor('车道变换辅助系统', fns, 'G2').length === 2);
  ok('Macan 转向盘电子设备不再为空（通用 0x030D/0x030E）',
    specialFunctionsFor('转向盘电子设备', fns, 'CAJUN').length === 2);
  }
}

// ===== 19. 特殊功能显示守卫（2026-10-19 审计：防 hex 泄漏 + 英文内部名复发） =====
console.log('\n[19] 特殊功能显示守卫');
{
  const app = readFileSync('./src/app.js', 'utf8');
  // ① special-functions-ext.json（548 条英文内部名）绝不能被接入 UI
  const extRefs = (app.match(/special-functions-ext/g) || []).length;
  ok('special-functions-ext.json 未被 src/app.js 引用（防英文内部名复发）', extRefs === 0);
  const bundle = readFileSync('./www/app.bundle.js', 'utf8');
  ok('special-functions-ext.json 未进 bundle', (bundle.match(/special-functions-ext/g) || []).length === 0);
  // ② 特殊功能只有「执行 / 查看步骤」两个入口，不再按单条 RID 直接发
  ok('特殊功能项带执行与查看步骤入口（都带 label）',
     /class="seqRun"[^>]*data-label=/.test(app) && /class="seqView"[^>]*data-label=/.test(app));
  ok('不再按单条 RID 直接执行（无 spRun/spStop/spResult）',
     !/class="spRun"/.test(app) && !/class="spStop"/.test(app) && !/class="spResult"/.test(app));
  // ③ 成功 toast 不打原始响应字节
  ok('例程成功 toast 不直接打 body hex',
    !/toast\('ok', `\$\{verb\}成功`, body \+/.test(app));
  // ④ ecu-addresses.json 已打进 bundle（RE 寻址链路真机可用）
  ok('ecu-addresses.json 已进 bundle（RE 寻址可用）', bundle.includes('data/ecu-addresses.json'));
  // ⑤ addrFor 链含 RE 表
  ok('addrFor 走 ecuAddrFromTable', app.includes('ecuAddrFromTable'));
  // ⑥ RE 表在 loadAll 预取（不在 enterSystem 懒加载导致首点失败）
  ok('ecu-addresses.json 在 loadAll 预取', /loadAll[\s\S]*ecu-addresses\.json/.test(app));
}

console.log('\n===== result: ' + pass + ' passed / ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
