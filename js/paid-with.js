// Insights "Paid with" (1.29.0, docs/plan-cards.md Release C): the month's outgoings by how they are
// paid, each live card, Cash and Not set. Pure (no DOM, no storage, no strings), shared by the app and
// tests/paid-with.scenarios.js.
//
// It regroups the rows Insights' By category already has (js/insights-calc.js breakdown(): the month's
// expenses in the chosen currency, each with its cash-basis `due`), so the slices add up to the same
// month total by construction: income and other currencies are never in them. An item's `pay` is read
// as js/cards.js payOf reads it; a card that is deleted, not received on this device yet, or a value
// this version can't use, counts as Not set (the Wallet chip shows nothing for it either).

import { payOf, PAY_CASH, isCardId } from './cards.js';

export const PAY_KEY_CASH = 'pay:cash';
export const PAY_KEY_NONE = 'pay:none';
export const PAY_KEY_OTHER = 'pay:other';
export const payCardKey = (id) => `pay:card:${id}`;
/** Cards under this share of the month are pooled into "Other cards" (two or more of them), as By category pools groups. */
export const SMALL_SHARE = 0.03;

const amountOf = (r) => (Number.isFinite(r?.due) ? r.due : 0);
const cardName = (g) => String(g.card?.name ?? '');
// Largest first; ties: cards A-Z, then Cash. Not set is always last.
const order = (a, b) => (a.kind === 'none') - (b.kind === 'none') || b.total - a.total
  || (a.kind === 'cash') - (b.kind === 'cash') || (cardName(a) < cardName(b) ? -1 : cardName(a) > cardName(b) ? 1 : 0)
  || (String(a.card?.id ?? '') < String(b.card?.id ?? '') ? -1 : 1);

/**
 * The month's expense rows (breakdown().byCategory's items, each with `due`) grouped by how they are
 * paid, given the live cards (js/cards.js listCards). Returns [{ key, kind: 'card' | 'cash' | 'none',
 * card (for a card), total, count, items }], only groups with an amount, largest first, Not set last.
 */
export function paidWith(rows, cards) {
  const live = new Map((cards ?? []).filter((c) => c && c.gone !== true && isCardId(c.id)).map((c) => [c.id, c]));
  const groups = new Map();
  for (const r of rows ?? []) {
    const amount = amountOf(r);
    if (!(amount > 0)) continue;
    const p = payOf(r);
    const kind = p === PAY_CASH ? 'cash' : live.has(p) ? 'card' : 'none';
    const key = kind === 'cash' ? PAY_KEY_CASH : kind === 'none' ? PAY_KEY_NONE : payCardKey(p);
    if (!groups.has(key)) groups.set(key, { key, kind, ...(kind === 'card' ? { card: live.get(p) } : {}), total: 0, count: 0, items: [] });
    const g = groups.get(key);
    g.total += amount;
    g.count += 1;
    g.items.push(r);
  }
  return [...groups.values()].sort(order);
}

/**
 * The chart's slices from paidWith() for a month total `total`: cards under SMALL_SHARE are pooled into
 * one "Other cards" slice ({ key: PAY_KEY_OTHER, kind: 'other', cards, total, count }) when there are
 * two or more of them; Cash and Not set are never pooled. Order: the rest as paidWith() gives them,
 * then Other cards, then Not set.
 */
export function paidWithSlices(groups, total, { small = SMALL_SHARE } = {}) {
  const tiny = (g) => g.kind === 'card' && total > 0 && g.total / total < small;
  const pooled = groups.filter(tiny);
  if (pooled.length < 2) return groups.slice();
  const kept = groups.filter((g) => !tiny(g));
  const none = kept.filter((g) => g.kind === 'none');
  const other = {
    key: PAY_KEY_OTHER, kind: 'other', cards: pooled.map((g) => g.card),
    total: pooled.reduce((t, g) => t + g.total, 0), count: pooled.reduce((t, g) => t + g.count, 0),
    items: pooled.flatMap((g) => g.items),
  };
  return [...kept.filter((g) => g.kind !== 'none'), other, ...none];
}

/**
 * Whether Insights offers "By category | Paid with" for a currency: there is a live card, or one of
 * that currency's expenses (`expenses`) has a `pay` (Cash or a card id).
 */
export const offersPaidWith = (cards, expenses) => (cards ?? []).length > 0 || (expenses ?? []).some((s) => payOf(s) !== '');
