// Node tests for the import flow's text and steps (js/util.js): the sync lines appear only when
// sync is set up, Replace all asks for a final confirmation, and cancelling at either step
// applies nothing. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importMessage, replaceConfirm, chooseImportMode,
  replaceSyncWarning, mergeSyncNote, replaceConfirmTitle, replaceConfirmMessage, replaceConfirmSync,
} from '../js/util.js';

const summary = (over = {}) => ({ total: 12, existing: 5, added: 3, updated: 2, kept: 1, removed: 1, newerVersion: false, withSettings: true, ...over });
const preview = (over) => ({ merge: summary({ mode: 'merge', ...over }), replace: summary({ mode: 'replace', ...over }) });

/** A fake confirmDialog: answers with the given values in turn and records what it was shown. */
function fakeDialog(...answers) {
  const shown = [];
  const confirm = async (opts) => {
    shown.push(opts);
    const a = answers.shift();
    // undefined means "dismissed": like the real dialog, that picks the first action.
    return a === undefined ? opts.actions[0].value : a;
  };
  return { confirm, shown };
}

/* ------------------------------------------------------------------ Strings */

test('the exact strings', () => {
  assert.equal(replaceSyncWarning(), 'Replace all deletes the current items and settings here and on every device you sync with.');
  assert.equal(mergeSyncNote(), 'Changes are sent to every device you sync with.');
  assert.equal(replaceConfirmTitle(), 'Replace everything?');
  assert.equal(replaceConfirmMessage(), "This deletes all current items and settings on this device. This can't be undone.");
  assert.equal(replaceConfirmSync(), 'It also deletes them on every device you sync with.');
});

test('choice dialog with sync set up: the Replace warning and the Merge note, each on its own line', () => {
  const lines = importMessage(preview(), { synced: true }).split('\n');
  assert.deepEqual(lines.slice(1), [replaceSyncWarning(), mergeSyncNote()]);
  assert.equal(lines[0], importMessage(preview()), 'the rest is unchanged');
});

test('choice dialog without sync: no sync lines', () => {
  const text = importMessage(preview(), { synced: false });
  for (const line of [replaceSyncWarning(), mergeSyncNote()]) assert.equal(text.includes(line), false);
  assert.equal(text.includes('\n'), false);
  assert.equal(importMessage(preview()), text, 'off by default');
});

test('the existing choice wording is kept', () => {
  assert.equal(importMessage(preview()),
    "12 items, 3 new. Merge adds the new ones, updates 2 where the file's copy is newer and keeps 1 where yours is the same or newer. "
    + "Replace deletes your 5 items and uses the file's items and settings (1 of yours aren't in the file).");
  assert.equal(importMessage(preview({ existing: 0, total: 1, added: 1 })), '1 item, 1 new. Your list is empty, so both options give the same result.');
  assert.match(importMessage(preview({ newerVersion: true })), /comes from a newer version/);
});

test('final Replace confirmation: Cancel first and safe, destructive Replace all; sync line only when synced', () => {
  const off = replaceConfirm({ synced: false });
  assert.equal(off.title, 'Replace everything?');
  assert.equal(off.message, replaceConfirmMessage());
  assert.deepEqual(off.actions, [{ label: 'Cancel', value: false }, { label: 'Replace all', value: true, kind: 'danger' }]);
  const on = replaceConfirm({ synced: true });
  assert.deepEqual(on.message.split('\n'), [replaceConfirmMessage(), replaceConfirmSync()]);
  assert.deepEqual(replaceConfirm(), off, 'off by default');
});

/* ------------------------------------------------------------------ Steps */

test('Replace all takes two steps and only then returns replace', async () => {
  const d = fakeDialog('replace', true);
  assert.equal(await chooseImportMode(preview(), { synced: true, confirm: d.confirm }), 'replace');
  assert.deepEqual(d.shown.map((s) => s.title), ['Import this backup?', 'Replace everything?']);
  assert.ok(d.shown[1].message.includes(replaceConfirmSync()));
});

test('cancelling or dismissing the final confirmation returns null, so nothing is applied', async () => {
  for (const answer of [false, undefined]) {
    const d = fakeDialog('replace', answer);
    let applied = false;
    const mode = await chooseImportMode(preview(), { confirm: d.confirm });
    if (mode) applied = true; // what importFile() does with the result
    assert.equal(mode, null);
    assert.equal(applied, false);
    assert.equal(d.shown.length, 2);
  }
});

test('Merge has no second step; cancelling the first dialog asks nothing more', async () => {
  const merge = fakeDialog('merge');
  assert.equal(await chooseImportMode(preview(), { synced: true, confirm: merge.confirm }), 'merge');
  assert.equal(merge.shown.length, 1);
  assert.ok(merge.shown[0].message.endsWith(mergeSyncNote()));
  const cancel = fakeDialog(undefined);
  assert.equal(await chooseImportMode(preview(), { confirm: cancel.confirm }), null);
  assert.equal(cancel.shown.length, 1);
});
