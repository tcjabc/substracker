// FROZEN: js/format-migration.js from Peek Budget 1.25.1 (commit 2135adf), byte for byte below these two lines.
// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).
// Format 5's first-launch step (docs/plan-intervals-groups.md, section 6): the pure parts. Pure (no
// DOM, no storage), shared by js/storage.js (which runs the step as one verified transaction) and the
// Node tests.
//
// The step, in order:
// 1. stepperCheck: on every live item, 1.19.0's date rules (js/legacy-step.js) and the shared stepper
//    (js/interval.js, through util.nextRenewal, calendar-math.stepDays and insights-calc) must give
//    the same next date, the same days and cash in each of 25 months (6 before this one to 18 after)
//    and the same yearly figure for this year and next. Any difference stops the step.
// 2. planColours: this device's automatic colours become shared palette slots. A live expense group
//    with no colour in the household's record and an automatic colour here (w1–w15) adopts that
//    colour as its slot, unless another live group already holds that slot; then it takes the first
//    free one from its probe (js/group-slots.js pickSlot). A live group with no colour at all gets a
//    slot as app.js would give it. Then the household's repair (planSlots). Colours someone picked
//    never move, and old g1–g10 picks are never moved or rewritten.
// 3. This device's version note { v, fmt: 5, at } (storage.versionNoteOps).
// Then storage writes the ops in one transaction, reads the record back (verifyFormatMigration) and
// only then sets meta.schemaVersion to 5. Running it again changes nothing: every planned value is
// in the record by then, so nothing is planned.

import * as legacy from './legacy-step.js';
import { nextRenewal, isIncome, isOnce } from './util.js';
import { stepDays } from './calendar-math.js';
import { dueInMonth, incomeInMonth, yearTotal, groupOf } from './insights-calc.js';
import { slotsFromRecord, planSlots, pickSlot, slotFields, SLOT_COUNT } from './group-slots.js';
import { sameValue, isStamp, compare, DELETED } from './sync-core.js';

/** The data format the step switches to (meta.schemaVersion, the version note's fmt). */
export const FORMAT = 5;
/** The months the stepper check compares, relative to this month. */
export const CHECK_MONTHS = Object.freeze({ before: 6, after: 18 });

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null);
const yearOf = (str) => (typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) ? Number(str.slice(0, 4)) : null);

/**
 * Whether an item is outside what 1.19.0's rules could ever work out right, so comparing would only
 * find 1.19.0's own faults (docs/plan-intervals-groups.md F13): a date in the years 0–99 (its Date
 * constructor reads them as 1900–1999), or a recurring date so far back that its 1200-step walk can't
 * reach the compared months.
 */
function beyondLegacy(s, now) {
  const y = yearOf(isOnce(s) ? s.date : s.nextRenewal);
  if (y === null) return false; // undated or unreadable: both sides have nothing
  if (y < 100) return true;
  if (isOnce(s)) return false;
  const back = (now.getFullYear() - y) * 12 + now.getMonth() + 12 - CHECK_MONTHS.before;
  return back >= (s.cycle === 'annual' ? legacy.LEGACY_GUARD * 12 : legacy.LEGACY_GUARD) - 24;
}

/** The app's own functions the check compares with 1.19.0's (stepperCheck can be given others, for its tests). */
export const CURRENT = Object.freeze({
  nextRenewal, stepDays, dueInMonth, incomeInMonth, yearTotal: (s, y) => yearTotal([s], y),
});

/** The first place `s` (its `repeat` set aside) differs between 1.19.0 and `cur`, or null. */
function firstDifference(s, now, cur) {
  if (ymd(legacy.nextRenewal(s, now)) !== ymd(cur.nextRenewal(s, now))) return 'next date';
  for (let k = -CHECK_MONTHS.before; k <= CHECK_MONTHS.after; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const [y, m] = [d.getFullYear(), d.getMonth()];
    if (!sameValue(legacy.stepDays(s, y, m), cur.stepDays(s, y, m))) return 'calendar days';
    if (legacy.dueInMonth(s, y, m) !== cur.dueInMonth(s, y, m)) return 'cash due';
    if (legacy.incomeInMonth(s, y, m) !== cur.incomeInMonth(s, y, m)) return 'income';
  }
  if (!isIncome(s)) {
    for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
      if (legacy.amountInYear(s, y) !== cur.yearTotal(s, y)) return 'yearly total';
    }
  }
  return null;
}

/**
 * Step 1, read-only: { checked, diff, skipped, custom, first }. Every item is compared on its own
 * cycle (a `repeat` it may carry from a format-5 file is set aside: 1.19.0 never had one), so this
 * checks the stepper, not the item. `custom` counts the items that carry a repeat (information
 * only), `skipped` those beyondLegacy, `first` the first difference found ('next date', …) or null.
 */
export function stepperCheck(items, now = new Date(), cur = CURRENT) {
  const out = { checked: 0, diff: 0, skipped: 0, custom: 0, first: null };
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue;
    const s = { ...item };
    if ('repeat' in s) { delete s.repeat; out.custom++; }
    if (beyondLegacy(s, now)) { out.skipped++; continue; }
    out.checked++;
    const d = firstDifference(s, now, cur);
    if (d) { out.diff++; out.first ??= d; }
  }
  return out;
}

/** The slot an automatic Wallet colour (w1–w15) draws, or null. */
const wSlot = (swatch) => {
  const m = /^w([1-9]|1[0-5])$/.exec(String(swatch ?? ''));
  return m ? Number(m[1]) - 1 : null;
};
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The live expense groups of `items`, in code-point order (the same on every device and language).
 * Only names a colour value can carry (1–40 characters, storage's isGroupName): another device
 * would refuse anything longer, and a refused op is lost for good.
 */
export const liveGroups = (items) => [...new Set((items ?? []).filter((s) => s && !isIncome(s)).map(groupOf))]
  .filter((n) => n.length <= 40).sort(byCodePoint);

/**
 * Step 2, pure: what to write for this device's live expense groups, from `items` (live), `record`
 * (the settings record, or null) and `autoColors` (this device's own automatic colours, name → wN).
 * Returns { adopted: [{ name, slot, from }], assigned: [{ name, slot }], moved: [{ name, slot }],
 * fields: the settings-record fields to set }. Only fields the record lacks are planned, plus the
 * household's repair of automatic slots; a pick (a g colour, or a w colour someone chose) is never
 * in `fields`.
 */
export function planColours({ items, record, autoColors }) {
  const names = liveGroups(items);
  const { shared: all, picks } = slotsFromRecord(record);
  const shared = new Map([...all].filter(([n]) => names.includes(n)));
  const counts = new Array(SLOT_COUNT).fill(0);
  for (const v of shared.values()) counts[v.slot]++;

  const adopted = [];
  for (const name of names) {
    if (shared.has(name) || picks.has(name)) continue;
    const from = wSlot(autoColors?.[name]);
    if (from === null) continue;
    // Its own colour, unless a live group in the record holds it; then its probe (past 15, they repeat).
    const slot = counts[from] === 0 ? from : (pickSlot(name, counts, { free: true }) ?? pickSlot(name, counts));
    counts[slot]++;
    adopted.push({ name, slot, from });
  }

  // The rest as app.js ensureGroupColors does it, the adopted ones counting as written now (newest).
  const withAdopted = new Map(shared);
  for (const a of adopted) withAdopted.set(a.name, { slot: a.slot, auto: true, ts: '~' });
  const held = new Map(names.filter((n) => picks.has(n) && !withAdopted.has(n)).map((n) => [n, null]));
  const plan = planSlots({ live: names, shared: withAdopted, held });

  const final = new Map(adopted.map((a) => [a.name, a.slot]));
  for (const a of plan.assign) final.set(a.name, a.slot);
  for (const m of plan.moves) final.set(m.name, m.slot);
  const moved = plan.moves.filter((m) => !adopted.some((a) => a.name === m.name));
  return {
    adopted: adopted.map((a) => ({ ...a, slot: final.get(a.name) })),
    assigned: plan.assign,
    moved,
    fields: slotFields([...final].map(([name, slot]) => ({ name, slot }))),
  };
}

/**
 * The read-back check, after the write: null when it holds, else what's wrong (counts only).
 * - The record exists and has no `del` (it must never become an item).
 * - Every planned field (`planned`: field → value, `stamps`: field → the stamp it was written with)
 *   has a stamp, and holds the planned value, or a value with a newer stamp (another device's, never
 *   an older one: nothing planned was lost).
 * - Every live expense group of `items` resolves: a colour value that holds a slot, or an old g pick.
 * - This device's version note (`noteField`) is there with fmt 5 or more.
 */
export function verifyFormatMigration({ record, planned = {}, stamps = {}, items = [], noteField }) {
  if (!record || typeof record !== 'object' || !record.fields) return 'no settings record';
  if (DELETED in record.fields) return 'the settings record looks like an item';
  let lost = 0;
  const want = Object.keys(planned);
  for (const f of want) {
    const t = record.ts?.[f];
    if (!isStamp(t)) { lost++; continue; }
    if (t === stamps[f]) { if (!sameValue(record.fields[f], planned[f])) lost++; } else if (!(isStamp(stamps[f]) && compare(t, stamps[f]) > 0)) lost++;
  }
  if (lost) return `${lost} of ${want.length} planned fields missing or changed`;
  const { shared, picks } = slotsFromRecord(record);
  const names = liveGroups(items);
  const open = names.filter((n) => !picks.has(n) && !shared.has(n)).length; // shared: values that hold a slot
  if (open) return `${open} of ${names.length} groups without a slot`;
  const note = record.fields?.[noteField];
  if (!note || !Number.isInteger(note.fmt) || note.fmt < FORMAT) return 'no version note';
  return null;
}
