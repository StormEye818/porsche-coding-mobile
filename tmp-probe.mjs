import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const server = spawn('python3', ['-m', 'http.server', '8777', '--directory', 'www'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 860 } });
page.on('dialog', async (d) => { if (d.type()==='prompt') await d.accept('1'); else await d.accept(); });
page.on('console', (m) => { if (m.type()==='error') console.log('[console.err]', m.text().slice(0,120)); });
await page.goto('http://127.0.0.1:8777/index.html', { waitUntil: 'networkidle' });
await page.click('#btnSim');
await page.waitForTimeout(1500);
const clickIf = async (re) => {
  const el = page.locator('#navList .item, #navList button', { hasText: re }).first();
  if (!(await el.count())) { console.log('未找到', re); return false; }
  const before = (await page.locator('#navList').innerText()).slice(0, 40);
  await el.click();
  await page.waitForTimeout(1500);
  const after = (await page.locator('#navList').innerText()).slice(0, 40);
  console.log(`点击[${re}] 前=${before.replace(/\n/g,'|')} 后=${after.replace(/\n/g,'|')} 变化=${before!==after}`);
  return before !== after;
};
await clickIf(/自动搜索/);
await clickIf(/^系统选择/);
await clickIf(/ECM\/DME|发动机/);
await clickIf(/^设码/);
console.log('navTitle=', await page.locator('#navTitle').innerText().catch(()=>'?'));
console.log('codSearchIn=', await page.locator('#codSearchIn').count());
// coding 全局状态
console.log('coding len =', await page.evaluate(() => (window.__codingLen ?? 'n/a')));
await browser.close(); server.kill();
