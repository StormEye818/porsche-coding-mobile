#!/usr/bin/env node
/**
 * 2026-10-15 全量修复冒烟测试 —— 只验本次改动的代码路径。
 * 跑法: node smoke-fixes.mjs
 */
import { readFileSync } from 'node:fs';
import { Elm327 } from './src/elm327.js';
import { Coder, parseResp } from './src/coder.js';

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
  const ap = c.address().catch(() => {});
  for (let i = 0; i < 3; i++) setTimeout(() => p.emit('OK\r>'), 10 + i * 15);
  await ap;
  const sent = p.sent.map((s) => s.replace(/\r/g, ''));
  ok('ATSH uses module address', sent.includes('ATSH7E0'));
  ok('ATCRA uses module address', sent.includes('ATCRA7E8'));
  ok('ATFCSH follows module address', sent.includes('ATFCSH7E0'));
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
  ok('IC no longer uses 0x7E8 (DME response id)', tbl['IC(仪表)'].tx === null);
  ok('IC marked unknown', tbl['IC(仪表)'].state === 'unknown');
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
}

console.log('\n===== result: ' + pass + ' passed / ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
