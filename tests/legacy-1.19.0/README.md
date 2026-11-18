# Frozen 1.19.0 modules

**These files are frozen. Never edit, reformat or update them.** They are exact copies of the
Peek Budget 1.19.0 modules (commit `08bcdc4`), each with only a two-line header comment added at
the top. They stand in for "a household device that is still on 1.19.0" in the mixed-version sync
tests (`tests/helpers/mixed-sync.js`, `tests/mixed-version.scenarios.js`). They let a later version prove
that it never sends 1.19.0 an op that it drops for good, or a value that it shows wrongly or loses
(see `docs/plan-intervals-groups.md`, sections 2 and 7).

- `tests/legacy-fixture.node.test.js` checks every byte: the header, and the SHA-256 of the
  original 1.19.0 file under it. An accidental edit, a formatter or a line-ending change fails
  `npm test`.
- The files keep 1.19.0's own bytes: LF line ends, as stored in git at `08bcdc4`.
  `.gitattributes` marks `tests/legacy-1.19.0/**/*.js` as `-text`, so no checkout converts them.
- `storage.js`, `sync.js`, `sync-core.js`, `crypto.js`, `util.js`, `i18n.js`, `services.js`,
  `insights-calc.js`, `wallet-math.js` and `locales/en.js` are imported by the tests: their imports resolve to
  each other, never to `js/`. `app.js` is never imported (it needs a DOM). The tests read it as
  text and run its item-form functions (`readForm`, `mergeFormEdit`, and the field filling in
  `openForm`) with stand-ins for the page.
- `locales/zh-TW.js` isn't copied: 1.19.0 loads it only when that language is chosen, and these
  tests never choose it.

If a future release needs a second frozen device (say 1.20.0), add a new folder next to this one.
Don't change this one.
