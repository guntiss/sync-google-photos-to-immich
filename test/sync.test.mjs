// End-to-end runSync against mocked chrome.* APIs, Google Photos and Immich.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../sync.js';
import { stateKey } from '../state.js';

const store = (m) => ({
  get: async (keys) => {
    const ks = keys == null ? [...m.keys()] : [].concat(keys);
    return Object.fromEntries(ks.filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))]));
  },
  set: async (obj) => Object.entries(obj).forEach(([k, v]) => m.set(k, structuredClone(v))),
  remove: async (keys) => [].concat(keys).forEach((k) => m.delete(k)),
});
const local = new Map();
const session = new Map();
const snapshots = [];
const localArea = store(local);
globalThis.chrome = {
  storage: {
    local: { ...localArea, set: async (obj) => (snapshots.push(structuredClone(obj)), localArea.set(obj)) },
    session: store(session),
  },
  permissions: { contains: async () => true },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

const ALBUM_URL = 'https://photos.google.com/share/AF1Qipalbum';
const IMMICH = 'https://immich.test';
const key = (n) => 'AF1Qip' + String(n).padStart(40, 'x');
const item = (n, ms) => [key(n), [`https://photos.fife.usercontent.google.com/pw/p${n}`, 4000, 3000], ms, `dedup${n}`, 0, ms];
const page = [null, [item(1, 300), item(2, 100), item(3, 200)], null, [key(999), 'Holiday']];
const html = `<script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify(page)}, sideChannel: {}});</script>`;

const uploads = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (url === ALBUM_URL) {
    const r = new Response(html);
    Object.defineProperty(r, 'url', { value: ALBUM_URL });
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
  assert.equal(s.albumKey, key(999), 'album key recorded, so the picker knows the album is added');
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
