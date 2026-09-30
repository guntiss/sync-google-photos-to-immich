// Renders the extension icons and the Chrome Web Store promo tile from the SVG below.
// usage: npm run icons   (writes icons/icon-*.png and store/promo-small-440x280.png)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'icons');
const storeDir = path.join(root, 'store');
fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(storeDir, { recursive: true });

// A photo (mountains and sun) inside two sync arrows, on a rounded square. Drawn on a 128 grid
// whose 96-unit artwork has the 16-unit transparent margin the store asks for; `crop` drops
// the margin and `photo: false` drops the photo, for the small toolbar sizes.
function iconSvg({ size, crop = false, photo = true, style = '' }) {
  const C = 64;
  const R = photo ? 28 : 27;
  const stroke = photo ? 8 : 11;
  const pt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return `${(C + R * Math.cos(a)).toFixed(2)} ${(C + R * Math.sin(a)).toFixed(2)}`;
  };
  const arc = (from, to) => `M${pt(from)} A${R} ${R} 0 0 1 ${pt(to)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" style="${style}" viewBox="${crop ? '16 16 96 96' : '0 0 128 128'}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
  <marker id="head" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="2.4" markerHeight="2.4" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#fff"/></marker>
</defs>
<rect x="16" y="16" width="96" height="96" rx="24" fill="url(#bg)"/>
<g fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" marker-end="url(#head)">
  <path d="${photo ? arc(195, 322) : arc(212, 308)}"/>
  <path d="${photo ? arc(15, 142) : arc(32, 128)}"/>
</g>
${photo ? `<circle cx="72" cy="54" r="4.5" fill="#fff"/>
<path d="M48 75 L58 61 L64 69 L69 63 L80 75 Z" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>` : ''}
</svg>`;
}

const ICONS = [
  { size: 16, crop: true, photo: false },
  { size: 32, crop: true, photo: true },
  { size: 48 },
  { size: 128 },
];

const promoHtml = `<div id="tile" style="width:440px;height:280px;box-sizing:border-box;display:flex;align-items:center;gap:20px;padding:0 28px;
  background:linear-gradient(135deg,#eef2ff,#e0e7ff);font-family:system-ui,-apple-system,sans-serif;color:#1e1b4b">
  ${iconSvg({ size: 100, crop: true, style: 'flex-shrink:0' })}
  <div>
    <div style="font-size:26px;font-weight:700;line-height:1.15;letter-spacing:-0.3px">Sync Google Photos to Immich</div>
    <div style="font-size:14px;line-height:1.45;margin-top:10px;color:#3730a3">Shared albums, in the background.<br>No server to run.</div>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 1 });

for (const icon of ICONS) {
  await page.setContent(`<body style="margin:0;background:transparent">${iconSvg(icon)}</body>`);
  const file = path.join(iconsDir, `icon-${icon.size}.png`);
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  console.log(path.relative(root, file));
}

await page.setContent(`<body style="margin:0">${promoHtml}</body>`);
const promo = path.join(storeDir, 'promo-small-440x280.png');
await page.locator('#tile').screenshot({ path: promo });
console.log(path.relative(root, promo));

await browser.close();
