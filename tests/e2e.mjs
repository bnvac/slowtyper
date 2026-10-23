import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer((q, r) => { const f = path.join(here, 'fixtures', path.basename(q.url)); fs.existsSync(f) ? (r.setHeader('content-type','text/html'), r.end(fs.readFileSync(f))) : (r.statusCode = 404, r.end()); }).listen(8765, '127.0.0.1');
const ext = path.resolve(here, '..');
const out = process.argv[2] || here;
const ctx = await chromium.launchPersistentContext('', {
  headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8765/index.html');
await page.waitForTimeout(300);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({active:true}))[0].id);
const opts = { wpm: 400, variance: 40, typoRate: 8, startDelay: 0 };
async function runIn(sel, text, extra = {}, frame = page) {
  await frame.click(sel);
  await page.waitForTimeout(150);
  const res = await sw.evaluate(([tabId, text, o]) => handle({ type:'start', tabId, text, opts:o }, {}), [tabId, text, {...opts, ...extra}]);
  if (!res.ok) throw new Error(JSON.stringify(res));
  for (let i = 0; i < 200; i++) {
    const t = await sw.evaluate((id) => getTab(id), tabId);
    if (t.status && ['done','stopped','error'].includes(t.status.state) && i > 2) return t.status;
    await page.waitForTimeout(100);
  }
  throw new Error('timeout');
}
const text = 'Hello there, World! This is a test.';
console.log('input:', await runIn('#inp', text), JSON.stringify(await page.inputValue('#inp')));
console.log('textarea:', (await runIn('#ta', 'Line one.\nLine two?')).state, JSON.stringify(await page.inputValue('#ta')));
console.log('ce:', (await runIn('#ce', text)).state, JSON.stringify(await page.innerText('#ce')));
const fr = page.frame({ url: /frame.html/ });
console.log('iframe:', (await runIn('#ta2', 'inside frame', {}, fr)).state, JSON.stringify(await fr.inputValue('#ta2')));
await page.fill('#ta', '');
console.log('trusted:', (await runIn('#ta', 'Trusted Keys! ok?\nyes', { method: 'trusted', wpm: 300 })).state, JSON.stringify(await page.inputValue('#ta')));
console.log('log:', JSON.stringify(await page.evaluate(() => window.log)));
// focus-loss pause
await page.fill('#inp', '');
await page.click('#inp'); await page.waitForTimeout(100);
await sw.evaluate(([tabId]) => handle({ type:'start', tabId, text:'a long string to type slowly here', opts:{wpm:30,startDelay:0,typoRate:0} }, {}), [tabId]);
await page.waitForTimeout(1200); await page.click('#ta'); await page.waitForTimeout(800);
const paused = (await sw.evaluate((id) => getTab(id), tabId)).status;
const v1 = await page.inputValue('#inp'); const ta1 = await page.inputValue('#ta');
console.log('focus loss:', paused.state, '|', paused.message, '| ta unchanged:', ta1 === 'Trusted Keys! ok?\nyes');
await page.click('#inp'); await page.waitForTimeout(1500);
const st = (await sw.evaluate((id) => getTab(id), tabId)).status;
console.log('auto-resume:', st.state, 'grew:', (await page.inputValue('#inp')).length > v1.length);
await page.screenshot({ path: out + '/overlay.png' });
await sw.evaluate(([tabId]) => handle({ type:'control', tabId, action:'stop' }, {}), [tabId]);
const extId = sw.url().split('/')[2];
const pop = await ctx.newPage(); await pop.setViewportSize({width:360,height:620});
await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
await pop.fill('#text', text); await pop.waitForTimeout(300);
const popState = await pop.evaluate(() => ({ wpm: document.getElementById('wpmOut').textContent, accessHidden: document.getElementById('access').hidden, eta: document.getElementById('eta').textContent }));
console.log('popup:', JSON.stringify(popState));
if (!popState.wpm || !popState.accessHidden) { console.error('POPUP INIT FAILED'); process.exitCode = 1; }
await pop.screenshot({ path: out + '/popup.png', fullPage: true });
await ctx.close();
server.close();
