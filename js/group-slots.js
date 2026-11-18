// Shared palette slots for groups' automatic colours (docs/plan-intervals-groups.md, section 3 L:
// "Assigning slots", "Two offline devices pick the same slot", "More than 15 groups"). Pure (no DOM,
// no storage), shared by the app and the Node tests.
//
// A group's colour value in the synced settings record is { name, swatch: wN, slot: N − 1, auto? }
// (js/storage.js). Every device draws slot N − 1 with its palette's colour N (the default palette
// is the Wallet's 15 colours). Here:
// - Assigning: a default group (js/services.js DEFAULT_GROUPS) takes its fixed slot unless a live
//   group already uses it; any other group takes the first slot no live group uses, probing from
//   hash(name) mod 15. With all 15 used, colours repeat: the least-used slot, in probe order.
// - Repair: when two live groups share a slot and the later one was automatic, the later one moves
//   to its first free slot (same probe). Picked colours never move. Two names of the same default
//   group (say Housing and 居住) may share. Nothing moves while no slot is free (past 15 groups).
//   It uses only what's in the record (values, stamps) and which groups are live, so every device
//   works out the same moves and the household converges.
// - Old picked colours (g1–g10) don't hold a slot; a w swatch without a slot (written by 1.19.0,
//   which drops slot and auto) counts as a pick of that slot.

import { colorField, slotOf } from './storage.js';
import { DEFAULT_GROUPS } from './services.js';

export const SLOT_COUNT = 15;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** The default group a group name is (one of its English or Chinese names), or null. */
export const presetFor = (name) => DEFAULT_GROUPS.find((g) => g.names.some((n) => norm(n) === norm(name))) ?? null;

/** Where a name's probe starts: its group-name hash (colorField, part of the sync format) mod 15. */
export const slotStart = (name) => parseInt(colorField(name).slice(6, 14), 16) % SLOT_COUNT;

/** The slot a w swatch draws (w1 is slot 0), or null for anything else. */
const wSlot = (swatch) => {
  const m = /^w([1-9]|1[0-5])$/.exec(String(swatch ?? ''));
  return m ? Number(m[1]) - 1 : null;
};

/**
 * What a colour value from the record means here: { slot, auto } with slot 0–14 (a slot past 14,
 * from a later version, draws as its base colour), or null when it holds no slot (an old g pick,
 * or no value). A value without `slot` but with a w swatch is a pick of that slot.
 */
export function readValue(v) {
  if (!v || typeof v !== 'object') return null;
  const s = slotOf(v);
  if (s !== null) return { slot: s % SLOT_COUNT, auto: v.auto === true };
  const w = wSlot(v.swatch);
  return w === null ? null : { slot: w, auto: false };
}

/** The colour value an automatic slot is written as. */
export const autoValue = (name, slot) => ({ name, swatch: `w${slot + 1}`, slot, auto: true });

/**
 * The slot for `name`, given `counts` (how many live groups use each slot): its default group's
 * fixed slot if free, else the first free slot from slotStart(name), else (all used) the least
 * used, in the same order. `free` true: only a free slot will do (null when there's none).
 */
export function pickSlot(name, counts, { free = false } = {}) {
  const preset = presetFor(name);
  if (preset && counts[preset.slot] === 0) return preset.slot;
  const s0 = slotStart(name);
  const order = Array.from({ length: SLOT_COUNT }, (_, i) => (s0 + i) % SLOT_COUNT);
  const open = order.find((k) => counts[k] === 0);
  if (open !== undefined) return open;
  if (free) return null;
  return order.reduce((best, k) => (counts[k] < counts[best] ? k : best), order[0]);
}

const countsOf = (slots) => {
  const c = new Array(SLOT_COUNT).fill(0);
  for (const s of slots) if (s !== null && s !== undefined) c[s]++;
  return c;
};

/**
 * The household's repair (deterministic): from `shared` (name → { slot, auto, ts }: the record's
 * values of live groups, ts the value's stamp), the moves [{ name, slot }] that end every clash
 * that can be ended. In a shared slot: a pick stays and every automatic group moves; with only
 * automatic ones, the earliest stamp stays (ties: the name first in code-point order) and the
 * others move, later first. Groups that are names of the same default group don't clash.
 */
export function repairMoves(shared) {
  const cur = new Map([...shared].map(([n, v]) => [n, { ...v }]));
  const moves = [];
  for (let guard = 0; guard < SLOT_COUNT * 4; guard++) {
    const bySlot = new Map();
    for (const [name, v] of [...cur].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!bySlot.has(v.slot)) bySlot.set(v.slot, []);
      bySlot.get(v.slot).push({ name, ...v });
    }
    let mover = null;
    for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
      const list = bySlot.get(slot);
      const families = new Set(list.map((g) => presetFor(g.name)?.id ?? `name:${g.name}`));
      if (families.size < 2) continue;
      const autos = list.filter((g) => g.auto);
      if (!autos.length) continue; // only picks: someone chose these
      const keeper = list.some((g) => !g.auto) ? null
        : [...autos].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.name < b.name ? -1 : 1))[0];
      // Members of the keeper's family stay too (two names of one default group may share).
      const fam = (g) => presetFor(g.name)?.id ?? `name:${g.name}`;
      const keep = new Set(list.filter((g) => !g.auto || (keeper && fam(g) === fam(keeper))).map(fam));
      const movable = autos.filter((g) => !keep.has(fam(g)))
        .sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : a.name < b.name ? -1 : 1));
      if (movable.length) { mover = movable[0]; break; }
    }
    if (!mover) break;
    const others = [...cur].filter(([n]) => n !== mover.name).map(([, v]) => v.slot);
    const slot = pickSlot(mover.name, countsOf(others), { free: true });
    if (slot === null) break; // past 15 groups: no free slot, so the colours repeat as they are
    cur.get(mover.name).slot = slot;
    moves.push({ name: mover.name, slot });
  }
  return moves;
}

/**
 * Everything to write for this device's live expense groups (`live`, names A–Z):
 * - `shared`: name → { slot, auto, ts } from the record (readValue), for live groups;
 * - `held`:   names whose colour this device keeps on its own or that someone picked as an old g
 *             colour (they get nothing here), with the slot they show if any (local automatic w
 *             colours count, so a new group avoids them on this device).
 * Returns { assign: [{ name, slot }] for live groups with no colour at all, moves: repairMoves }.
 * Assigned groups take part in the repair as the latest values (they'll be written now).
 */
export function planSlots({ live, shared, held = new Map() }) {
  const used = [...live].map((n) => shared.get(n)?.slot ?? held.get(n) ?? null);
  const counts = countsOf(used);
  const assign = [];
  for (const name of live) {
    if (shared.has(name) || held.has(name)) continue;
    const slot = pickSlot(name, counts);
    counts[slot]++;
    assign.push({ name, slot });
  }
  const after = new Map([...live].filter((n) => shared.has(n)).map((n) => [n, shared.get(n)]));
  for (const a of assign) after.set(a.name, { slot: a.slot, auto: true, ts: '~' }); // newer than any stamp
  const moves = repairMoves(after);
  // An assigned group that the repair moves is simply assigned there.
  const moved = new Map(moves.map((m) => [m.name, m.slot]));
  return {
    assign: assign.map((a) => ({ name: a.name, slot: moved.get(a.name) ?? a.slot })),
    moves: moves.filter((m) => !assign.some((a) => a.name === m.name)),
  };
}

/**
 * The record's group colours (`record`, the settings record), read for slots: { shared: name →
 * { slot, auto, ts } for values that hold a slot, picks: names with an old g colour (no slot) }.
 * Values that aren't a valid { name, swatch } for their field are skipped, as everywhere else.
 */
export function slotsFromRecord(record) {
  const shared = new Map();
  const picks = new Set();
  const f = record?.fields ?? {};
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('color_') || !v || typeof v !== 'object' || typeof v.name !== 'string' || colorField(v.name) !== k) continue;
    if (typeof v.swatch !== 'string' || !v.swatch || v.swatch.length > 8) continue;
    const r = readValue(v);
    if (r) shared.set(v.name, { ...r, ts: record.ts?.[k] ?? '' });
    else picks.add(v.name);
  }
  return { shared, picks };
}

/** The settings-record fields that write automatic slots [{ name, slot }] (storage.saveColourValues). */
export const slotFields = (list) => Object.fromEntries(list.map(({ name, slot }) => [colorField(name), autoValue(name, slot)]));
