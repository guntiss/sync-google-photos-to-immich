// Orchestrates: list Google album -> dedupe against Immich by SHA-1 -> upload missing
// -> mirror into an Immich album named after the Google album.
import { listAlbum, downloadOriginal } from './gphotos.js';
import { Immich, dedupKeyToChecksum } from './immich.js';
import { acquireLock, createReporter, percentDone, RUNNING_PHASES } from './state.js';

export const ALARM = 'gphotos-sync';
export const DEFAULT_SETTINGS = { immichUrl: '', apiKey: '', intervalMinutes: 60, addExisting: true };

export class BusyError extends Error {}

export async function loadConfig() {
  const { settings = {}, albums = [] } = await chrome.storage.local.get(['settings', 'albums']);
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, albums };
}

// mediaKey -> Immich asset id, for everything this extension uploaded. Stops a photo
// from being re-uploaded when its Immich checksum differs from Google's dedupKey.
async function loadLedger() {
  return (await chrome.storage.local.get('ledger')).ledger ?? {};
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/**
 * Sync (or with dryRun, only check) one album, reporting progress into report.state:
 *   phase: listing -> checking -> uploading -> album -> done (or 'stopped' / 'error', set by runSync)
 *   title / albumKey, total / inImmich / trashed / missing / failed,
 *   run: {...this run's stats}, totals: {...all time}
 * @returns {{album, status: Record<string, {state: string, assetId?: string, message?: string}>}}
 *   state: 'in-immich' | 'trashed' | 'missing' | 'uploaded' | 'error'
 * Throws when signal aborts; items copied until then stay counted.
 */
export async function syncAlbum(albumUrl, settings, immich, report, { dryRun = false, limit = Infinity, signal } = {}) {
  const s = report.state;
  Object.assign(s, {
    phase: 'listing',
    mode: dryRun ? 'check' : 'sync',
    message: null,
    listed: 0,
    run: { startedAt: Date.now(), finishedAt: null, toUpload: 0, done: 0, uploadedFiles: 0, uploadedBytes: 0, failed: 0, current: null },
  });
  await report.save(true);

  const album = await listAlbum(albumUrl, {
    signal,
    onProgress: (n) => {
      s.listed = n;
      report.save();
    },
  });
  const videos = album.items.filter((i) => i.isVideo).length;
  Object.assign(s, { phase: 'checking', title: album.title, albumKey: album.albumKey, total: album.items.length, videos });
  report.log(`Read "${album.title}" from Google Photos: ${album.items.length} items (${videos} videos)`);
  await report.save(true);

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
  const count = (state) => Object.values(status).filter((x) => x.state === state).length;
  Object.assign(s, { inImmich: count('in-immich'), trashed: count('trashed'), missing: missing.length, failed: count('error') });
  report.log(
    `${s.inImmich} already in Immich, ${missing.length} missing` +
      (s.trashed ? `, ${s.trashed} in Immich trash (skipped)` : '') +
      (s.failed ? `, ${s.failed} unreadable` : ''),
  );

  // Upload missing items, oldest first (so an interrupted run leaves no gaps in the past).
  missing.sort((a, b) => a.takenMs - b.takenMs);
  const queue = dryRun ? [] : missing.slice(0, limit);
  s.run.toUpload = queue.length;
  if (queue.length) {
    s.phase = 'uploading';
    s.run.uploadStartedAt = Date.now();
  }
  await report.save(true);

  for (const it of queue) {
    signal?.throwIfAborted();
    s.run.current = { name: null, step: 'downloading', received: 0, size: null, isVideo: it.isVideo };
    report.save();
    try {
      const file = await downloadOriginal(it, {
        signal,
        onProgress: ({ filename, received, total }) => {
          Object.assign(s.run.current, { name: filename, received, size: total });
          report.save();
        },
      });
      if (file.sha1Key !== it.dedupKey) report.log(`Warning: ${file.filename} differs from Google's checksum (not the original?)`);
      Object.assign(s.run.current, { name: file.filename, step: 'uploading', received: file.size, size: file.size });
      report.save();
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
      s.missing--;
      s.inImmich++;
      if (res.status === 'created') {
        s.run.uploadedFiles++;
        s.run.uploadedBytes += file.size;
        s.totals.uploadedFiles++;
        s.totals.uploadedBytes += file.size;
        report.log(`Copied ${file.filename} (${mb(file.size)})`);
      } else {
        report.log(`Already in Immich: ${file.filename}`);
      }
    } catch (err) {
      if (signal?.aborted) throw err; // stopped, not failed: the item is still to copy
      status[it.mediaKey] = { state: 'error', message: err.message };
      s.missing--;
      s.failed++;
      s.run.failed++;
      report.log(`Failed ${s.run.current.name ?? it.mediaKey}: ${err.message}`);
    }
    s.run.done++;
    await report.save(true);
  }
  s.run.current = null;

  // Mirror into the Immich album.
  signal?.throwIfAborted();
  s.phase = 'album';
  await report.save(true);
  const albumName = album.title;
  const wanted = Object.values(status)
    .filter((x) => x.assetId && (x.state === 'uploaded' || (settings.addExisting && x.state === 'in-immich')))
    .map((x) => x.assetId);
  let immichAlbum = (await immich.listAlbums()).find((a) => a.albumName === albumName);
  const inAlbum = immichAlbum ? await immich.albumAssetIds(immichAlbum.id) : new Set();
  const toAdd = [...new Set(wanted)].filter((id) => !inAlbum.has(id));
  if (toAdd.length && !dryRun) {
    immichAlbum ??= await immich.createAlbum(albumName);
    const added = await immich.addToAlbum(immichAlbum.id, toAdd);
    report.log(`Added ${added} item(s) to Immich album "${albumName}"`);
  } else if (toAdd.length) {
    report.log(`${toAdd.length} item(s) would be added to Immich album "${albumName}"`);
  }

  Object.assign(s, { phase: 'done', immichAlbum: albumName });
  s.run.finishedAt = Date.now();
  s[dryRun ? 'lastCheckAt' : 'lastSyncAt'] = s.run.finishedAt;
  if (!dryRun) {
    const r = s.run;
    s.lastSync = { files: r.uploadedFiles, bytes: r.uploadedBytes, failed: r.failed, durationMs: r.finishedAt - r.startedAt };
    report.log(
      `Sync finished: copied ${r.uploadedFiles} (${mb(r.uploadedBytes)})` + (r.failed ? `, ${r.failed} failed` : '') +
        ` in ${Math.round((r.finishedAt - r.startedAt) / 1000)} s`,
    );
  }
  await report.save(true);
  return { album, status };
}

// Toolbar badge: percentage while copying, "!" when the last run had failures.
function badge(text, color = '#1a73e8') {
  chrome.action?.setBadgeText({ text }).catch(() => {});
  chrome.action?.setBadgeBackgroundColor({ color }).catch(() => {});
}
function badgeProgress(state) {
  if (state.phase === 'uploading') badge(`${percentDone(state) ?? 0}%`);
  else if (RUNNING_PHASES.has(state.phase)) badge('…');
}

/**
 * Run a check or sync over the given albums (default: all configured) under the
 * shared lock. Throws BusyError if another sync is running. A stop request
 * (state.js requestStop) ends the run: the current album is marked 'stopped' and the
 * rest are left as they were, and the result has stopped: true.
 * @param {{urls?: string[], dryRun?: boolean, trigger?: 'manual'|'schedule', onAlbum?: (url: string, r: object) => void}} opts
 */
export async function runSync({ urls, dryRun = false, trigger = 'manual', onAlbum } = {}) {
  const { settings, albums } = await loadConfig();
  urls ??= albums;
  if (!settings.immichUrl || !settings.apiKey) throw new Error('Connect to Immich first (Settings).');
  const origin = new URL(settings.immichUrl).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new Error(`No access to ${origin} yet. Open Settings and click Save to grant it.`);
  }

  const lock = await acquireLock({ trigger, mode: dryRun ? 'check' : 'sync' });
  if (!lock) throw new BusyError('Another sync is already running.');
  const { release, signal } = lock;
  const lastRun = { at: Date.now(), trigger, dryRun, results: [] };
  try {
    const immich = new Immich(settings.immichUrl, settings.apiKey, { signal });
    await immich.me(); // fail fast on a bad URL / key
    for (const url of urls) {
      signal.throwIfAborted();
      const report = await createReporter(url, { onSave: badgeProgress });
      try {
        const r = await syncAlbum(url, settings, immich, report, { dryRun, signal });
        onAlbum?.(url, r);
        const { title, run } = report.state;
        lastRun.results.push({ url, title, percent: percentDone(report.state), uploaded: run.uploadedFiles, bytes: run.uploadedBytes, failed: run.failed });
      } catch (err) {
        if (signal.aborted) {
          const { title, run } = report.state;
          report.state.phase = 'stopped';
          run.current = null;
          report.log(`${dryRun ? 'Check' : 'Sync'} stopped` + (run.uploadedFiles ? ` after copying ${run.uploadedFiles} (${mb(run.uploadedBytes)})` : ''));
          await report.save(true);
          lastRun.results.push({ url, title, stopped: true, uploaded: run.uploadedFiles, bytes: run.uploadedBytes, failed: run.failed });
          throw err;
        }
        Object.assign(report.state, { phase: 'error', message: err.message });
        report.log(`Error: ${err.message}`);
        await report.save(true);
        lastRun.results.push({ url, title: report.state.title, error: err.message });
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      lastRun.error = err.message;
      throw err;
    }
    lastRun.stopped = true;
  } finally {
    await release();
    lastRun.at = Date.now();
    await chrome.storage.local.set({ lastRun });
    const bad = lastRun.error || lastRun.results.some((r) => r.error || r.failed);
    badge(bad ? '!' : '', '#d93025');
  }
  return lastRun;
}
