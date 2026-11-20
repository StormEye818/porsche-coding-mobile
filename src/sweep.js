/**
 * sweep.js — 431 连接期「静态选行 + 1 帧探针」候选编排 + 身份映射。
 *
 * ★ 2026-11-20 按 ARCH §9 T03 重写（E-01 / E-02 / E-05 / E-13 / E-14 / E-19 / E-20）：
 *   - **删除**自创 `0x700–0x7FF` 全段枚举与 `rxFor(tx) = tx + 8`（D 级我方设计，
 *     431 包内无该实现，且本代真值 302 对里 281 对 rx≠+8）。
 *   - 候选行只来自 DRIVELINKS addrBlock 的静态选行 + SYS_DATA comm cat=0x10 真值表
 *     （rx 取记录 C>>5 / rxRule 原样，不在运行时推导）。
 *   - 每个候选仅 1 帧 `22 14 09`；n==0 跳过探针；绑定入参为**请求键**；
 *     「哪条 CAN 应答」只由 src/live-map.js 的原生上报产生，缺失即 fail-closed。
 *   - 身份按**名字串 + 件号**裁决；0x0f4d(SWA2) 与 0x0e5f(BV_*) CAN raw 相同也不合并。
 *
 * 纯函数放这里（可单测），IO 在 app 侧。
 */

/** 探针帧（E-01 / PE-02：0xFF001409 = 22 14 09）；不是 CAN 地址。 */
export const PROBE_FRAME = '221409';
export const PROBE_FRAMES_PER_CANDIDATE = 1;

/** E-14：`0x0f4d` 与 `0x0e5f` 同 CAN raw 不同名，禁止按 raw/sysId 数值合并。 */
export const RAW_IDENTITY_COLLISIONS = Object.freeze([
  Object.freeze({
    raw: '0xE9C0F700',
    can: Object.freeze({ tx: 0x74e, rx: 0x7b8 }),
    entries: Object.freeze([
      Object.freeze({ sysId: '0x0f4d', name: 'SWA2_BaseSys' }),
      Object.freeze({ sysId: '0x0e5f', name: 'BV_ContrUnitLaneChangAssis2UDS_BaseSys' }),
    ]),
    rule: 'nameVariant + PARTNUMBER memcmp；raw 相同不合并',
  }),
]);

/**
 * 扫描结果归类：只看「回帧 ID 是否来自该候选 rx」+「有没有 body」。
 * NRC 也算有 ECU 应答（E-01 应答即绑），但 NRC 永远不是身份串。
 *
 * @param {{tx:number, rx:number}} cand
 * @param {number[]} ids 应答帧 CAN ID（frameIdsOf）
 * @param {string} body 应答体 hex（剥 PCI 后）
 * @returns {'alive'|'wrong-id'|'silent'}
 */
export function classifyProbe(cand, ids, body) {
  if (!Array.isArray(ids) || !ids.length) return body ? 'alive' : 'silent';
  if (!ids.includes(cand.rx)) return 'wrong-id';
  return body ? 'alive' : 'silent';
}

/**
 * 把 bind-plan 的四元条目展开为静态候选行（E-02：addrBlock 行原样搬移）。
 *
 * 只接受带 `provable:'static'` 的 CAN（`cat=0x10` A>>5/C>>5 可离线复算）。
 * 请求键只作绑定入参，绝不取低 16 位当 CAN。
 * blockOff 相同 → 同组只取首枚；blockOff 不同 → 必须分别绑定（Macan 0x0f23/0x0f34）。
 *
 * @param {object|null} bindPlan data/bind-plan.json（T02 重生后含四元字段）
 * @param {string[]} sysIds 本菜单要选的 sysId
 * @returns {Array<{tx:number,rx:number,rxRule:string,requestKey:string,
 *                  sysId:string,name:string,blockOff:string|null,
 *                  altIdentitySysIds:string[],provable:'static',e0Coord:string}>}
 */
export function selectAddrRows(bindPlan, sysIds = []) {
  const rows = [];
  const seen = new Set();
  for (const rawSid of sysIds || []) {
    const sysId = String(rawSid || '').toLowerCase();
    if (!sysId) continue;
    const entry = bindPlan?.ecu?.[sysId] || bindPlan?.ecu?.[rawSid];
    if (!entry) continue;
    const can = entry.can;
    const requestKeys = Array.isArray(entry.requestKey) ? entry.requestKey
      : (entry.requestKey != null ? [entry.requestKey] : []);
    // T02 四元对象：一个 can + 一组请求键（0x0030xxxx / 0xFF60xxxx 或低 16 位）。
    if (can && can.provable === 'static' && requestKeys.length) {
      const tx = Number(can.tx);
      const rx = Number(can.rx);
      if (Number.isInteger(tx) && tx > 0 && tx <= 0x7ff
          && Number.isInteger(rx) && rx > 0 && rx <= 0x7ff) {
        const blockOff = String(entry.blockOff ?? '');
        for (const rk of requestKeys) {
          const key = typeof rk === 'number' ? `0x${rk.toString(16).padStart(4, '0')}` : String(rk);
          const dedup = `${blockOff || ''}|${key}|${tx}|${rx}`;
          if (seen.has(dedup)) continue;
          seen.add(dedup);
          rows.push({
            tx, rx,
            rxRule: String(can.rxRule || ''),
            requestKey: key,
            sysId,
            name: String(entry.name || entry.sysName || ''),
            blockOff: blockOff || null,
            altIdentitySysIds: (entry.altIdentitySysIds || []).map((x) => String(x)),
            provable: 'static',
            e0Coord: String(entry.e0Coord || ''),
          });
        }
      }
      continue;
    }
    // 多块变体：entry.blocks[] / entry.addrBlocks[] 每条自带 can + requestKey。
    const blocks = Array.isArray(entry.blocks) ? entry.blocks
      : (Array.isArray(entry.addrBlocks) ? entry.addrBlocks : []);
    for (const b of blocks) {
      const bc = b.can || b;
      const bKeys = Array.isArray(b.requestKey) ? b.requestKey : [b.requestKey];
      if (bc.provable !== 'static') continue;
      const tx = Number(bc.tx);
      const rx = Number(bc.rx);
      if (!Number.isInteger(tx) || tx <= 0 || tx > 0x7ff
          || !Number.isInteger(rx) || rx <= 0 || rx > 0x7ff) continue;
      for (const rk of bKeys) {
        if (rk == null) continue;
        const blockOff = String(b.blockOff ?? entry.blockOff ?? '');
        const dedup = `${blockOff}|${String(rk)}|${tx}|${rx}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        rows.push({
          tx, rx,
          rxRule: String(bc.rxRule || ''),
          requestKey: typeof rk === 'number' ? `0x${rk.toString(16).padStart(4, '0')}` : String(rk),
          sysId,
          name: String(b.name || entry.name || ''),
          blockOff: blockOff || null,
          altIdentitySysIds: (entry.altIdentitySysIds || []).map((x) => String(x)),
          provable: 'static',
          e0Coord: String(b.e0Coord || entry.e0Coord || ''),
        });
      }
    }
  }
  // 同 blockOff 同请求键只保留首枚；blockOff 不同（Macan 双绑）必须分开。
  const byBlock = new Set();
  return rows.filter((r) => {
    const dedup = `${r.blockOff ?? ''}|${r.requestKey}`;
    if (byBlock.has(dedup)) return false;
    byBlock.add(dedup);
    return true;
  });
}

/**
 * 发现计划（sweepPlan）：按 sysId 选静态行；n==0 → 0 帧探针。
 * 保留函数名给调用方/门禁，但**不再逐地址扫描、不推导 rx**。
 *
 * @param {object} opts
 * @param {object|null} opts.bindPlan
 * @param {string[]} opts.sysIds
 * @param {number[]} [opts.skip] 跳过的 CAN tx（仅排除，不生成）
 * @returns {Array<object>} 静态候选行
 */
export function sweepPlan({ bindPlan = null, sysIds = [], skip = [] } = {}) {
  const skipSet = new Set((skip || []).map((x) => Number(x)));
  const rows = selectAddrRows(bindPlan, sysIds);
  return rows.filter((r) => !skipSet.has(r.tx));
}

/**
 * 识别串文本 → 模块名集合（E-08 / E-14：名字串，不是 sysId 数值）。
 * 传入 partNumber + partToModule 时再做件号交集（JOB.BIN memcmp 语义）。
 */
export function moduleFromIdent(text, identToVariant, partNumber = null, partToModule = null) {
  const raw = String(text || '').trim();
  if (!raw || !identToVariant) return [];
  const cands = new Set();
  const keys = [raw, raw.split(/\s+/)[0], raw.replace(/[^A-Za-z0-9]/g, '')];
  for (const k of keys) {
    if (!k) continue;
    const hit = identToVariant[k];
    if (Array.isArray(hit)) for (const h of hit) if (h && h.module) cands.add(h.module);
    else if (hit && hit.module) cands.add(hit.module);
  }
  if (partNumber && partToModule) {
    const pn = String(partNumber).trim();
    const byPart = partToModule[pn] || partToModule[pn.toUpperCase()] || [];
    const allowed = new Set((Array.isArray(byPart) ? byPart : [byPart])
      .map((x) => (typeof x === 'string' ? x : x && x.module)).filter(Boolean));
    if (allowed.size) return [...cands].filter((m) => allowed.has(m));
  }
  return [...cands];
}

/**
 * 名字串 + 件号双判据的显式身份裁决结果（不按 sysId 数值 / CAN raw 合并）。
 * 0x0f4d 与 0x0e5f raw 相同，只有名字串和件号才能分开。
 */
export function identityFromNameAndPart(text, partNumber, { identToVariant, partToModule } = {}) {
  const byName = moduleFromIdent(text, identToVariant);
  const pn = String(partNumber || '').trim();
  const byPart = pn && partToModule
    ? moduleFromIdent(pn, partToModule) : [];
  const both = byName.filter((m) => byPart.includes(m));
  if (!byName.length) return { verdict: 'unknown', modules: [], text: '' };
  if (pn && byPart.length && !both.length) {
    return { verdict: 'mismatch', modules: byName, text: String(text || '') };
  }
  const modules = byPart.length ? both : byName;
  const collision = RAW_IDENTITY_COLLISIONS.find((c) => c.entries.some((e) => modules.includes(e.name)));
  return {
    verdict: modules.length ? 'match' : 'unknown',
    modules,
    text: String(text || ''),
    partNumber: pn || null,
    rawCollision: collision ? collision.raw : null,
    note: collision ? collision.rule : null,
  };
}

/**
 * 活地址 + 识别串 → { module: {tx, rx, ident} }。
 * 只保留 menuModules 里存在的模块（避免 992/718 的同码模块串进来）。
 */
export function buildModuleMap(live, menuModules = []) {
  const allow = new Set(menuModules);
  const out = {};
  for (const l of live || []) {
    const mods = l.modules && l.modules.length ? l.modules : [];
    for (const m of mods) {
      if (allow.size && !allow.has(m)) continue;
      if (!out[m]) out[m] = { tx: l.tx, rx: l.rx, ident: l.ident || '', partNumber: l.partNumber || '' };
    }
  }
  return out;
}

/** 缓存新鲜度：同一 VIN、24h 内有效（fail-closed 的 liveMap 永不写缓存）。 */
export function cacheFresh(cache, vin, now = Date.now(), ttlMs = 24 * 3600 * 1000) {
  if (!cache || !cache.ts) return false;
  if (cache.state && cache.state !== 'bound') return false;
  if (vin && cache.vin && cache.vin !== vin) return false;
  return now - cache.ts < ttlMs;
}
