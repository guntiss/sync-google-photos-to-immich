import { listAlbum } from './gphotos.js';
import { normalizeBaseUrl } from './immich.js';
import { loadConfig, syncAlbum } from './sync.js';

const $ = (id) => document.getElementById(id);
const albumsEl = $('albums');
const statusEl = $('status');
const resultsEl = $('results');
const buttons = ['save', 'list', 'check', 'sync'].map($);

const urls = () => albumsEl.value.split('\n').map((s) => s.trim()).filter(Boolean);

function readSettings() {
  return {
    immichUrl: $('immichUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    intervalMinutes: Number($('interval').value) || 0,
    addExisting: $('addExisting').checked,
  };
}

async function save() {
  const settings = readSettings();
  if (settings.immichUrl) {
    // Immich sends no CORS headers, so the extension needs host access to it.
    // Must run early in the click handler to keep the user-gesture.
    const origins = [`${new URL(settings.immichUrl).origin}/*`];
    if (!(await chrome.permissions.contains({ origins }))) {
      if (!(await chrome.permissions.request({ origins }))) {
        statusEl.textContent = `Permission for ${origins[0]} was denied.`;
        return false;
      }
    }
    settings.immichUrl = normalizeBaseUrl(settings.immichUrl);
    $('immichUrl').value = settings.immichUrl;
  }
  await chrome.storage.local.set({ settings, albums: urls() });
  statusEl.textContent = 'Saved.';
  return true;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Google's image host sends Cross-Origin-Resource-Policy: same-site, so a plain
// <img> is blocked on an extension page. A fetch with host permission is not.
const thumbQueue = [];
let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < 6 && thumbQueue.length) {
    const { img, url } = thumbQueue.shift();
    thumbActive++;
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => (img.src = URL.createObjectURL(b)))
      .catch((e) => (img.alt = `thumb failed: ${e.message}`))
      .finally(() => {
        thumbActive--;
        pumpThumbs();
      });
  }
}
function thumb(it) {
  const img = el('img');
  thumbQueue.push({ img, url: `${it.thumbUrl}=w280-h280-c` });
  pumpThumbs();
  return img;
}

const STATE_LABEL = {
  'in-immich': '✓ in Immich',
  missing: '● missing',
  uploaded: '⬆ uploaded',
  trashed: '🗑 in Immich trash',
  error: '⚠ error',
};

function renderAlbum(box, result, status, summary) {
  const { title, items, pages, albumKey, url } = result;
  const videos = items.filter((i) => i.isVideo).length;
  box.replaceChildren(
    el('h2', {}, title || '(untitled album)'),
    el('div', { className: 'meta' }, `${items.length} items (${videos} videos), ${pages} page(s) — ${url}`),
    summary ? el('div', { className: 'meta summary' }, JSON.stringify(summary)) : '',
    el('div', { className: 'row' },
      el('button', { onclick: () => download(`album-${albumKey}.json`, items) }, 'Download list (JSON)'),
      el('button', {
        onclick: async (e) => {
          e.target.disabled = true;
          const raw = await listAlbum(url, { debug: true });
          download(`album-${albumKey}-raw.json`, raw.debug);
          e.target.disabled = false;
        },
      }, 'Download raw (debug)'),
    ),
    el('div', { className: 'grid' },
      ...items.map((it) => {
        const st = status?.[it.mediaKey];
        return el('div', { className: `item ${st?.state ?? ''}`, title: st?.message ?? it.mediaKey },
          thumb(it),
          el('div', {},
            new Date(it.takenMs).toLocaleString(),
            ` · ${it.width}×${it.height}`,
            it.isVideo ? el('span', { className: 'badge' }, ' ▶ video') : '',
            st ? el('div', { className: `st ${st.state}` }, STATE_LABEL[st.state] ?? st.state) : '',
          ),
        );
      }),
    ),
  );
}

async function run(mode) {
  if (!(await save())) return;
  buttons.forEach((b) => (b.disabled = true));
  resultsEl.replaceChildren();
  const settings = readSettings();
  for (const url of urls()) {
    const log = el('pre', { className: 'log' });
    const box = el('div', { className: 'album' }, el('div', { className: 'meta' }, `Loading ${url} …`), log);
    resultsEl.append(box);
    const addLog = (m) => {
      log.append(m + '\n');
      log.scrollTop = log.scrollHeight;
      console.log('[sync]', m);
    };
    try {
      if (mode === 'list') {
        const result = await listAlbum(url, {
          onProgress: (n) => (box.firstChild.textContent = `Loading ${url} … ${n} items`),
        });
        renderAlbum(box, result);
      } else {
        const r = await syncAlbum(url, settings, { dryRun: mode === 'check', log: addLog });
        renderAlbum(box, r.album, r.status, r.summary);
        box.append(log);
      }
    } catch (err) {
      box.replaceChildren(
        el('div', { className: 'meta' }, url),
        el('div', { className: 'error' }, err.message),
        err.debug ? el('div', { className: 'row' }, el('button', { onclick: () => download('album-raw-html.json', err.debug) }, 'Download raw (debug)')) : '',
      );
      console.error(url, err);
    }
  }
  statusEl.textContent = 'Done.';
  buttons.forEach((b) => (b.disabled = false));
}

$('save').onclick = save;
$('list').onclick = () => run('list');
$('check').onclick = () => run('check');
$('sync').onclick = () => run('sync');

const { settings, albums } = await loadConfig();
$('immichUrl').value = settings.immichUrl;
$('apiKey').value = settings.apiKey;
$('interval').value = settings.intervalMinutes;
$('addExisting').checked = settings.addExisting;
albumsEl.value = albums.join('\n');

const { lastRun } = await chrome.storage.local.get('lastRun');
if (lastRun) {
  $('lastRun').textContent =
    `Last background sync: ${new Date(lastRun.at).toLocaleString()} — ` +
    lastRun.results
      .map((r) => (r.error ? `error: ${r.error}` : `${r.summary.title}: ${r.summary.uploaded} uploaded, ${r.summary.missing} missing`))
      .join('; ');
}
