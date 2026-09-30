import { listAlbum, listAlbums, parseAlbumUrl } from './gphotos.js';
import { Immich, normalizeBaseUrl } from './immich.js';
import { ALARM, BusyError, loadConfig, runSync } from './sync.js';
import {
  getLock, getStates, getStopRequest, isLockActive, LOCK_KEY, percentDone, removeState, requestStop, RUNNING_PHASES,
  stateKey, STOP_KEY, urlFromKey,
} from './state.js';

const $ = (id) => document.getElementById(id);

let config = { settings: {}, albums: [] };
let states = {}; // album url -> shared state (see state.js / sync.js)
let lock = null;
let stopFor = null; // lock.since of the run a stop was requested for
let lastRun = null;
let alarm = null;
let localRun = false;
const cards = new Map(); // album url -> DOM refs
const results = new Map(); // album url -> {album, status} from runs made in this page

// ---------- formatting

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  return `${(n / 1000 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Average speed of a transfer meter ({bytes, ms, since}), counting a stretch still in progress.
function fmtSpeed(m) {
  const ms = (m?.ms ?? 0) + (m?.since ? Date.now() - m.since : 0);
  return m?.bytes && ms >= 500 ? `${fmtBytes(m.bytes / (ms / 1000))}/s` : '—';
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const num = (n) => (n ?? 0).toLocaleString();
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- running

const configured = () => Boolean(config.settings.immichUrl && config.settings.apiKey);
const busy = () => localRun || isLockActive(lock);
const stopping = () => Boolean(lock && stopFor === lock.since);

function showBanner(msg, kind = 'err') {
  const b = $('banner');
  b.hidden = !msg;
  b.className = `banner ${kind}`;
  b.textContent = msg ?? '';
}

async function start({ urls, dryRun }) {
  if (busy()) return;
  showBanner(null);
  localRun = true;
  refreshAll();
  try {
    await runSync({
      urls,
      dryRun,
      onAlbum: (url, r) => {
        results.set(url, r);
        const c = cards.get(url);
        if (!c) return;
        const todo = Object.values(r.status).some((x) => x.state === 'missing' || x.state === 'error');
        c.filter.value = todo ? 'todo' : 'all';
        if (c.photos.open) renderGrid(url);
      },
    });
  } catch (err) {
    showBanner(err instanceof BusyError ? 'Another sync is already running. Wait for it to finish.' : err.message);
  } finally {
    localRun = false;
    refreshAll();
  }
}

// Stops the running sync, whether this page or the background worker runs it.
function stop() {
  if (!isLockActive(lock) || stopping()) return;
  stopFor = lock.since;
  requestStop(lock);
  refreshAll();
}

// ---------- album cards

function createCard(url) {
  const node = $('cardTpl').content.firstElementChild.cloneNode(true);
  const q = (s) => node.querySelector(s);
  const c = {
    node,
    title: q('.title'), meta: q('.meta'), src: q('.src'),
    bar: q('.bar'), fill: q('.bar span'), pct: q('.pct'),
    status: q('.status'), stats: q('.stats'),
    photos: q('.photos'), filter: q('.filter'), grid: q('.grid'), note: q('.photos-note'),
    log: q('.log'),
    buttons: [...node.querySelectorAll('[data-action=check], [data-action=sync]')],
    stop: q('[data-action=stop]'),
  };
  c.src.href = url;
  c.src.textContent = url.replace(/^https:\/\//, '');
  q('[data-action=check]').onclick = () => start({ urls: [url], dryRun: true });
  q('[data-action=sync]').onclick = () => start({ urls: [url], dryRun: false });
  c.stop.onclick = stop;
  q('[data-action=remove]').onclick = () => removeAlbum(url);
  q('[data-action=export]').onclick = () => exportList(url);
  q('[data-action=raw]').onclick = () => exportRaw(url);
  c.photos.addEventListener('toggle', () => c.photos.open && openPhotos(url));
  c.filter.onchange = () => renderGrid(url);
  cards.set(url, c);
  return c;
}

function describe(s, running, interrupted) {
  if (!s?.phase) return { text: 'Not checked yet. Click Check to compare it with Immich.' };
  if (interrupted) {
    const where = s.phase === 'uploading' ? ` after ${s.run.done} of ${s.run.toUpload}` : '';
    return { text: `Interrupted${where}. Run Sync again to continue.`, tone: 'warn' };
  }
  if (running) {
    const r = s.run ?? {};
    switch (s.phase) {
      case 'listing':
        return { text: `Reading the album from Google Photos… ${s.listed ? plural(s.listed, 'item') : ''}` };
      case 'checking':
        return { text: `Comparing ${plural(s.total, 'item')} with Immich…` };
      case 'album':
        return { text: 'Updating the Immich album…' };
      case 'uploading': {
        const active = r.active ?? [];
        const transfers = active.map((cur) => {
          const name = cur.name ?? (cur.isVideo ? 'Video' : 'Photo');
          const step =
            cur.step === 'uploading'
              ? `uploading ${fmtBytes(cur.size)} to Immich…`
              : `downloading ${fmtBytes(cur.received)}${cur.size ? ` of ${fmtBytes(cur.size)}` : ''}`;
          return `${name} · ${step}`;
        });
        let sub = '';
        if (r.done > 0 && r.uploadStartedAt) {
          const elapsed = Date.now() - r.uploadStartedAt;
          const rate = r.uploadedBytes / (elapsed / 1000);
          const left = (elapsed / r.done) * (r.toUpload - r.done);
          sub = `${fmtBytes(rate)}/s · about ${fmtDuration(left)} left`;
        }
        const from = Math.min(r.done + 1, r.toUpload);
        const to = Math.min(r.done + active.length, r.toUpload);
        const range = to > from ? `${num(from)}–${num(to)}` : num(from);
        return { text: `Copying ${range} of ${num(r.toUpload)}`, sub, transfers };
      }
    }
  }
  if (s.phase === 'error') return { text: s.message, tone: 'err' };
  if (s.phase === 'stopped') {
    if (s.mode === 'check') return { text: 'Check stopped. Click Check to run it again.', tone: 'warn' };
    const copied = s.run?.uploadedFiles ? ` after copying ${plural(s.run.uploadedFiles, 'item')}` : '';
    return { text: `Sync stopped${copied}. Click Sync to continue where it stopped.`, tone: 'warn' };
  }
  if (s.failed) return { text: `${plural(s.failed, 'item')} could not be copied. See the activity log.`, tone: 'err' };
  if (s.missing) {
    return { text: `${plural(s.missing, 'item')} not in Immich yet. Click Sync to copy them.`, tone: 'warn' };
  }
  const r = s.run ?? {};
  if (s.mode === 'sync' && r.uploadedFiles) {
    return {
      text: `Up to date. Copied ${plural(r.uploadedFiles, 'item')} (${fmtBytes(r.uploadedBytes)}) in ${fmtDuration(r.finishedAt - r.startedAt)}.`,
      tone: 'ok',
    };
  }
  return { text: 'Up to date. Everything is in Immich.', tone: 'ok' };
}

function updateCard(url) {
  const c = cards.get(url);
  if (!c) return;
  const s = states[url];
  const lockOn = isLockActive(lock);
  const inRunPhase = Boolean(s && RUNNING_PHASES.has(s.phase));
  const running = inRunPhase && lockOn && (s.run?.startedAt ?? 0) >= (lock.since ?? 0);
  const interrupted = inRunPhase && !running && !localRun;
  const pct = percentDone(s);

  c.title.textContent = s?.title || 'New album';
  c.meta.textContent = s?.total
    ? `${plural(s.total, 'item')}${s.videos ? ` (${num(s.videos)} videos)` : ''} → Immich album “${s.immichAlbum ?? s.title}”`
    : '';

  const indeterminate = running && (s.phase === 'listing' || s.phase === 'checking');
  c.bar.classList.toggle('indeterminate', indeterminate);
  c.fill.style.width = `${pct ?? 0}%`;
  c.pct.textContent = indeterminate || pct === null ? '—' : `${pct}%`;
  c.node.classList.toggle('running', running);
  c.node.classList.toggle('complete', !running && pct === 100);
  c.node.classList.toggle('has-errors', !running && Boolean(s?.failed));

  const d = running && stopping() ? { text: 'Stopping…' } : describe(s, running, interrupted);
  c.status.className = `status ${d.tone ?? ''}`;
  c.status.replaceChildren(
    d.text ?? '',
    d.sub ? el('span', { className: 'sub' }, d.sub) : '',
    ...(d.transfers ?? []).map((t) => el('span', { className: 'transfer' }, t)),
  );

  const r = s?.run;
  const last = s?.lastSync;
  const stat = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  const showRun = running && s.phase === 'uploading';
  c.stats.replaceChildren(
    ...(s?.total
      ? [
          stat('In Immich', `${num(s.total - s.missing - s.failed)} of ${num(s.total)}`),
          stat('To copy', num(s.missing)),
          stat('Failed', num(s.failed)),
          showRun
            ? stat('Copied this run', `${plural(r.uploadedFiles, 'file')} · ${fmtBytes(r.uploadedBytes)}`)
            : stat('Last sync copied', last ? `${plural(last.files, 'file')} · ${fmtBytes(last.bytes)}` : '—'),
          stat('Avg download', fmtSpeed(showRun ? r.download : last?.download)),
          stat('Avg upload', fmtSpeed(showRun ? r.upload : last?.upload)),
          stat('Copied all time', `${plural(s.totals.uploadedFiles, 'file')} · ${fmtBytes(s.totals.uploadedBytes)}`),
          stat('Last synced', s.lastSyncAt ? ago(s.lastSyncAt) : s.lastCheckAt ? `never (checked ${ago(s.lastCheckAt)})` : 'never'),
        ]
      : []),
  );

  const atBottom = c.log.scrollTop + c.log.clientHeight >= c.log.scrollHeight - 4;
  c.log.textContent = s?.log?.length ? s.log.join('\n') : 'Nothing yet.';
  if (atBottom) c.log.scrollTop = c.log.scrollHeight;

  const disabled = busy() || !configured();
  c.buttons.forEach((b) => {
    b.disabled = disabled;
    b.hidden = running;
  });
  showStop(c.stop, running);
}

// Stop replaces the start buttons while a run is going, and says so once it's asked.
function showStop(button, show) {
  button.hidden = !show;
  button.disabled = stopping();
  button.textContent = stopping() ? 'Stopping…' : 'Stop';
}

function renderAlbums() {
  const main = $('albums');
  for (const url of cards.keys()) if (!config.albums.includes(url)) cards.delete(url);
  if (!config.albums.length) {
    main.replaceChildren(
      el('div', { className: 'empty' },
        el('p', {}, 'No albums yet. Pick the Google Photos albums you want in Immich.'),
        el('button', { className: 'primary', type: 'button', onclick: openPicker }, '+ Add albums'),
      ),
    );
    return;
  }
  main.replaceChildren(...config.albums.map((url) => (cards.get(url) ?? createCard(url)).node));
  config.albums.forEach(updateCard);
}

// ---------- photo grid

// Google's image host sends Cross-Origin-Resource-Policy: same-site, so a plain
// <img> is blocked on an extension page. A fetch with host permission is not.
const thumbQueue = [];
let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < 6 && thumbQueue.length) {
    const img = thumbQueue.shift();
    thumbActive++;
    fetch(img.dataset.src, { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => {
        img.onload = () => URL.revokeObjectURL(img.src);
        img.src = URL.createObjectURL(b);
      })
      .catch((e) => (img.alt = `thumbnail failed: ${e.message}`))
      .finally(() => {
        thumbActive--;
        pumpThumbs();
      });
  }
}
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      thumbQueue.push(e.target);
    }
    pumpThumbs();
  },
  { rootMargin: '400px' },
);

const STATE_LABEL = {
  'in-immich': '✓ In Immich',
  missing: '● Not in Immich',
  uploaded: '⬆ Copied',
  trashed: 'In Immich trash',
  error: '⚠ Failed',
};

async function openPhotos(url) {
  const c = cards.get(url);
  if (results.has(url)) return renderGrid(url);
  c.grid.replaceChildren();
  if (busy()) {
    c.note.textContent = 'Available when the current sync finishes.';
    return;
  }
  c.note.textContent = 'Checking the album…';
  await start({ urls: [url], dryRun: true });
  if (!results.has(url)) c.note.textContent = 'Could not load the album. See the status above.';
}

function renderGrid(url) {
  const c = cards.get(url);
  const { album, status } = results.get(url);
  const todo = (it) => ['missing', 'error'].includes(status[it.mediaKey]?.state);
  const items = c.filter.value === 'todo' ? album.items.filter(todo) : album.items;
  c.note.textContent =
    c.filter.value === 'todo' && !items.length ? 'Everything is in Immich.' : `${plural(items.length, 'item')}, newest first`;
  c.grid.replaceChildren(
    ...items.map((it) => {
      const st = status[it.mediaKey];
      const img = el('img', { alt: '' });
      img.dataset.src = `${it.thumbUrl}=w260-h260-c`;
      thumbObserver.observe(img);
      return el('div', { className: `item ${st?.state ?? ''}`, title: st?.message ?? '' },
        img,
        el('div', { className: 'cap' },
          new Date(it.takenMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
          it.isVideo ? ' · ▶ video' : '',
          st ? el('div', { className: `st ${st.state}` }, STATE_LABEL[st.state] ?? st.state) : null,
        ),
      );
    }),
  );
}

async function exportList(url) {
  try {
    const album = results.get(url)?.album ?? (await listAlbum(url));
    download(`album-${album.albumKey}.json`, album.items);
  } catch (err) {
    showBanner(err.message);
  }
}

async function exportRaw(url) {
  try {
    const raw = await listAlbum(url, { debug: true });
    download(`album-${raw.albumKey}-raw.json`, raw.debug);
  } catch (err) {
    if (err.debug) download('album-raw.json', err.debug);
    else showBanner(err.message);
  }
}

// ---------- add / remove albums

function isAlbumLink(raw) {
  try {
    const u = new URL(raw);
    return (u.hostname === 'photos.google.com' && u.pathname.startsWith('/share/')) || u.hostname === 'photos.app.goo.gl';
  } catch {
    return false;
  }
}

function shareIdOf(url) {
  try {
    return parseAlbumUrl(url).shareId;
  } catch {
    return null;
  }
}

// Links and Google album keys of the albums already in the list, so an album is
// recognised whichever link it was added with.
function addedKeys() {
  const keys = new Set(config.albums);
  for (const url of config.albums) {
    const key = states[url]?.albumKey ?? shareIdOf(url);
    if (key) keys.add(key);
  }
  return keys;
}

// entries: [{url, title?, albumKey?}]
async function addAlbums(entries) {
  const urls = entries.map((e) => e.url);
  const seeds = {};
  for (const { url, title, albumKey } of entries) {
    if (!title) continue;
    states[url] = { title, albumKey }; // so the card is named before the first check
    seeds[stateKey(url)] = states[url];
  }
  config.albums = [...config.albums, ...urls];
  await chrome.storage.local.set({ albums: config.albums, ...seeds });
  renderAlbums();
  renderOverview();
  if (configured()) start({ urls, dryRun: true });
}

// The picker lists the account's shared albums (Google Photos' own album list), so
// nobody has to copy links. Rows are built once per load; search only hides them.
const picker = { loading: false, error: null, account: null, albums: null, groups: [], selected: new Set() };

const monthYear = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', year: 'numeric' });

function pickerRow(album) {
  const box = el('input', { type: 'checkbox' });
  const img = el('img', { alt: '' });
  if (album.coverUrl) {
    img.dataset.src = `${album.coverUrl}=w96-h96-c`;
    thumbObserver.observe(img);
  }
  const from = album.firstMs && monthYear(album.firstMs);
  const to = album.lastMs && monthYear(album.lastMs);
  const meta = [
    album.count === null ? null : plural(album.count, 'item'),
    from && (!to || to === from ? from : `${from} – ${to}`),
  ].filter(Boolean).join(' · ');
  const node = el('label', { className: 'pick' },
    box,
    img,
    el('span', { className: 'pick-text' },
      el('span', { className: 'pick-title' }, album.title || 'Untitled'),
      el('span', { className: 'pick-meta' }, meta),
    ),
    el('span', { className: 'tag' }, '✓ Added'),
  );
  box.onchange = () => {
    if (box.checked) picker.selected.add(album.url);
    else picker.selected.delete(album.url);
    renderPicker();
  };
  return { node, box, album };
}

const PICKER_GROUPS = [
  [false, 'Shared with you'],
  [true, 'Shared by you'],
  [null, 'Shared albums'], // owner unknown
];

function buildPicker() {
  const shared = picker.albums.filter((a) => a.url);
  picker.selected = new Set(shared.map((a) => a.url).filter((u) => picker.selected.has(u)));
  picker.groups = PICKER_GROUPS.flatMap(([owned, name]) => {
    const rows = shared.filter((a) => a.ownedByMe === owned).map(pickerRow);
    if (!rows.length) return [];
    const toggle = el('button', { type: 'button', className: 'link' });
    toggle.onclick = () => {
      const open = rows.filter((r) => !r.node.hidden && !r.box.disabled);
      const select = open.some((r) => !r.box.checked);
      open.forEach((r) => (select ? picker.selected.add(r.album.url) : picker.selected.delete(r.album.url)));
      renderPicker();
    };
    const node = el('section', { className: 'pick-group' },
      el('div', { className: 'pick-head' }, el('h3', {}, name), toggle),
      ...rows.map((r) => r.node),
    );
    return [{ node, toggle, rows }];
  });
  $('pickerList').replaceChildren(...picker.groups.map((g) => g.node));
}

async function loadPicker() {
  picker.loading = true;
  picker.error = null;
  renderPicker();
  try {
    ({ account: picker.account, albums: picker.albums } = await listAlbums());
    buildPicker();
  } catch (err) {
    picker.error = `Could not read your albums from Google Photos: ${err.message}`;
  } finally {
    picker.loading = false;
    renderPicker();
  }
}

function renderPicker() {
  const { loading, error, albums, groups } = picker;
  const added = addedKeys();
  const query = $('pickerSearch').value.trim();
  const q = query.toLocaleLowerCase();
  let shown = 0;
  for (const g of groups) {
    for (const r of g.rows) {
      const isAdded = added.has(r.album.url) || added.has(r.album.albumKey);
      if (isAdded) picker.selected.delete(r.album.url);
      r.node.classList.toggle('added', isAdded);
      r.box.disabled = isAdded;
      r.box.checked = isAdded || picker.selected.has(r.album.url);
      r.node.hidden = Boolean(q) && !r.album.title.toLocaleLowerCase().includes(q);
    }
    const visible = g.rows.filter((r) => !r.node.hidden);
    const open = visible.filter((r) => !r.box.disabled);
    g.node.hidden = !visible.length;
    g.toggle.hidden = !open.length;
    g.toggle.textContent = open.length && open.every((r) => r.box.checked) ? 'Select none' : 'Select all';
    shown += visible.length;
  }

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const msg = loading
    ? 'Looking for albums in Google Photos…'
    : error
      ? error
      : !albums
        ? null
        : !total
          ? 'No shared albums in this Google account yet.'
          : !shown
            ? `No albums match “${query}”.`
            : null;
  $('pickerMsg').hidden = !msg;
  $('pickerMsg').textContent = msg ?? '';
  $('pickerMsg').classList.toggle('err', Boolean(error) && !loading);
  $('pickerList').hidden = loading || Boolean(error);
  $('pickerSearch').hidden = loading || !total;
  const account = picker.account ? `${picker.account}, the Google account` : 'the Google account';
  $('pickerAccount').textContent = `Shared albums in ${account} signed in to Chrome. Pick the ones to copy to Immich.`;
  const unshared = loading || error ? 0 : (albums?.filter((a) => !a.url).length ?? 0);
  $('pickerNote').hidden = !unshared;
  $('pickerNote').textContent =
    `${plural(unshared, 'album')} of yours ${unshared === 1 ? "isn't" : "aren't"} listed because only shared albums ` +
    'can be synced. To sync one, share it in Google Photos first.';
  $('refreshPicker').disabled = loading;

  const n = picker.selected.size;
  $('addPicked').disabled = !n;
  $('addPicked').textContent = n ? `Add ${plural(n, 'album')}` : 'Add';
}

function openPicker() {
  $('addError').hidden = true;
  if (!$('picker').open) $('picker').showModal();
  if (!picker.albums && !picker.loading) loadPicker();
  else renderPicker();
}

$('openPicker').onclick = openPicker;
$('refreshPicker').onclick = loadPicker;
$('cancelPicker').onclick = () => $('picker').close();
$('pickerSearch').oninput = renderPicker;

$('addPicked').onclick = async () => {
  const entries = picker.groups.flatMap((g) => g.rows).filter((r) => picker.selected.has(r.album.url)).map((r) => r.album);
  picker.selected.clear();
  $('picker').close();
  await addAlbums(entries);
};

$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const raw = $('addUrl').value.trim();
  const err = $('addError');
  err.hidden = true;
  if (!isAlbumLink(raw)) {
    err.textContent = "That isn't a shared album link. In Google Photos open the album, click Share, then Copy link.";
    err.hidden = false;
    return;
  }
  const added = addedKeys();
  if (added.has(raw) || added.has(shareIdOf(raw))) {
    err.textContent = 'That album is already in the list.';
    err.hidden = false;
    return;
  }
  $('addUrl').value = '';
  $('picker').close();
  await addAlbums([{ url: raw }]);
};

async function removeAlbum(url) {
  const title = states[url]?.title ?? 'this album';
  if (!confirm(`Stop syncing “${title}”?\n\nNothing is deleted. Photos already copied stay in Immich.`)) return;
  config.albums = config.albums.filter((u) => u !== url);
  delete states[url];
  results.delete(url);
  await chrome.storage.local.set({ albums: config.albums });
  await removeState(url);
  renderAlbums();
  renderOverview();
}

// ---------- overview, connection, schedule

function renderOverview() {
  const known = config.albums.map((u) => states[u]).filter((s) => s?.total);
  const total = known.reduce((a, s) => a + s.total, 0);
  const done = known.reduce((a, s) => a + s.total - s.missing - s.failed, 0);
  const files = known.reduce((a, s) => a + s.totals.uploadedFiles, 0);
  const bytes = known.reduce((a, s) => a + s.totals.uploadedBytes, 0);
  const tile = (v, k) => el('div', { className: 'tile' }, el('div', { className: 'v' }, v), el('div', { className: 'k' }, k));
  $('tiles').replaceChildren(
    tile(num(config.albums.length), config.albums.length === 1 ? 'album' : 'albums'),
    tile(num(total), 'items in Google Photos'),
    tile(total ? `${Math.floor((100 * done) / total)}%` : '—', `in Immich (${num(done)})`),
    tile(fmtBytes(bytes), `copied so far (${plural(files, 'file')})`),
  );

  const off = busy() || !configured() || !config.albums.length;
  const running = isLockActive(lock);
  for (const id of ['syncAll', 'checkAll']) {
    $(id).disabled = off;
    $(id).hidden = running;
  }
  showStop($('stopSync'), running);

  const minutes = Number(config.settings.intervalMinutes);
  const parts = [];
  if (running) {
    const what = lock.mode === 'check' ? 'Check' : 'Sync';
    if (stopping()) parts.push(`Stopping the ${what.toLowerCase()}…`);
    else parts.push(lock.trigger === 'schedule' ? `Automatic ${what.toLowerCase()} running…` : `${what} running…`);
  }
  else if (minutes > 0) {
    const every = $('interval').querySelector(`option[value="${minutes}"]`)?.textContent.toLowerCase() ?? `every ${minutes} minutes`;
    parts.push(`Auto-sync ${every}${alarm ? `, next at ${clock(alarm.scheduledTime)}` : ''}`);
  } else parts.push('Auto-sync off');
  if (lastRun) {
    const what = `${lastRun.trigger === 'schedule' ? 'automatic' : 'manual'} ${lastRun.dryRun ? 'check' : 'sync'}`;
    const bad = lastRun.error || lastRun.results?.some((r) => r.error || r.failed);
    parts.push(`last ${what} ${ago(lastRun.at)}${bad ? ' (with errors)' : lastRun.stopped ? ' (stopped)' : ''}`);
  }
  $('schedule').textContent = parts.join(' · ');
}

async function updateConnection() {
  const pill = $('conn');
  pill.className = 'pill';
  if (!configured()) {
    pill.textContent = 'Immich not connected';
    showBanner('Connect your Immich server to get started: open Settings.', 'info');
    return;
  }
  const { immichUrl, apiKey } = config.settings;
  const host = new URL(immichUrl).host;
  if (!(await chrome.permissions.contains({ origins: [`${new URL(immichUrl).origin}/*`] }))) {
    pill.classList.add('err');
    pill.textContent = `${host}: access not granted`;
    return;
  }
  pill.textContent = `${host}…`;
  try {
    const immich = new Immich(immichUrl, apiKey);
    const [me, about] = await Promise.all([immich.me(), immich.about().catch(() => null)]);
    pill.classList.add('ok');
    pill.textContent = `${host} · ${me.name}${about?.version ? ` · Immich ${about.version}` : ''}`;
    pill.title = 'Connected. Click to change.';
  } catch (err) {
    pill.classList.add('err');
    pill.textContent = `${host}: can't connect`;
    pill.title = err.message;
  }
}

async function refreshAlarm() {
  alarm = (await chrome.alarms.get(ALARM)) ?? null;
}

function refreshAll() {
  config.albums.forEach(updateCard);
  renderOverview();
}

// ---------- settings dialog

function openSettings() {
  const s = config.settings;
  $('immichUrl').value = s.immichUrl;
  $('apiKey').value = s.apiKey;
  const sel = $('interval');
  const v = String(s.intervalMinutes ?? 0);
  if (![...sel.options].some((o) => o.value === v)) sel.append(el('option', { value: v, textContent: `Every ${v} minutes` }));
  sel.value = v;
  $('addExisting').checked = s.addExisting;
  $('connResult').hidden = true;
  $('settings').showModal();
}

function connResult(text, tone) {
  const p = $('connResult');
  p.hidden = false;
  p.className = tone ?? 'muted';
  p.textContent = text;
}

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const next = {
    immichUrl: $('immichUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    intervalMinutes: Number($('interval').value) || 0,
    addExisting: $('addExisting').checked,
  };
  let origin;
  try {
    origin = new URL(next.immichUrl).origin;
  } catch {
    return connResult('That server URL is not valid.', 'err');
  }
  // Immich sends no CORS headers, so the extension needs host access to it. This must
  // be the first await so it still counts as part of the click.
  if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    return connResult(`Chrome did not grant access to ${origin}.`, 'err');
  }
  next.immichUrl = normalizeBaseUrl(next.immichUrl);
  connResult('Testing connection…');
  try {
    const me = await new Immich(next.immichUrl, next.apiKey).me();
    connResult(`Connected as ${me.name}.`, 'ok');
  } catch (err) {
    return connResult(`Could not connect: ${err.message}`, 'err');
  }
  config.settings = next;
  await chrome.storage.local.set({ settings: next });
  $('settings').close();
  showBanner(null);
  updateConnection();
  setTimeout(() => refreshAlarm().then(renderOverview), 500); // background re-schedules on save
  refreshAll();
  if (!config.albums.length) openPicker();
};

$('cancelSettings').onclick = () => $('settings').close();
$('openSettings').onclick = openSettings;
$('conn').onclick = openSettings;
$('syncAll').onclick = () => start({ dryRun: false });
$('checkAll').onclick = () => start({ dryRun: true });
$('stopSync').onclick = stop;

// ---------- live updates

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (LOCK_KEY in changes) lock = changes[LOCK_KEY].newValue ?? null;
    if (STOP_KEY in changes) stopFor = changes[STOP_KEY].newValue ?? null;
    refreshAll();
    return;
  }
  if (area !== 'local') return;
  for (const [key, ch] of Object.entries(changes)) {
    const url = urlFromKey(key);
    if (url && cards.has(url)) {
      states[url] = ch.newValue ?? null;
      updateCard(url);
    }
  }
  if (changes.lastRun) lastRun = changes.lastRun.newValue ?? null;
  if (changes.albums) {
    config.albums = changes.albums.newValue ?? [];
    getStates(config.albums).then((s) => {
      states = s;
      renderAlbums();
      renderOverview();
      if ($('picker').open) renderPicker();
    });
  }
  renderOverview();
});

// Relative times, ETA and stale-lock detection.
setInterval(() => refreshAlarm().then(refreshAll), 15_000);

// ---------- init

config = await loadConfig();
[states, lock, stopFor, { lastRun = null }] = await Promise.all([
  getStates(config.albums),
  getLock(),
  getStopRequest(),
  chrome.storage.local.get('lastRun'),
  refreshAlarm(),
]);
renderAlbums();
renderOverview();
updateConnection();
if (!configured()) openSettings();
