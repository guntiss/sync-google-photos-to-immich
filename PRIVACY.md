# Privacy policy: Sync Google Photos to Immich

Last updated: 30 September 2026

Sync Google Photos to Immich ("the extension") copies Google Photos shared albums you choose
to the Immich server you configure. It has no server of its own. Your photos and settings go
only to Google and to your Immich server, and the developer never receives any of your data.

## What the extension accesses

- **Google Photos**, through the Google account signed in to your browser:
  - the list of albums in your account, read only when you open **Add albums**
  - the contents of the albums you add (item IDs, capture times, locations, checksums, thumbnails)
  - the original photo and video files of items your Immich server doesn't have yet

  It makes the same requests the Google Photos website makes. It never changes or deletes
  anything in Google Photos.
- **Your Immich server**, at the URL and with the API key you enter. The extension checks which
  items Immich already has, uploads the missing files, creates and updates albums named after
  the Google albums, sets the location of copied assets that have none (the one Google Photos
  shows for the item), and adds a small record to each copied asset's metadata (the Google item
  ID and checksum), so copies can be recognised later. It never deletes anything in Immich.

## What the extension stores

Everything is stored in the extension's local storage (`chrome.storage.local`), on your device
only:

- your Immich server URL and API key (not encrypted, so use a dedicated API key)
- the albums you added and their share links
- settings, sync progress and statistics, and an activity log of the last 200 events
- a list mapping Google Photos item IDs to Immich asset IDs, so nothing is copied twice

Removing the extension deletes all of this. Files are held in memory only while they are being
copied.

## Who your data is shared with

- **Google**, only through the requests needed to read your albums, as your browser would.
- **Your own Immich server**, which receives the photos and videos you choose to sync.

Nobody else. The extension has no analytics, no ads, no tracking, and no developer server. Your
data is not sold, not transferred to third parties, and not used for anything except syncing
your albums.

The extension's use of data complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Permissions

- **storage**: keeps the settings and sync state listed above.
- **alarms**: runs the background sync on the schedule you choose.
- **Google Photos hosts** (`photos.google.com`, `photos.app.goo.gl`, `*.googleusercontent.com`,
  `*.usercontent.google.com`): reads your albums and downloads their original files.
- **Your Immich server**: requested when you save the settings, and only for that one address.

## Contact

Questions or problems: open an issue at
<https://github.com/guntiss/sync-google-photos-to-immich/issues>.

Changes to this policy are published in this file, and its history is in the repository.
