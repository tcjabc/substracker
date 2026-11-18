// The merge helper (docs/plan-intervals-groups.md, section 3 L "Suggest merges"): it suggests moving
// groups that mean the same thing into one of the default groups, driven by the alias table in
// js/services.js (no fuzzy matching). Pure (no DOM, no storage), shared by the app and the Node tests.
//
// Nothing happens without a tap: the app shows the suggestions and applies them, on Merge, as
// ordinary category edits, which every version understands and syncs. An Undo puts the old
// categories back the same way.

import { DEFAULT_GROUPS } from './services.js';
import { groupOf, UNCATEGORISED } from './insights-calc.js';
import { isIncome } from './util.js';

const norm = (name) => String(name ?? '').trim().toLowerCase();

/**
 * Suggestions for the household's expense groups (`items`, live): [{ to, from: [names] }], one per
 * default group that would gain something, in table order; `from` A–Z as given by `compare`.
 * - A group is matched by its whole name (case and outer spaces ignored) against the aliases.
 * - `to` is the household's own group for that default when it already has one under one of the
 *   default's names (the language in use first, then English, then Chinese; case and outer spaces
 *   ignored), else the default's name in the language in use (`nameOf(key)`, normally t). So a
 *   merge never renames a group the household already has, nor makes a second copy of a default.
 * - Uncategorised is never moved.
 */
export function suggestMerges(items, { nameOf, compare = (a, b) => a.localeCompare(b) } = {}) {
  const names = [...new Set(items.filter((s) => !isIncome(s)).map(groupOf))].filter((g) => g !== UNCATEGORISED);
  const out = [];
  for (const preset of DEFAULT_GROUPS) {
    const own = names.filter((n) => preset.aliases.includes(norm(n)));
    if (!own.length) continue;
    const local = nameOf(preset.key);
    const named = [local, ...preset.names].map(norm);
    const to = named.map((x) => own.find((n) => norm(n) === x)).find(Boolean) ?? local;
    const from = own.filter((n) => n !== to).sort(compare);
    if (from.length) out.push({ to, from });
  }
  return out;
}

/**
 * The items a set of suggestions changes: [{ item, category }] with the item as it is and its new
 * category. Only expenses in a `from` group move.
 */
export function mergeChanges(items, suggestions) {
  const target = new Map();
  for (const s of suggestions) for (const f of s.from) target.set(f, s.to);
  return items.filter((s) => !isIncome(s) && target.has(groupOf(s))).map((s) => ({ item: s, category: target.get(groupOf(s)) }));
}

/** How many groups there are before and after applying `suggestions` (for the summary). */
export function groupCounts(items, suggestions) {
  const before = new Set(items.filter((s) => !isIncome(s)).map(groupOf));
  const moved = new Set(suggestions.flatMap((s) => s.from));
  const after = new Set([...before].filter((g) => !moved.has(g)));
  for (const s of suggestions) after.add(s.to);
  return { before: before.size, after: after.size };
}
