// Renders README screenshots of the real extension page with made-up data: chrome.* is
// stubbed, Google Photos / Immich responses are faked with page.route, thumbnails are
// generated SVG landscapes. Touches no real account or server.
// usage: npm run screenshots   (writes docs/screenshots/*.png)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });

const ORIGIN = 'https://demo.local';
const IMMICH = 'https://immich.example.com';
const THUMBS = 'https://photos.fife.usercontent.google.com/pw/demo-';
const MIN = 60e3;
const now = Date.now();

const albumUrl = (id) => `https://photos.google.com/share/AF1QipDemo${id}Xk3vQ9mZ2rT7bLw4?key=ZGVtby1rZXk`;
const SUMMER = albumUrl('Summer');
const FAMILY = albumUrl('Family');
const HIKING = albumUrl('Hiking');
const SETTINGS = { immichUrl: IMMICH, apiKey: 'demo-api-key-0000000000000000', intervalMinutes: 60, addExisting: true };

// ---------- fake Google album ("Hiking trips"): 18 items, the 5 newest not in Immich yet

const key = (n) => `AF1QipHike${String(n).padStart(32, '0')}`;
const hikingItems = Array.from({ length: 18 }, (_, n) => {
  const taken = Date.UTC(2026, 7, 30) - n * 2.7 * 86400e3 - n * 3_600_000;
  const it = [key(n), [`${THUMBS}${n}`, 4032, 3024], taken, `hikedup${n}`, 10800000, taken];
  if (n === 2 || n === 9) it.push({ 76647426: [15000 + n * 1000] });
  return it;
});
const missingKeys = new Set(hikingItems.slice(0, 5).map((it) => it[0]));
const hikingHtml = `<html><body><script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify([
  null, hikingItems, null, ['AF1QipHikeAlbum000000000000000000', 'Hiking trips'],
])}, sideChannel: {}});</script></body></html>`;

// ---------- fake Google albums list (/albums page + rpc Z5xsfc) for the Add albums dialog

const ME = 'AF1QipDemoMe000000000000000000000';
const month = (y, m) => Date.UTC(y, m - 1, 15);
const pickable = [
  // [id, title, items, first, last, cover, owner]; ids of the seeded albums match their share links
  ['Summer', 'Summer in Italy', 1284, month(2026, 6), month(2026, 8), 4, 'other'],
  ['Ski', 'Ski week 2026', 318, month(2026, 2), month(2026, 2), 11, 'other'],
  ['Grandma', 'Grandma’s 80th birthday', 146, month(2026, 5), month(2026, 5), 7, 'other'],
  ['Family', 'Family 2026', 356, month(2026, 1), month(2026, 9), 1, 'other'],
  ['Concert', 'School concert', 64, month(2026, 5), month(2026, 5), 13, 'other'],
  ['Wedding', 'Anna & Tom’s wedding', 912, month(2025, 9), month(2025, 9), 5, 'other'],
  ['Hiking', 'Hiking trips', 18, month(2026, 7), month(2026, 8), 0, 'me'],
  ['Garden', 'Garden project', 57, month(2025, 4), month(2026, 9), 9, 'me'],
  ['Road', 'Road trip 2025', 403, month(2025, 7), month(2025, 8), 15, 'me'],
];
const albumEntry = ([id, title, count, first, last, cover, owner]) => [
  `AF1QipDemo${id}Xk3vQ9mZ2rT7bLw4`, [`${THUMBS}${cover}`, 4000, 3000], null, null, null, null,
  [owner === 'me' ? ME : 'AF1QipDemoFriend0000000000000000'], [], null, null, null,
  { 72930366: [4, title, [first, last], count, 1, null, [], [], null, null, `https://photos.app.goo.gl/demo${id}`] },
];
const unsharedEntry = (n) => [`AF1QipDemoPrivate${n}000000000000000`, null, null, null, null, null, [ME], [], { 72930366: [1, `Private ${n}`, [], 3] }];
const albumsHtml = `<html><head><script>window.WIZ_global_data = {"SNlM0e":"demo-at","oPEP7c":"alex@example.com"};
var AF_dataServiceRequests = {'ds:2' : {id:'O3G8Nd',request:[1]}};</script></head><body>
<script>AF_initDataCallback({key: 'ds:2', hash: '1', data:${JSON.stringify([[ME, '1', null, null, null, null, null, null, null, null, null, ['Alex']]])}, sideChannel: {}});</script></body></html>`;
const albumsRpc = `)]}'\n\n1\n${JSON.stringify([['wrb.fr', 'Z5xsfc', JSON.stringify([[...pickable.map(albumEntry), ...[1, 2, 3, 4].map(unsharedEntry)]]), null, null, null, 'generic']])}\n`;

function landscape(seed) {
  let x = seed * 7919 + 17;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const hue = Math.floor(rnd() * 360);
  const ridge = (base, light, amp) => {
    let d = `M0 260 L0 ${base}`;
    for (let i = 0; i <= 8; i++) d += ` L${i * 32.5} ${Math.round(base - rnd() * amp)}`;
    return `<path d="${d} L260 260 Z" fill="hsl(${(hue + 150) % 360} 28% ${light}%)"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 260 260">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 65% 72%)"/><stop offset="1" stop-color="hsl(${(hue + 35) % 360} 70% 90%)"/></linearGradient></defs>
<rect width="260" height="260" fill="url(#s)"/>
<circle cx="${Math.round(40 + rnd() * 180)}" cy="${Math.round(45 + rnd() * 50)}" r="${Math.round(14 + rnd() * 14)}" fill="hsl(${(hue + 30) % 360} 95% 94%)"/>
${ridge(165, 58, 60)}${ridge(200, 42, 45)}${ridge(236, 27, 28)}</svg>`;
}

// ---------- seeded extension storage

const state = (s) => ({ log: [], totals: { uploadedFiles: 0, uploadedBytes: 0 }, trashed: 0, ...s });
const HIKING_STATE = state({
  title: 'Hiking trips', immichAlbum: 'Hiking trips', total: 18, videos: 2,
  phase: 'done', mode: 'check', inImmich: 13, missing: 5, failed: 0,
  lastCheckAt: now - 10 * MIN, lastSyncAt: now - 2 * 86400e3,
  lastSync: { files: 3, bytes: 21.4e6, failed: 0, durationMs: 40e3 },
  totals: { uploadedFiles: 9, uploadedBytes: 61.8e6 },
  run: { startedAt: now - 10 * MIN - 5e3, finishedAt: now - 10 * MIN, toUpload: 0, done: 0, uploadedFiles: 0, uploadedBytes: 0, failed: 0 },
});

const overviewSeed = {
  local: {
    settings: SETTINGS,
    albums: [SUMMER, FAMILY, HIKING],
    lastRun: { at: now - 3 * 60 * MIN, trigger: 'schedule', dryRun: false, results: [] },
    [`albumState:${SUMMER}`]: state({
      title: 'Summer in Italy', immichAlbum: 'Summer in Italy', total: 1284, videos: 212,
      phase: 'uploading', mode: 'sync', inImmich: 822, missing: 461, failed: 1, lastSyncAt: now - 26 * 60 * MIN,
      totals: { uploadedFiles: 780, uploadedBytes: 6.4e9 },
      run: {
        startedAt: now - 41 * MIN + 1e3, uploadStartedAt: now - 40 * MIN, finishedAt: null,
        toUpload: 1242, done: 781, uploadedFiles: 780, uploadedBytes: 6.4e9, failed: 1,
        active: [
          { name: 'PXL_20260714_183512.mp4', step: 'downloading', received: 87.3e6, size: 214.6e6, isVideo: true },
          { name: 'PXL_20260714_184027.jpg', step: 'uploading', received: 4.1e6, size: 4.1e6, isVideo: false },
          { name: 'PXL_20260714_184233.jpg', step: 'downloading', received: 1.2e6, size: 3.8e6, isVideo: false },
        ],
      },
    }),
    [`albumState:${FAMILY}`]: state({
      title: 'Family 2026', immichAlbum: 'Family 2026', total: 356, videos: 41,
      phase: 'done', mode: 'sync', inImmich: 356, missing: 0, failed: 0,
      lastSyncAt: now - 3 * 60 * MIN,
      lastSync: { files: 14, bytes: 96.2e6, failed: 0, durationMs: 2 * MIN },
      totals: { uploadedFiles: 58, uploadedBytes: 402e6 },
      run: { startedAt: now - 3 * 60 * MIN - 2 * MIN, finishedAt: now - 3 * 60 * MIN, toUpload: 14, done: 14, uploadedFiles: 14, uploadedBytes: 96.2e6, failed: 0 },
    }),
    [`albumState:${HIKING}`]: HIKING_STATE,
  },
  session: { syncLock: { trigger: 'schedule', mode: 'sync', since: now - 41 * MIN, beat: now } },
};
const photosSeed = { local: { settings: SETTINGS, albums: [HIKING], [`albumState:${HIKING}`]: HIKING_STATE }, session: {} };

// Runs in the page before app.js: a minimal in-memory chrome.* for the APIs the page uses.
function installChromeStub(seed) {
  const listeners = [];
  const area = (name) => {
    const m = new Map(Object.entries(seed[name] ?? {}));
    const clone = (v) => (v === undefined ? v : structuredClone(v));
    return {
      get: async (keys) => {
        const ks = keys == null ? [...m.keys()] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, clone(m.get(k))]));
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: clone(m.get(k)), newValue: clone(v) };
          m.set(k, clone(v));
        }
        listeners.forEach((l) => l(changes, name));
      },
      remove: async (keys) => {
        const changes = {};
        for (const k of [].concat(keys)) {
          changes[k] = { oldValue: clone(m.get(k)) };
          m.delete(k);
        }
        listeners.forEach((l) => l(changes, name));
      },
    };
  };
  const noop = async () => {};
  window.chrome = {
    storage: {
      local: area('local'),
      session: area('session'),
      onChanged: { addListener: (f) => listeners.push(f), removeListener: (f) => listeners.splice(listeners.indexOf(f), 1) },
    },
    permissions: { contains: async () => true, request: async () => true },
    alarms: { get: async () => ({ name: 'gphotos-sync', periodInMinutes: 60, scheduledTime: Date.now() + 38 * 60e3 }) },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
async function routes(page) {
  const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`${ORIGIN}/**`, (route) => {
    const file = path.join(root, new URL(route.request().url()).pathname);
    route.fulfill({ contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.route(`${IMMICH}/api/**`, (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace('/api', '');
    if (p === '/users/me') return json(route, { id: 'u1', name: 'Alex', email: 'alex@example.com' });
    if (p === '/server/about') return json(route, { version: 'v3.2.2' });
    if (p === '/albums') return json(route, []);
    if (p === '/assets/bulk-upload-check') {
      const { assets } = req.postDataJSON();
      return json(route, {
        results: assets.map((a, i) =>
          missingKeys.has(a.id) ? { id: a.id, action: 'accept' } : { id: a.id, action: 'reject', reason: 'duplicate', assetId: `asset-${i}` },
        ),
      });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.route('https://photos.google.com/share/**', (route) => route.fulfill({ contentType: 'text/html', body: hikingHtml }));
  await page.route('https://photos.google.com/albums', (route) => route.fulfill({ contentType: 'text/html', body: albumsHtml }));
  await page.route('https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=Z5xsfc*', (route) => route.fulfill({ body: albumsRpc }));
  await page.route(`${THUMBS}*`, (route) => {
    const n = Number(route.request().url().slice(THUMBS.length).split('=')[0]);
    route.fulfill({ contentType: 'image/svg+xml', body: landscape(n + 3) });
  });
}

const browser = await chromium.launch({ args: ['--disable-web-security'] });
async function open(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.addInitScript(installChromeStub, seed);
  await routes(page);
  await page.goto(`${ORIGIN}/app.html`);
  await page.waitForSelector('.card');
  await page.waitForFunction(() => document.querySelector('#conn').classList.contains('ok'));
  await page.waitForTimeout(800); // progress-bar transition
  return page;
}

// 1. Overview: one album syncing (background run), one up to date, one with new photos.
let page = await open(overviewSeed);
await page.screenshot({ path: path.join(out, 'overview.png'), fullPage: true });
await page.context().close();

// 2. Add albums dialog: the account's shared albums, two of them ticked.
page = await open({ ...overviewSeed, session: {} });
await page.click('#openPicker');
await page.locator('.pick').first().waitFor();
await page.getByText('Ski week 2026').click();
await page.getByText('Grandma’s 80th birthday').click();
await page.waitForFunction(() => {
  const bottom = document.querySelector('#pickerList').getBoundingClientRect().bottom;
  return [...document.querySelectorAll('.pick img')].every((i) => i.getBoundingClientRect().top > bottom || i.naturalWidth > 0);
});
await page.waitForTimeout(300);
await page.locator('#picker').screenshot({ path: path.join(out, 'add-albums.png') });
await page.context().close();

// 3. Photos panel of an album: opening it runs a real Check against the fakes.
page = await open(photosSeed);
const card = page.locator('.card').first();
await card.locator('.photos summary').click();
await card.locator('.grid .item').first().waitFor();
await page.selectOption('.filter', 'all');
await page.waitForFunction(() => [...document.querySelectorAll('.grid img')].every((i) => i.naturalWidth > 0));
await page.waitForTimeout(500);
await card.screenshot({ path: path.join(out, 'photos.png') });

// 4. Settings dialog.
await card.locator('.photos summary').click();
await page.click('#openSettings');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'settings.png'), clip: { x: 0, y: 0, width: 1000, height: 690 } });
await page.context().close();

await browser.close();
for (const f of fs.readdirSync(out)) console.log(f, `${Math.round(fs.statSync(path.join(out, f)).size / 1024)} KB`);
