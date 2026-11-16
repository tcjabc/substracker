export const CURRENCIES = [
  'TWD', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'CNY', 'KRW', 'SGD', 'AUD', 'CAD', 'NZD', 'CHF', 'THB', 'MYR', 'PHP', 'IDR', 'VND', 'INR',
];

// Region → currency, for the currencies in the list above. Used to pick a first-run default.
const REGION_CURRENCY = {
  TW: 'TWD', US: 'USD', GB: 'GBP', JP: 'JPY', HK: 'HKD', CN: 'CNY', KR: 'KRW', SG: 'SGD', AU: 'AUD',
  CA: 'CAD', NZ: 'NZD', CH: 'CHF', LI: 'CHF', TH: 'THB', MY: 'MYR', PH: 'PHP', ID: 'IDR', VN: 'VND', IN: 'INR',
};
const EURO_REGIONS = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK'.split(' ');
for (const r of EURO_REGIONS) REGION_CURRENCY[r] = 'EUR';

/** The device's currency, from its preferred languages ("zh-TW", "en-GB", "ja"). Falls back to `fallback`. */
export function localeCurrency(fallback = 'TWD') {
  const langs = globalThis.navigator?.languages?.length ? navigator.languages : [globalThis.navigator?.language];
  for (const lang of langs) {
    if (!lang) continue;
    let region = '';
    try { region = new Intl.Locale(lang).maximize().region || ''; } catch { region = (lang.split(/[-_]/)[1] || '').toUpperCase(); }
    if (REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  }
  return fallback;
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Records without a `type` predate income support and are expenses. */
export const isIncome = (s) => s.type === 'income';
export const isOnce = (s) => s.cycle === 'once';

// Recurring cost only; one-offs are counted by date via amountInMonth / amountInYear.
export const monthlyCost = (s) => (isOnce(s) ? 0 : s.cycle === 'annual' ? s.price / 12 : s.price);
export const annualCost = (s) => (isOnce(s) ? 0 : s.cycle === 'annual' ? s.price : s.price * 12);

/** Amount counted in a month (0-based): recurring at monthly equivalent, one-offs only in their own month. */
export function amountInMonth(s, year, month) {
  if (!isOnce(s)) return monthlyCost(s);
  const d = parseDate(s.date);
  return d && d.getFullYear() === year && d.getMonth() === month ? s.price : 0;
}

/** Amount counted in a calendar year: monthly × 12 + annual, one-offs only in their own year. */
export function amountInYear(s, year) {
  if (!isOnce(s)) return annualCost(s);
  const d = parseDate(s.date);
  return d && d.getFullYear() === year ? s.price : 0;
}

const fmtCache = new Map();
export function money(amount, currency) {
  const key = currency;
  if (!fmtCache.has(key)) {
    let f;
    try {
      f = new Intl.NumberFormat(undefined, {
        // "symbol" keeps dollar currencies distinct (NT$, HK$, US$ depending on locale).
        style: 'currency', currency, currencyDisplay: 'symbol',
        minimumFractionDigits: 0, maximumFractionDigits: 2,
      });
    } catch {
      f = { format: (n) => `${currency} ${n.toFixed(2)}` };
    }
    fmtCache.set(key, f);
  }
  return fmtCache.get(key).format(amount);
}

export const cycleLabel = (c) => (c === 'annual' ? '/ yr' : c === 'once' ? '' : '/ mo');

/** Parse a stored YYYY-MM-DD date as a local date (no timezone shift). */
export function parseDate(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addCycle(date, cycle, originalDay) {
  const months = cycle === 'annual' ? 12 : 1;
  const y = date.getFullYear();
  const m = date.getMonth() + months;
  // Clamp to the last day of the target month (e.g. Jan 31 -> Feb 28), keep the original day after.
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(originalDay, last));
}

/** The next renewal on or after today, rolling a past stored date forward by its cycle. */
export function nextRenewal(sub) {
  if (isOnce(sub)) return null;
  const start = parseDate(sub.nextRenewal);
  if (!start) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let d = start;
  let guard = 0;
  while (d < today && guard++ < 1200) d = addCycle(d, sub.cycle, start.getDate());
  return d;
}

export function daysUntil(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date - today) / 86400000);
}

/** "Renews in 3 days" for a plan; for income (`income` true) "Payment in 3 days", never "renews". */
export function renewalText(date, income = false) {
  const word = income ? 'Payment' : 'Renews';
  const n = daysUntil(date);
  if (n === 0) return `${word} today`;
  if (n === 1) return `${word} tomorrow`;
  if (n < 7) return `${word} in ${n} days`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${word} ` + date.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Short date for one-off items, e.g. "3 Nov" (with the year when it isn't this year). */
export function shortDate(date) {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A grapheme counts as an emoji if it holds a pictograph, a flag letter or a keycap mark.
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
// Fallback when Intl.Segmenter is missing: one emoji sequence (flag, keycap, or ZWJ chain with modifiers).
const EMOJI_SEQ = /\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*/u;

/**
 * The first emoji in a string as one whole grapheme (so flags, skin tones and ZWJ families stay
 * intact), or '' if there is none. Letters, digits and other text are ignored.
 */
export function firstEmoji(str) {
  const s = String(str ?? '');
  if (!s) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) {
      if (EMOJI_PART.test(segment)) return segment.slice(0, 32);
    }
    return '';
  }
  return (s.match(EMOJI_SEQ)?.[0] ?? '').slice(0, 32);
}

const countOf = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The extra lines the import dialog shows when this device syncs: both choices reach every device. */
export const REPLACE_SYNC_WARNING = 'Replace all deletes the current items and settings here and on every device you sync with.';
export const MERGE_SYNC_NOTE = 'Changes are sent to every device you sync with.';

/** The final confirmation after choosing Replace all. */
export const REPLACE_CONFIRM_TITLE = 'Replace everything?';
export const REPLACE_CONFIRM_MESSAGE = "This deletes all current items and settings on this device. This can't be undone.";
export const REPLACE_CONFIRM_SYNC = 'It also deletes them on every device you sync with.';

/**
 * The import dialog's text from previewImport()'s { merge, replace } summaries. `synced` is
 * whether sync is set up on this device; only then are the Replace warning and the Merge note
 * added, each on its own line.
 */
export function importMessage({ merge, replace }, { synced = false } = {}) {
  const newer = merge.newerVersion
    ? ' It comes from a newer version of Peek Budget; fields this version doesn\'t know are ignored.' : '';
  const text = merge.existing
    ? `${countOf(merge.total, 'item')}, ${merge.added} new.${newer} Merge adds the new ones, updates ${merge.updated} where the file's copy is newer`
      + `${merge.kept ? ` and keeps ${merge.kept} where yours is the same or newer` : ''}. `
      + `Replace deletes your ${countOf(merge.existing, 'item')} and uses the file's items${replace.withSettings ? ' and settings' : ''}`
      + `${replace.removed ? ` (${replace.removed} of yours aren't in the file)` : ''}.`
    : `${countOf(merge.total, 'item')}, ${merge.added} new.${newer} Your list is empty, so both options give the same result.`;
  return synced ? `${text}\n${REPLACE_SYNC_WARNING}\n${MERGE_SYNC_NOTE}` : text;
}

/** The dialog options for the final Replace confirmation. Cancel comes first: it's focused, and dismissing picks it. */
export function replaceConfirm({ synced = false } = {}) {
  return {
    title: REPLACE_CONFIRM_TITLE,
    message: synced ? `${REPLACE_CONFIRM_MESSAGE}\n${REPLACE_CONFIRM_SYNC}` : REPLACE_CONFIRM_MESSAGE,
    actions: [{ label: 'Cancel', value: false }, { label: 'Replace all', value: true, kind: 'danger' }],
  };
}

/**
 * Ask how to import: the Merge / Replace all choice, then, for Replace, a final confirmation.
 * `confirm` shows a dialog ({ title, message, actions, stacked }) and resolves with the chosen
 * action's value (the first action's when dismissed). Resolves with 'merge', 'replace', or null
 * when the person cancelled at either step, in which case nothing may be applied.
 */
export async function chooseImportMode(preview, { synced = false, confirm }) {
  const mode = await confirm({
    title: 'Import this backup?',
    message: importMessage(preview, { synced }),
    stacked: true,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Replace all', value: 'replace', kind: 'danger' },
      { label: 'Merge', value: 'merge', kind: 'primary' },
    ],
  });
  if (mode === 'merge') return 'merge';
  if (mode !== 'replace') return null;
  return (await confirm(replaceConfirm({ synced }))) === true ? 'replace' : null;
}

/** Stable small hash for picking avatar colours. */
export function hash(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}
