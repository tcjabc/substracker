// Node tests for the pure parts of the "Import with AI" screens: the slide-to-confirm control's
// rules (js/slide-confirm.js), the optional backup button in the Merge / Replace flow and the
// dialog text for AI rows (js/util.js, js/import-ai.js). The screens themselves are covered by
// the browser tests. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slideFraction, slideRelease, slideKey, SLIDE_DONE, SLIDE_LOCK_MS } from '../js/slide-confirm.js';
import { chooseImportMode, backupLabel, importMessage, REPLACE_CONFIRM_TITLE } from '../js/util.js';
import { aiImportMessage, aiReplaceConfirm, AI_CHOICE_TITLE, AI_REPLACE_TITLE, AI_REPLACE_SYNC_WARNING } from '../js/import-ai.js';

/* ------------------------------------------------------------------ Slide to confirm */

test('the slider is locked for about two seconds and must reach the end', () => {
  assert.equal(SLIDE_LOCK_MS, 2000);
  assert.ok(SLIDE_DONE > 0.85 && SLIDE_DONE < 1);
  assert.equal(slideRelease(1, true), 'back', 'locked: springs back even at the end');
  assert.equal(slideRelease(1, false), 'done');
  assert.equal(slideRelease(SLIDE_DONE, false), 'done');
  assert.equal(slideRelease(SLIDE_DONE - 0.01, false), 'back', 'released early: springs back');
  assert.equal(slideRelease(0, false), 'back');
});

test('dragging maps pixels to 0–1 along the track, clamped', () => {
  assert.equal(slideFraction(0, 150, 300), 0.5);
  assert.equal(slideFraction(0, -40, 300), 0);
  assert.equal(slideFraction(0, 900, 300), 1);
  assert.equal(slideFraction(0.5, 75, 300), 0.75);
  assert.equal(slideFraction(0, 100, 0), 0, 'a hidden track (no width) never moves');
});

test('keys: arrows step, Home and End jump, other keys are ignored', () => {
  assert.equal(slideKey('ArrowRight', 0), 0.25);
  assert.equal(slideKey('ArrowUp', 0.75), 1);
  assert.equal(slideKey('ArrowLeft', 0), 0);
  assert.equal(slideKey('End', 0), 1);
  assert.equal(slideKey('Home', 0.75), 0);
  assert.equal(slideKey('Enter', 0), null);
  assert.equal(slideKey('a', 0), null);
});

/* ------------------------------------------------------------------ Optional backup */

test('the backup label mentions the item count and shows when it was saved', () => {
  assert.equal(backupLabel(0), 'Export a backup first');
  assert.equal(backupLabel(1), 'Export a backup first (1 item)');
  assert.equal(backupLabel(12), 'Export a backup first (12 items)');
  assert.equal(backupLabel(12, true), 'Backup saved ✓');
});

const summary = (over = {}) => ({ total: 3, existing: 5, added: 3, updated: 0, kept: 0, removed: 5, newerVersion: false, withSettings: false, ...over });
const preview = (over) => ({ merge: summary({ mode: 'merge', ...over }), replace: summary({ mode: 'replace', ...over }) });

function fakeDialog(...answers) {
  const shown = [];
  const confirm = async (opts) => {
    shown.push(opts);
    const a = answers.shift();
    return a === undefined ? opts.actions[0].value : a;
  };
  return { confirm, shown };
}

test('without a backup callback the flow is exactly as before', async () => {
  const { confirm, shown } = fakeDialog('replace', true);
  assert.equal(await chooseImportMode(preview(), { confirm }), 'replace');
  assert.deepEqual(shown[0].actions.map((a) => a.label), ['Cancel', 'Replace all', 'Merge']);
  assert.equal(shown[0].title, 'Import this backup?');
  assert.equal(shown[0].message, importMessage(preview()));
  assert.equal(shown[1].title, REPLACE_CONFIRM_TITLE);
  assert.deepEqual(shown[1].actions.map((a) => a.label), ['Cancel', 'Replace all']);
});

test('the backup sits beside Replace all at both steps, runs, and never blocks', async () => {
  let runs = 0;
  const backup = async () => { runs++; return true; };
  const { confirm, shown } = fakeDialog('backup', 'replace', 'backup', true);
  const mode = await chooseImportMode(preview(), { confirm, backup, count: 5, title: AI_CHOICE_TITLE, message: 'm', replace: aiReplaceConfirm() });
  assert.equal(mode, 'replace');
  assert.equal(runs, 2);
  assert.deepEqual(shown.map((s) => s.actions.map((a) => a.label)), [
    ['Cancel', 'Export a backup first (5 items)', 'Replace all', 'Merge'],
    ['Cancel', 'Backup saved ✓', 'Replace all', 'Merge'],
    ['Cancel', 'Backup saved ✓', 'Replace all'],
    ['Cancel', 'Backup saved ✓', 'Replace all'],
  ]);
  assert.deepEqual(shown.map((s) => s.title), [AI_CHOICE_TITLE, AI_CHOICE_TITLE, AI_REPLACE_TITLE, AI_REPLACE_TITLE]);
  assert.equal(shown[0].actions[0].value, null, 'Cancel stays first, so dismissing (Back) cancels');
});

test('a backup that fails or is closed changes nothing, and Merge works without one', async () => {
  const backup = async () => { throw new Error('share sheet failed'); };
  const { confirm, shown } = fakeDialog('backup', 'merge');
  assert.equal(await chooseImportMode(preview(), { confirm, backup, count: 2 }), 'merge');
  assert.equal(shown[1].actions[1].label, 'Export a backup first (2 items)', 'not marked saved');
  const closed = fakeDialog('backup', undefined);
  assert.equal(await chooseImportMode(preview(), { confirm: closed.confirm, backup: async () => false }), null, 'dismissed: nothing imported');
});

test('cancelling (or Back) at either step imports nothing, with the backup offered', async () => {
  const backup = async () => true;
  assert.equal(await chooseImportMode(preview(), { confirm: fakeDialog(undefined).confirm, backup }), null);
  assert.equal(await chooseImportMode(preview(), { confirm: fakeDialog('replace', undefined).confirm, backup }), null);
  assert.equal(await chooseImportMode(preview(), { confirm: fakeDialog('replace', false).confirm, backup }), null);
});

/* ------------------------------------------------------------------ Dialog text for AI rows */

test('the choice text for AI rows: adds only, settings stay, sync lines when synced', () => {
  assert.equal(aiImportMessage({ total: 3, existing: 5 }),
    '3 items to add. Merge adds them to your 5 items. Replace all deletes your 5 items and keeps only these 3. Your default currency and group colours stay as they are.');
  assert.equal(aiImportMessage({ total: 1, existing: 0 }), '1 item to add. Your list is empty, so both options give the same result.');
  const lines = aiImportMessage({ total: 3, existing: 5 }, { synced: true }).split('\n');
  assert.deepEqual(lines.slice(1), [AI_REPLACE_SYNC_WARNING, 'Changes are sent to every device you sync with.']);
  assert.match(aiReplaceConfirm().message, /Settings stay as they are\. This can't be undone\.$/);
  assert.match(aiReplaceConfirm({ synced: true }).message, /\nIt also deletes them on every device you sync with\.$/);
  assert.deepEqual(aiReplaceConfirm().actions.map((a) => a.value), [false, true]);
});

/* ------------------------------------------------------------------ The screens' text */

// Kept reversed so the names themselves don't appear in the source either.
const NAMES = ['tpgtahc', 'ianepo', 'edualc', 'ciporhtna', 'inimeg', 'drab', 'tolipoc', 'tfosorcim', 'elgoog', 'ytixelprep',
  'lartsim', 'amall', 'korg', 'keespeed', 'newq', 'yenruojdim', 'iax'].map((s) => [...s].reverse().join(''));

test('the new screens name no AI product or company and make no network calls', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const sheet = html.slice(html.indexOf('<dialog class="sheet" id="ai-dialog"'), html.indexOf('</dialog>', html.indexOf('id="ai-dialog"')));
  const row = html.slice(html.indexOf('Import with AI'), html.indexOf('id="btn-import-ai"'));
  assert.ok(sheet.length > 1000 && row.length > 10);
  for (const [name, src] of [['sheet markup', sheet], ['settings row', row],
    ['js/import-ai-sheet.js', readFileSync(new URL('../js/import-ai-sheet.js', import.meta.url), 'utf8')],
    ['js/slide-confirm.js', readFileSync(new URL('../js/slide-confirm.js', import.meta.url), 'utf8')]]) {
    const lower = src.toLowerCase();
    for (const n of NAMES) assert.equal(new RegExp(`\\b${n}\\b`).test(lower), false, `${name} names "${n}"`);
    for (const api of ['fetch(', 'xmlhttprequest', 'websocket', 'sendbeacon', 'eventsource', 'http://', 'https://']) {
      assert.equal(lower.includes(api), false, `${name} uses ${api}`);
    }
  }
});

test('the warning screen says what the brief asks for', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const s of [
    'Peek Budget has no connection to any AI service. The app never sends anything: what you upload is between you and the provider you choose.',
    'Privacy claims belong to each provider and can change. Check them yourself before you upload anything.',
    'Remove account numbers, card numbers and names first. The app only needs the merchant, amount and date.',
    'AI can misread documents, so check every row before you import.',
    'Nothing is imported until you confirm.',
    "Look for one that says it keeps no chat logs, doesn't train on your data, and has a temporary or incognito chat mode.",
    'aria-label="Slide to confirm you\'ve read this"', 'role="slider"', 'data-slide-check',
    'Copy error for your AI', 'data-ai-backup',
  ]) assert.ok(html.includes(s), s);
});
