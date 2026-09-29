// Attaches to the debug browser (npm run debug-browser), opens app.html, fills the
// settings from env (IMMICH_URL, IMMICH_KEY — never written to disk by this script
// beyond the debug profile's extension storage) and runs one mode against an album.
// usage: node scripts/probe.mjs <albumUrl> <list|check|sync> [screenshot.png]
import { chromium } from 'playwright-core';
const [url, mode = 'list', shot = 'probe.png'] = process.argv.slice(2);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js'));
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('requestfailed', (r) => console.log('[reqfailed]', r.url().slice(0, 100), r.failure()?.errorText));
await page.goto(`chrome-extension://${id}/app.html`);
await page.fill('#albums', url);
if (process.env.IMMICH_URL) await page.fill('#immichUrl', process.env.IMMICH_URL);
if (process.env.IMMICH_KEY) await page.fill('#apiKey', process.env.IMMICH_KEY);
await page.click(`#${mode}`);
await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Done.' , null, { timeout: 180000 });
console.log('log:\n' + (await page.locator('pre.log').allInnerTexts()).join('\n'));
console.log('summary:', await page.locator('.summary').allInnerTexts());
console.log('errors:', await page.locator('.album .error').allInnerTexts());
console.log('states:', await page.$$eval('.item', (els) => Object.entries(els.reduce((a, e) => { const s = e.className.replace('item', '').trim() || 'none'; a[s] = (a[s] || 0) + 1; return a; }, {}))));
await page.screenshot({ path: shot });
await page.close();
await browser.close();
