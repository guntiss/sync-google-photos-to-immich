// Attaches to the debug browser (npm run debug-browser), opens the extension page and
// optionally runs Check or Sync on one album, then prints the card and saves a screenshot.
// usage: node scripts/probe.mjs <albumUrl> <view|check|sync> [screenshot.png]
// Settings (Immich URL/key) must already be saved in the debug profile.
import { chromium } from 'playwright-core';
const [url, mode = 'view', shot = 'probe.png'] = process.argv.slice(2);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js')) ?? (await ctx.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.setViewportSize({ width: 1100, height: 900 });
page.on('console', (m) => m.type() !== 'log' && console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`chrome-extension://${id}/app.html`);
await page.waitForSelector('.card, .empty');

const card = page.locator('.card', { has: page.locator(`a.src[href="${url}"]`) });
if (!(await card.count())) {
  await page.click('#openPicker');
  await page.click('#picker .by-link summary');
  await page.fill('#addUrl', url);
  await page.click('#addForm button[type=submit]');
  await card.waitFor();
} else if (mode !== 'view') {
  await card.locator(`[data-action=${mode}]`).click();
}
if (mode !== 'view') {
  await page.waitForTimeout(500);
  await page.waitForFunction(
    () => !document.querySelector('.card.running') && !document.querySelector('.card [data-action=check]').disabled,
    null, { timeout: 600000 },
  );
}
const text = async (sel) => (await card.locator(sel).innerText()).replace(/\s+/g, ' ').trim();
console.log('title:', await text('.title'), '|', await text('.meta'));
console.log('pct:', await text('.pct'), '| status:', await text('.status'));
console.log('stats:', await text('.stats'));
console.log('tiles:', (await page.locator('#tiles').innerText()).replace(/\s+/g, ' '));
console.log('schedule:', await page.locator('#schedule').innerText(), '| conn:', await page.locator('#conn').innerText());
await page.screenshot({ path: shot, fullPage: true });
await page.close();
await browser.close();
