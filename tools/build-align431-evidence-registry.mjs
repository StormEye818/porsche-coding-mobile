#!/usr/bin/env node
/**
 * T01 · build-align431-evidence-registry.mjs
 *
 * Regenerates data/align431-evidence-registry.json from the three checked-in
 * 431 evidence ledgers. The builder is deliberately deterministic:
 *   - no Date / Math.random / process.cwd / machine-specific output path
 *   - every array is sorted with a locale-independent comparator
 *   - raw-package paths are emitted as the ${E0_ROOT} token, never absolute
 *
 * Evidence IDs, coordinates, practices, counterexamples and reproduction
 * commands are parsed from the ledger text instead of being hand-copied.
 */
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCH_FILE = 'docs/ARCH-全链路真实对齐-20261120.md';
const ROWS_FILE = 'tools/align431-rows.json';
const OUT_FILE = 'data/align431-evidence-registry.json';
const SCHEMA_VERSION = '1.0.0';

/** @type {{file: string, kind: string, pattern: RegExp}[]} */
const LEDGERS = Object.freeze([
  {
    file: 'docs/evidence/431-static-allmodels-20261120.md',
    kind: 'static',
    pattern: /^###\s+(E\d{2})\s*[—–-]\s*(.*)$/,
  },
  {
    file: 'docs/evidence/431-linkmap-20261120.md',
    kind: 'static',
    pattern: /^###\s+(E-\d{2})\s+(.*)$/,
  },
  {
    file: 'docs/evidence/431-postentry-20261120.md',
    kind: 'dynamic',
    pattern: /^###\s+(PE-\d{2})\s*[｜|]\s*(.*)$/,
  },
]);

/** Decoded raw-package file names (as written in the ledgers). */
const DECODED_FILES = new Set([
  'DSN.BIN',
  'PORSCHE_SYS_DATA.BIN',
  'PORSCHE_DRIVELINKS.BIN',
  'JOB.BIN',
  'MENU.BIN',
  'GAG_COMMAND.GAG.bin',
  'GAG_TEXT_CN.GAG.bin',
  'PORSCHE_SERVICE.GAG.bin',
]);

const VERB_START = /^(执行|复算|采用|按|依据|读取|解析|构造|校验|禁止|使用|发送|建立|拦截|记录|转换|分发|续等|保留|选择|遍历|定位|跳过|不)/;
const SHELL_TOKEN = /\b(?:python3|node|grep|xxd|llvm-nm|disasm-elf\.py|sed)\b/;

/**
 * Read a UTF-8 file relative to the repository root.
 * @param {string} rel repo-relative path
 * @returns {string}
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * Locale-independent string comparator (Array.sort() must be byte-stable).
 * @param {string} a left operand
 * @param {string} b right operand
 * @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Replace machine-specific absolute paths with stable tokens.
 * Nothing absolute ever reaches the registry file.
 * @param {string} text input text
 * @returns {string}
 */
function normalizePaths(text) {
  return String(text)
    .replace(/\/Users\/[^/\s'"`)]+\/porsche-mapper\/ref/g, '${E0_ROOT}')
    .replace(/\/Users\/[^/\s'"`)]+\/porsche-coder/g, '.')
    .replace(/\/Users\/[^/\s'"`)]+\/\.workbuddy\/binaries\/python\/envs\/default\/bin\/python3/g, 'python3')
    .replace(/\/Applications\/Xcode\.app\/[^\s'"`)]*llvm-nm/g, 'llvm-nm')
    .replace(/\/Users\/[^\s'"`)]+/g, '${E0_HOME}')
    .replace(/\$\{E0_ROOT\}\/porsche-coder/g, '.');
}

/**
 * Split a ledger into heading-delimited sections.
 * @param {string} text ledger text
 * @param {RegExp} pattern heading matcher capturing id and title
 * @returns {{id: string, title: string, line: number, body: string}[]}
 */
function splitSections(text, pattern) {
  const lines = text.split('\n');
  /** @type {{id: string, title: string, line: number, body: string}[]} */
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    found.push({ id: match[1], title: match[2] || '', line: i + 1, body: '' });
  }
  return found.map((section, index) => {
    const end = index + 1 < found.length ? found[index + 1].line - 1 : lines.length;
    return { ...section, body: lines.slice(section.line, end).join('\n') };
  });
}

/**
 * Map a raw file name found in a ledger to a token path used by reproduceCmd.
 * @param {string} name file name or repo-relative path
 * @returns {string}
 */
function mapFilePath(name) {
  const clean = normalizePaths(name.trim().replace(/^`|`$/g, ''));
  if (clean.startsWith('data/') || clean.startsWith('src/') || clean.startsWith('tools/') || clean.startsWith('ref/')) {
    return clean;
  }
  if (clean === 'MENU.BIN') return 'porche-v24.58/V24.58/MENU.BIN';
  if (DECODED_FILES.has(clean)) return `decoded/${clean}`;
  if (/^lib[\w.]+\.so$/.test(clean)) return `porche-v24.58/V24.58/${clean}`;
  if (/^GAG_[\w.]+\.bin$/.test(clean)) return `decoded/${clean}`;
  if (/^[\w-]+\.(?:json|md|txt)$/.test(clean)) return `analysis/${clean}`;
  return clean;
}

/**
 * Resolve a token path to the local file for read-only validation.
 * @param {string} token repo-relative path or ${E0_ROOT} token path
 * @returns {string|null}
 */
function localPath(token) {
  if (token.startsWith('${E0_ROOT}/')) {
    return join(ROOT, '..', 'porsche-mapper', 'ref', token.slice('${E0_ROOT}/'.length));
  }
  if (/^(?:decoded|analysis|porche-v24\.58)\//.test(token)) {
    return join(ROOT, '..', 'porsche-mapper', 'ref', token);
  }
  if (/^(?:data|src|tools|ref|docs)\//.test(token)) {
    return join(ROOT, token);
  }
  return null;
}

/**
 * Number of bytes in a token path (0 when unavailable).
 * @param {string} token token path
 * @returns {number}
 */
function fileSize(token) {
  const path = localPath(token);
  if (!path) return 0;
  try {
    return readFileSync(path).length;
  } catch {
    return 0;
  }
}

/**
 * Parse the pre-audited "主坐标" summary table of the post-entry ledger.
 * @param {string} text post-entry ledger text
 * @returns {Map<string, string>}
 */
function summaryCoordIndex(text) {
  /** @type {Map<string, string>} */
  const index = new Map();
  for (const line of text.split('\n')) {
    const match = /^\|\s*(PE-\d{2})\s*\|/.exec(line);
    if (!match) continue;
    const cells = line.split('|').map((x) => x.trim());
    if (cells.length >= 5) index.set(match[1], cells[4]);
  }
  return index;
}

/**
 * Choose the file that carries the primary E0 coordinate of a ledger entry.
 * @param {string} body section body
 * @param {string} ledgerFile source ledger path
 * @returns {string}
 */
function pickFile(body, ledgerFile) {
  const lines = body.split('\n');
  /** @type {{name: string, score: number, index: number}[]} */
  const candidates = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/[A-Za-z0-9_./-]+\.(?:BIN|bin|so|json|js|py)/g)) {
      const name = match[0];
      let score = 0;
      if (/原始文件|原始路径|原始坐标|主坐标|坐标|做法/.test(line)) score += 6;
      if (/可复核命令|函数\/偏移|记录坐标/.test(line)) score += 3;
      if (/反例|禁止|不是|不得/.test(line)) score -= 4;
      if (DECODED_FILES.has(name) || /^lib[\w.]+\.so$/.test(name)) score += 2;
      candidates.push({ name, score, index });
    }
  });
  candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index) || cmp(a.name, b.name));
  for (const candidate of candidates) {
    if (candidate.score <= 0) continue;
    if (DECODED_FILES.has(candidate.name) || /^lib[\w.]+\.so$/.test(candidate.name)) {
      return mapFilePath(candidate.name);
    }
  }
  for (const candidate of candidates) {
    if (candidate.score <= 0) continue;
    const mapped = mapFilePath(candidate.name);
    if (/^(?:data|src|tools|ref|analysis)\//.test(mapped)) return mapped;
  }
  return ledgerFile;
}

/**
 * Derive an E0 coordinate from the ledger section text.
 * No numeric coordinate is hard-coded: every value comes from the ledger.
 * @param {string} body section body
 * @param {string} ledgerFile source ledger path
 * @returns {{file: string, offset?: number, VA?: string, recordId?: string, detail: string, resolved: boolean}}
 */
function pickCoord(body, ledgerFile, id, summary) {
  let file = pickFile(body, ledgerFile);
  const lines = body.split('\n');
  /** @type {{value: number, text: string, line: string, score: number, index: number}[]} */
  const candidates = [];

  const collect = (source, index, weight) => {
    const clean = normalizePaths(source);
    const hexRe = /0x([0-9a-fA-F]{2,8})\b/g;
    let match = hexRe.exec(clean);
    while (match) {
      const value = Number.parseInt(match[1], 16);
      let score = weight;
      if (/原始坐标|坐标|偏移|VA|commOff|sysDataOff|fileOffset|主坐标|函数\/偏移/.test(clean)) score += 5;
      if (clean.includes(file.split('/').pop() || '')) score += 3;
      if (/\.so$/.test(file) && value >= 0x1000) score += 2;
      if (/可复核命令|function\/偏移|记录坐标/.test(clean)) score += 2;
      if (/@\s*(?:lib[\w.]+\.so|[\w.]+)\s*:\s*0x/.test(clean)) score += 10;
      if (/\bmovw\b|\bmovt\b|#0x/.test(clean)) score -= 4;
      if (/反例|禁止|不是|不得/.test(clean)) score -= 6;
      if (value <= 5 && !/DSN\.BIN/.test(file)) score -= 3;
      candidates.push({ value, text: match[0].toLowerCase(), line: clean, score, index });
      match = hexRe.exec(clean);
    }
  };

  // The post-entry ledger carries a pre-audited "主坐标" table: use it first.
  if (summary && /0x[0-9a-fA-F]{2,8}|rec#\d+/.test(summary)) {
    const names = [...summary.matchAll(/[A-Za-z0-9_./-]+\.(?:BIN|bin|so|json)/g)].map((m) => m[0]);
    const rawName = names.find((name) => DECODED_FILES.has(name) || /^lib[\w.]+\.so$/.test(name));
    if (rawName) file = mapFilePath(rawName);
    collect(summary, -1, 12);
  }
  lines.forEach((line, index) => collect(line, index, 0));
  candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index) || cmp(a.text, b.text));

  const size = fileSize(file);
  const valid = candidates.filter((item) => (!size || item.value < size) && !(/\.so$/.test(file) && item.value < 0x1000));
  const recordMatch = /rec#(\d+)/.exec(body) || /rec#(\d+)/.exec(summary || '');
  if (recordMatch && (!valid.length || valid[0].score <= 6)) {
    const gagFile = /GAG/i.test(body) ? 'decoded/GAG_COMMAND.GAG.bin' : file;
    if (!/\.md$/.test(gagFile)) {
      return {
        file: gagFile,
        recordId: `#${recordMatch[1]}`,
        detail: `${recordMatch[0]} @ ${gagFile.split('/').pop() || gagFile}`,
        resolved: true,
      };
    }
  }

  const chosen = valid[0];
  if (!chosen || /\.md$/.test(file)) {
    return {
      file: ledgerFile,
      recordId: `UNRESOLVED-${id}`,
      detail: '账本未给出可解析且在文件范围内的 0x 坐标或记录号，禁止猜值。',
      resolved: false,
    };
  }
  const detail = chosen.line.replace(/^\s*[-*>]+\s*/, '').replace(/`/g, '').trim().slice(0, 200) || chosen.text;
  if (/\.so$/.test(file)) return { file, VA: chosen.text, detail, resolved: true };
  return { file, offset: chosen.value, detail, resolved: true };
}

/**
 * Extract a human-readable 431 practice statement from a ledger heading/body.
 * @param {string} title ledger heading title
 * @param {string} body section body
 * @returns {string}
 */
function pickPractice(title, body) {
  let text = title
    .replace(/[（(](?:S|R|D)[）)]/g, '')
    .replace(/【[^】]+】/g, '')
    .replace(/^\s*[-—–|｜]+\s*/, '')
    .trim();
  if (!text) {
    const line = body.split('\n').find((x) => /\*\*做法/.test(x)) || '';
    text = line.replace(/^\s*[-*>]+\s*/, '').replace(/\*\*做法[^*]*\*\*[：:]?\s*/, '').trim();
  }
  text = text.replace(/`/g, '').slice(0, 180);
  return VERB_START.test(text) ? text : `采用 ${text}`;
}

/**
 * Classify the evidence grade using markers actually present in the ledger.
 * @param {string} body section body
 * @param {string} id evidence id
 * @returns {'S'|'R'|'D'}
 */
function pickGrade(body, id) {
  if (id === 'U1') return 'D';
  if (/R 级|R，机制|运行时事实|provable:\s*runtime|【R】/.test(body)) return 'R';
  if (/D（我方设计）|D 级我方设计|【无包证据】/.test(body)) return 'D';
  return 'S';
}

/**
 * Return the ledger's own reproduction command, normalised and single-line.
 * @param {string} body section body
 * @returns {string}
 */
function ledgerCommand(body) {
  const lines = body.split('\n');
  let captured = '';
  for (let i = 0; i < lines.length; i += 1) {
    if (!/可复核命令|复现命令|扫描命令/.test(lines[i])) continue;
    const fenceStart = lines.findIndex((line, j) => j > i && /^```/.test(line));
    if (fenceStart >= 0) {
      const fenceEnd = lines.findIndex((line, j) => j > fenceStart && /^```/.test(line));
      captured = lines.slice(fenceStart + 1, fenceEnd < 0 ? lines.length : fenceEnd).join(' ');
      break;
    }
    captured = lines.slice(i, i + 3).join(' ');
    break;
  }
  if (!captured) {
    const inline = lines.find((line) => SHELL_TOKEN.test(line) && /`/.test(line)) || '';
    captured = [...inline.matchAll(/`([^`]+)`/g)].map((m) => m[1]).find((x) => SHELL_TOKEN.test(x)) || '';
  }
  return normalizePaths(captured.replace(/\s+/g, ' ').trim()).slice(0, 420);
}

/**
 * Build a deterministic, read-only coordinate probe command.
 * @param {{file: string, offset?: number, VA?: string, recordId?: string, resolved: boolean}} coord E0 coordinate
 * @param {string} id evidence id
 * @param {string} body section body
 * @returns {string}
 */
function reproduceCommand(coord, id, body) {
  let probe = '';
  if (!coord.resolved) {
    probe = `node -e 'console.log("E0_UNRESOLVED:${id}: fail-closed; no E0 recompute command")'`;
  } else if (coord.recordId && coord.file.startsWith('decoded/')) {
    const n = Number.parseInt(String(coord.recordId).replace(/[^0-9]/g, ''), 10);
    probe = `python3 -c 'import os,sys;p=os.path.join(os.environ["E0_ROOT"],sys.argv[1]);b=open(p,"rb").read();n=int(sys.argv[2]);assert 0<n<=len(b),"E0 recordId out of range";print(os.path.basename(p),"recordId",n,hex(len(b)))' ${coord.file} ${n}`;
  } else if (coord.file.startsWith('decoded/') || coord.file.startsWith('porche-v24.58/') || coord.file.startsWith('analysis/')) {
    const location = coord.VA || `0x${coord.offset.toString(16)}`;
    const label = coord.VA ? 'VA' : 'offset';
    probe = `python3 -c 'import os,sys;p=os.path.join(os.environ["E0_ROOT"],sys.argv[1]);v=int(sys.argv[2],16);b=open(p,"rb").read();assert 0<=v<len(b),"E0 ${label} out of range";print(os.path.basename(p),"${label}",hex(v),b[v:v+16].hex())' ${coord.file} ${location}`;
  } else {
    probe = `python3 -c 'import sys;b=open(sys.argv[1],"rb").read();assert len(b)>0;print(sys.argv[1],hex(len(b)))' ${coord.file}`;
  }
  const provenance = ledgerCommand(body);
  return provenance ? `# ledger-reproduce: ${provenance}\n${probe}` : probe;
}

/**
 * Extract counterexample identifiers/statements from the ledger entry.
 * @param {string} body section body
 * @param {string} id evidence id
 * @returns {string[]}
 */
function counterexamples(body, id) {
  const found = [];
  for (const line of body.split('\n')) {
    if (!/反例|禁止做法|实现禁令/.test(line)) continue;
    const quoted = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const text = quoted.length
      ? quoted.join(' | ')
      : line.replace(/^\s*[-*>]+\s*/, '').replace(/\*\*/g, '').trim();
    if (text) found.push(normalizePaths(text).slice(0, 240));
  }
  found.sort(cmp);
  return found.length ? found.slice(0, 4) : [`UNRECORDED:${id}`];
}

/**
 * Extract consumer implementation paths / row ids from the ledger entry.
 * @param {string} body section body
 * @param {string} ledgerFile source ledger path
 * @param {string} id evidence id
 * @returns {string[]}
 */
function consumers(body, ledgerFile, id) {
  const found = new Set();
  for (const match of body.matchAll(/`((?:src|data|tools|ref)\/[A-Za-z0-9_./-]+(?::\d+(?:-\d+)?)?)`/g)) {
    found.add(match[1]);
  }
  for (const match of body.matchAll(/\b((?:src|data|tools)\/[A-Za-z0-9_./-]+:\d+(?:-\d+)?)\b/g)) {
    found.add(match[1]);
  }
  found.add(`${ledgerFile}#${id}`);
  return [...found].sort(cmp);
}

/**
 * Parse the architecture §4.1 step→gate table into an evidenceId→gate index.
 * @param {string} arch architecture document text
 * @returns {Map<string, string>}
 */
function archGateIndex(arch) {
  const lines = arch.split('\n');
  const start = lines.findIndex((line) => line.includes('#### 4.1'));
  const end = lines.findIndex((line, i) => i > start && line.includes('#### 4.2'));
  /** @type {Map<string, string>} */
  const index = new Map();
  if (start < 0 || end < 0) return index;
  for (const line of lines.slice(start, end)) {
    const gateMatch = /`((?:verify|audit|sa2)-[\w-]+)`/.exec(line);
    if (!gateMatch) continue;
    const gate = gateMatch[1];
    const ids = [];
    for (const raw of line.match(/\b(?:E-\d{2}|PE-\d{2}|E\d{2})\b/g) || []) ids.push(raw);
    for (const range of line.match(/\b(PE-\d{2})~(\d{2})\b/g) || []) {
      const parts = /(\d{2})~(\d{2})/.exec(range);
      if (!parts) continue;
      for (let n = Number.parseInt(parts[1], 10); n <= Number.parseInt(parts[2], 10); n += 1) {
        ids.push(`PE-${String(n).padStart(2, '0')}`);
      }
    }
    for (const id of ids) if (!index.has(id)) index.set(id, gate);
  }
  return index;
}

/**
 * Parse the existing rows file into a gate-basename→assertions index.
 * @param {string} rowsText align431 rows JSON text
 * @returns {Map<string, string[]>}
 */
function rowGateIndex(rowsText) {
  const rows = JSON.parse(rowsText);
  /** @type {Map<string, string[]>} */
  const index = new Map();
  const all = [...(rows.baselineRows || []), ...(rows.addedRows || [])];
  for (const row of all) {
    const gate = String(row.gate || '').split('/').pop().replace(/\.mjs$/, '');
    const assertion = String(row.assertion || '');
    if (!gate || !assertion) continue;
    const list = index.get(gate) || [];
    if (!list.includes(assertion)) list.push(assertion);
    index.set(gate, list.sort(cmp));
  }
  return index;
}

/**
 * Resolve a machine-greppable gate assertion name for one evidence entry.
 * @param {string} id evidence id
 * @param {string} body section body
 * @param {Map<string, string>} archGates architecture gate index
 * @param {Map<string, string[]>} rowGates rows gate index
 * @returns {string}
 */
function gateAssert(id, body, archGates, rowGates) {
  const mentioned = [...body.matchAll(/\b((?:verify|audit|sa2)-[\w-]+)\b/g)].map((m) => m[1]);
  const candidates = [...mentioned, archGates.get(id) || ''].filter(Boolean);
  for (const gate of candidates) {
    const assertions = rowGates.get(gate.replace(/\.mjs$/, ''));
    if (assertions && assertions.length) return assertions[0];
  }
  return `E0_REGISTRY_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/**
 * Build the U1 entry from the architecture's own UNCLEAR row: no guessed value.
 * @param {string} arch architecture document text
 * @returns {object}
 */
function buildU1(arch) {
  const line = arch.split('\n').find((x) => /^\|\s*U1\s*\|/.test(x)) || '';
  const cells = line.split('|').map((x) => x.trim());
  const item = cells[2] || '未定义数字（三本账本未给出坐标或复算命令）';
  const failClosed = cells[4] || '不写入该数字；从单一来源清单移除，禁止猜值。';
  const nextCarrier = cells[5] || '定位 E0 坐标与复算命令后再入清单。';
  return {
    evidenceId: 'U1',
    sourceLedger: ARCH_FILE,
    grade: 'D',
    provable: 'static',
    practice: `禁止将未证字面量写入单一来源清单：${normalizePaths(item).slice(0, 180)}`,
    e0Coord: {
      file: ARCH_FILE,
      recordId: 'UNCLEAR-U1',
      detail: '三本证据账本与原始包证据均未提供该数字的 E0 坐标或明确复算命令；只作为其它数值的子串出现，语义未证。',
    },
    reproduceCmd: 'node -e \'console.log("E0_UNRESOLVED:U1; fail-closed; value intentionally not registered")\'',
    counterexamples: [
      '把相邻数字的子串截断当作该数字的定值',
      '沿用 PRD P1-2 旧单一来源清单中的该项',
    ],
    consumers: [`${ARCH_FILE}#U1`, 'docs/PRD-全链路真实对齐-20261120.md#P1-2'],
    gateAssert: 'E0_REGISTRY_U1',
    status: 'unresolved',
    failClosed: normalizePaths(failClosed),
    nextCarrier: normalizePaths(nextCarrier),
  };
}

/**
 * Generate the registry object.
 * @returns {object}
 */
function buildRegistry() {
  const arch = read(ARCH_FILE);
  const archGates = archGateIndex(arch);
  const rowGates = rowGateIndex(read(ROWS_FILE));
  const postText = read(LEDGERS[2].file);
  const summaryCoords = summaryCoordIndex(postText);
  /** @type {object[]} */
  const entries = [];

  for (const ledger of LEDGERS) {
    const text = ledger.file === LEDGERS[2].file ? postText : read(ledger.file);
    for (const section of splitSections(text, ledger.pattern)) {
      const coord = pickCoord(section.body, ledger.file, section.id, summaryCoords.get(section.id));
      const grade = pickGrade(section.body, section.id);
      const resolved = coord.resolved;
      const entry = {
        evidenceId: section.id,
        sourceLedger: ledger.file,
        grade,
        provable: grade === 'R' ? 'runtime' : 'static',
        practice: pickPractice(section.title, section.body),
        e0Coord: {
          file: coord.file,
          ...(coord.offset !== undefined ? { offset: coord.offset } : {}),
          ...(coord.VA !== undefined ? { VA: coord.VA } : {}),
          ...(coord.recordId !== undefined ? { recordId: coord.recordId } : {}),
          detail: coord.detail,
        },
        reproduceCmd: reproduceCommand(coord, section.id, section.body),
        counterexamples: counterexamples(section.body, section.id),
        consumers: consumers(section.body, ledger.file, section.id),
        gateAssert: gateAssert(section.id, section.body, archGates, rowGates),
        status: resolved ? 'verified' : 'unresolved',
      };
      if (!resolved) {
        entry.failClosed = `无 E0 坐标的 ${section.id} 不进实现、不标 A；运行时遇到该分支即失败退出。`;
        entry.nextCarrier = `在 ${ledger.file} 对应原始 BIN/.so 中定位 ${section.id} 的坐标与复算命令后再入清单；扫描命令：grep -n '${section.id}' ${ledger.file}。`;
      }
      entries.push(entry);
    }
  }

  entries.push(buildU1(arch));
  entries.sort((a, b) => cmp(a.evidenceId, b.evidenceId));

  const sourceLedgers = LEDGERS.map((x) => x.file).sort(cmp);
  const registry = { schemaVersion: SCHEMA_VERSION, sourceLedgers, entries };
  const output = JSON.stringify(registry, null, 2) + '\n';
  if (/(?:\/Users\/|\/Applications\/|\/private\/)/.test(output)) {
    throw new Error('registry contains an absolute path');
  }
  writeFileSync(join(ROOT, OUT_FILE), output, 'utf8');
  process.stdout.write(`[build-align431-evidence-registry] entries=${entries.length} file=${OUT_FILE}\n`);
  if (process.env.E431_DEBUG === '1') {
    for (const entry of entries) {
      const c = entry.e0Coord;
      const loc = c.offset !== undefined ? `offset=${c.offset}` : c.VA ? `VA=${c.VA}` : `recordId=${c.recordId}`;
      process.stdout.write(`${entry.evidenceId} ${c.file}:${loc} ${entry.status} ${entry.gateAssert}\n`);
    }
  }
}

buildRegistry();
