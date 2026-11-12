#!/usr/bin/env node
/**
 * build-oem-enter-frames.mjs — 把 SYS_DATA comm 子表编译成「逐 ECU 逐地址原厂进模块帧序列」。
 *
 * 背景（2026-11-12 全量收口）：上一阶段只取了每个 sysId 的**第一个** `10 xx` 帧当会话号，
 * 运行时仍按族流发帧、把原厂序列打在日志里。本工具把剩余证据一并编译：
 *
 *   data/sysdata-comm.json 的每条 comm 记录含 [cat, subs]，每个 sub 带
 *   [tx, rx, cmds[]]，cmds 已经由 COMMAND.GAG 解成 [flag][len][payload] 帧
 *   （blk.frames 按 subs 顺序拼接，可按 cmds.length 切片还原）。
 *
 *   ★ 两个关键发现（推翻旧口径）：
 *     ① 68 个「无 10 xx 会话帧」的 sysId **全部是老代 type 0x01-0x0A**，
 *        序列是 `81`（KWP 快初始化）+ `1A 9x` 识别 —— 原厂不建 UDS 会话，
 *        旧实现回退 `10 89` 会把 UDS 帧发给老 KWP ECU。
 *     ② 同一 sysId 可有多条功能序列（107 个 sysId），会话号按序列而变，
 *        例如 DME 0x0e01：编码序列 1089→1A9F→1089、识别序列 3E00→22F19E→22F1A2→1003。
 *        「逐 ECU 会话」应升级为「逐 ECU 逐序列会话」。
 *
 * 产物：src/oem-enter-frames.js（勿手改），紧凑字符串编码以控制 bundle 体积。
 * 用法：node tools/build-oem-enter-frames.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'sysdata-comm.json');
const OUT = path.join(ROOT, 'src', 'oem-enter-frames.js');

const doc = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const frameHex = (f) => f.slice(2).map(hex).join('');

// 可直接在诊断链路上发送的帧 SID（其余是链路层/服务声明/复合脚本，进模块阶段跳过并留痕）。
// 依据：cat=0x20 的 `3070`×22、cat=0x30 的 `A00F00FF00FF`×45、cat=0x02 的 `81`×73
// 都是单字节或非 UDS 服务声明；flag=3 是 22 条约 31 字节的复合脚本帧。
const SENDABLE_SID = new Set([0x10, 0x1a, 0x21, 0x22, 0x23, 0x2e, 0x3b, 0x3e, 0x27, 0x31, 0x2f, 0x2a]);

const seqMap = {};          // sysId -> [ 'cat,tx,rx|flag:HEX ...', ... ]
const sessionless = [];     // 原厂序列里没有 10 xx 会话帧的 sysId
const stats = {
  sysIds: 0, sequences: 0, frames: 0, multiSequence: 0,
  withAddress: 0, sessionFrames: 0, skippedFrames: 0,
  sessionValues: {}, cats: {}, legacy81: 0,
};

for (const [sid, e] of Object.entries(doc.ecu)) {
  stats.sysIds++;
  const seqs = [];
  let hasSession = false;

  for (const blk of e.blocks || []) {
    stats.cats[blk.cat] = (stats.cats[blk.cat] || 0) + 1;
    const subs = blk.subs || [];
    // 按 cmds.length 把 blk.frames 切片还原到各 sub；flat 记录（cat 1/2/4）当作单序列。
    const groups = subs.length
      ? (() => {
          let off = 0;
          return subs.map((s) => {
            const fs = (blk.frames || []).slice(off, off + (s.cmds || []).length);
            off += (s.cmds || []).length;
            return { tx: s.tx, rx: s.rx, frames: fs };
          });
        })()
      : [{ tx: null, rx: null, frames: blk.frames || [] }];

    for (const g of groups) {
      const parts = [];
      for (const f of g.frames) {
        if (!Array.isArray(f) || f.length < 3) continue;
        stats.frames++;
        const flag = f[0];
        const sidByte = f[2];
        const payload = frameHex(f);
        if (sidByte === 0x10 && flag !== 3) {
          hasSession = true;
          stats.sessionFrames++;
          const k = `0x${hex(f[3])}`;
          stats.sessionValues[k] = (stats.sessionValues[k] || 0) + 1;
        }
        if (sidByte === 0x81 && payload.length === 2) stats.legacy81++;
        if (flag === 3 || !SENDABLE_SID.has(sidByte)) stats.skippedFrames++;
        parts.push(`${flag}${flag === 3 ? '!' : ''}:${payload}`);
      }
      if (!parts.length) continue;
      if (g.tx != null) stats.withAddress++;
      seqs.push(`${blk.cat},${g.tx == null ? '' : '0x' + g.tx.toString(16)},`
        + `${g.rx == null ? '' : '0x' + g.rx.toString(16)}|${parts.join(' ')}`);
      stats.sequences++;
    }
  }

  if (seqs.length) seqMap[sid] = seqs;
  if (seqs.length > 1) stats.multiSequence++;
  if (!hasSession) sessionless.push(sid);
}

const emit = (name, obj) => {
  const lines = Object.entries(obj).map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`);
  return `export const ${name} = Object.freeze({\n${lines.join('\n')}\n});\n`;
};

const body = `/**
 * oem-enter-frames.js — 自动生成，勿手改。
 * 生成器：tools/build-oem-enter-frames.mjs（数据源 data/sysdata-comm.json）
 *
 * 逐 ECU 逐地址的**原厂进模块帧序列**（SYS_DATA comm 子表 + COMMAND.GAG 解帧）。
 * 编码：'cat,tx,rx|flag:HEX flag:HEX ...'；flag=3 记为 '3!'（复合脚本帧，不可直接发送）。
 * - 有 10 xx 会话帧的序列：按原厂帧序进模块，会话号/容错由该帧的 flag 决定。
 * - 无会话帧的 68 个老代 sysId：原厂是 81（KWP 快初始化）+1A 识别，**不建 UDS 会话**。
 * - 非 UDS 帧（81/1800FF00/3070/A00F00FF00FF/复合脚本）：链路层或服务声明，进模块阶段跳过。
 */
${emit('OEM_ENTER_SEQS', seqMap)}
${emit('OEM_SESSIONLESS_SYSIDS_SET', Object.fromEntries(sessionless.map((k) => [k, true])))}

/** sysId → 原厂进模块序列组（按 comm 记录顺序）；无证据返回 []。 */
export function oemEnterSequences(sysId) {
  if (sysId == null) return [];
  const raw = OEM_ENTER_SEQS[String(sysId).toLowerCase()] || [];
  return raw.map((line) => {
    const [head, framesRaw] = line.split('|');
    const [cat, tx, rx] = head.split(',');
    return {
      cat: Number.parseInt(cat, 10),
      tx: tx ? Number.parseInt(tx, 16) : null,
      rx: rx ? Number.parseInt(rx, 16) : null,
      frames: (framesRaw || '').split(' ').filter(Boolean).map((t) => {
        const i = t.indexOf(':');
        const flagStr = t.slice(0, i);
        return { flag: Number.parseInt(flagStr, 10) || 0, script: flagStr.endsWith('!'), hex: t.slice(i + 1) };
      }),
    };
  });
}

/** 该 sysId 原厂是否不建 UDS 会话（老代 KWP 快初始化序列）。 */
export function oemIsSessionless(sysId) {
  return !!OEM_SESSIONLESS_SYSIDS_SET[String(sysId).toLowerCase()];
}

/**
 * 选一条与当前绑定地址/目标会话最吻合的原厂序列。
 * 优先级：地址匹配 > 会话号匹配 > 含会话帧 > 记录顺序第一。
 * 同优先级保持 comm 记录顺序，绝不跨代借序列。
 */
export function selectOemSequence(sysId, tx = null, session = null) {
  const seqs = oemEnterSequences(sysId);
  if (!seqs.length) return null;
  const score = (s) => {
    const sessFrames = s.frames.filter((f) => !f.script && f.hex.startsWith('10') && f.hex.length >= 4);
    const matches = session == null ? false
      : sessFrames.some((f) => Number.parseInt(f.hex.slice(2, 4), 16) === session);
    return (tx != null && s.tx === tx ? 8 : 0)
      + (matches ? 4 : 0)
      + (sessFrames.length ? 2 : 0);
  };
  let best = seqs[0], bestScore = score(seqs[0]);
  for (let i = 1; i < seqs.length; i++) {
    const v = score(seqs[i]);
    if (v > bestScore) { best = seqs[i]; bestScore = v; }
  }
  return best;
}

/** 进模块链路可直接发送的诊断 SID；其余（链路层快初始化/服务声明/复合脚本）跳过并留痕。 */
export const OEM_SENDABLE_SID = Object.freeze([${[...SENDABLE_SID].map((x) => `0x${hex(x)}`).join(', ')}]);

export const OEM_ENTER_STATS = Object.freeze(${JSON.stringify(stats)});
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`写出 src/oem-enter-frames.js：${Object.keys(seqMap).length} sysId / `
  + `${stats.sequences} 序列 / ${stats.frames} 帧 / ${sessionless.length} 个原厂不建会话`);
console.log('会话帧值分布：', JSON.stringify(stats.sessionValues));
console.log('多序列 sysId：', stats.multiSequence, '；跳过（非 UDS/脚本）帧：', stats.skippedFrames);
console.log('产物大小：', (fs.statSync(OUT).size / 1024).toFixed(1) + 'KB');
