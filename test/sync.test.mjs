// End-to-end runSync against mocked chrome.* APIs, Google Photos and Immich.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_KEY, runSync } from '../sync.js';
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
const assets = new Map(); // Immich: id -> {id, type, fileCreatedAt, isTrashed}
const metadata = new Map(); // Immich: asset id -> {key: value}
const metadataWrites = [];
let onFetch = null; // test hook, called with each request before it is answered
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  await onFetch?.(url, init);
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
    const filename = init.body.get('filename');
    uploads.push(filename);
    const id = `new-${filename}`;
    assets.set(id, { id, type: 'IMAGE', fileCreatedAt: init.body.get('fileCreatedAt'), isTrashed: false });
    return json({ id, status: 'created' });
  }
  if (path === '/search/metadata') {
    const q = JSON.parse(init.body);
    const inRange = (a) => Date.parse(q.takenAfter) <= Date.parse(a.fileCreatedAt) && Date.parse(a.fileCreatedAt) <= Date.parse(q.takenBefore);
    return json({ assets: { items: [...assets.values()].filter(inRange), nextPage: null } });
  }
  const meta = path.match(/^\/assets\/([^/]+)\/metadata$/);
  if (meta && m === 'GET') return json(Object.entries(metadata.get(meta[1]) ?? {}).map(([key, value]) => ({ key, value })));
  if (path === '/assets/metadata' && m === 'PUT') {
    const { items } = JSON.parse(init.body);
    if (items.some((x) => !assets.has(x.assetId))) return new Response('{"message":"Not found or no asset.update access"}', { status: 400 });
    items.forEach((x) => metadata.set(x.assetId, { ...metadata.get(x.assetId), [x.key]: x.value }));
    metadataWrites.push(...items);
    return json(items);
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
  const started = [];
  onFetch = (url) => void (/=d$/.test(url) && started.push(url));
  const run = await runSync({});
  onFetch = null;
  assert.deepEqual(started.map((u) => u.match(/p(\d)=d$/)[1]), ['2', '3'], 'oldest first');
  assert.deepEqual([...uploads].sort(), ['IMG_2.jpg', 'IMG_3.jpg']);
  assert.deepEqual(run.results[0], { url: ALBUM_URL, title: 'Holiday', percent: 100, uploaded: 2, bytes: 5000, failed: 0 });

  const s = local.get(stateKey(ALBUM_URL));
  assert.equal(s.phase, 'done');
  assert.equal(s.missing, 0);
  assert.equal(s.inImmich, 3);
  assert.deepEqual(s.totals, { uploadedFiles: 2, uploadedBytes: 5000 });
  assert.equal(s.lastSync.files, 2);
  assert.equal(s.lastSync.download.bytes, 5000);
  assert.equal(s.lastSync.upload.bytes, 5000);
  assert.equal(s.run.download.active, 0, 'meters are stopped when the run ends');
  assert.equal(s.run.upload.since, null);
  assert.ok(s.log.some((l) => l.includes('Copied IMG_2.jpg')));
  assert.deepEqual(metadata.get('new-IMG_2.jpg'), { [RECORD_KEY]: { mediaKey: key(2), dedupKey: 'dedup2' } }, 'copies are marked in Immich');
  assert.deepEqual(Object.keys(local.get('recorded')).sort(), [key(2), key(3)]);

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

test('copies run a few at a time, and a stop request ends the run without counting the interrupted items as failed', async () => {
  uploads.length = 0;
  const before = local.get(stateKey(ALBUM_URL));
  const held = new Map(); // download number -> release
  onFetch = (url, init) => {
    const n = url.match(/\/p(\d)=d$/)?.[1];
    if (!n) return;
    return new Promise((resolve) => {
      held.set(n, resolve);
      init.signal?.addEventListener('abort', resolve);
    });
  };
  const until = async (cond) => {
    for (const end = Date.now() + 2000; !cond(); await new Promise((r) => setImmediate(r))) {
      if (Date.now() > end) throw new Error(`timed out; downloads held: ${[...held.keys()]}`);
    }
  };
  const running = runSync({ urls: [ALBUM2_URL, ALBUM_URL] });
  let run;
  try {
    await until(() => held.size === 3);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...held.keys()], ['4', '5', '6'], 'the three oldest download at once, the fourth waits');
    held.get('4')();
    await until(() => held.has('7'));
    assert.deepEqual(uploads, ['IMG_4.jpg'], 'the fourth starts once the first is copied');
  } finally {
    // Stop while 5, 6 and 7 are downloading (or, if the test failed, so later tests can run).
    const lock = await getLock();
    if (lock) await requestStop(lock);
    run = await running;
    onFetch = null;
  }

  assert.equal(run.stopped, true);
  assert.equal(run.error, undefined);
  assert.deepEqual(run.results, [{ url: ALBUM2_URL, title: 'Party', stopped: true, uploaded: 1, bytes: 4000, failed: 0 }]);
  const s = local.get(stateKey(ALBUM2_URL));
  assert.equal(s.phase, 'stopped');
  assert.deepEqual(s.run.active, []);
  assert.deepEqual([s.inImmich, s.missing, s.failed], [1, 3, 0]);
  assert.match(s.log.at(-1), /Sync stopped after copying 1 /);
  assert.deepEqual(local.get(stateKey(ALBUM_URL)), before, 'albums after the stopped one are left alone');
  assert.equal(session.size, 0, 'lock and stop request cleared');

  const next = await runSync({ urls: [ALBUM2_URL] });
  assert.deepEqual(uploads.slice(1).sort(), ['IMG_5.jpg', 'IMG_6.jpg', 'IMG_7.jpg'], 'the next sync continues where it stopped');
  assert.equal(next.stopped, undefined);
  assert.equal(local.get(stateKey(ALBUM2_URL)).phase, 'done');
});

test('a stop request for an earlier run is ignored', async () => {
  session.set('syncStop', Date.now() - 1000);
  const run = await runSync({ urls: [ALBUM_URL], dryRun: true });
  assert.equal(run.stopped, undefined);
  assert.equal(local.get(stateKey(ALBUM_URL)).phase, 'done');
});

test('another install finds the copies by their mark in Immich instead of downloading', async () => {
  local.delete('ledger');
  local.delete('recorded');
  uploads.length = 0;
  let downloads = 0;
  onFetch = (url) => void (/=dv?$/.test(url) && downloads++);
  await runSync({ urls: [ALBUM_URL] });
  onFetch = null;

  assert.equal(downloads, 0);
  assert.deepEqual(uploads, []);
  const s = local.get(stateKey(ALBUM_URL));
  assert.deepEqual([s.inImmich, s.missing], [3, 0]);
  assert.ok(s.log.some((l) => l.includes('Found 2 copies made from another browser or install')));
  assert.equal(local.get('ledger')[key(2)], 'new-IMG_2.jpg', 'remembered locally from then on');
});

test('a copy is found despite time zone and video time differences, but only by its mark', async () => {
  const url = 'https://photos.google.com/share/AF1Qipalbum3';
  const T = Date.UTC(2026, 5, 1, 12);
  const video = (n, ms) => [...item(n, ms), { 76647426: [5000] }];
  albums[url] = albumHtml([item(8, T), video(9, T), item(10, T)], 'Trip');
  const add = (id, type, ms, mark) => {
    assets.set(id, { id, type, fileCreatedAt: new Date(ms).toISOString(), isTrashed: false });
    metadata.set(id, { [RECORD_KEY]: mark });
  };
  add('decoy', 'IMAGE', T, { mediaKey: 'someone-else', dedupKey: 'other' });
  add('photo8', 'IMAGE', T + 3 * 3_600_000, { mediaKey: key(8), dedupKey: 'dedup8' });
  add('video9', 'VIDEO', T + 7 * 60_000, { mediaKey: key(9), dedupKey: 'dedup9' });
  add('photo10', 'IMAGE', T + 7 * 60_000, { mediaKey: key(10), dedupKey: 'dedup10' });

  await runSync({ urls: [url], dryRun: true });
  const s = local.get(stateKey(url));
  assert.deepEqual([s.inImmich, s.missing], [2, 1], 'a photo 7 minutes off is not taken for the copy');
  assert.equal(local.get('ledger')[key(8)], 'photo8');
  assert.equal(local.get('ledger')[key(9)], 'video9');
});

test('copies made before marking are marked on the next sync, skipping deleted ones', async () => {
  metadata.delete('new-IMG_2.jpg');
  local.set('ledger', { [key(2)]: 'new-IMG_2.jpg', [key(3)]: 'deleted-in-immich' });
  local.set('recorded', {});
  metadataWrites.length = 0;

  await runSync({ urls: [ALBUM_URL], dryRun: true });
  assert.equal(metadataWrites.length, 0, 'a check changes nothing in Immich');

  await runSync({ urls: [ALBUM_URL] });
  assert.deepEqual(metadata.get('new-IMG_2.jpg'), { [RECORD_KEY]: { mediaKey: key(2), dedupKey: 'dedup2' } });
  assert.deepEqual(Object.keys(local.get('recorded')).sort(), [key(2), key(3)].sort(), 'the deleted one is not retried');
  assert.ok(!local.get(stateKey(ALBUM_URL)).log.some((l) => l.includes('Could not mark')));

  metadataWrites.length = 0;
  await runSync({ urls: [ALBUM_URL] });
  assert.equal(metadataWrites.length, 0, 'marked once');
});
