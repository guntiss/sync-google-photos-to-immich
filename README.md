# Sync Google Photos to Immich

A Chrome extension that keeps selected **Google Photos shared albums** in sync with
[Immich](https://immich.app), periodically and in the background, using the Google account
you are already signed in to in the browser.

Only the albums you pick are synced, not your whole library. Photos Immich already has are
detected by checksum and never imported twice. This works with libraries you seeded from a
Google Takeout export using [immich-go](https://github.com/simulot/immich-go): the extension
recognises those existing photos correctly and only uploads what's new (tested). Photos and
videos are both supported.

![Extension page: one album syncing in the background, one up to date, one with new photos](docs/screenshots/overview.png)

## Why not just Google Takeout?

Google Takeout doesn't export photos that other people added to a shared album, so a Takeout
import leaves those out of Immich. This extension syncs them too: it reads the album as
Google Photos shows it, including everyone's contributions, and copies whatever Immich is missing.

## Why an extension?

- **No server, no backend.** Nothing to host, deploy, secure or keep running. The extension
  talks directly from your browser to Google Photos and to your Immich server, and nowhere else.
- **Your signed-in session just works.** Google has no API for albums shared with an account
  (the Photos Library API doesn't expose them), and scraping from a server means handling
  logins, 2FA, cookies and bot checks. In the browser you are already logged in, so none of
  that exists.
- **Less overhead.** No OAuth app, no Google Cloud project, no cookie export, no container,
  no cron. Load it, paste two things, done.
- **Runs where you already are.** Sync happens in the background while Chrome is open, via
  `chrome.alarms`.

## Features

- Pick the albums to sync from the shared albums in your Google account, whether shared with
  you or by you. No links to copy; pasting a share link still works too.
- Deduplication by SHA-1 against your **entire** Immich library, before anything is downloaded.
- Copies are marked in Immich with the Google item they came from, so the extension in another
  browser, or after a reinstall, recognises them instead of copying them again.
- Includes photos other people added to a shared album, which Google Takeout doesn't export.
- Works alongside an [immich-go](https://github.com/simulot/immich-go) Google Takeout import:
  use Takeout for the bulk history, the extension for everything added afterwards.
- Copies missing items **oldest first**, three at a time, so an interrupted run leaves no gaps
  beyond the few files that were in flight.
- Mirrors each Google album into an Immich album with the same name (created if missing).
- Photos and videos; originals are downloaded, not thumbnails.
- Keeps locations. Google strips the GPS tags from most downloads, so the extension reads
  where each item was taken from Google Photos and sets it in Immich. A sync does this for the
  items it copies; **Sync locations** does it for everything already in Immich. Immich is
  asked first which items lack a location, so Google Photos is only asked about those. A
  location Immich already has is never replaced.
- Per-album progress: percentage in Immich, the files being copied, download progress,
  speed and time left. It works for background syncs too, and the toolbar icon shows the percentage.
- Stats: items in Immich, still to copy, failed, and files and bytes copied per sync and in total.
- **Check** compares an album with Immich without copying anything.
- **Stop** ends a running sync or check straight away, including a background one. The next
  sync continues where it stopped.
- Periodic background sync with a configurable interval. Manual and background runs never overlap.

## Screenshots

**Add albums**, listing the shared albums found in your Google account:

![Add albums dialog listing shared albums, some already added, two ticked](docs/screenshots/add-albums.png)

**Photos in an album**, each marked with whether it is already in Immich:

![Photos panel of an album with items marked In Immich or Not in Immich](docs/screenshots/photos.png)

**Settings**, where you connect Immich and choose how often to sync:

![Settings dialog](docs/screenshots/settings.png)

The screenshots show made-up albums and generated placeholder images. `npm run screenshots`
recreates them from the real extension page.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select
   the repository folder.
3. Make sure Chrome is signed in to the Google account that can see the albums.

## Use

1. Click the extension's toolbar icon to open its page. **Settings** opens on first use.
2. Enter your **Immich server URL** and an **API key**, and choose how often to sync
   automatically. Chrome asks for permission to reach your Immich server when you save,
   and the connection is tested straight away.
3. Click **Add albums**. It lists the shared albums in the Google account signed in to Chrome:
   albums shared with you and albums you share. Tick the ones you want and click **Add**. New
   albums are checked right away, so you see how much of each is already in Immich.
   Only shared albums can be synced, so to sync one of your own albums, share it in Google
   Photos first. For an album that isn't listed, use **Add by link instead** and paste its
   `https://photos.google.com/share/...` or `https://photos.app.goo.gl/...` link.
4. Click **Sync** on an album, or **Sync all**. After that the background sync takes over.

Each album card shows its percentage in Immich, what is happening now, and its stats.
**Photos** shows the album with each item marked *In Immich*, *Not in Immich*, *Copied* or
*Failed*. **Activity log** keeps the last 200 events.

While a sync or check runs, its **Sync** / **Check** buttons turn into **Stop**. Stopping
cancels the file being copied and skips the remaining albums. Files already copied stay in
Immich. If a sync is interrupted (Stop, Chrome closed, tab closed), the card says so, and the
next run continues where it stopped. Automatic sync still runs at its next scheduled time.

**API key permissions:** `asset.upload`, `asset.read`, `asset.update`, `album.create`,
`album.read`, `album.update` (or "All").

By default photos already in Immich are also added to the matching Immich album. Untick
*Also add photos already in Immich to the album* if you'd rather it never touches albums
for existing photos.

## How it works

1. **Find.** **Add albums** reads your album list the way the Google Photos *Albums* page does
   (rpc `Z5xsfc`, including shared albums you've joined). Shared albums come with a
   `photos.app.goo.gl` link, which is what gets stored.
2. **List.** The album page is fetched with your browser's cookies and the photo list is read
   from the data embedded in it; further pages come from Google's internal `batchexecute`
   endpoint (rpc `snAcKc`). Short links are opened through their desktop redirect (`?_imcp=1`),
   because they otherwise land on an interstitial page.
3. **Deduplicate.** For each photo Google supplies a `dedupKey`, which is the URL-safe base64
   SHA-1 of the original file. That is exactly what Immich stores as its asset `checksum`, so
   the keys are sent to `POST /assets/bulk-upload-check` and Immich says which it already has.
4. **Upload.** Only the missing originals are downloaded (`=d` for photos, `=dv` for videos),
   re-hashed, and uploaded with an `x-immich-checksum` header so Immich itself also refuses
   duplicates.
5. **Mirror.** Uploaded (and optionally existing) assets are added to an Immich album named
   after the Google album.

If Google answers a request with 429 (too many requests) or a 5xx error, the request is retried
up to five times, after the wait its `Retry-After` asks for or with exponential backoff. If
Google asks for more than a minute, the sync stops there and the next one continues.

Google's download often isn't byte for byte the file its `dedupKey` describes, and two
downloads of the same photo can differ, so the checksum can't be relied on to find earlier
copies. Two things cover that:

- A local ledger (`mediaKey → Immich asset id`) of everything this browser copied.
- Each copy's Immich asset metadata, under the key `google-photos`, records the Google item it
  came from (`{mediaKey, dedupKey}`). For items neither the checksum nor the ledger accounts
  for, the extension searches Immich for assets taken around the same time and reads their
  records, so copies made from another browser, or before a reinstall, are found without
  downloading anything. Copies made before this existed are marked on the next sync.

## Privacy and permissions

See [PRIVACY.md](PRIVACY.md) for the full privacy policy. In short:

- The extension contacts only `photos.google.com` / Google's image hosts and the Immich
  server you configure. There is no analytics and no third-party server.
- Your Immich URL and API key are stored in `chrome.storage.local` on your machine. It is
  not encrypted, so use a dedicated API key with only the permissions above.
- Host access to your Immich server is requested at runtime (optional permission), not
  granted broadly at install.

## Limitations

- **Unofficial.** Google Photos has no public API for this, so the extension reads the same
  undocumented data the web app uses. Google can change it at any time and break the extension.
- **Chrome must be running** and signed in to Google for background syncs to happen. Sync
  runs at most every 5 minutes.
- **Matching is by SHA-1.** Photos Google has re-encoded (not "original quality") won't match
  an Immich copy of the original byte for byte. Only copies the extension made are recognised
  by their record.
- One-way only: Google Photos → Immich. Nothing is ever changed or deleted in Google Photos,
  and nothing is deleted from Immich.

## Development

```sh
npm install
npm test                # unit tests (mocked fetch, fixtures modelled on real responses)
npm run screenshots     # README and Chrome Web Store screenshots, from made-up data
npm run icons           # icons/ and the store promo tile, from the SVG in scripts/icons.mjs
npm run package         # dist/*.zip for the Chrome Web Store, holding only the runtime files
```

[store/listing.md](store/listing.md) has the Chrome Web Store listing text, the permission
justifications and the privacy answers, ready to paste into the developer dashboard.

To drive the extension from scripts, launch a dedicated Chromium with the extension loaded and
the DevTools protocol on `:9222` (Chrome ≥ 137 ignores `--load-extension`, so this uses
Playwright's Chromium). Sign in to Google and save the Immich settings once in that window;
the profile is kept in `.debug-profile/`. The launcher loads a copy of the extension from
`.debug-ext/`, so restart it after changing the code. Restarting stops any sync running in it.

```sh
IMMICH_ORIGIN=https://immich.example.com npm run debug-browser
node scripts/probe.mjs <albumUrl> <view|check|sync> [screenshot.png]
```

Layout: `gphotos.js` (read albums, download originals), `immich.js` (Immich API client),
`sync.js` (orchestration), `state.js` (per-album progress/stats and the sync lock, shared through
`chrome.storage`), `background.js` (alarm-driven sync), `app.*` (the extension page).

## Disclaimer

Unofficial. Not affiliated with or endorsed by Google or Immich. Google Photos is a trademark of
Google LLC, and Immich is a trademark of its owner. Use at your own risk, and keep backups.
