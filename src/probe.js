/**
 * 识别串原语 + 候选族生成。
 *
 * ★ 2026-11-11 原厂对齐（CODE-AUDIT §4.2 偏离⑤）：本文件原来的 `probeDecision`
 *   （「NRC 不算候选 / 识别串匹配才算候选」）是 2026-11-09 RE-ICADDR 阶段的旧模型，
 *   已被 2026-11-10 `RE-DISCOVERY-20261110 §1` 的 **DriveLinksMode_1001 @LINK:0x18f00
 *   逐指令** 推翻并删除：
 *     · 原厂发现阶段对每个候选只发 1 帧 `22 14 09`，**只看有没有回来**（含 NRC = 该地址
 *       有 ECU 应答），不看识别串；
 *     · 身份裁决在**进模块后的真实读帧**（首参数 DID/LID）+ `GetSubSysDataAddr` 名字表。
 *   现保留的 `identMatch` 只服务于「进模块后身份文本匹配」（430 原语：strcmp /
 *   前缀 memcmp≥4 / strstr≥4；来源 GetSubSysDataAddr @FILE.so:0x15c18）。
 *
 * 候选族生成（通用规则，零特判）：
 *   - 主候选 = 表行序（ecu-addresses cands，GetDriveLinksAddress 行序）；
 *   - 兜底族 = DRIVELINKS 14B 记录族（GetDriveLinksData FILE:0x18b74 mode 0x1001/0x1002
 *     循环 @0x18d9a 的记录 u16，见 export-ecu-address.py extract_families）。
 *   ⚠️ 2026-11-11：`joinState='unresolved'` 的「全库族并集」兜底已由 app.js 删除
 *     （2026-11-10 真车 IC 事故根因：扫全库族会拿车门/PDC 地址扫 32 个必然全灭）。
 *     本函数仍接受 globalFamilies 参数，但 app.js 传空数组。
 */

/** 归一化：大写 + 去非字母数字（与 autoPickVariant 同口径）。 */
export function normIdent(x) {
  return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 识别串匹配（参考诊断仪 原语组合，非自创）：
 *   ① strcmp 全等；② 前缀 memcmp（公共前缀 ≥4 归一字符）；③ strstr 包含（≥4）。
 * 短键（<4，如 "IC"）只接受全等 —— 防任意串误命中。
 * 语义要求：命中串须含目标模块语义（如 IC=Kombi/仪表 → 命中 Kombiinstrument 前缀）。
 */
export function identMatch(text, keys) {
  const N = normIdent(text);
  if (!N) return false;
  for (const k0 of keys || []) {
    const k = normIdent(k0);
    if (!k) continue;
    if (N === k) return true;
    if (k.length >= 4 && N.length >= 4) {
      let cp = 0;
      while (cp < k.length && cp < N.length && k[cp] === N[cp]) cp++;
      if (cp >= 4) return true;               // 前缀 memcmp（0x1d9808 语义）
      if (N.includes(k) || k.includes(N)) return true;   // strstr（0x1d96d4 语义）
    }
  }
  return false;
}

/**
 * 单候选探测判定（纯函数，wire 无关）。
 * @param {string} bodyHex  响应体 hex（剥 ISO-TP 后，如 '7F2212' / '621102…'）
 * @param {string} text     响应体 ASCII 可打印段
 * @param {object} opts     { label, variantNames, moduleKeys, modRecords, autoPick, otherLabels }
 * @returns {{verdict:'accept'|'nrc-reject'|'other-module'|'no-match'|'no-answer', ident?:string}}
 */
/**
 * ★ 2026-11-11 原厂对齐：`probeDecision` 已删除（2026-11-09 旧模型，零调用）。
 *   - 旧语义「NRC→nrc-reject、识别串不匹配→no-match，都不算候选」与 原厂
 *     `DriveLinksMode_1001` 的「有回来即绑定（含 NRC）」冲突；
 *   - 身份裁决位置也不同：原厂在进模块后的真实读帧，而旧模型在发现阶段。
 *   发现阶段的判定现在只有 app.js `probeAddressFor.tryAddr` 一处（回帧 ID + body）。
 *   如需按识别串拒候选（安全增强），请用 `identMatch` 显式实现，不要恢复本函数。
 */

/**
 * 候选族生成（通用，DRIVELINKS tx 表族规则，零特判）：
 *   entry.family（本模块 14B 记录族）；
 *   模块 join 有未决（joinUnresolved/joinState:unresolved，如 KWP IC 0x02F9 无精确表A 行）
 *   时再并入 globalFamilies（全库 14B 记录族并集）做运行时身份探测兜底 —— 判据=join 证据，
 *   与模块身份无关（不为 IC 或任何模块单开规则）。识别串匹配才算命中，真车自证。
 * 去重保序（record 序 = 表行序口径）。
 */
export function familyCandidates(entry, globalFamilies = []) {
  const out = [];
  const seen = new Set();
  const push = (f) => {
    const tx = typeof f.tx === 'number' ? f.tx : parseInt(f.tx, 16);
    if (!Number.isFinite(tx) || seen.has(tx)) return;
    if (tx < 0x100 || tx > 0x7FF) return;
    seen.add(tx);
    out.push({ tx, rx: (typeof f.rx === 'number' ? f.rx : parseInt(f.rx || '0', 16)) || tx + 8,
      proto: f.proto ?? null, src: 'family', recOff: f.recOff, keyD: f.keyD, tag: f.tag });
  };
  for (const f of entry?.family || []) push(f);
  const hasUnresolved = entry?.joinState === 'unresolved' || (entry?.joinUnresolved || []).length > 0;
  if (hasUnresolved) {
    for (const f of globalFamilies) push(f);
  }
  return out;
}

/**
 * 探测顺序表（app.probeAddressFor 与模拟车「族中位」目标共用，保序一致）：
 *   表行序 cands（11 位诊断段 0x700-0x7FF，变体选行收窄后的顺序传 preferTx）→ 兜底族。
 * 返回 [{tx, rx, proto, src}]。
 */
export function probeList(entry, globalFamilies = [], prefer = null) {
  const out = [];
  const seen = new Set();
  const add = (tx, rx, proto, src) => {
    if (!Number.isFinite(tx) || !Number.isFinite(rx)) return;
    // 2026-11-10：诊断段从 0x700 放宽到 0x600 —— 表 A 里真实候选有 0x6DD/0x6E7/0x758/0x7B6 等，
    //   旧的 0x700 下界会把它们静默丢掉（bind-plan 主路径不受影响，这里是兜底路径）。
    if (tx < 0x600 || tx > 0x7FF) return;        // 11 位 CAN 合法域内的诊断段
    if (rx < 0x600 || rx > 0x7FF || rx === tx) return;
    if (seen.has(tx)) return;
    seen.add(tx);
    out.push({ tx, rx, proto: proto ?? null, src });
  };
  const cands = ((entry?.cands || []).concat(entry?.candsAux || [])).slice();
  if (prefer && typeof prefer.has === 'function') {
    cands.sort((a, b) => (prefer.has(String(a.internal || '').toUpperCase()) ? 0 : 1)
      - (prefer.has(String(b.internal || '').toUpperCase()) ? 0 : 1));
  }
  for (const c of cands) {
    add(typeof c.tx === 'number' ? c.tx : parseInt(c.tx, 16),
        typeof c.rx === 'number' ? c.rx : parseInt(c.rx, 16), Number(c.proto) || null, 'table');
  }
  for (const f of familyCandidates(entry, globalFamilies)) add(f.tx, f.rx, f.proto, 'family');
  return out;
}
