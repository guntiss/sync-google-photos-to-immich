// Run: node --test test/gphotos.test.mjs
// Uses a synthetic fixture shaped like the Google Photos share page; it does
// NOT prove the live format matches — see README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listAlbum, parseAlbumUrl } from '../gphotos.js';

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

test('login redirect gives a clear error', async () => {
  globalThis.fetch = async () => {
    const r = new Response('', { status: 200 });
    Object.defineProperty(r, 'url', { value: 'https://accounts.google.com/v3/signin' });
    return r;
  };
  await assert.rejects(listAlbum('https://photos.google.com/share/x'), /Not signed in/);
});
