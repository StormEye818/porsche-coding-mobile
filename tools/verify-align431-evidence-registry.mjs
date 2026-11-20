#!/usr/bin/env node
/**
 * T01 · verify-align431-evidence-registry.mjs
 *
 * Falsifiable gate for data/align431-evidence-registry.json:
 *   - JSON Schema compliance (including unresolved ⇒ failClosed + nextCarrier)
 *   - E0 coordinate shape and ledger ID coverage (no orphan entries)
 *   - every reproduceCmd is actually executed and must exit 0
 *   - deterministic纪律: sorted arrays, no absolute paths / clock / random
 *
 * Any failing assertion prints its name and exits non-zero.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = 'tools/align431-evidence-schema.json';
const BUILDER_FILE = 'tools/build-align431-evidence-registry.mjs';
const REGISTRY_FILE = 'data/align431-evidence-registry.json';
const LEDGER_FILES = [
  'docs/evidence/431-static-allmodels-20261120.md',
  'docs/evidence/431-linkmap-20261120.md',
  'docs/evidence/431-postentry-20261120.md',
];
const LEDGER_PATTERNS = [
  /^###\s+(E\d{2})\s*[—–-]/gm,
  /^###\s+(E-\d{2})\s+/gm,
  /^###\s+(PE-\d{2})\s*[｜|]/gm,
];
const E0_ROOT = join(ROOT, '..', 'porsche-mapper', 'ref');
const COMMAND_TIMEOUT_MS = 20000;

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const passed = [];

/**
 * Record an assertion result.
 * @param {string} name assertion name
 * @param {boolean} ok result
 * @param {string} detail explanatory detail
 */
function assert(name, ok, detail) {
  if (ok) {
    passed.push(name);
  } else {
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

/**
 * Read an UTF-8 file relative to the repository root.
 * @param {string} rel repo-relative path
 * @returns {string}
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * Minimal JSON Schema 2020-12 evaluator covering exactly the keywords used by
 * tools/align431-evidence-schema.json. Kept local so the gate has no deps.
 * @param {unknown} node instance
 * @param {object} schema schema fragment
 * @param {string} path error path
 * @param {string[]} errors collected errors
 * @returns {void}
 */
function validate(node, schema, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;
  const schemaRoot = root || schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const target = schema.$ref.slice(2).split('/').reduce((obj, key) => (obj ? obj[key] : undefined), schemaRoot);
    if (!target) {
      errors.push(`${path}: unresolved $ref ${schema.$ref}`);
      return;
    }
    validate(node, target, path, errors, schemaRoot);
    return;
  }
  if (schema.required && node && typeof node === 'object' && !Array.isArray(node)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) errors.push(`${path}: missing ${key}`);
    }
  }
  if (schema.type === 'object') {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${path}: expected object`);
      return;
    }
    const props = schema.properties || {};
    for (const [key, value] of Object.entries(node)) {
      if (props[key]) {
        validate(value, props[key], `${path}.${key}`, errors, schemaRoot);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected ${key}`);
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(node)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      errors.push(`${path}: shorter than ${schema.minItems}`);
    }
    if (schema.items) {
      node.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, errors, schemaRoot));
    }
  } else if (schema.type === 'string') {
    if (typeof node !== 'string') {
      errors.push(`${path}: expected string`);
      return;
    }
    if (schema.minLength !== undefined && node.length < schema.minLength) {
      errors.push(`${path}: too short`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(node)) {
      errors.push(`${path}: expected integer`);
      return;
    }
    if (schema.minimum !== undefined && node < schema.minimum) errors.push(`${path}: below minimum`);
  }
  if (schema.enum && !schema.enum.includes(node)) errors.push(`${path}: outside enum`);
  if (schema.const !== undefined && node !== schema.const) errors.push(`${path}: const mismatch`);
  if (schema.pattern && typeof node === 'string' && !new RegExp(schema.pattern).test(node)) {
    errors.push(`${path}: pattern mismatch`);
  }
  if (schema.anyOf && !schema.anyOf.some((sub) => {
    const local = [];
    validate(node, sub, path, local, schemaRoot);
    return local.length === 0;
  })) {
    errors.push(`${path}: anyOf failed`);
  }
  if (schema.if) {
    const local = [];
    validate(node, schema.if, path, local, schemaRoot);
    if (local.length === 0 && schema.then) validate(node, schema.then, path, errors, schemaRoot);
  }
}

/**
 * Compare strings without locale dependence.
 * @param {string} a left
 * @param {string} b right
 * @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Collect all scalar values recursively (to detect a forbidden standalone value).
 * @param {unknown} node value
 * @param {unknown[]} out accumulator
 * @returns {unknown[]}
 */
function scalars(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) scalars(item, out);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) scalars(value, out);
  } else {
    out.push(node);
  }
  return out;
}

/**
 * Compute the SHA-256 of a UTF-8 string.
 * @param {string} text input
 * @returns {string}
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Run every assertion and print the gate result.
 * @returns {void}
 */
function main() {
  const schema = JSON.parse(read(SCHEMA_FILE));
  const registryText = read(REGISTRY_FILE);
  const registry = JSON.parse(registryText);

  assert('SCHEMA_FILE_OK', schema.$schema.includes('json-schema.org') && !!schema.$defs?.evidenceEntry, 'schema has no evidenceEntry definition');

  const schemaErrors = [];
  validate(registry, schema, 'registry', schemaErrors);
  assert('REGISTRY_SCHEMA_OK', schemaErrors.length === 0, schemaErrors.slice(0, 6).join('; '));

  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  const ids = entries.map((entry) => entry.evidenceId);
  assert('NO_DUPLICATE_IDS', new Set(ids).size === ids.length, 'duplicate evidenceId');
  assert('IDS_SORTED', JSON.stringify(ids) === JSON.stringify([...ids].sort(cmp)), 'entries array is not sorted');

  const ledgerIds = [];
  LEDGER_FILES.forEach((file, index) => {
    const text = read(file);
    const pattern = LEDGER_PATTERNS[index];
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      ledgerIds.push(match[1]);
      match = pattern.exec(text);
    }
  });
  const expectedIds = [...ledgerIds, 'U1'].sort(cmp);
  assert('LEDGER_IDS_COVERED', JSON.stringify(ids) === JSON.stringify(expectedIds),
    `missing=${expectedIds.filter((x) => !ids.includes(x)).join(',') || '-'}; extra=${ids.filter((x) => !expectedIds.includes(x)).join(',') || '-'}`);

  let coordsOk = 0;
  let counterexamplesOk = 0;
  let consumersOk = 0;
  let gateAssertOk = 0;
  let absolutePathHits = 0;
  let gradeOk = 0;
  for (const entry of entries) {
    const coord = entry.e0Coord || {};
    const hasLocator = Number.isInteger(coord.offset) || typeof coord.VA === 'string' || typeof coord.recordId === 'string';
    if (coord.file && hasLocator && coord.detail && !(entry.status === 'verified' && /\.md$/.test(coord.file))) coordsOk += 1;
    if (Array.isArray(entry.counterexamples) && entry.counterexamples.length > 0) counterexamplesOk += 1;
    if (Array.isArray(entry.consumers) && entry.consumers.length > 0
      && entry.consumers.every((x) => /^(?:src|data|tools|docs|ref|ARCH|SPEC|LEDGER)[:/]/.test(x))) consumersOk += 1;
    if (typeof entry.gateAssert === 'string' && entry.gateAssert.length >= 3) gateAssertOk += 1;
    if ((entry.grade === 'R') === (entry.provable === 'runtime')) gradeOk += 1;
    for (const value of Object.values(entry)) {
      if (typeof value === 'string' && /(?:^|[\s'"`=:(])(?:\/Users\/|\/Applications\/|\/private\/|\/var\/folders\/)/.test(value)) absolutePathHits += 1;
    }
  }
  assert('E0_COORD_OK', coordsOk === entries.length, `${coordsOk}/${entries.length}`);
  assert('COUNTEREXAMPLES_OK', counterexamplesOk === entries.length, `${counterexamplesOk}/${entries.length}`);
  assert('NO_ORPHAN_ENTRY', consumersOk === entries.length, `${consumersOk}/${entries.length}`);
  assert('GATE_ASSERT_OK', gateAssertOk === entries.length, `${gateAssertOk}/${entries.length}`);
  assert('GRADE_PROVABLE_OK', gradeOk === entries.length, `${gradeOk}/${entries.length}`);
  assert('NO_ABSOLUTE_PATHS', absolutePathHits === 0, `${absolutePathHits} fields contain absolute paths`);
  assert('NO_ABSOLUTE_PATHS_IN_FILE', !/(?:\/Users\/|\/Applications\/|\/private\/|\/var\/folders\/)/.test(registryText), 'registry file contains absolute path');

  const builderSource = read(BUILDER_FILE);
  assert('NO_CLOCK_OR_RANDOM', !/Date\.now\(|new Date\(|Math\.random\(|process\.cwd\(/.test(builderSource), 'builder uses clock/random/cwd');

  const unresolved = entries.filter((entry) => entry.status === 'unresolved');
  assert('UNRESOLVED_FAIL_CLOSED', unresolved.every((entry) => entry.failClosed && entry.nextCarrier),
    `${unresolved.length} unresolved entries`);
  const u1 = entries.find((entry) => entry.evidenceId === 'U1');
  const scalarsAll = scalars(registry, []);
  assert('U1_NO_GUESSED_VALUE', !!u1 && u1.status === 'unresolved' && !scalarsAll.includes(2566) && !scalarsAll.includes('2566'),
    'U1 value must not be registered as a standalone scalar');

  let commandsOk = 0;
  for (const entry of entries) {
    const result = spawnSync('sh', ['-c', entry.reproduceCmd], {
      cwd: ROOT,
      env: { ...process.env, E0_ROOT, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (result.status === 0) {
      commandsOk += 1;
      process.stdout.write(`ASSERT ${entry.gateAssert} E0_COORD_REPRODUCED ${entry.evidenceId}\n`);
    } else {
      process.stdout.write(`ASSERT ${entry.gateAssert} REPRODUCE_FAILED ${entry.evidenceId} status=${result.status} signal=${result.signal || '-'}\n`);
      process.stdout.write(String(result.stderr || result.error || '').slice(0, 400) + '\n');
    }
  }
  assert('REPRODUCE_CMD_EXIT_ZERO', commandsOk === entries.length, `${commandsOk}/${entries.length}`);

  process.stdout.write(passed.map((name) => `ASSERT ${name} PASS\n`).join(''));
  process.stdout.write(`REGISTRY_ENTRIES ${entries.length}\n`);
  process.stdout.write(`REGISTRY_UNRESOLVED ${unresolved.length}\n`);
  process.stdout.write(`REGISTRY_SHA256 ${sha256(registryText)}\n`);
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
    process.stderr.write(`VERIFY_EVIDENCE_REGISTRY failed (${failures.length} assertion(s))\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('VERIFY_EVIDENCE_REGISTRY PASS\n');
  }
}

main();
