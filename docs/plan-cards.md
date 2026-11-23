# Plan: payment cards

Status: **Release A (groundwork) is built** as 1.26.0 / versionCode 39 (on `main` at `a065fcb`): no
visible UI change. **Release B (the cards UI) is built** on branch `cards-ui` as 1.27.0 / versionCode
40, from `main` at `a065fcb`: Settings → Payment cards and the card sheet, the item sheet's Payment
method, the Wallet chip, and Import with AI's Paid with (section 4). **Release C is not built**:
Calendar and due-soon card dates, Insights "Paid with", statement amounts, native notifications
(section 5).

## 1. Data

- A card is one field of the shared settings record (`js/storage.js` `SETTINGS_ID`): `card_<id>`
  with `{ name, colour, cut, due }`. `cut` and `due` are days of the month (1-31) or null. A deleted
  card keeps its value with `gone: true` (a tombstone), so a device that hasn't seen the delete
  can't bring the card back with an older value.
- Card ids: `[A-Za-z0-9_]`, 1-59 characters (so `card_<id>` is at most 64, `js/sync-core.js`
  `FIELD_RE`), never `cash` in any case. A dash makes an op every version refuses for good, so the
  new code throws before making one (`cardOps`) and never writes one from a file (`fileCards`).
- Cards are written only with `setFields` on the settings record: never `createRecord` or
  `putRecord` on a record of their own (an old device would show it as a blank item), never `del`.
- Each expense item may have `pay`: `''` Not set (the same as no field; never null, because the
  item sheet's `mergeFormEdit` compares a missing field with `''`), `'cash'`, or a card id.
- Sync is unchanged: `acceptableSetting` keeps any `card_*` value and `acceptableRemote` keeps any
  `pay` value (`UNCHECKED_FIELDS`, before the string rule). A value this version can't use reads
  as no card (`listCards`) or Not set (`payOf`). No type check can skip an op.
- `js/cards.js` holds the pure parts: `isCardId`, `cardFieldName`, `cardIdOf`, `parseCardValue`,
  `cardValue`, `cardTombstone`, `listCards`, `cardMap`, `payOf`, `isPayValue`.

## 2. Backup format 6

Format 5 plus `settings.cards` (live cards, `{}` for none) and each item's `pay`. The exporter
writes it only when there is a live card or an item with a non-empty `pay`; otherwise the file is
format 5, byte for byte as 1.25.1 wrote it (`tests/fixtures/backup-format5-1.25.1.json`). The
export check reads the cards and every `pay` back; when it fails the file falls back to format 5
(or 4) and the app says the cards are not in it (`settings.export.doneNoCards`).

Import reads formats 3-6. Merge adds and updates the file's cards and deletes none. Replace takes
the file's cards as the whole set (a live card here that the file lacks becomes a tombstone), the
way it takes group colours, but only when the file carries `settings.cards`. A format 3-5 file
leaves cards alone, and leaves a stored `pay` alone (an older file can't say how an item is paid).
1.19.0 and 1.25.1 read a format 6 file with the "newer version" note, import every item and leave
the cards out.

## 3. Migration plan (modelled on 1.23.0)

There is no data to convert, so there is no first-launch step. The risk-bearing changes:

| | Read-only | Writes | Read-back | On failure | Why an old device loses nothing |
|---|---|---|---|---|---|
| (a) Export | Everything: it reads items and settings and writes a file. | Only the file. | `checkBackup` reads the payload back with this version's reader and 1.19.0's rules; for format 6 also the cards and every `pay`. | Falls back to format 5, else 4, and says on screen that the cards aren't in the file. | Without cards it is the same format 5 file as before. A format 6 file imports on 1.19.0 and 1.25.1 as a newer one, items intact. |
| (b) Import | Parsing and planning. | One transaction of ops: items with `putRecord` (Not set never written over no `pay`), cards with `setFields` on the settings record. | Tests read the card fields and `pay` back from the record after each import. | A bad file throws before any op; a failed write aborts the one transaction: nothing changes. | Every op is one an old device stores (valid field names, no `del` on settings, no card record). |
| (c) Version-note refresh | Reads this device's note. | Only its own `app_<hash>` field, with `setFields`, when it's missing, another version or format, or over 30 days old. | Browser tests read the record back. | Silent; nothing written; tried again on the next launch. | 1.19.0 and 1.25.1 keep the field and ignore it, as they do today. |
| (d) A card saved in the card sheet (1.27.0) | The record, for the id check and the stored value. | One `setFields` op on the settings record (`card_<id>`), merged over the stored value so a later version's keys stay (`cardOps` `keepUnknown`). | tests/cards-ui.test.js reads the card field back from the record. | One commit: nothing changes; the existing error toast. | A valid field name on every version; settings never get `del`; no card is a record of its own. |
| (e) An item saved with a new card (1.27.0) | The record and the item. | ONE commit over the settings record and the item: the card's `setFields` op and the item's `putRecord` ops (only fields that changed; Not set on a new item writes no `pay`). | Browser and mixed-harness tests read both back; a bad card id stores neither. | All or nothing: no card without its item, no item pointing at a card that wasn't stored; the existing error toast. | As (d); `pay` is a field every version keeps (1.19.0 and 1.25.1 copy every stored field). |
| (f) A card deleted (1.27.0) | Every record, to find the live items paid with it. | ONE commit: the tombstone (`gone: true`, `setFields`) and `pay: ""` on each of those items (`putRecord` with that one field, nothing else). | The delete test reads every affected item's `pay` as `""` and the tombstone, from the same commit. | All or nothing; the existing error toast. | As (d) and (e). An item that names a card this device doesn't know (sync order, another device's delete) reads as Not set and keeps its `pay` until someone changes the drop-down. |

## 4. Release B (built: 1.27.0)

- **Settings → Payment cards** (between Groups and Sync; never "Cards", the Money view's name), shown
  once settings are shared, which is the local format 4 step, not pairing: an unsynced device has
  cards too. A row per live card ("Edit card {name}"), Add card, and the card sheet: Nickname (at
  most 40; refused when it has 13 or more digits in a run read through spaces and dashes after NFKC),
  ten colours `c1` … `c10`, Statement closing day and Payment due day (kept, promising nothing yet).
  A nickname that is already a card picks it. Delete says how many items use the card and sets them
  back to Not set in the same commit as the tombstone.
- **The item sheet:** Payment method under More details, after the New group field: Not set, Cash,
  the cards, then "Add new card…" with an inline nickname field (the 1.25.0 category pattern). A new
  card is stored with its item in one commit. A `pay` the drop-down didn't show is kept unless the
  person changes it.
- **The Wallet:** a chip with the card's glyph on the logo tile of an item paid with a live card,
  aria-hidden; the item's label names the card. Not in Grid or List.
- **Import with AI:** one Paid with for every expense row and a row's own pick; cards stay out of the
  prompt and the reply; the file stays format 4 with no settings.
- **Colours:** ten fills apart from each other (also under colour-vision simulation), not from the
  group colours; the glyph's outline is the theme's text colour (tests/card-palette.node.test.js).
- The readiness check was dropped: old devices keep `card_*` and `pay` (section 3).

## 5. Release C (not built)

Calendar and due-soon card dates (the cut-off and due days), Insights "Paid with", statement
amounts and native notifications.
