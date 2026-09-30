// End-to-end runSync against mocked chrome.* APIs, Google Photos and Immich.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../sync.js';
import { getLock, requestStop, stateKey } from '../state.js';

const listeners = new Set();
const store = (m, area) => ({
  get: async (keys) => {
    const ks = keys == null ? [...m.keys()] : [].concat(keys);
    return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))]));
  },
  set: async (obj) => {
    Object.entries(obj).forEach(([k, v]) => m.set(k, structuredClone(v)));
    const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { newValue: structuredClone(v) }]));
    listeners.forEach((f) => f(changes, area));
  },
  remove: async (keys) => [].concat(keys).forEach((k) => m.delete(k)),
});
const local = new Map();
const session = new Map();
const snapshots = [];
const localArea = store(local, 'local');
globalThis.chrome = {
  storage: {
    local: { ...localArea, set: async (obj) => (snapshots.push(structuredClone(obj)), localArea.set(obj)) },
    session: store(session, 'session'),
    onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
  },
  permissions: { contains: async () => true },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

const ALBUM_URL = 'https://photos.google.com/share/AF1Qipalbum';
const ALBUM2_URL = 'https://photos.google.com/share/AF1Qipalbum2';
const IMMICH = 'https://immich.test';
const key = (n) => 'AF1Qip' + String(n).padStart(40, 'x');
const item = (n, ms) => [key(n), [`https://photos.fife.usercontent.google.com/pw/p${n}`, 4000, 3000], ms, `dedup${n}`, 0, ms];
const albumHtml = (items, title) =>
  `<script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify([null, items, null, [key(990 + items.length), title]])}, sideChannel: {}});</script>`;
const albums = {
  [ALBUM_URL]: albumHtml([item(1, 300), item(2, 100), item(3, 200)], 'Holiday'),
  [ALBUM2_URL]: albumHtml([item(4, 100), item(5, 200), item(6, 300), item(7, 400)], 'Party'),
};

const uploads = [];
let onFetch = null; // test hook, called with each url before it is answered
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  await onFetch?.(url);
  init.signal?.throwIfAborted();
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (albums[url]) {
    const r = new Response(albums[url]);
    Object.defineProperty(r, 'url', { value: url });
    return r;
  }
  const dl = url.match(/\/p(\d)=d$/);
  if (dl) {
    const size = 1000 * Number(dl[1]);
    return new Response(new Uint8Array(size), {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(size), 'content-disposition': `attachment; filename="IMG_${dl[1]}.jpg"` },
    });
  }
  const path = url.replace(`${IMMICH}/api`, '');
  const m = init.method ?? 'GET';
  if (path === '/users/me') return json({ id: 'u', name: 'Tester' });
  if (path === '/assets/bulk-upload-check') {
    const { assets } = JSON.parse(init.body);
    return json({
      results: assets.map((a) =>
        a.id === key(1) ? { id: a.id, action: 'reject', reason: 'duplicate', assetId: 'existing1' } : { id: a.id, action: 'accept' },
      ),
    });
  }
  if (path === '/assets' && m === 'POST') {
    uploads.push(init.body.get('filename'));
    return json({ id: `new-${init.body.get('filename')}`, status: 'created' });
  }
  if (path === '/albums' && m === 'GET') return json([]);
  if (path === '/albums' && m === 'POST') return json({ id: 'alb1', albumName: JSON.parse(init.body).albumName });
  if (path === '/albums/alb1/assets') return json(JSON.parse(init.body).ids.map((id) => ({ id, success: true })));
  throw new Error(`unexpected fetch ${m} ${url}`);
};

local.set('settings', { immichUrl: IMMICH, apiKey: 'k', addExisting: true, intervalMinutes: 0 });
local.set('albums', [ALBUM_URL]);

test('check reports what is missing without copying', async () => {
  const run = await runSync({ dryRun: true });
  assert.equal(uploads.length, 0);
  assert.deepEqual(run.results[0], { url: ALBUM_URL, title: 'Holiday', percent: 33, uploaded: 0, bytes: 0, failed: 0 });
  const s = local.get(stateKey(ALBUM_URL));
  assert.equal(s.phase, 'done');
  assert.equal(s.mode, 'check');
  assert.equal(s.albumKey, key(993), 'album key recorded, so the picker knows the album is added');
  assert.equal(s.missing, 2);
  assert.equal(session.size, 0, 'lock released');
});

test('sync copies oldest first and records progress and stats', async () => {
  snapshots.length = 0;
  const run = await runSync({});
  assert.deepEqual(uploads, ['IMG_2.jpg', 'IMG_3.jpg']);
  assert.deepEqual(run.results[0], { url: ALBUM_URL, title: 'Holiday', percent: 100, uploaded: 2, bytes: 5000, failed: 0 });

  const s = local.get(stateKey(ALBUM_URL));
  assert.equal(s.phase, 'done');
  assert.equal(s.missing, 0);
  assert.equal(s.inImmich, 3);
  assert.deepEqual(s.totals, { uploadedFiles: 2, uploadedBytes: 5000 });
  assert.equal(s.lastSync.files, 2);
  assert.ok(s.log.some((l) => l.includes('Copied IMG_2.jpg')));

  const phases = snapshots.map((o) => o[stateKey(ALBUM_URL)]?.phase).filter(Boolean);
  const order = [...new Set(phases)];
  assert.deepEqual(order, ['listing', 'checking', 'uploading', 'album', 'done']);
  const mid = snapshots.map((o) => o[stateKey(ALBUM_URL)]).find((x) => x?.phase === 'uploading' && x.run.done === 1);
  assert.equal(mid.missing, 1, 'percentage advances per copied item');
  assert.equal(session.size, 0, 'lock released');
});

test('a second run is refused while the lock is held', async () => {
  session.set('syncLock', { trigger: 'schedule', since: Date.now(), beat: Date.now() });
  await assert.rejects(runSync({}), /already running/);
  session.clear();
});

test('a stop request ends the run without counting the interrupted item as failed', async () => {
  uploads.length = 0;
  const before = local.get(stateKey(ALBUM_URL));
  let downloads = 0;
  onFetch = async (url) => {
    if (url.endsWith('=d') && ++downloads === 2) await requestStop(await getLock());
  };
  const run = await runSync({ urls: [ALBUM2_URL, ALBUM_URL] });
  onFetch = null;

  assert.deepEqual(uploads, ['IMG_4.jpg'], 'stopped during the second download');
  assert.equal(run.stopped, true);
  assert.equal(run.error, undefined);
  assert.deepEqual(run.results, [{ url: ALBUM2_URL, title: 'Party', stopped: true, uploaded: 1, bytes: 4000, failed: 0 }]);
  const s = local.get(stateKey(ALBUM2_URL));
  assert.equal(s.phase, 'stopped');
  assert.equal(s.run.current, null);
  assert.deepEqual([s.inImmich, s.missing, s.failed], [1, 3, 0]);
  assert.match(s.log.at(-1), /Sync stopped after copying 1 /);
  assert.deepEqual(local.get(stateKey(ALBUM_URL)), before, 'albums after the stopped one are left alone');
  assert.equal(session.size, 0, 'lock and stop request cleared');

  const next = await runSync({ urls: [ALBUM2_URL] });
  assert.deepEqual(uploads, ['IMG_4.jpg', 'IMG_5.jpg', 'IMG_6.jpg', 'IMG_7.jpg'], 'the next sync continues where it stopped');
  assert.equal(next.stopped, undefined);
  assert.equal(local.get(stateKey(ALBUM2_URL)).phase, 'done');
});

test('a stop request for an earlier run is ignored', async () => {
  session.set('syncStop', Date.now() - 1000);
  const run = await runSync({ urls: [ALBUM_URL], dryRun: true });
  assert.equal(run.stopped, undefined);
  assert.equal(local.get(stateKey(ALBUM_URL)).phase, 'done');
});
