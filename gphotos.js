// Reads Google Photos albums using the browser's signed-in session.
// There is no official API for this (the Library API no longer exposes
// user-shared albums), so this uses the same internal endpoints the web UI does:
//   1. GET the /share/<id> page; the first page of items is embedded in an
//      AF_initDataCallback({... data: [...]}) blob.
//   2. Further pages come from POST /_/PhotosUi/data/batchexecute (rpc snAcKc).
//   3. The account's albums, including shared albums it has joined, come from
//      the same endpoint (rpc Z5xsfc), as on the /albums page.
// The format is undocumented, so items are located by shape rather than by
// fixed indexes wherever possible.

const PHOTOS = 'https://photos.google.com';
const KEY_PREFIX = 'AF1Qip';
const VIDEO_INFO_KEY = '76647426';
const ALBUM_META_KEY = '72930366';
const SHORT_LINK = /^https:\/\/photos\.app\.goo\.gl\/\w+$/;
const MAX_PAGES = 500;

export function parseAlbumUrl(input) {
  const u = new URL(input.trim());
  const m = u.pathname.match(/^\/share\/([^/]+)/);
  if (u.hostname !== 'photos.google.com' || !m) {
    throw new Error(`Not a Google Photos shared album URL: ${input}`);
  }
  return { shareId: m[1], authKey: u.searchParams.get('key') };
}

// photos.app.goo.gl links now open an interstitial page; its desktop link (?_imcp=1)
// redirects to the album instead.
export function fetchableUrl(input) {
  const u = new URL(input.trim());
  if (u.hostname === 'photos.app.goo.gl') u.searchParams.set('_imcp', '1');
  return u.href;
}

export function extractDataBlocks(html) {
  // AF_dataServiceRequests = {'ds:0' : {id:'Z5xsfc', ...}, ...} says which rpc filled each block.
  const rpcs = Object.fromEntries([...html.matchAll(/'(ds:\d+)' : \{id:'(\w+)'/g)].map((m) => [m[1], m[2]]));
  const re = /AF_initDataCallback\(\{key: '(ds:\d+)'.*?data:(.*?), sideChannel: \{\}\}\);<\/script>/gs;
  const blocks = [];
  for (const m of html.matchAll(re)) {
    try {
      blocks.push({ key: m[1], rpc: rpcs[m[1]] ?? null, data: JSON.parse(m[2]) });
    } catch {
      // not JSON; ignore
    }
  }
  return blocks;
}

export function parseBatchExecute(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) continue;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of chunk) {
      if (Array.isArray(e) && e[0] === 'wrb.fr' && typeof e[2] === 'string') {
        try {
          out.push({ rpc: e[1], data: JSON.parse(e[2]) });
        } catch {
          // ignore malformed payload
        }
      }
    }
  }
  return out;
}

function isItem(a) {
  return (
    Array.isArray(a) &&
    typeof a[0] === 'string' &&
    a[0].length >= 30 &&
    Array.isArray(a[1]) &&
    typeof a[1][0] === 'string' &&
    a[1][0].startsWith('https://') &&
    typeof a[2] === 'number'
  );
}

// Find arrays whose elements are all media items; remember where they hang so
// the sibling next-page token can be read.
export function findItemLists(node, parent = null, idx = -1, found = []) {
  if (!Array.isArray(node)) return found;
  if (node.length > 0 && node.every(isItem)) {
    found.push({ list: node, parent, idx });
    return found;
  }
  node.forEach((child, i) => findItemLists(child, node, i, found));
  return found;
}

function normalizeItem(a) {
  const videoInfo = a.find(
    (x) => x && typeof x === 'object' && !Array.isArray(x) && VIDEO_INFO_KEY in x,
  );
  const item = {
    mediaKey: a[0],
    thumbUrl: a[1][0],
    width: a[1][1] ?? null,
    height: a[1][2] ?? null,
    takenMs: a[2],
    dedupKey: typeof a[3] === 'string' ? a[3] : null,
    tzOffsetMs: typeof a[4] === 'number' ? a[4] : null,
    uploadedMs: typeof a[5] === 'number' ? a[5] : null,
    isVideo: Boolean(videoInfo),
  };
  if (videoInfo) item.durationMs = videoInfo[VIDEO_INFO_KEY]?.[0] ?? null;
  return item;
}

// Returns { items, nextToken, albumKey, title } from one decoded payload.
export function parsePayload(data) {
  const lists = findItemLists(data);
  const items = lists.flatMap((l) => l.list.map(normalizeItem));
  let nextToken = null;
  let albumKey = null;
  let title = null;
  for (const { parent, idx } of lists) {
    if (!parent) continue;
    const t = parent[idx + 1];
    if (typeof t === 'string' && t.length > 10 && !t.startsWith(KEY_PREFIX)) nextToken = t;
    const meta = parent.find((x) => Array.isArray(x) && typeof x[0] === 'string' && x[0].startsWith(KEY_PREFIX));
    if (meta) {
      albumKey = meta[0];
      if (typeof meta[1] === 'string') title = meta[1];
    }
  }
  return { items, nextToken, albumKey, title };
}

function pickWiz(html, name) {
  const m = html.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

function pickTitle(html) {
  const m =
    html.match(/<meta property="og:title" content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/ - Google Photos$/, '')
    .trim();
}

// Session tokens batchexecute needs, from any signed-in photos.google.com page.
function pageContext(html) {
  return { at: pickWiz(html, 'SNlM0e'), sid: pickWiz(html, 'FdrFJe'), bl: pickWiz(html, 'cfb2h') };
}

// Call one rpc; returns its decoded payloads plus the raw response for debugging.
async function batchExecute(ctx, rpcid, request, sourcePath) {
  const freq = JSON.stringify([[[rpcid, JSON.stringify(request), null, 'generic']]]);
  const qs = new URLSearchParams({
    rpcids: rpcid,
    'source-path': sourcePath,
    hl: 'en',
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: 'c',
  });
  if (ctx.sid) qs.set('f.sid', ctx.sid);
  if (ctx.bl) qs.set('bl', ctx.bl);
  const body = new URLSearchParams({ 'f.req': freq });
  if (ctx.at) body.set('at', ctx.at);

  const res = await fetch(`${PHOTOS}/_/PhotosUi/data/batchexecute?${qs}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  if (!res.ok) throw new Error(`batchexecute ${rpcid} failed: HTTP ${res.status}`);
  const text = await res.text();
  const payloads = parseBatchExecute(text).filter((p) => p.rpc === rpcid).map((p) => p.data);
  return { payloads, text };
}

/**
 * List every item in a shared album.
 * @param {string} input album URL (photos.google.com/share/... or a photos.app.goo.gl short link)
 * @param {{onProgress?: (n: number) => void, debug?: boolean}} opts
 */
export async function listAlbum(input, opts = {}) {
  const res = await fetch(fetchableUrl(input), { credentials: 'include', redirect: 'follow' });
  if (res.url.startsWith('https://accounts.google.com/')) {
    throw new Error('Not signed in to Google in this browser profile (redirected to login).');
  }
  if (res.status === 404) {
    throw new Error('Album not found (404). It may not be shared with the signed-in account.');
  }
  if (!res.ok) throw new Error(`Album page failed: HTTP ${res.status}`);

  const html = await res.text();
  const { shareId, authKey } = parseAlbumUrl(res.url);
  const blocks = extractDataBlocks(html);
  const debug = opts.debug ? { blocks, pages: [] } : null;

  const items = new Map();
  let albumKey = null;
  let albumTitle = null;
  let nextToken = null;
  for (const b of blocks) {
    const p = parsePayload(b.data);
    if (!p.items.length) continue;
    p.items.forEach((it) => items.set(it.mediaKey, it));
    albumKey = albumKey || p.albumKey;
    albumTitle = albumTitle || p.title;
    nextToken = p.nextToken;
  }
  if (!items.size) {
    const err = new Error(
      'No photos found on the album page (no access, empty album, or page format changed). ' +
        'Use "Download raw" to inspect.',
    );
    err.debug = {
      finalUrl: res.url,
      status: res.status,
      htmlLength: html.length,
      title: pickTitle(html),
      dataBlockKeys: blocks.map((b) => b.key),
      initDataCallbackCount: (html.match(/AF_initDataCallback/g) || []).length,
      html,
    };
    throw err;
  }
  opts.onProgress?.(items.size);

  const ctx = pageContext(html);
  albumKey ||= shareId;

  let pages = 1;
  while (nextToken && pages < MAX_PAGES) {
    const request = [albumKey, nextToken, null, authKey];
    const { payloads, text } = await batchExecute(ctx, 'snAcKc', request, `/share/${shareId}`);
    debug?.pages.push(text);
    const before = items.size;
    let token = null;
    for (const data of payloads) {
      const p = parsePayload(data);
      p.items.forEach((it) => items.set(it.mediaKey, it));
      if (p.nextToken) token = p.nextToken;
    }
    pages++;
    opts.onProgress?.(items.size);
    if (items.size === before || token === nextToken) break;
    nextToken = token;
  }

  const sorted = [...items.values()].sort((a, b) => b.takenMs - a.takenMs);
  return {
    url: res.url,
    title: albumTitle || pickTitle(html),
    albumKey,
    pages,
    items: sorted,
    ...(debug && { debug }),
  };
}

// One entry of the albums list (rpc Z5xsfc):
//   [albumKey, [coverUrl, w, h, ...], ..., [ownerId], ...,
//    {72930366: [kind, title, [firstTakenMs, lastTakenMs, ...], itemCount, ..., shortLink]}]
// Only shared albums have a short link.
export function parseAlbumEntry(e) {
  if (!Array.isArray(e) || typeof e[0] !== 'string' || !e[0].startsWith(KEY_PREFIX)) return null;
  const meta = e.find((x) => x && typeof x === 'object' && !Array.isArray(x) && ALBUM_META_KEY in x)?.[ALBUM_META_KEY];
  if (!Array.isArray(meta) || typeof meta[1] !== 'string') return null;
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    albumKey: e[0],
    title: meta[1],
    count: num(meta[3]),
    firstMs: num(meta[2]?.[0]),
    lastMs: num(meta[2]?.[1]),
    coverUrl: typeof e[1]?.[0] === 'string' ? e[1][0] : null,
    ownerId: typeof e[6]?.[0] === 'string' ? e[6][0] : null,
    url: meta.find((x) => typeof x === 'string' && SHORT_LINK.test(x)) ?? null,
  };
}

/**
 * List the signed-in account's albums, including shared albums it has joined, as on
 * the /albums page. Shared albums have `url` (a photos.app.goo.gl link listAlbum can
 * read); albums that aren't shared have url: null.
 * @returns {Promise<{account: string|null, albums: Array<ReturnType<typeof parseAlbumEntry> & {ownedByMe: boolean|null}>}>}
 */
export async function listAlbums() {
  const res = await fetch(`${PHOTOS}/albums`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Albums page failed: HTTP ${res.status}`);
  const html = await res.text();
  const ctx = pageContext(html);
  if (!ctx.at || !res.url.startsWith(PHOTOS)) {
    throw new Error('Not signed in to Google in this browser profile.');
  }
  // rpc O3G8Nd describes the signed-in user: [actorId, gaiaId, ..., [name, ...] at 11, ...]
  const self = extractDataBlocks(html).find((b) => b.rpc === 'O3G8Nd')?.data?.[0];
  const me = typeof self?.[0] === 'string' ? self[0] : null;
  const account = pickWiz(html, 'oPEP7c') || (typeof self?.[11]?.[0] === 'string' ? self[11][0] : null);

  const albums = new Map();
  let token = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const request = [token, null, null, null, 1, null, null, 100, [2], 5];
    const { payloads } = await batchExecute(ctx, 'Z5xsfc', request, '/albums');
    const data = payloads[0];
    for (const e of data?.[0] ?? []) {
      const a = parseAlbumEntry(e);
      if (a) albums.set(a.albumKey, { ...a, ownedByMe: me && a.ownerId ? a.ownerId === me : null });
    }
    const next = typeof data?.[1] === 'string' ? data[1] : null;
    if (!next || next === token) break;
    token = next;
  }
  return { account, albums: [...albums.values()] };
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toDedupKey = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function filenameFromDisposition(cd) {
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

/**
 * Download the original file of an item (=d photo, =dv video).
 * Returns the blob plus its SHA-1 in hex and in Google's dedupKey encoding, so the
 * caller can verify the bytes are the original.
 * @param {{onProgress?: (p: {filename: string, received: number, total: number|null}) => void}} opts
 */
export async function downloadOriginal(item, { onProgress } = {}) {
  const res = await fetch(`${item.thumbUrl}=${item.isVideo ? 'dv' : 'd'}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('text/')) throw new Error(`Download returned ${type}, not media`);
  const ext = (type.split('/')[1] || 'bin').replace('jpeg', 'jpg').split(';')[0];
  const filename = filenameFromDisposition(res.headers.get('content-disposition') || '') || `${item.mediaKey}.${ext}`;
  const total = Number(res.headers.get('content-length')) || null;

  let buf;
  if (onProgress && res.body) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    onProgress({ filename, received, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress({ filename, received, total });
    }
    buf = await new Blob(chunks).arrayBuffer();
  } else {
    buf = await res.arrayBuffer();
  }
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return {
    blob: new Blob([buf], { type }),
    filename,
    sha1Hex: hex(digest),
    sha1Key: toDedupKey(digest),
    size: buf.byteLength,
  };
}
