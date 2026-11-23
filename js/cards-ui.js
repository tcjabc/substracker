// The payment cards UI (1.27.0, docs/plan-cards.md Release B): Settings → Payment cards (the list
// and "Add card") and the card sheet (#card-dialog: nickname, colour, statement closing day, payment
// due day, delete). Nicknames only: the sheet never asks for a card number and refuses a nickname
// that looks like one (js/cards.js cardNameProblem). The data rules are in js/cards.js and the writes
// in js/storage.js (saveCard, deleteCard): this module only draws and calls them.

import { t } from './i18n.js';
import { esc } from './util.js';
import {
  listCards, cardNameProblem, cardByName, newCardId, CARD_NAME_MAX, CARD_COLOUR_KEYS, isCardColourKey, itemsPaidWith,
} from './cards.js';

/** The colour names, as plain keys (tests/i18n.node.test.js checks every key the source names). */
export const CARD_COLOUR_NAMES = Object.freeze({
  c1: 'colour.c1', c2: 'colour.c2', c3: 'colour.c3', c4: 'colour.c4', c5: 'colour.c5',
  c6: 'colour.c6', c7: 'colour.c7', c8: 'colour.c8', c9: 'colour.c9', c10: 'colour.c10',
});

/**
 * The card glyph (css/app.css .card-glyph) for a card ({ colour }), always aria-hidden: its meaning
 * goes in the label of what it sits in. A colour this version doesn't draw gets no data-colour, so
 * it shows as a muted outline with no fill. `size` 'sm' is the Wallet chip.
 */
export function cardGlyphHTML(card, { size = '', extraClass = '' } = {}) {
  const cls = ['card-glyph', size ? `card-glyph-${size}` : '', extraClass].filter(Boolean).join(' ');
  const colour = isCardColourKey(card?.colour) ? ` data-colour="${card.colour}"` : '';
  return `<span class="${cls}"${colour} aria-hidden="true"></span>`;
}

/** The colour a new card starts with: the first of c1 … c10 that the fewest live cards use. */
export function nextCardColour(list) {
  const uses = new Map(CARD_COLOUR_KEYS.map((k) => [k, 0]));
  for (const c of list ?? []) if (uses.has(c.colour)) uses.set(c.colour, uses.get(c.colour) + 1);
  const least = Math.min(...uses.values());
  return CARD_COLOUR_KEYS.find((k) => uses.get(k) === least);
}

/** The Settings row's second line: the payment due day and the statement closing day, when set. */
export function cardDaysText(card) {
  return [
    card?.due ? t('settings.cards.due', { day: card.due }) : '',
    card?.cut ? t('settings.cards.cut', { day: card.cut }) : '',
  ].filter(Boolean).join(' · ');
}

/** The message for a nickname cardNameProblem refuses, or ''. */
export function cardNameError(problem) {
  if (problem === 'empty') return t('card.error.name');
  if (problem === 'long') return t('card.error.long', { max: CARD_NAME_MAX });
  if (problem === 'digits') return t('card.error.digits');
  return '';
}

/** Fill a day-of-month select: Not set (''), then 1 … 31. */
export function fillDaySelect(select, current = null) {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  select.innerHTML = `<option value="">${esc(t('card.day.none'))}</option>`
    + days.map((d) => `<option value="${d}">${esc(t('card.day', { day: d }))}</option>`).join('');
  select.value = Number.isInteger(current) && current >= 1 && current <= 31 ? String(current) : '';
}

/**
 * Bind Settings → Payment cards and the card sheet. `ui` gives the app's shared pieces: storage,
 * record() (the settings record, or null before settings are shared), items() (the live items),
 * writable() (whether cards can be written: storage.cardsWritable), openDialog / closeDialog (the
 * overlay stack), confirmDialog, toast, keyboardLikely, and changed() (read the data again and
 * redraw, after a write). Returns { render, open }.
 */
export function createCardsUI(ui) {
  const $ = (sel, root = document) => root.querySelector(sel);
  const section = $('#card-settings');
  const list = $('#card-list');
  const empty = $('#card-empty');
  const dlg = $('#card-dialog');
  const form = $('#card-form');
  const f = form.elements;
  let editing = null; // the card being edited ({ id, … }), or null when adding
  let colourPicked = false; // a swatch was chosen in this sheet (an editor save keeps an unknown colour otherwise)

  $('#card-colours').innerHTML = CARD_COLOUR_KEYS.map((k) => `<input type="radio" class="swatch" name="cardColour" value="${k}" style="--swatch: var(--card-${k})" aria-label="${esc(t(CARD_COLOUR_NAMES[k]))}" title="${esc(t(CARD_COLOUR_NAMES[k]))}">`).join('');

  const setError = (msg) => {
    f.cardName.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (!msg) f.cardName.removeAttribute('aria-invalid');
    $('[data-error-for="cardName"]', form).textContent = msg;
  };
  // The sheet's header glyph follows the colour picked (or the stored one this version can't draw).
  const drawHead = () => {
    const glyph = $('#card-form-glyph');
    const colour = f.cardColour.value || editing?.colour || '';
    if (isCardColourKey(colour)) glyph.dataset.colour = colour; else delete glyph.dataset.colour;
  };

  function render() {
    const record = ui.record();
    const on = !!record && ui.writable();
    section.hidden = !on;
    if (!on) return;
    const cards = listCards(record);
    empty.hidden = cards.length > 0;
    list.hidden = cards.length === 0;
    list.innerHTML = cards.map((c) => {
      const days = cardDaysText(c);
      return `<li><button type="button" class="setting-row card-row" data-card="${esc(c.id)}" aria-label="${esc(t('settings.cards.editLabel', { name: c.name }))}">
        ${cardGlyphHTML(c)}
        <span class="setting-label card-row-label"><span class="card-row-name">${esc(c.name)}</span>${days ? `<span class="setting-hint">${esc(days)}</span>` : ''}</span>
      </button></li>`;
    }).join('');
  }

  function open(id = null) {
    const cards = listCards(ui.record());
    editing = id ? cards.find((c) => c.id === id) ?? null : null;
    if (id && !editing) return; // gone meanwhile (another device deleted it)
    form.reset();
    setError('');
    colourPicked = false;
    $('#card-dialog-title').textContent = t(editing ? 'card.title.edit' : 'card.title.new');
    f.cardName.value = editing?.name ?? '';
    const colour = editing ? editing.colour : nextCardColour(cards);
    for (const r of form.querySelectorAll('input[name="cardColour"]')) r.checked = r.value === colour;
    fillDaySelect(f.cardCut, editing?.cut ?? null);
    fillDaySelect(f.cardDue, editing?.due ?? null);
    $('#btn-card-delete').hidden = !editing;
    drawHead();
    ui.openDialog(dlg);
    // As the item sheet (js/app.js openForm): adding starts at Nickname when a hardware keyboard is
    // likely; otherwise at the sheet itself, so a phone's keyboard doesn't open with it.
    if (!editing && ui.keyboardLikely()) f.cardName.focus({ preventScroll: true }); else dlg.focus({ preventScroll: true });
  }

  async function save() {
    const name = f.cardName.value.trim();
    const problem = cardNameProblem(name);
    if (problem) { setError(cardNameError(problem)); f.cardName.focus(); return; }
    const cards = listCards(ui.record());
    if (!editing) {
      // A nickname that is already a card picks that card instead of adding a second one: the sheet
      // shows it, as editing it would, and nothing is written.
      const same = cardByName(cards, name);
      if (same) { open(same.id); return; }
    }
    const day = (v) => (v === '' ? null : Number(v));
    const card = { name, cut: day(f.cardCut.value), due: day(f.cardDue.value) };
    // An editor save leaves a colour this version can't draw as it is, unless a swatch was picked.
    if (!editing || colourPicked || isCardColourKey(editing.colour)) card.colour = f.cardColour.value || '';
    const id = editing?.id ?? newCardId(ui.record());
    try {
      await ui.storage.saveCard(id, card);
    } catch (err) {
      console.error(err);
      ui.toast(t('card.toast.saveFailed'));
      return;
    }
    ui.closeDialog(dlg);
    await ui.changed();
    ui.toast(t(editing ? 'card.toast.saved' : 'card.toast.added', { name }));
  }

  async function remove() {
    if (!editing) return;
    const card = editing;
    const count = itemsPaidWith(ui.items(), card.id).length;
    const ok = await ui.confirmDialog({
      title: t('card.delete.title', { name: card.name }),
      message: count ? t('card.delete.message', { count }) : t('card.delete.messageUnused'),
      actions: [{ label: t('common.cancel'), value: false }, { label: t('card.delete'), value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try {
      await ui.storage.deleteCard(card.id);
    } catch (err) {
      console.error(err);
      ui.toast(t('card.toast.saveFailed'));
      return;
    }
    ui.closeDialog(dlg);
    await ui.changed();
    ui.toast(t('card.toast.deleted', { name: card.name }));
  }

  $('#btn-card-add').addEventListener('click', () => open());
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-card]');
    if (b) open(b.dataset.card);
  });
  f.cardName.addEventListener('input', () => setError(''));
  form.addEventListener('change', (e) => {
    if (e.target.name === 'cardColour') { colourPicked = true; drawHead(); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('#btn-card-delete').addEventListener('click', () => remove());
  for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => ui.closeDialog(dlg));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) ui.closeDialog(dlg); });
  // The floating buttons come back once no sheet is open (js/app.js openDialog hides them).
  dlg.addEventListener('close', () => {
    if (![...document.querySelectorAll('dialog.sheet')].some((d) => d.open)) document.body.classList.remove('sheet-open');
  });

  return { render, open };
}
