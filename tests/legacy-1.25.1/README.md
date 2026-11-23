# Frozen 1.25.1 modules

**These files are frozen. Never edit, reformat or update them.** They are exact copies of the
Peek Budget 1.25.1 modules (commit `2135adf`, versionCode 38), each with only a two-line header
comment added at the top. They stand in for "a household device that is still on 1.25.1" in the
mixed-version sync tests (`tests/helpers/mixed-sync.js`, version `legacy125`), next to the 1.19.0
device in `tests/legacy-1.19.0/`. 1.25.1 is the last version before payment cards (1.26.0,
`docs/plan-cards.md`): it doesn't know `pay` or `card_*` fields, and reads backup formats up to 5.
The tests use it to prove that a newer version never sends it an op it drops for good, or a value
it shows wrongly or loses.

- `tests/legacy-fixture.node.test.js` checks every byte: the header, and the SHA-256 of the
  original 1.25.1 file under it. An accidental edit, a formatter or a line-ending change fails
  `npm test`.
- The files keep 1.25.1's own bytes: LF line ends, as stored in git at `2135adf`.
  `.gitattributes` marks `tests/legacy-1.25.1/**/*.js` as `-text`, so no checkout converts them.
- `storage.js`, `sync.js`, `sync-core.js`, `crypto.js`, `util.js`, `i18n.js`, `services.js`,
  `interval.js`, `format-migration.js`, `legacy-step.js`, `calendar-math.js`, `insights-calc.js`,
  `group-slots.js`, `wallet-math.js`, `category-select.js` and `locales/en.js` are imported by the
  tests: their imports resolve to each other, never to `js/`. `app.js` is never imported (it needs a
  DOM). The tests read it as text and run its item-form functions (`readForm`, `mergeFormEdit`, and
  the field filling in `openForm`) with stand-ins for the page.
- `locales/zh-TW.js` isn't copied: 1.25.1 loads it only when that language is chosen, and these
  tests never choose it.

If a future release needs another frozen device, add a new folder next to this one. Don't change
this one.
