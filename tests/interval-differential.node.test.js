// Differential test for the shared stepper (js/interval.js): 1.19.0's date stepping against the
// current code, over the same large grid in six time zones. Each zone runs in its own process
// (tests/helpers/interval-diff-worker.js, started with that TZ), all six at once.
//
// Per zone, about 1.65 million comparisons: the plan's grid (every anchor day of 2023–2026, monthly,
// annual and an unknown cycle, each month 2020–2030 of the calendar and the cash, the next date
// from 9 offsets: its 618,003 comparisons of calendar days and next dates are in it), the same for
// anchors in São Paulo's last DST years (2016–2019, clocks changed at midnight), one-offs on every
// day of 2023–2026, the due-soon banner's rows for every "today" of 2023–2026 (at the day's first and
// last minute, three windows, a portfolio sampled every 61st day: the one deterministic sample, to
// keep the run well under two minutes), and stored dates outside real data.
//
// Every difference must be one of the two fixed bugs, and they are listed apart:
//   a  years 0–99 (1.19.0 read them as 1900–1999)
//   b  1.19.0's nextRenewal gave up after 1200 steps and returned a date in the past
// Anything else fails the test and is printed. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./helpers/interval-diff-worker.js', import.meta.url));
// The zone, and its UTC offsets in minutes (getTimezoneOffset) on 15 January and 15 July 2026.
const ZONES = {
  'Asia/Taipei': [-480, -480],
  'America/New_York': [300, 240],
  'Europe/London': [0, -60],
  'Pacific/Auckland': [-780, -720],
  'America/Sao_Paulo': [180, 180],
  UTC: [0, 0],
};
const COMPARED = 1647302;
// The fixed bugs' differences, the same in every zone: how many, and a fingerprint of the full list.
const KNOWN = {
  a: { count: 433, sha256: 'be2b3f8a0cd7981a75455489cdd4b050341e052d94ab7afaacd26f3040ebfc61' },
  b: { count: 115, sha256: '05d2fb6fe1d186ab28e47e696143a4227df20085490a599528246531bd5062ad' },
};
const digest = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

function runWorker(tz) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { env: { ...process.env, TZ: tz }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker for ${tz} exited with ${code}: ${err.slice(0, 2000)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`worker for ${tz} printed no result: ${err.slice(0, 2000)}`)); }
    });
  });
}

const results = Promise.all(Object.keys(ZONES).map(runWorker)).then((list) => Object.fromEntries(list.map((r) => [r.tz, r])));

for (const [tz, offsets] of Object.entries(ZONES)) {
  test(`${tz}: the worker really ran in that zone, over the whole grid`, async () => {
    const r = (await results)[tz];
    assert.equal(r.resolved, tz === 'UTC' ? 'UTC' : tz);
    assert.deepEqual(r.offsets, offsets);
    assert.equal(r.compared, COMPARED);
    assert.ok(r.sections.stepDays > 750000 && r.sections.dueInMonth > 750000 && r.sections.nextRenewal > 60000 && r.sections.dueSoon > 9000);
  });

  test(`${tz}: no difference from 1.19.0 apart from the two fixed bugs`, async () => {
    const { unexpected } = (await results)[tz].diffs;
    assert.equal(unexpected.count, 0, `unexpected differences:\n${unexpected.sample.join('\n')}`);
  });

  for (const bug of ['a', 'b']) {
    test(`${tz}: fixed bug ${bug}, its differences listed apart (${KNOWN[bug].count})`, async () => {
      const list = (await results)[tz].diffs[bug].sample;
      assert.equal(list.length, KNOWN[bug].count);
      assert.equal(digest(list), KNOWN[bug].sha256, `bug ${bug} differences changed:\n${list.slice(0, 40).join('\n')}`);
    });
  }
}

// Outside the callers' domain (kept out of the grid above): a year or month that isn't a whole
// number of type number, or a month outside 0–11. On purpose, the current code gives no days and
// no cash for all of them. Where 1.19.0 answered something else, it's listed here.
const OUTSIDE_DIFFERS = {
  // The nine cases from the probe after the stepper went in. Four still differ from 1.19.0 (it
  // answered NaN days or rolled the text '1' into a month); the other five are 1.19.0's answer again.
  'monthly 2026-01-31 (2026, NaN)': { stepDays: [null], due: 100 },
  'monthly 2026-01-31 (NaN, 0)': { stepDays: [null], due: 100 },
  "monthly 2026-01-31 (2026, '1')": { stepDays: [30], due: 100 },
  'annual 2026-01-15 (NaN, 0)': { stepDays: [null], due: 100 },
  // The same rule for a monthly item: 1.19.0 rolled these months over into the next or last year.
  'monthly 2026-01-31 (2026, 12)': { stepDays: [31], due: 100 },
  'monthly 2026-01-31 (2027, -1)': { stepDays: [31], due: 100 },
  'monthly 2026-01-31 (2026, 13)': { stepDays: [28], due: 100 },
  'monthly 2026-01-31 (2026, 1.5)': { stepDays: [28], due: 100 },
};

for (const tz of Object.keys(ZONES)) {
  test(`${tz}: outside the callers' domain, no days and no cash, and exactly these answers differ from 1.19.0`, async () => {
    const { outside } = (await results)[tz];
    assert.equal(outside.length, 28);
    for (const c of outside) assert.deepEqual(c.now, { stepDays: [], due: 0 }, c.label);
    const differs = Object.fromEntries(outside.filter((c) => JSON.stringify(c.old) !== JSON.stringify(c.now)).map((c) => [c.label, c.old]));
    assert.deepEqual(differs, OUTSIDE_DIFFERS);
  });
}

test('the fixed bugs, a few of their differences by example', async () => {
  const { a, b } = (await results)['America/New_York'].diffs;
  for (const line of [
    'parseDate 0050-06-15: 1.19.0 "1950-06-15T00:00", now "50-06-15T00:00"',
    'dueInMonth 0000-02-29 once 0-2: 1.19.0 0, now 100',
    'nextRenewal 0000-02-29 annual from 2026-11-19T12:00: 1.19.0 "2027-03-01T00:00", now "2027-02-28T00:00"',
    'stepDays 0000-02-29 monthly 2026-2: 1.19.0 [1], now [28]',
  ]) assert.ok(a.sample.includes(line), line);
  for (const line of [
    'nextRenewal 1876-01-15 monthly from 2026-11-19T12:00: 1.19.0 "1976-01-15T00:00", now "2026-12-15T00:00"',
    'nextRenewal 0500-06-15 annual from 2026-11-19T12:00: 1.19.0 "1700-06-15T00:00", now "2027-06-15T00:00"',
    'dueSoon 1876-11-20 monthly from 2026-11-19T12:00: 1.19.0 [], now [{"id":"monthly:1876-11-20:expense","date":"2026-11-20T00:00","days":1}]',
  ]) assert.ok(b.sample.includes(line), line);
  assert.ok(!b.sample.some((x) => /^(stepDays|dueInMonth|incomeInMonth) /.test(x)), 'bug b never touched the calendar or the cash');
});
