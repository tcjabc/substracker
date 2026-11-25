// The Calendar tab: a month grid of due dates with dots in the group colours, the
// selected day's items listed under it, and month navigation by buttons, swipe and keyboard. What
// falls on which day, and every figure, comes from js/calendar-math.js (Insights' cash basis); this
// file only draws it. The shown month and the selected day aren't saved anywhere.
//
// Accessibility: a role="grid" of rows and gridcells, each day of the month a button labelled with
// its full date, how many payments and the default currency's total ("5 December 2026, 2 payments,
// NT$30,390"). One day is in the tab order (roving tabindex); the arrow keys move by a day or a
// week, Home and End to the week's ends, Page Up and Page Down by a month, Enter or Space shows the
// day. The month heading is announced in one polite live region when the month changes, and only
// then. Dots are never the only cue: days with items have a tinted cell, and the label says it all.
//
// Under the heading, the month's cash flow in the default currency: In (incomeDue), Out (cashDue)
// and Left over (In − Out), the Money card's and Insights' functions, so the figures match by
// construction. Left over shows its size with an arrow (up-right when more comes in, down-right
// when more goes out) and no sign; only it is coloured. Other currencies are counted on one line,
// never added in. Screen readers get the three as one labelled group that says the direction.
//
// Motion: a swipe drags the weeks and slides them out; with "Reduce motion and effects" the month
// just changes (no animation frames). Only the three cash-flow figures may roll (opts.roll).
//
// Card dates (1.29.0, js/card-dates.js): a card's statement closing and payment due days, reminders
// beside the money, never in it. A day with card dates gives one of its three dot slots to a small
// card glyph (in the card's colour, or the neutral outline for two or more cards or a colour this
// version can't draw), so it shows at most two expense dots and "+N" counts only the expense rows
// left out. The day's label names each card date, and its list ends with a "Card dates" block of
// its own with no amounts. A day with only card dates isn't tinted: the tint means money moves.
// No figure, count, In / Out / Left over or "N items need a date" line ever includes a card date.

import { monthGrid, occurrences, addMonths, dayDots, moveDay } from './calendar-math.js';
import { cardDatesInMonth, cardMarker } from './card-dates.js';
import { cardGlyphHTML } from './cards-ui.js';
import { t, dateWords, weekdayStyle, formatLocale } from './i18n.js';
import { esc, money } from './util.js';
import { othersText, parseColour, contrast } from './wallet-math.js';
import { groupLabel, incomeDue, cashDue } from './insights-calc.js';

const CHEV_L = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const CHEV_R = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
// Left over's direction, drawn (not a font glyph or emoji, so it looks the same on every device).
const ARROW = {
  up: '<svg class="cal-flow-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  down: '<svg class="cal-flow-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 9v8H9"/></svg>',
};
// The figures step down a size at a time (and the gaps narrow) while the three don't fit side by side.
const FIT_STEPS = ['', 'is-tight', 'is-tighter', 'is-tightest'];
const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
// A swipe counts once it's moved this far sideways (px) before moving as far up or down; it changes
// the month past a share of the width, or on a fling.
const SLOP = 10;
const SWIPE_SHARE = 0.22;
const FLING = 0.45; // px per ms
// A dot needs this contrast with its cell (WCAG's 3:1 for graphics); below it, it gets a thin ring.
const DOT_CONTRAST = 3;

const sameDay = (a, b) => !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
const todayParts = () => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }; };

/**
 * Mount the calendar in `host` (an empty element). Options:
 *   items()            the live items
 *   currency()         the default currency (the only one totalled)
 *   weekStart()        0 Sunday … 6 Saturday
 *   reduced()          "Reduce motion and effects"
 *   dotColour(group)   a CSS colour for an expense group's dot (its picked or automatic colour)
 *   logo(s)            logo markup for an item in the day's list
 *   onEdit(item)       open an item's edit sheet (a row, or the "N items need a date" line)
 *   cards()            optional: the live payment cards (js/cards.js listCards), for their dates
 *   cardsWritable()    optional: whether a card can be edited here; its dates are buttons only then
 *   onCard(id)         optional: open card `id`'s sheet (a card date in the day's list)
 *   roll(el, key, value, currency)  optional: a cash-flow figure ('in', 'out' or 'left', its size), so it can roll
 * update() draws it again (new items, settings or theme); its month and selected day are kept.
 */
export function createCalendar(host, opts) {
  host.classList.add('calendar');
  host.setAttribute('aria-label', t('calendar.label'));
  host.setAttribute('role', 'region');
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.id = 'cal-live';

  const now0 = todayParts();
  let shown = { year: now0.year, month: now0.month };
  let selected = now0.day; // the current month opens on today
  let focusDay = null;     // the day in the tab order when it isn't the selected one
  let occ = null;
  let cardDays = []; // the shown month's card dates, one list per day (js/card-dates.js)
  let destroyed = false;
  let ringCache = new Map();
  const reduced = () => !!opts.reduced?.();
  const isCurrent = (m = shown) => { const n = todayParts(); return m.year === n.year && m.month === n.month; };
  const cur = () => opts.currency();
  const dayDate = (day) => new Date(shown.year, shown.month, day);
  const num = (n) => new Intl.NumberFormat(formatLocale()).format(n);

  /* Wording ---------------------------------------------------------------------------------- */
  const monthName = (m = shown) => dateWords(new Date(m.year, m.month, 1), { month: 'long', year: 'numeric' });
  const fullDate = (day) => dateWords(dayDate(day), { day: 'numeric', month: 'long', year: 'numeric' });
  const extras = (d) => [d.income > 0 ? t('calendar.income', { amount: money(d.income, cur()) }) : '', othersText(d.others)].filter(Boolean);
  /** A card date's words: "Payment due: Visa" or "Statement closes: Visa". */
  const cardDateText = (e) => t(e.kind === 'due' ? 'cardDates.due' : 'cardDates.cut', { name: e.card.name });
  function dayLabel(d, cards = []) {
    const today = sameDay({ ...shown, day: d.day }, todayParts());
    const none = cards.length ? t('calendar.day.noPayments') : t('calendar.day.nothing');
    return [fullDate(d.day), today ? t('calendar.day.today') : '',
      d.count ? t('calendar.day.payments', { count: d.count }) : none,
      d.total > 0 ? money(d.total, cur()) : '', ...extras(d), ...cards.map(cardDateText)].filter(Boolean).join(t('common.listSep'));
  }

  /* Dots -------------------------------------------------------------------------------------- */
  // Whether a colour needs a ring to stand out from the cell behind it, measured against that kind
  // of cell's own background in the theme in use (the cache is cleared on every draw, so a theme
  // change is picked up). Measured on short-lived probes before the markup is written, so the ring
  // is in the markup from the start and no style changes afterwards (which would start transitions).
  function probe(tag, cls, style) {
    const el = document.createElement(tag);
    el.className = cls;
    if (style) el.style.color = style;
    host.append(el);
    const cs = getComputedStyle(el);
    const out = style ? cs.color : cs.backgroundColor;
    el.remove();
    return out;
  }
  function needsRing(colour, cellClass) {
    const key = `${colour}|${cellClass}`;
    if (!ringCache.has(key)) {
      const fg = parseColour(probe('span', '', colour));
      const back = parseColour(probe('button', `cal-day ${cellClass}`));
      ringCache.set(key, !!fg && !!back && contrast(fg, back) < DOT_CONTRAST);
    }
    return ringCache.get(key);
  }
  const dotColour = (r) => (r.income ? 'var(--positive)' : opts.dotColour(r.group));

  /* Drawing ----------------------------------------------------------------------------------- */
  function draw({ announce = false, focus = false } = {}) {
    if (destroyed) return;
    ringCache = new Map();
    const ws = opts.weekStart();
    const g = monthGrid(shown.year, shown.month, ws);
    occ = occurrences(opts.items(), shown.year, shown.month, { currency: cur() });
    // Beside the items, never among them: the card dates have no amount and are in no figure.
    cardDays = cardDatesInMonth(opts.cards?.() ?? [], shown.year, shown.month);
    const today = todayParts();
    const c = cur();
    const tabDay = selected ?? focusDay ?? (isCurrent() ? today.day : 1);
    const wdStyle = weekdayStyle();
    // A week that starts on 15 November 2026 (a Sunday) gives each column's weekday name.
    const wdDate = (w) => new Date(2026, 10, 15 + w);
    const heads = g.weekdays.map((w) => `<div role="columnheader" class="cal-wd" aria-label="${esc(dateWords(wdDate(w), { weekday: 'long' }))}"><span aria-hidden="true">${esc(dateWords(wdDate(w), { weekday: wdStyle }))}</span></div>`).join('');
    const weeks = g.weeks.map((week) => `<div role="row" class="cal-row">${week.map((cell) => {
      if (!cell.inMonth) return `<div role="gridcell" class="cal-cell cal-out"><span class="cal-num" aria-hidden="true">${esc(num(cell.day))}</span></div>`;
      const d = occ.days[cell.day - 1];
      const isToday = sameDay(cell, today);
      const sel = selected === cell.day;
      const cards = cardDays[cell.day - 1] ?? [];
      const marker = cardMarker(cards);
      // A card marker takes one of the three slots; "+N" counts only the expense rows left out.
      const { dots, more } = dayDots(d.rows, marker ? 2 : 3);
      const cellClass = sel ? 'has-items is-selected' : 'has-items';
      const dotHTML = dots.map((r) => `<i class="cal-dot${needsRing(dotColour(r), cellClass) ? ' cal-dot-ring' : ''}" style="--dot-colour: ${dotColour(r)}"></i>`).join('')
        + (marker ? cardGlyphHTML(marker, { size: 'xs', extraClass: 'cal-card' }) : '')
        + (more ? `<span class="cal-more">${esc(t('calendar.more', { count: more }))}</span>` : '');
      // has-card-mark: the day draws a card marker (its dot gaps narrow; a class, not :has(), which
      // older WebViews skip).
      const kinds = `${d.count ? ' has-items' : cards.length ? ' has-cards' : ''}${marker ? ' has-card-mark' : ''}${isToday ? ' is-today' : ''}${sel ? ' is-selected' : ''}`;
      return `<div role="gridcell" class="cal-cell" aria-selected="${sel}"><button type="button" class="cal-day${kinds}" data-day="${cell.day}" tabindex="${cell.day === tabDay ? 0 : -1}"${isToday ? ' aria-current="date"' : ''} aria-label="${esc(dayLabel(d, cards))}"><span class="cal-num" aria-hidden="true">${esc(num(cell.day))}</span><span class="cal-dots" aria-hidden="true">${dotHTML}</span></button></div>`;
    }).join('')}</div>`).join('');

    // Under the heading: the month's In, Out and Left over in the default currency (the cash basis,
    // from insights-calc), other currencies counted on their own line and never added in.
    const inCur = opts.items().filter((s) => s.currency === c);
    const flowIn = incomeDue(inCur, shown.year, shown.month);
    const flowOut = cashDue(inCur, shown.year, shown.month);
    const left = flowIn - flowOut;
    const dir = left > 0 ? 'up' : left < 0 ? 'down' : 'even';
    const leftWords = t(left < 0 ? 'calendar.flow.short' : 'calendar.flow.leftOver', { amount: money(Math.abs(left), c) });
    const flowLabel = t('calendar.flow.label', { in: money(flowIn, c), out: money(flowOut, c), left: leftWords });
    const cell = (key, label, value, extra = '') => `
        <div class="cal-flow-cell cal-flow-${key}">
          <span class="cal-flow-label">${esc(label)}</span>
          <span class="cal-flow-value">${extra}<span class="cal-flow-amount" data-flow="${key}" data-value="${value}">${esc(money(value, c))}</span></span>
        </div>`;
    host.innerHTML = `
      <div class="cal-head">
        <button type="button" class="icon-btn cal-step" data-cal-step="-1" aria-label="${esc(t('calendar.prev'))}" title="${esc(t('calendar.prev'))}">${CHEV_L}</button>
        <h2 class="cal-month" id="cal-month">${esc(monthName())}</h2>
        <button type="button" class="icon-btn cal-step" data-cal-step="1" aria-label="${esc(t('calendar.next'))}" title="${esc(t('calendar.next'))}">${CHEV_R}</button>
        <button type="button" class="btn cal-today" data-cal-today title="${esc(t('calendar.today.title'))}">${esc(t('calendar.today'))}</button>
      </div>
      <div class="cal-flow" role="group" aria-label="${esc(flowLabel)}" data-dir="${dir}">
        <div class="cal-flow-cells" aria-hidden="true">${cell('in', t('calendar.flow.in'), flowIn)}${cell('out', t('calendar.flow.out'), flowOut)}${cell('left', t('money.leftOver'), Math.abs(left), ARROW[dir] ?? '')}
        </div>
      </div>
      ${occ.others.length ? `<p class="cal-flow-note">${esc(othersText(occ.others))}</p>` : ''}
      <div class="cal-grid" data-no-page-swipe role="grid" aria-labelledby="cal-month" aria-describedby="cal-keys">
        <div role="rowgroup" class="cal-heads"><div role="row" class="cal-row">${heads}</div></div>
        <div role="rowgroup" class="cal-weeks">${weeks}</div>
      </div>
      <p class="sr-only" id="cal-keys">${esc(t('calendar.keys'))}</p>
      ${occ.count ? '' : `<p class="cal-note cal-empty">${esc(t(cardDays.some((l) => l.length) ? 'calendar.nothingMonth.cards' : 'calendar.nothingMonth', { month: monthName() }))}</p>`}
      ${occ.undated.length ? `<button type="button" class="summary-note summary-note-action cal-undated" data-id="${esc(occ.undated[0].id)}">${esc(t('dueSoon.undated', { count: occ.undated.length }))}</button>` : ''}
      ${selected ? listHTML(occ.days[selected - 1], cardDays[selected - 1] ?? []) : ''}`;
    host.append(live);
    fitFlow();
    for (const el of host.querySelectorAll('.cal-flow-amount')) opts.roll?.(el, el.dataset.flow, Number(el.dataset.value), c);
    if (announce) live.textContent = monthName();
    if (focus) host.querySelector(`.cal-day[data-day="${tabDay}"]`)?.focus();
  }

  /**
   * Step the three cash-flow figures down a size while they don't fit side by side (a long
   * currency prefix, a narrow screen). Measured, so a hidden tab (no width) keeps the full size
   * until it's drawn on screen; a change of width measures again.
   */
  function fitFlow() {
    const row = host.querySelector('.cal-flow-cells');
    if (!row?.clientWidth) return;
    for (const step of FIT_STEPS) {
      row.classList.remove(...FIT_STEPS.filter(Boolean));
      if (step) row.classList.add(step);
      if (row.scrollWidth <= row.clientWidth + 1) return;
    }
  }
  let fitWidth = 0;
  const fitter = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (host.clientWidth && host.clientWidth !== fitWidth) { fitWidth = host.clientWidth; fitFlow(); }
  }) : null;
  fitter?.observe(host);

  /**
   * The day's card dates under their own heading: the card's glyph and "Payment due: Visa", no
   * amount. A button that opens the card's sheet where cards can be edited, else a plain row.
   */
  function cardsHTML(cards) {
    if (!cards.length) return '';
    const writable = !!opts.cardsWritable?.() && !!opts.onCard;
    const rows = cards.map((e) => {
      const text = cardDateText(e);
      const inner = `<span class="card-date-mark">${cardGlyphHTML(e.card)}</span><span class="sub-text"><span class="sub-name">${esc(text)}</span></span>`;
      return writable
        ? `<li><button type="button" class="sub-row due-row card-date-row" data-card="${esc(e.card.id)}" aria-label="${esc(t('cardDates.edit', { text }))}">${inner}</button></li>`
        : `<li><div class="sub-row due-row card-date-row">${inner}</div></li>`;
    }).join('');
    return `
        <h4 class="cal-cards-title">${esc(t('cardDates.title'))}</h4>
        <ul class="due-list cal-card-list">${rows}</ul>`;
  }

  function listHTML(d, cards = []) {
    const c = cur();
    const sum = [d.total > 0 ? t('dueSoon.total', { amount: money(d.total, c) }) : '', ...extras(d)].filter(Boolean);
    const rows = d.rows.map((r) => {
      const s = r.item;
      const amount = money(r.amount, r.currency);
      const group = r.income ? t('group.income') : groupLabel(r.group);
      const label = r.income ? t('calendar.row.income', { name: s.name, amount }) : t('calendar.row', { name: s.name, group, amount });
      const note = r.currency === c ? '' : `<span class="cycle">${esc(t('wallet.notInTotals', { currency: c }))}</span>`;
      return `<li><button type="button" class="sub-row due-row" data-id="${esc(s.id)}" aria-label="${esc(label)}">
        ${opts.logo(s)}
        <span class="sub-text"><span class="sub-name">${esc(s.name)}</span><span class="sub-plan">${esc(group)}</span></span>
        <span class="sub-row-price"><span class="amount">${esc(amount)}</span>${note}</span>
      </button></li>`;
    }).join('');
    return `
      <section class="cal-list" aria-label="${esc(t('calendar.list.label', { date: fullDate(d.day) }))}">
        <h3 class="cal-list-title">${esc(dateWords(dayDate(d.day), { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>
        ${sum.length ? `<p class="cal-list-sum">${esc(sum.join(' · '))}</p>` : ''}
        ${d.rows.length ? `<ul class="due-list">${rows}</ul>` : `<p class="cal-note">${esc(t(cards.length ? 'calendar.list.noPayments' : 'calendar.list.empty'))}</p>`}
        ${cardsHTML(cards)}
      </section>`;
  }

  /* Navigation -------------------------------------------------------------------------------- */
  /** Show another month: today selected in the current month, nothing selected in the others. */
  function go(next, { focusOn = null } = {}) {
    if (next.year === shown.year && next.month === shown.month) {
      if (focusOn) { focusDay = focusOn; draw({ focus: true }); }
      return;
    }
    shown = { year: next.year, month: next.month };
    selected = isCurrent() ? todayParts().day : null;
    focusDay = focusOn;
    draw({ announce: true, focus: !!focusOn });
    // Keyboard: the moved-to day takes the tab stop even when another day is selected.
    if (focusOn) {
      for (const b of host.querySelectorAll('.cal-day')) b.tabIndex = Number(b.dataset.day) === focusOn ? 0 : -1;
      host.querySelector(`.cal-day[data-day="${focusOn}"]`)?.focus();
    }
  }
  const step = (delta) => go(addMonths(shown.year, shown.month, delta));

  function select(day) {
    selected = selected === day ? null : day; // tapping the selected day again closes its list
    focusDay = day;
    draw();
    for (const b of host.querySelectorAll('.cal-day')) b.tabIndex = Number(b.dataset.day) === day ? 0 : -1;
    host.querySelector(`.cal-day[data-day="${day}"]`)?.focus();
  }

  let suppressClick = false;
  host.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const stepBtn = e.target.closest('[data-cal-step]');
    if (stepBtn) { step(Number(stepBtn.dataset.calStep)); host.querySelector(`[data-cal-step="${stepBtn.dataset.calStep}"]`)?.focus(); return; }
    if (e.target.closest('[data-cal-today]')) {
      const n = todayParts();
      if (isCurrent()) { selected = n.day; focusDay = null; draw(); } else go(n);
      host.querySelector('[data-cal-today]')?.focus();
      return;
    }
    const day = e.target.closest('.cal-day');
    if (day) { select(Number(day.dataset.day)); return; }
    const cardRow = e.target.closest('[data-card]');
    if (cardRow) { opts.onCard?.(cardRow.dataset.card); return; }
    const row = e.target.closest('[data-id]');
    if (row) {
      const s = opts.items().find((x) => x.id === row.dataset.id);
      if (s) opts.onEdit(s);
    }
  });

  host.addEventListener('keydown', (e) => {
    const day = e.target.closest?.('.cal-day');
    if (!day || !KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const to = moveDay({ ...shown, day: Number(day.dataset.day) }, e.key, opts.weekStart());
    if (to.year === shown.year && to.month === shown.month) {
      focusDay = to.day;
      for (const b of host.querySelectorAll('.cal-day')) b.tabIndex = Number(b.dataset.day) === to.day ? 0 : -1;
      host.querySelector(`.cal-day[data-day="${to.day}"]`)?.focus();
    } else {
      go(to, { focusOn: to.day });
    }
  });

  /* Swipe ------------------------------------------------------------------------------------- */
  // The weeks follow the finger sideways; past a share of the width (or on a fling) they slide out
  // and the next month slides in. Up-and-down movement is left to the page (touch-action: pan-y).
  let drag = null;
  const ms = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : fallback;
  };
  const easing = () => getComputedStyle(document.documentElement).getPropertyValue('--ease').trim() || 'ease-out';
  const weeksEl = () => host.querySelector('.cal-weeks');

  host.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !e.target.closest('.cal-grid')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, v: 0, on: false, lastX: e.clientX, lastT: e.timeStamp };
  });
  host.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) { drag = null; return; } // a scroll
      if (Math.abs(dx) < SLOP) return;
      drag.on = true;
      try { host.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
    }
    const dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.v = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    drag.dx = dx;
    if (!reduced()) weeksEl().style.transform = `translateX(${dx}px)`;
  });
  const endDrag = (e, cancelled = false) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.on) return;
    suppressClick = true; // the click that ends a swipe isn't a tap on a day
    setTimeout(() => { suppressClick = false; }, 0);
    const el = weeksEl();
    const width = el.getBoundingClientRect().width || 1;
    const turn = !cancelled && (Math.abs(d.dx) > width * SWIPE_SHARE || (Math.abs(d.v) > FLING && Math.abs(d.dx) > SLOP * 2));
    const delta = d.dx < 0 ? 1 : -1;
    if (reduced()) { el.style.transform = ''; if (turn) step(delta); return; }
    const dur = ms('--dur', 200);
    if (!turn) {
      el.animate([{ transform: `translateX(${d.dx}px)` }, { transform: 'translateX(0)' }], { duration: dur, easing: easing() });
      el.style.transform = '';
      return;
    }
    const out = el.animate([{ transform: `translateX(${d.dx}px)` }, { transform: `translateX(${-delta * width}px)` }], { duration: dur * 0.6, easing: 'ease-in', fill: 'forwards' });
    out.onfinish = () => {
      step(delta);
      weeksEl()?.animate([{ transform: `translateX(${delta * width * 0.3}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: dur, easing: easing() });
    };
  };
  host.addEventListener('pointerup', (e) => endDrag(e));
  host.addEventListener('pointercancel', (e) => endDrag(e, true));

  draw();
  return {
    update: () => draw(),
    /** The shown month and selected day, for tests: { year, month, selected }. */
    get state() { return { ...shown, selected }; },
    /** Tests and the Settings preview: show `month` of `year`. */
    show: (year, month) => go({ year, month }),
    destroy() { destroyed = true; fitter?.disconnect(); host.textContent = ''; },
  };
}
