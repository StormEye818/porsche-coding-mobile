#!/usr/bin/env node
/**
 * D-3 统一口径 id 全集断言（Node 包装）。
 *
 * 真实判定在 tools/verify-d3-id-union.py：本包装用 child_process.execFileSync 转发，
 * 并以「退出码 + stdout 内容」二次断言，绝不自行复制一份判定逻辑（禁止重复实现）。
 *
 * 断言名：D3_ID_UNION / D3_ID_UNION_WRAPPER
 * 输出确定性：无时间戳、无绝对路径、无随机顺序；末尾输出规范化 stdout 的 sha256。
 * 退出码：全绿 0，任一断言失败 1。
 * 复跑：node tools/verify-d3-id-union.mjs ; python3 tools/verify-d3-id-union.py --verbose
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = join(ROOT, 'tools', 'verify-d3-id-union.py');

const lines = [];
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (cond) pass += 1; else fail += 1;
};

let stdout = '';
let exitCode = 0;
try {
  stdout = execFileSync('python3', [PY], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  exitCode = typeof e.status === 'number' ? e.status : 1;
  stdout = String(e.stdout || '');
  lines.push(`FAIL D3_ID_UNION python 脚本退出码=${exitCode}`);
  fail += 1;
}

// python 端的 sha256 只覆盖 8 行判定文本；第 9 行是哈希本身，必须排除后再重算。
const body = stdout.split('\n').filter((l) => l.startsWith('D3_ID_UNION ')
  && !l.startsWith('D3_ID_UNION sha256='));
const value = (key) => {
  const row = body.find((l) => l.startsWith(`D3_ID_UNION ${key}=`));
  return row ? row.slice(`D3_ID_UNION ${key}=`.length) : null;
};
const distinct = Number.parseInt(value('distinct_itemids') || '', 10);
const unionIds = Number.parseInt(value('union_ids') || '', 10);
const exactHit = Number.parseInt(value('exact_hit') || '', 10);
const miss = Number.parseInt(value('miss') || '', 10);
const resolvable = value('miss_resolvable_by_chain') || '';
const yy = value('entity_resolvable_Y/Y') || '';
const verdict = value('verdict');
// 哈希行本身不参与哈希计算，单独从 stdout 取出来做比对。
const shaRow = stdout.split('\n').find((l) => l.startsWith('D3_ID_UNION sha256='));
const sha = shaRow ? shaRow.slice('D3_ID_UNION sha256='.length) : null;

ok('D3_ID_UNION python 判定脚本退出码 0', exitCode === 0, `exit=${exitCode}`);
ok('D3_ID_UNION verdict=A', verdict === 'A', `verdict=${verdict}`);
ok('D3_ID_UNION distinct_itemids 动态计算（非硬编码 119657）',
  Number.isInteger(distinct) && distinct > 119657, `distinct_itemids=${distinct} > 归一前中间量 119657`);
ok('D3_ID_UNION union_ids 与 exact_hit 同源且 exact_hit<=distinct',
  Number.isInteger(unionIds) && Number.isInteger(exactHit) && unionIds >= distinct && exactHit <= distinct,
  `union_ids=${unionIds} exact_hit=${exactHit}`);
ok('D3_ID_UNION miss 全部可由 chain 前 3 段解析',
  resolvable === `${miss}/${miss}` && Number.isInteger(miss), `miss_resolvable_by_chain=${resolvable}`);
ok('D3_ID_UNION entity_resolvable_Y/Y 动态等于 distinct_itemids',
  yy === `${distinct}/${distinct}`, `Y/Y=${yy}`);
ok('D3_ID_UNION sha256 为 8 行规范化输出的真实哈希',
  typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)
    && sha === createHash('sha256').update(body.join('\n')).digest('hex'),
  `sha256=${sha}`);

const text = lines.join('\n');
console.log(text);
console.log(`D3_ID_UNION_WRAPPER: ${pass} PASS / ${fail} FAIL`);
console.log(`复跑命令：python3 tools/verify-d3-id-union.py --verbose ; node tools/verify-d3-id-union.mjs`);
console.log(`sha256=${createHash('sha256').update(text).digest('hex')}`);
process.exit(fail === 0 ? 0 : 1);
