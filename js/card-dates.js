// Payment card dates (1.29.0, docs/plan-cards.md Release C): on which days a card's statement closes
// and its payment is due, for the Calendar and the due-soon sheet. Pure (no DOM, no storage, no
// strings), shared by the app and tests/card-dates.scenarios.js.
//
// A card's `cut` (statement closing day) and `due` (payment due day) are two independent days of the
// month, 1-31 (js/cards.js parseCardValue reads anything else as null). Each set day falls once a
// month, clamped to the last day of a shorter month by the shared stepper (js/interval.js): day 31 is
// the 30th in April and the 28th or 29th in February. A card with one day set gives one date a month;
// a card with neither gives none (and is never "missing a date"). Deleted cards give none.
//
// Card dates are reminders, never money: nothing here has an amount, and nothing here reads or
// returns an item. They never go into state.subs, a total, a count of items or any calculation in
// js/insights-calc.js, js/calendar-math.js or js/due-soon.js; this module imports only the stepper
// and the card rules.

import { MONTHLY, inMonth, nextOnOrAfter, dayNumber, dayOf, dateOf, daysInMonth } from './interval.js';
import { isCardColourKey } from './cards.js';

/** The two kinds of card date, in the order a day lists them: the payment due first. */
export const CARD_DATE_KINDS = Object.freeze(['due', 'cut']);

const isDayOfMonth = (v) => Number.isInteger(v) && v >= 1 && v <= 31;
// A January anchor makes every day 1-31 a real day; a monthly step then lands once in every month.
const anchorOf = (day) => ({ year: 2000, month: 0, day });
const kindRank = (k) => CARD_DATE_KINDS.indexOf(k);
const isLiveCard = (c) => c !== null && typeof c === 'object' && c.gone !== true;
const byName = (a, b) => {
  const x = String(a.card.name ?? ''), y = String(b.card.name ?? '');
  return x < y ? -1 : x > y ? 1 : String(a.card.id ?? '') < String(b.card.id ?? '') ? -1 : String(a.card.id ?? '') > String(b.card.id ?? '') ? 1 : 0;
};
const byKindThenName = (a, b) => kindRank(a.kind) - kindRank(b.kind) || byName(a, b);

/** The days a card has set: [{ kind, day }], the payment due first; [] for a deleted card or none set. */
export function cardKinds(card) {
  if (!isLiveCard(card)) return [];
  return CARD_DATE_KINDS.filter((k) => isDayOfMonth(card[k])).map((kind) => ({ kind, day: card[kind] }));
}

/** On which days of `month` (0-11) of `year` card `card` has a date: [{ kind, day }], by day, then kind. */
export function cardDays(card, year, month) {
  const out = [];
  for (const { kind, day } of cardKinds(card)) {
    for (const d of inMonth(anchorOf(day), MONTHLY, year, month)) out.push({ kind, day: d.day });
  }
  return out.sort((a, b) => a.day - b.day || kindRank(a.kind) - kindRank(b.kind));
}

/**
 * The card dates of `month` (0-11) of `year` for `cards` (js/cards.js listCards): one list per day of
 * the month (index day − 1), each [{ card, kind }], the payment due dates first, then A-Z by name.
 * Empty lists for a month that isn't a real one.
 */
export function cardDatesInMonth(cards, year, month) {
  const ok = Number.isInteger(year) && Number.isInteger(month) && month >= 0 && month <= 11;
  const days = Array.from({ length: ok ? daysInMonth(year, month) : 0 }, () => []);
  for (const card of cards ?? []) {
    for (const { kind, day } of cardDays(card, year, month)) days[day - 1].push({ card, kind });
  }
  for (const list of days) list.sort(byKindThenName);
  return days;
}

/**
 * The card dates from today (`now`'s local calendar day) to `windowDays` days ahead, both included:
 * [{ card, kind, date, days }] (`date` a local Date at the start of the day, `days` 0 for today), by
 * date, then kind, then name. A window of 14 days or fewer holds at most one date of each kind per card.
 */
export function cardDatesSoon(cards, now = new Date(), { windowDays = 7 } = {}) {
  const span = Number.isInteger(windowDays) && windowDays >= 0 ? windowDays : 7;
  const today = dayOf(now);
  const t0 = dayNumber(today);
  const rows = [];
  for (const card of cards ?? []) {
    for (const { kind, day } of cardKinds(card)) {
      const next = nextOnOrAfter(anchorOf(day), MONTHLY, today);
      const days = dayNumber(next) - t0;
      if (days <= span) rows.push({ card, kind, date: dateOf(next), days });
    }
  }
  return rows.sort((a, b) => a.days - b.days || byKindThenName(a, b));
}

/**
 * What a calendar day draws for its card dates ([{ card, kind }]): null for none, else one marker,
 * { colour } — the card's colour key when every date that day is the same card's and it's one this
 * version draws, '' (the neutral outline) for a colour it can't draw or two or more cards.
 */
export function cardMarker(events) {
  if (!events?.length) return null;
  const ids = new Set(events.map((e) => e.card?.id));
  const colour = events[0].card?.colour;
  return { colour: ids.size === 1 && isCardColourKey(colour) ? colour : '' };
}
