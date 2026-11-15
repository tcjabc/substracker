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
- **Logos (Pro):** an emoji in the item's **Emoji** field wins everywhere the logo appears (one emoji, picked from the built-in grid beside the field or typed with the phone's emoji keyboard; choose **None** to go back). Otherwise logos are loaded from `https://www.google.com/s2/favicons?domain={domain}&sz=128`. When there's no domain, the request fails, or Google only has a generic icon, a coloured initial-letter avatar is shown instead. Logos you've already seen are cached for offline use.
- **Domain auto-suggest:** typing a known service fills in the domain and category. Known services: Netflix, Spotify, YouTube Premium, Disney+, iCloud, Google One, ChatGPT, Claude, Adobe, Microsoft 365, Nintendo, PlayStation, Xbox, Notion and Canva. Edit `js/services.js` to add more.
- **Renewal dates:** optional. Dates in the past roll forward by the billing cycle automatically, and renewals within 7 days are highlighted.
- **Colour palettes (Pro):** Settings → **Colour palette** changes the accent colour (buttons, highlights, the selected tab). Indigo is the default; Ocean, Teal, Sunset, Berry, Plum and Graphite are Pro. Each works in light and dark and meets 4.5:1 contrast. The choice is remembered on the device, like the theme.
- **Settings:** default currency (picked from the device's language and region on first run, e.g. `zh-TW` → TWD or `en-GB` → GBP, falling back to TWD; installs that already had items before 1.2.1 keep TWD), light/dark/system appearance, colour palette, JSON export, and JSON import. Import checks the whole file first and shows what it will do (for example "12 items, 3 new") before you choose **Merge** (adds new items; for an item already here, whichever copy was edited more recently wins) or **Replace all**. A file with a problem is rejected with a message naming it, and nothing changes.

## Basic and Pro

Pro is cosmetic only. Everything functional is free, and data, totals, insights and export/import are never limited.

| | Basic | Pro |
|---|---|---|
| Items, totals, insights, export/import | ✓ | ✓ |
| Light, dark and system theme | ✓ | ✓ |
| Item icons | Coloured initial | Emoji, then website logo, then initial |
| Accent palette | Indigo | Indigo + six more |

- **Web (the PWA):** always Pro, everything unlocked.
- **Android app:** Basic. **Settings → Peek Budget Pro** lists what Pro adds. **Unlock Pro** and **Restore purchase** are placeholders: purchases aren't built yet (`TODO(purchase)` in `js/app.js` and `js/entitlements.js`).
- **In Basic:** items keep any emoji and domain they already have; they're only hidden, and come back with Pro. Logo images aren't requested at all. A Pro palette can be tried as a live preview but isn't saved.
- **The check:** `isPro()` in `js/entitlements.js` is the only place the app asks, so a store purchase can be added there later. Debug builds (`assembleDebug`) show a **Debug: unlock Pro** switch on the Pro screen; it sets a `debugPro` setting that release builds ignore and that backups never include (import ignores it too).

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

All persistence goes through `js/storage.js`; no other file touches IndexedDB or localStorage. The IndexedDB database `substracker` (version 2) has three stores:

- `items`: every expense and income record, keyed by `id`.
- `settings`: `defaultCurrency` and `groupColors`, one row per key. Debug builds may also hold `debugPro`, which stays on the device and is never exported.
- `meta`: `schemaVersion` (currently 3) and a record of the one-time migration.

Versions up to 1.2 kept items in a store called `subscriptions`. On the first load of 1.3.0 they're copied into `items`, and the copy is checked (same count, every id present) before it's marked done. If the check fails, the app keeps using the old store and says so. The old store is left untouched as a fallback and will be removed in a later release. A few per-device view preferences (theme, palette, tab, grid/list, period, donut/list) stay in localStorage.

The app asks the browser for persistent storage (`navigator.storage.persist()`), so the data isn't cleared under storage pressure where the browser supports that.

Export files have this shape:

```json
{
  "app": "substracker",
  "schemaVersion": 3,
  "exportedAt": "ISO timestamp",
  "items": [ … ],
  "settings": { "defaultCurrency": "TWD", "groupColors": { "Entertainment": "g1" } }
}
```

`groupColors` maps a category name to a swatch key `g1`–`g10` (the `--group-1` … `--group-10` tokens in `css/app.css`); files without it import fine and get colours assigned automatically.

Import also reads backups from 1.0–1.2 (`{ "format": "substracker", "version": 1 | 2, … }`, with records under `subscriptions` in version 1). It checks each item's required fields and their types: `id` (text), `name` (non-empty text), `price` (a number of 0 or more), `currency` (a 3-letter code), `cycle` (`monthly`, `annual` or `once`), `type` if present (`expense` or `income`), and `date` for one-offs. Unknown fields are ignored, so files from newer versions still import. Merge matches items by `id` and keeps whichever has the newer `updatedAt`; Replace deletes everything first and takes the file's settings. Both write in one transaction.

Saving the export file goes through `deliverFile()` in `js/files.js`, which is the place to swap the browser download for a native share sheet.

## Project structure

```
index.html            App shell and markup
manifest.json         PWA manifest (relative paths)
sw.js                 Service worker: precaches the shell, caches logos
css/app.css           All styles; design tokens live at the top in :root
js/app.js             UI, rendering, summary strip, form, insights, import/export screens
js/storage.js         The only persistence layer: IndexedDB, migration, export/import checks, preferences
js/files.js           Hands a file to the person: share sheet in the native app, download on the web
js/platform.js        isNative() and plugin(): the only place that touches Capacitor
js/entitlements.js    isPro(): the single Basic/Pro check (debug flag now, store purchase later)
js/palettes.js        The accent palette list; the colours live in css/app.css
js/services.js        Known services → domain + category
js/logos.js           Emoji, favicon logos (Pro) and initial-letter fallback
js/util.js            Formatting, cost maths (incl. one-offs by month/year), renewal dates
icons/                App icons (SVG favicon, PNG 192/512, maskable, Apple touch)
tests/storage.html    In-browser tests for js/storage.js

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

With the server running, open <http://localhost:8080/tests/storage.html>. It runs the storage tests (migration, export/import round trip, merge rules, bad-file rejection, and keeping the Pro debug flag out of backups) against throwaway `substracker-test-*` databases, so the app's own data isn't touched.

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
- **Basic and Pro:** the app starts in Basic; see [Basic and Pro](#basic-and-pro).

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

The only network requests the app makes are for its own files and for favicon images from Google (Pro only; Basic never requests them). A favicon request includes the domain you entered (for example `example.com`), but never your prices, plans or notes. Leave the domain blank if you'd rather not send it.

## License

MIT. See [LICENSE](LICENSE).
