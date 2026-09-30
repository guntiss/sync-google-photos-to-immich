// Orchestrates: list Google album -> dedupe against Immich by SHA-1 -> upload missing
// -> mirror into an Immich album named after the Google album.
import { listAlbum, downloadOriginal, fetchLocations } from './gphotos.js';
import { Immich, dedupKeyToChecksum } from './immich.js';
import { acquireLock, createReporter, percentDone, RUNNING_PHASES } from './state.js';

export const ALARM = 'gphotos-sync';
export const DEFAULT_SETTINGS = { immichUrl: '', apiKey: '', intervalMinutes: 60, addExisting: true };

export class BusyError extends Error {}

export async function loadConfig() {
  const { settings = {}, albums = [] } = await chrome.storage.local.get(['settings', 'albums']);
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, albums };
}

// Immich asset metadata key under which each copy records the Google Photos item it came
// from ({mediaKey, dedupKey}). Google's download often differs from its dedupKey, so the
// checksum can't find earlier copies; this record lets any install of the extension (in
// another browser, or after a reinstall) find them without downloading again.
export const RECORD_KEY = 'google-photos';

// ledger: mediaKey -> Immich asset id, for everything this install copied or found.
// recorded: mediaKeys whose asset already carries the RECORD_KEY record.
// located: mediaKeys whose location has been looked at (copied from Google Photos, or
// not needed), so it is not asked for again.
async function loadLedger() {
  const { ledger = {}, recorded = {}, located = {} } = await chrome.storage.local.get(['ledger', 'recorded', 'located']);
  return { ledger, recorded, located };
}

const LOCATION_CHUNK = 200;

const MAX_SHIFT_MS = 15 * 3_600_000;
const QUARTER_HOUR_MS = 15 * 60_000;

// Could an Immich asset (with ms = its capture time) be the copy of Google item `it`? The
// times mostly agree to the millisecond, but Google and Immich can read a photo's time in
// different time zones (whole quarter hours apart) and a video's from different tags
// (minutes apart).
function couldBeCopy(asset, it) {
  if (asset.type !== (it.isVideo ? 'VIDEO' : 'IMAGE')) return false;
  const d = Math.abs(asset.ms - it.takenMs);
  return d <= MAX_SHIFT_MS && (it.isVideo || d % QUARTER_HOUR_MS === 0);
}

// Runs fn over list, at most n at a time. After a failure it starts no more, waits for the
// running ones to finish, then throws the first error.
async function eachLimit(list, n, fn) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < list.length) {
      try {
        await fn(list[next++]);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  if (failure) throw failure.err;
}

// Items downloaded and uploaded at the same time. Each is held in memory while in flight.
const PARALLEL_COPIES = 3;

/**
 * Find Immich assets whose RECORD_KEY record names one of `items`, by mediaKey or, for the
 * same photo seen through another album, by dedupKey. Candidates come from a search by
 * capture time; their records are read closest first.
 * @returns {Promise<Map<string, {id: string, isTrashed: boolean}>>} mediaKey -> asset
 */
async function findRecordedCopies(immich, items) {
  const found = new Map();
  if (!items.length) return found;
  const spans = [];
  for (const t of items.map((it) => it.takenMs).sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && t - MAX_SHIFT_MS <= last[1]) last[1] = t + MAX_SHIFT_MS;
    else spans.push([t - MAX_SHIFT_MS, t + MAX_SHIFT_MS]);
  }
  const assets = [];
  for (const [from, to] of spans) {
    for (const a of await immich.searchTaken(new Date(from), new Date(to))) assets.push({ ...a, ms: Date.parse(a.fileCreatedAt) });
  }

  const records = new Map(); // asset id -> Promise<record | null>
  const recordOf = (id) => {
    if (!records.has(id)) {
      records.set(id, immich.getMetadata(id).then((m) => m.find((x) => x.key === RECORD_KEY)?.value ?? null));
    }
    return records.get(id);
  };
  await eachLimit(items, 8, async (it) => {
    const candidates = assets.filter((a) => couldBeCopy(a, it));
    candidates.sort((a, b) => Math.abs(a.ms - it.takenMs) - Math.abs(b.ms - it.takenMs));
    for (const a of candidates) {
      const r = await recordOf(a.id);
      if (r && (r.mediaKey === it.mediaKey || (it.dedupKey && r.dedupKey === it.dedupKey))) {
        found.set(it.mediaKey, a);
        return;
      }
    }
  });
  return found;
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// A transfer meter times the stretches when at least one transfer is in flight, so with
// several copies at once bytes / ms is the overall speed, not one connection's.
// {bytes, ms, active, since}: since is set while active > 0.
const newMeter = () => ({ bytes: 0, ms: 0, active: 0, since: null });
function meterStart(m) {
  if (m.active++ === 0) m.since = Date.now();
}
function meterStop(m) {
  if (--m.active === 0) {
    m.ms += Date.now() - m.since;
    m.since = null;
  }
}

/**
 * Sync (or with dryRun, only check) one album, reporting progress into report.state:
 *   phase: listing -> checking -> uploading -> locations -> album -> done (or 'stopped' / 'error', set by runSync)
 *   title / albumKey, total / inImmich / trashed / missing / failed,
 *   run: {...this run's stats}, totals: {...all time}
 * @returns {{album, status: Record<string, {state: string, assetId?: string, message?: string}>}}
 *   state: 'in-immich' | 'trashed' | 'missing' | 'uploaded' | 'error'
 * Throws when signal aborts; items copied until then stay counted.
 */
export async function syncAlbum(albumUrl, settings, immich, report, { dryRun = false, locationsOnly = false, limit = Infinity, signal } = {}) {
  const s = report.state;
  Object.assign(s, {
    phase: 'listing',
    mode: dryRun ? 'check' : locationsOnly ? 'locations' : 'sync',
    message: null,
    listed: 0,
    run: { startedAt: Date.now(), finishedAt: null, locations: 0, locationsTotal: 0, locationsDone: 0, locationsError: null, toUpload: 0, done: 0, uploadedFiles: 0, uploadedBytes: 0, failed: 0, active: [], download: newMeter(), upload: newMeter() },
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

  const { ledger, recorded, located } = await loadLedger();

  // Writes the RECORD_KEY record onto copies ([{it, assetId}]). Failing is not fatal: this
  // install's ledger still knows the copies, only other installs won't find them.
  let recordWarned = false;
  const record = async (pairs) => {
    if (!pairs.length) return;
    const write = async (part) => {
      const value = (it) => ({ mediaKey: it.mediaKey, dedupKey: it.dedupKey });
      await immich.setMetadata(part.map(({ it, assetId }) => ({ assetId, key: RECORD_KEY, value: value(it) })));
      part.forEach(({ it }) => (recorded[it.mediaKey] = 1));
    };
    try {
      for (let i = 0; i < pairs.length; i += 500) {
        const chunk = pairs.slice(i, i + 500);
        try {
          await write(chunk);
        } catch (err) {
          // One asset deleted from Immich fails the whole request, so retry one by one.
          // A deleted asset has nothing to record.
          if (err.status !== 400) throw err;
          for (const p of chunk) {
            try {
              await write([p]);
            } catch (e) {
              if (e.status !== 400) throw e;
              recorded[p.it.mediaKey] = 1;
            }
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!recordWarned) report.log(`Could not mark copies in Immich for other installs: ${err.message}`);
      recordWarned = true;
    }
    await chrome.storage.local.set({ recorded });
  };

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
  let missing = [];
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

  // Copies made from another browser, or before a reinstall.
  try {
    const found = await findRecordedCopies(immich, missing);
    if (found.size) {
      for (const [mediaKey, asset] of found) {
        status[mediaKey] = { state: asset.isTrashed ? 'trashed' : 'in-immich', assetId: asset.id };
        if (asset.isTrashed) continue;
        ledger[mediaKey] = asset.id;
        recorded[mediaKey] = 1;
      }
      missing = missing.filter((it) => !found.has(it.mediaKey));
      await chrome.storage.local.set({ ledger, recorded });
      report.log(`Found ${found.size} ${found.size === 1 ? 'copy' : 'copies'} made from another browser or install`);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    report.log(`Could not look for copies made from other installs: ${err.message}`);
  }

  const count = (state) => Object.values(status).filter((x) => x.state === state).length;
  Object.assign(s, { inImmich: count('in-immich'), trashed: count('trashed'), missing: missing.length, failed: count('error') });
  report.log(
    `${s.inImmich} already in Immich, ${missing.length} missing` +
      (s.trashed ? `, ${s.trashed} in Immich trash (skipped)` : '') +
      (s.failed ? `, ${s.failed} unreadable` : ''),
  );

  // Copies this install made before copies were marked in Immich.
  if (!dryRun && !locationsOnly) {
    const unmarked = album.items.filter((it) => ledger[it.mediaKey] && !recorded[it.mediaKey]);
    await record(unmarked.map((it) => ({ it, assetId: ledger[it.mediaKey] })));
  }

  // Upload missing items, oldest first (so an interrupted run leaves few gaps in the past),
  // PARALLEL_COPIES at a time.
  missing.sort((a, b) => a.takenMs - b.takenMs);
  const queue = dryRun || locationsOnly ? [] : missing.slice(0, limit);
  s.run.toUpload = queue.length;
  if (queue.length) {
    s.phase = 'uploading';
    s.run.uploadStartedAt = Date.now();
  }
  await report.save(true);

  // run.active lists the items in flight: {name, step: 'downloading' | 'uploading', received, size, isVideo}.
  const copy = async (it) => {
    signal?.throwIfAborted();
    const cur = { name: null, step: 'downloading', received: 0, size: null, isVideo: it.isVideo };
    s.run.active.push(cur);
    report.save();
    let assetId = null;
    let timing = null; // the meter running for this item
    const time = (m) => {
      if (timing) meterStop(timing);
      timing = m;
      if (m) meterStart(m);
    };
    try {
      time(s.run.download);
      const file = await downloadOriginal(it, {
        signal,
        onProgress: ({ filename, received, total }) => {
          Object.assign(cur, { name: filename, received, size: total });
          report.save();
        },
      });
      if (file.sha1Key !== it.dedupKey) report.log(`Warning: ${file.filename} differs from Google's checksum (not the original?)`);
      s.run.download.bytes += file.size;
      Object.assign(cur, { name: file.filename, step: 'uploading', received: file.size, size: file.size });
      time(s.run.upload);
      report.save();
      const res = await immich.upload({
        blob: file.blob,
        filename: file.filename,
        createdAt: new Date(it.takenMs),
        modifiedAt: new Date(it.takenMs),
        sha1Hex: file.sha1Hex,
      });
      time(null);
      s.run.upload.bytes += file.size;
      assetId = res.id;
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
      report.log(`Failed ${cur.name ?? it.mediaKey}: ${err.message}`);
    } finally {
      time(null);
      s.run.active.splice(s.run.active.indexOf(cur), 1);
    }
    s.run.done++;
    await report.save(true);
    if (assetId) await record([{ it, assetId }]);
  };
  await eachLimit(queue, PARALLEL_COPIES, copy);

  // Google's download of a shared item mostly has its GPS tags stripped, so Immich would have
  // no location for the copy. Give it the one Google Photos shows, but never replace a
  // location Immich already has (a Takeout import, or one set by hand). A sync does this for
  // the items it just copied; "Sync locations" (locationsOnly) does it for every item not
  // looked at yet, which takes a while for a big album. Failing is not fatal: the items not
  // done are tried again next time.
  signal?.throwIfAborted();
  const wantLocation = album.items.filter((it) => {
    const st = status[it.mediaKey]?.state;
    return (st === 'uploaded' || (locationsOnly && st === 'in-immich')) && !located[it.mediaKey];
  });
  if (!dryRun && wantLocation.length) {
    s.phase = 'locations';
    s.run.locationsTotal = wantLocation.length;
    await report.save(true);
    try {
      for (let i = 0; i < wantLocation.length; i += LOCATION_CHUNK) {
        signal?.throwIfAborted();
        const chunk = wantLocation.slice(i, i + LOCATION_CHUNK);
        try {
          const places = await fetchLocations(album.session, chunk, { signal });
          await eachLimit(chunk, 8, async (it) => {
            if (!places.has(it.mediaKey)) return;
            const place = places.get(it.mediaKey);
            const { assetId } = status[it.mediaKey];
            try {
              if (place) {
                const asset = await immich.getAsset(assetId);
                if (asset.exifInfo?.latitude == null) {
                  await immich.updateAsset(assetId, place);
                  s.run.locations++;
                }
              }
            } catch (err) {
              // The asset was deleted from Immich meanwhile: nothing to set.
              if (err.status !== 400 && err.status !== 404) throw err;
            }
            located[it.mediaKey] = 1;
          });
        } finally {
          await chrome.storage.local.set({ located });
        }
        s.run.locationsDone = Math.min(i + LOCATION_CHUNK, wantLocation.length);
        report.save();
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      s.run.locationsError = err.message;
      report.log(`Could not copy locations to Immich: ${err.message}`);
    }
    const n = s.run.locations;
    if (n || locationsOnly) report.log(`Copied the location of ${n} ${n === 1 ? 'item' : 'items'} from Google Photos to Immich`);
  }

  // Mirror into the Immich album.
  if (!locationsOnly) {
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
  }

  Object.assign(s, { phase: 'done' });
  if (!locationsOnly) s.immichAlbum = album.title;
  s.run.finishedAt = Date.now();
  if (!locationsOnly) s[dryRun ? 'lastCheckAt' : 'lastSyncAt'] = s.run.finishedAt;
  if (!dryRun && !locationsOnly) {
    const r = s.run;
    s.lastSync = {
      files: r.uploadedFiles, bytes: r.uploadedBytes, failed: r.failed, durationMs: r.finishedAt - r.startedAt,
      download: { bytes: r.download.bytes, ms: r.download.ms }, upload: { bytes: r.upload.bytes, ms: r.upload.ms },
    };
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
 * Run a check, a sync, or (locationsOnly) a locations-only sync over the given albums
 * (default: all configured) under the shared lock. Throws BusyError if another sync is running. A stop request
 * (state.js requestStop) ends the run: the current album is marked 'stopped' and the
 * rest are left as they were, and the result has stopped: true.
 * @param {{urls?: string[], dryRun?: boolean, locationsOnly?: boolean, trigger?: 'manual'|'schedule', onAlbum?: (url: string, r: object) => void}} opts
 */
export async function runSync({ urls, dryRun = false, locationsOnly = false, trigger = 'manual', onAlbum } = {}) {
  const { settings, albums } = await loadConfig();
  urls ??= albums;
  if (!settings.immichUrl || !settings.apiKey) throw new Error('Connect to Immich first (Settings).');
  const origin = new URL(settings.immichUrl).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new Error(`No access to ${origin} yet. Open Settings and click Save to grant it.`);
  }

  const lock = await acquireLock({ trigger, mode: dryRun ? 'check' : locationsOnly ? 'locations' : 'sync' });
  if (!lock) throw new BusyError('Another sync is already running.');
  const { release, signal } = lock;
  const lastRun = { at: Date.now(), trigger, dryRun, locationsOnly, results: [] };
  try {
    const immich = new Immich(settings.immichUrl, settings.apiKey, { signal });
    await immich.me(); // fail fast on a bad URL / key
    for (const url of urls) {
      signal.throwIfAborted();
      const report = await createReporter(url, { onSave: badgeProgress });
      try {
        const r = await syncAlbum(url, settings, immich, report, { dryRun, locationsOnly, signal });
        onAlbum?.(url, r);
        const { title, run } = report.state;
        lastRun.results.push({ url, title, percent: percentDone(report.state), uploaded: run.uploadedFiles, bytes: run.uploadedBytes, failed: run.failed });
      } catch (err) {
        if (signal.aborted) {
          const { title, run } = report.state;
          report.state.phase = 'stopped';
          run.active = [];
          report.log(`${dryRun ? 'Check' : locationsOnly ? 'Location sync' : 'Sync'} stopped` + (run.uploadedFiles ? ` after copying ${run.uploadedFiles} (${mb(run.uploadedBytes)})` : ''));
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
