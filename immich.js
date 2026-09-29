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
  constructor(baseUrl, apiKey) {
    this.api = `${normalizeBaseUrl(baseUrl)}/api`;
    this.apiKey = apiKey;
  }

  async request(method, path, { json, body, headers = {} } = {}) {
    const h = { 'x-api-key': this.apiKey, Accept: 'application/json', ...headers };
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(this.api + path, { method, headers: h, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Immich ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
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

  async albumAssetIds(albumId) {
    const ids = new Set();
    let page = 1;
    for (;;) {
      const r = await this.request('POST', '/search/metadata', { json: { albumIds: [albumId], size: 1000, page } });
      r.assets.items.forEach((a) => ids.add(a.id));
      if (!r.assets.nextPage) return ids;
      page = Number(r.assets.nextPage);
    }
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
