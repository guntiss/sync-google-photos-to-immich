# Chrome Web Store submission

What to enter in the [developer dashboard](https://chrome.google.com/webstore/devconsole), and
where the images are. `npm run package` builds the zip to upload
(`dist/sync-google-photos-to-immich-<version>.zip`). `npm run icons` and `npm run screenshots`
recreate the images.

## Before the first upload

- Register as a developer: a one-time $5 fee, and 2-step verification on the Google account.
- Complete the trader / non-trader declaration (EU Digital Services Act). A free hobby project
  is normally *non-trader*. Traders have their address and contact details shown on the listing.
- Verify the contact email.

## Package

Upload `dist/sync-google-photos-to-immich-<version>.zip`. It contains only `manifest.json`, the
page and module files, and `icons/`. Bump `version` in `manifest.json` for every new upload.

## Store listing tab

**Name** (from the manifest): Sync Google Photos to Immich

**Summary** (from the manifest `description`, at most 132 characters):
Copy Google Photos shared albums to your Immich server in the background, using your signed-in
browser session. Unofficial.

**Description** (plain text, paste as is):

```text
Copies the Google Photos shared albums you choose to your own Immich server, and keeps them in sync in the background.

Unofficial. Not affiliated with or endorsed by Google or Immich.

HOW IT WORKS
• Pick albums from the shared albums in the Google account signed in to Chrome (shared with you or by you), or paste a share link.
• Each album is compared with your whole Immich library by checksum, and only what's missing is copied: original photos and videos, oldest first.
• Each Google album is mirrored into an Immich album with the same name.
• Background sync runs on the schedule you choose while Chrome is open. You can also Sync, Check or Stop by hand, and follow the progress of every album.

WHY AN EXTENSION
Google Photos has no API for albums shared with you. The extension uses the browser session you're already signed in with, so there's no server to run, no Google Cloud project, no OAuth app and no cookie export.

PRIVACY
• Talks only to Google Photos and the Immich server you configure. No developer server, no analytics, no tracking.
• Your Immich URL and API key stay in the extension's local storage.
• Access to your Immich server is requested when you save the settings, not at install.
• One-way: nothing is ever changed or deleted in Google Photos, and nothing is deleted from Immich.

WORKS WITH IMMICH-GO
If you imported a Google Takeout with immich-go, photos already in Immich are recognised and not copied again.

LIMITATIONS
• It reads the same undocumented data the Google Photos website uses, so a change at Google can break it until the extension is updated.
• Chrome must be running for background syncs.

Open source: https://github.com/guntiss/gphotos-immich-extension

Google Photos is a trademark of Google LLC. Immich is a trademark of its owner.
```

**Category:** Productivity › Tools. **Language:** English.

**Graphics:**

| Field | File |
| --- | --- |
| Store icon (128×128) | `icons/icon-128.png` |
| Screenshots (1280×800) | `store/screenshot-1-overview.png`, `store/screenshot-2-add-albums.png`, `store/screenshot-3-photos.png`, `store/screenshot-4-settings.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |

The screenshots show made-up albums and generated images, not real people's photos.

**Homepage URL:** https://github.com/guntiss/gphotos-immich-extension
**Support URL:** https://github.com/guntiss/sync-google-photos-to-immich/issues

## Privacy practices tab

**Single purpose:**
Copies the Google Photos shared albums the user picks to the user's own Immich photo server,
and keeps them in sync, using the Google account the user is already signed in to in Chrome.

**Permission justifications:**

- **storage**: Saves the user's Immich server URL and API key, the albums they added, sync
  progress and history, and a local list of items already copied, so that syncs can resume
  and nothing is copied twice.
- **alarms**: Runs the background sync on the interval the user picks in Settings (no more
  often than every 5 minutes).
- **Host permission `https://photos.google.com/*`**: Reads the user's shared albums with their
  signed-in session: the album list (only when the user opens "Add albums"), each added
  album's page, and Google Photos' own data endpoint for the rest of the album. These are the
  requests the Google Photos website makes itself. Nothing is changed in Google Photos.
- **Host permission `https://photos.app.goo.gl/*`**: Opens the short share links Google Photos
  gives shared albums, to find the album they point to.
- **Host permissions `https://*.googleusercontent.com/*` and `https://*.usercontent.google.com/*`**:
  Google Photos serves thumbnails and original files from these hosts (for example
  `photos.fife.usercontent.google.com`), and downloads can redirect between them. The extension
  downloads the originals of items missing from Immich and shows thumbnails in its Photos panel.
- **Optional host permissions `https://*/*` and `http://*/*`**: Immich is self-hosted, so every
  user's server is at a different address that isn't known in advance. Nothing is granted at
  install. When the user saves their Immich URL in Settings, the extension requests access to
  that one origin only (`chrome.permissions.request`). `http` is included because many Immich
  servers run on a home network without TLS.

**Remote code:** No, I am not using remote code. All code is in the package, with no `eval`
and no remote scripts.

**Data usage.** Tick these:

- **Website content**: photos and videos from the user's albums, album titles, and item
  metadata. They are sent only to the user's own Immich server.
- **Authentication information**: the Immich API key the user enters. It is stored locally and
  sent only to the user's Immich server.

Leave the other categories unticked. The signed-in Google account's email is shown on the page
but never stored or sent anywhere.

Tick all three certifications: no selling or transferring data to third parties outside the
approved use cases; no use unrelated to the single purpose; no creditworthiness or lending use.

**Privacy policy URL:**
https://github.com/guntiss/sync-google-photos-to-immich/blob/main/PRIVACY.md

## Test instructions

Reviewers need a Google account that can see a shared album, and an Immich server. Suggested
text (add a test server URL and API key if you can, so the reviewer can see a sync run):

```text
The extension needs an Immich server (https://immich.app, self-hosted). Test server: <URL>, API key: <key>.
1. Sign in to Chrome with any Google account that has at least one shared album in Google Photos (or open a shared album link once while signed in).
2. Click the toolbar icon. Settings opens: enter the Immich URL and API key, click "Save & test connection", and allow access to the server.
3. Click "+ Add albums", tick an album and click Add. The album is checked against Immich right away.
4. Click "Sync" on the album. Its photos appear in Immich, in an album with the same name.
Nothing is changed in Google Photos.
```

## Distribution tab

- **Visibility:** start with *Unlisted*. It gets the same review but isn't searchable, and
  you can switch it to *Public* later.
- **Regions:** all. **Price:** free.

## If it's rejected over the name

Google's branding guidelines don't allow a Google trademark as the extension's name. If the
review objects, rename it to something like "Shared Album Sync for Immich", and use "for
Google Photos™" in the summary and description.
