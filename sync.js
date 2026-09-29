// Orchestrates: list Google album -> dedupe against Immich by SHA-1 -> upload missing
// -> mirror into an Immich album named after the Google album.
import { listAlbum, downloadOriginal } from './gphotos.js';
import { Immich, dedupKeyToChecksum } from './immich.js';

export const DEFAULT_SETTINGS = { immichUrl: '', apiKey: '', intervalMinutes: 60, addExisting: true };

export async function loadConfig() {
  const { settings = {}, albums = [] } = await chrome.storage.local.get(['settings', 'albums']);
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, albums };
}

// mediaKey -> Immich asset id, for everything this extension uploaded. Stops a photo
// from being re-uploaded when its Immich checksum differs from Google's dedupKey.
async function loadLedger() {
  return (await chrome.storage.local.get('ledger')).ledger ?? {};
}

/**
 * @param {string} albumUrl
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {{dryRun?: boolean, limit?: number, log?: (msg: string) => void}} opts
 * @returns {{album, status: Record<string, {state: string, assetId?: string, message?: string}>, summary}}
 *   state: 'in-immich' | 'trashed' | 'missing' | 'uploaded' | 'error'
 */
export async function syncAlbum(albumUrl, settings, { dryRun = false, limit = Infinity, log = () => {} } = {}) {
  if (!settings.immichUrl || !settings.apiKey) throw new Error('Set the Immich URL and API key first.');
  const immich = new Immich(settings.immichUrl, settings.apiKey);
  await immich.me(); // fail fast on a bad URL / key

  const album = await listAlbum(albumUrl);
  log(`Google album "${album.title}": ${album.items.length} items`);

  const ledger = await loadLedger();
  const status = {};
  const toCheck = [];
  for (const it of album.items) {
    if (ledger[it.mediaKey]) status[it.mediaKey] = { state: 'in-immich', assetId: ledger[it.mediaKey] };
    else if (!it.dedupKey) status[it.mediaKey] = { state: 'error', message: 'no checksum in Google data' };
    else toCheck.push(it);
  }

  const checks = await immich.bulkCheck(
    toCheck.map((it) => ({ id: it.mediaKey, checksum: dedupKeyToChecksum(it.dedupKey) })),
  );
  const missing = [];
  for (const it of toCheck) {
    const c = checks.get(it.mediaKey);
    if (c?.action === 'accept') {
      status[it.mediaKey] = { state: 'missing' };
      missing.push(it);
    } else if (c?.reason === 'duplicate') {
      status[it.mediaKey] = { state: c.isTrashed ? 'trashed' : 'in-immich', assetId: c.assetId };
    } else {
      status[it.mediaKey] = { state: 'error', message: `Immich rejected: ${c?.reason ?? 'no result'}` };
    }
  }
  log(`${album.items.length - missing.length} already in Immich, ${missing.length} missing`);

  // Upload missing photos, oldest first (so an interrupted run leaves no gaps in the past).
  missing.sort((a, b) => a.takenMs - b.takenMs);
  let uploaded = 0;
  for (const it of missing.slice(0, limit)) {
    if (dryRun) break;
    try {
      const file = await downloadOriginal(it);
      if (file.sha1Key !== it.dedupKey) log(`warn: ${file.filename} bytes differ from Google's checksum (not the original?)`);
      const res = await immich.upload({
        blob: file.blob,
        filename: file.filename,
        createdAt: new Date(it.takenMs),
        modifiedAt: new Date(it.takenMs),
        sha1Hex: file.sha1Hex,
      });
      status[it.mediaKey] = { state: res.status === 'created' ? 'uploaded' : 'in-immich', assetId: res.id };
      ledger[it.mediaKey] = res.id;
      await chrome.storage.local.set({ ledger });
      if (res.status === 'created') uploaded++;
      log(`${res.status}: ${file.filename} (${(file.size / 1e6).toFixed(1)} MB)`);
    } catch (err) {
      status[it.mediaKey] = { state: 'error', message: err.message };
      log(`error: ${it.mediaKey}: ${err.message}`);
    }
  }

  // Mirror into the Immich album.
  const albumName = album.title;
  const wanted = Object.values(status)
    .filter((s) => s.assetId && (s.state === 'uploaded' || (settings.addExisting && s.state === 'in-immich')))
    .map((s) => s.assetId);
  let immichAlbum = (await immich.listAlbums()).find((a) => a.albumName === albumName);
  const inAlbum = immichAlbum ? await immich.albumAssetIds(immichAlbum.id) : new Set();
  const toAdd = [...new Set(wanted)].filter((id) => !inAlbum.has(id));
  let addedToAlbum = 0;
  if (toAdd.length && !dryRun) {
    immichAlbum ??= await immich.createAlbum(albumName);
    addedToAlbum = await immich.addToAlbum(immichAlbum.id, toAdd);
    log(`added ${addedToAlbum} asset(s) to Immich album "${albumName}"`);
  }

  const count = (state) => Object.values(status).filter((s) => s.state === state).length;
  return {
    album,
    status,
    summary: {
      title: album.title,
      total: album.items.length,
      inImmich: count('in-immich'),
      trashed: count('trashed'),
      missing: count('missing'),
      uploaded,
      errors: count('error'),
      addedToAlbum,
      wouldAddToAlbum: dryRun ? toAdd.length : 0,
    },
  };
}

// Used by the periodic alarm.
export async function syncAll({ log = () => {} } = {}) {
  const { settings, albums } = await loadConfig();
  const results = [];
  for (const url of albums) {
    try {
      const r = await syncAlbum(url, settings, { log });
      results.push({ url, summary: r.summary });
    } catch (err) {
      log(`error: ${url}: ${err.message}`);
      results.push({ url, error: err.message });
    }
  }
  const lastRun = { at: Date.now(), results };
  await chrome.storage.local.set({ lastRun });
  return lastRun;
}
