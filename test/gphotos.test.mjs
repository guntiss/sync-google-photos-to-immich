// Run: node --test test/gphotos.test.mjs
// Uses a synthetic fixture shaped like the Google Photos share page; it does
// NOT prove the live format matches — see README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchableUrl, listAlbum, listAlbums, parseAlbumUrl } from '../gphotos.js';

const key = (n) => 'AF1Qip' + String(n).padStart(40, 'x');
const item = (n, ms, video = false) => [
  key(n),
  [`https://photos.fife.usercontent.google.com/pw/photo${n}`, 4000, 3000],
  ms,
  `dedup${n}`,
  7200000,
  ms + 1000,
  null, null, null, null, null, null,
  video ? { 76647426: [12000] } : null,
];

const ALBUM = key(999);
const page1 = [null, [item(1, 300), item(2, 200, true)], 'NEXTTOKEN_ABCDEFG', [ALBUM, 'Trip & Fun']];
const html = `<html><head><title>Trip &amp; Fun · Jan 1 - Google Photos</title></head><body>
<script>window.WIZ_global_data = {"SNlM0e":"ATOKEN:123","FdrFJe":"-123","cfb2h":"boq_photos"};</script>
<script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify(page1)}, sideChannel: {}});</script></body></html>`;

const page2 = [[item(3, 100)], null];
const batch = `)]}'\n\n123\n${JSON.stringify([['wrb.fr', 'snAcKc', JSON.stringify(page2), null, null, null, 'generic']])}\n25\n[["e",4,null,null,1]]\n`;

test('parseAlbumUrl', () => {
  assert.deepEqual(parseAlbumUrl('https://photos.google.com/share/AF1Qipabc?key=K1'), { shareId: 'AF1Qipabc', authKey: 'K1' });
  assert.throws(() => parseAlbumUrl('https://example.com/share/x'));
});

test('listAlbum follows pagination and sorts newest first', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('batchexecute')) {
      assert.match(init.body.get('f.req'), /NEXTTOKEN_ABCDEFG/);
      assert.equal(init.body.get('at'), 'ATOKEN:123');
      return new Response(batch, { status: 200 });
    }
    const r = new Response(html, { status: 200 });
    Object.defineProperty(r, 'url', { value: 'https://photos.google.com/share/AF1Qipabc' });
    return r;
  };
  const res = await listAlbum('https://photos.google.com/share/AF1Qipabc');
  assert.equal(res.title, 'Trip & Fun');
  assert.equal(res.albumKey, ALBUM);
  assert.deepEqual(res.items.map((i) => i.takenMs), [300, 200, 100]);
  assert.equal(res.items[1].isVideo, true);
  assert.equal(res.items[1].durationMs, 12000);
  assert.equal(res.pages, 2);
});

test('short links are fetched through their desktop redirect', async () => {
  assert.equal(fetchableUrl(' https://photos.app.goo.gl/AbC123 '), 'https://photos.app.goo.gl/AbC123?_imcp=1');
  assert.equal(fetchableUrl('https://photos.google.com/share/AF1Qipabc?key=K1'), 'https://photos.google.com/share/AF1Qipabc?key=K1');
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).includes('batchexecute')) return new Response(batch, { status: 200 });
    const r = new Response(html, { status: 200 });
    Object.defineProperty(r, 'url', { value: 'https://photos.google.com/share/AF1Qipabc?key=K1' });
    return r;
  };
  const res = await listAlbum('https://photos.app.goo.gl/AbC123');
  assert.equal(fetched[0], 'https://photos.app.goo.gl/AbC123?_imcp=1');
  assert.equal(res.url, 'https://photos.google.com/share/AF1Qipabc?key=K1');
  assert.equal(res.items.length, 3);
});

// Albums list (rpc Z5xsfc), shaped like the real one: shared albums carry a short link,
// unshared ones don't and are shorter.
const ME = 'AF1QipMeActor00000000000000000000';
const OTHER = 'AF1QipOtherActor0000000000000000';
const albumEntry = (n, { owner = ME, title, count, link = null }) => {
  const meta = { 72930366: [link ? 4 : 1, title, [1000 * n, 2000 * n, null, null, 3000 * n], count, 1, link && owner !== ME ? 'SHAREKEY' : null, [n]] };
  if (link) meta[72930366].push([1, 1], owner === ME ? key(500 + n) : null, null, link);
  const cover = [`https://photos.fife.usercontent.google.com/pw/cover${n}`, 4000, 3000, null, null, null, null, null, null, [123]];
  const head = [key(100 + n), cover, null, null, null, null, [owner], [[9], [8]]];
  return link ? [...head, null, null, [null, null, null, null, null, [null, 10]], meta] : [...head, meta];
};
const albumsPage1 = [[
  albumEntry(1, { owner: OTHER, title: 'Grandma 80', count: 42, link: 'https://photos.app.goo.gl/Grandma80Link1' }),
  albumEntry(2, { title: 'Receipts', count: 7 }),
], 'ALBUMS_PAGE_2_TOKEN', [1], [1]];
const albumsPage2 = [[albumEntry(3, { title: 'Garden', count: 0, link: 'https://photos.app.goo.gl/GardenLink3' })]];
const albumsHtml = `<html><head><script>window.WIZ_global_data = {"SNlM0e":"ATOKEN:456","FdrFJe":"-9","cfb2h":"boq_photos","oPEP7c":"alex@example.com"};</script>
<script>var AF_dataServiceRequests = {'ds:0' : {id:'Z5xsfc',ext: 7.2930366E7 ,request:[null,null,null,null,1,null,null,100,[2],5]},'ds:1' : {id:'O3G8Nd',ext: 1.50230321E8 ,request:[1]}};</script></head><body>
<script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify([[ME, '1234567890', null, null, null, [ME, '1234567890'], null, null, null, null, null, ['Alex Example', 1, null, 'Alex']]])}, sideChannel: {}});</script></body></html>`;
const batchOf = (rpc, data) => `)]}'\n\n123\n${JSON.stringify([['wrb.fr', rpc, JSON.stringify(data), null, null, null, 'generic']])}\n`;

test('listAlbums pages through the account albums and tells whose they are', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === 'https://photos.google.com/albums') {
      const r = new Response(albumsHtml, { status: 200 });
      Object.defineProperty(r, 'url', { value: url });
      return r;
    }
    assert.match(url, /batchexecute\?rpcids=Z5xsfc&source-path=%2Falbums/);
    assert.equal(init.body.get('at'), 'ATOKEN:456');
    const [[[rpc, inner]]] = JSON.parse(init.body.get('f.req'));
    requests.push(JSON.parse(inner));
    return new Response(batchOf(rpc, requests.length === 1 ? albumsPage1 : albumsPage2), { status: 200 });
  };
  const { account, albums } = await listAlbums();
  assert.equal(account, 'alex@example.com');
  assert.deepEqual(requests.map((r) => r[0]), [null, 'ALBUMS_PAGE_2_TOKEN']);
  assert.deepEqual(
    albums.map((a) => [a.title, a.url, a.ownedByMe, a.count]),
    [
      ['Grandma 80', 'https://photos.app.goo.gl/Grandma80Link1', false, 42],
      ['Receipts', null, true, 7],
      ['Garden', 'https://photos.app.goo.gl/GardenLink3', true, 0],
    ],
  );
  assert.equal(albums[0].albumKey, key(101));
  assert.equal(albums[0].coverUrl, 'https://photos.fife.usercontent.google.com/pw/cover1');
  assert.deepEqual([albums[0].firstMs, albums[0].lastMs], [1000, 2000]);
});

test('listAlbums without a Google session gives a clear error', async () => {
  globalThis.fetch = async () => {
    const r = new Response('<html>Sign in to continue</html>', { status: 200 });
    Object.defineProperty(r, 'url', { value: 'https://www.google.com/photos/about/' });
    return r;
  };
  await assert.rejects(listAlbums(), /Not signed in/);
});

test('login redirect gives a clear error', async () => {
  globalThis.fetch = async () => {
    const r = new Response('', { status: 200 });
    Object.defineProperty(r, 'url', { value: 'https://accounts.google.com/v3/signin' });
    return r;
  };
  await assert.rejects(listAlbum('https://photos.google.com/share/x'), /Not signed in/);
});
