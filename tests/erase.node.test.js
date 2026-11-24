// Node tests for js/erase.js: when "Erase data on this device" may run (never while this device can
// sync), what it may touch on an origin it can share with other sites (its own preferences prefix,
// its own export files, nothing else), the order of the steps, and what a failure at each step does.
// The browser side (IndexedDB, localStorage, Cache Storage, the sheet) is tests/erase.html. Run with
// `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  eraseBlock, ownPrefKeys, staleExports, runErase, ERASE_STEPS, PREF_PREFIX, LOGO_CACHE, EXPORT_MAX_AGE_MS,
  BLOCKED_NOTICE_MS,
} from '../js/erase.js';
import { LANG_PREF } from '../js/i18n.js';

const root = new URL('../', import.meta.url);

/* When it may run -------------------------------------------------------------------------------- */

test('eraseBlock: refused while this device can sync (in a household, key readable), allowed otherwise', () => {
  const paired = { paired: true, enabled: true, keyUnavailable: false };
  assert.equal(eraseBlock({ syncAvailable: true, status: paired }), 'sync');
  assert.equal(eraseBlock({ syncAvailable: true, status: { ...paired, enabled: false } }), 'sync', 'a paired device with sync paused can still sync again');
  assert.equal(eraseBlock({ syncAvailable: true, status: { ...paired, keyUnavailable: true } }), null, 'a key that can\'t be read sends nothing');
  assert.equal(eraseBlock({ syncAvailable: true, status: { paired: false, enabled: false, wasPaired: true } }), null, 'turned off');
  assert.equal(eraseBlock({ syncAvailable: true, status: { paired: false } }), null, 'never set up');
});

test('eraseBlock: status unreadable where sync could run → unknown; no sync engine at all → allowed', () => {
  assert.equal(eraseBlock({ syncAvailable: true, statusFailed: true }), 'unknown');
  assert.equal(eraseBlock({ syncAvailable: true, status: null }), 'unknown');
  assert.equal(eraseBlock({ syncAvailable: false, statusFailed: true }), null);
  assert.equal(eraseBlock(), null);
});

/* What it may touch ------------------------------------------------------------------------------ */

test('ownPrefKeys: only the substracker. prefix (theme and language included), never another site\'s keys', () => {
  const keys = ['substracker.theme', 'substracker.lang', 'substracker.reduceMotion', 'substracker.tab',
    'substracker', 'substracker-other', 'Substracker.theme', 'other.app', 'theme', 'peek-budget.household-key', null];
  assert.deepEqual(ownPrefKeys(keys), ['substracker.theme', 'substracker.lang', 'substracker.reduceMotion', 'substracker.tab']);
  assert.equal(PREF_PREFIX, 'substracker.');
  assert.ok(LANG_PREF.startsWith(PREF_PREFIX), 'the language preference has the same prefix');
});

test('the prefix and the logo cache name match js/storage.js and sw.js', async () => {
  const storageSrc = await readFile(new URL('js/storage.js', root), 'utf8');
  assert.match(storageSrc, /const PREF_PREFIX = 'substracker\.';/);
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  assert.match(sw, new RegExp(`const LOGO_CACHE = '${LOGO_CACHE}';`));
});

test('staleExports: this app\'s backup and CSV names only, files only, older than 10 minutes', () => {
  const now = Date.parse('2026-11-24T10:00:00Z');
  const old = now - EXPORT_MAX_AGE_MS - 1;
  const files = [
    { name: 'substracker-2026-11-24.json', type: 'file', mtime: old },
    { name: 'substracker-2026-11-20.csv', type: 'file', mtime: old },
    { name: 'substracker-2026-11-24.json', type: 'file', mtime: now - 60_000 }, // just shared: kept
    { name: 'substracker-2026-11-24.json', type: 'file', mtime: now - EXPORT_MAX_AGE_MS }, // exactly 10 minutes: kept
    { name: 'substracker-2026-11-24.json.tmp', type: 'file', mtime: old },
    { name: 'other-2026-11-24.json', type: 'file', mtime: old },
    { name: 'substracker-2026-11-24.json', type: 'directory', mtime: old },
    { name: 'substracker-26-11-24.json', type: 'file', mtime: old },
    { name: 'substracker-2026-11-24.json', type: 'file' }, // no time: kept
    { name: 'image.png', type: 'file', mtime: old },
    null,
  ];
  assert.deepEqual(staleExports(files, now), ['substracker-2026-11-24.json', 'substracker-2026-11-20.csv']);
  assert.deepEqual(staleExports(undefined, now), []);
});

/* The steps -------------------------------------------------------------------------------------- */

/** Fake steps that record their order; `fail` names steps that throw. */
function fakeSteps({ fail = [], blocked = false } = {}) {
  const log = [];
  const steps = {};
  for (const name of ERASE_STEPS) {
    steps[name] = async (arg) => {
      log.push(name);
      if (name === 'database' && blocked) { arg.onBlocked(); log.push('waited'); }
      if (fail.includes(name)) throw new Error(`${name} failed`);
    };
  }
  steps.stop = () => { log.push('stop'); if (fail.includes('stop')) throw new Error('stop failed'); };
  steps.reload = () => { log.push('reload'); };
  return { steps, log };
}

test('runErase: stop, database, secure, prefs, logos, exports, reload, in that order', async () => {
  const { steps, log } = fakeSteps();
  const notes = [];
  const out = await runErase(steps, { beforeReload: async (r) => { notes.push(r); log.push('note'); } });
  assert.deepEqual(out, { outcome: 'erased', failed: [] });
  assert.deepEqual(log, ['stop', 'database', 'secure', 'prefs', 'logos', 'exports', 'note', 'reload']);
  assert.deepEqual(ERASE_STEPS, ['stop', 'database', 'secure', 'prefs', 'logos', 'exports', 'reload']);
});

test('runErase: the database not deleted → failed, nothing after it runs, no reload (retry is safe)', async () => {
  const { steps, log } = fakeSteps({ fail: ['database'] });
  const out = await runErase(steps);
  assert.deepEqual(out, { outcome: 'failed', failed: ['database'] });
  assert.deepEqual(log, ['stop', 'database']);
  const again = fakeSteps();
  assert.equal((await runErase(again.steps)).outcome, 'erased', 'the same erase runs again');
  const { stop } = fakeSteps().steps;
  assert.equal((await runErase({ stop })).outcome, 'failed', 'no database step: never "erased"');
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake steps whose delete reports "blocked" at each of `blockedAt` (ms), then settles at `doneAt` (rejecting with `fails`). */
function heldUpSteps({ blockedAt = [0], doneAt, fails = false }) {
  const { steps, log } = fakeSteps();
  steps.database = ({ onBlocked }) => new Promise((resolve, reject) => {
    log.push('database');
    for (const ms of blockedAt) { if (ms === 0) onBlocked(); else setTimeout(onBlocked, ms); }
    setTimeout(() => { log.push('deleted'); if (fails) reject(new Error('delete failed')); else resolve(); }, doneAt);
  });
  return { steps, log };
}

test('runErase: a delete held up only for a moment (blocked at once, deleted at 100 ms) never says so, then reloads', async () => {
  assert.equal(BLOCKED_NOTICE_MS, 1000, 'about a second');
  const { steps, log } = heldUpSteps({ blockedAt: [0, 40], doneAt: 100 });
  const said = [];
  const out = await runErase(steps, { onBlocked: () => said.push('blocked'), onUnblocked: () => said.push('unblocked') });
  assert.deepEqual(out, { outcome: 'erased', failed: [] });
  assert.equal(log.at(-1), 'reload');
  await wait(BLOCKED_NOTICE_MS + 100);
  assert.deepEqual(said, [], 'never said, not even later');
  const late = heldUpSteps({ blockedAt: [150], doneAt: 100 }); // a stray blocked event after the delete
  const lateSaid = [];
  await runErase(late.steps, { onBlocked: () => lateSaid.push('blocked'), blockedNoticeMs: 20 });
  await wait(100);
  assert.deepEqual(lateSaid, [], 'a blocked event after the delete is never passed on');
});

test('runErase: a delete still held up after the delay → onBlocked once, no reload while waiting, then onUnblocked before anything else', async () => {
  const { steps, log } = heldUpSteps({ blockedAt: [0, 10], doneAt: 200 });
  const run = runErase(steps, {
    blockedNoticeMs: 50, onBlocked: () => log.push('said blocked'), onUnblocked: () => log.push('said unblocked'),
  });
  await wait(25);
  assert.ok(!log.includes('said blocked'), 'not yet: under the delay');
  await wait(75);
  assert.equal(log.filter((x) => x === 'said blocked').length, 1, 'said once the delay has passed, once');
  assert.ok(!log.includes('reload'), 'no reload while it waits');
  assert.deepEqual(await run, { outcome: 'erased', failed: [] });
  assert.deepEqual(log, ['stop', 'database', 'said blocked', 'deleted', 'said unblocked', 'secure', 'prefs', 'logos', 'exports', 'reload']);
});

test('runErase: a held-up delete that then fails → failed, no reload; the words go if they were said', async () => {
  const quick = heldUpSteps({ doneAt: 100, fails: true });
  const saidQuick = [];
  assert.equal((await runErase(quick.steps, { onBlocked: () => saidQuick.push('b'), onUnblocked: () => saidQuick.push('u') })).outcome, 'failed');
  assert.deepEqual(saidQuick, [], 'failed before the delay: never said');
  assert.ok(!quick.log.includes('reload'));
  const slow = heldUpSteps({ doneAt: 150, fails: true });
  const saidSlow = [];
  assert.deepEqual(await runErase(slow.steps, { blockedNoticeMs: 50, onBlocked: () => saidSlow.push('b'), onUnblocked: () => saidSlow.push('u') }),
    { outcome: 'failed', failed: ['database'] });
  assert.deepEqual(saidSlow, ['b', 'u']);
  assert.ok(!slow.log.includes('reload'), 'nothing after the database step');
});

test('runErase: it waits for the delete; it reloads only once deleted', async () => {
  const { steps, log } = fakeSteps({ blocked: true });
  const out = await runErase(steps);
  assert.equal(out.outcome, 'erased');
  assert.deepEqual(log.slice(0, 3), ['stop', 'database', 'waited']);
  let release;
  const pending = { ...fakeSteps().steps, database: () => new Promise((r) => { release = r; }) };
  let reloaded = false;
  pending.reload = () => { reloaded = true; };
  const run = runErase(pending);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reloaded, false, 'still waiting: no reload');
  release();
  await run;
  assert.equal(reloaded, true);
});

test('runErase: later steps that fail → partial (named), the rest still run, then the note and the reload', async () => {
  for (const name of ['secure', 'prefs', 'logos']) {
    const { steps, log } = fakeSteps({ fail: [name] });
    const notes = [];
    const out = await runErase(steps, { beforeReload: async (r) => { notes.push(r.outcome); } });
    assert.deepEqual(out, { outcome: 'partial', failed: [name] }, name);
    assert.deepEqual(log, ['stop', 'database', 'secure', 'prefs', 'logos', 'exports', 'reload'], `${name}: every step still runs`);
    assert.deepEqual(notes, ['partial']);
  }
  const { steps } = fakeSteps({ fail: ['secure', 'logos'] });
  assert.deepEqual((await runErase(steps)).failed, ['secure', 'logos']);
});

test('runErase: failures stopping the engine or deleting cached exports are ignored; a failed note still reloads', async () => {
  const a = fakeSteps({ fail: ['stop', 'exports'] });
  assert.deepEqual(await runErase(a.steps), { outcome: 'erased', failed: [] });
  assert.ok(a.log.includes('database') && a.log.at(-1) === 'reload');
  const b = fakeSteps();
  await runErase(b.steps, { beforeReload: async () => { throw new Error('dialog failed'); } });
  assert.equal(b.log.at(-1), 'reload');
  const c = fakeSteps();
  delete c.steps.secure; delete c.steps.exports; delete c.steps.logos;
  assert.deepEqual(await runErase(c.steps), { outcome: 'erased', failed: [] }, 'a step this platform lacks is skipped');
});

/* The source keeps to its scope ------------------------------------------------------------------ */

test('the erase code never clears a whole origin: no localStorage.clear(), indexedDB.databases() or every cache', async () => {
  const sources = await Promise.all(['js/erase.js', 'js/app.js', 'js/storage.js'].map((f) => readFile(new URL(f, root), 'utf8')));
  const code = sources.map((s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  assert.doesNotMatch(code, /localStorage\.clear\s*\(/);
  assert.doesNotMatch(code, /indexedDB\.databases\s*\(/);
  assert.doesNotMatch(code, /caches\.keys\s*\(/);
  assert.doesNotMatch(code, /deleteDatabase\(\s*['"`]/, 'the database is named by dbName, never by a literal');
  assert.match(sources[2], /indexedDB\.deleteDatabase\(dbName\)/, 'storage deletes its own database by name');
});
