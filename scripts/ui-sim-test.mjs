// UI 操作级模拟全流程验证（2026-11-06，用户指令：整体大改后从实际 app 操作层面排查 bug）。
// 跑法: node scripts/ui-sim-test.mjs   （需 playwright + chromium 已装）
// 产出: /tmp/ui-sim/*.png 截图 + 末尾 PASS/FAIL/SKIP 汇总 + 汇总 JSON。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SHOT = '/tmp/ui-sim';
// ★ 双形态：直板（430/css #sbBack）vs Duo 内屏（951×669/原生 APXRail）
const CFG = JSON.parse(process.env.UI_SIM_CFG || '{"w":430,"h":860,"back":"css","tag":"slab"}');
const doBack = async () => {
  if (CFG.back === 'native') await page.evaluate(() => window.APXRail && window.APXRail.select('back'));
  else await page.click('#sbBack').catch(() => {});
  await page.waitForTimeout(800);
};
mkdirSync(SHOT, { recursive: true });
const results = [];
const dialogs = [];
const pageErrors = [];
const consoleErrors = [];
const ok = (name, cond, extra = '') => results.push({ name, status: cond ? 'PASS' : 'FAIL', extra });
const skip = (name, why) => results.push({ name, status: 'SKIP', extra: why });

// ── 静态服务 www/ ──
const server = spawn('python3', ['-m', 'http.server', '8777', '--directory', 'www'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CFG.w, height: CFG.h } });
page.on('dialog', async (d) => {
  dialogs.push({ type: d.type(), message: d.message() });
  // prompt（多车型序号选择）给 1；confirm 一律接受
  if (d.type() === 'prompt') await d.accept('1'); else await d.accept();
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('crash', () => pageErrors.push('PAGE CRASHED'));
const shot = (n) => page.screenshot({ path: `${SHOT}/${String(results.length).padStart(2, '0')}-${n}.png` }).catch(() => {});
const navText = () => page.locator('#navList').innerText().catch(() => '');
const waitNav = async (ms = 600) => { await page.waitForTimeout(ms); };

try {
  // 1. 载入 + 模拟模式
  await page.goto('http://127.0.0.1:8777/index.html', { waitUntil: 'networkidle' });
  ok('页面载入无 pageerror', pageErrors.length === 0, pageErrors[0] || '');
  await page.click('#btnSim');
  await waitNav(1200);
  shot('sim-on');
  ok('模拟模式进入（日志含模拟）', (await page.locator('#log').innerText()).includes('模拟'));

  // 2. 自动搜索（回首页点自动搜索）→ 必须弹确认（2026-11-05 修复②）
  await page.click('#sbHome').catch(() => {});
  await waitNav(500);
  const autoItem = page.locator('#navList .item', { hasText: '自动搜索' }).first();
  if (await autoItem.count()) {
    await autoItem.click();
    await waitNav(2500);
    shot('autosearch');
    const dlg = dialogs.find((d) => /确认|选择|车型/.test(d.message));
    ok('自动搜索弹车型确认（模拟模式也弹）', !!dlg, dlg ? dlg.message.slice(0, 60) : '无弹窗');
    const logTxt = await page.locator('#log').innerText();
    ok('车型落定（日志含已选）', /已选|车型/.test(logTxt), logTxt.split('\n').filter((l) => l.includes('已选')).pop() || '');
  } else {
    skip('自动搜索弹确认', '首页无「自动搜索」项');
  }

  // 3. 进系统：系统选择 → 点一个系统（车型落定后导航已在车型层，勿点 sbHome）
  let entered = false;
  const navSig = async () => (await navText()).slice(0, 120) + '#' + (await page.locator('#secParam').isVisible().catch(() => false));
  // expectNav=true（换页类）：点击后等 navSig 变化；没变可重试（换页成功后旧元素失效，不会双执行）
  // expectNav=false（面板/动作类）：单击，仅在抛错时重试（防动作执行两遍）
  const clickIf = async (re, expectNav = true) => {
    const el = page.locator('#navList .item, #navList button', { hasText: re }).first();
    if (!(await el.count())) return false;
    const before = await navSig();
    const doClick = async () => { try { await el.click({ timeout: 2500 }); return true; } catch { return false; } };
    for (let a = 0; a < 2; a++) {
      await page.waitForTimeout(650);          // 避开 pushModel 的 500ms ghost-click 吞锁窗口
      if (!(await doClick())) { await page.waitForTimeout(700); if (!(await doClick())) continue; }
      if (!expectNav) return true;             // 非导航点击：点到即成功
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(500);
        if ((await navSig()) !== before) return true;
      }
    }
    return false;   // ★ 2026-11-07：超时如实报 false（旧实现恒 true 掩盖故障）
  };
  await clickIf(/系统选择/);
  await clickIf(/发动机|ECM|DME/);
  const sysFnTxt = await navText();
  shot('sys-functions');
  ok('进入系统功能菜单（设码/特殊功能/版本入口）', /设码|编码|特殊|版本/.test(sysFnTxt), sysFnTxt.slice(0, 60).replace(/\n/g, ' / '));

  // 4. 版本信息（★ 内层页：push 栈级替换主区，与设码同款）
  if (await clickIf(/^版本信息/, false)) {
    await waitNav(1500);
    shot('version');
    const titleT = await page.locator('#navTitle').innerText().catch(() => '');
    const secT = await navText();
    ok('版本信息=内层页（标题+主区内容）', /版本信息/.test(titleT) && /全部读取|硬件|软件|识别/.test(secT),
      `标题=${titleT} | ${secT.slice(0, 40).replace(/\n/g, ' / ')}`);
    ok('版本信息不在底部面板（secParam 隐藏）', !(await page.locator('#secParam').isVisible().catch(() => false)));
    await doBack();
    ok('版本信息返回系统菜单', /设码|数据流|特殊/.test(await navText()), (await navText()).slice(0, 40).replace(/\n/g, ' / '));
  } else { skip('版本信息', '系统功能菜单无版本入口'); }

  // 5. 特殊功能：进一项 → 执行（弹窗=参考诊断仪 执行族）
  if (await clickIf(/^特殊功能/, false)) {
    await waitNav(900);
    await waitNav(1200);
    {
      const boxT = await page.locator('#navList').innerText().catch(() => '');
      const execBtn = page.locator('#navList .seqRun, #navList .spRun, #navList .vRun').first();
      if (await execBtn.count()) {
        const dCount = dialogs.length;
        await execBtn.click(); await waitNav(2500);
        shot('specfun');
        const edlg = dialogs.slice(dCount).find((d) => /是否要执行|执行/.test(d.message));
        ok('特殊功能执行确认弹窗（参考诊断仪 执行族）', !!edlg, edlg ? edlg.message.slice(0, 50) : '无弹窗');
        const logT = await page.locator('#log').innerText();
        ok('特殊功能执行无报错', !/未定义|ReferenceError|NaN/.test(logT));
      } else if (/没有可执行的特殊功能/.test(boxT)) {
        ok('特殊功能页渲染（数据级空态提示正确）', true, '该平台此模块无可执行项（正常空态）');
      } else {
        ok('特殊功能页渲染', false, '无按钮也无空态提示：' + boxT.slice(0, 50));
      }
    }
    await doBack();
    ok('特殊功能返回系统菜单', /设码|数据流|版本/.test(await navText()), (await navText()).slice(0, 40).replace(/\n/g, ' / '));
  } else { skip('特殊功能执行', '系统菜单无特殊功能入口'); }

  // 6. 编码搜索 → 详情 → 返回保留搜索结果（2026-11-05 修复①）
  await clickIf(/^设码/);
  await clickIf(/刷隐藏|无规则编码/);          // 这层才是 codgroup（带搜索框）
  let searchFixed = null;
  const cs = page.locator('#codSearchIn');
  if (await cs.count()) {
    await cs.fill('模式');
    await waitNav(700);
    const before = (await navText()).slice(0, 200);
    const firstHit = page.locator('#navList .item').first();
    if (await firstHit.count()) {
      await firstHit.click(); await waitNav(900);
      shot('detail');
      await doBack();
      const kept = await page.locator('#codSearchIn').inputValue().catch(() => '');
      const after = (await navText()).slice(0, 200);
      searchFixed = kept === '模式' && after === before;
      ok('详情返回保留搜索词与结果视图', searchFixed, `词="${kept}" 结果一致=${after === before}`);
      ok('返回后搜索结果仍可点', (await page.locator('#navList .item').count()) > 0);
      // ★ 返回语义（用户实测步骤）：搜索态再返回=退出搜索不退层；随后恢复搜索供写入步
      await doBack(); await waitNav(800);
      const cleared = (await page.locator('#codSearchIn').inputValue().catch(() => '(无)'));
      const stillHere = (await page.locator('#codSearchIn').count()) > 0;
      ok('搜索态返回=退出搜索不退层', stillHere && cleared === '', `词="${cleared}" 仍在本层=${stillHere}`);
      if (stillHere) { await page.locator('#codSearchIn').fill('模式'); await waitNav(700); }
    } else { skip('搜索→详情→返回', '搜索无结果'); }
  } else { skip('搜索→详情→返回', '未到达 codgroup 层'); }

  // 7. 写入流程：详情 → 写入（枚举=下拉直接写 / 数值=valueModal）→ 参考诊断仪 原文确认 → 回读
  const detailBtn = page.locator('#navList .item').first();
  if (await detailBtn.count() && await page.locator('#codSearchIn').count()) {
    await waitNav(650);
    try { await detailBtn.click({ timeout: 2500 }); } catch { await waitNav(700); await detailBtn.click().catch(() => {}); }
    await waitNav(900);
    const editBtn = page.locator('#pWrite, #secParam button', { hasText: /修改|写入|编辑|设定|更改/ }).first();
    if (await editBtn.count()) {
      const dCount = dialogs.length;
      await editBtn.click(); await waitNav(500);
      if (await page.locator('#valueModal').isVisible().catch(() => false)) {
        await page.locator('#vmInput').fill('1');
        await page.locator('#valueModal button', { hasText: /确定|写入|确认/ }).first().click();
      }
      await waitNav(1800);
      shot('write');
      const wdlg = dialogs.slice(dCount).find((d) => /编此编码|写入新编码值/.test(d.message));
      ok('写入确认弹窗=参考诊断仪 原文', !!wdlg, wdlg ? wdlg.message.slice(0, 40) : (dialogs.slice(dCount).map((d) => d.message.slice(0, 30)).join('|') || '无弹窗'));
      const logT = await page.locator('#log').innerText();
      ok('写入流程完成（备份/回读字样）', /回读|成功|备份|写入完成/.test(logT), logT.split('\n').filter((l) => /写|备份|回读/.test(l)).slice(-2).join(' | '));
    } else { skip('写入流程', '详情页无写入按钮'); }
  } else { skip('写入流程', '未进入编码详情'); }

  // 7b. 其余功能入口冒烟（先退回系统菜单：写入步后栈在 paramdetail/codgroup/codsubmenu 3 级深）
  // 退栈按内容判断（新返回语义：搜索态的第一次 doBack=退出搜索，数次数会错位）
  const backToSys = async () => {
    for (let i = 0; i < 8; i++) {
      const txt = await navText();
      const noSearch = (await page.locator('#codSearchIn').count()) === 0;
      // 系统功能菜单多标记共现（读故障码+版本信息），且无搜索框 —— 排除深层页误判
      if (noSearch && /读故障码/.test(txt) && /版本信息/.test(txt) && /特殊功能/.test(txt)) return;
      await doBack();
    }
  };
  await backToSys();
  const smokePanel = async (name, re) => {
    if (await clickIf(re, false)) {
      await waitNav(1200);
      const titleT = await page.locator('#navTitle').innerText().catch(() => '');
      const t = await navText();
      ok(`${name}=内层页渲染`, t.length > 20 && titleT.length > 0, `标题=${titleT} | ${t.slice(0, 30).replace(/\n/g, ' / ')}`);
      ok(`${name} 不在底部面板`, !(await page.locator('#secParam').isVisible().catch(() => false)));
      await doBack();
    } else { skip(`${name} 入口`, '菜单无该入口'); }
  };
  await smokePanel('DTC', /^读故障码/);
  await smokePanel('数据流', /^数据流/);
  // 执行器测试：内层页 + ★ 可用性（点「驱动」真发 2F，无报错）
  if (await clickIf(/^执行器测试/, false)) {
    await waitNav(1200);
    const titleT = await page.locator('#navTitle').innerText().catch(() => '');
    const t = await navText();
    ok('执行器=内层页渲染（按 DID 操作）', /DID|按 DID|驱动/.test(t) && titleT.length > 0,
      `标题=${titleT} | ${t.slice(0, 40).replace(/\n/g, ' / ')}`);
    const drive = page.locator('#navList .actOn').first();
    if (await drive.count()) {
      const dCount = dialogs.length;
      await drive.click(); await waitNav(1500);
      const logT = await page.locator('#log').innerText();
      // ★ 31 族例程执行断言（真发 31）
      const run31 = page.locator('#navList .actRun').first();
      if (await run31.count()) {
        await run31.click(); await waitNav(2000);
        const logT = await page.locator('#log').innerText();
        ok('例程执行真发 31（31 01/03 日志）', /例程执行|例程 31/.test(logT) && !/ReferenceError|NaN/.test(logT), logT.split('\n').filter((l) => /例程/.test(l)).slice(-2).join(' | ').slice(0, 60));
      } else { skip('例程执行', '无 31 族条目'); }
      ok('执行器项目名可读（非裸代码串）', !/执行器 0x[0-9A-F]{4}/.test((await navText()).slice(0, 400)) && /调节|灯罩|加热|时间|状态|信号|灯/.test(await navText()), (await navText()).slice(0, 50).replace(/\n/g, ' / '));
      ok('执行器驱动真发 2F（无报错/有日志）', !/ReferenceError|undefined|NaN/.test(logT) && logT.length > 0,
        logT.split('\n').slice(-2).join(' | ').slice(0, 50));
    } else {
      // 无实测 2F 条目时应有手动 DID 输入（不是死页）
      ok('执行器页有手动 DID 输入兜底', (await page.locator('#xDid').count()) > 0);
    }
    await doBack();
    ok('执行器返回系统菜单', /设码|数据流|版本/.test(await navText()), (await navText()).slice(0, 40).replace(/\n/g, ' / '));
  } else { skip('执行器测试', '系统菜单无执行器入口'); }
  // 设码子菜单：备份/恢复是子菜单动作项（非独立页）——验入口存在+点备份有动作
  if (await clickIf(/^设码/)) {
    await waitNav(900);
    const subT = await navText();
    ok('设码子菜单含备份/恢复入口', /备份所有编码/.test(subT) && /备份编码|恢复/.test(subT), subT.slice(0, 40).replace(/\n/g, ' / '));
    const bk = page.locator('#navList .item, #navList button', { hasText: /备份所有编码/ }).first();
    if (await bk.count()) {
      await bk.click(); await waitNav(1500);
      const logT = await page.locator('#log').innerText();
      ok('备份动作触发（有读块/备份日志）', /备份|读取|块/.test(logT), logT.split('\n').slice(-2).join(' | ').slice(0, 50));
    } else { skip('备份动作', '未找到入口'); }
    await doBack();   // 回系统菜单
  } else { skip('备份/恢复入口', '未到设码子菜单'); }
  // 系统扫描：循环退栈直到车型菜单（按内容判断，不数级数）
  for (let i = 0; i < 6; i++) {
    if (/快速测试|系统扫描/.test(await navText())) break;
    await doBack();
  }
  if (await clickIf(/系统扫描/)) {
    await waitNav(3000);
    const logT = await page.locator('#log').innerText();
    ok('系统扫描跑起来（扫描日志）', /扫描/.test(logT), logT.split('\n').filter((l) => /扫描/.test(l)).slice(-1).join('').slice(0, 50));
  } else { skip('系统扫描', '车型菜单无系统扫描'); }
  const expBtn = page.locator('#btnExport');
  if (await expBtn.count()) { ok('导出按钮存在', true); } else { skip('导出', '无按钮'); }

  // ★ 末段. IC 案例二级页形态（用户实测基准）：自含导航 从车型层 → 系统选择 → IC → 设码 → PTI
  {
    for (let i = 0; i < 6; i++) {           // 退回车型层
      const tx = await navText();
      console.log('  [3b退栈]', i, 'title=', await page.locator('#navTitle').innerText().catch(()=>'?'), '|', tx.slice(0,50).replace(/\n/g,' / '));
      if (/快速测试|系统扫描/.test(tx)) break;
      await doBack();
    }
    await clickIf(/系统选择/);
    await clickIf(/IC\(仪表\)/);                 // 精确 IC（避免附加仪表抢匹配）
    // IC 进模块=全量编码块读取，真实耗时 ~17s（真机同）——耐心等进入
    for (let i = 0; i < 120 && !/IC|仪表/.test(await page.locator('#navTitle').innerText().catch(()=>'')); i++) {
      await page.waitForTimeout(1000);
    }
    const okCoding = await clickIf(/^设码/);
    await clickIf(/刷隐藏/);                      // 设码首页=类别层，PTI 组在刷隐藏/改装内
    const grp = page.locator('#navList .item', { hasText: /erformance and torque/i }).first();
    if (okCoding && await grp.count()) {
      await grp.click(); await waitNav(1200);
      const t2 = await navText();
      ok('二级页无「直接条目」伪组', !t2.includes('直接条目'));
      // ★ 行集合恰好=…0/…1 两桶行、无任何多余行（用户打回点：多余行全归桶）
      const rowsOf = async () => {
        const rows = [];
        for (const el of await page.locator('#navList .item').all()) rows.push(await el.innerText());
        return rows;
      };
      let rows = await rowsOf();
      // ★ 2026-11-08 规则定案：二级页=记录序 50 条分页（…0/…1=页序号），页内平铺
      const pageCnt = (txt) => { const m = /(\d+)\s*个编码项/.exec(txt); return m ? Number(m[1]) : -1; };
      const bRows = rows.filter((r) => /ndication\d/i.test(r));
      const extra = rows.filter((r) => !/ndication\d/i.test(r));
      ok('PTI 二级页=恰好 …0/…1 两页行', bRows.length === 2 && extra.length === 0,
        `页行=${bRows.length} 多余=${extra.length} | ${rows.slice(0, 4).join(' / ')}`);
      const r0 = rows.find((r) => /ndication0/i.test(r)) || '';
      const r1 = rows.find((r) => /ndication1/i.test(r)) || '';
      ok('PTI 分页=50+38', pageCnt(r0) === 50 && pageCnt(r1) === 38, `…0=${pageCnt(r0)} …1=${pageCnt(r1)}`);
      const b0 = page.locator('#navList .item', { hasText: /ndication0/i }).first();
      if (await b0.count()) {
        await b0.click(); await waitNav(1200);
        const t3 = await navText();
        ok('…0 页首条=N21（记录序）', /N21/.test(t3.slice(0, 80)), t3.slice(0, 50).replace(/\n/g, ' / '));
        ok('…0 页平铺含批量写入', /批量写入|byte/.test(t3), '');
        await doBack(); await waitNav(800);
      } else { skip('…0 页首条', '无 …0 行'); }
      const b1 = page.locator('#navList .item', { hasText: /ndication1/i }).first();
      if (await b1.count()) {
        await b1.click(); await waitNav(1200);
        const t4 = await navText();
        ok('…1 页首条=N08（…0 末=N09）', /N08/.test(t4.slice(0, 80)), t4.slice(0, 50).replace(/\n/g, ' / '));
        await doBack(); await waitNav(800);
      } else { skip('…1 页首条', '无 …1 行'); }
      // ★ 车载电脑菜单配置：63→50+13 两页
      for (let i = 0; i < 3; i++) {
        if (await page.locator('#navList .item', { hasText: /车载电脑菜单配置/ }).count()) break;
        await doBack(); await waitNav(700);
      }
      const tc = page.locator('#navList .item', { hasText: /车载电脑菜单配置/ }).first();
      if (await tc.count()) {
        await tc.click(); await waitNav(1200);
        rows = await rowsOf();
        const b2 = rows.filter((r) => /车载电脑菜单配置\d/.test(r));
        const x2 = rows.filter((r) => !/车载电脑菜单配置\d/.test(r));
        ok('菜单配置二级页=恰好 …0/…1', b2.length === 2 && x2.length === 0,
          `页行=${b2.length} 多余=${x2.length} | ${rows.slice(0, 4).join(' / ')}`);
        const m0 = rows.find((r) => /车载电脑菜单配置0/.test(r)) || '';
        const m1 = rows.find((r) => /车载电脑菜单配置1/.test(r)) || '';
        ok('菜单配置分页=50+13', pageCnt(m0) === 50 && pageCnt(m1) === 13, `…0=${pageCnt(m0)} …1=${pageCnt(m1)}`);
      } else { skip('菜单配置形态', '组不在当前变体'); }
    } else {
      skip('IC 二级页形态', okCoding ? '无 Performance and torque 组（变体不同）' : '未到设码层');
    }
  }

  // 8. 全局健康
  ok('全程零 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  ok('全程零 console error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (e) {
  ok('测试脚本自身执行', false, String(e).slice(0, 200));
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

// 汇总
for (const r of results) console.log(`${r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
const p = results.filter((r) => r.status === 'PASS').length;
const f = results.filter((r) => r.status === 'FAIL');
const s = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n===== UI 模拟全流程[${CFG.tag} ${CFG.w}x${CFG.h} back=${CFG.back}]: ${p} PASS / ${f.length} FAIL / ${s} SKIP =====`);
console.log('弹窗记录:', JSON.stringify(dialogs.map((d) => d.message.slice(0, 40))));
