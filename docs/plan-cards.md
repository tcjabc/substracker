# Plan: payment cards

Status: **Release A (groundwork) is built** on branch `cards-groundwork` as 1.26.0 / versionCode 39,
from `main` at 1.25.1 (`2135adf`, versionCode 38). It has no visible UI change. **Release B (the
card UI) is not built**: Settings screen, add-sheet field, Wallet chip, Calendar, due-soon and
Insights changes, Import with AI.

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

## 4. Release B (not built)

Card UI in Settings, the add-sheet field, the Wallet chip, Calendar, due-soon and Insights. Before
it ships, check the household's version notes (now refreshed on launch) to see which devices are on
1.26.0 or later.
