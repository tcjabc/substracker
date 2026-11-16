// Node tests for the import dialog's text (js/util.js importMessage): the Replace warning about
// synced devices appears on its own line only when sync is set up. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importMessage, REPLACE_SYNC_WARNING } from '../js/util.js';

const summary = (over = {}) => ({ total: 12, existing: 5, added: 3, updated: 2, kept: 1, removed: 1, newerVersion: false, withSettings: true, ...over });
const preview = (over) => ({ merge: summary({ mode: 'merge', ...over }), replace: summary({ mode: 'replace', ...over }) });

test('the Replace warning names this device and every synced device', () => {
  assert.equal(REPLACE_SYNC_WARNING, 'Replace all deletes the current items and settings here and on every device you sync with.');
});

test('with sync set up, the warning is added on its own line', () => {
  const text = importMessage(preview(), { synced: true });
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], REPLACE_SYNC_WARNING);
  assert.equal(lines[0], importMessage(preview()), 'the rest is unchanged');
});

test('without sync, there is no warning', () => {
  const text = importMessage(preview(), { synced: false });
  assert.equal(text.includes(REPLACE_SYNC_WARNING), false);
  assert.equal(text.includes('\n'), false);
  assert.equal(importMessage(preview()), text, 'off by default');
});

test('the existing wording is kept', () => {
  assert.equal(importMessage(preview()),
    "12 items, 3 new. Merge adds the new ones, updates 2 where the file's copy is newer and keeps 1 where yours is the same or newer. "
    + "Replace deletes your 5 items and uses the file's items and settings (1 of yours aren't in the file).");
  assert.equal(importMessage(preview({ existing: 0, total: 1, added: 1 })), '1 item, 1 new. Your list is empty, so both options give the same result.');
  assert.match(importMessage(preview({ newerVersion: true })), /comes from a newer version/);
});
