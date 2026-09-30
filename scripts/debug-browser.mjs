// Launches a dedicated Chromium (Playwright's build; branded Chrome >=137 ignores
// --load-extension) with this extension loaded and CDP exposed on :9222, so it can
// be driven/inspected from another process. Profile lives in .debug-profile/ —
// sign in to Google there once and it persists.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The permission prompt for optional host access can't be clicked over CDP, so load a
// copy of the extension with IMMICH_ORIGIN (e.g. https://im.g4.lv) added to host_permissions.
const root = path.join(repo, '.debug-ext');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);
for (const f of fs.readdirSync(repo).filter((f) => /\.(js|html|css|json)$/.test(f) && f !== 'package.json' && f !== 'package-lock.json')) {
  fs.copyFileSync(path.join(repo, f), path.join(root, f));
}
fs.cpSync(path.join(repo, 'icons'), path.join(root, 'icons'), { recursive: true });
if (process.env.IMMICH_ORIGIN) {
  const mf = path.join(root, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions.push(`${process.env.IMMICH_ORIGIN}/*`);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}
const ctx = await chromium.launchPersistentContext(path.join(repo, '.debug-profile'), {
  headless: false,
  viewport: null,
  // default --enable-automation makes Google block sign-in
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--remote-debugging-port=9222',
    '--disable-blink-features=AutomationControlled',
  ],
});

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log(`READY extension id ${id}  app: chrome-extension://${id}/app.html  cdp: http://127.0.0.1:9222`);
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://photos.google.com/');
ctx.on('close', () => process.exit(0));
