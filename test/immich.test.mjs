import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupKeyToChecksum, normalizeBaseUrl } from '../immich.js';

test("Google's dedupKey converts to Immich's base64 checksum", () => {
  // both taken from the same real photo (Google share page vs Immich asset)
  assert.equal(dedupKeyToChecksum('3a_cFgyZCRYAsPN_BrhtaiswMrg'), '3a/cFgyZCRYAsPN/BrhtaiswMrg=');
});

test('normalizeBaseUrl strips trailing slash and /api', () => {
  assert.equal(normalizeBaseUrl('https://im.g4.lv/'), 'https://im.g4.lv');
  assert.equal(normalizeBaseUrl('https://host/immich/api/'), 'https://host/immich');
});
