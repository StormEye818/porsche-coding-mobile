/**
 * app.js — 对齐参考诊断仪 的层级交互。
 *
 * 层级（参考诊断仪真实菜单）：
 *   L0 请选择车型 → 自动搜索 / 手动选择 / 特殊功能 / 在线功能 / ADAS 校准 / 防盗功能 / 安全网关
 *   L1 车系组（9 个）
 *   L2 车型（21 个）
 *   L3 快速测试 / 系统扫描 / 系统选择
 *   L4 系统列表（带 ECU 号）
 *   L5 功能（设码 / 编程 / 特殊功能 …）
 *   L6 条目 / 子功能
 *
 * 连接与适配器通信参考同门工具；车上的读写走本项目协议层（coder.js）。
 */
import { Coder, CodingError, MissingSeedKeyError, parseResp } from './coder.js';
import { canWrite, riskLabel, extractField, decodeValue, validateParam, parseFieldInput, fieldInRange } from './schema.js';
import { makeProvider, pickVariant } from './seedkey.js';
import { autoPickVariant } from './variant.js';
import { MODULE_TO_ECUID as MODULE_TO_ECUID_MAP, SYSTEM_TO_ECUID } from './module-ecu-map.js';
import { ECU_NUM_TO_ADDR, LABEL_TO_ECU_NUM } from './ecu-num-addr.js';

// 431 探测指令（已逆，见 ECU-ADDRESSING-20261019.md §8）
// sel=blockKey → 探测命令，用响应 flags 消歧候选地址
const PROBE_CMD_BY_ECU = {
  // 已知需要探测的 ecu（431 的 1.2%）
  // 其余走默认 KWP 1A9F 识别
};
const DEFAULT_PROBE_CMD = '1A9F';
import { makeResolverProvider, SeedKeyUnresolvedError, resolveKeyByName, resolveKey } from './seedkey-resolver.js';
import { nonAsapForName, nonAsapForModule, platformForModel } from './seedkey-nonasap.js';
import { variantForName, NAME_TO_VARIANT } from './seedkey-name-map.js';
/** DRIVELINKS：ECU_ID → {variantTag, mode, LID}（原厂 权威，2026-10-17） */
let drivelinks = null;
/** ECU 寻址表（2026-10-19 RE 实证）：sysId → {tx,rx,confidence,...} */
let ecuAddrTable = undefined;

/**
 * 模块名 → DRIVELINKS 的 ECU_ID（0x0bXX）。
 *
 * ⚠️ 2026-10-18 审计：这张表**目前是空的** —— 原厂 DRIVELINKS.BIN 里只有
 *    `ECU_ID → (variantTag, mode, LID)`，没有模块名；菜单树里的 `sys.ecu` 也全是 null。
 *    所以「照抄 securityModel 的 mode 表」这条号称的正解路径现在走不通，
 *    实际全部落在按名字查 nameTable 变体的路径上。
 *    等拿到 ECU_ID 归属表（或按 variantTag 反查）后在这里补，代码路径已经通了。
 */
const MODULE_TO_ECUID = MODULE_TO_ECUID_MAP;

import { LinkDoctor, scanEcuAddresses } from './link-doctor.js';
import { parseAddrPair, overrideFor } from './addr.js';
import { parseDtcPayload } from './dtc.js';
import { MockAdapter } from './mock-adapter.js';
import { Elm327 } from './elm327.js';

/**
 * ECU 物理地址表（CAN 请求/应答 ID）。
 *
 * ⚠️ 地址是上车实测出来的，**猜不得** —— 硬编码一个地址读所有模块是读不到的（实车教训）。
 * 每条带 `state`：
 *   'measured'  实测确认
 *   'candidate' 按 OBD-II 物理寻址规律（0x7E0-0x7E7 请求 / +8 应答）推测，**未验证**
 *   'unknown'   猜不出来，必须先跑 link-doctor.js L5「地址扫描」实测再填
 *
 * ⚠️ 0x7E0-0x7E7 只有 **8 个槽位**，应答占 0x7E8-0x7EF。
 *   所以「IC(仪表) = 0x7E8」是**错的**：0x7E8 已经是 DME 的应答 ID，
 *   拿它当请求 ID 会和 DME 应答撞。仪表在保时捷上多半在 0x7E0 系之外
 *   （网关就是 0x710/0x77A，应答≠请求+8）。
 *   → 已改为 unknown，等地址扫描实测。
 *
 * 验证方法：连接自检 L5 会逐个地址发 KWP 1A 9F，有应答的就是实测值，回填到这里并标 'measured'。
 */
const ECU_ADDR = {
  'ECM/DME(发动机控制模块)': { tx: 0x7E0, rx: 0x7E8, state: 'measured', note: '实测' },
  '网关':                  { tx: 0x710, rx: 0x77A, state: 'measured', note: '实测（rx≠tx+8）' },
  // 981/718/991 的 CAN 诊断地址按 ECU 顺序：7E0 DME、7E1 PDK、7E2 PSM、
  // 7E3 Airbag、7E4 IC、7E5 AC、7E6 PASM、7E7 TPM。此前 7E2/7E4/7E5/7E6 整体错位，
  // 会把 AC 当 PASM、PSM 当 IC；2026-10-18 按 参考诊断仪 可进模块 + 该顺序修正。
  '安全气囊':               { tx: 0x7E3, rx: 0x7EB, state: 'candidate', note: '标准 7E3；可进入' },
  'SRS(安全气囊)':          { tx: 0x7E3, rx: 0x7EB, state: 'candidate', note: '标准 7E3；可进入' },
  'ESP/PSM(电控稳定系统)':   { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: '标准 7E2；可进入' },
  'PSM':                    { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: '标准 7E2；可进入' },
  'AC(空调系统)':           { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '标准 7E5；可进入' },
  '空调':                   { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '标准 7E5；可进入' },
  '空调压缩机':              { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '标准 7E5；可进入' },
  'IC(仪表)':               { tx: 0x7E4, rx: 0x7EC, state: 'candidate', note: '标准 7E4；可进入' },
  '组合仪表':               { tx: 0x7E4, rx: 0x7EC, state: 'candidate', note: '标准 7E4；可进入' },
  'EPS(电动助力转向系统)':   { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  '电动转向':               { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  '动力转向':               { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  'Tiptronic 变速器控制':    { tx: 0x7E1, rx: 0x7E9, state: 'candidate', note: '标准 7E1；可进入' },
  'TCM/PDK(自动变速箱控制模块)': { tx: 0x7E1, rx: 0x7E9, state: 'candidate', note: '标准 7E1；可进入' },
  '驻车制动器':             { tx: null, rx: null, state: 'unknown', note: '7E3 与安全气囊冲突，待 CAN 表/扫描；不能猜' },
  // 由 PORSCHE_SYS_DATA 的 CAN/internal 表得：PASM internal 0x1CB → CAN 0x7D0；
  // BCM_hinten internal 0x1C6 → 0x74F；BCM_vorne internal 0x1C7 → 0x7D1。
  '水平高度控制/PASM':      { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  'PASM（保时捷主动悬架管理系统）': { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  'PASM(水平高度控制)':     { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  'PASM':                   { tx: 0x7D0, rx: 0x7D8, state: 'candidate', note: 'PORSCHE_SYS_DATA 1CB→7D0' },
  '后端电子设备':            { tx: 0x74F, rx: 0x757, state: 'candidate', note: 'PORSCHE_SYS_DATA 1C6→74F' },
  '前端电子设备':            { tx: 0x7D1, rx: 0x7D9, state: 'candidate', note: 'PORSCHE_SYS_DATA 1C7→7D1' },
  // 'PDC' 死键已删（2026-10-19）：菜单标签是「驻车辅助系统」，同址 0x7CF/0x7D7，
  // 留着会和 measured 冲突（smoke: candidates do not clash with measured ids）。
  '驾驶员侧座椅存储器':      { tx: 0x7D9, rx: 0x7E1, state: 'candidate', note: 'CAN 表 1CF 候选 7D9' },
  '乘客侧座椅存储器':        { tx: 0x7DA, rx: 0x7E2, state: 'candidate', note: 'CAN 表 1CF 候选 7DA' },
  '前摄像头':                { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: 'CAN 表 1CE→7E2' },
  '倒车摄像头':              { tx: 0x76D, rx: 0x775, state: 'candidate', note: 'CAN 表 1D0 候选 76D' },
  '左侧前照灯':              { tx: 0x719, rx: 0x721, state: 'candidate', note: 'CAN 表 110 候选 719' },
  '右侧前照灯':              { tx: 0x71A, rx: 0x722, state: 'candidate', note: 'CAN 表 110 候选 71A' },
  '中央前照灯':              { tx: 0x719, rx: 0x721, state: 'candidate', note: 'CAN 表 110 候选 719' },

  '轮胎压力监控 （TPM）':    { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
  '轮胎压力监控':            { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
  'TPM':                    { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
  // ── 2026-10-19 审计：菜单实际标签别名（原键在菜单里不存在，成死键）──
  '驻车辅助系统':            { tx: 0x7CF, rx: 0x7D7, state: 'measured', note: 'RE 锚点 0x0B12→7CF/7D7（ECU-ADDRESSING §2）' },
  '右前照灯':                { tx: 0x71A, rx: 0x722, state: 'candidate', note: 'CAN 表 110 候选 71A' },
  'TPMS/TPM(胎压监控系统)':  { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '标准 7E7；可进入' },
};

const ADDR_OVERRIDE_KEY = 'pc_addr_overrides_v1';

function loadAddrOverrides() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(ADDR_OVERRIDE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

function addrKey(label, model = currentModel) {
  return model ? `${model}::${label}` : String(label);
}

function saveAddrOverride(label, pair, model = currentModel) {
  try {
    if (typeof localStorage === 'undefined') return false;
    const all = loadAddrOverrides();
    all[addrKey(label, model)] = { tx: pair.tx, rx: pair.rx, savedAt: new Date().toISOString() };
    localStorage.setItem(ADDR_OVERRIDE_KEY, JSON.stringify(all));
    return true;
  } catch { return false; }
}

/**
 * 从 RE 实证地址表查 sysId（2026-10-19）。
 * proven 条目直接返回 tx/rx；candidate 只返回候选提示，不瞎猜。
 */
function ecuAddrFromTable(label, sys) {
  if (!ecuAddrTable) return null;
  // ① 精确 label ② label 的模块名走 MODULE_TO_ECUID ③ sys.modules 兜底
  //   （2026-10-19 审计：只查 SYSTEM_TO_ECUID 会漏「停车辅助」→PDC、「RTM Gateway」→CAN_CAN_Gateway）
  let sysId = SYSTEM_TO_ECUID[label];
  if (!sysId && typeof MODULE_TO_ECUID !== 'undefined') sysId = MODULE_TO_ECUID[label];
  if (!sysId && sys?.modules?.length) {
    for (const m of sys.modules) {
      const k = MODULE_TO_ECUID[m];
      if (k) { sysId = k; break; }
    }
  }
  if (!sysId) return null;
  const key = sysId.toLowerCase();
  const hit = (ecuAddrTable.entries || []).find(
    (e) => e.sysId && e.sysId.toLowerCase() === key);
  if (!hit) return null;
  if (hit.confidence === 'proven' && hit.tx != null && hit.rx != null) {
    return {
      tx: parseInt(hit.tx, 16), rx: parseInt(hit.rx, 16),
      state: 'measured',
      note: `RE 锚点（${hit.source || 'ECU-ADDRESSING-20261019'}）`,
    };
  }
  if (hit.needsProbe && hit.probeCmd?.length) {
    return {
      tx: null, rx: null, state: 'needs-probe',
      note: `需探测 sysId=${hit.sysId} blockKeys=${hit.blockKeys?.join(',') || '?'}`,
      probeCmd: hit.probeCmd[0],
    };
  }
  return null;
}

/**
 * ecu 号桥接：label → ecu 号 → CAN 地址（2026-10-22，431 数据驱址）。
 * 覆盖 systemCatalog 全量 177 label / 152 ecu 号。
 * 已知地址（proven/标准 OBD/ECU_ADDR）直接返回；未知 ecu 返回 needs-probe。
 */
function ecuAddrFromNum(label, sys) {
  // 查 ecu 号：① label 精确 ② sys.modules 兜底
  let ecuNum = LABEL_TO_ECU_NUM[label];
  if (ecuNum == null && sys?.modules?.length) {
    for (const m of sys.modules) {
      const e = LABEL_TO_ECU_NUM[m];
      if (e != null) { ecuNum = e; break; }
    }
  }
  if (ecuNum == null) return null;
  // 如果 431 证据表明确说这个 sysId 没有 tx（candidateCount 0 / 非 proven），
  // 不要用 ECU_NUM 的标准 OBD 猜测覆盖它 —— 走探测。
  let sysId = SYSTEM_TO_ECUID[label];
  if (!sysId && sys?.modules?.length) {
    for (const m of sys.modules) {
      if (MODULE_TO_ECUID[m]) { sysId = MODULE_TO_ECUID[m]; break; }
    }
  }
  if (sysId && ecuAddrTable) {
    const e = (ecuAddrTable.entries || []).find((x) => x.sysId && x.sysId.toLowerCase() === sysId.toLowerCase());
    if (e && e.confidence !== 'proven' && e.tx == null) {
      return {
        tx: null, rx: null, state: 'needs-probe',
        note: `sysId=${sysId} 431 证据表无 tx，需探测`,
        probeCmd: e.probeCmd?.[0] || DEFAULT_PROBE_CMD,
        ecuNum,
      };
    }
  }
  const hit = ECU_NUM_TO_ADDR[ecuNum];
  if (hit && hit.tx && hit.rx) {
    const tx = parseInt(hit.tx, 16), rx = parseInt(hit.rx, 16);
    if (!Number.isFinite(tx) || !Number.isFinite(rx)) return null;
    // ⚠️ ECU_NUM_TO_ADDR 里多数是标准 OBD/431 候选，不是真车实测；
    //    不能统一标 measured，否则 UI 会把它当成已验证地址。
    return {
      tx, rx,
      state: 'candidate',
      note: `ecu=${ecuNum}（431 候选，未实测）`,
    };
  }
  // ecu 号已知但无地址 → 探测指令路径（431 的 1.2% 方案）
  return {
    tx: null, rx: null, state: 'needs-probe',
    note: `ecu=${ecuNum} 需探测寻址`,
    probeCmd: PROBE_CMD_BY_ECU[ecuNum] || '01 04 21 01 00 01',
    ecuNum,
  };
}

/**
 * 431 探测指令：对候选 CAN 地址逐个发识别探针，找模块地址。
 * 对齐 431 的运行时探测逻辑（ECU-ADDRESSING-20261019.md §8）。
 * 探测顺序：先试标准 OBD 范围（7E0-7E7），再试保时捷扩展范围（700-7EF）。
 * 返回 {tx, rx} 或 null。
 */
async function probeAddressFor(label, probeCmd, model) {
  if (!coder) return null;
  const probes = [];
  // 标准 OBD-II 诊断地址（DME/TCM/ABS/SRS/IC/AC/TPMS 等）
  for (let tx = 0x7E0; tx <= 0x7E7; tx++) {
    probes.push({ tx, rx: tx + 8 });
  }
  // 保时捷扩展地址（Gateway/PASM/BCM/PDC 等已知）
  for (const [tx, rx] of [[0x710,0x77A],[0x7CF,0x7D7],[0x7D0,0x7D8],[0x7D1,0x7D9],
                           [0x74F,0x757],[0x730,0x738],[0x719,0x721],[0x71A,0x722],
                           [0x76D,0x775],[0x7D9,0x7E1],[0x7DA,0x7E2],[0x7E2,0x7EA]]) {
    probes.push({ tx, rx });
  }
  showLoading(`正在探测 ${label}`, `试 ${probes.length} 个候选地址…`);
  try {
    // 候选都是 11-bit；上一个模块可能是 29-bit，先切回 ATSP6。
    await coder.elm.cmd('ATSP6', 1500).catch(() => {});
    for (const p of probes) {
      try {
        await coder.elm.cmd(`ATSH${p.tx.toString(16).toUpperCase()}`, 1500);
        await coder.elm.cmd(`ATCRA${p.rx.toString(16).toUpperCase()}`, 1500);
        // 发识别探针：KWP 1A9F（DSN）为主，UDS 22F190（VIN）为辅
        for (const cmd of (probeCmd ? [probeCmd] : ['1A9F', '22F190'])) {
          const r = (await coder.elm.cmd(cmd, 4000) || '').trim();
          const p2 = parseResp(r);
          const body = Array.from(p2.body || [])
            .map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
          // 只认正响应（5A9F/62F190）。NRC 7F 只证明「这个地址有某个模块」，
          // 不能证明它就是目标模块 —— 旧代码把 7F 当命中，会把别的 ECU
          // 的地址保存给当前系统，之后读到的全是错模块数据。
          if (body.startsWith('5A') || body.startsWith('62')) {
            log(`  探测命中 0x${p.tx.toString(16).toUpperCase()}/0x${p.rx.toString(16).toUpperCase()} (${cmd} → ${body.slice(0,16)})`, 'ok');
            return { tx: p.tx, rx: p.rx };
          }
          if (body.startsWith('7F')) {
            log(`  · 0x${p.tx.toString(16).toUpperCase()} 有模块但回 NRC（${body.slice(0,8)}），不作为目标地址`, 'info');
          }
        }
      } catch { /* 超时/无应答，继续 */ }
    }
    return null;
  } finally {
    hideLoading();
  }
}

function addrFor(label, model = currentModel, sys = null) {
  // 手工覆盖优先于内置表。
  // 2026-10-22：接入 ecu→addr 全量查表（431 数据驱址），label→ecu→CAN 三层。
  const all = loadAddrOverrides();
  const override = overrideFor(addrKey(label, model), all) || overrideFor(label, all);
  if (override) return override;
  const fromRe = ecuAddrFromTable(label, sys);
  if (fromRe && fromRe.state === 'measured') return fromRe;
  // 地址扫描回填的 ECU_ADDR（measured）优先于 431 的 needs-probe；
  // 已经扫到的实测地址不需要再探测。
  const builtin = ECU_ADDR[label];
  if (builtin && builtin.state === 'measured') return builtin;
  // 431 明确要求探测的 sysId，必须走 probe；不能被 ECU_NUM 的通用候选覆盖。
  if (fromRe && fromRe.state === 'needs-probe') return fromRe;
  // ecu 号桥接：label → ecu → CAN 地址（全量覆盖 177 label / 152 ecu）
  const ecuAddr = ecuAddrFromNum(label, sys);
  if (ecuAddr) return ecuAddr;
  return builtin || fromRe || null;
}

import { registerPlugin } from '@capacitor/core';

// 状态栏留白：WebView 里 env(safe-area-inset-top) 常为 0，
// 所以用显式 spacer + JS 量测，保证刘海/灵动岛下内容不被遮。
function fitSafeTop() {
  const el = document.getElementById('safeTop');
  if (!el) return;
  // 优先用真正的安全区；没有就按机型估（刘海 47-59px，老机型 20px）
  const sat = window.visualViewport?.offsetTop
    ?? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sat') || '0', 10);
  const isNotch = window.innerHeight / window.innerWidth > 2.0;   // 全面屏长宽比
  el.style.height = (sat > 0 ? sat : (isNotch ? 50 : 22)) + 'px';
}
fitSafeTop();
window.addEventListener('resize', fitSafeTop);
window.addEventListener('orientationchange', fitSafeTop);

// 状态栏：让 webview 避开状态栏（刘海/灵动岛下不遮内容）。
// ⚠️ 只在 capacitor.config.json 里写不够，必须运行时再设一次才生效。
const StatusBar = registerPlugin('StatusBar');
(async () => {
  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: 'DARK' });
    await StatusBar.setBackgroundColor({ color: '#0e1116' });
  } catch (e) {
    console.warn('StatusBar 配置失败', e);
  }
  fitSafeTop();
})();

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (m, cls = 'info') => {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
};

/**
 * 浮层反馈 —— 每个操作都要让用户看到结果（成功/失败/为什么）。
 * @param {'ok'|'err'|'warn'|'info'} kind
 * @param {string} title  一句话结论
 * @param {string} [detail]  原因 / 下一步
 */
function toast(kind, title, detail = '') {
  const w = $('toastWrap');
  const d = document.createElement('div');
  d.className = 'toast ' + (kind === 'info' ? '' : kind);
  d.innerHTML = `<div class="t"></div>${detail ? '<div class="d"></div>' : ''}`;
  d.querySelector('.t').textContent = title;
  if (detail) d.querySelector('.d').textContent = detail;
  w.appendChild(d);
  // 自动消失（错误多留一会）
  const ms = kind === 'err' ? 5200 : kind === 'warn' ? 4000 : 2600;
  setTimeout(() => {
    d.classList.add('out');
    setTimeout(() => d.remove(), 240);
  }, ms);
  // 同时记日志（保留可复制的完整轨迹）
  log((kind === 'ok' ? '✅ ' : kind === 'err' ? '❌ ' : kind === 'warn' ? '⚠️ ' : '') + title +
      (detail ? ` —— ${detail}` : ''), kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'info');
}

/** 未连接时的统一拦截提示 */
function needLink() {
  if (coder) return true;
  toast('err', '未连接适配器', '请先选接头类型并点「连接自检」，接上 OBD 接头后再操作');
  return false;
}

// ---------- 全屏加载遮罩（读取期间锁定操作） ----------
function showLoading(title, detail = '') {
  let el = $('loadingMask');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingMask';
    el.innerHTML = `
      <div class="lmBox">
        <div class="lmSpinner"></div>
        <div class="lmTitle"></div>
        <div class="lmDetail"></div>
      </div>`;
    document.body.appendChild(el);
  }
  el.querySelector('.lmTitle').textContent = title;
  el.querySelector('.lmDetail').textContent = detail;
  el.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function hideLoading() {
  const el = $('loadingMask');
  if (el) el.style.display = 'none';
  document.body.style.overflow = '';
}
function updateLoading(title, detail = '') {
  const el = $('loadingMask');
  if (!el) return;
  el.querySelector('.lmTitle').textContent = title;
  el.querySelector('.lmDetail').textContent = detail;
}

/** 规则编码：批量查看和修改多个设码值 */
function showRuleCoding(allItems, sysLabel) {
  // ★ 参考诊断仪的做法：先显示一级分组目录（和刷隐藏一样），点进去再批量编辑
  const groups = {};
  for (const p of allItems) {
    const g = p.path?.[0] || '（未命名）';
    (groups[g] = groups[g] || []).push(p);
  }
  const groupItems = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, items]) => ({
      kind: 'ruleGroup', raw: { name, items, sysLabel },
      lbl: name, meta: `${items.length} 个参数`, cnt: items.length,
    }));
  stack.push({ level: 'ruleGroupList', title: `规则编码 · ${sysLabel}`, data: { items: groupItems, allItems, sysLabel } });
  renderNav();
}

function showRuleGroup(g) {
  // ★ 参考诊断仪的做法：有 L3 子组就先显示子组列表，没有才直接显示条目
  const hasSubgroups = g.items.some((p) => (p.path?.length || 0) >= 3);
  if (hasSubgroups) {
    // 按 L3 子分组
    const subgroups = {};
    for (const p of g.items) {
      const sg = (p.path?.length >= 3) ? p.path[1] : '（直接条目）';
      (subgroups[sg] = subgroups[sg] || []).push(p);
    }
    const sgItems = Object.entries(subgroups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, items]) => ({
        kind: 'ruleSubgroup', raw: { name, items, parentGroup: g.name },
        lbl: name, meta: `${items.length} 个参数`, cnt: items.length,
      }));
    stack.push({ level: 'ruleSubgroupList', title: g.name, data: { items: sgItems, allItems: g.items, sysLabel: g.sysLabel } });
    renderNav();
    return;
  }
  // 无子组 → 直接批量编辑
  showRuleBatchEdit(g.name, g.items);
}

function showRuleSubgroup(sg) {
  // 显示 L3 子组的批量编辑
  showRuleBatchEdit(`${sg.parentGroup} > ${sg.name}`, sg.items);
}

function showRuleBatchEdit(title, items) {
  const rows = items.map((p) => {
    const curVal = p.currentValue !== undefined ? decodeValue(p, p.currentValue) : '?';
    const en = p.enum ? Object.entries(p.enum)
      : (p.kind === 'switch' ? [[0, '关'], [1, '开']] : []);
    let inputHtml;
    if (p.kind === 'switch' || p.kind === 'enum') {
      // ⚠️ enum key 是**十进制**字符串（"0".."255"/"16777215"），不是十六进制！
      // 曾用 parseInt(k,16)：`"255"→597`、`"10"→16`，3802 条枚举里 4194 个 key≥10 全写错值。
      inputHtml = `<select class="ruleVal" data-id="${p.id}" data-touched="0" onchange="this.dataset.touched='1'">${en.map(([k, v]) =>
        `<option value="${Number(k)}" ${Number(k) === p.currentValue ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    } else {
      const wide = (p.bitsize | 0) > 53;
      inputHtml = `<input class="ruleVal" data-id="${p.id}" data-touched="0" oninput="this.dataset.touched='1'" type="${wide ? 'text' : 'number'}" inputmode="numeric" value="${p.currentValue ?? 0}" min="${p.min ?? 0}" max="${p.max ?? ''}" style="width:${wide ? 150 : 70}px">`;
    }
    // 显示完整路径（含 L3 上下文）
    const pathStr = (p.path || []).slice(1).join(' › ');
    return `<div class="ruleRow">
      <div class="ruleName">${p.name}<br><small>${pathStr} · byte ${p.byte} bit ${p.bit} · 当前: ${curVal}</small></div>
      <div class="ruleInput">${inputHtml}</div>
    </div>`;
  }).join('');

  $('navList').innerHTML = `
    <div class="ruleCoding">
      <div class="hint">${title}：修改后点「批量写入」一次性写入。</div>
      <div class="ruleGroup">
        ${rows}
      </div>
      <div class="acts" style="margin-top:16px">
        <button id="ruleBatchWrite" class="primary">批量写入</button>
      </div>
    </div>`;

  $('ruleBatchWrite').onclick = async () => {
    const changes = [];
    const rejected = [];
    $('navList').querySelectorAll('.ruleVal').forEach((el) => {
      const p = items.find((x) => x.id === el.dataset.id);
      if (!p) return;
      const newVal = parseFieldInput(p, el.value);
      if (newVal == null) { rejected.push(`${p.name}: 值无效（${el.value}）`); return; }
      // ⚠️ 当前值未读到时不能一律跳过（2026-10-18 审计）：此前 `currentValue===undefined`
      //    直接 return，用户明明改了值也不会进 changes，批量写入静默少项。
      //    现在只有「用户真的动过」才纳入；未动过仍跳过，避免把第一项当目标值写进去。
      if (p.currentValue === undefined) {
        if (el.dataset.touched !== '1') return;
      } else if (newVal === p.currentValue) {
        return;
      }
      // ⚠️ 批量写入必须与单项写入**同一套闸门**：
      //   ① canWrite（只读项 / 无 LID / 严格门禁开关）
      //   ② min/max 范围 —— 此前批量路径不查，injectField 对越界值
      //      `& mask` 静默截断后照写（2026-10-16 复查 P11）
      if (!canWrite(p)) { rejected.push(`${p.name}: 不可写（只读/无 LID/门禁）`); return; }
      if (!fieldInRange(p, newVal)) {
        rejected.push(`${p.name}: ${newVal} 超出范围 ${p.min ?? 0}…${p.max ?? '?'}`);
        return;
      }
      changes.push({ p, newVal });
    });
    if (rejected.length) {
      alert(`有 ${rejected.length} 项未通过校验，已跳过：\n\n${rejected.slice(0, 10).join('\n')}`);
    }
    if (!changes.length) {
      toast('info', '没有可写入的变更', rejected.length ? '全部被校验拦下' : '所有值与当前值一致');
      return;
    }
    const okBatch = confirm(`确认批量写入 ${changes.length} 个变更？\n\n`
      + changes.slice(0, 8).map((c) => `· ${c.p.name} = ${decodeValue(c.p, c.newVal)}`).join('\n')
      + (changes.length > 8 ? `\n…等 ${changes.length} 项` : '')
      + '\n\n会改变车辆配置，请确认已导出备份。');
    if (!okBatch) return;
    showLoading('批量写入中…', `${changes.length} 个变更`);
    let ok = 0, fail = 0;
    const failWhy = [];
    for (const { p, newVal } of changes) {
      try {
        await coder.applyChange(p, newVal, { dryRun: false, session: 0x89, secLevel: 0x09 });
        p.currentValue = newVal;
        if (p.lid != null) delete currentBlocks[p.lid];   // 块缓存失效
        ok++;
      } catch (e) {
        fail++;
        // ⚠️ 失败原因必须留下来（2026-10-18 审计）：此前 `catch {}` 空吞，
        //    用户只看到「成功 3 / 失败 2」，不知道哪一项为什么失败、要不要重试。
        failWhy.push(`${p.name}：${e.message}`);
        log(`  ❌ ${p.name} 写入失败：${e.message}`, 'err');
      }
    }
    hideLoading();
    if (fail) alert(`批量写入：成功 ${ok} / 失败 ${fail}\n\n${failWhy.slice(0, 12).join('\n\n')}`);
    // ⚠️ 批量写入本身与「每次只改一项」的项目红线有张力：失败项之后的项会继续写，
    //    且中途失败时车上是**部分变更**状态。保留功能但明确告知（2026-10-18 审计）。
    toast(fail ? 'warn' : 'ok', '批量写入完成', `成功 ${ok} / 失败 ${fail}`);
    showRuleBatchEdit(title, items); // 刷新显示新值
  };
}

/** 备份所有编码 */
async function backupAllCoding(allItems, sysLabel) {
  // ⚠️ lid=0 是**合法 LID**（6383 条里有 1088 条 lid=0，22↔2E 且 sidPairOk），
  //    不能用 filter(Boolean) —— 那会把这些块全丢掉不备份。
  //    （若将来确认 0 是提取缺省值，应在数据侧标 writeBlockedReason，而不是在这里过滤。）
  const lids = [...new Set(allItems.map((p) => p.lid).filter((v) => v != null))];
  if (!lids.length) {
    toast('warn', '无可备份数据', '该模块无编码块');
    return;
  }
  showLoading('正在备份编码', `0 / ${lids.length} 个块`);
  const backup = { sysLabel, timestamp: new Date().toISOString(), blocks: {} };
  for (let i = 0; i < lids.length; i++) {
    const lid = lids[i];
    try {
      const sample = allItems.find((p) => p.lid === lid);
      const readSid = sample?.readSid ?? 0x21;
      const blk = await coder.readBlock(lid, readSid);
      // 同时记下读写 SID —— 恢复时按备份原样写回，不猜 SID
      backup.blocks[lid] = {
        bytes: Array.from(blk),
        readSid,
        writeSid: sample?.writeSid ?? (readSid === 0x22 ? 0x2E : 0x3B),
        session: 0x89,
      };
    } catch (e) {
      // ⚠️ 备份失败必须记账（2026-10-17 审计）：静默跳过会让用户以为备份完整，
      //    写坏后恢复才发现缺块。备份不全 → **拒绝让用户以为可以安全写入**。
      (backup.failed = backup.failed || []).push({ lid, error: e.message });
    }
    updateLoading('正在备份编码', `${i + 1} / ${lids.length} 个块`);
  }
  if (backup.failed && backup.failed.length) {
    toast('warn', '⚠️ 备份不完整',
      `${backup.failed.length} 个块备份失败：${backup.failed.slice(0, 3).map((f) => 'LID ' + f.lid).join('、')}`
      + ' —— 写入前请确认这些块已另有备份，否则写坏无法恢复。');
  }
  // 保存到本地
  const key = `pc_backup_${sysLabel}_${Date.now()}`;
  try {
    localStorage.setItem(key, JSON.stringify(backup));
  } catch (e) {
    hideLoading();
    toast('err', '备份写入本地存储失败', `${e.message} —— 请改用「分享/导出」保存这次备份，别直接写入。`);
    return;
  }
  hideLoading();
  toast('ok', '备份完成', `${Object.keys(backup.blocks).length} 个块已保存`);
}

/** 恢复编码 */
async function restoreCoding(sysLabel) {
  // 查找备份
  const backups = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('pc_backup_')) {
      try {
        const b = JSON.parse(localStorage.getItem(k));
        backups.push({ key: k, ...b });
      } catch {}
    }
  }
  if (!backups.length) {
    toast('warn', '无备份', '请先使用「备份所有编码」');
    return;
  }
  // 显示备份列表
  const html = backups.map((b, i) => `
    <div class="item" onclick="window._restoreBackup(${i})">
      <div class="lbl">${b.sysLabel}</div>
      <div class="meta">${new Date(b.timestamp).toLocaleString()} · ${Object.keys(b.blocks).length} 个块</div>
    </div>`).join('');
  $('navList').innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader"><div class="pdName">选择备份恢复</div></div>
      ${html}
    </div>`;
  window._restoreBackup = async (idx) => {
    if (!needLink()) return;
    const b = backups[idx];
    const entries = Object.entries(b.blocks);
    showLoading('恢复编码中…', `0 / ${entries.length} 个块`);
    let ok = 0, fail = 0;
    const failed = [];
    for (const [lid, rec] of entries) {
      // 兼容旧格式：旧备份 blocks[lid] 直接是字节数组
      const bytes = Array.isArray(rec) ? rec : rec?.bytes;
      const readSid = (Array.isArray(rec) ? 0x21 : rec?.readSid) ?? 0x21;
      const writeSid = (Array.isArray(rec) ? 0x3B : rec?.writeSid) ?? (readSid === 0x22 ? 0x2E : 0x3B);
      // 旧备份没有 session 字段；新备份写入 0x89（与 applyChange 默认一致）
      const session = (Array.isArray(rec) ? 0x89 : rec?.session) ?? 0x89;
      try {
        if (!bytes || !bytes.length) throw new Error('备份块为空');
        // ⚠️ 恢复必须**整块原样写回**，不要走 applyChange 的字段路径 ——
        //    那条路径需要 byte/bit/bitsize，备份里没有，必然抛"参数超出编码块长度"。
        //    此前就是这样把备份写废的（2026-10-16 复查 P3）。
        const hex = bytes.map((x) => x.toString(16).padStart(2, '0')).join('');
        const idHex = Number(lid).toString(16).toUpperCase().padStart(writeSid === 0x2E ? 4 : 2, '0');
        await coder.enterSession(session);
        // ⚠️ 不能吞解锁失败（审计 D6）：算法缺失/NRC 都必须中止，不能照写。
        //    ⚠️ 2026-10-18 审计：这里原来引用了不存在的 `bk.writeSid`（ReferenceError），
        //    导致「读取备份编码 → 恢复」**每一块都必然失败**。用本块的 writeSid 判 KWP。
        await coder.securityAccess(0x09, writeSid !== 0x2E);
        await coder.uds(`${writeSid.toString(16).toUpperCase().padStart(2, '0')}${idHex}${hex}`, 8000);
        // 回读校验
        const back = await coder.readBlock(Number(lid), readSid);
        const same = back.length === bytes.length && back.every((x, i) => x === bytes[i]);
        if (!same) throw new Error('回读与备份不一致');
        ok++;
      } catch (e) {
        fail++;
        failed.push(`LID ${lid}: ${e.message}`);
      }
      updateLoading('恢复编码中…', `${ok + fail} / ${entries.length} 个块`);
    }
    hideLoading();
    if (failed.length) log('恢复失败明细：\n' + failed.slice(0, 8).join('\n'), 'err');
    toast(fail ? 'warn' : 'ok', '恢复完成', `成功 ${ok} / 失败 ${fail}`);
  };
}

/** 懒加载：按需读取指定条目所需的编码块，并提取当前值 */
async function readBlocksForItems(items) {
  const needLids = new Set();
  for (const p of items) {
    if (p.lid != null && !currentBlocks[p.lid]) needLids.add(p.lid);
  }
  if (!needLids.size) return;
  showLoading('正在读取数据', `${needLids.size} 个编码块`);
  const failed = [];
  for (const lid of needLids) {
    const sample = items.find((p) => p.lid === lid);
    try {
      currentBlocks[lid] = await coder.readBlock(lid, sample?.readSid ?? 0x21);
    } catch (e) {
      // ⚠️ 不能静默吞（2026-10-18 审计）：读失败会让当前值显示成「?」，
      //    用户会以为只是没读到；批量写入时又会在 applyChange 里重新读一次，
      //    真正失败时错误更晚、更难归因。这里至少把失败块记下来并提示。
      failed.push({ lid, error: e.message });
    }
    updateLoading('正在读取数据', `LID 0x${lid.toString(16)}`);
  }
  for (const p of items) {
    const block = currentBlocks[p.lid];
    if (block) {
      try { p.currentValue = extractField(block, p); } catch { p.currentValue = undefined; }
    }
  }
  hideLoading();
  if (failed.length) {
    toast('warn', `${failed.length}/${needLids.size} 个编码块读取失败`,
      failed.slice(0, 3).map((f) => `LID 0x${f.lid.toString(16)}: ${f.error}`).join('；'));
  }
}

// ---------- 状态 ----------
let doctor = null, elm = null, coder = null;
let tree = null;          // menu-tree-v3.json
let coding = [];          // coding-v2.json params
let stack = [];           // 导航栈 [{level, title, data}]
let currentParam = null;
let simMode = false;
let modelsCatalog = null;
let currentModel = null;
const loadedVariants = new Map();   // 缓存已加载的变体
// ⚠️ 2026-10-17 修：`state` 在 4 处被用（multiVariantModules / selectedVariant）
//    但**从未定义** → 进模块必炸 `Can't find variable: state`。
//    补在这里，别再散着用。
const state = {
  multiVariantModules: new Set(),
  selectedVariant: {},        // { [module]: 变体名 }
  currentAddr: null,          // 当前进入模块的地址证据（measured/probed/manual/candidate）
};

// ---------- ① 连接 ----------
$('btnDoctor').onclick = async () => {
  $('btnDoctor').disabled = true;
  // ⚠️ 自检期间屏蔽其它操作（2026-10-22）：此前用户在自检中点「自动搜索」，
  //    coder 还没建（doctor.run() 才返回），误报「未连接适配器」——
  //    日志里「自动搜索」夹在 L3✅ 和 L4❌ 中间就是这个时序。
  $('btnDisc').disabled = true;
  $('btnScan').disabled = true;
  toast('info', '开始连接自检', '配件发现 → 会话 → 协议锁定 → 模块探测');
  try {
    // ⚠️ 重连前必须先关掉上一个 EA 会话 —— 否则 EASession 创建失败（僵尸会话）。
    //    实车日志：第一次能开、第二次必失败。此前每次点都 new LinkDoctor() 而不 close。
    if (doctor) {
      try { await doctor.close(); } catch (e) { /* 忽略 */ }
      doctor = null;
    }
    if (elm && typeof elm.close === 'function') {
      try { await elm.close(); } catch (e) { /* 忽略 */ }
      elm = null;
    }
    coder = null;
    simMode = false;
    await new Promise((r) => setTimeout(r, 400));   // 给 EA 栈一点释放时间
    doctor = new LinkDoctor();
    doctor.onStep = (s) => {
      log(`${s.ok ? '✅' : '❌'} ${s.title}: ${s.detail || ''}`, s.ok ? 'ok' : 'err');
      if (!s.ok) toast('err', `${s.title} 失败`, s.detail || s.fix || '');
    };
    const r = await doctor.run();
    // ⚠️ 从模拟模式切到真车时必须清 simMode（2026-10-18 审计）：
    //    否则 enterSystem 仍走「模拟地址 0x7E0」，所有模块都被当成 DME。
    simMode = false;
    elm = doctor.elm;
    if (elm) {
      coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: 'DME' });
      coder.onProgress = (m) => log(m, 'info');
      // 按 ECU 家族选 seed/key 变体 —— 不认识就拒绝写入，不盲用默认
      // （用错变体 = 算错 key = NRC 0x35 → 重试 → 0x36 锁死）
      const _vk = pickVariant('DME');
      coder.seedKeyProvider = _vk ? makeProvider(_vk) : null;
      if (_vk) log(`seed/key 变体：${_vk.variant}/${_vk.algo}（seed ${_vk.seedBytes}B）`, 'info');
      else log('该 ECU 家族无已确认的 seed/key 变体 —— 只读可用，写入会被拒绝', 'warn');
    }
    $('linkBadge').textContent = r.fail === 0 ? '已连接' : `${r.fail} 层失败`;
    $('linkBadge').className = 'badge ' + (r.fail === 0 ? 'ok' : 'warn');
    $('btnDisc').disabled = false;
    $('btnScan').disabled = false;
    if (r.fail === 0) {
      toast('ok', '连接就绪', '可以选模块读写了');
    } else {
      toast('warn', `连接完成，但 ${r.fail} 层失败`,
        '看下方日志逐层排查；协议锁定失败就无法读写');
    }
  } catch (e) {
    toast('err', '自检异常', e.message);
  }
  $('btnDoctor').disabled = false;
  if (coder) { $('btnDisc').disabled = false; $('btnScan').disabled = false; }
};

// 地址扫描：实测车上哪些 ECU 有应答（比查表猜靠谱）
$('btnScan').onclick = async () => {
  if (!needLink()) return;
  toast('info', 'ECU 地址扫描中', '逐个试 0x700–0x7F0；真车无应答多，需数分钟，请勿断开');
  $('btnScan').disabled = true;
  try {
    const found = await scanEcuAddresses(elm, (m) => log(m, 'info'));
    if (found.length) {
      // ⚠️ 扫到就回填 ECU_ADDR 并标 measured（审计 A2）—— 否则扫了也用不上
      for (const f of found) {
        // 一个 tx 可能对应多个候选名字（如 PSM/前摄像头都曾是 7E2）；
        // 扫描只能证明「这个地址活着」，不能证明它属于哪一个名字。
        // 只有唯一候选才回填 measured，否则保持 candidate，避免把错模块标成实测。
        const matches = Object.entries(ECU_ADDR)
          .filter(([, v]) => v.state === 'candidate' && v.tx === f.tx);
        if (matches.length === 1) {
          const [k, v] = matches[0];
          v.rx = f.rx; v.state = 'measured';
          v.note = `地址扫描实测 ${new Date().toISOString().slice(0, 10)}`;
          // 持久化：否则重启 app 后扫描结果丢失（旧实现只改内存常量）。
          saveAddrOverride(k, { tx: f.tx, rx: f.rx }, currentModel);
          log(`  ✅ ${k} 地址实测确认 0x${f.tx.toString(16).toUpperCase()}/0x${f.rx.toString(16).toUpperCase()}`, 'ok');
        } else if (matches.length > 1) {
          log(`  ⚠️ 0x${f.tx.toString(16).toUpperCase()} 命中多个候选（${matches.map(([k]) => k).join('/')}），不自动归属`, 'warn');
        }
        // 未知模块也记下来（供后续人工命名）
        ECU_ADDR[`扫描到 0x${f.tx.toString(16).toUpperCase()}`] =
          { tx: f.tx, rx: f.rx, state: 'measured', note: '地址扫描发现，未命名' };
      }
      const s = found.map((f) => `0x${f.tx.toString(16).toUpperCase()}/0x${f.rx.toString(16).toUpperCase()}`).join(' ');
      toast('ok', `发现 ${found.length} 个 ECU`, s + '（进模块时可手工输入并保存地址）');
    } else {
      toast('err', '没扫到任何 ECU', '确认点火 ON、电压 >12V、CAN 线已接');
    }
  } catch (e) {
    toast('err', '扫描失败', e.message);
  }
  $('btnScan').disabled = false;
};

// 模拟模式：没接头也能完整体验（读写走模拟车，不碰真车）
$('btnSim').onclick = async () => {
  if (coder && simMode) {
    // 已在模拟 → 退出
    doctor = elm = coder = null; simMode = false;
    $('linkBadge').textContent = '未连接';
    $('linkBadge').className = 'badge';
    $('btnDisc').disabled = true; $('btnScan').disabled = true;
    $('btnSim').textContent = '模拟模式';
    $('btnSim').classList.remove('primary');
    toast('info', '已退出模拟模式', '接上 vLinker 后点「连接自检」用真车');
    return;
  }
  // ⚠️ 真车 → 模拟 前必须释放真实 EA 会话（2026-10-18 审计）：
  //    此前直接覆盖 elm/coder，真实串口一直挂着，下一次连接会创建失败（僵尸会话）。
  if (doctor) { try { await doctor.close(); } catch {} doctor = null; }
  if (elm && typeof elm.close === 'function') { try { await elm.close(); } catch {} }
  elm = null; coder = null;
  const mock = new MockAdapter({ latencyMs: 30 });
  elm = new Elm327(mock, { timeoutMs: 2000 });   // ← MockAdapter 是 PortLike，包进 Elm327
  simMode = true;
  coder = new Coder(elm, { tx: 0x7E0, rx: 0x7E8, ecuName: '模拟ECU' });
  coder.onProgress = (m) => log(m, 'info');
  // 模拟模式固定用已确认变体（保证离线回归可跑）；真车按 ECU 家族选
  coder.seedKeyProvider = makeProvider({ variant: '9x7GW', algo: 'A' });
  $('linkBadge').textContent = '模拟中';
  $('linkBadge').className = 'badge warn';
  $('btnDisc').disabled = false; $('btnScan').disabled = true;
  $('btnSim').textContent = '退出模拟';
  $('btnSim').classList.add('primary');
  toast('ok', '模拟模式已开启', '所有车型/功能都能点，读写走模拟车 —— 不碰真车');
};

// 返回上一级（二级菜单也能退出来）
$('btnBack').onclick = () => goBack();

$('btnDisc').onclick = async () => {
  if (doctor) { try { await doctor.close(); } catch {} }
  if (elm && typeof elm.close === 'function') { try { await elm.close(); } catch {} }
  doctor = elm = coder = null;
  simMode = false;
  $('linkBadge').textContent = '未连接';
  $('linkBadge').className = 'badge';
  $('btnDisc').disabled = true;
  $('btnSim').textContent = '模拟模式';
  $('btnSim').classList.remove('primary');
  log('已断开', 'info');
};

/**
 * VIN 校验 —— ISO 3779 / NHTSA：17 位，字母数字，**排除 I、O、Q**。
 * 不校验就读会把二进制垃圾当 VIN，进而猜错车型、按错车型读编码。
 */
function isValidVin(v) {
  return typeof v === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
}

/**
 * VIN 第 10 位（下标 9）= 年款码，30 年一循环。
 * 这是**消歧用的**，不是摆设 —— 例如 970/971、958/9YA 的分界就靠年款。
 *
 * ⚠️ 字母表顺序：**数字在前**（1..9 = 2001..2009），再 A..Y（2010..2030，跳过 I/O/Q/U/Z）。
 *    2026-10-15 前写反成「字母在前数字在后」，年款整体偏 9 年。
 */
function decodeVinYear(vin) {
  const c = (vin[9] || '').toUpperCase();
  if (!c) return null;
  const alpha = '123456789ABCDEFGHJKLMNPRSTVWXY';
  const i = alpha.indexOf(c);
  if (i < 0) return null;
  return i < 9 ? 2001 + i : 2010 + (i - 9);
}

// ---------- 自动搜索（读 VIN 判车型年款）----------
async function autoSearch() {
  log('—— 自动搜索：读 VIN ——', 'info');
  if (!coder) {
    toast('err', '未连接适配器', '请先点「连接自检」，接上 vLinker 后再自动搜索');
    return;
  }
  try {
    // ⚠️ 会话顺序对齐参考诊断仪：10 03 → 3E → 1A 9F → **读识别/VIN** → 才 10 89。
    // 此前一上来就 enterSession(0x89) 再用 22 F190 读 VIN —— VIN 在保时捷专用
    // 会话下可能读不到，且识别应走 KWP 1A 9F 不是 UDS 22。
    await coder.address();
    // ⚠️ 分级容错（2026-10-17 实车）：DME 对 `10 03` 回 `7F 10 12`，
    //    旧实现直接抛错退出，后面 1A 9F / 读 VIN 全没跑。
    try { await coder.uds('1003', 4000); }                            // ① 尽力而为
    catch (e) { log(`  (10 03 未支持：${e.message} —— 继续)`, 'warn'); }
    await coder.uds('3E00', 2000, { allowEmpty: true }).catch(() => {}); // ② 保活
    let ident = null;
    try { ident = await coder.uds('1A9F', 3000, { allowEmpty: true }); } catch { /* 不致命 */ }
    if (ident?.body?.length) {
      log(`  识别 1A 9F = ${ident.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`, 'info');
    }

    // ③ 读 VIN —— **双途径**（GAG 实测 22 与 1A 都在用）：UDS 22 F190 → 兜底 KWP 1A xx
    let blk = await coder.readBlock(0xF190, 0x22).catch(() => null);
    let vin = '';
    if (blk && blk.length >= 17) {
      // ⚠️ 剥掉尾部 NUL/空格填充（审计 B4）：trim() 不去 \0，会把合法 VIN 判非法
      vin = String.fromCharCode(...blk.slice(0, 17)).replace(/[\u0000\u0020]+$/g, '').trim();
    }
    if (!isValidVin(vin)) {
      // ⚠️ 兜底走 KWP 1A（审计 B3）：1A 9F 常返回 **11 位 VIN 前缀**（WP0ZZZ991GS），
      //    不是完整 17 位 —— 此前要求 17 位，兜底永不命中。
      //    现在接受 11 位前缀，再接 1A 87 序列号拼完整 VIN；拼不出就用前缀+提示手动选。
      for (const kid of ['90', '9F', '97', '87', '91', '88']) {
        try {
          const r = await coder.uds('1A' + kid, 3000, { allowEmpty: true });
          const b = Array.from(r.body || []);
          const payload = b[0] === 0x5a ? b.slice(2) : b;
          const txt = payload.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('')
            .replace(/[\u0000\u0020]+$/g, '').trim();
          log(`  1A ${kid} = "${txt}"（${txt.length} 字符）`, 'info');
          // 零件号（9 开头 11 位数字串）不当 VIN
          if (/^9[0-9]{10}$/.test(txt)) { log(`  1A ${kid} 是零件号，跳过`, 'info'); continue; }
          if (/^[A-HJ-NPR-Z0-9]{11,17}$/.test(txt)) {
            if (txt.length === 17) {
              vin = txt; log(`  从 1A ${kid} 得到完整 VIN`, 'ok'); break;
            }
            if (!vin) {
              vin = txt;
              log(`  从 1A ${kid} 得到 VIN 前缀 ${txt}（${txt.length} 位，缺尾段）`, 'warn');
            }
          }
        } catch (e) { /* 继续下一个 */ }
      }
    }
    // ⚠️ 2026-10-18 审计：KWP `1A 9F` 在 981 上常只返回 **11 位 VIN 前缀**
    //    （WP0ZZZ991GS）。原实现先接受前缀、随后又用 isValidVin(17 位) 把它判死，
    //    等于自动搜索在 KWP 模块上从未成功过。现在允许「合法前缀」参与车型识别，
    //    但绝不伪造完整 VIN：界面上明确标为前缀。
    let vinPrefix = false;
    if (!vin) {
      toast('warn', '读不到 VIN', '可能地址不对或 ECU 未响应 —— 请用手动选择车型');
      return;
    }
    if (!isValidVin(vin)) {
      if (vin.length >= 11 && vin.length <= 17
          && /^WP[01][A-HJ-NPR-Z0-9]{8,14}$/.test(vin)) {
        vinPrefix = true;
        log(`  VIN 前缀 ${vin}（${vin.length} 位）—— 按前缀识别车型，不伪造完整 VIN`, 'warn');
      } else {
        // 二进制垃圾被当 VIN 读出来了 —— 拒绝，别据此猜车型
        log(`  VIN 格式非法（含 I/O/Q 或非字母数字）：${JSON.stringify(vin)}`, 'err');
        toast('warn', 'VIN 格式非法', `读到 ${JSON.stringify(vin)}，不是 17 位 ISO 3779 VIN。请手动选择车型。`);
        return;
      }
    }
    toast('info', `${vinPrefix ? 'VIN 前缀' : 'VIN'} = ${vin}`,
      vinPrefix ? 'KWP 1A 常只给 11 位前缀，正在按前缀匹配车型 …' : '正在匹配车型年款 …');

    const yearCode = vin[9];
    const year = decodeVinYear(vin);
    const modelGuess = guessModelFromVin(vin, year);
    log(`  ${vinPrefix ? 'VIN 前缀' : 'VIN'}=${vin} · 年款码=${yearCode} → ${year ?? '?'} 年款 · 车型判断：${modelGuess ? modelGuess.label : '未识别'}`,
      modelGuess ? 'ok' : 'info');
    if (modelGuess) {
      const ok = confirm(`识别为：${modelGuess.label}\n`
        + `${vinPrefix ? 'VIN 前缀' : 'VIN'}：${vin}\n年款码：${yearCode}（${year ?? '未知'} 年款）\n\n确认这个车型？`);
      if (ok) { pushModel(modelGuess); toast('ok', `已选 ${modelGuess.label}`, `${year ?? '?'} 年款`); return; }
    }
    toast('info', '未自动识别出车型', '请手动选择');
  } catch (e) {
    toast('err', '自动搜索失败', e.message);
  }
}

/**
 * 由 VIN 车型码 + 年款推车型。
 *
 * ⚠️ **车型码在 VIN 第 7–9 位（`substring(6, 9)`）**，不是 4–6 位！
 *    保时捷 VIN 形如 `WP0 ZZZ **970** GL 000001`：
 *      1-3  WMI（WP0 / WP1）
 *      4-6  通常是 `ZZZ` 占位，**不是车型码**
 *      7-9  车型码（970 / 991 / 9YA / 95B …）
 *      10   年款码
 *    2026-10-15 前读 4–6 位，拿到的永远是 `ZZZ` —— 自动搜索从未匹配上过。
 *
 * ⚠️ 必须**精确匹配**车型码，不要用 includes —— 否则 `99` 这类短码会误匹配一片。
 * ⚠️ 年款参与消歧：同码不同代（970/971、958/9YA）靠 yearFrom/yearTo 收窄。
 */
function guessModelFromVin(vin, year) {
  const code = (vin.substring(6, 9) || '').toUpperCase();
  // yearFrom/yearTo = 该车型码的有效年款区间（null = 不限）
  const table = [
    { code: '981', label: 'Boxster（981）' },
    { code: '982', label: 'Boxster（982）' },
    { code: '987', label: 'Boxster（987）' },
    { code: '986', label: 'Boxster（986）' },
    { code: '98B', label: 'Cayman（981）' },
    { code: '98C', label: 'Cayman（982）' },
    { code: '98D', label: 'Cayman（987）' },
    { code: '991', label: '911（991）' },
    { code: '992', label: '911（992）' },
    { code: '997', label: '911（997）' },
    { code: '996', label: '911（996）' },
    { code: '970', label: 'Panamera-970（至2016年款止）', yearFrom: null, yearTo: 2016 },
    { code: '971', label: 'Panamera-971（2017-2024）', yearFrom: 2017, yearTo: 2024 },
    { code: '958', label: 'Cayenne-92A（2011 - 2017）', yearFrom: 2011, yearTo: 2017 },
    { code: '9YA', label: 'Cayenne-9YA（自2018年款起）', yearFrom: 2018, yearTo: null },
    { code: '95B', label: 'Macan' },
    { code: '918', label: '918 Spyder' },
    { code: '980', label: 'Carrera GT' },
    { code: 'J1', label: 'Taycan', codeLen: 2 },   // 2 位车型码（占第 7-8 位）
  ];
  // ① 精确匹配车型码（先 3 位，再允许条目自带更短的 codeLen）
  let hit = table.find((t) => (t.codeLen || 3) === 3 && t.code === code)
    || table.find((t) => (t.codeLen || 3) < 3 && code.startsWith(t.code))
    || tree?.allModels?.find((m) => (m.vinCode || '').toUpperCase() === code);
  // ② 年款收窄：命中多条或带年款区间时校验
  if (hit && year != null && hit.yearFrom != null && (year < hit.yearFrom)) hit = null;
  if (hit && year != null && hit.yearTo != null && (year > hit.yearTo)) hit = null;
  return hit || null;
}

// ---------- 导航栈 ----------
/**
 * 版本信息（读 ECU 识别）—— 对应每个模块的「读版本信息」。
 *
 * 数据源 data/identity.json：KWP `1A xx` 识别项 + ASAM ODX 标识链，已按模块/变体归属。
 * 标签映射（实测：命令 ID+4 = 显示标签）：
 *   1A 9F ECU 识别 · 1A 87 ECU 序列号 · 1A 84 ECU 零件号 · 1A 91 零件图号
 *   1A 92 硬件号 · 1A 93 硬件版本 · 1A 94 软件号 · 1A 95 软件版本
 *   1A 96 认证号 · 1A 97 ECU ISO 码 · 1A 9A 系统供应商标识
 *
 * ⚠️ 全部**只读**，不做任何写入。
 */
async function renderIdentity(sys) {
  const box = $('paramBox');
  showLoading('正在读取版本信息…', sys.label || '');
  let ident = null;
  try {
    ident = await fetch('data/identity.json').then((r) => (r.ok ? r.json() : null));
  } catch (e) { /* ignore */ }
  hideLoading();
  if (!ident) {
    box.innerHTML = '<div class="hint">版本信息数据缺失（data/identity.json）</div>';
    return;
  }
  // 按模块名归属（identity.json 的 module 是内部名，如 DME_BDE_Continental / _9x7_kombi）
  const sysNorm = (sys.label || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const modNames = (sys.modules || []).map((m) => String(m));
  // ⚠️ 与特殊功能的 modMatch 同口径（2026-10-16 审计 ★7）：
  //    此前只做精确名 + 互含，对 1572 个系统只命中 250 个（15.9%）。
  //    现补上内部模块名（BCM_hinten 等）+ KEYMAP 同类匹配。
  const NORM = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const SYS_KEYMAP = [
    ['组合仪表', ['ic','kombi','instr']], ['发动机', ['ecm','dme','motor']],
    ['变速器', ['tiptronic','pdk','getriebe']], ['驻车制动', ['epb','bremse']],
    ['转向盘', ['lenkrad','steering','swsg','swh']], ['前端电子设备', ['bcm_vorne','vorne']],
    ['后端电子设备', ['bcm_hinten','hinten']], ['保时捷稳定', ['psm','esp']],
    ['保时捷主动悬挂', ['pasm']], ['保时捷通讯', ['pcm','cdr','head']],
    ['网关', ['gateway','gatew']], ['座椅', ['seat','sitz']],
    ['灯光电子', ['lec','lhb','rhb','fhba','headlight']],
    ['轮胎压力', ['tpm','tpms','rdk']], ['安全气囊', ['srs','airbag','pab']],
    ['全轮驱动', ['allrad','awd']], ['空调', ['ac','klima','bke','klimaanlage']],
    ['电视调谐器', ['tvtuner']], ['触摸操作面板', ['touchbedienfeld']],
    ['辅助加热', ['zusatzheizung']], ['拖车', ['anhaenger','trail']],
  ];
  const catOf = (x) => {
    const n = NORM(x); if (!n) return null;
    for (const [zh, keys] of SYS_KEYMAP) {
      const z = NORM(zh);
      if (n === z || n.includes(z) || z.includes(n)) return zh;
      if (keys.some((k) => n.includes(k))) return zh;
    }
    return null;
  };
  const sysCat = catOf(sys.label);
  const hit = (ident.items || []).filter((it) => {
    const ms = (it.modules || []).map((x) => String(x));
    if (ms.some((m) => modNames.includes(m))) return true;
    const sysNorm2 = NORM(sys.label);
    return ms.some((m) => {
      const mn = NORM(m);
      if (!mn) return false;
      if (mn === sysNorm2 || mn.includes(sysNorm2) || sysNorm2.includes(mn)) return true;
      // 内部模块名参与
      const mods = (sys.modules || []).map(NORM).filter(Boolean);
      if (mods.some((x) => mn.includes(x) || x.includes(mn))) return true;
      // 同类匹配
      return sysCat != null && catOf(m) === sysCat;
    });
  });
  // 同标签去重，保留一条
  const byLabel = new Map();
  for (const it of hit) { if (!byLabel.has(it.label)) byLabel.set(it.label, it); }
  const rows = [...byLabel.values()];

  box.innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader"><div class="pdName">版本信息</div>
        <div class="hint">KWP 1A xx 识别 · 只读 · 命中 ${rows.length} 项${hit.length !== rows.length ? `（去重前 ${hit.length} 条）` : ''}</div></div>
      <div id="idList"></div>
      <div class="acts" style="margin-top:12px"><button id="idReadAll" class="primary">全部读取</button></div>
      <div class="hint" style="margin-top:8px">
        命令族：KWP <b>1A xx</b>（ReadECUIdentification）。
        未列出的项表示该模块在源数据里没有对应标识链，可点「全部读取」按标准全套试探。
      </div>
    </div>`;

  const list = $('idList');
  if (!rows.length) {
    list.innerHTML = '<div class="hint">该模块在源数据里没有版本信息条目 —— 点「全部读取」按标准 1A xx 全套试探。</div>';
  } else {
    list.innerHTML = rows.map((it, i) => `
      <div class="ruleRow" data-i="${i}">
        <div class="lbl">${it.labelZh || it.label}<span class="hint" style="margin-left:6px">${it.kwpId}</span></div>
        <div class="meta" style="opacity:.6;font-size:11px">${it.odxId}</div>
        <div class="val" id="idv${i}" style="font-family:monospace">—</div>
        <button class="idRead" data-i="${i}" data-kwp="${it.kwpId}">读取</button>
      </div>`).join('');
  }

  /**
   * 发 KWP 1A xx / UDS 22 F1xx，返回**可读**值。
   *
   * 显示口径取自参考诊断仪的版本信息模块（VERF.so）实测 JSON schema：
   *   { sys_id, sys_name, sys_type, is_disp, grp_name,
   *     item_list[ { item_txtid, item_name, item_value, item_type } ],
   *     ver_list, VERINFO, AUTOVER }
   *   版本记录: `<iSidR=..,<iSidW=..,<iPid=..,<iCodeLen=..,<iVerValue=..`
   *   item_type 取值 **byte | int | long**（数值型），格式化 spec 实测为
   *   `%02X` / `%02X%04X` / `0x%02X` / `0x%04X` / `0x%08X` / `%04x` / `%d`
   *   名称来自 item_txtid 经 EXPRESS.GAG 查表（不是自由文本）
   *
   * 因此：**值是数值/ASCII 两种形态**，按类型格式化，不要乱猜。
   */
  async function readIdent(kwpHex, itemType) {
    const id = parseInt(String(kwpHex).replace(/^0x/i, ''), 16);
    const r = await coder.uds('1A' + id.toString(16).toUpperCase().padStart(2, '0'), 4000, { allowEmpty: true });
    let b = Array.from(r.body || []);
    if (b[0] === 0x7f) return 'NRC 0x' + (b[2] || 0).toString(16).toUpperCase();
    if (b[0] === 0x5a) b = b.slice(2);
    else if (b[0] === 0x62) b = b.slice(3);
    // 去尾部填充（参考实现对 iCodeLen 定长，尾部用 00/20/FF 填）
    while (b.length && (b[b.length - 1] === 0x00 || b[b.length - 1] === 0x20 || b[b.length - 1] === 0xff)) b.pop();
    if (!b.length) return '(空)';

    // ① 版本记录形态：`<iSidR=..,<iPid=..,<iVerValue=..` 直接原样显示
    const asAscii = b.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('');
    if (/^<i(Sid|Pid|Ver|Code)/.test(asAscii.trim())) return asAscii.trim();

    // ② item_type 驱动的数值格式化（byte/int/long）
    const n = b.length;
    const be = b.reduce((a, c) => (a * 256 + c) >>> 0, 0);
    const le = b.slice().reverse().reduce((a, c) => (a * 256 + c) >>> 0, 0);
    const numeric = (itemType || '').toLowerCase();
    if (numeric === 'byte' && n === 1) return `0x${b[0].toString(16).toUpperCase().padStart(2, '0')} (${b[0]})`;
    if (numeric === 'int' && n <= 2) return `0x${be.toString(16).toUpperCase().padStart(n * 2, '0')} (${be})`;
    if (numeric === 'long' && n <= 4) return `0x${be.toString(16).toUpperCase().padStart(n * 2, '0')} (${be})`;

    // ③ 全可打印 → ASCII（零件号/版本号/供应商名）
    const printable = b.filter((c) => c >= 0x20 && c < 0x7f).length;
    if (printable >= b.length * 0.8) {
      return b.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('').trim() || '(空)';
    }
    // ④ 混合 → 可打印段拼接
    const parts = []; let cur = '';
    for (const c of b) {
      if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
      else { if (cur) { parts.push(cur); cur = ''; } }
    }
    if (cur) parts.push(cur);
    if (parts.length) return parts.join(' · ');
    // ⑤ 全二进制 → 按数值 spec 显示（0x%08X 等）
    return `0x${be.toString(16).toUpperCase().padStart(n * 2, '0')}`;
  }

  async function doRead(i, kwpHex) {
    const el = document.getElementById('idv' + i);
    try {
      await coder.enterSessionFor('ident');
      const v = await readIdent(kwpHex);
      if (el) { el.textContent = v; el.style.color = /^NRC/.test(v) ? '#c0392b' : ''; }
      return v;
    } catch (e) {
      if (el) { el.textContent = '✗ ' + e.message; el.style.color = '#c0392b'; }
      return null;
    }
  }

  list.querySelectorAll('.idRead').forEach((b) => {
    b.onclick = () => doRead(Number(b.dataset.i), b.dataset.kwp);
  });
  $('idReadAll').onclick = async () => {
    if (!needLink()) return;
    const std = ['0x9F', '0x87', '0x84', '0x91', '0x92', '0x93', '0x94', '0x95', '0x96', '0x97', '0x9A'];
    $('idReadAll').disabled = true;
    try {
      if (!rows.length) {
        // ⚠️ 结果必须画到卡片上 —— 此前只 log()，用户点「全部读取」后什么也看不到。
        const stdZh = { '0x9F': 'ECU 识别', '0x87': 'ECU 序列号', '0x84': 'ECU 零件号',
          '0x91': '零件图号', '0x92': '硬件号', '0x93': '硬件版本', '0x94': '软件号',
          '0x95': '软件版本', '0x96': '认证号', '0x97': 'ECU ISO 码', '0x9A': '系统供应商标识' };
        await coder.enterSessionFor('ident');
        list.innerHTML = std.map((k, i) => `
          <div class="ruleRow"><div class="lbl">${stdZh[k] || k}<span class="hint" style="margin-left:6px">1A ${k.replace('0x', '')}</span></div>
          <div class="val" id="idv${i}" style="font-family:monospace">读取中…</div></div>`).join('');
        for (let i = 0; i < std.length; i++) {
          const el = document.getElementById('idv' + i);
          try {
            const v = await readIdent(std[i]);
            if (el) { el.textContent = v || '(空)'; el.style.color = /^NRC/.test(v) ? '#c0392b' : ''; }
          } catch (e) {
            if (el) { el.textContent = '✗ ' + e.message; el.style.color = '#c0392b'; }
          }
        }
        return;
      }
      for (let i = 0; i < rows.length; i++) await doRead(i, rows[i].kwpId);
    } finally {
      $('idReadAll').disabled = false;
    }
  };
}

function topLevelItems() {
  const t = tree?.topLevel || [];
  // ★ 只显示可离线的功能，移除需在线的（在线编程/编码/ADAS/防盗/安全网关）
  // ⚠️ 2026-10-18 审计：`special` 顶层入口此前会显示，但点进去只弹「本版只做设码/特殊功能」，
  //    特殊功能实际是**模块级**页面（需要模块地址/会话），顶层没有可执行的落点 —— 死入口。
  //    先不显示，等有「系统 → 模块地址」映射后再接。
  const offlineKinds = new Set(['autosearch', 'manual']);
  return t.filter((x) => offlineKinds.has(x.kind)).map((x) => ({
    kind: 'top', raw: x,
    lbl: x.label || x.id,
    meta: describeTop(x),
  }));
}

function describeTop(x) {
  switch (x.kind) {
    case 'autosearch': return '读 VIN 自动识别车型年款';
    case 'manual': return `${x.groups?.length ?? 0} 个车系组`;
    case 'special': return '独立特殊功能';
    default: return '';
  }
}

function groupItems() {
  return (tree?.groups || []).map((g) => ({
    kind: 'group', raw: g,
    lbl: g.label || g.id,
    meta: `${g.models?.length ?? 0} 个车型`,
  }));
}

function modelItems(g) {
  return (g.models || []).map((m) => ({
    kind: 'model', raw: m,
    lbl: m.label || m.id,
    meta: `${(m.functions || []).map((f) => f.id).join(' · ')}`,
  }));
}

function fnItems(m) {
  return (m.functions || []).map((f) => {
    let meta = '';
    if (f.kind === 'quicktest') meta = '全车扫故障';
    else if (f.kind === 'sysscan') meta = '逐系统探测';
    else if (f.kind === 'syssel') meta = `${f.systems?.length ?? 0} 个系统`;
    else meta = `${f.items?.length ?? f.subFunctions?.length ?? 0} 项`;
    return { kind: 'fn', raw: f, lbl: f.id, meta };
  });
}

function sysItems(f) {
  // v3 树：系统条目内联（label/ecu/modules/codingCount/itemIds）
  return (f.systems || []).map((s) => {
    const cnt = s.codingCount ?? s.count ?? 0;
    return {
      kind: 'sys',
      raw: { ...s, codingCount: cnt, label: s.label },
      lbl: s.label,
      meta: `ECU ${s.ecu ?? '—'} · ${cnt} 条${s.unmapped ? ' · 无对应数据' : ''}`,
      cnt,
    };
  });
}

/**
 * 模块下的功能列表 —— 对齐参考诊断仪：进模块后不止「设码」，还有
 *   读故障码 / 设码（刷隐藏）/ 特殊功能 / 数据流 / 执行器测试
 */
function sysFnItems(s) {
  const base = (s.functions || []).map((f) => ({
    kind: 'sysfn', raw: { ...f, _sys: s },
    lbl: f.id,
    meta: f.subFunctions ? `${f.subFunctions.length} 个子功能` : `${f.count ?? (f.itemIds || []).length} 个条目`,
    cnt: f.count ?? (f.itemIds || []).length,
  }));
  // 参考诊断仪里模块下固定有这些功能项（服务已实现，这里给入口）
  const extras = [
    { id: '读故障码', kind: 'dtc', sid: '19', meta: '读取 / 清除故障码' },
    { id: '设码', kind: 'coding', meta: '编码 / 刷隐藏（主功能）' },
    { id: '数据流', kind: 'measure', meta: '实时测量值' },
    { id: '执行器测试', kind: 'actuator', meta: 'IOControl 驱动执行器' },
    { id: '版本信息', kind: 'identity', meta: 'ECU 识别 / 硬件号 / 软件版本 …' },
    { id: '特殊功能', kind: 'special', meta: '例程控制（校准/匹配/初始化等）' },
  ];
  for (const e of extras) {
    if (base.some((b) => b.lbl === e.id)) continue;
    base.push({ kind: 'sysextra', raw: { ...e, _sys: s }, lbl: e.id, meta: e.meta, cnt: null });
  }
  return base;
}

/** 从 coding-v2 按模块取参数（树里只存 id，不存副本） */
function paramsByModules(modules, itemIds) {
  let list = coding.filter((p) => (modules || []).includes(p.module));
  if (itemIds && itemIds.length) {
    const byId = new Map(list.map((p) => [p.id, p]));
    const picked = itemIds.map((i) => byId.get(i)).filter(Boolean);
    if (picked.length) list = picked;
  }
  return list;
}

/**
 * 二级菜单：按 path[0] 分组（参考诊断仪的做法 —— 冷却液温度特性X / 转速表特性Y / 设码值 …）
 * 不再把一个模块的所有条目摊平。
 */
function groupItemsOf(f) {
  const mods = f._sys?.modules || f.modules;
  const list = f.items?.length ? f.items : paramsByModules(mods, f.itemIds);
  const byGroup = new Map();
  for (const p of list) {
    const g = (p.path && p.path[0]) || '(未命名)';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  // 多维特性组（X/Y）排前面，其余按名称
  // ★ 合并 X/Y 特性组：参考诊断仪里「冷却液温度特性」是一个入口，进去看到 X/Y 表
  //   我们数据里拆成 冷却液温度特性X / 冷却液温度特性Y 两个分组，要并起来
  const norm = (s) => s.replace(/[\s]*([XYZ])\s*$/i, '').trim();
  const merged = new Map();
  for (const [g, items] of byGroup.entries()) {
    const base = norm(g);
    if (!merged.has(base)) merged.set(base, []);
    merged.get(base).push(...items);
  }
  const entries = [...merged.entries()].map(([g, items]) => {
    const multi = items.some((p) => p.multiGroup);
    const axes = {};
    for (const p of items) {
      const leaf = (p.path || []).slice(-1)[0] || '';
      const m = /^\s*([XYZ])\s*(\d+)\s*$/.exec(leaf);
      if (m) (axes[m[1]] ||= []).push(p);
    }
    for (const k of Object.keys(axes)) axes[k].sort((a, b) => {
      const na = +(/\d+/.exec((a.path || []).slice(-1)[0] || '') || [0]);
      const nb = +(/\d+/.exec((b.path || []).slice(-1)[0] || '') || [0]);
      return na - nb;
    });
    const axDesc = Object.keys(axes).length
      ? Object.entries(axes).map(([k, v]) => `${k}${v.length}`).join(' / ')
      : `${items.length} 个条目`;
    return {
      kind: 'subgroup',      // ← 与车系组 'group' 区分（switch 同名 case 会死代码）
      raw: { name: g, items, axes, multi },
      lbl: g,
      meta: multi ? `特性曲线 · ${axDesc}` : axDesc,
      cnt: items.length,
    };
  });
  entries.sort((a, b) => (b.raw.multi - a.raw.multi) || a.lbl.localeCompare(b.lbl, 'zh'));
  return entries;
}

function paramItems(items) {
  return items.map((p) => ({
    kind: 'param', raw: p,
    lbl: p.name,
    meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}`,
    cnt: null,
  }));
}

function kindLabel(p) {
  if (p.kind === 'switch') return '开关';
  if (p.kind === 'enum') return `枚举 ${Object.keys(p.enum || {}).length} 项`;
  return '数值';
}
function rangeHint(p) {
  if (p.kind === 'switch') return '开 / 关';
  if (p.kind === 'enum') return `取值 ${(p.min ?? 0)}..${(p.max ?? 0)}`;
  const hi = p.max ?? p.maxText ?? '?';
  return `范围 ${p.min ?? 0}..${hi}`;
}

// ---------- 渲染 ----------
/** 退一级（返回按钮用） */
function goBack() {
  if (!stack.length) return;
  // ★ 只在真正离开系统（回到系统列表以下）时才 exitSystem
  // 规则编码/设码的子级之间移动不应该断开会话
  const top = stack[stack.length - 1];
  const prev = stack.length >= 2 ? stack[stack.length - 2] : null;
  const isLeavingSystem = top.level === 'sys' && (!prev || prev.level !== 'sysfn');
  if (isLeavingSystem) exitSystem();
  stack = stack.slice(0, -1);
  $('secParam').style.display = 'none';
  renderNav();
  const newTop = stack[stack.length - 1];
  toast('info', newTop ? `返回「${newTop.title}」` : '返回首页');
}

function crumb() {
  const segs = [];
  stack.forEach((s, i) => {
    const last = i === stack.length - 1;
    segs.push(last ? `<b>${s.title}</b>` : `<button data-i="${i}">${s.title}</button>`);
    if (!last) segs.push('<span class="sep">›</span>');
  });
  if (!stack.length) segs.push('<b>请选择车型</b>');
  $('crumb').innerHTML = segs.join('');

  // 面包屑可点（跳到任意一层）
  $('crumb').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.i;
      const leavingSys = stack.slice(i + 1).some((s) => s.level === 'sys');
      if (leavingSys) exitSystem();
      stack = stack.slice(0, i + 1);
      $('secParam').style.display = 'none';
      renderNav();
    };
  });

  // 显式返回键 —— 栈里只要有东西就显示
  $('btnBack').style.display = stack.length ? '' : 'none';
}

function renderNav() {
  crumb();
  // 默认显示常规搜索框（codgroup 会隐藏它）
  const _searchEl = $('searchIn');
  if (_searchEl) _searchEl.parentElement.style.display = '';
  const list = $('navList');
  const q = ($('searchIn').value || '').trim().toLowerCase();
  list.innerHTML = '';
  $('navEmpty').style.display = 'none';
  $('navHint').textContent = '';

  let items = [];
  let title = '请选择车型';

  if (!stack.length) {
    items = topLevelItems();
  } else {
    const top = stack[stack.length - 1];
    title = top.title;
    switch (top.level) {
      case 'top': {
        const x = top.data;
        if (x.kind === 'manual') { items = groupItems(); title = '手动选择'; }
        else if (x.kind === 'online') {
          items = (x.items || []).map((s) => ({ kind: 'onlineitem', raw: s, lbl: s, meta: '' }));
          title = '在线功能';
        } else {
          items = [];
          $('navHint').textContent = `「${x.id}」是独立功能入口，暂不展开设码列表。`;
          toast('info', `「${x.id}」暂不展开`, '这是独立功能入口，本版只做设码/特殊功能');
          title = x.id;
        }
        break;
      }
      case 'group': { items = modelItems(top.data); title = top.data.label; break; }
      case 'model': { items = fnItems(top.data); title = top.data.label; break; }
      case 'fn': {
        const f = top.data;
        if (f.kind === 'syssel') { items = sysItems(f); title = '系统选择'; }
        else if (f.kind === 'quicktest') { items = []; $('navHint').textContent = '快速测试：全车故障扫描（需连接适配器）。';
          if (!needLink()) return;
          toast('info', '快速测试', '全车故障扫描 —— 用「诊断码」页的读故障码，本项暂为入口'); }
        else if (f.kind === 'sysscan') { items = []; $('navHint').textContent = '系统扫描：逐系统探测（需连接适配器）。';
          if (!needLink()) return;
          toast('info', '系统扫描', '逐系统探测 —— 建议直接进「系统选择」逐个模块读'); }
        else { items = (f.items || []).map((p) => ({ kind: 'param', raw: p, lbl: p.name, meta: '' })); }
        break;
      }
      case 'sys': { items = sysFnItems(top.data); title = top.data.label; break; }
      case 'codsubmenu': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'ruleGroupList': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'ruleSubgroupList': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'ruleGroup': {
        // 只渲染，不 push（push 在 onSelect 里做）
        const g = top.data;
        const hasSub = g.items.some((p) => (p.path?.length || 0) >= 3);
        if (hasSub) {
          const subgroups = {};
          for (const p of g.items) {
            const sg = (p.path?.length >= 3) ? p.path[1] : '（直接条目）';
            (subgroups[sg] = subgroups[sg] || []).push(p);
          }
          items = Object.entries(subgroups)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([name, its]) => ({
              kind: 'ruleSubgroup', raw: { name, items: its, parentGroup: g.name },
              lbl: name, meta: `${its.length} 个参数`, cnt: its.length,
            }));
        } else {
          // 直接渲染批量编辑
          showRuleBatchEdit(g.name, g.items);
          return;
        }
        title = g.name;
        break;
      }
      case 'ruleSubgroup': {
        const sg = top.data;
        showRuleBatchEdit(`${sg.parentGroup} > ${sg.name}`, sg.items);
        return;
      }
      case 'codgroup': {
        // ★ 隐藏常规搜索框，只留设码搜索
        const searchEl = $('searchIn');
        if (searchEl) searchEl.parentElement.style.display = 'none';
        items = top.data.groups || [];
        title = top.title;
        // 参考诊断仪: 设码列表第一项是搜索框，搜全量项（含二级三级内容）
        const searchHtml = `<div class="codSearch"><input id="codSearchIn" placeholder="搜索设码项（含子分组内容）..." oninput="window._codSearch(this.value)"></div>`;
        $('navList').innerHTML = searchHtml;
        window._codSearch = (q) => {
          if (!q.trim()) { renderNav(); return; }
          const ql = q.toLowerCase();
          const allItems = top.data.allItems || [];
          const matched = allItems.filter((p) => {
            const name = (p.name || '').toLowerCase();
            const pathStr = (p.path || []).join(' ').toLowerCase();
            return name.includes(ql) || pathStr.includes(ql);
          }).map((p) => ({
            kind: 'param', raw: p,
            lbl: `${(p.path || []).join(' › ')}`,
            meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
            cnt: null,
          }));
          const list = $('navList');
          const searchBox = list.querySelector('.codSearch');
          list.innerHTML = '';
          if (searchBox) list.appendChild(searchBox);
          if (!matched.length) {
            list.insertAdjacentHTML('beforeend', '<div class="navEmpty">无匹配结果</div>');
          } else {
            matched.slice(0, 200).forEach((it) => {
              const d = document.createElement('div');
              d.className = 'item';
              d.innerHTML = `<div class="lbl">${it.lbl}</div><div class="meta">${it.meta || ''}</div>`;
              d.onclick = () => onSelect(it);
              list.appendChild(d);
            });
            if (matched.length > 200) {
              // ⚠️ 不能用 `list.innerHTML +=`：那会把上面的搜索框节点一起重建/丢掉，
              //    用户打一个字后搜索框就消失（2026-10-18 审计）。
              list.insertAdjacentHTML('beforeend',
                `<div class="hint" style="padding:10px">共 ${matched.length} 条匹配，显示前 200 条</div>`);
            }
          }
        };
        break;
      }
      case 'codsubgroup': { items = top.data.groups || []; title = top.title; break; }
      case 'codl4group': { items = top.data.groups || []; title = top.title; break; }
      case 'codelist': {
        items = top.data.items || [];
        title = top.title;
        break;
      }
      case 'paramdetail': {
        // 参数详情独立页面
        const p = top.data;
        renderParamDetail(p);
        return;
      }
      case 'sysfn': {
        const f = top.data;
        if (f.subFunctions) {
          items = f.subFunctions.map((s) => ({ kind: 'sub', raw: s, lbl: s.label || s.id, meta: s.risk ? `风险：${riskLabel(s.risk)}` : '' }));
          title = f.id;
        } else {
          items = groupItemsOf(f);     // ← 二级菜单，不摊平
          title = f.id;
        }
        break;
      }
      case 'subgroup': {
        const g = top.data;
        if (g.multi && Object.keys(g.axes).length) {
          // 多维特性组：显示 X/Y 表格
          showMultiGroup(g);
          items = [];
          title = g.name;
          break;
        }
        items = paramItems(g.items || []);
        title = g.name;
        break;
      }
      case 'onlineitem': { items = []; $('navHint').textContent = `「${top.title}」需联网，暂未实现。`;
        toast('warn', `「${top.title}」暂未实现`, '该项需联网/需授权，本版不做'); break; }
    }
  }

  $('navTitle').textContent = title;
  if (q) items = items.filter((i) => (i.lbl || '').toLowerCase().includes(q) || (i.meta || '').toLowerCase().includes(q));

  if (!items.length) {
    $('navEmpty').style.display = '';
    return;
  }
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<div class="lbl">${it.cnt != null ? `<span class="cnt">${it.cnt}</span>` : ''}${it.lbl}</div>
      ${it.meta ? `<div class="meta">${it.meta}</div>` : ''}`;
    d.onclick = () => onSelect(it);
    list.appendChild(d);
  }
}

/**
 * 进模块：切地址 → 进会话 → **一次性读完该模块所有编码**（对齐参考诊断仪）。
 * 参考诊断仪 是进模块就读全量，不是一个一个进去读。
 */


/** 退出模块：回到系统列表（参考诊断仪的做法是断开模块会话） */
function exitSystem() {
  const name = coder?.ecuName || '模块';
  if (coder) {
    try { coder.uds('1003', 2000, { allowEmpty: true }); } catch { }
  }
  currentBlocks = {};
  currentParam = null;
  state.currentAddr = null;
  $('secParam').style.display = 'none';
  toast('info', `已退出 ${name}`, '回到系统列表');
}

let currentBlocks = {};

/** 参考诊断仪 完整命令序列（function-sequences.json，特殊功能页加载后填充） */
let fnSeqData = null;

/**
 * 进模块：切地址 → 进会话 → **一次性读完该模块所有编码**（对齐参考诊断仪）。
 * 参考诊断仪 是进模块就读全量，不是一个一个进去读。
 */
async function enterSystem(sys) {
  if (!needLink()) return false;
  state.currentAddr = null;   // 进模块失败时不能沿用上一个模块的地址证据
  let addr = addrFor(sys.label, currentModel, sys);
  // 地址缺失两种情况：①表里没这模块 ②表里有但 tx/rx 未知（如 IC，原填 0x7E8 与 DME 应答冲突已作废）
  if (!addr || addr.tx == null || addr.rx == null) {
    if (simMode) {
      // 模拟模式：任何模块都能进，给个占位地址
      addr = { tx: 0x7E0, rx: 0x7E8, note: '模拟' };
    } else {
      // 2026-10-22：未知 ecu 走 431 探测指令路径（替代手工输入）。
      // 对候选 CAN 地址逐个发识别探针（KWP 1A9F / UDS 22F190），
      // 有正响应的地址就是模块地址，保存后下次直接用。
      const why = addr?.note ? `（${addr.note}）` : '';
      log(`  ${sys.label} 地址未知${why}，启动 431 探测…`, 'info');
      const probed = await probeAddressFor(sys.label, addr?.probeCmd, currentModel);
      if (probed) {
        saveAddrOverride(sys.label, probed, currentModel);
        addr = { ...probed, state: 'probed', note: '431 探测命中' };
        log(`  ✅ ${sys.label} 探测到 0x${probed.tx.toString(16).toUpperCase()}/0x${probed.rx.toString(16).toUpperCase()}（已保存）`, 'ok');
      } else {
        // 探测失败 → 仍允许手工输入兜底
        log(`  ❌ ${sys.label} 探测未命中${why}，可手工输入地址`, 'warn');
        const raw = (typeof prompt === 'function')
          ? prompt(`探测未找到「${sys.label}」的 CAN 地址${why}。\n\n`
            + '若已用「地址扫描」或参考设备查到 tx/rx，请输入一对地址（如 7E0/7E8）。\n'
            + '留空 = 取消。')
          : null;
        if (!raw) return false;
        const pair = parseAddrPair(raw);
        if (!pair) { toast('err', '地址格式不对', '请输入如 7E0/7E8'); return false; }
        saveAddrOverride(sys.label, pair, currentModel);
        addr = { ...pair, state: 'manual', note: '手工输入/已保存' };
      }
    }
  }
  state.currentAddr = addr;
  showLoading(`正在进入 ${sys.label}`, `地址 0x${addr.tx.toString(16).toUpperCase()}/0x${addr.rx.toString(16).toUpperCase()} · 建立会话中…`);
  // ⚠️⚠️ 从这里到函数末尾**整段 try/finally**：loading 必然被关掉。
  //    2026-10-17 实测「进模块一直转圈」—— 中间任何一处抛未捕获异常，
  //    hideLoading 就不执行，转圈永远停不下来。别再靠「每条错误路径手写 hideLoading」。
  try {
  // ⚠️ 候选地址（未实测）必须让用户知情（2026-10-17 审计 C2）：
  //    直接用未验证地址发请求，可能把别的 ECU 的数据当目标模块显示。
  if (addr.state === 'candidate') {
    // 参考诊断仪 不在进模块时弹「地址未实测」；地址来自 参考诊断仪/标准顺序，进模块后用 1A9F/读块核验。
    // 只在日志提示，不再阻塞用户（此前 confirm 让模拟模式也每次弹，且真车点取消就进不去）。
    log(`  ${sys.label} 地址 0x${addr.tx.toString(16).toUpperCase()}/0x${addr.rx.toString(16).toUpperCase()}（标准顺序；进模块后核验）`, 'info');
  }
  coder.setAddress(addr.tx, addr.rx, sys.label);
  // ⚠️ 换模块必须重选 seed/key 变体（2026-10-17 审计 D1）：
  //    此前只在连接时选一次，换 ECU 后仍是旧变体 → 算错 key → NRC 0x35 → 可能锁死。
  try {
    // ⚠️ 优先走 原厂 的 mode 表（securityModel），这是「和 参考诊断仪 对齐」的正解。
    //    拿不到 mode 才退回按 ECU 名猜变体（旧路径）。
    // ⚠️⚠️ 这里**绝不能阻塞**：2026-10-17 装机后实测「进模块一直转圈」，
    //    根因就是这段 `await fetch(...)` 在同步流程里 —— fetch 不 resolve 就永远 await，
    //    showLoading 的转圈停不下来。改成**限时 + 失败立刻回落旧路径**。
    let mode = null, lid = null;
    if (drivelinks === undefined) drivelinks = null;   // 允许 null 表示「加载过但没有」
    if (!drivelinks) {
      try {
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 1500) : null;
        const r = await fetch('data/drivelinks.json', ctl ? { signal: ctl.signal } : {});
        if (timer) clearTimeout(timer);
        drivelinks = r.ok ? await r.json() : null;
      } catch (e) {
        drivelinks = null;   // 拿不到就退回旧路径，绝不卡住
      }
    }
    // 2026-10-19：RE 实证 ECU 寻址表（sysId → tx/rx），限时加载，失败不阻塞
    if (ecuAddrTable === undefined) ecuAddrTable = null;
    if (!ecuAddrTable) {
      try {
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 1500) : null;
        const r = await fetch('data/ecu-addresses.json', ctl ? { signal: ctl.signal } : {});
        if (timer) clearTimeout(timer);
        ecuAddrTable = r.ok ? await r.json() : null;
      } catch (e) {
        ecuAddrTable = null;
      }
    }
    try {
      // ⚠️ 2026-10-18 审计：这条路径**此前永远走不到**。
      //    原实现拿 `sys.label`（形如「ECM/DME(发动机控制模块)」）去匹配 `0x([0-9a-f]{3,4})`
      //    —— 中文标签里没有 hex，mode 恒为 null，于是号称「正解」的原厂 mode 表
      //    一次都没用过，全部落回按名字猜变体。
      //    现在：① 优先用 `sys.ecu`（树里本就有这个字段，当前数据为 null）
      //          ② 再看 label 里的 hex
      //          ③ 都没有 → 走「模块名 → ECU_ID」映射表（目前源数据未提供，留空）
      //    拿不到 ECU_ID 时必须**明说**，别再假装走了 mode 表。
      const ecuKeyFrom = (raw) => {
        if (raw == null) return null;
        if (typeof raw === 'number') return '0x' + raw.toString(16).padStart(4, '0');
        const m = String(raw).match(/0x([0-9a-fA-F]{3,4})/);
        return m ? '0x' + m[1].toLowerCase().padStart(4, '0') : null;
      };
      let hit = null;
      for (const src of [sys.ecu, SYSTEM_TO_ECUID[sys.label], sys.label, ...(sys.modules || []).map((m) => MODULE_TO_ECUID[m])]) {
        const k = ecuKeyFrom(src);
        if (k && drivelinks?.ecu?.[k]?.length) { hit = drivelinks.ecu[k]; break; }
      }
      if (hit && hit.length) { mode = hit[0].m; lid = hit[0].l; }
      else if (drivelinks) {
        log(`  （DRIVELINKS 已加载 ${Object.keys(drivelinks.ecu).length} 个 ECU，` +
            `但「${sys.label}」没有 ECU_ID —— 缺 module→ECU_ID 映射，退回按名字选变体）`, 'warn');
      }
    } catch (e) { /* 解析失败退回旧路径 */ }

    if (mode != null) {
      // 预检：mode 的算法在不在（不真算）。没逆出来的 mode 立刻降级成「只读」，
      // 别等到用户按写入才报错（日志里也不该显示成 ok）。
      let modeOk = true, modeWhy = '';
      try { resolveKey(mode, 0x12345678, { ecuId: null }); } catch (e) { modeOk = false; modeWhy = e.message; }
      if (modeOk) {
        coder.seedKeyProvider = makeResolverProvider(mode, { ecuId: null, name: sys.label });
        log(`  seed/key：原厂 mode 0x${mode.toString(16).padStart(2, '0')}` +
            (lid != null ? ` · LID 0x${lid.toString(16).padStart(4, '0')}` : '') + '（照抄 securityModel）', 'ok');
      } else {
        coder.seedKeyProvider = null;
        log(`  ⚠ mode 0x${mode.toString(16)} 还不能算 key：${modeWhy} —— 该模块只读`, 'warn');
      }
    } else {
      // ⚠️ 优先走 原厂 的 `nameTable` 名字表（138 条，权威），
      //    这是「和 参考诊断仪 对齐」的正解；查不到才退回旧的 pickVariant 别名表。
      const cands = [sys.label, ...(sys.modules || [])];
      let variant = null, hitName = null;
      // ⓪ 非 ASAP1A 入口先试。
      //    ① 精确函数名（如 'SecurityAccess_9x7_ALLRAD'）
      //    ② **平台限定**模块名 —— `BV_SteerAssisUDS` 跨 5 个平台，
      //       不带平台会把 E3/G2 也用上 992 的算法 → 算错 key → 0x36 锁死。
      const plat = platformForModel(currentModel);
      let naEntry = null, naKey = null;
      for (const c of cands) {
        naEntry = nonAsapForName(c);
        if (naEntry) { naKey = c; break; }
      }
      if (!naEntry) {
        for (const c of cands) {
          naEntry = nonAsapForModule(plat, c);
          if (naEntry) { naKey = c; break; }
        }
      }
      if (naEntry) {
        try {
          const ctx = { platform: plat, module: naKey };
          const chk = resolveKeyByName(naKey, null, ctx);   // 预检：算法在不在
          coder.seedKeyProvider = {
            name: `nonasap:${naEntry.algo}`,
            verified: true,
            calc(seedBytes, _lv) { return resolveKeyByName(naKey, seedBytes, ctx).key; },
          };
          log(`  seed/key：非 ASAP1A「${naKey}」${plat ? `（${plat}）` : ''}→ ${chk.algo}`, 'ok');
        } catch (e) {
          coder.seedKeyProvider = null;
          log(`  ⚠ 「${naKey}」的非 ASAP1A 算法未就绪：${e.message}`, 'warn');
        }
      } else {
      for (const c of cands) {
        variant = variantForName(c);
        if (variant) { hitName = c; break; }
      }
      if (variant) {
        // 用名字映射直接算，绕过 mode
        // ⚠️ 先做**存在性预检**（seed=null）：变体没实现时在这里就降级成「只读」，
        //    而不是等到用户按写入才抛异常。此前无条件记 ok，日志会骗人。
        let naOk = true, naWhy = '';
        try { resolveKeyByName(hitName, null); } catch (e) { naOk = false; naWhy = e.message; }
        coder.seedKeyProvider = naOk ? {
          name: `asap:${String(variant).slice(0, 16)}`,
          verified: true,
          calc(seedBytes, _lv) {
            // ⚠️ 直接传 **原始 seed 字节**：非 ASAP1A 的 seedLen 可能是 2，
            //    压成 32 位再解回来会丢字节（2026-10-17 踩过）。
            return resolveKeyByName(hitName, seedBytes).key;
          },
        } : null;
        if (naOk) log(`  seed/key：名字「${hitName}」→ 变体 ${String(variant).slice(0, 16)}（原厂 权威表）`, 'ok');
        else log(`  ⚠ 「${hitName}」的变体 ${String(variant).slice(0, 16)} 尚未逆出：${naWhy} —— 只读`, 'warn');
      } else {
        const v = pickVariant(sys.label) || (sys.modules || []).map((m) => pickVariant(m)).find(Boolean) || null;
        coder.seedKeyProvider = v ? makeProvider(v) : null;
        if (v) log(`  seed/key 变体：${v.variant}${v.verified ? '' : '（未逐位验证，写入需先 校验 校验）'}`, v.verified ? 'ok' : 'warn');
        else log(`  ⚠ 「${sys.label}」不在 原厂 名字表（${Object.keys(NAME_TO_VARIANT).length} 条）也无别名 —— 只读，写入会被拒`, 'warn');
      }
      }
    }
  } catch (e) {
    // 选变体失败不阻断进模块（只读仍可用）；写入时 canWrite 会再拦一次。
    // ⚠️ 这里必须兜住，否则异常会让 showLoading 的转圈永远停不下来。
    coder.seedKeyProvider = null;
    log(`  ⚠ seed/key 选择异常，已回落到无算法（只读可用）：${e.message}`, 'warn');
  }
  try {
    await coder.enterSession(0x89);
  } catch (e) {
    // ⚠️ 不是所有模块都支持 10 89（KWP/老模块常用 10 03）。此前 10 89 失败就直接
    //    放弃整个模块 —— 连只读都进不去。现在回退到扩展会话 10 03：
    //    只读可用；写入仍会在 applyChange 里硬要求 10 89，失败即报错。
    log(`  ⚠ 10 89 会话失败：${e.message} —— 回退 10 03 只读会话`, 'warn');
    try {
      await coder.enterSession(0x03);
      log('  ✅ 已进 10 03 扩展会话（只读；写入仍需 10 89）', 'warn');
    } catch (e2) {
      hideLoading();
      toast('err', `${sys.label} 会话失败`, `${e.message}；回退 10 03 也失败：${e2.message}`);
      return false;
    }
  }

  // ★ 加载该车型×模块×变体的编码条目
  const mods = sys.modules || [];
  let items = [];
  state.multiVariantModules.clear();
  for (const mod of mods) {
    const cat = modelsCatalog?.models?.[currentModel];
    const mi = (cat?.modules || []).find((m) => m.module === mod);
    if (mi && (mi.variants || []).length > 1) {
      state.multiVariantModules.add(mod);
      // ★ 2026-10-18：参考诊断仪 **不弹变体选择**。它靠 ECU 识别（1A 9F/94/92）
      //   匹配 ODX 变体名；我们之前反过来让用户手选，既不像 参考诊断仪，也把
      //   大多数模块的写入锁死。现在自动选：识别串命中变体名 → 精确；
      //   命中模块名 → BaseSys；都不中 → 参考诊断仪 默认变体（default）。
      //   仍然保留 selectedVariant 这个安全闸门（自动选也会写入它），
      //   这样 doWrite 不再因为「未选」拒写。
      const auto = autoPickVariant(mi, coder.lastIdent);
      // ⚠️ 识别失败时 autoPickVariant 仍会返回默认变体名；不能把它写进
      //    selectedVariant，否则 doWrite 的「变体未识别 → 拒写」闸门永远失效。
      if (/未识别|无识别文本/.test(auto.how)) {
        delete state.selectedVariant[mod];
        log(`  🧩 ${mod} 变体未识别，保持写入锁定（仅只读显示 ${auto.name}）`, 'warn');
      } else {
        state.selectedVariant[mod] = auto.name;
        log(`  🧩 ${mod} 变体自动：${auto.name}（${auto.how}）`, 'ok');
      }
    }
    const got = await loadModuleItems(currentModel, mod);
    items = items.concat(got);
  }
  items = items.filter((p) => validateParam(p).length === 0 && p.lid != null);
  coding = items;

  // ★ 懒加载读取（对齐参考诊断仪）：不全量读，按需读对应块
  // 参考诊断仪 是按锁定的变体读对应块，不是全量扫
  const lids = [...new Set(items.map((p) => p.lid))];
  updateLoading(`正在读取 ${sys.label}`, `按需加载 ${lids.length} 个编码块…`);

  // 只读用户当前会看的块（按分组懒加载，进设码列表时再批量读）
  currentBlocks = {};
  // 预读前几个高频块（提升体验），其余按需
  const priorityLids = lids.slice(0, 8);
  let readFail = 0;
  for (const lid of priorityLids) {
    const sample = items.find((p) => p.lid === lid);
    try {
      currentBlocks[lid] = await coder.readBlock(lid, sample.readSid ?? 0x21);
    } catch (e) {
      // ⚠️ 读失败必须让用户看见（2026-10-17 审计 C1）：静默吞掉会让用户以为
      //    "326 个参数" 只是没值，实际是块根本没读到。
      readFail++;
      log(`  ❌ LID 0x${lid.toString(16)} 读取失败：${e.message}`, 'err');
    }
  }
  if (readFail) {
    toast('warn', `${readFail}/${priorityLids.length} 个编码块读取失败`,
      '当前值显示为空 —— 请检查连接/地址，或跑地址扫描确认 ECU 可达');
  }
  // 提取已读块的当前值
  for (const p of items) {
    const block = currentBlocks[p.lid];
    if (block) {
      try { p.currentValue = extractField(block, p); } catch { p.currentValue = undefined; }
    }
  }

  hideLoading();
  toast('ok', `${sys.label} 就绪`, `${items.length} 个参数 / ${lids.length} 个编码块（按需加载）`);
  return true;
  } catch (e) {
    // ⚠️ enterSystem **永不抛异常**，只返回 true/false。
    //    2026-10-17 实测：用 try/finally 时异常照样 reject，
    //    调用方 `enterSystem(...).then(ok => ...)` 没有 .catch() →
    //    转圈停了（finally 生效）但**不导航**，界面停在模块列表。
    //    这里 catch 掉返回 false，调用方才知道是失败。
    hideLoading();
    toast('err', `进入 ${sys?.label ?? '模块'} 失败`, e?.message || String(e));
    return false;
  } finally {
    hideLoading();   // 双保险：无论哪条路径，转圈一定停
  }
}




async function onSelect(it) {
  // ruleGroup: 规则编码分组点击
  if (it.kind === 'ruleGroup') {
    await readBlocksForItems(it.raw.items || []);
    stack.push({ level: 'ruleGroup', title: it.raw.name, data: it.raw });
    renderNav();
    return;
  }
  // ruleSubgroup: 规则编码子组点击
  if (it.kind === 'ruleSubgroup') {
    await readBlocksForItems(it.raw.items || []);
    stack.push({ level: 'ruleSubgroup', title: it.raw.name, data: it.raw });
    renderNav();
    return;
  }
  // codop: 处理设码二级菜单操作
  if (it.kind === 'codop') {
    const op = it.raw;
    if (op.op === 'hidden' || op.op === 'noRuleCoding') {
      const allItems = op.allItems || [];
      const groups = {};
      for (const p of allItems) {
        const g = p.path?.[0] || '（未命名）';
        (groups[g] = groups[g] || []).push(p);
      }
      const groupItems = Object.entries(groups)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, items]) => {
          const isCurve = items.some((p) => /^[XY]\s*\d+$/.test(p.path?.[p.path.length - 1] || ''));
          return { kind: 'codgroup', raw: { name, items, isCurve }, lbl: name,
            meta: `${items.length} 个参数${isCurve ? ' · 特性曲线' : ''}`, cnt: items.length };
        });
      stack.push({ level: 'codgroup', title: `设码 · ${op.sysLabel}`, data: { groups: groupItems, allItems } });
      renderNav();
      return;
    }
    if (op.op === 'ruleCoding') { showRuleCoding(op.allItems || [], op.sysLabel); return; }
    if (op.op === 'backup') { await backupAllCoding(op.allItems || [], op.sysLabel); return; }
    if (op.op === 'restore') { await restoreCoding(op.sysLabel); return; }
    if (op.op === 'writeVer') { toast('info', '写版本信息', '此功能需要连接车辆后使用'); return; }
    return;
  }
  switch (it.kind) {
    case 'top':
      if (it.raw.kind === 'autosearch') { autoSearch(); return; }
      stack.push({ level: 'top', title: it.raw.id, data: it.raw });
      break;
    case 'onlineitem':
      stack.push({ level: 'onlineitem', title: it.raw, data: it.raw });
      break;
    case 'group': stack.push({ level: 'group', title: it.raw.label, data: it.raw }); break;
    case 'model': currentModel = it.raw.label; stack.push({ level: 'model', title: it.raw.label, data: it.raw }); break;
    case 'fn': stack.push({ level: 'fn', title: it.raw.id, data: it.raw }); break;
    case 'sys': {
      // 进模块：切地址 + 一次性读全部编码（对齐参考诊断仪）
      enterSystem(it.raw).then((ok) => {
        if (ok) { stack.push({ level: 'sys', title: it.raw.label, data: it.raw }); renderNav(); }
        else log(`  进入「${it.raw.label}」未完成 —— 留在当前页`, 'warn');
      }).catch((e) => {
        // 兜底：enterSystem 已保证不抛，这里只是双保险
        hideLoading();
        toast('err', `进入「${it.raw.label}」失败`, e?.message || String(e));
      });
      return;
    }
    case 'sysfn': stack.push({ level: 'sysfn', title: it.raw.id, data: it.raw }); break;
    case 'sysextra': {
      // 设码 → 按参考诊断仪 的多级菜单进：分组列表 → 子分组/条目 → 参数详情
      if (it.raw.kind === 'coding') {
        const allItems = coding || [];
        if (!allItems.length) {
          toast('warn', '无编码条目', '该模块未加载到编码数据');
          return;
        }
        // ★ 参考诊断仪 二级菜单：设码下有多种操作
        const sysLabel = it.raw._sys?.label || '';
        const submenuItems = [
          { kind: 'codop', raw: { op: 'backup', sysLabel, allItems }, lbl: '备份所有编码', meta: '读取全部编码块并保存', cnt: null },
          { kind: 'codop', raw: { op: 'writeVer', sysLabel }, lbl: '写版本信息', meta: '写入版本/识别信息', cnt: null },
          { kind: 'codop', raw: { op: 'ruleCoding', sysLabel, allItems }, lbl: '规则编码', meta: '批量查看和修改多个设码值', cnt: null },
          { kind: 'codop', raw: { op: 'noRuleCoding', sysLabel, allItems }, lbl: '无规则编码', meta: '直接逐项编辑', cnt: null },
          { kind: 'codop', raw: { op: 'hidden', sysLabel, allItems }, lbl: '刷隐藏/改装', meta: '搜索并修改单个设码项', cnt: allItems.length },
          { kind: 'codop', raw: { op: 'restore', sysLabel, allItems }, lbl: '读取备份编码', meta: '从备份恢复编码', cnt: null },
        ];
        stack.push({ level: 'codsubmenu', title: `设码 · ${sysLabel}`, data: { items: submenuItems, allItems, sysLabel } });
        renderNav();
        return;
      }
      showSysExtra(it.raw);
      return;
    }
    case 'codgroup': {
      const g = it.raw;
      await readBlocksForItems(g.items || []);
      if (g.isCurve) {
        showCurveGroup(g);
        return;
      }
      // 检查是否有 L3 子分组（path depth >= 3）
      const hasSubgroups = g.items.some((p) => (p.path?.length || 0) >= 3);
      if (hasSubgroups) {
        // 显示 L3 子分组列表（参考诊断仪 的三级菜单）
        const subgroups = {};
        for (const p of g.items) {
          const sg = (p.path?.length >= 3) ? p.path[1] : '（直接条目）';
          (subgroups[sg] = subgroups[sg] || []).push(p);
        }
        const sgItems = Object.entries(subgroups)
          .sort((a, b) => b[1].length - a[1].length)
          .map(([name, items]) => ({
            kind: 'codsubgroup', raw: { name, items, parentGroup: g.name },
            lbl: name,
            meta: `${items.length} 个参数`,
            cnt: items.length,
          }));
        stack.push({ level: 'codsubgroup', title: g.name, data: { groups: sgItems } });
        renderNav();
        return;
      }
      // 无子分组 → 直接显示条目
      const items = g.items.map((p) => ({
        kind: 'param', raw: p,
        lbl: p.path?.length > 1 ? p.path[p.path.length - 1] : p.name,
        meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
        cnt: null,
      }));
      stack.push({ level: 'codelist', title: g.name, data: { items } });
      renderNav();
      return;
    }
    case 'codsubgroup': {
      const sg = it.raw;
      await readBlocksForItems(sg.items || []);
      // 检查是否有 4 级路径（L3 内还有子层，如 V1/V2）
      const hasL4 = sg.items.some((p) => (p.path?.length || 0) >= 4);
      if (hasL4) {
        // 按 path[2] 分组（保留 V1/V2 标识）
        const l4groups = {};
        for (const p of sg.items) {
          const l4 = (p.path?.length >= 4) ? p.path[2] : '（直接条目）';
          (l4groups[l4] = l4groups[l4] || []).push(p);
        }
        const l4Items = Object.entries(l4groups)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, items]) => ({
            kind: 'codl4group', raw: { name, items, parentPath: `${sg.parentGroup} > ${sg.name}` },
            lbl: name,
            meta: `${items.length} 个参数`,
            cnt: items.length,
          }));
        stack.push({ level: 'codl4group', title: `${sg.parentGroup} > ${sg.name}`, data: { groups: l4Items } });
        renderNav();
        return;
      }
      const items = sg.items.map((p) => ({
        kind: 'param', raw: p,
        lbl: p.path?.length > 2 ? p.path[p.path.length - 1] : p.name,
        meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
        cnt: null,
      }));
      stack.push({ level: 'codelist', title: `${sg.parentGroup} > ${sg.name}`, data: { items } });
      renderNav();
      return;
    }
    case 'codl4group': {
      const l4 = it.raw;
      await readBlocksForItems(l4.items || []);
      const items = l4.items.map((p) => ({
        kind: 'param', raw: p,
        lbl: p.path?.length > 3 ? p.path[p.path.length - 1] : p.name,
        meta: `${kindLabel(p)} · byte ${p.byte} bit ${p.bit} · ${rangeHint(p)}${p.currentValue !== undefined ? ' · 当前=' + decodeValue(p, p.currentValue) : ''}`,
        cnt: null,
      }));
      stack.push({ level: 'codelist', title: l4.name, data: { items } });
      renderNav();
      return;
    }
    case 'param': {
      // 参数详情 → 独立页面（参考诊断仪的做法）
      stack.push({ level: 'paramdetail', title: it.raw.name, data: it.raw });
      renderNav();
      return;
    }
    case 'subgroup': stack.push({ level: 'subgroup', title: it.raw.name, data: it.raw }); break;
    case 'sub': showSub(it.raw); return;
    default: return;
  }
  $('secParam').style.display = 'none';
  renderNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function pushModel(m) {
  // 自动搜索命中：直接压入该车型
  // ⚠️ 必须用**树里的真 model 对象**（带 functions/modules），不能用 VIN 码表 stub
  //    （stub 只有 {code,label}，fnItems(m) 会读 m.functions || [] → 0 项 → 进不了系统选择）。
  //    2026-10-17 审计 B1：自动搜索识别成功却走到死胡同。
  currentModel = m.label;
  const g = (tree?.groups || []).find((x) => (x.models || []).some((y) => y.label === m.label));
  const real = g?.models?.find((y) => y.label === m.label) || m;
  stack = [{ level: 'top', title: '手动选择', data: tree?.topLevel?.find((x) => x.kind === 'manual') || {} }];
  if (g) stack.push({ level: 'group', title: g.label, data: g });
  stack.push({ level: 'model', title: m.label, data: real });
  renderNav();
}

$('searchIn').oninput = renderNav;

// ---------- 多维特性组（X/Y 曲线）----------
function showMultiGroup(g) {
  $('secParam').style.display = '';
  const axes = g.axes || {};
  const names = Object.keys(axes);
  const n = Math.max(...names.map((k) => axes[k].length), 0);
  let rows = '';
  for (let i = 0; i < n; i++) {
    const cells = names.map((k) => {
      const p = axes[k][i];
      return p ? `<td><button class="axisCell" data-id="${p.id}">${p.name}<br>
        <span class="meta">byte ${p.byte} · ${rangeHint(p)}</span></button></td>` : '<td></td>';
    }).join('');
    rows += `<tr>${cells}</tr>`;
  }
  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${g.name}<span class="tag">特性曲线</span></div>
      <div class="meta">共 ${names.join(' / ')} 各 ${n} 点。点任一格进入单项编辑。</div>
      <table class="axisTable"><thead><tr>${names.map((k) => `<th>${k} 值</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  $('paramBox').querySelectorAll('.axisCell').forEach((b) => {
    b.onclick = () => {
      const p = coding.find((x) => x.id === b.dataset.id);
      if (p) {
        stack.push({ level: 'paramdetail', title: p.name, data: p });
        renderNav();
      }
    };
  });
}

// ---------- 参数详情（独立页面） ----------
function renderParamDetail(p) {
  currentParam = p;
  const ro = p.sidPairOk === false;
  const en = p.enum ? Object.entries(p.enum) : [];
  const curVal = p.currentValue !== undefined ? decodeValue(p, p.currentValue) : null;

  // 枚举只显示人能看懂的文字
  let input = '';
  if (p.kind === 'switch' || p.kind === 'enum') {
    // 统一用下拉框，显示 enum 的实际值（参考诊断仪的做法）
    // ⚠️ enum key 是**十进制**字符串，不是 hex（见前面注释）
    // ⚠️ 必须按 currentValue 预选（2026-10-18 审计）：此前不设 selected，
    //    打开一个枚举/开关参数后直接点「写入」会写**第一个选项**（常常是 0/关），
    //    而不是当前值 —— 用户以为没改，实际把车改了。
    const opts = (en.length ? en : [[0, '关'], [1, '开']]);
    const cur = (p.currentValue == null) ? null : Number(p.currentValue);
    input = `<select id="pVal">${opts.map(([k, v]) =>
      `<option value="${Number(k)}" ${cur != null && Number(k) === cur ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    if (cur == null) input += `<div class="hint" style="color:#c0392b">当前值未读到 —— 下拉框默认是第一项，请先「读当前值」或确认目标值后再写入。</div>`;
  } else {
    // 宽字段（>53 位）用 text：HTML number input 会把 64 位值转成浮点/科学计数，
    // 提交时已经丢精度；text + inputmode=numeric 保留原始十进制串，交给 parseFieldInput 转 BigInt。
    const wide = (p.bitsize | 0) > 53;
    input = `<input id="pVal" type="${wide ? 'text' : 'number'}" inputmode="numeric"
        min="${p.min ?? 0}" max="${p.max ?? ''}" value="${p.currentValue ?? p.min ?? 0}">
      <div class="hint">验证状态：<b>${p.level || '—'}</b> · 可填范围：<b>${p.min ?? 0} … ${p.max ?? '?'}</b>
        （${p.bitsize} 位，共 ${(p.max - p.min + 1) || '?'} 个取值）</div>`;
  }

  $('navList').innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader">
        <div class="pdName">${p.name}${ro ? '<span class="tag ro">只读</span>' : ''}
          <span class="tag">${kindLabel(p)}</span></div>
        <div class="pdPath">${(p.path || []).join(' › ')}</div>
      </div>
      <div class="pdMeta">
        ${curVal !== null ? `<div class="pdRow pdCurrent"><span>当前值</span><span><b>${curVal}</b></span></div>` : ''}
        <div class="pdRow"><span>位置</span><span>byte ${p.byte} · bit ${p.bit} · 宽 ${p.bitsize}</span></div>
        <div class="pdRow"><span>服务</span><span>读 0x${(p.readSid ?? 0x21).toString(16).toUpperCase()} / 写 0x${(p.writeSid ?? 0x3B).toString(16).toUpperCase()} · LID 0x${(p.lid ?? 0).toString(16).toUpperCase()}</span></div>
        <div class="pdRow"><span>风险</span><span class="risk-${p.risk || 'low'}">${riskLabel(p.risk)}</span></div>
      </div>
      <label>目标值</label>
      ${input}
      <div class="acts">
        <button id="pRead">读当前值</button>
        <button id="pWrite" class="${ro ? '' : 'primary'}">写入</button>
      </div>
      <div class="hint">${ro ? (p.writeBlockedReason || '源数据无写服务，只能读') : ''}</div>
    </div>`;

  $('pRead').onclick = () => doRead(p);
  $('pWrite').onclick = () => {
    if (ro) {
      toast('warn', `「${p.name}」是只读项`, p.writeBlockedReason || '源数据无写服务，只能读不能改');
      return;
    }
    const raw = $('pVal')?.value ?? '0';
    const v = parseFieldInput(p, raw);
    if (v == null) {
      toast('err', '值无效', p.bitsize > 53 ? '请输入十进制或 0x 前缀的整数' : '请输入数字');
      return;
    }
    if (!fieldInRange(p, v)) {  // max=null 不能当 0 比较
      toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}`);
      return;
    }
    doWrite(p, v);
  };
}

function showCurveGroup(g) {
  const items = g.items;
  const axisRe = /^([XYZ])\s*(\d+)$/;
  const axes = {};
  const others = [];
  for (const p of items) {
    const leaf = p.path?.[p.path.length - 1] || p.name;
    const m = leaf.match(axisRe);
    if (m) {
      (axes[m[1]] = axes[m[1]] || []).push(p);
    } else {
      others.push(p);
    }
  }
  for (const k of Object.keys(axes)) {
    axes[k].sort((a, b) => {
      const na = parseInt((a.path?.[a.path.length - 1] || '').match(/\d+/)?.[0] || '0');
      const nb = parseInt((b.path?.[b.path.length - 1] || '').match(/\d+/)?.[0] || '0');
      return na - nb;
    });
  }
  const axisKeys = Object.keys(axes).sort();
  const n = Math.max(...axisKeys.map((k) => axes[k].length), 0);

  // 构建曲线表
  let rows = '';
  for (let i = 0; i < n; i++) {
    const cells = axisKeys.map((k) => {
      const p = axes[k][i];
      return p ? `<td><button class="axisCell" data-id="${p.id}">
        <b>${p.path?.[p.path.length - 1] || p.name}</b>
        <span class="meta">byte ${p.byte} · ${rangeHint(p)}</span></button></td>` : '<td></td>';
    }).join('');
    rows += `<tr>${cells}</tr>`;
  }
  $('navList').innerHTML = `
    <div class="paramDetail">
      <div class="pdHeader">
        <div class="pdName">${g.name}<span class="tag">特性曲线</span></div>
        <div class="pdPath">${axisKeys.join(' / ')} 各 ${n} 点</div>
      </div>
      <table class="axisTable"><thead><tr>${axisKeys.map((k) => `<th>${k} 值</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
  $('navList').querySelectorAll('.axisCell').forEach((b) => {
    b.onclick = () => {
      const p = coding.find((x) => x.id === b.dataset.id);
      if (p) {
        stack.push({ level: 'paramdetail', title: p.name, data: p });
        renderNav();
      }
    };
  });
}

// ---------- 参数详情（旧版内嵌卡片，保留兼容） ----------
function showParam(p) {
  currentParam = p;
  $('secParam').style.display = '';
  const ro = p.sidPairOk === false;
  const en = p.enum ? Object.entries(p.enum) : [];

  // 按 kind 给不同输入：开关 / 下拉 / 数字
  let input = '';
  if (p.kind === 'switch') {
    const on = p.currentValue === 1 || p.currentValue === '1';
    input = `<div class="switchRow">
      <button class="swBtn ${on ? '' : 'sel'}" data-v="0">关</button>
      <button class="swBtn ${on ? 'sel' : ''}" data-v="1">开</button>
    </div>`;
  } else if (p.kind === 'enum') {
    const cur = (p.currentValue == null) ? null : Number(p.currentValue);
    input = `<select id="pVal">${en.map(([k, v]) =>
      `<option value="${Number(k)}" ${cur != null && Number(k) === cur ? 'selected' : ''}>${k} = ${v}</option>`).join('')}</select>`;
  } else {
    const wide = (p.bitsize | 0) > 53;
    input = `<input id="pVal" type="${wide ? 'text' : 'number'}" inputmode="numeric"
        min="${p.min ?? 0}" max="${p.max ?? ''}" value="${p.currentValue ?? p.min ?? 0}">
      <div class="hint">验证状态：<b>${p.level || '—'}</b> · 可填范围：<b>${p.min ?? 0} … ${p.max ?? '?'}</b>
        （${p.bitsize} 位，共 ${(p.max - p.min + 1) || '?'} 个取值）</div>`;
  }
  const enHtml = en.length ? `<br>枚举：<br>${en.map(([k, v]) => `${k} = ${v}`).join('<br>')}` : '';

  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${p.name}${ro ? '<span class="tag ro">只读</span>' : ''}
        <span class="tag">${kindLabel(p)}</span></div>
      <div class="meta">
        位置：byte ${p.byte} · bit ${p.bit} · 宽 ${p.bitsize}<br>
        服务：读 0x${(p.readSid ?? 0x21).toString(16).toUpperCase()} / 写 0x${(p.writeSid ?? 0x3B).toString(16).toUpperCase()}
             · LID 0x${(p.lid ?? 0).toString(16).toUpperCase()}<br>
        风险：<span class="risk-${p.risk || 'low'}">${riskLabel(p.risk)}</span>${enHtml}
      </div>
      <label>目标值</label>
      ${input}
      <div class="acts">
        <button id="pRead">读当前值</button>
        <button id="pWrite" class="${ro ? '' : 'primary'}">写入</button>
      </div>
      <div class="hint">${ro ? (p.writeBlockedReason || '源数据无写服务，只能读') : ''}</div>
    </div>`;

  // 开关按钮选中态
  $('paramBox').querySelectorAll('.swBtn').forEach((b) => {
    b.onclick = () => {
      $('paramBox').querySelectorAll('.swBtn').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    };
  });
  $('pRead').onclick = () => doRead(p);
  $('pWrite').onclick = () => {
    if (ro) {
      toast('warn', `「${p.name}」是只读项`, p.writeBlockedReason || '源数据无写服务，只能读不能改');
      return;
    }
    const sw = $('paramBox').querySelector('.swBtn.sel');
    const raw = sw ? sw.dataset.v : ($('pVal')?.value ?? '0');
    const v = parseFieldInput(p, raw);
    if (v == null) {
      toast('err', '值无效', p.bitsize > 53 ? '请输入十进制或 0x 前缀的整数' : '请输入数字');
      return;
    }
    if (!fieldInRange(p, v)) {  // max=null 不能当 0 比较
      toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}`);
      return;
    }
    doWrite(p, v);
  };
  $('secParam').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function addrSafeForAction() {
  const st = state.currentAddr?.state;
  if (st && !['measured', 'probed', 'manual'].includes(st)) {
    toast('err', '拒绝执行', `当前地址是 ${st}（未实测）；例程/特殊功能可能真的动作，先探测或手工确认 tx/rx`);
    return false;
  }
  return true;
}

async function doWrite(p, v) {
  if (!needLink()) return;
  // 地址证据门禁：没有实测/探测/手工证据的候选地址，禁止写入。
  // 候选地址可能落到相邻 ECU，读都未必对，写更会改错模块。
  if (!addrSafeForAction()) return;
  if (!coder.seedKeyProvider) {
    toast('err', '拒绝写入', '缺口令算法变体');
    return;
  }
  // ⚠️ 未逐位验证的 seed/key 变体，写入前强制确认（2026-10-17 审计 D1）：
  //    指纹聚类显示多数变体是独立算法，用错会算错 key → 0x36 锁死。
  if (coder.seedKeyProvider && coder.seedKeyProvider.verified === false) {
    const okV = confirm(
      `⚠️ 「${coder.seedKeyProvider.name}」的算法**未逐位验证**。\n\n`
      + '用错变体会算出错误密钥 → ECU 拒绝 → 反复重试可能触发 0x36 锁死。\n\n'
      + '点「确定」= 我确认这个变体正确，继续写入\n'
      + '点「取消」= 中止（推荐，先做 校验 校验）');
    if (!okV) return;
  }
  // ⚠️ 写入必须显式确认（2026-10-16 审计 #22）：此前无 confirm 直接 dryRun:false 真写。
  const okWrite = confirm(
    `确认写入？\n\n参数：${p.name}\n新值：${decodeValue(p, v)}\n`
    + `（当前 ${p.currentValue !== undefined ? decodeValue(p, p.currentValue) : '?'}）\n\n`
    + '⚠️ 写入会改变车辆配置，请确认已导出备份。');
  if (!okWrite) return;
  // ⚠️ 变体未确认则拒绝写入（2026-10-17 审计）：多变体模块的 byte/bit 映射因变体而异，
  //    用错变体会写到错误字节。参考诊断仪靠版本信息（1A 92/94）识别变体。
  if (state.multiVariantModules?.has(p.module) && !state.selectedVariant?.[p.module]) {
    toast('err', `「${p.name}」变体未自动识别`,
      `${p.module} 存在多个变体，且没有匹配到当前 ECU 的识别串 —— 已用默认变体显示，但为防写错字节，写入被拒绝。请重新进模块或核对模块地址。`);
    return;
  }
  // canWrite 是**总闸**：含 WRITE_ENABLED 严格门禁开关 + 只读项 + 无 LID。
  // 此前它零调用，文档说「改 WRITE_ENABLED=false 可恢复严格门禁」实际无效。
  if (!canWrite(p)) {
    toast('err', `「${p.name}」不可写`,
      p.sidPairOk === false ? (p.writeBlockedReason || '源数据无写服务')
        : (p.lid == null && p.did == null) ? '缺 LID/DID'
          : '严格门禁未放行（WRITE_ENABLED=false 且未 write-confirmed）');
    return;
  }
  if (!fieldInRange(p, v)) {  // max=null 不能当 0 比较；BigInt/Number 混用由 helper 处理
    toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}`);
    return;
  }
  toast('info', `写入 ${p.name} = ${decodeValue(p, v)}`, '进会话 → 安全访问 → 写 → 回读校验 …');
  try {
    await coder.applyChange(p, v, { dryRun: false, session: 0x89, secLevel: 0x09 });
    p.currentValue = v;
    // ⚠️ 块缓存必须失效（2026-10-18 审计）：写入后 currentBlocks[p.lid] 还是旧字节，
    //    再点「读当前值」会拿缓存算出**写入前**的值，显示和车上实际不一致。
    if (p.lid != null) delete currentBlocks[p.lid];
    if (currentParam && currentParam.id === p.id) {
      renderParamDetail(p); // 立即刷新显示
    }
    toast('ok', `${p.name} 写入成功`, `当前值已更新为 ${decodeValue(p, v)}`);
  } catch (e) {
    const nrc = e instanceof CodingError ? e.nrc : null;
    toast('err', `${p.name} 写入失败`, e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
  }
}

function showSub(s) {
  $('secParam').style.display = '';
  const steps = (s.playbook?.steps || []).map((x, i) => `${i + 1}. ${x}`).join('<br>');
  const rid = s.routineId ?? s.id?.match(/0x[0-9A-Fa-f]+/)?.[0];
  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${s.label || s.id}<span class="tag">特殊功能</span></div>
      <div class="meta">
        风险：<span class="risk-${s.risk || 'low'}">${riskLabel(s.risk)}</span><br>
        ${steps || '（无步骤说明）'}
      </div>
      <div class="acts">
        <button id="pRun" class="primary">执行</button>
        <button id="pStop">停止</button>
        <button id="pResult">查结果</button>
      </div>
      <div class="hint">执行前确认车辆状态安全；高风险功能请先备份。</div>
    </div>`;
  // 例程轮询中止开关（点「停止」置位）—— MES 定论：用户取消时要发恢复命令，
  // 这里至少保证轮询能被打断，不会在后台继续敲 ECU。
  let routineAbort = false;
  const run = (sf, verb) => async () => {
    if (!needLink()) return;
    if (!rid) {
      // 菜单树里这类子功能只有名称，源数据没给可执行 ID —— 说清楚，并指出能用的路径。
      toast('err', `无法${verb}「${s.label || s.id}」`,
        '这条菜单没有对应的可执行例程 ID。请到「特殊功能」页执行；若仍失败，说明该菜单项在当前 ECU 上没有对应例程。');
      return;
    }
    const id = parseInt(String(rid).replace(/^0x/i, ''), 16);
    const risk = s.risk === 'high' ? '高风险功能，请确认车辆状态安全' : '';
    toast('info', `${verb}「${s.label || s.id}」`, risk || '已进入例程会话');
    try {
      await coder.enterSessionFor('routine');   // ← 10 86，对齐参考诊断仪
      if (coder.seedKeyProvider) {
        await coder.securityAccessEx({ level: 0x09, kwp: false });
      }
      // ⚠️ 长例程会先回 NRC 0x78（响应挂起）/ 0x21（忙），一次请求判成败会误报失败。
      //    MES 定论：发跟随服务 `31 03` 轮询直到响应不是 21/23/24/78（REAUDIT-20261017）。
      routineAbort = false;
      const { result: r, polled } = await coder.runRoutine(sf, id, '', {
        maxMs: 30000, intervalMs: 1500,
        shouldStop: () => routineAbort,
        onPoll: ({ polls, nrc }) => {
          if (polls === 1) toast('info', '例程执行中', 'ECU 回「未完成」，转 31 03 轮询结果 …');
          else if (polls % 4 === 0) toast('info', '例程执行中', `已轮询 ${polls} 次（最近 NRC 0x${(nrc ?? 0).toString(16)}）`);
        },
      });
      toast('ok', `「${s.label || s.id}」${verb}成功`,
        `应答 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}` +
        (polled ? ` · 轮询 ${polled} 次后取到结果` : ''));
    } catch (e) {
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `「${s.label || s.id}」${verb}失败`,
        e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
    }
  };
  $('pRun').onclick = () => {
    // 高风险项执行前二次确认（对齐 app 里其它危险操作的闸门）
    if (s.risk === 'high' && typeof confirm === 'function'
        && !confirm(`⚠️ 高风险特殊功能：${s.label || s.id}\n\n`
          + '会真的让 ECU 动作（匹配/复位/学习/驱动），可能改变车辆状态。\n'
          + '确认车辆状态安全后再继续。')) return;
    run(0x01, '执行')();
  };
  $('pStop').onclick = () => {
    routineAbort = true;
    run(0x02, '停止')();                      // stopRoutine + 打断轮询
  };
  $('pResult').onclick = run(0x03, '查结果'); // requestRoutineResults
}

async function doRead(p) {
  if (p.lid == null) { toast('err', '无法读取', '该参数缺 LID（源数据未给）'); return; }
  let block = currentBlocks[p.lid];
  let fromCache = true;
  if (!block) {
    if (!needLink()) return;
    toast('info', `读取 ${p.name}`, '缓存无此块，现读 …');
    fromCache = false;
    try {
      block = await coder.readBlock(p.lid, p.readSid ?? 0x21);
      currentBlocks[p.lid] = block;
    } catch (e) {
      toast('err', `${p.name} 读取失败`, e.message);
      return;
    }
  }
  const v = extractField(block, p);
  // ⚠️ 必须把读到的值写回参数对象（2026-10-18 审计）：此前只 toast，详情页仍显示旧值/
  //    未读到，用户再点写入时确认框里的「当前值」也是旧的。读当前值就要真的更新状态。
  if (v != null) p.currentValue = v;
  if (currentParam && currentParam.id === p.id) renderParamDetail(p);
  toast('ok', `${p.name} = ${decodeValue(p, v)}`,
    `原始值 ${v} · ${block.length} 字节${fromCache ? ' · 用进模块时读到的块' : ''}`);
}

// ---------- 写入 ----------
let pendingParam = null;
function openValueModal(p) {
  pendingParam = p;
  $('vmTitle').textContent = `「${p.name}」目标值`;
  const opts = $('vmOpts');
  opts.innerHTML = '';
  const entries = p.enum ? Object.entries(p.enum) : [];
  const cur = (p.currentValue == null) ? null : String(p.currentValue);
  for (const [k, v] of entries) {
    const b = document.createElement('button');
    b.textContent = v;
    if (cur != null && String(Number(k)) === cur) b.classList.add('sel');
    b.onclick = () => {
      $('vmInput').value = k;
      opts.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    };
    opts.appendChild(b);
  }
  // 预填当前值而不是第一项（否则直接点确定会写错值）
  const curEntry = entries.find(([k]) => cur != null && String(Number(k)) === cur);
  $('vmInput').value = curEntry ? curEntry[0] : (entries.length ? entries[0][0] : (cur ?? '1'));
  $('vmHint').textContent = `byte ${p.byte} bit ${p.bit} · 风险 ${riskLabel(p.risk)} · ` +
    `写 0x${(p.writeSid ?? 0x3B).toString(16).toUpperCase()} LID 0x${(p.lid ?? 0).toString(16).toUpperCase()}`;
  $('valueModal').classList.add('show');
}
$('vmCancel').onclick = () => $('valueModal').classList.remove('show');
$('vmOk').onclick = async () => {
  const p = pendingParam;
  const v = Number($('vmInput').value);
  if (!Number.isFinite(v)) { log('值无效', 'err'); return; }
  $('valueModal').classList.remove('show');
  if (!coder) { log('未连接', 'err'); return; }
  if (!coder.seedKeyProvider) { log('缺口令算法，拒绝写入', 'err'); return; }
  // 2026-10-19：值弹窗此前跳过 canWrite（只查 seedKey），与 doWrite 不同口径。
  // 对齐：同一套闸门（canWrite 总闸 + 值域），与 doWrite 完全一致。
  if (!canWrite(p)) {
    log(`「${p.name}」不可写`, 'err');
    return;
  }
  if (!fieldInRange(p, v)) {
    log(`值超出范围：可填 ${p.min} … ${p.max}，当前 ${v}`, 'err');
    return;
  }
  log(`—— 写入 ${p.name} = ${decodeValue(p, v)} ——`, 'info');
  try {
    await coder.applyChange(p, v, { dryRun: false, session: 0x89, secLevel: 0x09 });
    p.currentValue = v;
    if (p.lid != null) delete currentBlocks[p.lid];   // 同上：块缓存失效
    log('✅ 写入成功，回读一致', 'ok');
  } catch (e) {
    log(`❌ ${e.message}`, 'err');
    if (e instanceof CodingError && e.nrc != null) log(`   NRC 0x${e.nrc.toString(16)}`, 'err');
  }
};

// ---------- 备份 / 导出 / 分享 ----------
$('btnBackup').onclick = async () => {
  if (!needLink()) return;
  const p = currentParam;
  const lid = p && (p.lid ?? p.did);
  if (lid == null) {
    toast('warn', '先选一个参数', '备份要指定编码块（需要参数的 LID）');
    return;
  }
  toast('info', `备份 ${p.name}`, `LID 0x${lid.toString(16).toUpperCase()} …`);
  try {
    await coder.enterSession(0x89);
    const block = await coder.readBlock(lid, p.readSid ?? 0x21);
    coder.backups.push({
      id: 'backup', lid, readSid: p.readSid, writeSid: p.writeSid, session: 0x89,
      time: new Date().toISOString(),
      raw: block.map((b) => b.toString(16).padStart(2, '0')).join(''),
      name: p.name,
    });
    toast('ok', '备份完成', `${p.name} · ${block.length} 字节 · 共 ${coder.backups.length} 份`);
  } catch (e) {
    toast('err', '备份失败', e.message);
  }
};
$('btnExport').onclick = () => openShare(
  coder ? JSON.stringify(coder.exportBackups(), null, 2) : logEl.textContent);
function openShare(text) {
  $('shareTa').value = text;
  $('shareModal').classList.add('show');
}
$('mClose').onclick = () => $('shareModal').classList.remove('show');
$('mCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('shareTa').value); log('已复制', 'ok'); } catch { }
};
$('mShare').onclick = async () => {
  try { await navigator.share({ text: $('shareTa').value }); } catch { }
};
$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(logEl.textContent); log('日志已复制', 'ok'); } catch { }
};
$('btnShare').onclick = () => openShare(logEl.textContent);

// ---------- 载入 ----------
async function loadAll() {
  // ★ 按车型×模块×变体 懒加载（全量 987K 条太大，不能一次载入）
  const [t, cat, c, ea] = await Promise.all([
    fetch('data/menu-tree-v3.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/models-catalog.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/coding-v2.json').then((r) => r.ok ? r.json() : null)
      .catch(() => null)
      .then((x) => x || fetch('data/coding.json').then((r) => r.json())),
    // 2026-10-19：RE 寻址表预取（原先在 enterSystem 里懒加载 → 首次点模块必然失败）
    fetch('data/ecu-addresses.json').then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (ea) ecuAddrTable = ea;
  tree = t;
  modelsCatalog = cat;
  coding = (c.params || []).filter((p) => validateParam(p).length === 0);
  if (modelsCatalog?.models) {
    const n = Object.keys(modelsCatalog.models).length;
    const nv = Object.values(modelsCatalog.models).reduce((a, m) => a + (m.modules || []).reduce((b, x) => b + x.variants.length, 0), 0);
    log(`载入 ${n} 个车型 / ${nv} 个模块变体（按需加载）`, 'ok');
  }
  if (!tree) {
    log('⚠️ 菜单数据未就绪，用参数表兜底', 'info');
    tree = {
      topLevel: [{ id: '手动选择', kind: 'manual', label: '手动选择', groups: [] }],
      groups: [{
        id: 'fallback', label: '（未识别车型）', models: [{
          id: 'fb', label: '（未识别车型）',
          functions: [{ id: '设码', kind: 'syssel', systems: [] }],
        }],
      }],
    };
  }
  log(`载入 ${coding.length} 个参数`, 'ok');
  renderNav();
}

loadAll().catch((e) => log('载入失败: ' + e.message, 'err'));

// ---------- 模块扩展功能（读故障码 / 数据流 / 执行器 / 特殊功能）----------
async function showSysExtra(f) {
  $('secParam').style.display = '';
  const sys = f._sys || {};
  const kind = f.kind;
  // ⚠️ 2026-10-18 审计：`esc` 原来只定义在 `kind === 'special'` 分支里，
  //    但 measure / actuator 分支也用了它 —— 那两个页面一点就 ReferenceError。
  //    提到函数作用域，所有分支共用。
  const esc = (x) => String(x ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // 版本信息页面自己渲染 paramBox，不需要先塞「暂不支持」再覆盖（会闪一下）。
  if (kind === 'identity') { await renderIdentity(sys); return; }
  let actions = '';
  if (kind === 'dtc') {
    actions = `<div class="acts">
      <button id="xReadDtc" class="primary">读故障码</button>
      <button id="xClearDtc">清故障码</button></div>
      <div id="dtcResult" class="dtcList"></div>`;
  } else if (kind === 'program') {
    // 只生成 HTML；按钮 handler 统一在 `$('paramBox').innerHTML = ...` **之后**绑定。
    // ⚠️ 2026-10-18 审计：此前 HTML 和 handler 都写在这个分支里，而 handler 在
    //    paramBox.innerHTML 赋值**之前**执行 → `$('xProgRead')` 恒为 null，
    //    点「编程」直接抛 TypeError，后面的 `$('xProgWrite')` 也不会绑定。
    //    这也是「编程」功能一直不可用的根因。
    actions = `<label>编程块 LID（十六进制）</label>
      <input id="xProgLid" placeholder="如 9A">
      <div class="acts">
      <button id="xProgRead" class="primary">读当前值</button>
      <button id="xProgWrite">写入</button>
      <button id="xProgVerify">校验</button></div>
      <div class="hint">默认按 KWP 读 0x21 / 写 0x3B；若该块是 UDS（22/2E），勾选下面的协议再操作。<br>
      编程按标准流程：<b>读当前值 → 修改 → 写入 → 回读校验</b>。高风险，请先备份。</div>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="xProgUds"> 该块使用 UDS（22/2E）</label>`;
  } else if (kind === 'special') {
    // ★ 特殊功能（只列「本平台确认可执行」的项）
    //
    // 一条特殊功能 = 一段完整命令序列，不是单个 RID：
    //   读状态(21/22) → 启动例程(31 01) → 查结果(31 03) → 驱动/写入(2F/2E) → 停止(31 02)
    // 数据来自 special-function-map.json（功能项 → 各平台实现）
    // 与 function-sequences.json（实现函数 → 命令序列）。
    //
    // 展示口径：只显示当前车型平台有实现、且序列非空的项。
    // 其他平台有实现的、本版本没有实现的，一律不列 —— RID 与 ECU 绑定，
    // 跨平台发出去要么没响应，要么命中另一个例程。
    const [mapData, seqData] = await Promise.all([
      fetch('data/special-function-map.json').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('data/function-sequences.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    fnSeqData = seqData;

    const plat = platformForModel(currentModel);
    const nrm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const up = (x) => String(x || '').toUpperCase();
    const sysNorm = nrm(sys.label);
    const sysHay = up(sys.label) + ' ' + (sys.modules || []).map(up).join(' ');
    const sysAliases = mapData?.systemAliases || {};
    // 按词切分而不是子串包含：「ACC(巡航)」不能因为含 AC 就命中「空调」，
    // 「Frontkamera」也不能因为含 Front 就命中「前端电子设备」。
    const wordTokens = (s) => {
      const out = new Set();
      String(s || '').replace(/[^A-Za-z0-9]+/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => {
        out.add(w.toUpperCase());
        (w.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) || []).forEach((p) => out.add(p.toUpperCase()));
      });
      return out;
    };
    const sysTokens = wordTokens(sysHay);
    const sysConcat = sysHay.replace(/[^A-Z0-9]/g, '');
    const aliasHit = (a) => sysTokens.has(a)
      || (a.length >= 5 && sysConcat.includes(a))
      || [...sysTokens].some((t) => t.startsWith(a) && /^\d*$/.test(t.slice(a.length)));

    // 功能项 → 当前系统：中文名互含 / 别名表 / 拉丁代码重合
    const hitSystem = (it) => {
      const a = nrm(it.system);
      if (a && sysNorm && (a === sysNorm || a.includes(sysNorm) || sysNorm.includes(a))) return true;
      if ((sysAliases[a] || []).some(aliasHit)) return true;
      return [...wordTokens(it.system)].some((t) => sysTokens.has(t));
    };
    const implFor = (it) => it.impls.find((x) => x.platforms.includes(plat))
      || it.impls.find((x) => x.platforms.includes('ALL'));

    // 只保留「本平台有实现 + 序列非空 + 映射已确认」的项。
    // verified=false 的是语义对不上、或同一函数无法区分正反操作的（比如
    // "去标准化" 和 "标准化" 指向同一段序列），宁可不显示也不给错按钮。
    // 另外按「名称 + 实现函数」去重：左右设备两条菜单指向同一段序列时只留一条。
    const picked = [];
    const seenKey = new Set();
    for (const it of (mapData?.maps || []).filter(hitSystem)) {
      if (it.status !== 'ok' || it.verified === false) continue;
      const c = implFor(it);
      if (!c) continue;
      const key = `${it.sub}|${c.name}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      picked.push({ it, impl: c });
    }
    const items = picked.map((x) => x.it);

    let html = '';
    if (!plat) {
      html += `<div class="hint">未识别车型平台 —— 先选车型，再看该模块的特殊功能。</div>`;
    } else if (!items.length) {
      html += `<div class="hint">该模块在平台 <b>${esc(plat)}</b> 上没有可执行的特殊功能。</div>`;
    } else {
      html += `<div class="hint" style="margin-bottom:8px">
        特殊功能 · 系统 <b>${esc(sys.label)}</b> · 平台 <b>${esc(plat)}</b> · 共 <b>${items.length}</b> 项
      </div>`;
      html += `<div class="specialList">${picked.map(({ it, impl: c }) => {
        const ridText = (c.rids || []).length ? ` · 例程 ${esc(c.rids.slice(0, 3).join(' / '))}` : '';
        return `
        <div class="specialItem">
          <div class="siName">${esc(it.sub)}</div>
          <div class="siMeta">${c.cmdCount} 步命令${ridText}</div>
          <div class="siActs">
            <button class="seqRun" data-fn="${esc(c.name)}" data-label="${esc(it.sub)}">执行</button>
            <button class="seqView" data-fn="${esc(c.name)}" data-label="${esc(it.sub)}">查看步骤</button>
          </div>
        </div>`;
      }).join('')}</div>`;
      html += `<div class="hint" style="margin-top:8px">
        首次执行先点「查看步骤」核对；执行前确认车辆状态安全（熄火 / 拉手刹 / 必要时上举升机）。
      </div>`;
    }
    actions = html;
  } else if (kind === 'measure') {
    const measureData = await fetch('data/measure.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const modNamesM = (sys.modules || []).map((x) => String(x));
    const sysNormM = (sys.label || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const measures = (measureData?.params || []).filter((m) => {
      const mn = String(m.module || '');
      if (modNamesM.includes(mn)) return true;
      const n2 = mn.toLowerCase().replace(/[^a-z0-9]/g, '');
      return n2 && sysNormM && (n2.includes(sysNormM) || sysNormM.includes(n2));
    }).slice(0, 100);
    if (measures.length) {
      actions = `<div class="specialList">${measures.slice(0, 30).map((m, i) => `
        <div class="specialItem" id="meCard${i}">
          <div class="siName">${esc(m.name || '测量值 ' + i)}</div>
          <div class="siMeta">${m.kind === 'enum' ? '枚举' : m.kind === 'switch' ? '开关' : '数值'}${m.unit ? ' · 单位: ' + esc(m.unit) : ''}${m.min != null ? ' · 范围: ' + m.min + '..' + (m.max ?? '?') : ''}</div>
          <div class="siVal" id="meVal${i}" style="font-size:16px;font-weight:600;color:var(--acc);margin:6px 0">—</div>
          <div class="siActs"><button class="meRead" data-id="${esc(m.id || i)}" data-idx="${i}">读取</button></div>
        </div>`).join('')}</div>
        ${measures.length > 30 ? `<div class="hint">显示前 30 条 / 共 ${measures.length} 条</div>` : ''}`;
    } else {
      actions = `<div class="hint">暂无测量值数据</div>`;
    }
  } else if (kind === 'actuator') {
    // ⚠️ 用 GAG 实测的 2F DID 全集（2026-10-17 审计 F3）：
    //    此前的 actuator.json 分支是死代码，且其 items 只有 name+chain、**无 DID** → 发不出 2F。
    //    gag-actuators.json 是 3139 条实测请求里的 154 条 2F，71 个真实 DID + 控制形态。
    const gact = await fetch('data/gag-actuators.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const acts = (gact?.items || []);
    if (acts.length) {
      actions = `<div class="hint">实测 2F DID 共 ${acts.length} 个（drive=ctrl 0x03 + 状态 · 回位=ctrl 0x00）。
        <br>⚠️ 名称是占位（chain↔DID 映射在 ODX 里未解），按 DID 操作。</div>
        <div class="specialList">${acts.slice(0, 40).map((a, i) => `
        <div class="specialItem">
          <div class="siName">${esc(a.name)}</div>
          <div class="siMeta">DID ${esc(a.didHex || '0x' + Number(a.did).toString(16).toUpperCase().padStart(4, '0'))} · drive: ctrl 0x03 + ${esc(a.drive.state)} · 回位: ctrl 0x00</div>
          <div class="siActs">
            <button class="actOn" data-did="${a.did}" data-state="${esc(a.drive.state)}">驱动</button>
            <button class="actOff" data-did="${a.did}">回位</button>
          </div>
        </div>`).join('')}</div>
        ${acts.length > 40 ? `<div class="hint">…另有 ${acts.length - 40} 个 DID，可用下方手输</div>` : ''}
        <div class="hint" style="margin-top:10px">手动 DID（十六进制，最多 4 位）</div>
        <div class="siActs">
          <input id="xDid" value="045B" placeholder="如 045B" style="width:96px">
          <button id="xActOn" class="primary">驱动</button>
          <button id="xActOff">回位</button>
        </div>`;
    } else {
      actions = `<div class="hint">暂无执行器数据；可手输 DID 直接发 2F</div>
        <div class="siActs">
          <input id="xDid" value="045B" placeholder="如 045B" style="width:96px">
          <button id="xActOn" class="primary">驱动</button>
          <button id="xActOff">回位</button>
        </div>`;
    }
  } else {
    actions = `<div class="hint">暂不支持</div>`;
  }
  $('paramBox').innerHTML = `
    <div class="param">
      <div class="nm">${f.id}<span class="tag">${sys.label || ''}</span></div>
      <div class="meta">${f.meta || ''}</div>
      ${actions}
      <div class="hint">会话按 参考诊断仪服务类型切换（故障码 10 03 / 执行器 10 85 / 例程 10 86）</div>
    </div>`;
  const run = async (fn, verb) => {
    if (!needLink()) return;
    toast('info', `${verb} …`, sys.label || '');
    try {
      const r = await fn();
      toast('ok', `${verb}成功`, r || '');
    } catch (e) {
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `${verb}失败`, e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
    }
  };

  // 特殊功能按钮事件
  // ★ 例程执行统一入口 —— 全部走 runRoutine（回 NRC 78/21 时自动 31 03 轮询）。
  // ⚠️ 此前 `.spRun` 直接 `routineControl(1, rid, '')` 发一次就判成败，
  //    长例程（排气/校准/匹配）ECU 先回 7F 31 78 → 这里误报「执行失败」。
  const parseHex = (s) => {
    const t = String(s ?? '').trim().replace(/^0x/i, '');
    if (!/^[0-9A-Fa-f]+$/.test(t)) return NaN;
    return parseInt(t, 16);
  };
  const execRoutine = async ({
    rid, sub = 0x01, params = '', label = '', poll = true, confirmText = null,
  }) => {
    if (!needLink()) return;
    if (!addrSafeForAction()) return;
    if (!Number.isFinite(rid) || rid < 0 || rid > 0xffff) {
      toast('err', 'RID 无效', '请输入 0000–FFFF 的十六进制例程 ID'); return;
    }
    if (!Number.isFinite(sub) || sub < 0 || sub > 0xff) {
      toast('err', '子功能无效', '请输入 00–FF 的十六进制'); return;
    }
    if (params && (params.length % 2 || !/^[0-9A-Fa-f]+$/.test(params))) {
      toast('err', '参数无效', '参数须为偶数位十六进制（如 0100），不要带空格'); return;
    }
    if (confirmText && typeof confirm === 'function' && !confirm(confirmText)) return;
    const verb = sub === 0x01 ? '执行' : sub === 0x02 ? '停止' : sub === 0x03 ? '查结果' : `子功能 0x${sub.toString(16)}`;
    const ridHex = rid.toString(16).toUpperCase().padStart(4, '0');
    showLoading(`${verb}例程中…`, `${label ? label + ' · ' : ''}31 ${sub.toString(16).toUpperCase().padStart(2, '0')} ${ridHex}${params ? ' ' + params : ''}`);
    try {
      await coder.enterSessionFor('routine');            // 10 86，对齐参考诊断仪
      if (coder.seedKeyProvider && sub !== 0x02) {
        // KWP(21/1A) 与 UDS(22) 的安全访问不是一套；readBlock 已记录最近读服务。
        const kwp = coder.lastReadSid != null && coder.lastReadSid !== 0x22;
        await coder.securityAccessEx({ level: kwp ? 0x00 : 0x09, kwp });
      }
      const { result: r, polled } = await coder.runRoutine(sub, rid, params, {
        maxMs: 30000, intervalMs: 1500, poll,
        onPoll: ({ polls }) => {
          if (polls === 1) toast('info', '例程执行中', 'ECU 回「未完成」，转 31 03 轮询 …');
          else if (polls % 4 === 0) toast('info', '例程执行中', `已轮询 ${polls} 次`);
        },
      });
      hideLoading();
      // 2026-10-19：不向用户打原始响应字节（hex）——参考诊断仪 只显示结果状态。
      // 原始字节进日志供调试，toast 只报人话。
      const nBytes = (r?.body || []).length;
      const detail = polled ? `轮询 ${polled} 次后取到结果` : (nBytes ? `ECU 已响应（${nBytes} 字节）` : 'ECU 已确认');
      log(`  响应原文：${(r?.body || []).map((x) => x.toString(16).padStart(2, '0')).join(' ')}`, 'info');
      toast('ok', `${verb}成功`, detail);
    } catch (e) {
      hideLoading();
      const nrc = e instanceof CodingError ? e.nrc : null;
      let msg = e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : '');
      // 参考诊断仪 菜单项与 ECU 实际 RID 不一定是同一个；0x31 明确告诉用户不是“车坏了”。
      if (nrc === 0x31) msg += ' —— 当前 ECU 没有这个例程 ID；该功能项可能对应别的例程 ID。';
      toast('err', `${verb}失败`, msg);
    }
  };

  const RISK_TIP = '例程会真的让 ECU 动作（匹配/复位/学习/驱动）。\n确认车辆状态安全（熄火/拉手刹/必要时上举升机）再执行。';

  /**
   * 执行**完整命令序列**（不是只发一条 31）。
   *
   * 序列成分（实测 P9x1_TIP_Oil_Filling）：
   *   21/22 读状态 → 31 01 启动例程 → 31 03 查结果 → 2F IO 控制 → 31 02 停止
   * 安全策略：
   *   · 读命令（21/22/19/1A）失败 → 跳过继续
   *   · 例程（31 01/03）失败 → 停止
   *   · 写入（2E/3B/2F/14/11）失败 → 停止
   */
  const runSequence = async (fnName, label) => {
    const f = fnSeqData?.functions?.find((x) => x.name === fnName);
    if (!f) { toast('err', '找不到执行步骤'); return; }
    if (!needLink()) return;
    if (!addrSafeForAction()) return;
    const cmds = f.cmds || [];
    const isWrite = (c) => /^(2E|3B|2F|14|11)/i.test(c.replace(/\s/g, ''));
    const isRead = (c) => /^(21|22|19|1A)/i.test(c.replace(/\s/g, ''));
    const nWrite = cmds.filter(isWrite).length;
    const ok = confirm(
      `执行「${label}」的完整序列？\n\n`
      + `共 ${cmds.length} 条命令，其中写入类 ${nWrite} 条。\n\n`
      + `该序列是完整执行流程：读状态 → 启动例程 → 查结果 → 写参数 → 停止。\n`
      + `⚠️ 写入会改变 ECU 配置，请确认已备份。\n\n${RISK_TIP}`);
    if (!ok) return;

    showLoading(`执行「${label}」`, `0 / ${cmds.length}`);
    let done = 0;
    try {
      await coder.enterSessionFor('routine');
      if (coder.seedKeyProvider) {
        // 序列里出现 21/1A 读 = KWP；出现 22 读 = UDS。不能用上一个模块的 lastReadSid。
        const kwp = cmds.some((c) => /^(21|1A)/i.test(c.replace(/\s/g, '')))
          && !cmds.some((c) => /^22/i.test(c.replace(/\s/g, '')));
        await coder.securityAccessEx({ level: kwp ? 0x00 : 0x09, kwp }).catch(() => {});
      }
      for (const c of cmds) {
        const raw = c.replace(/\s/g, '').toUpperCase();
        const sid = parseInt(raw.slice(0, 2), 16);
        done += 1;
        updateLoading(`执行「${label}」`, `${done} / ${cmds.length}　${raw.slice(0, 20)}`);
        try {
          if (sid === 0x31) {
            const sub = parseInt(raw.slice(2, 4), 16);
            const rid = parseInt(raw.slice(4, 8), 16);
            const params = raw.slice(8);
            if (sub === 0x01 || sub === 0x03) {
              await coder.runRoutine(sub, rid, params, { maxMs: 15000, intervalMs: 1200, poll: false });
            } else {
              await coder.routineControl(sub, rid, params);
            }
          } else if (sid === 0x27 || sid === 0x17) {
            await coder.securityAccessEx({ level: 0x09, kwp: sid === 0x17 }).catch(() => {});
          } else {
            await coder.uds(raw, 6000, { allowEmpty: isRead(raw) });
          }
          log(`  ✅ ${done}/${cmds.length} ${raw.slice(0, 24)}`, 'ok');
        } catch (e) {
          const nrc = e instanceof CodingError ? e.nrc : null;
          if (isRead(raw)) {
            log(`  （跳过读 ${raw.slice(0, 12)}：${e.message}）`, 'warn');
            continue;
          }
          throw new CodingError(
            `第 ${done}/${cmds.length} 步失败：${raw.slice(0, 24)} —— ${e.message}` +
            (nrc ? `（NRC 0x${nrc.toString(16)}）` : '') +
            `\n序列已中止（未继续后续步骤）。`, nrc);
        }
      }
      hideLoading();
      toast('ok', `「${label}」序列完成`, `${cmds.length} 条命令全部执行`);
    } catch (e) {
      hideLoading();
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `「${label}」中止`, e.message + (nrc ? '' : ''));
    }
  };
  $('paramBox').querySelectorAll('.seqRun').forEach((b) => {
    b.onclick = () => runSequence(b.dataset.fn, b.dataset.label || b.dataset.fn);
  });
  $('paramBox').querySelectorAll('.seqView').forEach((b) => {
    b.onclick = () => {
      const f = fnSeqData?.functions?.find((x) => x.name === b.dataset.fn);
      if (!f) { toast('err', '找不到执行步骤'); return; }
      const label = b.dataset.label || '特殊功能';
      log(`\n=== ${label} 执行步骤（${f.cmdCount} 步）===`, 'info');
      f.cmds.forEach((c, i) => log(`  ${String(i + 1).padStart(2)}. ${c}`, 'info'));
      toast('info', `${f.cmdCount} 步已打印到日志`, '点右上「日志」查看');
    };
  });

  $('paramBox').querySelectorAll('.spRun, .vRun').forEach((b) => {
    if (b.disabled) return;
    b.onclick = () => execRoutine({
      rid: parseHex(b.dataset.rid),
      sub: parseHex(b.dataset.sub || '01'),
      params: String(b.dataset.params || '').replace(/\s+/g, ''),
      label: b.dataset.name || b.dataset.rid,
      // 普通界面只显示中文功能名；RID 留在高级/调试里。
      confirmText: `确认执行「${b.dataset.name || b.dataset.rid}」？\n\n${RISK_TIP}`,
    });
  });
  $('paramBox').querySelectorAll('.spStop, .vStop').forEach((b) => {
    b.onclick = () => execRoutine({ rid: parseHex(b.dataset.rid), sub: 0x02, poll: false, label: b.dataset.name || b.dataset.rid });
  });
  $('paramBox').querySelectorAll('.spResult, .vResult').forEach((b) => {
    b.onclick = () => execRoutine({ rid: parseHex(b.dataset.rid), sub: 0x03, label: b.dataset.name || b.dataset.rid });
  });
  // 手动指定 RID
  const mRid = $('mRid'), mSub = $('mSub'), mParams = $('mParams');
  const readManual = (sub) => ({
    rid: parseHex(mRid?.value),
    sub: sub ?? (parseHex(mSub?.value) || 0x01),
    params: String(mParams?.value || '').replace(/[^0-9A-Fa-f]/g, ''),
    label: '手动 RID',
  });
  $('paramBox').querySelectorAll('.mRun').forEach((b) => {
    b.onclick = () => execRoutine({
      ...readManual(),
      confirmText: `确认执行手动指定的例程？\n\n${RISK_TIP}`,
    });
  });
  $('paramBox').querySelectorAll('.mResult').forEach((b) => {
    b.onclick = () => execRoutine({ ...readManual(0x03) });
  });

  // 数据流读取按钮
  $('paramBox').querySelectorAll('.meRead').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      const idx = parseInt(b.dataset.idx);
      // ⚠️ 下标必须对上**过滤后**列表（2026-10-17 审计 F4）：data-idx 是过滤后下标，
      //    之前却拿去查全量 params[idx] → 显示的名字和读的值必然不对应。
      const measureData = await fetch('data/measure.json').then(r => r.ok ? r.json() : null).catch(() => null);
      const allM = measureData?.params || [];
      const wantId = b.dataset.id;
      const m = wantId ? allM.find((x) => x.id === wantId) : allM[idx];
      if (!m) return;
      try {
        await coder.enterSessionFor('measure');
        // ⚠️ 必须用真实 pid/sid（2026-10-16 审计 ★5a）：
        //    此前 m.lid 恒 undefined → 发 `21 00`，且只取首字节 ——
        //    857/1719 条参数 bitsize>8 全部读错。现已回填 readSid/pid（1719/1719）。
        const pid = m.pid ?? m.lid;
        const sid = m.readSid ?? 0x21;
        if (pid == null) throw new Error('该测量项缺 pid，无法读取');
        const r = await coder.readBlock(pid, sid);
        if (!r || !r.length) throw new Error('空响应');
        // 多字节字段用位域提取（BigInt，支持 bitsize>32）
        // ⚠️ 一律用 extractField（2026-10-17 审计 F5）：此前 bitsize<=8 就取 r[0]，
        //    忽略 byte 偏移 —— 实测 1719 条里 489 条 bitsize<=8 且 byte>0 全部读错。
        const raw = (typeof extractField === 'function')
          ? (extractField(r, m) ?? r[0] ?? 0)
          : (r[0] ?? 0);
        // ★ 解码显示人能读懂的值
        let display = '';
        if (m.kind === 'switch' && m.enum) {
          // ⚠️ 别用 `'0x0'+raw`：raw≥16 时拼出 3 位十六进制（'0x010'），查表必失配
          display = m.enum['0x' + raw.toString(16).toUpperCase().padStart(2, '0')]
            || m.enum[String(raw)] || String(raw);
        } else if (m.kind === 'enum' && m.enum) {
          const key = '0x' + raw.toString(16).toUpperCase().padStart(2, '0');
          display = m.enum[key] || m.enum[String(raw)] || `未知(${raw})`;
        } else {
          display = String(raw) + (m.unit && m.unit.length < 5 ? ' ' + m.unit : '');
        }
        const el = document.getElementById(`meVal${idx}`);
        if (el) el.textContent = display;
        toast('ok', `${m.name} = ${display}`, '');
      } catch (e) {
        toast('err', `${m.name} 读取失败`, e.message);
      }
    };
  });

  // 执行器驱动按钮
  // ⚠️ 必须真的发 `2F` IOControl —— 此前只 enterSession 就弹「已驱动/已回位」，
  //    总线上什么都没发生，用户以为执行器动了（2026-10-16 复查 P10）。
  const runAct = async (b, controlOption, label) => {
    if (!needLink()) return;
    try {
      // ⚠️ DID 直接来自按钮 data-did（GAG 实测值），不再从 actuator.json 查（那个没 DID）
      const did = parseInt(b.dataset.did, 10);
      if (!Number.isFinite(did)) throw new Error('缺少 DID');
      const state = b.dataset.state || '';
      await coder.enterSessionFor('io');
      // 0x03 = shortTermActivate（驱动）；0x00 = returnControlToECU（回位）
      const st = controlOption === 0x03 ? (state.replace(/ /g, '') || 'FF000000') : '';
      const r = await coder.ioControl(did, controlOption, st);
      if (r?.kind === 'nrc') throw new Error(`NRC 0x${r.code?.toString(16)}`);
      toast('ok', `执行器${label}成功`, `DID 0x${Number(did).toString(16).toUpperCase()}`);
    } catch (e) {
      toast('err', `${label}失败`, e.message);
    }
  };
  $('paramBox').querySelectorAll('.actOn').forEach((b) => {
    b.onclick = () => runAct(b, 0x03, '驱动');
  });
  $('paramBox').querySelectorAll('.actOff').forEach((b) => {
    b.onclick = () => runAct(b, 0x00, '回位');
  });
  if (kind === 'identity') {
    await renderIdentity(sys);
    return;
  }
  if (kind === 'dtc') {
    $('xReadDtc').onclick = async () => {
      if (!needLink()) return;
      showLoading('正在读取故障码', sys.label || '');
      try {
        await coder.enterSessionFor('ident');
        const r = await coder.readDtc(0x02, 0x89);
        // ⚠️ UDS（59）和 KWP（58）的应答头不同，必须分开解析（2026-10-18 审计）。
        //    此前只按 UDS `slice(3)`，readDtc 回退到 KWP 时会整体错位 → 显示垃圾码。
        const parsed = parseDtcPayload(r.body);
        const dtcs = parsed.dtcs;
        if (parsed.protocol === 'unknown') {
          const rawHex = parsed.raw.map((x) => x.toString(16).padStart(2, '0')).join(' ');
          const el = $('dtcResult') || document.querySelector('#dtcResult');
          if (el) el.innerHTML = `<div class="dtcItem"><div class="dtcCode">未知格式</div>`
            + `<div class="dtcDesc">原始应答：${rawHex || '(空)'} —— 无法识别 59/58 头，未做猜测</div></div>`;
          hideLoading();
          toast('warn', '故障码格式未知', `原始应答：${rawHex || '(空)'}`);
          return;
        }
        // ⚠️ 接上 dtc.json 的描述（审计 #10）：4059 条里 3808 条是中文描述。
        //    码是 5 位（P00C7），库里是 7 位（P00C700，含 failure type 字节）→ 按前缀匹配。
        if (!window.__dtcTable) {
          try {
            const dj = await fetch('data/dtc.json').then((r) => (r.ok ? r.json() : null));
            const tbl = {};
            for (const plat of Object.values(dj?.platforms || {})) {
              for (const it of (plat || [])) {
                const key = String(it.code || '').slice(0, 5).toUpperCase();
                if (key && it.desc && !tbl[key]) tbl[key] = it.desc;
              }
            }
            window.__dtcTable = tbl;
          } catch (e) { window.__dtcTable = {}; }
        }
        const dtcTable = window.__dtcTable || {};
        const escD = (x) => String(x ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const el = $('dtcResult') || document.querySelector('#dtcResult');
        if (el) {
          el.innerHTML = dtcs.length
            ? dtcs.map((d) => {
                const desc = dtcTable[d.code.toUpperCase()] || '';
                return `<div class="dtcItem"><div class="dtcCode">${escD(d.code)}</div>`
                  + `<div class="dtcDesc">${desc ? escD(desc) : '(无描述)'} · 状态 0x${d.status.toString(16).padStart(2, '0')}</div></div>`;
              }).join('')
            : '<div class="dtcNone">✅ 无故障码</div>';
        }
        hideLoading();
        const protoLabel = parsed.protocol === 'kwp' ? 'KWP 18' : 'UDS 19';
        toast('ok', '故障码读取完成',
          dtcs.length ? `${dtcs.length} 个故障码 · ${protoLabel}` : `无故障码 · ${protoLabel}`);
      } catch (e) {
        hideLoading();
        toast('err', '故障码读取失败', e.message);
      }
    };
    $('xClearDtc').onclick = async () => {
      if (!needLink()) return;
      showLoading('正在清除故障码', '');
      try {
        await coder.enterSessionFor('ident');
        await coder.clearDtc();
        hideLoading();
        toast('ok', '故障码已清除', '');
        const el = $('dtcResult') || document.querySelector('#dtcResult');
        if (el) el.innerHTML = '<div class="dtcNone">✅ 已清除，无故障码</div>';
      } catch (e) {
        hideLoading();
        toast('err', '清除失败', e.message);
      }
    };
  } else if (kind === 'program') {
    // ⚠️ 2026-10-18 审计：原实现的写入 handler 里引用了未定义的 `readSid`
    //    （ReferenceError），且无论块是 KWP 还是 UDS 都硬发 0x3B —— 编程功能实际不可用。
    //    现在按用户勾选决定 21/3B（KWP）或 22/2E（UDS），并统一走同一条读/写/回读路径。
    const progProto = () => {
      const uds = !!($('xProgUds') && $('xProgUds').checked);
      return { uds, readSid: uds ? 0x22 : 0x21, writeSid: uds ? 0x2E : 0x3B, idPad: uds ? 4 : 2 };
    };
    const progRun = async (verb, fn) => {
      if (!needLink()) return;
      const lid = parseInt($('xProgLid').value || '', 16);
      if (Number.isNaN(lid)) { toast('err', 'LID 无效', '请输入十六进制 LID'); return; }
      const { idPad } = progProto();
      if (lid < 0 || lid > (idPad === 4 ? 0xffff : 0xff)) {
        toast('err', 'LID 超出位宽', idPad === 4 ? 'UDS DID 为 2 字节（0000–FFFF）' : 'KWP LID 为 1 字节（00–FF）');
        return;
      }
      toast('info', `${verb} …`, `LID 0x${lid.toString(16).toUpperCase()}`);
      try {
        const r = await fn(lid);
        toast('ok', `${verb}成功`, r || '');
      } catch (e) {
        const nrc = e instanceof CodingError ? e.nrc : null;
        toast('err', `${verb}失败`, e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
      }
    };
    $('xProgRead').onclick = () => progRun('读编程块', async (lid) => {
      const { readSid } = progProto();
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, readSid);
      return blk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    });
    $('xProgWrite').onclick = () => progRun('写编程块', async (lid) => {
      // 必须显式给出完整块 + 长度校验 + 回读校验；不允许「读到什么就写回什么」。
      // 2026-10-19 对齐 参考诊断仪：备份 → 写入 → 回读 → 失败恢复。
      const input = prompt(
        `要写入 LID 0x${Number(lid).toString(16).toUpperCase()} 的完整块（十六进制，空格可选）：\n`
        + '留空 = 取消。请先复制当前块、改好再粘回。', '');
      if (input == null || !input.trim()) return '已取消';
      const clean = input.replace(/[^0-9A-Fa-f]/g, '');
      if (!clean || clean.length % 2) throw new Error('十六进制内容非法（长度必须为偶数）');
      const { uds, readSid, writeSid, idPad } = progProto();
      await coder.enterSessionFor('coding');
      const cur = await coder.readBlock(lid, readSid);
      if (clean.length / 2 !== cur.length) {
        throw new Error(`长度不符：要写 ${clean.length / 2} 字节，块实际 ${cur.length} 字节 —— 已中止`);
      }
      // 参考诊断仪 序列：写前备份整块（回读不一致时原样写回）
      const backupHex = cur.map((b) => b.toString(16).padStart(2, '0')).join('');
      await coder.securityAccess(0x09, !uds);
      const sidHex = writeSid.toString(16).toUpperCase().padStart(2, '0');
      const lidHex = Number(lid).toString(16).toUpperCase().padStart(idPad, '0');
      try {
        await coder.uds(`${sidHex}${lidHex}${clean.toUpperCase()}`, 8000);
        const back = await coder.readBlock(lid, readSid);
        const ok = back.map((b) => b.toString(16).padStart(2, '0')).join('') === clean.toUpperCase();
        if (!ok) throw new Error('回读与写入不一致');
        return `已写入并回读校验通过（${cur.length} 字节）`;
      } catch (e) {
        // 恢复：把备份整块写回（与 restoreBackups 同路径）
        try {
          await coder.enterSessionFor('coding');
          await coder.securityAccess(0x09, !uds);
          await coder.uds(`${sidHex}${lidHex}${backupHex.toUpperCase()}`, 8000);
          const restored = await coder.readBlock(lid, readSid);
          const ok = restored.map((b) => b.toString(16).padStart(2, '0')).join('') === backupHex.toUpperCase();
          throw new Error(e.message + (ok ? '（已恢复原块）' : '（⚠️ 恢复也失败，请用恢复备份）'));
        } catch (e2) {
          throw new Error(e2.message.includes('已恢复') || e2.message.includes('恢复')
            ? e2.message : e.message + '（⚠️ 恢复失败，请用恢复备份）');
        }
      }
    });
    $('xProgVerify').onclick = () => progRun('回读校验', async (lid) => {
      const { readSid } = progProto();
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, readSid);
      return `块 ${blk.length} 字节已回读`;
    });
  } else if (kind === 'actuator') {
    $('xActOn').onclick = () => run(async () => {
      await coder.enterSessionFor('io');
      const did = parseInt($('xDid').value, 16);
      const r = await coder.ioControl(did, 0x03, 'FF000000');
      return r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }, '驱动执行器');
    $('xActOff').onclick = () => run(async () => {
      await coder.enterSessionFor('io');
      const did = parseInt($('xDid').value, 16);
      const r = await coder.ioControl(did, 0x00, '');
      return r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }, '执行器回位');
  }
}

/**
 * 按 (车型, 模块) 加载编码条目 —— 取该模块的默认变体（BaseSys），
 * 缓存避免重复拉。全量 987K 条太大，必须按需载。
 */
/**
 * 加载某车型×模块×变体的编码条目。
 *
 * ⚠️ **变体必须匹配**（2026-10-17 审计）：每个模块有多个变体
 *    （ACC3_BaseSys / ACC3_A2 / ACC3_A4 …），不同变体的 byte/bit 映射**可能完全不同**。
 *    旧实现只加载 `mod.default`，车上若是别的变体 → 读写到错误字节。
 *    参考诊断仪 靠 1A 9F/94/92 的识别文本匹配 ODX 变体名（变体识别），不弹窗。
 *    本实现 `autoPickVariant()` 自动匹配；匹配不到用默认变体。
 *    `state.selectedVariant[module]` 仍是写入安全闸门，但由自动选择填充。
 */
async function loadModuleItems(modelLabel, module) {
  const cat = modelsCatalog?.models?.[modelLabel];
  if (!cat) return [];
  const mod = (cat.modules || []).find((m) => m.module === module);
  if (!mod) return [];
  // state 里存的是**变体名**（如 ACC3_A2），文件名字段才是实际 URL（ACC3_A2.json）。
  const sel = state.selectedVariant?.[module];
  const selRec = sel ? (mod.variants || []).find((v) => (v.name || v.file) === sel) : null;
  if (sel && !selRec) {
    // 保存的变体名在目录里找不到（数据更新/手输错误）→ 清掉选择，回默认并保持写入锁，
    // 不能拿默认映射冒充用户选的变体。
    log(`⚠️ ${module} 保存的变体「${sel}」不在目录里，已清除选择（写入保持锁定）`, 'warn');
    delete state.selectedVariant[module];
  }
  const want = selRec?.file || mod.default;
  const key = `${modelLabel}::${module}::${want}`;
  if (loadedVariants.has(key)) return loadedVariants.get(key);
  const url = `data/models/${cat.slug}/${want}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    const items = j.items || [];
    loadedVariants.set(key, items);
    return items;
  } catch {
    return [];
  }
}
