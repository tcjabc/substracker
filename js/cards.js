// Payment cards, the groundwork (1.26.0; docs/plan-cards.md). Pure: no storage, no DOM, no strings.
//
// A card is one field of the shared settings record (js/storage.js SETTINGS_ID): `card_<id>` with
// the value { name, colour, cut, due }, written only with setFields on that record (never as a
// record of its own, which could show up as an item). A deleted card stays as a tombstone, its
// value with `gone: true`, so a device that hasn't seen the delete can't bring it back with an
// older value. An expense item says how it is paid in its `pay` field: '' Not set, 'cash' Cash,
// otherwise a card id.
//
// Every value is read tolerantly, as `repeat` is: sync stores any plain JSON for a card field and
// for `pay` (a skipped op never comes back), and a value this version can't use reads as no card
// (listCards skips it) or as Not set (payOf). Nothing here throws on a value from another device.

/** The settings-record field prefix of a card. */
export const CARD_PREFIX = 'card_';
/** The item field that says how an item is paid. */
export const PAY_FIELD = 'pay';
/** `pay` for Not set (the same as no `pay` field at all). Never null: the item sheet compares with ''. */
export const PAY_NOT_SET = '';
/** `pay` for Cash. Never a card id. */
export const PAY_CASH = 'cash';
/** The longest card nickname kept. */
export const CARD_NAME_MAX = 40;
/** The longest card id: a field name is at most 64 characters (js/sync-core.js FIELD_RE), and `card_` takes 5. */
export const CARD_ID_MAX = 64 - CARD_PREFIX.length;

const ID_RE = /^[A-Za-z0-9_]+$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDayOfMonth = (v) => Number.isInteger(v) && v >= 1 && v <= 31;

/**
 * Whether `v` can be a card id: 1-59 letters, digits or `_` (a dash would make a field name every
 * version refuses for good), and never `cash` in any case, so it can't be read as Cash.
 */
export function isCardId(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= CARD_ID_MAX && ID_RE.test(v) && v.toLowerCase() !== PAY_CASH;
}

/** The settings-record field for card `id`, or null when `id` can't be a card id. */
export function cardFieldName(id) {
  return isCardId(id) ? `${CARD_PREFIX}${id}` : null;
}

/** The card id in a settings-record field name, or null when it isn't a card field. */
export function cardIdOf(field) {
  if (typeof field !== 'string' || !field.startsWith(CARD_PREFIX)) return null;
  const id = field.slice(CARD_PREFIX.length);
  return isCardId(id) ? id : null;
}

/**
 * A card value as this version reads it: { name, colour, cut, due } for a live card, { gone: true }
 * for a deleted one, or null when it can't be used. Tolerant: a name (trimmed, cut to 40) is all a
 * live card needs; a colour that isn't a short string reads as '', a cut-off or due day that isn't
 * a whole number 1-31 as null. Keys a later version adds are left out of the result (and stay in
 * the record).
 */
export function parseCardValue(v) {
  if (!isObj(v)) return null;
  if (v.gone === true) return { gone: true };
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, CARD_NAME_MAX) : '';
  if (!name) return null;
  return {
    name,
    colour: typeof v.colour === 'string' && v.colour.length <= 16 ? v.colour : '',
    cut: isDayOfMonth(v.cut) ? v.cut : null,
    due: isDayOfMonth(v.due) ? v.due : null,
  };
}

/**
 * The value to write for a card from { name, colour?, cut?, due? }, cleaned as parseCardValue reads
 * it, or null when it has no usable name.
 */
export function cardValue(card) {
  const p = parseCardValue(isObj(card) ? { ...card, gone: undefined } : card);
  return p && !p.gone ? p : null;
}

/** A deleted card's value: what it held, with `gone: true` (a usable value stays readable for history). */
export function cardTombstone(value) {
  const p = parseCardValue(isObj(value) ? { ...value, gone: undefined } : value);
  return p && !p.gone ? { ...p, gone: true } : { gone: true };
}

/**
 * The live cards in a settings record ({ fields }): [{ id, name, colour, cut, due }], by name, then
 * id. Fields that aren't card fields, deleted cards and unusable values are skipped (and kept).
 * Two cards may share a name (two devices added "Visa" offline): both are listed.
 */
export function listCards(record) {
  const out = [];
  for (const [f, v] of Object.entries(isObj(record?.fields) ? record.fields : {})) {
    const id = cardIdOf(f);
    const p = id ? parseCardValue(v) : null;
    if (p && !p.gone) out.push({ id, ...p });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The live cards as a map id → { name, colour, cut, due } (the shape a backup carries). */
export function cardMap(record) {
  return Object.fromEntries(listCards(record).map(({ id, ...card }) => [id, card]));
}

/**
 * How an item is paid, as this version reads its `pay`: 'cash', a card id, or '' (Not set). A value
 * that isn't a string, or a string that is neither, is Not set. Whether the card still exists is the
 * caller's question (listCards).
 */
export function payOf(item) {
  const v = item?.[PAY_FIELD];
  if (v === PAY_CASH || isCardId(v)) return v;
  return PAY_NOT_SET;
}

/** Whether `v` is a `pay` value this version writes: '', 'cash' or a card id. */
export const isPayValue = (v) => v === PAY_NOT_SET || v === PAY_CASH || isCardId(v);
