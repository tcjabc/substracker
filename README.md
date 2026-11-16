# Peek Budget

A private, offline-first household income and expense tracker (it started as a subscription tracker). It's a Progressive Web App built with plain HTML, CSS and JavaScript: no framework, no build step, no backend.

- **Private:** all data lives in your browser's IndexedDB. Nothing is uploaded anywhere.
- **Offline:** a service worker caches the app shell, so the app opens and works with no connection.
- **Installable:** add it to the home screen on iOS and Android and it runs like a native app.

## Features

- **Money tab:** a summary strip shows Income, Outgoings and Left over, with a **Monthly | Annual** toggle. Monthly counts recurring items at their monthly equivalent (annual ÷ 12) plus one-offs dated this month. Annual counts monthly × 12, annual items, and one-offs dated this year. The strip uses the default currency only. Below it, income streams have their own section, followed by expenses grouped by category, shown as a card grid or compact list (toggle in the header). Tap any item to edit it, and delete it from the edit sheet after a confirmation. Two stacked floating buttons add items: the large **−** at the bottom adds an expense, the small green **+** above it adds income. The form has an **Expense | Income** toggle, so a wrong tap can be switched without losing what you typed; switching it while editing converts the item when you save.
- **Group colours:** each expense group gets a colour from a muted set of ten, shown as a dot beside its heading on the Money page. Tap the dot to pick another colour. New groups take the next unused colour; existing groups were assigned in A–Z order the first time. Income has no colour.
- **One-off items:** set the cycle to **Once** and pick a date instead of a renewal. They're tagged "One-off" and only count in the month and year of their date.
- **Insights tab:** step through months with the arrows. A headline shows "Outgoings X of Y income (Z%)" for the selected month. Below it are that month's total, the calendar-year total, a breakdown by category, and a ranking. The breakdown has a **Donut | List** toggle (remembered on the device, Donut by default). The donut uses the group colours with the month's total in the centre, and the legend below lists each category's amount and share, largest first. Tap a slice or legend row to highlight it, and tap again to clear. Categories under 3% are pooled into a neutral "Other" when there are two or more of them. One-offs count in the month of their date, and income is never part of the category views. If you use several currencies, a chip switches between them. Totals are never converted between currencies.
- **Logos:** an emoji typed into the item's **Emoji** field wins everywhere the logo appears (one emoji only, from the phone's emoji keyboard; clear it to go back). Otherwise logos are loaded from `https://www.google.com/s2/favicons?domain={domain}&sz=128`. When there's no domain, the request fails, or Google only has a generic icon, a coloured initial-letter avatar is shown instead. Logos you've already seen are cached for offline use.
- **Domain auto-suggest:** typing a known service fills in the domain and category. Known services: Netflix, Spotify, YouTube Premium, Disney+, iCloud, Google One, ChatGPT, Claude, Adobe, Microsoft 365, Nintendo, PlayStation, Xbox, Notion and Canva. Edit `js/services.js` to add more.
- **Renewal dates:** optional. Dates in the past roll forward by the billing cycle automatically, and renewals within 7 days are highlighted.
- **Settings:** default currency (picked from the device's language and region on first run, e.g. `zh-TW` → TWD or `en-GB` → GBP, falling back to TWD; installs that already had items before 1.2.1 keep TWD), light/dark/system appearance, JSON export, and JSON import. Import checks the whole file first and shows what it will do (for example "12 items, 3 new") before you choose **Merge** (adds new items; for an item already here, whichever copy was edited more recently wins) or **Replace all**. A file with a problem is rejected with a message naming it, and nothing changes.

## Data model

Each item (expense or income) is stored as:

```json
{
  "id": "uuid",
  "type": "expense",
  "name": "Example Streaming",
  "domain": "example.com",
  "emoji": "",
  "plan": "Family",
  "price": 250,
  "currency": "TWD",
  "cycle": "monthly",
  "nextRenewal": "2030-01-01",
  "date": "",
  "category": "Entertainment",
  "notes": "",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

- `type` is `"expense"` or `"income"`. Records without it (everything saved before 1.1.0) are expenses.
- `cycle` is `"monthly"`, `"annual"` or `"once"`. One-off items use `date` (YYYY-MM-DD) and leave `nextRenewal` empty. Recurring items leave `date` empty.
- Income uses the same shape. The name says where it comes from (e.g. "My salary"), and `domain`, `plan` and `category` stay empty.
- `emoji` is a single emoji (one grapheme, so flags and skin tones count) or empty. Records without it use the favicon or initial.
- `nextRenewal`, `date`, `category`, `plan`, `domain`, `emoji` and `notes` can be empty strings.

## Storage and backups

All persistence goes through `js/storage.js`; no other file touches IndexedDB or localStorage. The IndexedDB database `substracker` (version 3) has these stores:

- `records`: every expense and income item in a sync-ready form, keyed by `id`: `{ id, fields: { …item fields, del }, ts: { field: stamp } }`. Each field carries the hybrid-logical-clock stamp of its last change, and `del` is the deleted flag. Deleting an item sets `del` to `true` and keeps the record as a tombstone. The app only ever sees live records, in the plain item shape above.
- `outbox`: changes not yet sent to other devices, one op `{ id, rec, f, v, t, dev }` per changed field, keyed by `[rec, f]`, so a newer change to a field replaces its unsent older op. Every save, delete and import writes its ops in the same transaction as the records.
- `meta`: `schemaVersion` (currently 4), `deviceId` (made once per install), `hlc` (the clock), `syncCursor` (0 until sync exists) and records of the one-time migrations.
- `settings`: `defaultCurrency` and `groupColors`, one row per key. Settings are per device and never synced; backups carry these two so a restore brings them back.
- `items`: the 1.3–1.4 store, kept untouched as a fallback (see below).

The merge rules live in `js/sync-core.js`, a pure module with no DOM, storage or platform code, so web, Android and iOS merge identically. Each field is last-write-wins by stamp, ties go to the higher device id, and applying an op twice or in any order gives the same result. A delete only changes `del`, so an edit made elsewhere doesn't undo it; importing or saving the item again brings it back. A stamp from another device more than `MAX_DRIFT_MS` (24 hours) ahead of this device's clock can't pull the clock further than that, so one phone with the wrong date can't drag every device's clock into the future. The op still sorts by its own stamp, so all devices agree on the result.

Migrations run once and are verified before the app switches over. Versions up to 1.2 kept items in a store called `subscriptions`: on the first load of 1.3.0 they're copied into `items`, and the copy is checked (same count, every id present). The sync-ready step then copies `items` into `records`, stamping each item's fields with its own `updatedAt` and queueing an op per field, and checks the copy (one live record per item that reads back identical, a stamp and a matching op for every field). Until a check passes, the app keeps using the previous store and says so; an unfinished or unverified attempt is cleared and redone on the next load. The older stores are left untouched as fallbacks and will be removed in a later release. A few per-device view preferences (theme, tab, grid/list, period, donut/list) stay in localStorage.

The app asks the browser for persistent storage (`navigator.storage.persist()`), so the data isn't cleared under storage pressure where the browser supports that.

Export files have this shape:

```json
{
  "app": "substracker",
  "schemaVersion": 4,
  "exportedAt": "ISO timestamp",
  "items": [ … ],
  "settings": { "defaultCurrency": "TWD", "groupColors": { "Entertainment": "g1" } }
}
```

`items` holds the live (not deleted) items with their ids, in the plain item shape. `settings` holds only `defaultCurrency` and `groupColors` (an allowlist, `BACKUP_SETTINGS` in `js/storage.js`, so a setting added later stays out of backups until it's listed). Sync bookkeeping (device id, clock, cursor, outbox, field timestamps), entitlement flags and appearance preferences are never exported, and import ignores any other settings a file contains. `groupColors` maps a category name to a swatch key `g1`–`g10` (the `--group-1` … `--group-10` tokens in `css/app.css`); files without it import fine and get colours assigned automatically, and a file with no `settings` at all leaves yours as they are.

Import also reads every older backup: schemaVersion 3 files (1.3–1.4, the same envelope) and 1.0–1.2 files (`{ "format": "substracker", "version": 1 | 2, … }`, with records under `subscriptions` in version 1). It checks each item's required fields and their types: `id` (text), `name` (non-empty text), `price` (a number of 0 or more), `currency` (a 3-letter code), `cycle` (`monthly`, `annual` or `once`), `type` if present (`expense` or `income`), and `date` for one-offs. Unknown fields are ignored, so files from newer versions still import. Merge matches items by `id` and keeps whichever has the newer `updatedAt` (an item deleted here since the backup comes back); Replace deletes (tombstones) every item not in the file and takes the file's default currency and colours (Merge takes its colours only). Both write in one transaction, as ops, like any other change.

Saving the export file goes through `deliverFile()` in `js/files.js`, which is the place to swap the browser download for a native share sheet.

## Project structure

```
index.html            App shell and markup
manifest.json         PWA manifest (relative paths)
sw.js                 Service worker: precaches the shell, caches logos
css/app.css           All styles; design tokens live at the top in :root
js/app.js             UI, rendering, summary strip, form, insights, import/export screens
js/storage.js         The only persistence layer: IndexedDB, migrations, outbox, export/import checks, preferences
js/sync-core.js       Pure sync rules: hybrid logical clock, field ops, last-write-wins merge, tombstones
js/files.js           Hands a file to the person: share sheet in the native app, download on the web
js/platform.js        isNative() and plugin(): the only place that touches Capacitor
js/services.js        Known services → domain + category
js/logos.js           Favicon logos with initial-letter fallback
js/util.js            Formatting, cost maths (incl. one-offs by month/year), renewal dates
icons/                App icons (SVG favicon, PNG 192/512, maskable, Apple touch)
tests/storage.html    In-browser tests for js/storage.js (IndexedDB)
tests/*.node.test.js  Node tests for js/sync-core.js and the pure parts of js/storage.js

Native app only (the web version ignores these):
package.json          Capacitor 8 and plugins; npm scripts
capacitor.config.json App name, bundle ID, webDir (www)
scripts/copy-web.mjs  Copies the shipped web files into www/
assets/               Icon and splash sources
android/              Android project
```

## Run locally

Service workers need `http://localhost` or HTTPS, so opening `index.html` straight from disk won't work. Serve the folder with any static server, for example:

```sh
# Python 3
python -m http.server 8080

# or Node
npx serve .
```

Then open <http://localhost:8080>.

### Tests

`npm test` runs the Node tests (Node 22 or later, no install needed): clock ordering, skew and the drift cap, convergence of replicas that see the same ops in different orders, per-field merging, tombstones, idempotency, the items → records migration, importing old backups, and a check that every file in `js/` is in the service worker's `SHELL` list.

With the server running, open <http://localhost:8080/tests/storage.html> for the IndexedDB tests (migrations, the outbox and tombstones, an interrupted migration, export/import round trip, merge rules and bad-file rejection). They run against throwaway `substracker-test-*` databases, so the app's own data isn't touched.

Neither is part of the app: `tests/` isn't in the service worker's shell or in the native copy.

## Native builds

The same web files also ship as an Android app, **Peek Budget** (`com.tcjabc.peekbudget`), wrapped with [Capacitor](https://capacitorjs.com) 8. The web version doesn't need any of this: GitHub Pages still serves the files as they are.

You need Node.js 22 or later, the Android SDK with Platform 36 and Build-Tools 36, and **JDK 21**. The Gradle version Capacitor 8 uses (8.14.3) doesn't run on Java 25, which is what current Android Studio bundles, so point `JAVA_HOME` at a JDK 21 for the build. One way: in Android Studio, **Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK → Download JDK…**, version 21.

```sh
npm install
npm run sync:web      # copy index.html, manifest.json, sw.js, js/, css/, icons/ into www/, then cap sync
cd android
./gradlew assembleDebug   # on Windows: .\gradlew.bat assembleDebug
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Run `npm run sync:web` again after any change to the web files. `npm run assets` regenerates the icon and splash from `assets/`.

How the native app differs from the PWA:

- **Backups:** Export opens the share sheet (save to Files or Drive, or send it) instead of downloading.
- **No service worker:** the files are inside the app, so it works offline anyway, and updates come with app updates.
- **Separate data:** the app keeps its own storage, separate from the PWA. To move your items, export a backup in one and import it in the other.
- **Status bar:** the app draws behind the status bar, and its icons follow the app's light or dark appearance.

Release signing isn't set up. Keystores, `keystore.properties` and `local.properties` are ignored by git and must never be committed.

## Deploy to GitHub Pages

All paths are relative, so the app works from a project subpath such as `https://<user>.github.io/substracker/`.

1. Create an empty repository named `substracker` on GitHub.
2. Push this folder to it:
   ```sh
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git push -u origin main
   ```
3. On GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, then select the `main` branch and the `/ (root)` folder. Click **Save**.
5. Wait a minute or two, then open `https://<user>.github.io/substracker/`.

The empty `.nojekyll` file tells GitHub Pages to serve the files as they are, without running Jekyll.

### Publishing updates

The service worker serves the cached app shell first. When you change any file:

1. Bump `VERSION` in `sw.js` (for example `v1.0.0` → `v1.0.1`). Also bump `APP_VERSION` in `js/app.js` so the Settings footer shows the new version.
2. Commit and push.
3. The next time the app is opened online, it downloads the new version in the background and shows **"A new version is ready. Reload"**.

If you add a new file to the app shell, also add it to the `SHELL` list in `sw.js`.

## Install on a phone

- **iPhone / iPad (Safari):** open the site, tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap the **⋮** menu, then **Install app** (or use the **Install app** button in Settings).

## Backups

Your data exists only in the browser on that device. Clearing site data, or uninstalling the home-screen app on iOS, deletes it. Use **Settings → Export** regularly and keep the JSON file somewhere safe. To move data to another device, export on one and import on the other.

## Privacy note

The only network requests the app makes are for its own files and for favicon images from Google. A favicon request includes the domain you entered (for example `example.com`), but never your prices, plans or notes. Leave the domain blank if you'd rather not send it.

## License

MIT. See [LICENSE](LICENSE).
