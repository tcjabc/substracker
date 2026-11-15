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

export function renewalText(date) {
  const n = daysUntil(date);
  if (n === 0) return 'Renews today';
  if (n === 1) return 'Renews tomorrow';
  if (n < 7) return `Renews in ${n} days`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return 'Renews ' + date.toLocaleDateString(undefined, {
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

/** Stable small hash for picking avatar colours. */
export function hash(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}
