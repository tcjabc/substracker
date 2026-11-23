// FROZEN: js/category-select.js from Peek Budget 1.25.1 (commit 2135adf), byte for byte below these two lines.
// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).
// The add and edit sheet's Category drop-down (1.25.0): its options, and what a name typed under
// "New group…" saves as. Pure (no DOM, no storage), shared by the app and the tests.
//
// Nothing here changes what is stored: a category is still plain text (an expense's `category`,
// '' for Uncategorised), and a default group is written as its name in the language of the moment,
// as the suggestions list did before (js/services.js). A new group gets its colour the usual way,
// when the app next draws (app.js ensureGroupColors, js/group-slots.js); the group-name hash sees only
// the text.

import { DEFAULT_GROUPS } from './services.js';
import { groupOf, UNCATEGORISED } from './insights-calc.js';
import { isIncome } from './util.js';

/**
 * The "New group…" option's value. Stored categories are trimmed (the form, storage and Import with
 * AI all trim them), so no real category starts with a space and this can't be mistaken for one.
 */
export const NEW_GROUP = ' new-group';

/** The app's group-name normalisation (js/group-merge.js, js/group-slots.js): outer spaces and case ignored. */
const norm = (name) => String(name ?? '').trim().toLowerCase();

/** For matching a typed name: case and all spacing ignored ("Health  &fitness" is "Health & fitness"). */
const loose = (name) => String(name ?? '').replace(/\s+/g, '').toLowerCase();

/**
 * The drop-down's options, in order: Uncategorised (value ''), the eleven default groups (table
 * order, named in the language in use), the household's other groups (live expenses only; one per
 * name as normalised above, the most used spelling kept; A–Z by `compare`), then "New group…".
 * `current` is the edited item's category: when it isn't one of the options (say a spelling the
 * de-duplication folded away), it is added among the household's groups, so editing never loses
 * or silently changes it. Each option is { value, label, kind: 'none' | 'default' | 'own' | 'new',
 * id? (a default group's) }; `labelOf` is the label helper (insights-calc.js groupLabel), `nameOf`
 * looks up a dictionary key (t).
 */
export function categoryOptions(items, { nameOf, labelOf = (n) => n, compare = (a, b) => a.localeCompare(b), current = '' } = {}) {
  const out = [{ value: '', label: labelOf(UNCATEGORISED), kind: 'none' }];
  const seen = new Set([norm(UNCATEGORISED), norm(labelOf(UNCATEGORISED))]);
  for (const g of DEFAULT_GROUPS) {
    const name = nameOf(g.key);
    out.push({ value: name, label: labelOf(name), kind: 'default', id: g.id });
    seen.add(norm(name));
  }
  const counts = new Map();
  for (const s of items ?? []) {
    if (isIncome(s)) continue;
    const g = groupOf(s);
    if (g !== UNCATEGORISED) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  // The most used spelling of a name wins; ties go to the first A–Z, then by code point.
  const byUse = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  const own = [];
  for (const name of byUse) {
    if (seen.has(norm(name))) continue;
    seen.add(norm(name));
    own.push(name);
  }
  const cur = String(current ?? '').trim();
  if (cur && !out.some((o) => o.value === cur) && !own.includes(cur)) own.push(cur);
  own.sort((a, b) => compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of own) out.push({ value: name, label: labelOf(name), kind: 'own' });
  out.push({ value: NEW_GROUP, label: nameOf('form.category.new'), kind: 'new' });
  return out;
}

/**
 * What a name typed under "New group…" saves as, given the drop-down's `options`:
 * - empty (or only spaces): { value: '' }, Uncategorised;
 * - longer than `max` (the category limit, js/import-ai.js CATEGORY_MAX, after trimming): { error: 'long' };
 * - the name of an option, case and spacing ignored (Uncategorised by its label or its stored key):
 *   { value: that option's value }, so no second copy of a group is made;
 * - one of a default group's names in any language (js/services.js `names`): that default's option;
 * - otherwise { value: the trimmed name, created: true }.
 */
export function resolveNewGroup(typed, options, { max = 40 } = {}) {
  const name = String(typed ?? '').trim();
  if (!name) return { value: '' };
  if (name.length > max) return { error: 'long' };
  const k = loose(name);
  if (k === loose(UNCATEGORISED)) return { value: '' };
  const list = (options ?? []).filter((o) => o.kind !== 'new');
  const hit = list.find((o) => (o.value !== '' && loose(o.value) === k) || loose(o.label) === k);
  if (hit) return { value: hit.value };
  const preset = DEFAULT_GROUPS.find((g) => g.names.some((n) => loose(n) === k));
  const opt = preset && list.find((o) => o.id === preset.id);
  if (opt) return { value: opt.value };
  return { value: name, created: true };
}
