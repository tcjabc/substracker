import { formatLocale, relativeDays, t } from './i18n.js';
import { effectiveInterval, indexOnOrAfter, occurrence, dayOf, dateOf } from './interval.js';

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

// One formatter per formatting locale and currency. The locale is js/i18n.js formatLocale():
// undefined (the device's conventions, exactly as before languages existed) unless a language
// other than the device's was picked.
const fmtCache = new Map();
function moneyFormat(currency, locale = formatLocale()) {
  const key = `${locale ?? ''}|${currency}`;
  if (!fmtCache.has(key)) {
    let f;
    try {
      f = new Intl.NumberFormat(locale, {
        // "symbol" keeps dollar currencies distinct (NT$, HK$, US$ depending on locale).
        style: 'currency', currency, currencyDisplay: 'symbol',
        minimumFractionDigits: 0, maximumFractionDigits: 2,
      });
    } catch {
      f = { format: (n) => `${currency} ${n.toFixed(2)}` };
    }
    fmtCache.set(key, f);
  }
  return fmtCache.get(key);
}
export function money(amount, currency, locale = formatLocale()) {
  return moneyFormat(currency, locale).format(amount);
}

/**
 * `money(amount, currency, locale)` as its parts ({ type, value }, Intl formatToParts types:
 * 'currency', 'minusSign', 'integer', 'group', 'decimal', 'fraction', 'literal'…), from the same
 * formatter (same locale), so joining the values gives exactly money()'s text. The rolling totals
 * (js/count-anim.js) use it. Where the formatter can't give parts, digit runs come back as
 * 'integer' and the rest as 'literal'.
 */
export function moneyParts(amount, currency, locale = formatLocale()) {
  const f = moneyFormat(currency, locale);
  if (typeof f.formatToParts === 'function') return f.formatToParts(amount);
  return (f.format(amount).match(/\d+|\D+/g) || []).map((v) => ({ type: /\d/.test(v) ? 'integer' : 'literal', value: v }));
}

export const cycleLabel = (c) => (c === 'annual' ? t('cycle.perYear') : c === 'once' ? '' : t('cycle.perMonth'));

/**
 * Parse a stored YYYY-MM-DD date as a local date (no timezone shift). A day past the month's end
 * rolls over (2026-02-30 is 2 March), as it always has. Years 0–99 are those years (js/interval.js
 * dateOf), not 1900–1999 as the Date constructor would make them.
 */
export function parseDate(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  return dateOf({ year: y, month: m - 1, day: d });
}

/**
 * The next renewal on or after today, rolling a past stored date forward by the item's interval
 * (js/interval.js effectiveInterval: its repeat when that counts, else monthly every 1 month and
 * annual every 12, clamped from the stored day). Never a date before the
 * stored one, and never one before today, however old the stored date (worked out directly, with no
 * step limit). Display only: the stored date is never rewritten. `now` is for the pure modules and
 * their tests.
 */
export function nextRenewal(sub, now = new Date()) {
  if (isOnce(sub)) return null;
  const start = parseDate(sub.nextRenewal);
  if (!start) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(today.getTime())) return start; // nothing to compare with
  const anchor = dayOf(start);
  const interval = effectiveInterval(sub);
  const k = Math.max(0, indexOnOrAfter(anchor, interval, dayOf(today)));
  return k === 0 ? start : dateOf(occurrence(anchor, interval, k));
}

export function daysUntil(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date - today) / 86400000);
}

/** "Renews in 3 days" for a plan; for income (`income` true) "Payment in 3 days", never "renews". */
export function renewalText(date, income = false) {
  const n = daysUntil(date);
  if (n === 0) return income ? t('date.payment.today') : t('date.renews.today');
  if (n === 1) return income ? t('date.payment.tomorrow') : t('date.renews.tomorrow');
  if (n < 7) return income ? t('date.payment.inDays', { count: n }) : t('date.renews.inDays', { count: n });
  return income ? t('date.payment.on', { date: shortDate(date) }) : t('date.renews.on', { date: shortDate(date) });
}

/** Short date for one-off items, e.g. "3 Nov" (with the year when it isn't this year). */
export function shortDate(date) {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(formatLocale(), {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** "Today", "Tomorrow", "In 3 days" for `date` (js/i18n.js relativeDays). For the upcoming banner. */
export const relativeDay = (date) => relativeDays(daysUntil(date));

/** A local date as YYYY-MM-DD (no timezone shift), the way dates are stored. */
export function dayStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayStamp() {
  return dayStamp(new Date());
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

const items = (n) => t('common.items', { count: n });

// The wording is read when it's needed (functions, not constants), in the language in use then.
/** The extra lines the import dialog shows when this device syncs: both choices reach every device. */
export const replaceSyncWarning = () => t('import.sync.replaceWarning');
export const mergeSyncNote = () => t('import.sync.mergeNote');

/** The final confirmation after choosing Replace all. */
export const replaceConfirmTitle = () => t('import.replace.title');
export const replaceConfirmMessage = () => t('import.replace.message');
export const replaceConfirmSync = () => t('import.replace.sync');

/**
 * The import dialog's text from previewImport()'s { merge, replace } summaries. `synced` is
 * whether sync is set up on this device; only then are the Replace warning and the Merge note
 * added, each on its own line.
 */
export function importMessage({ merge, replace }, { synced = false } = {}) {
  const parts = [t('import.summary', { items: items(merge.total), added: merge.added })];
  if (merge.newerVersion) parts.push(t('import.newer'));
  if (merge.existing) {
    parts.push(merge.kept
      ? t('import.merge.kept', { updated: merge.updated, kept: merge.kept })
      : t('import.merge.updated', { updated: merge.updated }));
    const yours = items(merge.existing);
    const key = replace.withSettings
      ? (replace.removed ? 'import.replace.settingsRemoved' : 'import.replace.settings')
      : (replace.removed ? 'import.replace.itemsRemoved' : 'import.replace.items');
    parts.push(t(key, { items: yours, removed: replace.removed }));
  } else parts.push(t('import.sameResult'));
  const text = parts.join(t('common.sentenceSep'));
  return synced ? `${text}\n${replaceSyncWarning()}\n${mergeSyncNote()}` : text;
}

/** The dialog options for the final Replace confirmation. Cancel comes first: it's focused, and dismissing picks it. */
export function replaceConfirm({ synced = false } = {}) {
  return {
    title: replaceConfirmTitle(),
    message: synced ? `${replaceConfirmMessage()}\n${replaceConfirmSync()}` : replaceConfirmMessage(),
    actions: [{ label: t('common.cancel'), value: false }, { label: t('import.replaceAll'), value: true, kind: 'danger' }],
  };
}

/**
 * The label of an optional "Export a backup first" button: the item count when there are items,
 * and "Backup saved ✓" once a backup was delivered.
 */
export function backupLabel(count, saved = false) {
  if (saved) return t('import.backup.saved');
  return count > 0 ? t('import.backup.withCount', { items: items(count) }) : t('common.exportBackupFirst');
}

/**
 * Ask how to import: the Merge / Replace all choice, then, for Replace, a final confirmation.
 * `confirm` shows a dialog ({ title, message, actions, stacked }) and resolves with the chosen
 * action's value (the first action's when dismissed). Resolves with 'merge', 'replace', or null
 * when the person cancelled at either step, in which case nothing may be applied.
 * `title`, `message` and `replace` (the final confirmation's options) replace the backup-file
 * wording. `backup`, when given, is an async () => boolean (true once a backup was delivered) and
 * adds an optional backup button beside Replace all at both steps, labelled by backupLabel with
 * `count`; choosing it runs the backup and shows the same step again. It is never required.
 */
export async function chooseImportMode(preview, {
  synced = false, confirm, title = t('import.title'), message, replace, backup, count = 0,
} = {}) {
  let saved = false;
  const backupAction = () => (backup ? [{ label: backupLabel(count, saved), value: 'backup' }] : []);
  const runBackup = async () => { try { saved = (await backup()) === true || saved; } catch { /* the backup reports its own failure */ } };
  for (;;) {
    const mode = await confirm({
      title,
      message: message ?? importMessage(preview, { synced }),
      stacked: true,
      actions: [
        { label: t('common.cancel'), value: null },
        ...backupAction(),
        { label: t('import.replaceAll'), value: 'replace', kind: 'danger' },
        { label: t('import.merge'), value: 'merge', kind: 'primary' },
      ],
    });
    if (mode === 'backup') { await runBackup(); continue; }
    if (mode === 'merge') return 'merge';
    if (mode !== 'replace') return null;
    break;
  }
  const final = replace ?? replaceConfirm({ synced });
  for (;;) {
    const [cancel, ...rest] = final.actions;
    const ok = await confirm({ ...final, actions: [cancel, ...backupAction(), ...rest] });
    if (ok === 'backup') { await runBackup(); continue; }
    return ok === true ? 'replace' : null;
  }
}

/** Stable small hash for picking avatar colours. */
export function hash(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}

/**
 * Whether "Reduce motion and effects" is on. `pref` is this device's saved choice ('on', 'off', or
 * null when never set); an unset choice follows the system's prefers-reduced-motion (`systemReduce`).
 */
export const reduceMotionFrom = (pref, systemReduce) => (pref === 'on' ? true : pref === 'off' ? false : !!systemReduce);

/** Insights "By category" view from the saved preference: a saved Donut or List is kept, else the Ring. */
export const catViewFrom = (pref) => (pref === 'donut' || pref === 'list' ? pref : 'ring');

/** The Insights year chart's stacking from the saved preference: a saved By type is kept, else By category. */
export const yearStackFrom = (pref) => (pref === 'type' ? 'type' : 'category');

/**
 * The Money tab view from the saved preference: a saved Grid or List is kept, else the Wallet. A
 * saved Calendar (1.19.0, when it was a view here) is the Wallet: the calendar has its own tab now.
 */
export const viewFrom = (pref) => (pref === 'grid' || pref === 'list' ? pref : 'wallet');
