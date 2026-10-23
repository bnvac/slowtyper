import puppeteer from 'puppeteer-core';
// Firefox end-to-end test. Needs: npm run build, puppeteer-core, and a Firefox
// binary in FIREFOX_PATH (e.g. `npx @puppeteer/browsers install firefox@stable`).
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(here, 'fixtures'), out = process.argv[2] || here;
// WebDriver BiDi can't navigate to extension pages, so test a copy of the
// build that opens its own popup in a tab on startup.
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'slowtyper-ff-'));
fs.cpSync(path.join(here, '..', 'dist', 'firefox'), ext, { recursive: true });
fs.writeFileSync(path.join(ext, 'src', 'testopen.js'), "browser.tabs.create({ url: browser.runtime.getURL('popup/popup.html') });");
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.background.scripts.push('src/testopen.js');
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));
const server = http.createServer((q, r) => { const f = path.join(fx, path.basename(q.url)); fs.existsSync(f) ? (r.setHeader('content-type','text/html'), r.end(fs.readFileSync(f))) : (r.statusCode=404, r.end()); }).listen(8766, '127.0.0.1');
const browser = await puppeteer.launch({ browser: 'firefox', headless: true, args: ['--remote-allow-system-access'],
  executablePath: process.env.FIREFOX_PATH });
console.log('installed:', await browser.installExtension(ext));
await new Promise(r => setTimeout(r, 1500));
let pop;
for (const p of await browser.pages()) {
  const href = await p.evaluate(() => location.href).catch(() => '');
  if (href.includes('popup.html')) pop = p;
}
await new Promise(r => setTimeout(r, 500));
console.log('popup: trusted option hidden =', await pop.evaluate(() => document.getElementById('method').closest('label').hidden),
            '| access banner hidden =', await pop.evaluate(() => document.getElementById('access').hidden));
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8766/index.html');
await page.bringToFront();
await new Promise(r => setTimeout(r, 500));
const tabId = await pop.evaluate(async () => (await browser.tabs.query({ url: 'http://127.0.0.1/*' }))[0]?.id);
const tab = () => pop.evaluate((id) => browser.runtime.sendMessage({ type: 'get-tab', tabId: id }), tabId);
async function runIn(sel, text, frame = page, extra = {}) {
  await frame.click(sel); await new Promise(r => setTimeout(r, 200));
  const res = await pop.evaluate((id, t, o) => browser.runtime.sendMessage({ type: 'start', tabId: id, text: t, opts: o }), tabId, text, { wpm: 400, typoRate: 8, startDelay: 0, ...extra });
  if (!res.ok) return 'START FAILED ' + JSON.stringify(res);
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
    const s = (await tab()).tab.status;
    if (i > 2 && s && ['done', 'stopped', 'error', 'paused'].includes(s.state)) return s.state + (s.message && s.state !== 'done' ? ' ' + s.message : '');
  }
  return 'timeout';
}
const T = 'Hello there, World! This is a test.';
console.log('input:', await runIn('#inp', T), JSON.stringify(await page.$eval('#inp', e => e.value)));
console.log('textarea:', await runIn('#ta', 'Line one.\nLine two?'), JSON.stringify(await page.$eval('#ta', e => e.value)));
console.log('ce:', await runIn('#ce', T), JSON.stringify(await page.$eval('#ce', e => e.innerText)));
const fr = page.frames().find(f => f.url().includes('frame.html'));
console.log('iframe:', await runIn('#ta2', 'inside frame', fr), JSON.stringify(await fr.$eval('#ta2', e => e.value)));
console.log('trusted (should refuse):', await runIn('#ta', 'x', page, { method: 'trusted' }));
console.log('log:', JSON.stringify(await page.evaluate(() => window.log)));
// overlay + focus-loss
await page.$eval('#inp', e => e.value = '');
await page.click('#inp'); await new Promise(r => setTimeout(r, 200));
await pop.evaluate((id) => browser.runtime.sendMessage({ type: 'start', tabId: id, text: 'a long string typed slowly', opts: { wpm: 30, startDelay: 0, typoRate: 0 } }), tabId);
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: out + '/ff-overlay.png' });
await page.click('#ta'); await new Promise(r => setTimeout(r, 800));
console.log('focus loss:', (await tab()).tab.status.state);
await page.click('#inp'); await new Promise(r => setTimeout(r, 1500));
console.log('auto-resume:', (await tab()).tab.status.state, JSON.stringify(await page.$eval('#inp', e => e.value)));
await browser.close(); server.close(); fs.rmSync(ext, { recursive: true, force: true });
