// Node tests for js/pairing.js: which way a device joins, the confirmations, and status wording.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseJoinMode, confirmStart, sheetView, statusText, summaryText, replaceConfirm, JOIN_REPLACE, JOIN_MERGE } from '../js/pairing.js';

/** A fake `ask` that answers from a list, and a fake confirm that records what it was asked. */
function script(answers, confirmAnswer = true) {
  const asked = [];
  const confirms = [];
  let exports = 0;
  return {
    asked, confirms, get exports() { return exports; },
    ask: async (n) => { asked.push(n); return answers.shift() ?? null; },
    confirm: async (d) => { confirms.push(d); return confirmAnswer; },
    exportBackup: async () => { exports++; },
  };
}

test('an empty device just joins with the household data, without asking', async () => {
  const s = script([]);
  assert.equal(await chooseJoinMode({ localItems: 0, ...s }), JOIN_REPLACE);
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.confirms, []);
});

test('a device with items is asked; merge goes straight ahead', async () => {
  const s = script([JOIN_MERGE]);
  assert.equal(await chooseJoinMode({ localItems: 3, ...s }), JOIN_MERGE);
  assert.deepEqual(s.asked, [3]);
  assert.deepEqual(s.confirms, [], 'no second question for merge');
});

test('replace needs a second yes; no means nothing happens', async () => {
  const yes = script([JOIN_REPLACE], true);
  assert.equal(await chooseJoinMode({ localItems: 2, ...yes }), JOIN_REPLACE);
  assert.equal(yes.confirms.length, 1);
  assert.match(yes.confirms[0].message, /The 2 items on this device will be replaced/);
  assert.equal(yes.confirms[0].actions[0].value, false, 'Cancel first (Escape picks it)');

  const no = script([JOIN_REPLACE], false);
  assert.equal(await chooseJoinMode({ localItems: 2, ...no }), null);
});

test('cancel, or anything unexpected, joins nothing', async () => {
  for (const answer of [null, undefined, 'something else']) {
    const s = script([answer]);
    assert.equal(await chooseJoinMode({ localItems: 1, ...s }), null, String(answer));
  }
});

test('export a backup first, then ask again', async () => {
  const s = script(['export', 'export', JOIN_MERGE]);
  assert.equal(await chooseJoinMode({ localItems: 5, ...s }), JOIN_MERGE);
  assert.equal(s.exports, 2);
  assert.deepEqual(s.asked, [5, 5, 5]);
});

test('replace wording: singular and plural', () => {
  assert.match(replaceConfirm(1).message, /The 1 item on this device/);
  assert.match(replaceConfirm(4).message, /The 4 items on this device/);
});

test('starting a new household warns only a device that was in one before', async () => {
  const s = script([], false);
  assert.equal(await confirmStart({ wasPaired: false }, s.confirm), true);
  assert.equal(s.confirms.length, 0);
  assert.equal(await confirmStart({ wasPaired: true }, s.confirm), false);
  assert.match(s.confirms[0].message, /other devices stay on that household/);
  const ok = script([], true);
  assert.equal(await confirmStart({ wasPaired: true }, ok.confirm), true);
});

test('which screen the sheet opens on, and the status wording', () => {
  assert.equal(sheetView({ paired: false }), 'setup');
  assert.equal(sheetView(null), 'setup');
  assert.equal(sheetView({ paired: true, keyUnavailable: false }), 'active');
  assert.equal(sheetView({ paired: true, keyUnavailable: true }), 'setup', 'join again when the key is unreadable');
  assert.equal(statusText({ state: 'ok' }), 'Up to date');
  assert.equal(statusText({ state: 'syncing' }), 'Syncing…');
  assert.equal(statusText({ state: 'offline', lastError: 'x' }), 'Offline');
  assert.equal(statusText({ state: 'error', lastError: "Can't reach the relay." }), "Error: Can't reach the relay.");
  assert.equal(summaryText({ paired: false }, { state: 'off' }), 'Off');
  assert.equal(summaryText({ paired: true, enabled: true }, { state: 'ok' }), 'On · Up to date');
  assert.equal(summaryText({ paired: true, enabled: false }, { state: 'off' }), 'Paused on this device');
  assert.equal(summaryText({ paired: true, enabled: true, keyUnavailable: true }, { state: 'error' }), 'Needs the 12 words on this device');
});
