# SubsTracker

A private, offline-first household income and expense tracker (it started as a subscription tracker). It's a Progressive Web App built with plain HTML, CSS and JavaScript: no framework, no build step, no backend.

- **Private:** all data lives in your browser's IndexedDB. Nothing is uploaded anywhere.
- **Offline:** a service worker caches the app shell, so the app opens and works with no connection.
- **Installable:** add it to the home screen on iOS and Android and it runs like a native app.

## Features

- **Money tab:** a summary strip shows Income, Outgoings and Left over, with a **Monthly | Annual** toggle. Monthly counts recurring items at their monthly equivalent (annual ÷ 12) plus one-offs dated this month. Annual counts monthly × 12, annual items, and one-offs dated this year. The strip uses the default currency only. Below it, income streams have their own section, followed by expenses grouped by category, shown as a card grid or compact list (toggle in the header). Tap any item to edit it, and delete it from the edit sheet after a confirmation. The floating **+** button adds an expense and **+ Income stream** adds income.
- **One-off items:** set the cycle to **Once** and pick a date instead of a renewal. They're tagged "One-off" and only count in the month and year of their date.
- **Insights tab:** step through months with the arrows. A headline shows "Outgoings X of Y income (Z%)" for the selected month. Below it are that month's total, the calendar-year total, a breakdown by category, and a ranking. One-offs count in the month of their date, and income is never part of the category views. If you use several currencies, a chip switches between them. Totals are never converted between currencies.
- **Logos:** loaded from `https://www.google.com/s2/favicons?domain={domain}&sz=128`. When there's no domain, the request fails, or Google only has a generic icon, a coloured initial-letter avatar is shown instead. Logos you've already seen are cached for offline use.
- **Domain auto-suggest:** typing a known service fills in the domain and category. Known services: Netflix, Spotify, YouTube Premium, Disney+, iCloud, Google One, ChatGPT, Claude, Adobe, Microsoft 365, Nintendo, PlayStation, Xbox, Notion and Canva. Edit `js/services.js` to add more.
- **Renewal dates:** optional. Dates in the past roll forward by the billing cycle automatically, and renewals within 7 days are highlighted.
- **Settings:** default currency (TWD out of the box), light/dark/system appearance, JSON export, and JSON import with **Merge** (adds new entries and updates ones with matching IDs) or **Replace all**.

## Data model

Each item (expense or income) is stored as:

```json
{
  "id": "uuid",
  "type": "expense",
  "name": "Netflix",
  "domain": "netflix.com",
  "plan": "Premium",
  "price": 390,
  "currency": "TWD",
  "cycle": "monthly",
  "nextRenewal": "2026-11-15",
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
- `nextRenewal`, `date`, `category`, `plan`, `domain` and `notes` can be empty strings.

The export file (version 2) has this shape: `{ "format": "substracker", "version": 2, "exportedAt": "…", "settings": { "defaultCurrency": "TWD" }, "items": [ … ] }`. Import accepts version 2 files, version 1 files (which list records under `subscriptions`), and a bare array of records. It refuses files from a newer version.

## Project structure

```
index.html            App shell and markup
manifest.json         PWA manifest (relative paths)
sw.js                 Service worker: precaches the shell, caches logos
css/app.css           All styles; design tokens live at the top in :root
js/app.js             UI, rendering, summary strip, form, insights, import/export
js/db.js              IndexedDB wrapper
js/services.js        Known services → domain + category
js/logos.js           Favicon logos with initial-letter fallback
js/util.js            Formatting, cost maths (incl. one-offs by month/year), renewal dates
icons/                App icons (SVG favicon, PNG 192/512, maskable, Apple touch)
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

The only network requests the app makes are for its own files and for favicon images from Google. A favicon request includes the domain you entered (for example `netflix.com`), but never your prices, plans or notes. Leave the domain blank if you'd rather not send it.
