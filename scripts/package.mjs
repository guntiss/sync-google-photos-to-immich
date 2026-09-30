// Builds the zip to upload to the Chrome Web Store, holding only what the extension loads.
// usage: npm run package   (writes dist/sync-google-photos-to-immich-<version>.zip)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = [
  'manifest.json',
  ...fs.readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f)),
  ...fs.readdirSync(path.join(root, 'icons')).filter((f) => f.endsWith('.png')).map((f) => `icons/${f}`),
];

// Everything the manifest, the page and the modules refer to must be in the zip.
const referenced = [
  manifest.background.service_worker,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\(\s*|(?:src|href)=)['"]\.?\/?([\w./-]+\.(?:js|css|png))['"]/g)) referenced.push(m[1]);
}
const absent = [...new Set(referenced)].filter((f) => !files.includes(f));
if (absent.length) throw new Error(`Referenced but not packaged: ${absent.join(', ')}`);

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const zip = path.join(dist, `sync-google-photos-to-immich-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-X', '-q', zip, ...files], { cwd: root });
console.log(`${path.relative(root, zip)}: ${files.length} files, ${Math.round(fs.statSync(zip).size / 1024)} KB`);
console.log(files.join('\n'));
