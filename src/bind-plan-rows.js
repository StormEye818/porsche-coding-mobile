/**
 * bind-plan-rows.js — 生产 `data/bind-plan.json` → runtime 候选行的**纯函数**适配器。
 *
 * ★ 2026-11-20 阶段 A（P0-1 契约漂移修复）：
 *   生成器（tools/export-bind-plan.py）实际产出的是
 *   `cands[] / pairs[] / truth[] / requestKeys[] / blockOff[] / blockKeys[]`；
 *   旧消费者却读 `entry.can` + `entry.requestKey` 单数，623 条中只有 0x0f4d
 *   因四元特例带这两个兼容字段，导致真实数据只选出 1/623 条 runtime row。
 *
 * 本模块只做**候选行选取**，不生成、不推断绑定：
 *   - 一个 row = 一个静态候选 CAN + 一个请求键（或无请求键时的显式 null）；
 *   - `truth` 本代 cat=0x10 静态真值优先，其次 `pairs` 中 commCat10/static，
 *     最后其它 `pairs`（一律标 `provable:'derived'`，排在所有 static 之后）；
 *   - 请求键只作绑定入参，**绝不**把低 16 位当 CAN；
 *   - 绑定真值仍由 `nativeProbeForRow()` 的真实回帧 + `bindByRequestKey()` 产生；
 *   - `0x0f4d` 四元对象与 `altIdentitySysIds` 原样保留，不按 CAN raw 合并。
 *
 * 兼容别名（`can` / `requestKey` 单数）仅供旧 in-memory fixture 使用，
 * **不是**生产契约；生产条目必须走 truth/pairs/requestKeys 路径。
 */

/**
 * 把 CAN ID（十六进制字符串或数值）归一为 11 位整数；非法值返回 null。
 *
 * @param {string|number|null|undefined} value 原始 CAN ID
 * @returns {number|null} 合法 11 位 ID，或 null
 */
function normalizeCanId(value) {
  const n = typeof value === 'number'
    ? value
    : Number.parseInt(String(value ?? '').trim(), 16);
  return Number.isInteger(n) && n > 0 && n <= 0x7ff ? n : null;
}

/**
 * 请求键归一：数值补成 4 位十六进制（旧 fixture 的四元低 16 位），
 * 字符串原样保留（生产 `0x0030xxxx` / `0xFF60xxxx` / 少数低 16 位）。
 *
 * @param {string|number|null|undefined} value 原始请求键
 * @returns {string|null} 归一后的请求键，空值返回 null
 */
function normalizeRequestKey(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `0x${value.toString(16).padStart(4, '0')}` : null;
  }
  const s = String(value ?? '').trim();
  return s || null;
}

/**
 * 从 entry 取请求键列表：生产只认 `requestKeys`（含空数组，空数组表示
 * 「此 sysId 无绑定入参」，行仍保留 requestKey:null 让下游 fail-closed）；
 * 仅在字段缺失时退回单数 `requestKey` 兼容别名。
 *
 * @param {object} entry bind-plan ecu 条目
 * @returns {{keys:string[], declared:boolean}} 请求键数组 + 字段是否声明
 */
function requestKeysOf(entry) {
  const field = Object.prototype.hasOwnProperty.call(entry, 'requestKeys')
    ? 'requestKeys'
    : (Object.prototype.hasOwnProperty.call(entry, 'requestKey') ? 'requestKey' : null);
  if (!field) return { keys: [], declared: false };
  const raw = entry[field];
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  return { keys: list.map(normalizeRequestKey).filter(Boolean), declared: true };
}

/**
 * 派生静态/派生候选 CAN，按「truth → commCat10/static → 其它 pairs」排序。
 * 同一 tx/rx 只保留首次出现（真值优先），derived 不覆盖 static。
 *
 * @param {object} entry bind-plan ecu 条目
 * @returns {Array<{tx:number,rx:number,rxRule:string,provable:string,
 *                  source:string,e0Coord:string}>} 候选 CAN 列表
 */
function canCandidatesOf(entry) {
  const out = [];
  const seen = new Set();
  const push = (can, source, provable, explicitCoord) => {
    if (!can || typeof can !== 'object') return;
    const tx = normalizeCanId(can.tx);
    const rx = normalizeCanId(can.rx);
    if (tx === null || rx === null) return;
    const dedup = `${tx}|${rx}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    out.push({
      tx,
      rx,
      rxRule: String(can.rxRule || ''),
      provable,
      source,
      e0Coord: String(explicitCoord || can.e0Coord || ''),
    });
  };

  const truth = Array.isArray(entry.truth) ? entry.truth : [];
  const pairs = Array.isArray(entry.pairs) ? entry.pairs : [];

  // ① 本代 cat=0x10 静态真值（A>>5/C>>5 可离线复算）。
  for (const item of truth) {
    if (item?.provable !== 'static') continue;
    push(item, 'truth', 'static', item.e0Coord);
  }
  // ② pairs 中明确标为 commCat10/static 的地址对。
  for (const pair of pairs) {
    if (pair?.provable !== 'static' || pair.rxSource !== 'commCat10') continue;
    push(pair, 'commCat10', 'static', pair.e0Coord);
  }
  // ③ 其它 pairs：低优先级 derived 候选，绝不冒充 static truth。
  for (const pair of pairs) {
    if (pair?.provable === 'static' && pair.rxSource === 'commCat10') continue;
    const rxSource = String(pair?.rxSource || '');
    const source = rxSource.startsWith('tableA') ? 'tableA' : 'derived';
    push(pair, source, 'derived', pair?.e0Coord);
  }

  // ④ 兼容别名：仅当生产 truth/pairs 全缺时，才认旧 fixture 的单个 `can`。
  //    生产数据 623 条中只有 0x0f4d 带此别名，且它同时有 truth → 走不到这里。
  if (!truth.length && !pairs.length && entry.can && typeof entry.can === 'object') {
    if (entry.can.provable === 'static') push(entry.can, 'truth', 'static', entry.can.e0Coord);
  }
  return out;
}

/**
 * blockOff 关联：数组且长度与 requestKeys 一致时按**稳定请求键索引**逐行关联；
 * 长度不一致时没有明确映射，保持原数组序列化字符串（如 `21100,21183`），不猜。
 *
 * @param {object} entry bind-plan ecu 条目
 * @param {string[]} keys 已归一的请求键数组
 * @returns {{perKey: Array<string|null>, shared: string|null}} 关联结果
 */
function blockOffOf(entry, keys) {
  const raw = entry.blockOff;
  if (Array.isArray(raw)) {
    const parts = raw.map((v) => String(v ?? '').trim() || null);
    if (keys.length && raw.length === keys.length) return { perKey: parts, shared: null };
    return { perKey: null, shared: parts.join(',') || null };
  }
  if (raw == null) return { perKey: null, shared: null };
  const s = String(raw).trim();
  return { perKey: null, shared: s || null };
}

/**
 * 从真实 bind-plan ecu 条目派生 runtime 候选行（纯函数，不改入参）。
 *
 * @param {object|null|undefined} entry data/bind-plan.json 的 ecu[sysId]
 * @param {{sysId?:string}} [options] 显式 sysId（默认取 entry.sysId）
 * @returns {Array<{tx:number,rx:number,rxRule:string,requestKey:string|null,
 *                  sysId:string,name:string,blockOff:string|null,
 *                  altIdentitySysIds:string[],provable:string,e0Coord:string,
 *                  source:string}>} 候选行（真值在前，derived 在后）
 */
export function bindPlanRuntimeRows(entry, { sysId = '' } = {}) {
  if (!entry || typeof entry !== 'object') return [];
  const resolvedSysId = String(sysId || entry.sysId || entry.fourTuple?.sysId || '').toLowerCase();
  const candidates = canCandidatesOf(entry);
  if (!candidates.length) return [];

  const { keys, declared } = requestKeysOf(entry);
  // 请求键字段整体缺失（生产 schema 漂移/改名注入）→ 无绑定入参契约，行数为 0；
  // 字段存在但为空数组（如 0x1408）→ 保留候选行且 requestKey 显式为 null，
  // 让下游 fail-closed，不静默丢弃。
  if (!declared) return [];
  const effectiveKeys = keys.length ? keys : [null];
  const blockOff = blockOffOf(entry, keys);
  const fourTuple = entry.fourTuple && typeof entry.fourTuple === 'object' ? entry.fourTuple : {};
  const name = String(entry.sysName || entry.name || fourTuple.sysName || '');
  const altRaw = Array.isArray(entry.altIdentitySysIds) ? entry.altIdentitySysIds
    : (Array.isArray(fourTuple.altIdentitySysIds) ? fourTuple.altIdentitySysIds : []);
  const altIdentitySysIds = altRaw.map((v) => String(v));
  const entryCoord = String(entry.e0Coord || '');

  const rows = [];
  for (const cand of candidates) {
    for (let i = 0; i < effectiveKeys.length; i++) {
      const rk = effectiveKeys[i];
      rows.push({
        tx: cand.tx,
        rx: cand.rx,
        rxRule: cand.rxRule,
        requestKey: rk,
        sysId: resolvedSysId,
        name,
        blockOff: rk === null ? blockOff.shared
          : (blockOff.perKey ? blockOff.perKey[i] : blockOff.shared),
        altIdentitySysIds: [...altIdentitySysIds],
        provable: cand.provable,
        e0Coord: cand.e0Coord || entryCoord,
        source: cand.source,
      });
    }
  }
  return rows;
}

export default bindPlanRuntimeRows;
