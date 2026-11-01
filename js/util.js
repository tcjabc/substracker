export const CURRENCIES = [
  'TWD', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'CNY', 'KRW', 'SGD', 'AUD', 'CAD', 'NZD', 'CHF', 'THB', 'MYR', 'PHP', 'IDR', 'VND', 'INR',
];

export const CYCLES = { monthly: 'monthly', annual: 'annual' };

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const monthlyCost = (s) => (s.cycle === 'annual' ? s.price / 12 : s.price);
export const annualCost = (s) => (s.cycle === 'annual' ? s.price : s.price * 12);

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

export const cycleLabel = (c) => (c === 'annual' ? '/ yr' : '/ mo');

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

export function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Stable small hash for picking avatar colours. */
export function hash(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}
