# Plan: custom intervals (H) and default groups with palette slots (L)

Status: planning only, for review. Nothing here is built yet. Written against `main` at 1.19.0
(`08bcdc4`, versionCode 28). Branch `plan-h-l`; this file is its only change.

Both features change what goes over sync and into backups. The plan defines the new format
(**format 5**) once, ships the code that reads it first, and turns on the writers that older
devices can't fully show only after that. No IndexedDB schema change, no relay change, no
change to the group-name hash.

---

## 1. Summary

- **One format, two releases.** 1.20.0 ships the foundation and the whole of L: one shared
  occurrence stepper (it gives exactly today's results), readers for every format-5 field, a
  small version heartbeat in the settings record, backup format 5, and palette slots with
  default groups. Every value L writes is one that 1.19.0 already understands. 1.21.0 then turns
  on H's writers (presets and Custom in the item sheet, Import with AI, CSV), after 1.20.0 has
  been out long enough for the household's devices to update.
- **H data:** one new item field, `repeat: { every, unit }`. `nextRenewal` stays the anchor date
  and `cycle` stays a legacy value, always `monthly`, `annual` or `once` (a "shadow"). Old
  devices keep working, keep the field, and show the nearest legacy cycle. No existing item is
  rewritten: an item without `repeat` is read as every 1 month or every 12 months.
- **L data:** the colour value that already exists, `color_<hash>: { name, swatch }`, gains
  `slot` (and `auto` when the app chose it). The swatch is always written as the Wallet key of
  the same colour (`w1`–`w15`), which 1.19.0 already draws. So old devices show the household's
  colours without knowing about slots. Slots sync, but which palette a slot is drawn in is a
  per-device setting.
- **Both rules come from what 1.19.0 does** (section 2): it keeps fields it doesn't know, but
  any op its checks refuse is dropped for good, because the sync cursor moves past it. So no
  format-5 value may fail a 1.19.0 check. Format-5 checks are loose when storing and strict
  when reading.

---

## 2. What 1.19.0 does today (read from the code, not assumed)

These facts decide what an older device does with each new field.

| # | Fact | Where |
|---|---|---|
| F1 | A remote op on an item field `ITEM_FIELDS` doesn't list is **kept** (`return true`). Listed fields must be strings of 2000 characters or less, `price` a finite number of 0 or more, and `del` a boolean. | `js/storage.js:666-672` |
| F2 | An op that fails those checks is **skipped**: not stored, only counted. The cursor still moves past it in the same transaction, so the device never sees it again unless it pulls everything again. | `js/storage.js:679-689`, `js/sync.js:284-289` |
| F3 | `toItem()` copies **every** stored field into the app's item, unknown ones too. | `js/storage.js:570-575` |
| F4 | `save()` writes only `ITEM_FIELDS`, and only the fields whose value changed (`changedFields`). An old device never removes or echoes a field it doesn't know. | `js/storage.js:578-580`, `js/sync-core.js:230-237, 272-278` |
| F5 | An unknown `cycle` value counts as **monthly** everywhere: `typeOf`, `cashInMonth`, `monthlyCost`, `nextRenewal`'s `addCycle`, and the calendar. | `js/insights-calc.js:47, 55-64`, `js/util.js:40-41, 104-111`, `js/calendar-math.js:103` |
| F6 | The item sheet sets the cycle radio from `sub.cycle`. An unknown value checks nothing and is **saved as `monthly`**. Saving a recurring item **requires a date**. | `js/app.js:1467, 1619, 1629-1631` |
| F7 | An unknown field in the settings record is kept (`return true`). A `color_` value must be an object with a valid `name`, a `swatch` string of 8 characters or less and a matching hash. Extra keys pass. | `js/storage.js:746-753` |
| F8 | `settingsFromRecord` reads only `{ name, swatch }`. The app draws `g1`–`g10` and `w1`–`w15` and treats every colour in the record as **picked**. An unknown key is dropped, and that group gets an automatic colour instead (no crash). | `js/storage.js:756-767`, `js/app.js:50, 400-408, 417-423` |
| F9 | Automatic colours (`w1`–`w15`) stay on the device and are **left out of exports** by `exportData()`. | `js/app.js:1822-1825`, `js/storage.js:972-978` |
| F10 | `exportAll()` spreads the whole `toItem()` result, so an old device's backup contains any unknown fields. `parseBackup()` accepts any whole-number `schemaVersion` of 1 or more and says "comes from a newer version" when it's newer. It requires `cycle` to be one of the three values, and `normalize()` drops unknown fields. | `js/storage.js:1016-1023, 1029, 1052-1055, 1095, 1102-1123`, `js/locales/en.js:529` |
| F11 | `meta.schemaVersion` is written but never checked when the database opens. IndexedDB `DB_VERSION` is 3. A **higher** `DB_VERSION` would stop 1.19.0 opening the database at all (rollback killer). | `js/storage.js:31-32, 121-134` |
| F12 | The relay keeps the whole log in order with no compaction, and sees only ciphertext. | `relay/src/room-logic.js` |
| F13 | `nextRenewal()` loops with a guard of 1200 steps. An anchor more than 100 years back returns a **date in the past** (prototype: an 1876 monthly anchor gives 15 Jan 1976). The stepper fixes this. | `js/util.js:117-127` |
| F14 | Cash and calendar figures **project in both directions**: a monthly item counts in months before its stored date. Only the "next" date never goes back before it. | `js/insights-calc.js:55-64`, `js/calendar-math.js:96-110` |
| F15 | The palette's neighbour rule ("adjacent OKLab ΔE ≥ 33 light, ≥ 25 dark", also under protan/deutan) is a comment. **No test enforces it.** It holds only for slot order, which sticky slots no longer give. | `js/wallet-math.js:10-15`, `tests/wallet-math.node.test.js` |
| F16 | `colorField()` (cyrb53 to `color_` + 16 hex) has **no golden-value test**. Today `Food` gives `color_566d16f27227b7de` and `Gaming` gives `color_0305bb8033dcce51`. | `js/storage.js:731-743` |
| F17 | Money calculated outside `insights-calc.js` today: `util.monthlyCost/annualCost/amountInMonth/amountInYear` (behind `yearTotal`) and `import-ai.js totalsOf()` (bucketed by cycle). | `js/util.js:40-55`, `js/import-ai.js:501-519` |

Versions 1.10–1.13 (shared settings, before the Wallet palette) don't know `w` keys. They drop
them under F8 and show their own automatic colours. Nothing breaks, but their colours won't
match.

---

## 3. Decision table

### H. Custom intervals

| Question | Recommended | Alternatives | Why |
|---|---|---|---|
| Stored fields | One new field `repeat: { every, unit }`, with `unit` one of `day`, `week`, `month`, `year`. `nextRenewal` stays the anchor and `cycle` stays a legacy shadow. | (a) Two fields `every` and `unit`. (b) Rename `nextRenewal` to `anchor`. (c) Put new values straight into `cycle` (`weekly`). | One field changes as a whole. With two fields, two concurrent edits can merge into an interval nobody chose (`every` from one edit, `unit` from the other). Renaming would rewrite every record for nothing. (c) breaks F6: an old device saves `weekly` back as `monthly`. |
| How old data is read | No `repeat` (or an invalid one) means `cycle`: `monthly` = every 1 month, `annual` = every 12 months, `once` = once. Read when the data is read; **nothing is backfilled**. | Write `repeat` into every record on upgrade. | No sync storm, no stamp races, nothing to verify per item. The first save of an item after upgrade adds `repeat` like any other changed field. |
| Dual-write `cycle` | **Always**, for good. `cycle` is the shadow of `repeat`: every 1 month is `monthly`, every 12 months or every 1 year is `annual`, and any other interval takes the nearest by period (log scale: up to about 105 days is `monthly`, longer is `annual`; quarterly is `monthly`, every 6 months is `annual`). | Stop writing `cycle` after a transition. | `cycle` is required by 1.19.0's backup import (F10) and drives every old screen (F5). Writing it costs nothing. |
| Which wins, `repeat` or `cycle` | `repeat` counts only if it **agrees** with `cycle` (shadow(repeat) equals cycle) **and its stamp is not older than `cycle`'s**. Otherwise `cycle` wins. In a backup file (no stamps) only the agreement test applies. | Always trust `repeat`. Always trust `cycle`. | Every format-5 writer writes a matching pair. A mismatch, or a newer `cycle`, can only mean an older device changed the cycle on purpose, and LWW says its edit wins. An old device that edits the price, name, category or date leaves `repeat` intact (F4). |
| What an old device shows for an interval it can't represent | The nearest legacy cycle **at the real anchor date** (weekly shows as monthly, every 6 months as annual). Its totals are approximate: 150 a week shows as 150 a month instead of about 650. | Write the shadow without a date (`nextRenewal: ''`), so old devices leave it out of month totals. | Without a date, F6 forces anyone editing the item on an old device to add one. That edit loses the interval (data loss). A dated shadow keeps every old edit safe. The wrong amount is avoided by order, not by format: readers ship first, and 1.21.0's **readiness check** warns before the first non-representable interval while an old device is still active (section 5.4). |
| Anchor semantics | The anchor is a **phase**: occurrences are anchor + k × interval for every whole k, before and after it, as today (F14). Months are clamped from the **anchor's** day, never from the previous clamped date. "Next" never shows a date before the anchor (today's rule). | Treat the anchor as a start: nothing before it. Add an optional start or end date later. | Changing to a start would remove existing items from past months on the year chart (their stored dates are usually recent "next renewal" dates). Start and end dates can be added later as fields of their own. |
| Month ends | Day = min(anchor day, days in that month). Every 1 month from 31 Jan gives 28/29 Feb, 31 Mar, 30 Apr, 31 May. Every year from 29 Feb gives 28 Feb in other years and 29 Feb in leap years. | Stepping from the previous date (drifts: 31 Jan, 28 Feb, 28 Mar, 28 Apr). | Matches `nextRenewal()` and the calendar today exactly (prototype P1: 618,003 comparisons, 0 differences). |
| Days and weeks across DST | Calendar arithmetic only: whole UTC day numbers built with `setUTCFullYear(y, m, d)`, never milliseconds or local `Date` sums. A week is 7 days. | Local `Date` with `setDate(+7)`. | Can't move across DST or time zones. Prototype P1 passes in London, New York, Lord Howe (30-minute DST), Apia, Santiago and Taipei. Note that `Date.UTC` maps years 0–99 to the 1900s; the fuzz test found this. |
| Occurrences per month | Cash basis: `dueInMonth = price × number of occurrences in that month`. Weekly gives 4 or 5, fortnightly 2 or 3, daily 28–31. | A monthly average for weekly items. | Cash basis is the app's rule. The counts are exact (prototype P2). |
| Yearly total and Avg | `yearTotal` = price × the item's occurrences in that calendar year (weekly 52 or 53, fortnightly 26 or 27). Undated recurring items use a nominal rate (weekly ×365.2425/7, every N months ×12/N). Avg = yearTotal ÷ 12, as now. | A nominal rate for everything. | Keeps the existing identity: Avg equals the mean of the twelve cash months when every item has a date (prototype P2: 0 mismatches). Monthly and annual results don't change. |
| Insights type colours | Keep the three keys and their colours (`--type-monthly`, `--type-annual`, `--type-once`). `monthly` becomes "every month or more often" (period up to a month: weekly, fortnightly, every 4 weeks, monthly). `annual` becomes "less often than monthly" (quarterly, 6-monthly, yearly, custom above a month). New label strings, no new colour. | Four buckets with a new token. Per-unit buckets. | No new colour to tune and test. The year chart and the strip legend stay readable. |
| Item sheet | Replace the three-way cycle choice with: Weekly, Fortnightly, Monthly, Quarterly, Every 6 months, Yearly, Once, Custom. Custom shows "Every [N] [days / weeks / months / years]". Under it, a line: "Next: Thu 26 Nov, then every 2 weeks". Income keeps "How often". | A free text field. A separate interval sheet. | Presets cover what the AI tests actually produced. Custom covers the rest without a second screen. |
| Validation | N is a whole number, 1–99 in the sheet. The period is at most 10 years. Recurring items need a date (today's rule). The reader accepts wider ranges (days up to 3660, weeks up to 520, months up to 120, years up to 10) and treats anything outside as "use `cycle`". | The reader rejects bad values. | A strict reader must never drop an op (F2). Interpret strictly, store loosely. |
| CSV | Keep the 7 columns in place. **Cycle** gets the readable value (`weekly`, `fortnightly`, `monthly`, `quarterly`, `every 6 months`, `annual`, `one-off`, or `every 3 weeks`). Add **Every** and **Unit** columns at the end. **Next date** comes from the stepper. | Replace Cycle with Every and Unit. | Existing spreadsheet formulas on columns A–G keep working. |
| Import with AI | Schema version 1 stays. `cycle` also accepts `weekly`, `fortnightly`, `quarterly`, `every 6 months`, `yearly`, plus `custom` with optional `"every"` and `"unit"` fields. Synonyms map to presets ("every two weeks" is fortnightly, "half-yearly" and "semi-annual" are every 6 months). Ambiguous words (`biweekly`, `bimonthly`) are flagged with the existing cycle fix, never guessed. The prompt stays English. | A schema version 2. | Old replies stay valid. The flag-don't-guess rule already exists in `import-ai.js`. |
| Banner (due soon) | One row per item: the first date in the window, and "×2" plus the summed amount when it falls more than once (weekly in a 14-day window). | One row per occurrence. | Keeps the banner short. A daily item would otherwise fill it. |
| Calendar | `stepDays()` returns every day in the month (it already returns a list). Each row's amount comes from a new `insights-calc` function `dueOnDays(s, y, m)` (one price per occurrence), whose days add up to `dueInMonth`. | Amounts worked out in the calendar. | Keeps "no money maths outside insights-calc", and keeps the day totals adding up to `cashDue`. |
| Stepping far away | Every month query is direct arithmetic, not a walk from the anchor. Each query returns at most 400 occurrences. Anchor years are limited to 1900–2199. | A loop with a guard (today). | 100,000 month queries 300 years from the anchor take about 100–170 ms in Node (P1). It also fixes F13. |

### L. Default groups and palette slots

| Question | Recommended | Alternatives | Why |
|---|---|---|---|
| Where the slot is stored | In the **existing** `color_<hash>` value: `{ name, swatch, slot, auto? }`. `swatch` is always `w(slot mod 15 + 1)`. | A new field `slot_<hash>`. | One field means a colour can't half-change. 1.19.0 accepts extra keys (F7) and draws `w` keys (F8). When an old device re-picks a colour it writes `{ name, swatch: gN }`, dropping `slot`, and the slot is worked out again from the swatch. No stamp comparison needed. |
| Dual-write of `{ name, swatch }` | Always (it's the same value). | Stop writing `swatch` later. | Without `swatch` 1.19.0 would refuse the op and lose it for good (F2, F7). |
| Default palette | The current 15-colour Wallet palette. Slot i is `--wallet-(i+1)` and `w(i+1)`. | A new palette. | Old devices draw the identical colour, and the 4.5:1 text tests already pass (prototype P4). |
| Assigning slots | A preset gets its fixed slot unless a live group already uses it. Any other group gets a **hash probe**: start at `hash(name) mod 15` and take the first slot no live group uses. After 15, the same probe over the second lap (15–29). After 30, colours repeat (accepted). Written with the item that creates the group, in the same transaction. A group that arrives from an old device gets its slot from the first new device that sees it. | The lowest free slot. Neighbour-aware choice. | Simulation P3: two devices offline each adding one group clash 6–62% of the time with the hash probe, against 88–100% with the lowest free slot. The same name on two devices gets the same slot from the same state, and it's one field, so that never clashes. |
| Two offline devices pick the same slot | **Repair**, the same on every device: when two live groups share a slot and the later one was automatic, the later one moves to its next free slot. Picked colours never move. Two names for the **same preset** (for example `Housing` and `居住`) are allowed to share. | Accept the clash. Ask the person. | P3: the repair always converged, with at most one move per clash in practice. The group that moves is the one just created on the other device. |
| How presets are stored | **Plain presets**: choosing one writes its name text in the current language, plus its fixed slot. No id or flag. A built-in table maps both languages' names to the preset, and is used only to pick the slot. | A stored preset id. | The name hash and name sync stay exactly as they are. A renamed preset is simply a custom group. Nothing matches names across languages; the same colour for `Housing` and `居住` is a coincidence of slot, not a match. |
| Renamed or translated defaults | A name typed by the person never changes. Switching the app's language doesn't rename groups; new presets are offered in the new language. A "Rename group" action (part of the merge helper) moves the items and takes the old slot along. | Translating stored names. | Names are the person's own data (see the glossary's conventions). |
| Migrating today's picked colours (g1–g10) | Rewrite each picked `gN` to its mapped slot (table in 5.3), stamped at the upgrade, **once**, as a verified step. The mapping is fixed, so every device writes the same value. | Keep `g` keys as a "Classic" palette. Map only when reading. | One palette everywhere. Old devices see the new `w` key too, so every device matches. Colours shift slightly (OKLab 7–20) for groups someone picked. |
| Migrating automatic colours (w1–w15, per device) | Each live group with no record field gets its **current local automatic colour** as its slot (`auto: true`), unless another group already holds that slot in the record. Then it probes. | Recompute everything. | Nothing visibly changes on the device that upgrades first. Others take its colours, a one-time change for groups whose automatic colours differed between devices. |
| More than 15 groups | Slots 15–29 are a second lap of **hand-tuned** lighter or darker versions of the same hues (one table per theme). Old devices see the base hue (`swatch` = base key). | Computed lightness shifts. | P4: a computed ±0.14 OKLCH shift fails 4.5:1 in dark mode (4.44) and nearly matches another slot under deutan (orange vs yellow², ΔE 0.7). It needs a tuned table with its own tests. |
| What syncs and what stays on the device | **Synced:** `slot`, `auto`, `swatch`, `name`. **This device only:** which palette slots are drawn in (`palette` preference in localStorage: `default` now, Pastel and Neon later as Pro cosmetics). | Syncing the palette choice. | A household can use different palettes and groups still match by slot. |
| Colour picker | 15 swatches of this device's palette, with a "More shades" row for the second lap. Slots used by other live groups show a small mark. Choosing one writes `slot` and drops `auto`. | The old 10 `g` colours. | Picks are slots from now on. The mark makes duplicates a choice, not an accident. |
| Contrast and distance checks | One `PALETTES` registry. Every palette has tests for each theme and both laps: text 4.5:1 with depth (exists), neighbours in slot order, default presets in English A–Z **and** Zhuyin order, normal vision plus protan/deutan/tritan (P4 thresholds in 7.4). | Only the default palette. | Sticky slots plus A–Z order mean any two slots can end up next to each other (F15). P4 shows this palette can't keep **every** pair apart under colour-blindness (blue and violet are ΔE 1.2 under protan). Names on the cards and the Wallet divider carry that case, never colour alone. |
| Wallet, Ring, year chart, calendar dots | All read one `slotVar(slot)` (CSS `--slot-0` … `--slot-29`, set from the palette tokens). The calendar's 3:1 ring rule runs on every slot. The Wallet divider follow-up makes neighbouring cards distinct even when their colours are close. | Per-view mappings. | One shared layer, as DESIGN rules ask. |
| Presets vs `js/services.js` and Import with AI | Map the service categories to presets: Entertainment and Gaming to Entertainment, Music to Hobbies, AI, Cloud storage, Software and Productivity to Software & cloud, News to Entertainment, Fitness to Health & fitness, Utilities to Utilities. `DEFAULT_CATEGORIES` becomes the 11 English preset names, and the AI prompt lists them. | Keep the old category list. | One vocabulary. The AI suggests the groups the person will see. |
| Suggest merges | An optional helper, driven by an alias table (no fuzzy matching): it suggests "move these groups into that preset", shows the result, and applies it as ordinary category edits (old devices understand them). P5 on your real list gives exactly your merge map: 13 groups become 9. | Automatic merging. | Explainable and undoable, and nothing happens without a tap. |

### Both

| Question | Recommended | Alternatives | Why |
|---|---|---|---|
| Format number | Backup `schemaVersion` **5**, and `meta.schemaVersion` 5 once the step in section 6 is verified. | Stay on 4. | A 1.19.0 import of a 1.21 file loses intervals; the "newer version" note (F10) should say so, and it does only for a higher number. |
| IndexedDB `DB_VERSION` | Stays **3**. No new stores. | A new store for slots or history. | F11: a higher number stops 1.19.0 opening the data, so going back would be impossible. |
| Relay | No change. | – | Ciphertext only, small ops, full log (F12). Checked against the room logic and the engine. |
| Release split | **Two:** 1.20.0 (foundation and L), then 1.21.0 (H writers). At least 2 weeks between them in production. | One release. Three releases (foundation, L, H). | The H readers must reach every device before any H writer exists. L needs no such wait, because 1.19.0 already draws its values. |

---

## 4. Data model, field by field

### 4.1 Items (records with `del`)

| Field | 1.19.0 | Format 5 | Notes |
|---|---|---|---|
| `cycle` | `monthly` \| `annual` \| `once` | Same three values only, always written. The **shadow** of `repeat`. | Never any other string (F6). |
| `nextRenewal` | Date typed (YYYY-MM-DD) | Same: the **anchor**. | Display rolls it forward and never rewrites it (as now). |
| `date` | One-off date | Same | |
| `repeat` | – | `{ "every": int, "unit": "day"\|"week"\|"month"\|"year" }`, or absent or `null` | Recurring items only. Saved by 1.21+ on every save of a recurring item. Extra keys are kept and ignored. |
| everything else | unchanged | unchanged | |

**How the interval is read** (`intervalOf(item, stamps?)`, in one module):

```
if cycle == 'once'                                     -> once
r = valid(repeat) ? repeat : null
if r and shadow(r) == cycle and (no stamps or ts.repeat >= ts.cycle) -> r
cycle == 'annual' ? every 12 months : every 1 month
```

`storage.toItem()` puts the result in `item.repeat`, so every screen sees one value. The next
save then writes a matching pair: it repairs itself, with no background writes.

Before and after. An old monthly item: nothing is stored differently. 1.20 reads `repeat` as
every 1 month.

```json
{ "id": "k3f9", "type": "expense", "name": "Netflix", "price": 390, "currency": "TWD",
  "cycle": "monthly", "nextRenewal": "2026-12-05", "date": "", "category": "Entertainment" }
```

A weekly item written by 1.21. 1.19.0 shows it as 150 a month on the 19th of each month.

```json
{ "id": "p2a7", "type": "expense", "name": "Pottery class", "price": 150, "currency": "TWD",
  "cycle": "monthly", "nextRenewal": "2026-11-19", "repeat": { "every": 1, "unit": "week" },
  "date": "", "category": "Hobbies" }
```

A 6-monthly item: `"cycle": "annual"`, `"repeat": { "every": 6, "unit": "month" }`. A quarterly
item: `"cycle": "monthly"` (about 105 days is the dividing line).

### 4.2 Settings record (`id: "settings"`, never `del`)

| Field | 1.19.0 | Format 5 |
|---|---|---|
| `defaultCurrency` | `"TWD"` | unchanged |
| `color_<16 hex>` | `{ "name": "Gaming", "swatch": "g6" }` (picked only) | `{ "name": "Gaming", "swatch": "w8", "slot": 7 }` picked; `{ "name": "Fuel", "swatch": "w7", "slot": 6, "auto": true }` automatic; `{ "name": "Pets", "swatch": "w3", "slot": 17, "auto": true }` second lap |
| `app_<16 hex>` | – | `{ "v": "1.20.0", "fmt": 5, "at": "2026-12-01" }`, one per device: the hash of its device id, by the same cyrb53 with an `app_` prefix |

How a slot is read: a valid `slot` (0–29) whose base matches `swatch` is used as is. Otherwise
the slot comes from `swatch`: `wN` gives N−1, and `gN` uses the table in 5.3. A value with
no `slot` counts as picked.

### 4.3 Backup file

```json
{ "app": "substracker", "schemaVersion": 5, "exportedAt": "…",
  "items": [ { "…": "…", "cycle": "monthly", "nextRenewal": "2026-11-19",
               "repeat": { "every": 1, "unit": "week" } } ],
  "settings": { "defaultCurrency": "TWD",
                "groupColors": { "Gaming": "w8", "Fuel": "w7" },
                "groupSlots":  { "Gaming": 7, "Fuel": 6, "Pets": 17 } } }
```

- Every recurring item carries `repeat` (the value read) and its matching `cycle`.
- `groupColors` now includes automatic colours too (they're shared now). The `w`-key filter in
  `exportData()` goes. `groupSlots` is added to `BACKUP_SETTINGS`.
- Reading files: version 5 uses `repeat` and `groupSlots`. Versions 3 and 4 use the agreement
  rule for any `repeat` they carry (old backups can include a stale one, F10), and map `gN` keys.
- Every export is checked before it's handed over: the payload is parsed back with the format-5
  reader **and** with the 1.19.0 rules (every `cycle` one of three values, every one-off
  dated), and compared with the live items. If either check fails, the file is written as
  format 4 and the person is told.

---

## 5. Rules in detail

### 5.1 The shared stepper (`js/interval.js`, pure)

Everything that steps through dates goes through it: `util.nextRenewal()`; insights-calc
(`cashDue`, `incomeDue`, `monthSeries`, `yearSummary`, `breakdown`, `stripSummary`, `yearTotal`);
due-soon; the calendar's `stepDays()`; the CSV "Next date"; wallet "next" dates. Money stays in
insights-calc: the stepper returns dates and counts, never amounts. `util.monthlyCost`,
`annualCost`, `amountInMonth` and `amountInYear` move into insights-calc, and
`import-ai.totalsOf()` buckets with insights-calc's type function, which clears F17.

The core, as prototyped:

```js
// day numbers: whole UTC days built with setUTCFullYear (years 0–99 safe)
occurrence(anchor, step, k):           // k any whole number, 0 = the anchor
  days:   fromDayNum(dayNum(anchor) + k * n)
  months: mi = anchor.y*12 + anchor.m + k*n; y = floor(mi/12); m = mi - 12*y
          return { y, m, d: min(anchor.d, daysIn(y, m)) }   // clamp from the ANCHOR's day
between(anchor, step, from, to):       // first k from arithmetic, then walk; at most 400 results
nextOnOrAfter(anchor, step, today):    // from max(today, anchor): never before the stored date
```

`week` is 7 days and `year` is 12 months, so there are only two kinds of step.

### 5.2 Default groups

| Slot | Preset (en) | zh-TW (⚠ for review) | Colour | Notes |
|---|---|---|---|---|
| 2 | Housing | 居住 | Red | House (Mortgage) |
| 13 | Utilities | 水電瓦斯 | Brown | Internet included; ⚠ the name says water, power and gas. An alternative is 生活帳單 |
| 11 | Food | 餐飲 | Magenta | Coffee |
| 6 | Transport | 交通 | Orange | Fuel |
| 1 | Software & cloud | 軟體與雲端 | Mint | AI, Cloud Storage |
| 4 | Entertainment | 娛樂 | Lilac | Streaming, Gaming, News |
| 14 | Hobbies | 嗜好 | Yellow | Hobbies, Music (MuseScore) |
| 5 | Education | 教育 | Navy | Twinkl |
| 7 | Shopping | 購物 | Violet | Amazon Prime |
| 8 | Health & fitness | 健康與運動 | Sky | (Fitness in services.js) |
| 10 | Insurance & finance | 保險與金融 | Lime | |

The slots were chosen by search (P4b), not by meaning. With all 11 presets, and with your 9
after the merge, neighbouring cards in English A–Z and in Zhuyin order stay at OKLab ΔE ≥ 23.6
(normal vision, worse theme). Under colour-blindness they stay at ≥ 16.5. Any two presets stay
at ≥ 10.9 (normal vision). The semantic picks first tried (Housing brown, Food orange…) dropped
to ΔE 2.5 under deutan in Zhuyin order. Slots 0 Teal, 3 Blue, 9 Forest and 12 Pink are left for
custom groups. "Other" isn't a preset: Uncategorised covers it, and it takes a slot like any
group.

Judgement calls from your data: **News → Entertainment** (a separate "Media" preset would be a
12th with a weaker slot). **MuseScore → Hobbies** (it's for making music, and Music →
Hobbies matches your map).

### 5.3 g1–g10 to slots (the fixed migration table)

The nearest distinct slots, light theme, OKLab ×100 (P4):

| g | Old name | Slot | Distance |
|---|---|---|---|
| g1 | Gold | 10 Lime | 20.2 (Yellow would be 23.0, if you'd rather) |
| g2 | Steel blue | 3 Blue | 12.7 |
| g3 | Terracotta | 6 Orange | 13.3 |
| g4 | Sky | 8 Sky | 16.7 |
| g5 | Rose | 11 Magenta | 11.6 |
| g6 | Plum | 7 Violet | 11.3 |
| g7 | Olive | 9 Forest | 16.1 |
| g8 | Brown | 13 Brown | 7.1 |
| g9 | Teal | 0 Teal | 8.0 |
| g10 | Brick | 2 Red | 7.7 |

### 5.4 Readiness heartbeat (in 1.20.0, used by 1.21.0)

- Each 1.20+ device writes `app_<hash(deviceId)>` when sync is on and the version changed or
  the value is more than 30 days old. That's one small op, usually once a month.
- **Ready** means every device id found in a record stamp from the last 90 days has a heartbeat
  with `fmt` 5 or more.
- 1.21.0 checks this the first time someone saves an interval that 1.19.0 can't show. If the
  household isn't ready, it says: "Another device in your household hasn't been updated, and it
  will show this as monthly until it is." The choices are **Save anyway** and **Cancel**.
- A device that never edits leaves no stamps, so it can't be detected. That gap is accepted and
  listed under risks.

---

## 6. The migration sequence

Nothing new runs before the existing chain (subscriptions, items, records, shared settings)
has been verified. Each new step works like `migrateSettings`: one transaction, read back,
check, then switch. A failure changes nothing, is logged with counts only, and runs again on
the next load.

**First launch of 1.20.0**

1. **Stepper check (read-only).** For every live item, compare the 1.19 code (kept for 1.20 only,
   as `js/legacy-step.js`) with the new stepper over 25 months (−6 to +18): next date, calendar
   days, `dueInMonth`/`incomeInMonth`, and `yearTotal` for this year and next. Any difference
   means this device keeps the legacy code (a flag) and records
   `meta.formatMigration = { verified: false, step: 'intervals', diff: n }`.
2. **Plan colours (pure).** Every `gN` field gets its slot from 5.3. Every live expense group
   without a field (Uncategorised too) adopts its local automatic colour if no group in the
   record already uses that slot; otherwise it probes. Also this device's heartbeat.
3. **Write** (one transaction over records, outbox and meta): the settings-record ops, their
   outbox entries and the clock. The `settings` store isn't touched.
4. **Read back** the record. Every planned field must have a stamp, and its value must be the
   planned one or one with a **newer stamp** from another device (never lost). The record must
   have no `del`. Every live group must resolve to a slot.
5. **Switch:** write `meta.formatMigration = { verified: true, at, fields }` and `schemaVersion: 5`.
   From then on, groups created here write slots.
6. **On failure** (step 3 or 4), colours stay as they are today on this device. The read path
   is the same either way (slots come from the swatch), so there's no second UI. Only sharing
   waits.

**First launch of 1.21.0:** nothing to migrate. `legacy-step.js` and its check are removed
(after 1.20.0 has reported `verified` on your devices: see the dev screen's storage status).

**Half-synced household:**
- Device A migrates and pushes. B (1.19.0) pulls and shows A's colours as picks (F8).
- C (1.20.0) migrates later. It plans only the fields the record lacks, so it never overwrites A.
- If A and C migrate offline at the same time, the same group gets the same value where both
  adopted the same automatic colour. Otherwise LWW picks one, and a slot clash is repaired (5.2).

---

## 7. Mixed versions

### 7.1 What a 1.19.0 device does with each new thing

| New thing | 1.19.0 behaviour | Data safe? |
|---|---|---|
| `repeat` op on an item | Stored (F1); shows in its item object (F3); never written back or removed (F4) | Yes |
| Item with a non-representable `repeat` | Shows `cycle` at the anchor: weekly as monthly, every 6 months as annual. Its totals are approximate. | Yes (readiness check limits it) |
| Old device edits price, name, category, notes or date of such an item | Writes only those fields; `repeat` stays valid (the date is the anchor) | Yes |
| Old device changes the cycle | `cycle` is newer, so on new devices the legacy value wins, by design (LWW) | Yes |
| Old device exports a backup | Format 4, includes `repeat` (F10). A new device reads it with the agreement rule. | Yes |
| Old device imports a format-5 file | Accepted with the "newer version" note. `repeat` is dropped from the import, but a record's existing `repeat` is untouched (no op for unchanged fields). | Yes |
| `color_` with `slot` / `auto` | Accepted (F7); drawn by its `w` key as a pick (F8) | Yes |
| Old device picks a colour | Writes `{ name, gN }`. New devices read it through 5.3 and treat it as picked. | Yes |
| Second-lap slot (15–29) | Shows the base hue | Yes |
| `app_` heartbeat | Kept, unused (F7) | Yes |
| Colours in an old device's backup | `exportData()` drops `w` keys (F9), now most colours, so a restore from that file gets new automatic slots | ⚠ colours only |
| Versions 1.10–1.13 | `w` keys dropped; their own automatic colours | ⚠ colours only |
| Deletes | Unchanged: tombstones as today, and nothing new deletes or revives anything | Yes |

### 7.2 Over days and weeks

| Period | Household | What people see |
|---|---|---|
| 1.20 on some devices | Mixed 1.19 and 1.20 | Same items and amounts everywhere (no H writers yet). Colours converge to the household's slots. |
| 1.21 on one device, others still on 1.19 | Readiness check warns | Weekly or quarterly items only if someone taps Save anyway. Then 1.19 devices show approximations, and 1.20 devices show them exactly. |
| Everyone on 1.21 | Format 5 everywhere | Everything exact |

---

## 8. Module impact

| Module | Change |
|---|---|
| `js/interval.js` (new) | Stepper, `intervalOf`, `shadow`, labels' data (no t() calls) |
| `js/util.js` | `nextRenewal` delegates; the cost helpers move to insights-calc; `cycleLabel` uses interval labels |
| `js/insights-calc.js` | Counts occurrences for cash; `dueOnDays`; `typeOf` by period; `yearTotal` exact or nominal; owns all money |
| `js/calendar-math.js` | `stepDays` from the stepper; amounts from `dueOnDays` |
| `js/due-soon.js` | Next date from the stepper; ×count rows |
| `js/year-chart(-math).js` | Type labels only (money already comes from insights-calc) |
| `js/wallet.js`, `js/wallet-math.js` | Labels from intervals; `PALETTES` registry; `slotVar`; slot assignment, probe and repair (pure) |
| `js/app.js` | Item sheet (presets, Custom, summary line, validation); picker (15 + second lap, in-use marks); group colours read slots; export filter removed; merge helper; readiness dialog |
| `js/storage.js` | `ITEM_FIELDS` gets `repeat`, checked before the string rule: any plain JSON is stored (sync-core already checks it), and an odd value is read as "use `cycle`", never skipped; loose checks for `repeat` and colour values; `toItem` adds `intervalOf`; slot-aware `settingsFrom/settingsFields`; heartbeat; F5 migration step; backup format 5 read and write with the export check; `BACKUP_SETTINGS += groupSlots` |
| `js/sync-core.js`, `js/sync.js`, `relay/` | No change |
| `js/services.js` | Service categories mapped to presets; `DEFAULT_CATEGORIES` = presets; preset table (en/zh names, slot) |
| `js/import-ai.js`, `js/import-ai-prompt.js`, `js/import-ai-sheet.js` | New cycle values, `every`/`unit`, ambiguous words flagged; the fix list gets the presets; duplicate key includes the interval |
| `js/csv-export.js` | Cycle text; **Every** and **Unit** columns |
| `css/app.css` | `--slot-0` … `--slot-29` per theme (second-lap tokens); the default maps to `--wallet-*` |
| `js/locales/en.js`, `zh-TW.js` | Interval presets, units (plurals), summary line, errors, type labels, preset names, second-lap colour names, readiness and merge texts |
| `docs/glossary-zh-TW.md` | Interval terms (每週, 每兩週, 每季, 每半年, 自訂, 每 N 天/週/個月/年), preset names, "default group" |
| `README.md`, `sw.js` | Docs and `VERSION` bump in each release (not in this plan) |

---

## 9. Test matrix

| Area | Where | Cases |
|---|---|---|
| Group-name hash frozen | `settings.node.test.js` | **First**, before any refactor: golden values (`Food` → `color_566d16f27227b7de`, `Gaming` → `color_0305bb8033dcce51`, plus CJK, emoji and 40-character names) |
| Stepper matches today | `interval.node.test.js` | 1.19 functions copied as a fixture. Anchors across 4 years × months across 11 years × monthly/annual, plus "next" from 9 offsets (P1's 618k cases) |
| Month ends, leap day | same | Every 1 month from the 31st, from Jan 31 in leap and other years, every 3 months from Nov 30, every year from Feb 29, every 6 months from Aug 31 |
| Fuzz | same | Seeded 200k: valid dates, clamped from the anchor day, k=0 is the anchor, strictly increasing, `inMonth` finds every occurrence. Years 0–99 |
| DST and time zones | npm script runs the file under TZ Europe/London, America/New_York, Australia/Lord_Howe, Pacific/Apia | Week and day steps across both DST changes |
| Far ranges | same | 1900 anchor queried in 2199 in under 1 s for 100k queries; the 400 cap; 1876 monthly gives a future date (F13 fixed) |
| Counts and Avg | `insights-calc.node.test.js` | Weekly 4/5 and 52/53, fortnightly 2/3 and 26/27, quarterly, daily; the identity yearTotal/12 = mean of cash months; undated nominal; type buckets |
| Calendar, due soon | existing suites + new | Several dots per day; day totals = `cashDue`; ×2 rows in a 14-day window |
| Reading items | `storage-model.node.test.js` | `intervalOf`: agreement × stamp order (8 cases), backup files with stale `repeat`, invalid values falling back, extra keys kept |
| Loose checks | same | No format-5 value is ever skipped; 1.19 checks (fixture) accept every value format 5 writes |
| Backups | same | 5 → write → read → compare; 5 read by the 1.19 parser (fixture); 4 with `repeat`; the format-4 fallback when the check fails |
| Mixed-version sync | `sync-engine.node.test.js`, with a **1.19.0 fixture** of the pure modules (`tests/fixtures/v1.19.0/`) and the harness's `device()` taking either set | (1) 1.21 writes weekly; 1.19 pulls, edits the price; 1.21 still weekly. (2) 1.19 changes the cycle; legacy wins everywhere. (3) Colours: 1.20 adopts; 1.19 shows them as picks; 1.19 picks `g6`; 1.20 maps it to slot 7. (4) Two 1.20 devices offline add groups; the repair converges. (5) Heartbeat and readiness. (6) Rollback: the 1.19 store reads 1.21 records, lists every item, gives finite totals, no tombstone revived |
| Migration F5 | `storage.html` (browser, IndexedDB) | Seed a 1.19-shaped database, open, verify meta, record and read-back; an aborted transaction stays unverified and retries; re-running adds only what's missing; a second tab |
| Palettes | `wallet-math.node.test.js` → `palette.node.test.js` | For every palette × theme × lap: text 4.5:1 with depth; neighbours in slot order (normal ≥ 25 light / 23 dark, protan and deutan ≥ 20, tritan ≥ 20); presets in en A–Z and Zhuyin order (normal ≥ 20, colour-blind ≥ 15); any pair ≥ 8 normal; second lap vs its base ≥ 12. Numbers from P4 with a margin; enforces the F15 comment |
| Strings | i18n suites (exist) | Parity and placeholders for every new key; zh-TW glossary terms |
| UI | `app.html` | Preset and Custom validation, summary line, picker, readiness dialog, merge helper, both languages at 375 px |

---

## 10. Branch and version plan

| Step | Branch | Version | Contents |
|---|---|---|---|
| 0 | `plan-h-l` | – | This doc (review only) |
| 1 | `test-legacy-fixture` | – (tests only) | 1.19.0 fixture, `device()` either version, the golden hash test |
| 2 | `feature/format5-groups` | **1.20.0**, versionCode **29** | Stepper refactor (no behaviour change) + legacy check; format-5 readers; heartbeat; backup 5; L in full; tag `pre-1.20.0-main` before merging |
| 3 | soak | – | 14 days on your devices (section 12) |
| 4 | `feature/custom-intervals` | **1.21.0**, versionCode **30** | H writers and UI, Import with AI, CSV, banner, calendar, readiness check; `legacy-step.js` removed; tag `pre-1.21.0-main` |
| 5 | soak | – | 14 days |

If you'd rather keep each release small: 1.20.0 foundation only, 1.21.0 L, 1.22.0 H. That's
slower, with the same format.

---

## 11. Risks and rollback

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| An old device shows wrong totals for a new interval | Medium | Wrong numbers on that device | Readers first, readiness check, the shadow at the real anchor |
| A device that never edits is missed by the readiness check | Medium | Same as above | Release notes; 1.20 has 2+ weeks to spread |
| A PWA tab keeps old code for days | Medium | Same | That tab shares the device id (same IndexedDB) with the updated app, so the heartbeat can't see it. It's the same person's browser, and the service worker's update cycle replaces it on the next reload |
| A new value fails an old check, and the op is lost (F2) | Low with tests | Silent divergence | 1.19 fixture tests on every format-5 value |
| Torn intervals from concurrent edits | Low | Wrong interval | One `repeat` field |
| Colours change once (g mapping, adopting other devices' automatic colours) | Certain, one-time | Cosmetic | Release note; mapped to the nearest colour |
| Slot clash from offline creation | 6–62% per offline pair, repaired | One colour moves | Repair |
| Neighbours too close (any slot next to any slot) | Some | Cosmetic, accessibility | Preset table, names on cards, Wallet divider, palette tests |
| Group-name hash changed by accident | Low | Colours split, sync noise | Golden test first |
| `DB_VERSION` bumped | Low | No way back | Kept at 3; called out in review |
| Stepper refactor changes a number | Low | Wrong totals | P1 equivalence in tests + check on device |

**Rollback**
- **1.20 → 1.19** (the web service worker rolls back, or a 1.20.1 that reverts the change; on
  Android the versionCode only goes up, so rolling back means shipping a fix forward): 1.19
  opens the same database (F11), draws the slots as picks, ignores heartbeats and `repeat`. No
  loss.
- **1.21 → 1.20:** 1.20 reads everything, so nothing is lost (this is why the readers ship first).
- **1.21 → 1.19:** items show approximately (as in 7.1). Nothing is lost on the records, and
  `repeat` comes back into use on update.
- **Data:** no step destroys anything. The old stores stay as fallbacks. Export a backup before
  the soak (format 4 from 1.19).

---

## 12. Sync soak test (each release)

- **Devices:** the Android phone (new version), desktop web (new), a second browser profile kept
  on 1.19.0 (`www/` from the `pre-1.20.0-main` tag served locally). 14 days.
- **Daily:** add, edit, delete one item on each, one of them offline for a day. Create one group
  offline on two devices on day 3 and day 9 (slot repair). 1.21: change a weekly item's price on
  1.19, and its cycle on 1.19 once.
- **Checks each evening:** a script compares the format-5 exports of the two new devices
  (normalised, sorted; must be equal) and the 1.19 export (items equal except `repeat`). Outbox
  0 and cursor = head on each. Console has no "ignored N change(s)". The relay head grows only by
  edits plus at most one heartbeat a month per device. The dev screen's storage status shows
  `formatMigration.verified`.
- **Exit:** 14 days with no mismatch, then start the next release.

---

## 13. Prototypes (throwaway, in the session scratchpad, not in the repo)

| # | What | Result |
|---|---|---|
| P1 | Stepper: arithmetic on UTC day numbers; compared with 1.19's `nextRenewal`/`stepDays`; month ends; DST; fuzz | 618,003 comparisons, **0 differences**, in 6 time zones. Fuzz 200k: 0 failures after fixing a bug it found: `Date.UTC` maps years 0–99 to the 1900s, so use `setUTCFullYear`. 100k far-range month queries take about 100–170 ms. 1.19's loop returns 1976 for an 1876 monthly anchor (F13). |
| P2 | Counts per month and year, and the Avg identity | Weekly per month: 4× in 3129 and 5× in 1671 of 4800 months; per year: 52 (329 years), 53 (71). Fortnightly: 2×/3× per month, 26/27 per year. Every 10 days: 2–4 per month. Identity: **0 mismatches**. Example: 150/week in 2027 is 7,800 for the year, Avg 650.00 (nominal 652.22). |
| P3 | Slot clash, two offline devices, lowest free slot vs hash probe, plus repair | Lowest free clashes 88–100% of the time; hash probe 6% (0 groups) to 62% (13 groups, or 2 each). The repair always converged, with 0.06–1.04 moves per merge and no clash left. The same name from the same state gives the same slot. |
| P4 | Palette: text contrast, OKLab distances, normal and Machado-2009 protan/deutan/tritan, both themes | Text: every slot passes (min 4.51 light, 4.50 dark). Slot-order neighbours: normal 33.3 light / 25.8 dark (the F15 claim holds for normal vision), protan 25.1/23.0, deutan 29.2/23.2. **Any pair:** normal min 8.2 (lilac and pink), colour-blind min 1.2 (blue and violet under protan). The computed second lap fails (dark text 4.44; deutan near-duplicate 0.7). g → slot table in 5.3. |
| P4b | Preset slots, searched for en A–Z and Zhuyin orders, all 11 and your 9 | The table in 5.2: neighbours ≥ 23.6 normal and ≥ 16.5 colour-blind, any two presets ≥ 10.9 |
| P5 | Suggest merges, alias table, on your real list | Shopping; Software & cloud (Cloud Storage, AI); Food; Entertainment (News, Gaming, Streaming); Transport (Fuel); Hobbies (Hobbies, Music); Utilities; Housing (House); Education. 13 groups become 9, as in your map. |

**Still to prototype before building:** (1) the 1.19.0 fixture harness (loading the old pure
modules next to the new ones in one test run), which is the most valuable; (2) the item sheet
with presets and Custom at 375 px in both languages; (3) the hand-tuned second-lap table that
passes P4's checks; (4) the extended AI prompt with two or three AI chat tools on real statements
(weekly, quarterly, "every two weeks").

---

## 14. Open questions for you (most plan-changing first)

1. **Release split:** two releases (1.20 foundation and L, 1.21 H; recommended), three, or one?
2. **Anchor semantics:** keep the phase (items count before their date, as today; recommended),
   or make the date a start? A start changes past months on the year chart for existing items.
3. **Readiness check:** warn and allow **Save anyway** (recommended), or block until every device
   is ready?
4. **Old devices' view of new intervals:** nearest cycle at the real date (recommended; old edits
   are safe, amounts approximate), or undated (amounts hidden, but an old edit then loses the
   interval)?
5. **Automatic colours become shared** for the whole household (today they're per device). OK?
6. **Default list:** the 11 in 5.2, with News → Entertainment and MuseScore → Hobbies? Add
   "Media", or "Other"? The zh-TW names marked ⚠, especially 水電瓦斯 vs 生活帳單 for
   Utilities with Internet in it.
7. **Preset colours by distinctness** (5.2, recommended) or by meaning (Housing brown, Food
   orange), which measured ΔE 2.5 under deutan?
8. **g1–g10 mapping:** accept a one-time small colour shift for picked groups? Gold → Lime or
   Yellow?
9. **Insights types:** three buckets relabelled (recommended), or a fourth?
10. **Banner:** one row with ×2 (recommended) or a row per occurrence?
11. **Uncategorised:** an ordinary slot (recommended), or a fixed neutral?
12. **CSV:** Every and Unit appended at the end (recommended)?
13. **Wallet divider follow-up:** I found no note of it in the repo. What do you have in mind?
    It decides how much the palette tests must guarantee for any-pair neighbours.

---

## 15. Next prompts, in order

1. **Test fixture and golden hash:** the 1.19.0 pure-module fixture, `device()` running either
   version, golden values for `colorField`. Tests only, no app change.
2. **Shared stepper:** `js/interval.js`, used by every caller in section 8, with no behaviour
   change. P1's equivalence, the fuzz and the time-zone runs become tests. Fixes F13.
3. **Format-5 readers:** `repeat` and slot reading, loose checks, the heartbeat, backup 5 with the
   export check, mixed-version sync tests (1)–(6).
4. **L:** palette registry and tests, presets, slot assignment, probe and repair, picker, the F5
   migration step with its browser test, merge helper, strings and glossary. Then release 1.20.0
   and soak.
5. **H:** item sheet, labels, Insights types, calendar and banner occurrences, CSV, Import with
   AI, readiness check, strings and glossary. Removes `legacy-step.js`. Then release 1.21.0 and
   soak.
