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
import { Coder, CodingError, MissingSeedKeyError } from './coder.js';
import { canWrite, riskLabel, extractField, decodeValue, validateParam } from './schema.js';
import { makeProvider, pickVariant } from './seedkey.js';
import { LinkDoctor, scanEcuAddresses } from './link-doctor.js';
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
  '安全气囊':               { tx: 0x7E2, rx: 0x7EA, state: 'candidate', note: '候选·未验证' },
  'ESP/PSM(电控稳定系统)':   { tx: 0x7E4, rx: 0x7EC, state: 'candidate', note: '候选·未验证' },
  'AC(空调系统)':           { tx: 0x7E6, rx: 0x7EE, state: 'candidate', note: '候选·未验证' },
  'IC(仪表)':               { tx: null, rx: null, state: 'unknown', note: '需地址扫描（原填 0x7E8 与 DME 应答 ID 冲突，已作废）' },
  'EPS(电动助力转向系统)':   { tx: 0x730, rx: 0x738, state: 'candidate', note: '候选·未验证' },
  'Tiptronic 变速器控制':    { tx: 0x7E1, rx: 0x7E9, state: 'candidate', note: '候选·未验证' },
  '驻车制动器':             { tx: 0x7E3, rx: 0x7EB, state: 'candidate', note: '候选·未验证' },
  '水平高度控制/PASM':      { tx: 0x7E5, rx: 0x7ED, state: 'candidate', note: '候选·未验证' },
  '轮胎压力监控 （TPM）':    { tx: 0x7E7, rx: 0x7EF, state: 'candidate', note: '候选·未验证' },
};

function addrFor(label) {
  return ECU_ADDR[label] || null;
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
    const en = p.enum ? Object.entries(p.enum) : [];
    let inputHtml;
    if (p.kind === 'switch' || p.kind === 'enum') {
      // ⚠️ enum key 是**十进制**字符串（"0".."255"/"16777215"），不是十六进制！
      // 曾用 parseInt(k,16)：`"255"→597`、`"10"→16`，3802 条枚举里 4194 个 key≥10 全写错值。
      inputHtml = `<select class="ruleVal" data-id="${p.id}">${en.map(([k, v]) =>
        `<option value="${Number(k)}" ${Number(k) === p.currentValue ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    } else {
      inputHtml = `<input class="ruleVal" data-id="${p.id}" type="number" value="${p.currentValue ?? 0}" min="${p.min ?? 0}" max="${p.max ?? ''}" style="width:70px">`;
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
      const newVal = Number(el.value);
      if (p.currentValue === undefined || newVal === p.currentValue) return;
      // ⚠️ 批量写入必须与单项写入**同一套闸门**：
      //   ① canWrite（只读项 / 无 LID / 严格门禁开关）
      //   ② min/max 范围 —— 此前批量路径不查，injectField 对越界值
      //      `& mask` 静默截断后照写（2026-10-16 复查 P11）
      if (!canWrite(p)) { rejected.push(`${p.name}: 不可写（只读/无 LID/门禁）`); return; }
      if ((p.min != null && newVal < p.min) || (p.max != null && newVal > p.max)) {
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
    showLoading('批量写入中…', `${changes.length} 个变更`);
    let ok = 0, fail = 0;
    for (const { p, newVal } of changes) {
      try {
        await coder.applyChange(p, newVal, { dryRun: false, session: 0x89, secLevel: 0x09 });
        p.currentValue = newVal;
        ok++;
      } catch {
        fail++;
      }
    }
    hideLoading();
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
      };
    } catch {}
    updateLoading('正在备份编码', `${i + 1} / ${lids.length} 个块`);
  }
  // 保存到本地
  const key = `pc_backup_${sysLabel}_${Date.now()}`;
  localStorage.setItem(key, JSON.stringify(backup));
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
      try {
        if (!bytes || !bytes.length) throw new Error('备份块为空');
        // ⚠️ 恢复必须**整块原样写回**，不要走 applyChange 的字段路径 ——
        //    那条路径需要 byte/bit/bitsize，备份里没有，必然抛"参数超出编码块长度"。
        //    此前就是这样把备份写废的（2026-10-16 复查 P3）。
        const hex = bytes.map((x) => x.toString(16).padStart(2, '0')).join('');
        const idHex = Number(lid).toString(16).toUpperCase().padStart(writeSid === 0x2E ? 4 : 2, '0');
        await coder.enterSession(0x89);
        await coder.securityAccess(0x09).catch(() => {});
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
  for (const lid of needLids) {
    const sample = items.find((p) => p.lid === lid);
    try {
      currentBlocks[lid] = await coder.readBlock(lid, sample?.readSid ?? 0x21);
    } catch {}
    updateLoading('正在读取数据', `LID 0x${lid.toString(16)}`);
  }
  for (const p of items) {
    const block = currentBlocks[p.lid];
    if (block) {
      try { p.currentValue = extractField(block, p); } catch { p.currentValue = undefined; }
    }
  }
  hideLoading();
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

// ---------- ① 连接 ----------
$('btnDoctor').onclick = async () => {
  $('btnDoctor').disabled = true;
  toast('info', '开始连接自检', '配件发现 → 会话 → 协议锁定 → 模块探测');
  try {
    doctor = new LinkDoctor();
    doctor.onStep = (s) => {
      log(`${s.ok ? '✅' : '❌'} ${s.title}: ${s.detail || ''}`, s.ok ? 'ok' : 'err');
      if (!s.ok) toast('err', `${s.title} 失败`, s.detail || s.fix || '');
    };
    const r = await doctor.run();
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
};

// 地址扫描：实测车上哪些 ECU 有应答（比查表猜靠谱）
$('btnScan').onclick = async () => {
  if (!needLink()) return;
  toast('info', 'ECU 地址扫描中', '逐个试 0x7XX，约需 1-2 分钟，请勿断开');
  $('btnScan').disabled = true;
  try {
    const found = await scanEcuAddresses(elm, (m) => log(m, 'info'));
    if (found.length) {
      const s = found.map((f) => `0x${f.tx.toString(16).toUpperCase()}/0x${f.rx.toString(16).toUpperCase()}`).join(' ');
      toast('ok', `发现 ${found.length} 个 ECU`, s);
    } else {
      toast('err', '没扫到任何 ECU', '确认点火 ON、电压 >12V、CAN 线已接');
    }
  } catch (e) {
    toast('err', '扫描失败', e.message);
  }
  $('btnScan').disabled = false;
};

// 模拟模式：没接头也能完整体验（读写走模拟车，不碰真车）
$('btnSim').onclick = () => {
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
  if (doctor) await doctor.close();
  doctor = elm = coder = null;
  $('linkBadge').textContent = '未连接';
  $('linkBadge').className = 'badge';
  $('btnDisc').disabled = true;
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
    await coder.uds('1003', 4000);                                   // ① UDS 扩展会话
    await coder.uds('3E00', 2000, { allowEmpty: true }).catch(() => {}); // ② 保活
    let ident = null;
    try { ident = await coder.uds('1A9F', 3000, { allowEmpty: true }); } catch { /* 不致命 */ }
    if (ident?.body?.length) {
      log(`  识别 1A 9F = ${ident.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`, 'info');
    }

    // ③ 读 VIN（DID 0xF190，UDS 22）
    const blk = await coder.readBlock(0xF190, 0x22).catch(() => null);
    let vin = '';
    if (blk && blk.length >= 17) vin = String.fromCharCode(...blk.slice(0, 17)).trim();
    log(`  VIN = ${vin || '(读不到)'}`, vin ? 'ok' : 'err');
    if (!vin) {
      toast('warn', '读不到 VIN', '可能地址不对或 ECU 未响应 —— 请用手动选择车型');
      return;
    }
    if (!isValidVin(vin)) {
      // 二进制垃圾被当 VIN 读出来了 —— 拒绝，别据此猜车型
      log(`  VIN 格式非法（含 I/O/Q 或非字母数字）：${JSON.stringify(vin)}`, 'err');
      toast('warn', 'VIN 格式非法', `读到 ${JSON.stringify(vin)}，不是 17 位 ISO 3779 VIN。请手动选择车型。`);
      return;
    }
    toast('info', `VIN = ${vin}`, '正在匹配车型年款 …');

    const yearCode = vin[9];
    const year = decodeVinYear(vin);
    const modelGuess = guessModelFromVin(vin, year);
    log(`  年款码=${yearCode} → ${year ?? '?'} 年款 · 车型判断：${modelGuess ? modelGuess.label : '未识别'}`,
      modelGuess ? 'ok' : 'info');
    if (modelGuess) {
      const ok = confirm(`识别为：${modelGuess.label}\n年款码：${yearCode}（${year ?? '未知'} 年款）\n\n确认这个车型？`);
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
  const hit = (ident.items || []).filter((it) => {
    const ms = (it.modules || []).map((x) => String(x));
    if (ms.some((m) => modNames.includes(m))) return true;
    return ms.some((m) => {
      const mn = m.toLowerCase().replace(/[^a-z0-9]/g, '');
      return mn && sysNorm && (mn.includes(sysNorm) || sysNorm.includes(mn));
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

  /** 发 KWP 1A xx / UDS 22 F1xx，返回 ASCII 正文 */
  async function readIdent(kwpHex) {
    const id = parseInt(String(kwpHex).replace(/^0x/i, ''), 16);
    const r = await coder.uds('1A' + id.toString(16).toUpperCase().padStart(2, '0'), 4000, { allowEmpty: true });
    const b = Array.from(r.body || []);
    if (b[0] === 0x7f) return 'NRC 0x' + (b[2] || 0).toString(16).toUpperCase();
    // 5A <id> <ascii...>  或  62 F1 xx <ascii...>
    let payload = b;
    if (b[0] === 0x5a) payload = b.slice(2);
    else if (b[0] === 0x62) payload = b.slice(3);
    const txt = payload.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('').trim();
    return txt || payload.map((c) => c.toString(16).padStart(2, '0')).join(' ').toUpperCase();
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
    const std = ['0x9F', '0x87', '0x84', '0x91', '0x92', '0x93', '0x94', '0x95', '0x96', '0x97', '0x9A'];
    $('idReadAll').disabled = true;
    try {
      if (!rows.length) {
        await coder.enterSessionFor('ident');
        for (const k of std) {
          try {
            const v = await readIdent(k);
            log('1A ' + k.replace('0x', '') + ' → ' + v, /^NRC/.test(v) ? 'warn' : 'ok');
          } catch (e) { log('1A ' + k.replace('0x', '') + ' → ' + e.message, 'err'); }
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
  const offlineKinds = new Set(['autosearch', 'manual', 'special']);
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
            list.innerHTML += '<div class="navEmpty">无匹配结果</div>';
          } else {
            matched.slice(0, 200).forEach((it) => {
              const d = document.createElement('div');
              d.className = 'item';
              d.innerHTML = `<div class="lbl">${it.lbl}</div><div class="meta">${it.meta || ''}</div>`;
              d.onclick = () => onSelect(it);
              list.appendChild(d);
            });
            if (matched.length > 200) {
              list.innerHTML += `<div class="hint" style="padding:10px">共 ${matched.length} 条匹配，显示前 200 条</div>`;
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
  $('secParam').style.display = 'none';
  toast('info', `已退出 ${name}`, '回到系统列表');
}

let currentBlocks = {};

/**
 * 进模块：切地址 → 进会话 → **一次性读完该模块所有编码**（对齐参考诊断仪）。
 * 参考诊断仪 是进模块就读全量，不是一个一个进去读。
 */
async function enterSystem(sys) {
  if (!needLink()) return false;
  let addr = addrFor(sys.label);
  // 地址缺失两种情况：①表里没这模块 ②表里有但 tx/rx 未知（如 IC，原填 0x7E8 与 DME 应答冲突已作废）
  if (!addr || addr.tx == null || addr.rx == null) {
    if (simMode) {
      // 模拟模式：任何模块都能进，给个占位地址
      addr = { tx: 0x7E0, rx: 0x7E8, note: '模拟' };
    } else {
      const why = addr?.note ? `（${addr.note}）` : '';
      toast('warn', `无「${sys.label}」的可用地址${why}`,
        '先跑「地址扫描」（连接自检 L5）实测该 ECU 的 tx/rx 回填 ECU_ADDR，再进模块（或开模拟模式体验）。别猜地址——猜不得。');
      return false;
    }
  }
  showLoading(`正在进入 ${sys.label}`, `地址 0x${addr.tx.toString(16).toUpperCase()}/0x${addr.rx.toString(16).toUpperCase()} · 建立会话中…`);
  coder.setAddress(addr.tx, addr.rx, sys.label);
  try {
    await coder.enterSession(0x89);
  } catch (e) {
    hideLoading();
    toast('err', `${sys.label} 会话失败`, e.message);
    return false;
  }

  // ★ 加载该车型×模块×变体的编码条目
  const mods = sys.modules || [];
  let items = [];
  for (const mod of mods) {
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
  for (const lid of priorityLids) {
    const sample = items.find((p) => p.lid === lid);
    try {
      currentBlocks[lid] = await coder.readBlock(lid, sample.readSid ?? 0x21);
    } catch {}
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
  currentModel = m.label;
  let g = (tree?.groups || []).find((x) => (x.models || []).some((y) => y.label === m.label));
  stack = [{ level: 'top', title: '手动选择', data: tree?.topLevel?.find((x) => x.kind === 'manual') || {} }];
  if (g) stack.push({ level: 'group', title: g.label, data: g });
  stack.push({ level: 'model', title: m.label, data: m });
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
    // ⚠️ enum key 是**十进制**字符串，不是 hex（见 214 行注释）
    input = `<select id="pVal">${en.map(([k, v]) => `<option value="${Number(k)}">${v}</option>`).join('')}</select>`;
  } else {
    input = `<input id="pVal" type="number" inputmode="numeric"
        min="${p.min ?? 0}" max="${p.max ?? ''}" value="${p.currentValue ?? p.min ?? 0}">
      <div class="hint">可填范围：<b>${p.min ?? 0} … ${p.max ?? '?'}</b>
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
        <button id="pWrite" class="${ro ? '' : 'primary'}">写入</button>
      </div>
      <div class="hint">${ro ? (p.writeBlockedReason || '源数据无写服务，只能读') : ''}</div>
    </div>`;

  $('pWrite').onclick = () => {
    if (ro) {
      toast('warn', `「${p.name}」是只读项`, p.writeBlockedReason || '源数据无写服务，只能读不能改');
      return;
    }
    const raw = $('pVal')?.value ?? '0';
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      toast('err', '值无效', '请输入数字');
      return;
    }
    if (p.min != null && (v < p.min || v > p.max)) {
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
    input = `<div class="switchRow">
      <button class="swBtn sel" data-v="1">开</button>
      <button class="swBtn" data-v="0">关</button>
    </div>`;
  } else if (p.kind === 'enum') {
    input = `<select id="pVal">${en.map(([k, v]) => `<option value="${k}">${k} = ${v}</option>`).join('')}</select>`;
  } else {
    input = `<input id="pVal" type="number" inputmode="numeric"
        min="${p.min ?? 0}" max="${p.max ?? ''}" value="${p.min ?? 0}">
      <div class="hint">可填范围：<b>${p.min ?? 0} … ${p.max ?? '?'}</b>
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
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      toast('err', '值无效', '请输入数字');
      return;
    }
    if (p.min != null && (v < p.min || v > p.max)) {
      toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}`);
      return;
    }
    doWrite(p, v);
  };
  $('secParam').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function doWrite(p, v) {
  if (!needLink()) return;
  if (!coder.seedKeyProvider) {
    toast('err', '拒绝写入', '缺口令算法变体');
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
  if (p.min != null && (v < p.min || v > p.max)) {
    toast('err', '值超出范围', `可填 ${p.min} … ${p.max}，当前 ${v}`);
    return;
  }
  toast('info', `写入 ${p.name} = ${decodeValue(p, v)}`, '进会话 → 安全访问 → 写 → 回读校验 …');
  try {
    await coder.applyChange(p, v, { dryRun: false, session: 0x89, secLevel: 0x09 });
    // ★ 写入成功后更新本地缓存 + 刷新 UI
    p.currentValue = v;
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
        风险：<span class="risk-${s.risk || 'low'}">${riskLabel(s.risk)}</span>
        ${rid ? ` · 例程 ID ${rid}` : ''}<br>
        ${s.playbook?.routePath ? `路径：${s.playbook.routePath}<br><br>` : ''}
        ${steps || '（无步骤说明）'}
      </div>
      <div class="acts">
        <button id="pRun" class="primary">执行</button>
        <button id="pStop">停止</button>
        <button id="pResult">查结果</button>
      </div>
      <div class="hint">执行走例程控制（0x31），会话 10 86 —— 与 参考诊断仪一致。
        高风险功能请先备份。</div>
    </div>`;
  const run = (sf, verb) => async () => {
    if (!needLink()) return;
    if (!rid) {
      toast('err', `无法${verb}「${s.label || s.id}」`, '该子功能无例程 ID，源数据未给');
      return;
    }
    const id = parseInt(String(rid).replace(/^0x/i, ''), 16);
    const risk = s.risk === 'high' ? '高风险功能，请确认车辆状态安全' : '';
    toast('info', `${verb}「${s.label || s.id}」`, risk || `例程 0x${id.toString(16).toUpperCase()}，会话 10 86`);
    try {
      await coder.enterSessionFor('routine');   // ← 10 86，对齐参考诊断仪
      const r = await coder.routineControl(sf, id, '');
      toast('ok', `「${s.label || s.id}」${verb}成功`,
        `应答 ${r.body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    } catch (e) {
      const nrc = e instanceof CodingError ? e.nrc : null;
      toast('err', `「${s.label || s.id}」${verb}失败`,
        e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
    }
  };
  $('pRun').onclick = run(0x01, '执行');      // startRoutine
  $('pStop').onclick = run(0x02, '停止');     // stopRoutine
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
  for (const [k, v] of entries) {
    const b = document.createElement('button');
    b.textContent = v;
    b.onclick = () => {
      $('vmInput').value = k;
      opts.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    };
    opts.appendChild(b);
  }
  $('vmInput').value = entries.length ? entries[0][0] : '1';
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
  log(`—— 写入 ${p.name} = ${decodeValue(p, v)} ——`, 'info');
  try {
    await coder.applyChange(p, v, { dryRun: false, session: 0x89, secLevel: 0x09 });
    p.currentValue = v;
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
      id: 'backup', lid, readSid: p.readSid, writeSid: p.writeSid,
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
  const [t, cat, c] = await Promise.all([
    fetch('data/menu-tree-v3.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/models-catalog.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch('data/coding-v2.json').then((r) => r.ok ? r.json() : null)
      .catch(() => null)
      .then((x) => x || fetch('data/coding.json').then((r) => r.json())),
  ]);
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
  let actions = '';
  if (kind === 'dtc') {
    actions = `<div class="acts">
      <button id="xReadDtc" class="primary">读故障码</button>
      <button id="xClearDtc">清故障码</button></div>
      <div id="dtcResult" class="dtcList"></div>`;
  } else if (kind === 'program') {
    const progRun = async (verb, fn) => {
      if (!needLink()) return;
      const lid = parseInt($('xProgLid').value || '', 16);
      if (Number.isNaN(lid)) { toast('err', 'LID 无效', '请输入十六进制 LID'); return; }
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
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, 0x21);
      return blk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    });
    $('xProgWrite').onclick = () => progRun('写编程块', async (lid) => {
      // 此前是「读到什么就写回什么」，没有任何修改 —— 按钮语义是假的。
      // 现在必须显式给出内容 + 长度校验 + 回读校验。
      const input = prompt(
        `要写入 LID 0x${Number(lid).toString(16).toUpperCase()} 的完整块（十六进制，空格可选）：\n`
        + '留空 = 取消。请先复制当前块、改好再粘回。', '');
      if (input == null || !input.trim()) return '已取消';
      const clean = input.replace(/[^0-9A-Fa-f]/g, '');
      if (!clean || clean.length % 2) throw new Error('十六进制内容非法（长度必须为偶数）');
      await coder.enterSessionFor('coding');
      const cur = await coder.readBlock(lid, 0x21);
      if (clean.length / 2 !== cur.length) {
        throw new Error(`长度不符：要写 ${clean.length / 2} 字节，块实际 ${cur.length} 字节 —— 已中止`);
      }
      await coder.securityAccess(0x09);
      await coder.uds('3B' + Number(lid).toString(16).toUpperCase().padStart(2, '0') + clean.toUpperCase(), 8000);
      const back = await coder.readBlock(lid, 0x21);
      const ok = back.map((b) => b.toString(16).padStart(2, '0')).join('') === clean.toUpperCase();
      if (!ok) throw new Error('回读与写入不一致');
      return `已写入并回读校验通过（${cur.length} 字节）`;
    });
    $('xProgVerify').onclick = () => progRun('回读校验', async (lid) => {
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, 0x21);
      return `块 ${blk.length} 字节已回读`;
    });
  } else if (kind === 'actuator') {
    actions = `<label>执行器 DID（十六进制）</label>
      <input id="xDid" value="045B" placeholder="如 045B">
      <div class="acts">
      <button id="xActOn" class="primary">驱动（shortTerm）</button>
      <button id="xActOff">回位</button></div>`;
  } else if (kind === 'special') {
    // ★ 特殊功能 —— 按参考诊断仪的路径：选车型 → 选模块 → 只显示**该车型变体 × 该模块**的项。
    //
    // 两份数据源：
    //   special-functions.json      67 条，带 routineId（可执行：执行/停止/查结果）
    //   special-functions-ext.json  548 条，来自 libPORSCHE_SPECF.so 导出名（车型×模块×动作目录）
    // 过滤口径：先按车型（currentModel → platform），再按模块（sys.label → module）。
    const [specialData, extData] = await Promise.all([
      fetch('data/special-functions.json').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('data/special-functions-ext.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    // —— 车型 → 平台代号（ext 数据的 platform 字段）——
    const modelLabel = String(currentModel || '').toLowerCase();
    const PLAT_KEYS = [
      ['cayenne-92a', 'Cayenne-92A'], ['cayenne-9pa', 'Cayenne-9PA'], ['cayenne-9ya', 'Cayenne-9YA'],
      ['cayenne', 'Cayenne'], ['panamera-970', 'Panamera-970'], ['panamera-971', 'Panamera-971'],
      ['panamera', 'Panamera'], ['macan', 'Macan'], ['taycan', 'Taycan'],
      ['911（992', '911 (992)'], ['911（991', '911 (991)'], ['911（997', '911 (997)'],
      ['911', '911 (992)'], ['boxster', '（通用）'], ['cayman', '（通用）'],
      ['918', '918 Spyder'], ['carrera gt', '（通用）'],
    ];
    let plat = null;
    for (const [k, v] of PLAT_KEYS) { if (modelLabel.includes(k)) { plat = v; break; } }
    // E1/E2/E3/G1/G2/G3/J1 是内部平台代号，车型名里可能直接带
    if (!plat) {
      for (const k of ['E1', 'E2', 'E3', 'G1', 'G2', 'G3', 'J1', 'PJ1']) {
        if (modelLabel.includes(k.toLowerCase())) { plat = k; break; }
      }
    }

    // —— 模块匹配（两边都用同一套归一化 + 关键字表）——
    const sysNorm = (sys.label || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const KEYMAP = [
      ['组合仪表', ['ic', 'kombi', 'instr']], ['发动机', ['ecm', 'dme', 'motor']],
      ['变速器', ['tiptronic', 'pdk', 'getriebe', 'tcM', 'tcM', 'tc']],
      ['驻车制动', ['epb', 'bremse']], ['转向盘', ['lenkrad', 'steering', 'swh']],
      ['前端电子', ['bcm', 'front']], ['保时捷稳定', ['psm', 'esp']],
      ['保时捷主动悬挂', ['pasm']], ['保时捷通讯', ['pcm', 'cdr', 'head']],
      ['网关', ['gateway', 'gatew']], ['座椅', ['seat', 'sitz']],
      ['车道变换', ['lane', 'spur']], ['灯光电子', ['lec', 'lhb', 'rhb', 'fhba', 'scheinwerfer', 'headlight']],
      ['通讯连接系统', ['connect', 'dfm']], ['轮胎压力', ['tpm', 'tpms', 'reifendruck']],
      ['安全气囊', ['srs', 'airbag', 'pab']], ['全轮驱动', ['allrad', 'awd']],
      ['空调', ['ac', 'klima']], ['水平高度', ['hcl', 'niveau']], ['尾门', ['tag', 'heck']],
      ['ACC 自适应巡航', ['acc', 'adaptive']], ['空气悬挂', ['aws', 'luftfeder']],
      ['蓄电池管理', ['bmc', 'batterie']], ['高压电气箱', ['hv', 'high']],
    ];
    const modMatch = (modName) => {
      const mn = String(modName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!mn) return false;
      if (mn === sysNorm || mn.includes(sysNorm) || sysNorm.includes(mn)) return true;
      for (const [zh, keys] of KEYMAP) {
        const hit = (s2) => s2.includes(zh.toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''));
        if (hit(sysNorm) && keys.some((k) => mn.includes(k))) return true;
        if (keys.some((k) => sysNorm.includes(k)) && hit(mn)) return true;
      }
      return false;
    };

    // —— A. 可执行项（带 routineId）——
    const funcs = (specialData?.functions || []).filter((f) => modMatch(f.system));
    // —— B. .so 目录项（车型 × 模块）——
    const ext = (extData?.items || []).filter((r) => {
      const platOk = !plat || r.platform === '（通用）' || r.platform === plat;
      return platOk && modMatch(r.module);
    });

    const esc = (x) => String(x ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    let html = '';
    html += `<div class="hint" style="margin-bottom:8px">
      车型 <b>${esc(currentModel || '（未选）')}</b> → 平台 <b>${esc(plat || '全部')}</b> ·
      系统 <b>${esc(sys.label)}</b><br>
      可执行 <b>${funcs.length}</b> 项 · 参考目录 <b>${ext.length}</b> 项
      ${plat ? '' : '（未识别平台，目录按全部显示）'}
    </div>`;

    if (funcs.length) {
      html += `<div class="specialList">${funcs.map((f, i) => `
        <div class="specialItem" data-idx="${i}">
          <div class="siName">${esc(f.sub)}</div>
          <div class="siMeta">例程 ${esc(f.routineId)} · 风险：${f.risk === 'high' ? '高' : f.risk === 'medium' ? '中' : '低'}</div>
          <div class="siActs">
            <button class="spRun" data-rid="${esc(f.routineId)}">执行</button>
            <button class="spStop" data-rid="${esc(f.routineId)}">停止</button>
            <button class="spResult" data-rid="${esc(f.routineId)}">查结果</button>
          </div>
        </div>`).join('')}</div>`;
    }
    if (ext.length) {
      html += `<div class="hint" style="margin:12px 0 6px">参考目录（来自诊断程序内置例程名，仅供对照）</div>`;
      html += `<div class="specialList">${ext.slice(0, 80).map((r) => `
        <div class="specialItem">
          <div class="siName">${esc(r.label)}</div>
          <div class="siMeta">${esc(r.platform)} · ${esc(r.module || '—')} · ${esc(r.action)}</div>
        </div>`).join('')}</div>`;
      if (ext.length > 80) html += `<div class="hint">…另有 ${ext.length - 80} 项未列出</div>`;
    }
    if (!funcs.length && !ext.length) {
      html += `<div class="hint">该车型 × 该模块在源数据里没有特殊功能定义。<br>
        可能是：车型未识别、模块名未匹配、或该模块确实无特殊功能。</div>`;
    }
    actions = html;
  } else if (kind === 'program') {
    const progRun = async (verb, fn) => {
      if (!needLink()) return;
      const lid = parseInt($('xProgLid').value || '', 16);
      if (Number.isNaN(lid)) { toast('err', 'LID 无效', '请输入十六进制 LID'); return; }
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
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, 0x21);
      return blk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    });
    $('xProgWrite').onclick = () => progRun('写编程块', async (lid) => {
      // 此前是「读到什么就写回什么」，没有任何修改 —— 按钮语义是假的。
      // 现在必须显式给出内容 + 长度校验 + 回读校验。
      const input = prompt(
        `要写入 LID 0x${Number(lid).toString(16).toUpperCase()} 的完整块（十六进制，空格可选）：\n`
        + '留空 = 取消。请先复制当前块、改好再粘回。', '');
      if (input == null || !input.trim()) return '已取消';
      const clean = input.replace(/[^0-9A-Fa-f]/g, '');
      if (!clean || clean.length % 2) throw new Error('十六进制内容非法（长度必须为偶数）');
      await coder.enterSessionFor('coding');
      const cur = await coder.readBlock(lid, 0x21);
      if (clean.length / 2 !== cur.length) {
        throw new Error(`长度不符：要写 ${clean.length / 2} 字节，块实际 ${cur.length} 字节 —— 已中止`);
      }
      await coder.securityAccess(0x09);
      await coder.uds('3B' + Number(lid).toString(16).toUpperCase().padStart(2, '0') + clean.toUpperCase(), 8000);
      const back = await coder.readBlock(lid, 0x21);
      const ok = back.map((b) => b.toString(16).padStart(2, '0')).join('') === clean.toUpperCase();
      if (!ok) throw new Error('回读与写入不一致');
      return `已写入并回读校验通过（${cur.length} 字节）`;
    });
    $('xProgVerify').onclick = () => progRun('回读校验', async (lid) => {
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, 0x21);
      return `块 ${blk.length} 字节已回读`;
    });
  } else if (kind === 'actuator') {
    actions = `<label>执行器 DID（十六进制）</label>
      <input id="xDid" value="045B" placeholder="如 045B">
      <div class="acts">
      <button id="xActOn" class="primary">驱动（shortTerm）</button>
      <button id="xActOff">回位</button></div>`;
  } else if (kind === 'program') {
    actions = `<label>编程块 LID（十六进制）</label>
      <input id="xProgLid" placeholder="如 9A">
      <div class="acts">
      <button id="xProgRead" class="primary">读当前值</button>
      <button id="xProgWrite">写入</button>
      <button id="xProgVerify">校验</button></div>
      <div class="hint">编程按 参考诊断仪流程：<b>读当前值 → 修改 → 写入 → 回读校验</b><br>
      走例程控制（0x31）+ 写入（0x3B）。⚠️ 高风险，请先备份。</div>`;
  } else if (kind === 'measure') {
    const measureData = await fetch('data/measure.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const measures = (measureData?.params || []).slice(0, 100);
    if (measures.length) {
      actions = `<div class="specialList">${measures.slice(0, 30).map((m, i) => `
        <div class="specialItem" id="meCard${i}">
          <div class="siName">${m.name || '测量值 ' + i}</div>
          <div class="siMeta">${m.kind === 'enum' ? '枚举' : m.kind === 'switch' ? '开关' : '数值'}${m.unit ? ' · 单位: ' + m.unit : ''}${m.min !== undefined ? ' · 范围: ' + m.min + '..' + (m.max ?? '?') : ''}</div>
          <div class="siVal" id="meVal${i}" style="font-size:16px;font-weight:600;color:var(--acc);margin:6px 0">—</div>
          <div class="siActs"><button class="meRead" data-idx="${i}">读取</button></div>
        </div>`).join('')}</div>
        ${measures.length > 30 ? `<div class="hint">显示前 30 条 / 共 ${measures.length} 条</div>` : ''}`;
    } else {
      actions = `<div class="hint">暂无测量值数据</div>`;
    }
  } else if (kind === 'actuator') {
    const actData = await fetch('data/actuator.json').then(r => r.ok ? r.json() : null).catch(() => null);
    const acts = (actData?.items || []).slice(0, 100);
    if (acts.length) {
      actions = `<div class="specialList">${acts.slice(0, 30).map((a, i) => `
        <div class="specialItem">
          <div class="siName">${a.name || '执行器 ' + i}</div>
          <div class="siMeta">${(a.chain || '').slice(0, 40)}</div>
          <div class="siActs">
            <button class="actOn" data-idx="${i}">驱动</button>
            <button class="actOff" data-idx="${i}">回位</button>
          </div>
        </div>`).join('')}</div>
        ${acts.length > 30 ? `<div class="hint">显示前 30 条 / 共 ${acts.length} 条</div>` : ''}`;
    } else {
      actions = `<div class="hint">暂无执行器数据</div>`;
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
  $('paramBox').querySelectorAll('.spRun').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      const rid = parseInt(b.dataset.rid, 16);
      showLoading('执行例程中…', `RID 0x${rid.toString(16).toUpperCase()}`);
      try {
        await coder.enterSessionFor('routine');
        const r = await coder.routineControl(1, rid, '');
        hideLoading();
        toast('ok', '执行成功', `应答 ${r.body.map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
      } catch (e) {
        hideLoading();
        const nrc = e instanceof CodingError ? e.nrc : null;
        toast('err', '执行失败', e.message + (nrc ? `（NRC 0x${nrc.toString(16)}）` : ''));
      }
    };
  });
  $('paramBox').querySelectorAll('.spStop').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      const rid = parseInt(b.dataset.rid, 16);
      try {
        await coder.enterSessionFor('routine');
        await coder.routineControl(2, rid, '');
        toast('ok', '已停止', '');
      } catch (e) {
        toast('err', '停止失败', e.message);
      }
    };
  });
  $('paramBox').querySelectorAll('.spResult').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      const rid = parseInt(b.dataset.rid, 16);
      try {
        await coder.enterSessionFor('routine');
        const r = await coder.routineControl(3, rid, '');
        toast('ok', '查询结果', r.body.map((x) => x.toString(16).padStart(2, '0')).join(' '));
      } catch (e) {
        toast('err', '查询失败', e.message);
      }
    };
  });

  // 数据流读取按钮
  $('paramBox').querySelectorAll('.meRead').forEach((b) => {
    b.onclick = async () => {
      if (!needLink()) return;
      const idx = parseInt(b.dataset.idx);
      const measureData = await fetch('data/measure.json').then(r => r.ok ? r.json() : null).catch(() => null);
      const m = measureData?.params?.[idx];
      if (!m) return;
      try {
        await coder.enterSessionFor('measure');
        const r = await coder.readBlock(m.lid ?? 0, m.readSid ?? 0x21);
        const raw = r[0] ?? 0;
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
    const idx = parseInt(b.dataset.idx);
    try {
      const actData = await fetch('data/actuator.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const a = actData?.params?.[idx];
      if (!a) throw new Error(`找不到执行器 #${idx}`);
      const did = a.did ?? a.lid ?? a.id;
      if (did == null) throw new Error('该执行器缺少 DID/LID，无法下发');
      await coder.enterSessionFor('io');
      // 0x03 = shortTermActivate（驱动）；0x00 = returnControlToECU（回位）
      const r = await coder.ioControl(did, controlOption, controlOption === 0x03 ? 'FF000000' : '');
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
        const bytes = Array.from(r.body || []);
        // ⚠️ `19 02 xx` 正响应 = `59 02 <statusAvailabilityMask> [DTC hi lo status]×n`
        //    前 3 字节是 59/02/mask，DTC 三元组从下标 3 开始。
        //    此前 slice(2) 把 mask 当成第一个 DTC 的头字节，整体错位 → 显示的全是垃圾码。
        const dtcData = bytes.slice(3);
        const dtcs = [];
        for (let i = 0; i + 2 < dtcData.length; i += 3) {
          const b1 = dtcData[i], b2 = dtcData[i+1], status = dtcData[i+2];
          const type = (b1 >> 6) & 3;
          const typeChar = ['P', 'C', 'B', 'U'][type];
          const d1 = ((b1 >> 4) & 3).toString(16).toUpperCase();
          const d2 = (b1 & 0xF).toString(16).toUpperCase();
          const d3 = (b2 >> 4).toString(16).toUpperCase();
          const d4 = (b2 & 0xF).toString(16).toUpperCase();
          dtcs.push({ code: `${typeChar}${d1}${d2}${d3}${d4}`, status });
        }
        const el = $('dtcResult') || document.querySelector('#dtcResult');
        if (el) {
          el.innerHTML = dtcs.length
            ? dtcs.map((d) => `<div class="dtcItem"><div class="dtcCode">${d.code}</div><div class="dtcDesc">状态: 0x${d.status.toString(16).padStart(2, '0')}</div></div>`).join('')
            : '<div class="dtcNone">✅ 无故障码</div>';
        }
        hideLoading();
        toast('ok', '故障码读取完成', dtcs.length ? `${dtcs.length} 个故障码` : '无故障码');
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
    const progRun = async (verb, fn) => {
      if (!needLink()) return;
      const lid = parseInt($('xProgLid').value || '', 16);
      if (Number.isNaN(lid)) { toast('err', 'LID 无效', '请输入十六进制 LID'); return; }
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
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, 0x21);
      return blk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    });
    $('xProgWrite').onclick = () => progRun('写编程块', async (lid) => {
      // 此前是「读到什么就写回什么」，没有任何修改 —— 按钮语义是假的。
      // 现在必须显式给出内容 + 长度校验 + 回读校验。
      const input = prompt(
        `要写入 LID 0x${Number(lid).toString(16).toUpperCase()} 的完整块（十六进制，空格可选）：\n`
        + '留空 = 取消。请先复制当前块、改好再粘回。', '');
      if (input == null || !input.trim()) return '已取消';
      const clean = input.replace(/[^0-9A-Fa-f]/g, '');
      if (!clean || clean.length % 2) throw new Error('十六进制内容非法（长度必须为偶数）');
      await coder.enterSessionFor('coding');
      const cur = await coder.readBlock(lid, 0x21);
      if (clean.length / 2 !== cur.length) {
        throw new Error(`长度不符：要写 ${clean.length / 2} 字节，块实际 ${cur.length} 字节 —— 已中止`);
      }
      await coder.securityAccess(0x09);
      await coder.uds('3B' + Number(lid).toString(16).toUpperCase().padStart(2, '0') + clean.toUpperCase(), 8000);
      const back = await coder.readBlock(lid, 0x21);
      const ok = back.map((b) => b.toString(16).padStart(2, '0')).join('') === clean.toUpperCase();
      if (!ok) throw new Error('回读与写入不一致');
      return `已写入并回读校验通过（${cur.length} 字节）`;
    });
    $('xProgVerify').onclick = () => progRun('回读校验', async (lid) => {
      await coder.enterSessionFor('coding');
      const blk = await coder.readBlock(lid, 0x21);
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
async function loadModuleItems(modelLabel, module) {
  const cat = modelsCatalog?.models?.[modelLabel];
  if (!cat) return [];
  const mod = (cat.modules || []).find((m) => m.module === module);
  if (!mod) return [];
  const key = `${modelLabel}::${module}::${mod.default}`;
  if (loadedVariants.has(key)) return loadedVariants.get(key);
  const url = `data/models/${cat.slug}/${mod.default}`;
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
