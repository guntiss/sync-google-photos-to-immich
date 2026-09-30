// Minimal Immich REST client (targets Immich v2/v3 API).

// Google's dedupKey is the URL-safe, unpadded base64 of the file's SHA-1;
// Immich stores/accepts standard base64.
export function dedupKeyToChecksum(key) {
  const s = key.replace(/-/g, '+').replace(/_/g, '/');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

export function normalizeBaseUrl(input) {
  const u = new URL(input.trim());
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return u.origin + path;
}

export class Immich {
  // signal, if given, aborts every request made through this client.
  constructor(baseUrl, apiKey, { signal } = {}) {
    this.api = `${normalizeBaseUrl(baseUrl)}/api`;
    this.apiKey = apiKey;
    this.signal = signal;
  }

  async request(method, path, { json, body, headers = {} } = {}) {
    const h = { 'x-api-key': this.apiKey, Accept: 'application/json', ...headers };
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(this.api + path, { method, headers: h, body, signal: this.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Immich ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  me() {
    return this.request('GET', '/users/me');
  }

  about() {
    return this.request('GET', '/server/about');
  }

  listAlbums() {
    return this.request('GET', '/albums');
  }

  createAlbum(albumName) {
    return this.request('POST', '/albums', { json: { albumName } });
  }

  // Every asset matching a /search/metadata query, across pages.
  async searchAll(query) {
    const assets = [];
    for (let page = 1; page; ) {
      const r = await this.request('POST', '/search/metadata', { json: { ...query, size: 1000, page } });
      assets.push(...r.assets.items);
      page = r.assets.nextPage ? Number(r.assets.nextPage) : 0;
    }
    return assets;
  }

  async albumAssetIds(albumId) {
    return new Set((await this.searchAll({ albumIds: [albumId] })).map((a) => a.id));
  }

  // Assets captured between two Dates (inclusive), trashed ones included.
  searchTaken(after, before) {
    return this.searchAll({ takenAfter: after.toISOString(), takenBefore: before.toISOString(), withDeleted: true });
  }

  // -> [{key, value, updatedAt}]
  getMetadata(assetId) {
    return this.request('GET', `/assets/${assetId}/metadata`);
  }

  // Upserts items: [{assetId, key, value(object)}]. Fails as a whole (HTTP 400) if any
  // asset is gone.
  setMetadata(items) {
    return this.request('PUT', '/assets/metadata', { json: { items } });
  }

  async addToAlbum(albumId, ids) {
    let added = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const res = await this.request('PUT', `/albums/${albumId}/assets`, { json: { ids: ids.slice(i, i + 500) } });
      added += res.filter((r) => r.success).length;
    }
    return added;
  }

  // entries: [{id, checksum(base64)}] -> Map(id -> {action, reason, assetId, isTrashed})
  async bulkCheck(entries) {
    const out = new Map();
    for (let i = 0; i < entries.length; i += 1000) {
      const r = await this.request('POST', '/assets/bulk-upload-check', { json: { assets: entries.slice(i, i + 1000) } });
      r.results.forEach((x) => out.set(x.id, x));
    }
    return out;
  }

  // -> {id, status: 'created' | 'duplicate'}
  upload({ blob, filename, createdAt, modifiedAt, sha1Hex }) {
    const fd = new FormData();
    fd.append('assetData', blob, filename);
    fd.append('filename', filename);
    fd.append('fileCreatedAt', createdAt.toISOString());
    fd.append('fileModifiedAt', modifiedAt.toISOString());
    return this.request('POST', '/assets', { body: fd, headers: { 'x-immich-checksum': sha1Hex } });
  }
}
