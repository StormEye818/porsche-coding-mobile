#!/usr/bin/env node
/**
 * build-oem-session-table.mjs — 把 SYS_DATA comm 表编译成运行时静态表。
 *
 * 背景（2026-11-12）：上一阶段已证明「逐 ECU 会话被加密体挡住」是错的——
 * data/sysdata-comm.json 里 874 条 comm 记录经 COMMAND.GAG 解帧后，每个 sysId 都有
 * 自己的进模块命令序列，其中 `10 xx` 帧给出原厂会话号。981 实测 48 模块 =
 * 32×`10 03` + 16×`10 89`，此前运行时一律发 `10 89` 是明确对齐缺口。
 *
 * 本工具把它从「浏览器 fetch 570KB JSON + 日志提示未对齐」升级为
 * 「协议层直接 import 的静态证据表」，落地点：
 *   - src/oem-session-table.js  ← 本工具产物（勿手改）
 *   - src/coder.js  setOemContext(sysId) / enterSession 默认取证据会话
 *   - src/app.js    进模块设置上下文并打印原厂序列
 *
 * 帧格式（COMMAND.GAG）: [flag][len][payload...]
 *   flag=1 → 原厂要求正响应（如 `01 02 10 89`）
 *   flag=0 → 原厂不要求正响应（如 `00 02 10 03`、`00 02 3E 00`）
 *   flag=3 → 复合脚本帧（22 条，约 31 字节宏序列，**不是可直接发的 UDS 帧**）。
 *            全表会话帧的 flag 只有 0/1，故 flag=3 不参与会话判定；
 *            序列串里输出成 `3!:HEX` 以免被当成可发帧。
 * 这与 coder.js「10 03 尽力而为 / 10 89 硬要求」的容错分级一致，flag 一并导出，
 * 使「会话号数据驱动」不会把尽力而为的会话误判成硬要求（避免写流程卡死）。
 *
 * 用法：node tools/build-oem-session-table.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'sysdata-comm.json');
const OUT = path.join(ROOT, 'src', 'oem-session-table.js');

const doc = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const frameHex = (f) => f.slice(2).map(hex).join('');

const sessionMap = {};   // sysId -> [session, requireResponse]
const seqMap = {};       // sysId -> 'flag:HEX flag:HEX | ...'（按 block 分组）
const genMap = {};       // sysId -> type（代际）
let noSession = 0;
const sessionDist = {};

for (const [sid, e] of Object.entries(doc.ecu)) {
  genMap[sid] = e.type || null;
  const groups = [];
  let picked = null;
  for (const blk of e.blocks || []) {
    const group = [];
    for (const f of blk.frames || []) {
      if (!Array.isArray(f) || f.length < 3) continue;
      const flag = f[0];
      // flag=3 是复合脚本帧（非可直接发送的 UDS 帧），加 ! 标记防止被当成可发帧。
      group.push(`${flag}${flag === 3 ? '!' : ''}:${frameHex(f)}`);
      if (!picked && f.length >= 4 && f[2] === 0x10) {
        picked = [f[3], flag === 1];
      }
    }
    if (group.length) groups.push(group.join(' '));
  }
  if (picked) {
    sessionMap[sid] = picked;
    sessionDist[`0x${hex(picked[0])}`] = (sessionDist[`0x${hex(picked[0])}`] || 0) + 1;
  } else {
    noSession++;
  }
  if (groups.length) seqMap[sid] = groups.join(' | ');
}

const emit = (name, obj) => {
  const lines = Object.entries(obj).map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`);
  return `export const ${name} = Object.freeze({\n${lines.join('\n')}\n});\n`;
};

const body = `/**
 * oem-session-table.js — 自动生成，勿手改。
 * 生成器：tools/build-oem-session-table.mjs（数据源 data/sysdata-comm.json）
 *
 * 每个 sysId 的原厂进模块会话与命令序列，来自 SYS_DATA comm 子表 + COMMAND.GAG 解帧。
 * 会话帧 flag=1 → 原厂要求正响应；flag=0 → 尽力而为（与协议层容错分级一致）。
 * 查不到会话号的 sysId 保持「未证」，调用方回退主会话 10 89，绝不猜。
 */
${emit('OEM_SESSION_BY_SYSID', sessionMap)}
${emit('OEM_ENTER_SEQ_BY_SYSID', seqMap)}
${emit('OEM_GEN_BY_SYSID', genMap)}

/** sysId → { session, requireResponse, gen, seq }；无证据返回 null。 */
export function oemSessionFor(sysId) {
  if (sysId == null) return null;
  const key = String(sysId).toLowerCase();
  const hit = OEM_SESSION_BY_SYSID[key];
  if (!hit) return null;
  return {
    session: hit[0],
    requireResponse: hit[1],
    gen: OEM_GEN_BY_SYSID[key] || null,
    seq: OEM_ENTER_SEQ_BY_SYSID[key] || '',
  };
}

/** 原厂进模块序列，按 block 分组展示；无证据返回 ''。 */
export function oemEnterSeqFor(sysId) {
  return sysId == null ? '' : (OEM_ENTER_SEQ_BY_SYSID[String(sysId).toLowerCase()] || '');
}
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`写出 src/oem-session-table.js：${Object.keys(sessionMap).length} 个会话 / `
  + `${Object.keys(seqMap).length} 条序列 / ${noSession} 个 sysId 无会话（未证回退）`);
console.log('会话分布：', JSON.stringify(sessionDist));
console.log('产物大小：', (fs.statSync(OUT).size / 1024).toFixed(1) + 'KB');
