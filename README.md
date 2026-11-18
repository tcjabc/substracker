# Peek Budget

A private, offline-first household income and expense tracker (it started as a subscription tracker). It's a Progressive Web App built with plain HTML, CSS and JavaScript: no framework, no build step, and no backend apart from an optional sync relay that only stores data it can't read.

- **Private:** your data is stored in your browser's IndexedDB. Optional sync between your devices (**Settings → Sync**, no account, 12 recovery words as the only key) is end-to-end encrypted, so the relay can't read it.
- **Offline:** a service worker caches the app shell, so the app opens and works with no connection.
- **Installable:** add it to the home screen on iOS and Android and it runs like a native app.

## Features

- **Money tab:** a summary strip shows Income, Outgoings and Left over, with a **Monthly | Annual** toggle. Both use the same cash basis as Insights. Monthly is this month: the income paid and the cash due in it (so it matches the Insights headline for this month), with an "Avg X/mo" line under Outgoings (the same Avg as Insights). Annual is this year from its twelve cash months (the same as the Insights yearly card). Items without a renewal or payment date are left out; one line, "Excludes N undated items", opens the first of them (undated plans first, then income). The strip uses the default currency only. Below it, income streams have their own section, followed by expenses grouped by category. A **Wallet | Grid | List** toggle in the header picks how (remembered on the device; Wallet unless Grid or List was chosen). See **Wallet** below. The **Sort** button beside it orders the groups: **A to Z** (the default, and the order the tab always had, Uncategorised last), **Total** (high to low) or **Items** (most first). Total uses the strip's cash basis and default currency: this month, or this year in Annual. A group whose items are all in other currencies has no total to compare, so those groups come after the rest, most items first. Ties go A to Z, and Income always stays first. The choice applies to Wallet, Grid and List. It's remembered on the device and never synced or put in a backup. The button shows the order in use (its label, and the accent colour when it isn't A to Z); the menu works with the arrow keys, Home, End, Enter and Escape, and Android Back closes it. Changing the order keeps an open Wallet card open and brings it to the front; with none open the stack goes back to the top. The strip's three figures and the Wallet card totals **roll** like an odometer, digit by digit: the first time they're shown, when one changes (from the old value), and again when the Money tab comes to the front or the app comes back (from the value shown before if it changed meanwhile, else from 0). A redraw with the same number doesn't roll. Only cards on or near the screen roll, ten figures at most at once across the app. Insights' single figures roll by the same rules (see **Insights tab**). The real text stays in place under the rolling digits, so nothing shifts and screen readers read the final value once; the Wallet card labels are unchanged. With **Reduce motion and effects** the number just changes. Tap any item to edit it, and delete it from the edit sheet after a confirmation. Two stacked floating buttons add items: the large **−** at the bottom adds an expense, the small green **+** above it adds income. The form has an **Expense | Income** toggle, so a wrong tap can be switched without losing what you typed; switching it while editing converts the item when you save.
- **Wallet:** the Money tab's default view. Each group is a card in a stack, like cards in a wallet: only its top band shows, with the group name, its number of items, its total and up to three logos ("+N" for the rest); the front card also shows a share bar and its two biggest items. Income comes first, on a neutral card, then the expense groups in the same order as the grid (the order **Sort** picks). Card totals are on the same cash basis as the summary strip: this month's cash due (paid, for Income), or this year's in **Annual**; items in other currencies are left out and counted as "+1 in USD", never converted or added; a group with nothing due says "Nothing due". The expense cards add up to the strip's Outgoings and the Income card is its Income. Drag or fling to move through the stack (it settles on a card's band; cards that pass the top tilt back into a small pile). Tap a card to open it to all its items while the others slide away; tap an item to edit it; tap the card again, press Escape or Android Back to close it. Each card is a button ("House, 1 item, NT$30,000 this month"); the arrow keys, Home and End move between cards, Enter opens one, and opening and closing are announced. Logos sit on small neutral tiles (white in light, dark grey in dark) so no brand colour meets the card colour; an item without a logo shows its letter on the same tile. Logos load only for cards on or near the screen. Each card's text colour is picked for it (the app's dark ink or white) and its depth (a top-lit gradient, a raised top edge, a short shadow on the card behind, a drop shadow under the front or open card, a faint sheen that shifts as cards move) is fitted so all text keeps at least 4.5:1 everywhere on the card. The stack draws only while it moves. With **Reduce motion and effects** it's a plain list on the page's own scroll, with no tilt or springs, and a card opens and closes at once.
- **Group colours:** each expense group gets a colour, shown as a dot beside its heading in Grid and List and as its card in the Wallet. Colours picked automatically come from a palette of fifteen chosen so neighbours never look alike (also for colour-blind viewers), in A to Z group order: up to fifteen groups get fifteen different colours, more groups cycle, and an automatic colour is never the same as the group next to it. **Sort** never changes a colour: colours follow the group, so a group looks the same in every order and in Insights. The neighbour guarantee holds for A to Z order only. Sorted by Total or Items, two groups next to each other can have similar colours (some palette pairs are close for colour-blind viewers, for example Blue and Violet), or the same colour past fifteen groups. The cards' raised top edge and the shadow between them still separate them. Tap the dot to pick another colour from the ten swatches; a colour someone picked is never changed by the automatic colours. Automatic colours stay on the device (never synced or put in a backup); a picked colour is shared with your other devices as before. Before 1.14.0 automatic colours came from the ten swatches; they move to the new palette on the first start of 1.14.0, and picked ones stay as they were. (Offering alternative palettes would need a palette-slot model for picked colours; that's not built.) Income has no colour.
- **One-off items:** set the cycle to **Once** and pick a date instead of a renewal. They're tagged "One-off" and only count in the month and year of their date.
- **Insights tab:** step through months with the arrows. The month figures are **cash due**: what falls due in that month. A monthly plan counts every month, an annual plan counts its full price in the month of its renewal date (every year), and a one-off counts in the month of its date. The app doesn't record what was paid, so past and future months are both projections from the plan dates. A headline shows "Outgoings X of Y income (Z%)" for the selected month, where Y is the income paid in that month by the same rules (monthly income every month, annual income in the month of its payment date, one-off income in its month). A month with no income shows no percentage and says why ("no TWD income paid in March 2027, so no percentage", or "no TWD income recorded" when there's none in that currency at all). Income and outgoings are compared, never added together. Below it are the month's total ("Cash due this month", with an "Avg X/mo" line: the calendar-year total ÷ 12), a yearly card for the viewed month's year with **Income**, **Outgoings** and **Left over**, each the sum of that year's twelve cash months (so undated items are left out, as in the month figures; "Excludes N undated items" says so when either notice is showing). A year that spends more than it takes in shows Left over with a minus sign, in the warning colour, with "More going out than coming in"; a year with no dated income says "No income dated in {year}" and shows no left-over figure. Then a breakdown by category, and a ranking, all on the same cash basis. The month's total and its Avg amount, the yearly card's Income, Outgoings and Left over, and the donut's centre total roll like the Money tab's figures: when Insights comes to the front, when the app comes back, when a figure changes (stepping to another month rolls old to new), never on a redraw with the same number, and only figures on screen. The headline sentence, per-category amounts, the legend, the Ring's caption and the year chart's readout stay plain text (the readout changes on every frame of a swipe). With **Reduce motion and effects** nothing rolls. Recurring plans without a renewal date can't be placed in a month, so they're left out of the month figures; a notice ("N plans need a renewal date, X not shown", X being their prices added up) opens the first one for editing. Income without a payment date gets its own notice ("N income items need a payment date, X not shown"), which works the same way. The breakdown has a **Ring | Donut | List** toggle (remembered on the device; Ring unless Donut or List was chosen). **Ring** is a tilted 3D ring of the same slices: drag or flick to spin it, tap a slice or legend row, or use the arrow keys, and it settles with a slice at the front. The front slice is raised (its neighbours partly; a very large slice holds its lift across most of its arc), the others are slightly dimmed, and the caption under the ring names it with its amount and share; the legend marks it, and it is announced to screen readers once the ring stops. Tiny slices are drawn at least 14° wide so they can be tapped; the text always shows the true amounts. It draws only while it moves. When **Reduce motion and effects** is on (Settings; per device, following the system setting until changed), WebGL isn't available, the 3D view loses its graphics context or can't load (offline before its first use), the flat donut stands in with a line saying why, and the arrow keys move its highlight. The donut uses the group colours with the month's total in the centre, and the legend below lists each category's amount and share, largest first. Tap a slice or legend row to highlight it, and tap again to clear. Categories under 3% are pooled into a neutral "Other" when there are two or more of them. One-offs count in the month of their date, and income is never part of the category views. If you use several currencies, a chip switches between them. Totals are never converted between currencies.
- **Insights → Year:** a **Month | Year** switch at the top of Insights (remembered on the device). Year shows the year chart: every month as a bar of the cash due in it, on an endless loop (December runs into January), with the current month in the middle. The centre month is the widest bar, outlined in the accent colour, with its label in an accent pill; the other months are muted (lower opacity with a veil of the card colour) and fade further towards the edges. No shadows or filters, so it stays cheap on older phones. The y-axis labels sit in a gutter left of the plot, where no bar can cover them. **This year** shows the calendar year, **Rolling ±6 months** (the default, remembered) the six months either side of the real current month with the year under each month. Swipe to move (it flings and settles on a month), use the arrow keys, or tap **Jump to now**. The readout above the chart names the centre month, its total and how it compares with the average of the months shown (the dashed line, "Average of these months" in the key); a small triangle marks months more than 10% above it. **By type** stacks monthly plans, annual renewals and one-offs; **By category** uses the group colours. The key (what each colour, line and mark means) is behind a small **Show key** toggle under the chart, remembered on the device; an opened month names its parts itself. **Show income** adds a line for the income paid each month and marks months where more goes out than comes in with a small diamond instead of the triangle. Tap a month (or press Enter) to open it: the other months shrink into a strip along the bottom and the month lists its types (with the plan names) or categories; swipe or tap the strip to move, tap the month again, press Escape or tap **All months** to go back. Undated items are left out, with one "Excludes N undated items" line, and the yearly card below shows this calendar year. The chart is one tab stop (a list of months with arrow keys); each month has a label such as "March 2027, NT$40,398" and the centre or opened month is announced. With **Reduce motion and effects** on (or, when it has never been set, the system's reduced-motion setting), it moves without inertia and settles almost at once.
- **Logos:** an emoji typed into the item's **Emoji** field wins everywhere the logo appears (one emoji only, from the phone's emoji keyboard; clear it to go back). Otherwise logos are loaded from `https://www.google.com/s2/favicons?domain={domain}&sz=128`. When there's no domain, the request fails, or Google only has a generic icon, a coloured initial-letter avatar is shown instead. Logos you've already seen are cached for offline use.
- **Domain auto-suggest:** typing a known service fills in the domain and category. Known services: Netflix, Spotify, YouTube Premium, Disney+, iCloud, Google One, ChatGPT, Claude, Adobe, Microsoft 365, Nintendo, PlayStation, Xbox, Notion and Canva. Edit `js/services.js` to add more.
- **Renewal and payment dates:** required for monthly and annual items when you add or edit one: "Next renewal" for an expense ("Pick a renewal date."), "Next payment" for income ("Pick a payment date."). Both are kept in the same `nextRenewal` field. One-offs, expense or income, have a "Date" instead. Plans saved before 1.9.0 and income saved before 1.9.1 without a date keep working and aren't filled in for you: they stay in their Insights notice until edited, and editing one asks for its date. Dated income on the Money tab says "Payment in 3 days" and so on, never "Renews". The stored date stays as entered; dates in the past roll forward by the billing cycle when shown, and renewals within 7 days are highlighted.
- **Settings:** default currency (picked from the device's language and region on first run, e.g. `zh-TW` → TWD or `en-GB` → GBP, falling back to TWD; installs that already had items before 1.2.1 keep TWD), language (Same as device, English or 繁體中文; see Languages), light/dark/system appearance, JSON export, and JSON import. **Export as CSV** is for spreadsheets, not a backup: **Download CSV** saves a file (name, amount, currency, cycle, next date, category and type for each live item, with a UTF-8 byte-order mark so spreadsheets read accented and CJK text), and **Copy CSV** puts the same text on the clipboard without the mark. Both escape cells that would run as formulas. If the clipboard is blocked, the CSV is shown selected below the row to copy by hand. Each says what it did ("Saved substracker-2026-11-18.csv", "Copied 41 items"), every time it's used. With sync set up, the default currency and any group colour you pick are shared with your other devices; appearance and the other preferences stay on each device. Import checks the whole file first and shows what it will do (for example "12 items, 3 new") before you choose **Merge** (adds new items; for an item already here, whichever copy was edited more recently wins) or **Replace all**. A file with a problem is rejected with a message naming it, and nothing changes.

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
- `cycle` is `"monthly"`, `"annual"` or `"once"`. One-off items use `date` (YYYY-MM-DD) and leave `nextRenewal` empty. Recurring items leave `date` empty; their `nextRenewal` is the next renewal for an expense and the next payment for income.
- Income uses the same shape. The name says where it comes from (e.g. "My salary"), and `domain`, `plan` and `category` stay empty.
- `emoji` is a single emoji (one grapheme, so flags and skin tones count) or empty. Records without it use the favicon or initial.
- `nextRenewal`, `date`, `category`, `plan`, `domain`, `emoji` and `notes` can be empty strings.

## Storage and backups

All persistence goes through `js/storage.js`; no other file touches IndexedDB or localStorage. The IndexedDB database `substracker` (version 3) has these stores:

- `records`: every expense and income item in a sync-ready form, keyed by `id`: `{ id, fields: { …item fields, del }, ts: { field: stamp } }`. Each field carries the hybrid-logical-clock stamp of its last change, and `del` is the deleted flag. Deleting an item sets `del` to `true` and keeps the record as a tombstone. The app only ever sees live records, in the plain item shape above. One reserved record, `settings`, holds the two shared settings (see below); it never has a `del` field, so it is never live and never appears as an item.
- `outbox`: changes not yet sent to other devices, one op `{ id, rec, f, v, t, dev }` per changed field, keyed by `[rec, f]`, so a newer change to a field replaces its unsent older op. Every save, delete and import writes its ops in the same transaction as the records.
- `meta`: `schemaVersion` (currently 4), `deviceId` (made once per install), `hlc` (the clock), `syncCursor` (the last relay entry applied), `syncConfig` (relay URL, household key, enabled), `lastSyncedAt` and records of the one-time migrations. None of it is exported or synced.
- `settings`: per-device settings, one row per key. `autoCurrency` and `autoGroupColors` are the values the app picked by itself (the locale currency, automatically assigned colours); they only fill gaps and are never synced. The `defaultCurrency` and `groupColors` rows from before shared settings are kept untouched as a fallback.

The default currency and group colours someone actually chooses are shared: they're stored as fields of the `settings` record, with the same ops, stamps and outbox as items. `defaultCurrency` is one field; each group's colour is its own field, `color_` plus a 64-bit hash of the group name (the value carries the name and the swatch), so colour changes to different groups on two devices both survive. For the same field the later change wins. A value the app picked by itself never becomes an op, so a device that never chose a currency can't override the household's, and it adopts the household's as soon as it arrives.
- `items`: the 1.3–1.4 store, kept untouched as a fallback (see below).

The merge rules live in `js/sync-core.js`, a pure module with no DOM, storage or platform code, so web, Android and iOS merge identically. Each field is last-write-wins by stamp, ties go to the higher device id, and applying an op twice or in any order gives the same result. A delete only changes `del`, so an edit made elsewhere doesn't undo it; importing or saving the item again brings it back. A stamp from another device more than `MAX_DRIFT_MS` (24 hours) ahead of this device's clock can't pull the clock further than that, so one phone with the wrong date can't drag every device's clock into the future. The op still sorts by its own stamp, so all devices agree on the result.

Migrations run once and are verified before the app switches over. Versions up to 1.2 kept items in a store called `subscriptions`: on the first load of 1.3.0 they're copied into `items`, and the copy is checked (same count, every id present). The sync-ready step then copies `items` into `records`, stamping each item's fields with its own `updatedAt` and queueing an op per field, and checks the copy (one live record per item that reads back identical, a stamp and a matching op for every field). The shared-settings step then copies the stored `defaultCurrency` and `groupColors` into the `settings` record once, stamped at the time of the upgrade and queued to sync, skipping any field the household already set, and checks that every one arrived; until then settings stay per device as before. Until a check passes, the app keeps using the previous store and says so; an unfinished or unverified attempt is cleared and redone on the next load. The older stores are left untouched as fallbacks and will be removed in a later release. A few per-device view preferences (theme, reduce motion and effects, tab, wallet/grid/list, period, ring/donut/list, the year chart's key) stay in localStorage; they are never synced or exported.

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

`items` holds the live (not deleted) items with their ids, in the plain item shape. `settings` holds only `defaultCurrency` and `groupColors` (an allowlist, `BACKUP_SETTINGS` in `js/storage.js`, so a setting added later stays out of backups until it's listed). Sync bookkeeping (device id, clock, cursor, outbox, field timestamps), entitlement flags and appearance preferences are never exported, and import ignores any other settings a file contains. `groupColors` maps a category name to a swatch key `g1`–`g10` (the `--group-1` … `--group-10` tokens in `css/app.css`); files without it import fine and get colours assigned automatically, and a file with no `settings` at all leaves yours as they are. Import restores the two settings as changes like any other, so they sync: **Merge** applies the file's colours for the groups it names, **Replace all** takes the file's colours (clearing others) and its default currency.

Import also reads every older backup: schemaVersion 3 files (1.3–1.4, the same envelope) and 1.0–1.2 files (`{ "format": "substracker", "version": 1 | 2, … }`, with records under `subscriptions` in version 1). It checks each item's required fields and their types: `id` (text), `name` (non-empty text), `price` (a number of 0 or more), `currency` (a 3-letter code), `cycle` (`monthly`, `annual` or `once`), `type` if present (`expense` or `income`), and `date` for one-offs. Unknown fields are ignored, so files from newer versions still import. Merge matches items by `id` and keeps whichever has the newer `updatedAt` (an item deleted here since the backup comes back); Replace deletes (tombstones) every item not in the file and takes the file's default currency and colours (Merge takes its colours only). Both write in one transaction, as ops, like any other change.

Saving the export file goes through `deliverFile()` in `js/files.js`, which is the place to swap the browser download for a native share sheet.

## Sync between devices

Devices in one household can sync through a small relay (`relay/`, a Cloudflare Worker; see `relay/README.md`). It's optional and end-to-end encrypted, and there are no accounts. Your data stays stored on each device.

### Setting it up

**Settings → Sync** opens the Sync sheet.

- **Start sync** creates a household. Before sync turns on, a required step shows the **12 recovery words** (numbered, with **Copy words** and the same words as a QR code). **Start sync** stays disabled until **I've saved these words** is ticked. Then the device claims the household's room on the relay and sends its items. A device that was in a household before gets a warning first: its other devices stay on the old household.
- **Join with 12 words** adds a device. The words can be typed in any case, with any spacing or line breaks, and the old 22-character key still works. Mistakes are named: the wrong number of words, "word N isn't in the list" (with the closest match), or "a word is wrong or out of order" (the checksum). The device then checks the relay. Words with no household get "No household found for these words", and joining never creates a room.
  - An empty device just joins.
  - A device that already has items asks first. **Use the household's data** (the default) replaces this device's items and shared settings with the household's, after one more confirmation. **Export a backup first** is right there. Everything is pulled before anything is written, and the swap of records, outbox, cursor and config is one IndexedDB transaction, so a failed pull or write leaves the device exactly as it was. **Merge this device's data into the household** sends this device's items too. Where an item was edited in both places, the later edit wins.
- Once set up, the sheet shows the status (Up to date, Syncing, Offline or the error), the last sync and the changes waiting to send. **Show recovery words** asks before showing them. It also has **Sync now** and **Turn off sync on this device**, which stops syncing and forgets the words but keeps every item and setting. Closing the sheet or hiding the words removes them from the page.

### Recovery words

The household key is 16 random bytes (`generateKey()` in `js/crypto.js`), stored on the device as 22 characters of base64url. The 12 words (`js/words.js`) are another way of writing the same 16 bytes: BIP-39 English (`js/wordlist.js`, the standard 2048-word list), 128 bits of key plus a 4-bit SHA-256 checksum, 11 bits per word. So a device paired before 1.7 shows its current household's words, and nothing needs pairing again. Anyone with the words can read the household's data. If you lose every device and the words, the synced copy can't be recovered.

### How it works

1. **Keys** (`js/crypto.js`, Web Crypto only). HKDF-SHA256 derives three values from the household key: a room id (128 bits) and a token (256 bits) for the relay, and an AES-GCM-256 key. The relay never sees the household key or the AES key, and can't work back to them.
2. **Envelopes.** Each op (one field change, from the outbox) is sealed as `{ id, wall, c }`. `c` is base64 of a random 12-byte IV plus the ciphertext of the op, padded to 64-byte steps. The op id and the wall-clock part of its stamp are bound as additional authenticated data. A device opening an envelope also checks that the op inside has the same id and the same wall time. Anything that fails is dropped and counted, never applied.
3. **Push.** `js/sync.js` seals the outbox oldest first (at most 200 ops or about 512 KB per request) and POSTs it to the room. The relay stores envelopes in an append-only log with a sequence number. It ignores ids it already has and refuses envelopes stamped more than 24 hours ahead. An op leaves the outbox only if it's still the pending op for its field, because a newer edit made during the push must still go out. Starting a household pushes an empty batch first, which claims the room so other devices can join before anything is added.
4. **Pull.** The device fetches entries after its `syncCursor`, 500 at a time, until it reaches the head. Each page is applied in one transaction: stamps are folded into the clock, ops are merged field by field (last write wins), and the cursor moves. That transaction doesn't include the outbox, so pulled changes are never sent back. Applying is idempotent and order-independent.
5. **When.** Sync runs about 1 s after a local change, on start, when the app becomes visible, when the device comes back online, and every 60 s while visible. While visible, a WebSocket also stays open. The relay only uses it to say "there's something new", and the device then pulls. Only one sync runs at a time, and requests are coalesced. Failures retry with exponential backoff and jitter (2 s up to 5 min). A 401 waits for **Sync now** or a config change. Local saves never wait for sync.
6. **Switching, losing data.** Merging (or setting a different key on the developer screen) resets the cursor and queues every record again, so the household receives this device's items and the settings chosen on it. A relay that has fewer entries than a device has already seen, or has no room at all, gets everything again too.

The relay URL is one constant, `DEFAULT_RELAY_URL` in `js/sync.js`. There's no field for it in the app. The hidden **developer screen** (add `?dev=1` to the URL, or tap the version line at the bottom of Settings 7 times) can override it for testing. It can also set a raw key, enable or disable sync, and disconnect, and it shows where the key is kept. It never fills the key into the page: **Show key** fetches it on demand, and an empty key field on **Save** keeps the stored key. A relay URL must be `https://`, except `http://localhost` / `127.0.0.1` for development.

### Where the household key is kept

Everything that reads or writes the key goes through `js/secure-key.js` (`get`, `set`, `remove`, and `kind`). That covers the sync engine, the Sync sheet, the developer screen, Start, Join and Turn off. The key never appears in exports, logs or the page, except while **Show recovery words** (or the developer screen's **Show key**) is open.

- **Phones (`native-secure`):** the Android Keystore or iOS Keychain, through [`@aparajita/capacitor-secure-storage`](https://github.com/aparajita/capacitor-secure-storage). On Android the plugin encrypts the key with AES-GCM using a key that lives in the Android Keystore. It stores the ciphertext in `shared_prefs/WSSecureStorageSharedPreferences.xml`. On iOS the key goes in the Keychain as `whenUnlockedThisDeviceOnly`, never synced to iCloud. The IndexedDB sync config then holds only `keyLocation: 'secure'` and `keyTag`, a random id with no relation to the key that says which household the rest of the config belongs to.
- **Web (`web-indexeddb`):** a browser has no real secure store, so the key stays in the IndexedDB sync config, exactly as before. Anyone who can read this browser profile's site data can read the key.

**Moving the key on phones (once).** On each launch, a key still in IndexedDB is written to secure storage, read back and compared. Only then is it removed from IndexedDB, in the same write that records `keyLocation: 'secure'`. If any step fails, the IndexedDB copy stays and sync works as before, and the next launch tries again. The key is never in neither place, and the household doesn't need pairing again. If writing a new key to secure storage fails (Start or Join), it's kept in IndexedDB and moved later. If the config write after it fails, the secure slot gets its previous value back. If removing the key at **Turn off** fails, the leftover is removed on the next launch.

**A key that can't be read.** If the config says the key is in secure storage but it can't be read, sync shows "Sync needs the 12 words on this device. Join again with your recovery words." This happens when app data is restored from a backup onto a new phone, where the Keystore entry doesn't exist. There are no retries, nothing is deleted, the items stay, and **Join with 12 words** works as usual.

**Android backups.** `allowBackup` is still on, so items and settings are backed up as before. Two rule files leave out the one secure-storage file: `res/xml/backup_rules.xml` (`android:fullBackupContent`, Android 11 and earlier) and `res/xml/data_extraction_rules.xml` (`android:dataExtractionRules`, Android 12 and later, cloud backup and device transfer). Its Keystore key can't leave the phone anyway, so a copy would be useless elsewhere. The IndexedDB data (items, and the sync config without the key once it has moved) is still backed up. A key that is still in IndexedDB is backed up with it until it moves on the next launch. IndexedDB's files may also keep a deleted value until the WebView compacts them.

### Scanning the QR code

**Join with 12 words** has a **Scan QR code** button above the words box. It only appears where scanning is possible. The QR code (under **Show recovery words** on another device) holds the 12 words as plain text. A scan fills the box and runs the same checks as typing, and you still tap **Join**. A code that isn't 12 recovery words with a valid checksum shows "That QR code isn't a Peek Budget recovery code." and fills nothing. If the camera is blocked or missing, a message says so, and typing still works.

- **Android:** [`@capacitor-mlkit/barcode-scanning`](https://github.com/capawesome-team/capacitor-mlkit)'s `scan()`, which opens the Google code scanner from Google Play services. The scanner runs outside the app, so the app has no `CAMERA` permission. The first time, the scanner module may need to be downloaded: the app checks `isGoogleBarcodeScannerModuleAvailable`, installs it if needed and says "Getting the scanner ready…". Phones without Google Play services get "Scanning needs Google Play services. Type the words instead."
- **Web and desktop:** `getUserMedia` (rear camera when there is one) and [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0, vendored as `js/jsqr.js` with its licence in `js/jsqr.LICENSE.txt`). It doesn't depend on `BarcodeDetector`, which Chrome on Windows lacks. Frames are decoded in a canvas that is never added to the page. No frames, images or results leave the device. Every camera track stops as soon as a code is read, **Stop scanning** is tapped, the view changes, the sheet closes or the page is hidden.

To try it locally: run the relay (`cd relay`, `npm install`, `npx wrangler dev`) and open the app on two different localhost ports (each port has its own storage). On each one, open the developer screen and set the relay URL to `http://localhost:8787`, so nothing goes to the real relay. Then use **Settings → Sync**: **Start sync** on one, **Join with 12 words** on the other.

### Roadmap

- A list of the household's devices (and removing one). This needs relay support. For now the sheet only says how to add a device.
- iOS: adding the iOS project (see the iOS notes under Native builds).

## Languages

Every word the app shows comes from a dictionary: `js/locales/en.js` (English, bundled) through `t(key, params)` in `js/i18n.js`. Keys are namespaced by screen (`wallet.band`, `sync.join.noHousehold`), `{placeholders}` are filled in, and plural forms are `key.one` / `key.other` (and whatever forms a language has; Chinese has only `.other`), chosen with `Intl.PluralRules`. Whole sentences are keys, so a translation can put the words in its own order. A key another locale lacks falls back to English with a console warning; a key missing everywhere shows nothing (and is caught by the tests), never the key itself. `index.html` keeps its English text and marks each piece with `data-i18n`, `data-i18n-attr` (labels, titles, placeholders), `data-i18n-html` (the two install lines) or `data-i18n-native` (the app's wording where the web's mentions the browser).

Two languages exist: **English** and **Traditional Chinese** (`zh-TW`, Taiwan usage, since 1.17.0). English reads exactly as it did in 1.15.0. The language is a per-device choice, like the theme: **Settings → Language** offers Same as device, English and 繁體中文, each language named in its own language. The choice is `substracker.lang` in localStorage (no entry means Same as device). It's never synced or put in a backup, and changing it reloads the app. `document.documentElement.lang` follows the language in use (`zh-TW`, so Traditional glyphs are used).

**Same as device** takes the first of the device's languages that has a locale: exactly, else the same language and script (zh-Hant, zh-HK and zh-MO get zh-TW), else the same language in another script. So for now Simplified Chinese (zh-CN, zh-SG) also gets zh-TW, until a Simplified locale exists. Anything else falls back to English.

Numbers, money and dates keep the device's own conventions (en-GB "18 Nov", en-US "Nov 18") when the app is in the device's language, any variant of it. So a zh-CN or zh-HK phone in zh-TW still formats its own way (Taiwan dollars as NT$30,000). When someone picks a language other than the device's, numbers and dates follow that language: zh-TW on an English phone writes `$30,000` for Taiwan dollars (CLDR's standard in Taiwan, with US$, HK$ and so on for the others) and "2026年11月". The formatters (`money()`, `moneyParts()`, the dates, the year chart's axis, the rolling totals) all take the same formatting locale, so a rolling total always ends on exactly the formatted text. `relativeDays()` in `js/i18n.js` ("Today", "Tomorrow", "In 3 days"; "今天", "明天", "3 天後") is ready for the upcoming-payments banner; nothing uses it yet.

Sort's A to Z ("依名稱" in Chinese) orders group names the language's way: the device's order in English, as before, and Zhuyin (ㄅㄆㄇㄈ, Taiwan's standard order, `Intl.Collator('zh-TW-u-co-zhuyin')`) in zh-TW, with Latin names after Chinese ones. A locale's collation is the `collation` field of its `LOCALES` entry. Item names keep the device's order. Automatic group colours follow the group order, so switching language can re-pick some automatic colours so neighbours stay different. Colours someone chose never change.

Chinese typography lives in the shared styles under `:root:lang(zh-TW)`: the Traditional Chinese UI font after the Latin UI fonts (Noto Sans CJK TC, PingFang TC, Microsoft JhengHei), more line height for running text, and no all-caps tracking. Short lines of facts joined with " · " break at spaces rather than inside a word or a date, and `<em>` stays upright.

### Adding a language

1. Write a glossary first, as `docs/glossary-<tag>.md` (see `docs/glossary-zh-TW.md`): the app's core vocabulary (item, group, category, income, expense, cash due, renewal, Wallet, Insights, Sync, household, recovery words, backup, export, import, replace, merge…) and the conventions (punctuation, spacing, what stays in Latin script). Have a native speaker review it, then use it everywhere.
2. Copy `js/locales/en.js` to `js/locales/<tag>.js` and translate the values. Keep every key and `{placeholder}`, the tags in `…Html` keys, and the JSON names and values in straight double quotes in the import messages: the AI and the app read them. Plural groups get exactly the forms `Intl.PluralRules(<tag>)` has (Chinese: only `.other`; Arabic: six). A separator that is a space in English (`common.sentenceSep`) may be empty. Write invisible characters, such as a no-break space, as ` ` escapes.
3. Keep the `// legal check` marker on the same keys. These keys are legal or privacy wording, and each translation of them needs a professional legal review for that language before it ships. So do the safety-critical confirmations (`form.delete.message`, `import.replace.message`, `sync.turnOff.message`, `sync.replace.message`, the `sync.choice.*.hint` keys).
4. Add one line to `LOCALES` in `js/i18n.js` (its own name, its loader and, if the language sorts differently, a `collation`) and the file to `SHELL` in `sw.js`. Locales other than English load on first use and are precached, so they work offline. If `auto` should map more device languages to it, `resolveLocale()` is the place.
5. If the script needs it, add its typography to the shared styles under `:root:lang(<tag>)`: tokens first (`--font`, `--leading`, `--tracking-caps`), never per screen.
6. `npm test` checks the file has the same keys, the language's own plural forms, the same placeholders and tags, and the legal-check markers. Add a mode for it in `tests/i18n.test.js` (copy `zh`), with the person's data in that language and the Latin words it keeps on purpose. `tests/i18n.html` then walks every key screen at 360, 393 and 320px for raw keys, leftover English and text that runs out of its box.

Never translated: the person's data (item, group and category names, the preset names in `js/services.js`), the 12 recovery words (the BIP-39 English list), the Import with AI prompt and its JSON, CSV column headers and values, backup and sync formats, and currency codes. "Uncategorised" and "Income" stay the stored group keys (group colours are keyed by them); only their labels change. The hidden developer sync screen stays English. Messages written by the relay itself are shown as the relay sends them.

`?lang=xx` in the address shows the pseudo-locale (for development; never saved or offered): every string bracketed, accented and about 30% longer, so text that isn't in the dictionary yet stands out unbracketed and layouts that don't stretch show it. `tests/i18n.html` walks the main screens in it at 360px.

## Project structure

```
index.html            App shell and markup
manifest.json         PWA manifest (relative paths)
sw.js                 Service worker: precaches the shell, caches logos
css/app.css           All styles; design tokens live at the top in :root
js/app.js             UI, rendering, summary strip, form, insights, import/export screens
js/storage.js         The only persistence layer: IndexedDB, migrations, outbox, export/import checks, preferences
js/sync-core.js       Pure sync rules: hybrid logical clock, field ops, last-write-wins merge, tombstones
js/crypto.js          Household key, HKDF derivation, sealing and opening op envelopes (Web Crypto)
js/sync.js            Sync engine: push/pull with the relay, triggers, backoff, status
js/words.js           The household key as 12 recovery words (BIP-39) and back, with typing errors
js/wordlist.js        The standard BIP-39 English wordlist (vendored)
js/pairing.js         Start/join/turn-off decisions and wording, no DOM
js/sync-sheet.js      Settings → Sync: start, recovery words, join, status, turn off
js/qrcode.js          QR code generator (qrcode-generator 1.4.4, MIT, vendored)
js/sync-ui.js         The hidden developer sync screen in Settings
js/secure-key.js      Where the household key lives: phone secure storage or IndexedDB, and the one-time move
js/qr-scan.js         Scanning the recovery-words QR code: the phone scanner, or the camera and jsQR on the web
js/jsqr.js            QR code decoder (jsQR 1.4.0, Apache-2.0, vendored; licence in js/jsqr.LICENSE.txt)
relay/                The sync relay (Cloudflare Worker + Durable Object); not part of the web app
js/files.js           Hands a file to the person: share sheet in the native app, download on the web
js/platform.js        isNative() and plugin(): the only place that touches Capacitor
js/overlays.js        The open overlays (sheets, dialogs, steps, popovers, chart focus) and what Android Back does (pure)
js/services.js        Known services → domain + category
js/logos.js           Favicon logos with initial-letter fallback
js/util.js            Formatting, cost maths (incl. one-offs by month/year), renewal dates
js/i18n.js            Languages: t(), plural forms, the language setting, the formatting locale, the pseudo-locale
js/locales/en.js      Every word the app shows, in English (the dictionary other locales copy)
js/locales/zh-TW.js   The same in Traditional Chinese (Taiwan); loaded on first use
docs/glossary-zh-TW.md English → zh-TW terms and conventions, for translators and reviewers
js/insights-calc.js   Insights on a cash basis: cash due per month, breakdowns, Avg, undated plans (pure)
js/year-chart-math.js The year chart's maths: the loop, taper, springs, y scale, months shown (pure)
js/year-chart.js      The Insights year chart (SVG, no libraries): drawing, swipe, focus, keyboard
js/donut-math.js      The Insights Ring's maths: slice angles (14° minimum), lift weights, dimming, spin physics (pure)
js/donut-flat.js      The flat Insights donut and legend (SVG), also the Ring's fallback
js/donut-3d.js        The Insights Ring (3D, WebGL); loaded only when shown
js/three.module.min.js three.js r170 (MIT, vendored; licence in js/three.LICENSE.txt); cached on first use, not precached
icons/                App icons (SVG favicon, PNG 192/512, maskable, Apple touch)
tests/storage.html    In-browser tests for js/storage.js (IndexedDB)
tests/app.html        In-browser tests for the app screens: the Insights month view, the notices, the form
tests/i18n.html       In-browser language tests: English against the 1.15.0 recording, the pseudo-locale, and zh-TW at three widths
tests/*.node.test.js  Node tests: sync core, crypto, recovery words, join choices, the sync engine (with an in-memory relay), the pure parts of js/storage.js

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

`npm test` runs the Node tests (Node 22 or later, no install needed): clock ordering, skew and the drift cap, convergence of replicas that see the same ops in different orders, per-field merging, tombstones, idempotency, the items → records migration, importing old backups, a check that every file in `js/` is in the service worker's `SHELL` list (except three.js, which is cached on first use; the test checks that short, explained list against `sw.js`) and that vendored libraries ship with their licences, the Insights Ring's maths (slice angles and the 14° minimum from real month data, the front slice fully raised, the big-slice plateau, no jump in any slice's lift between frames at 3 rad/s, dimming toward the card colour, fling and snap, taps, the Reduce motion and effects rule, and the Ring | Donut | List default), the Insights cash maths (a hand-worked example across several months with monthly, annual and one-off items, including an annual plan whose date has rolled forward, the breakdowns, the Avg figure and undated plans; a second one for income: a monthly salary, an annual bonus, a one-off, undated income; and the year summary: income, outgoings, left over and the months that go over, for both examples together, a year with no income, and a year with annual and one-off items; and the Money tab strip, monthly and annual, with bonus and renewal months, undated items, and the old figures for comparison), and the year chart's maths (the loop wrap and seam, the taper's widths and positions, snapping, springs and fling, the nice y-axis maximum, the rolling range anchored on the real current month, and per-month data agreeing with the calculation layer), encryption (round trip, tampering, wrong key, mismatched authenticated data), the relay's room logic, the shared settings record (convergence, an unset device adopting the household currency, per-group colour merging, upgrade seeding), the recovery words (the BIP-39 reference vectors, round trips, typos, swapped words, wrong counts, the old key), the join choices, where the key is kept (set/get/remove, the move to secure storage with a failed read-back, the flag, an unreadable key, Turn off removing it everywhere, every combination of failures leaving the key somewhere), QR scanning (reading the words from scanned text, a round trip from our QR generator to jsQR, the camera tracks stopping, the phone scanner flow), the overlay stack behind Android Back (open and close order, closing twice, close-all, an overlay that refuses while busy, stale and out-of-sight entries, and Back at each level), and the sync engine. The engine tests run three simulated devices through an in-memory relay built on the relay's own logic, with offline periods, failures and retries, plus starting and joining a household: unknown words, an empty device, replace, merge, and replace staying all-or-nothing when a pull or the write fails. Also the Money tab's Sort (each order, ties, groups with only other-currency items, empty groups, Monthly against Annual totals, Income first, the input left alone), the rolling totals' plan (it ends exactly on the formatter's text, starts on the old value's digits, keeps the final layout, steps in range, separators fading only beside blank columns, other numbering systems) and when a total rolls, and Copy CSV being the downloaded file without its byte-order mark, escaping included. The language tests cover `t()`'s placeholders and plural forms, the English fallback with its warning and never a raw key, choosing the locale from the setting and the device's languages, the formatting locale (the device's conventions unless another language was picked), money and rolling totals ending on the formatted text in other locales, `relativeDays()`, the pseudo-locale, and the keys: every key the source uses is in `en.js`, every English key is used, plural groups are complete, and every other locale file has the same keys, plural forms and placeholders (the check is also tested on made-up dictionaries: a missing or extra key, a changed placeholder, a `.one` in Chinese). For zh-TW: every key, in Chinese apart from an explained list of names and codes, the legal-check markers on the same keys as English, the quoted JSON names in the import messages, choosing it from the device's languages (zh-TW, zh-Hant, zh-HK, zh-MO, and zh-CN and other Simplified Chinese for now; not Japanese), its formats (Taiwan dollars, dates, relative days) and the Zhuyin group order.

With the server running, open <http://localhost:8080/tests/storage.html> for the IndexedDB tests (migrations including the shared-settings seeding, the outbox and tombstones, an interrupted migration, export/import round trip, merge rules and bad-file rejection, and joining a household with the real engine over an in-page relay: an empty device, replace, merge, a failed pull or write leaving the data untouched, turning off keeping the data, and a key saved the old way). They also check that the web keeps the key in IndexedDB as before, and test the move to secure storage, Join, Turn off and an unreadable key against a fake phone secure store. They run against throwaway `substracker-test-*` databases, so the app's own data isn't touched.

<http://localhost:8080/tests/app.html> runs the real app (index.html's markup and js/app.js) against a throwaway `substracker-test-app-*` database seeded with items dated relative to today: the month card's cash figure and Avg line, the yearly card's Income, Outgoings and Left over (a normal year, a short year, a year with no income), the income bar, donut and category list agreeing, the undated-plans notice opening the first plan, the form asking for a renewal date (editing an undated plan, new monthly and annual expenses, one-offs), saves writing only the changed fields, and a past stored date saving as it is and rolling forward. For income: the month's income being what's paid in it (including an annual bonus month), a month with none showing no percentage, the separate undated-income notice opening the item, the form asking for a payment date per cycle (monthly, annual, one-off) and when editing undated income, the wording switching with the Expense | Income toggle, and the Money tab saying "Payment", not "Renews". For the Money tab strip: Monthly matching the Insights headline with its Avg line, Annual matching the yearly card, the undated-items line opening the first undated plan, and a short month in another default currency showing its minus sign and "More going out than coming in". For the year chart: the Month | Year switch (the chart agreeing with the month headline), every month labelled and one tab stop, This year and Rolling, the By type / By category crossfade, Jump to now (faded when centred, hidden in focus), the keyboard (arrows, Enter, Escape), tapping a month and the mini strip, swiping past the loop seam, and Show income with its line and the months-over marker. For the Insights Ring: Reduce motion and effects following the system until set, then saved on the device, never exported or synced, and showing the Ring as the flat donut while on; the Ring's caption, legend and labels, arrow keys and a tap turning it, the announcement at rest, no frames while idle, one redraw on a theme change, and the flat fallback with `?flat=1` (WebGL ruled out) and after a lost WebGL context. Run it with reduced motion emulated too. For Android Back, through the same `pressBack()` the native listener calls: each overlay closing as its Cancel would (the add and edit sheets, the Delete confirmation over the sheet, the colour picker, the year chart's focus mode, the Sync sheet's recovery-words and Join steps, the web QR scanner view, the join choice and its Replace confirmation, the import dialogs including the Replace all confirmation), Back doing nothing while the Sync sheet is busy, a double Back, Back during an import, and the tab-then-minimise order. Sort: A to Z by default, the menu's roles, keys, Escape and Back, the choice kept per device and never in a backup, the settings or the sync outbox, and Wallet, Grid and List following it with a card open. Rolling totals: they roll when the tab comes to the front and when the app comes back, not on a redraw with the same numbers; the text is the final value throughout; the Wallet labels are unchanged; with 16 groups only the cards near the screen roll, at most 10 at once; with Reduce motion and effects there are no animations at all. On Insights, the month's total, Avg and the yearly card roll when the tab comes to the front, on a month step and on resume, not on a redraw, and only on screen; the year chart's readout never rolls, moving or settled; the yearly card matches the strip in Annual and the month's total its Outgoings. Copy CSV: the file minus its mark, the confirmations on every click, and the selected-text fallback when the clipboard is blocked. These need the page visible: a hidden browser tab doesn't run animation frames.

<http://localhost:8080/tests/i18n.html> runs the app in a frame with a fixed clock (18 November 2026) and fixed items. In English it walks the main screens (the Wallet and its labels, the Money strip, Grid and List, Sort, the add and edit sheet, Insights month and year, Settings, the Sync sheet, Import with AI) and the wording functions, and compares every text and label with `tests/fixtures/i18n-en-snapshot.json`, recorded from 1.15.0 before any text moved into the dictionary, in an en-GB browser (it says so if the browser's language differs). It also checks that `index.html`'s own English is the dictionary's, and that the language setting is per device, never in a backup, the settings or the sync outbox, with `lang="en"`. In the pseudo-locale (at 360px) it walks the same screens, reports any text or label outside the brackets (the person's data, money, currency codes and month names are allowed; the test explains what the heuristic can't see) and any text that runs out of its box or makes a sheet scroll sideways. In zh-TW (picked in Settings → Language, with Chinese item and category names) it walks the same screens at 360, 393 and 320px and reports any dictionary key that reaches the screen, any English left beyond an explained list (product names, file formats, the JSON names the AI reads, the recovery words), and any text that runs out of its box. It also checks `lang="zh-TW"`, the picker (per device, never in a backup, the settings or the sync outbox), that the rolling totals end on the formatted text at the text's width, and, at 360px, that changing the language through the picker reloads the app in English. The English recording leaves out the Language row, which is new since 1.15.0, and checks it on its own. `?geom=1` records every element's box per screen (`window.testGeometry`), to check that a style change doesn't move English. To record the English again after a deliberate wording change, save `window.testDump` from that page over the fixture.

None of these are part of the app: `tests/` isn't in the service worker's shell or in the native copy.

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
- **Sync key:** kept in the Android Keystore (see "Where the household key is kept").
- **QR scanning:** through Google Play services' code scanner; no camera permission.
- **Back button (Android):** Back closes only the topmost open overlay, the same way its own Cancel, Back or X does. That covers a sheet, a step inside the Sync sheet, a confirmation, the colour picker and the year chart's focus mode. A confirmation's Cancel is its first, least destructive choice, so Back on "Replace all" cancels. While the Sync sheet is busy, Back does nothing. With nothing open, Back goes to the Money tab, and from Money it sends the app to the background (`minimizeApp`, not `exitApp`, so anything still running carries on and the app reopens as it was). Every overlay registers in `js/overlays.js` when it opens. The web and the PWA don't listen for Back, so the browser's own Back is unchanged.

Native plugins: `@capacitor/app` 8.1.2 (the Back button), `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/status-bar`, `@aparajita/capacitor-secure-storage` 8.0.1, `@capacitor-mlkit/barcode-scanning` 8.2.2 (all on Capacitor 8). The scanning plugin brings ML Kit, CameraX and Google Play services libraries into the APK. The debug APK grew from about 5 MB to about 28 MB, mostly ML Kit's bundled barcode model for four CPU types, which `scan()` doesn't use. Those libraries also add `ACCESS_NETWORK_STATE` and Google's `datatransport`, which ML Kit uses for usage reports.

**iOS notes** (there's no iOS project yet). When one is added with `npx cap add ios`:

- `NSCameraUsageDescription` must be in `ios/App/App/Info.plist`, because ML Kit scanning on iOS uses the camera inside the app. For example: "Scan the recovery-words QR code from another device."
- `@capacitor-mlkit/barcode-scanning` only supports CocoaPods on iOS, not Swift Package Manager (Capacitor 8's default for new iOS projects). Create the iOS project with CocoaPods, or pick a different iOS scanner.
- The secure-storage plugin needs no Info.plist entry and no Keychain Sharing entitlement. The key is stored per device (`whenUnlockedThisDeviceOnly`), so it isn't in iCloud Keychain or in backups restored to another iPhone.

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

Your data is stored in the browser on that device (and, if you set up sync, on your other devices too). Clearing site data, or uninstalling the home-screen app on iOS, deletes it. Use **Settings → Export** regularly and keep the JSON file somewhere safe. To move data to another device, export on one and import on the other.

## Privacy note

Unless you turn on sync, the only network requests the app makes are for its own files and for favicon images from Google. In the Android app, Google Play services' code scanner and the ML Kit libraries may also send Google usage reports when you scan (no images are sent). On the web, scanning runs entirely in the page. With sync on, it also talks to the relay you set, which only receives encrypted changes (see `relay/README.md` for what it can and can't see). A favicon request includes the domain you entered (for example `example.com`), but never your prices, plans or notes. Leave the domain blank if you'd rather not send it.

## License

MIT. See [LICENSE](LICENSE).
