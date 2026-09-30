// Per-album progress and stats, shared between the extension page and the background
// worker through chrome.storage, so the page shows a sync whichever of them runs it.
// A heartbeat lock in storage.session keeps the two from syncing at the same time, and
// a stop request there lets the page stop a sync whichever of them runs it.

const PREFIX = 'albumState:';
const LOG_LINES = 200;
const SAVE_DELAY_MS = 300;
export const LOCK_KEY = 'syncLock';
export const STOP_KEY = 'syncStop';
const LOCK_BEAT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

export const RUNNING_PHASES = new Set(['listing', 'checking', 'uploading', 'locations', 'album']);
export const stateKey = (url) => PREFIX + url;
export const urlFromKey = (key) => (key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null);

export async function getStates(urls) {
  const got = await chrome.storage.local.get(urls.map(stateKey));
  return Object.fromEntries(urls.map((u) => [u, got[stateKey(u)] ?? null]));
}

export const removeState = (url) => chrome.storage.local.remove(stateKey(url));

// Share of the album that needs no more work (in Immich, or in its trash).
export function percentDone(s) {
  if (!s?.total) return null;
  return Math.floor((100 * (s.total - (s.missing ?? 0) - (s.failed ?? 0))) / s.total);
}

/**
 * Mutable state for one album plus throttled persistence. Mutate `state`, then call
 * save() (throttled) or save(true) (immediate).
 */
export async function createReporter(url, { onSave } = {}) {
  const key = stateKey(url);
  const prev = (await chrome.storage.local.get(key))[key] ?? {};
  const state = {
    ...prev,
    log: prev.log ?? [],
    totals: prev.totals ?? { uploadedFiles: 0, uploadedBytes: 0 },
  };
  let timer = null;
  const write = async () => {
    clearTimeout(timer);
    timer = null;
    await chrome.storage.local.set({ [key]: state });
    onSave?.(state);
  };
  return {
    state,
    save(immediate = false) {
      if (immediate) return write();
      timer ??= setTimeout(write, SAVE_DELAY_MS);
    },
    log(msg) {
      console.log('[sync]', msg);
      state.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
      if (state.log.length > LOG_LINES) state.log.splice(0, state.log.length - LOG_LINES);
      timer ??= setTimeout(write, SAVE_DELAY_MS);
    },
  };
}

export async function getLock() {
  return (await chrome.storage.session.get(LOCK_KEY))[LOCK_KEY] ?? null;
}

export const isLockActive = (lock) => Boolean(lock && Date.now() - lock.beat < LOCK_STALE_MS);

// Asks the sync holding `lock` to stop. The request names the run (its `since`), so it
// cannot stop a later one.
export const requestStop = (lock) => chrome.storage.session.set({ [STOP_KEY]: lock.since });

export async function getStopRequest() {
  return (await chrome.storage.session.get(STOP_KEY))[STOP_KEY] ?? null;
}

// Returns {release, signal}, or null if another sync holds the lock. The signal aborts
// when requestStop() is called for this run.
export async function acquireLock(owner) {
  if (isLockActive(await getLock())) return null;
  const since = Date.now();
  const stop = new AbortController();
  const onChanged = (changes, area) => {
    if (area === 'session' && changes[STOP_KEY]?.newValue === since) stop.abort();
  };
  chrome.storage.onChanged.addListener(onChanged);
  const beat = () => chrome.storage.session.set({ [LOCK_KEY]: { ...owner, since, beat: Date.now() } });
  await beat();
  const timer = setInterval(beat, LOCK_BEAT_MS);
  return {
    signal: stop.signal,
    async release() {
      clearInterval(timer);
      chrome.storage.onChanged.removeListener(onChanged);
      await chrome.storage.session.remove([LOCK_KEY, STOP_KEY]);
    },
  };
}
