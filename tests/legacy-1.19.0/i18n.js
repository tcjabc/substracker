// FROZEN: js/i18n.js from Peek Budget 1.19.0 (commit 08bcdc4), byte for byte below these two lines.
// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).
// The app's words: t(key, params) looks a key up in the active locale's dictionary (js/locales/),
// fills in {placeholders} and picks plural forms with Intl.PluralRules. English (js/locales/en.js)
// is bundled and is the fallback for anything another locale lacks; other locales load on first
// use and are precached by sw.js. A key missing everywhere logs an error and shows nothing: a raw
// key never reaches the screen.
//
// The language is a per-device choice (localStorage `substracker.lang`: 'auto' or a locale), never
// synced or exported. 'auto' follows the device's languages, falling back to English. `?lang=xx`
// in the address shows the pseudo-locale (bracketed, accented, about 30% longer), for finding text
// that isn't translatable yet and layouts that don't stretch; it's never saved or offered.
//
// User data (item, group and category names, the preset names in js/services.js), the 12 recovery
// words, the Import with AI prompt and its JSON, CSV headers and backup or sync formats are never
// translated.

import en from './locales/en.js';

/**
 * The UI locales: tag → { name (in its own language), load, collation, weekdays }. English is
 * bundled. `collation` is the locale for ordering group names (A to Z); without one, the device's
 * own order, as English always had. zh-TW sorts by Zhuyin (ㄅㄆㄇㄈ), Taiwan's standard order.
 * `weekdays` is how the calendar's column heads name the days ('short' unless given): zh-TW uses
 * the single characters 一 二 三 (its 'narrow' names), as Taiwanese calendars do.
 */
export const LOCALES = Object.freeze({
  en: Object.freeze({ name: 'English', load: null }),
  // A new locale is one line here, its file in js/locales/ and its sw.js SHELL entry.
  'zh-TW': Object.freeze({ name: '繁體中文', load: () => import('./locales/zh-TW.js'), collation: 'zh-TW-u-co-zhuyin', weekdays: 'narrow' }),
});
export const FALLBACK = 'en';
/** The pseudo-locale (dev only, from the address); its document lang is the standard pseudo tag. */
export const PSEUDO = 'xx';
const PSEUDO_LANG = 'en-XA';
export const LANG_PREF = 'substracker.lang';

const dicts = new Map([[FALLBACK, en]]);
const state = { locale: FALLBACK, dict: en, setting: 'auto', format: undefined };
const warned = new Set();
const pluralCache = new Map();
const plurals = (locale) => {
  if (!pluralCache.has(locale)) pluralCache.set(locale, new Intl.PluralRules(locale === PSEUDO ? FALLBACK : locale));
  return pluralCache.get(locale);
};

/* Lookup ---------------------------------------------------------------------------------------- */

/** The dictionary entry for `key`, choosing the plural form for params.count; undefined when absent. */
function entry(dict, locale, key, params) {
  if (Object.hasOwn(dict, key)) return dict[key];
  if (params && typeof params.count === 'number') {
    const form = `${key}.${plurals(locale).select(params.count)}`;
    if (Object.hasOwn(dict, form)) return dict[form];
    if (Object.hasOwn(dict, `${key}.other`)) return dict[`${key}.other`];
  }
  return undefined;
}

/** `template` with each {name} replaced by params.name (as text); unknown names stay as they are. */
export function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/** The template for `key` in the active locale, else English, else '' (never the key itself). */
function template(key, params) {
  let s = entry(state.dict, state.locale, key, params);
  if (s === undefined && state.dict !== en) {
    s = entry(en, FALLBACK, key, params);
    if (s !== undefined) warnOnce(`i18n: "${key}" is missing in ${state.locale}; using English.`);
  }
  if (s === undefined) {
    warnOnce(`i18n: "${key}" is missing in English.`);
    return '';
  }
  return s;
}

/** The text for `key`, with {placeholders} from `params`; params.count picks the plural form. */
export function t(key, params) {
  return interpolate(template(key, params), params);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Markup for `key`. A key ending in "Html" holds a few tags of its own (such as a figure in
 * <strong>) and is used as it is; any other key's text is escaped. Every param is escaped, except
 * those in `markup`, which are ready-made markup (such as a <span> around a rolling figure).
 */
export function tHTML(key, params, markup) {
  const tpl = template(key, params);
  const safe = { ...(params && Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escHTML(v)]))), ...markup };
  return interpolate(/Html$/.test(key) ? tpl : escHTML(tpl), safe);
}

/* Locale choice --------------------------------------------------------------------------------- */

const tagParts = (tag) => {
  try { const l = new Intl.Locale(tag).maximize(); return { language: l.language, script: l.script ?? '' }; } catch { return null; }
};
/** Whether two tags are the same language in the same script ("en-GB" and "en"; "zh-HK" and "zh-TW"). */
export function sameLanguage(a, b) {
  const x = tagParts(a), y = tagParts(b);
  return !!x && !!y && x.language === y.language && x.script === y.script;
}

/** Whether two tags are the same language, whatever the script ("zh-CN" and "zh-TW"). */
export function sameBaseLanguage(a, b) {
  const x = tagParts(a), y = tagParts(b);
  return !!x && !!y && x.language === y.language;
}

/**
 * The UI locale for a setting ('auto' or a locale tag) and the device's preferred languages.
 * 'auto' takes the first device language that has a locale: exactly, else the same language and
 * script (zh-Hant, zh-HK and zh-MO → zh-TW), else the same language in another script (zh-CN and
 * other Simplified Chinese → zh-TW, until a Simplified locale exists); else English.
 * Returns { locale, matched }: matched is false when English is a fallback.
 */
export function resolveLocale(setting, languages = [], available = Object.keys(LOCALES)) {
  if (setting && setting !== 'auto' && available.includes(setting)) return { locale: setting, matched: true };
  for (const lang of languages) {
    if (!lang) continue;
    const exact = available.find((a) => a.toLowerCase() === String(lang).toLowerCase());
    if (exact) return { locale: exact, matched: true };
    const near = available.find((a) => sameLanguage(a, lang)) ?? available.find((a) => sameBaseLanguage(a, lang));
    if (near) return { locale: near, matched: true };
  }
  return { locale: FALLBACK, matched: false };
}

/**
 * The locale for numbers, money and dates. `undefined` (the device's own conventions, as before
 * languages existed) when the UI is in the device's language, so en-GB keeps "18 Nov" and en-US
 * "Nov 18", and a zh-CN or zh-HK device in zh-TW keeps its own; also when English is only a
 * fallback ('auto' found no locale for the device). Otherwise the UI locale, so a language picked
 * by hand on a device in another language formats like that language (zh-TW on an en-GB device).
 */
export function formatLocaleFor(locale, { matched = true, deviceLocale } = {}) {
  if (locale === PSEUDO || !matched) return undefined;
  if (deviceLocale && sameBaseLanguage(locale, deviceLocale)) return undefined;
  return locale;
}

const collators = new Map();
/**
 * Compare two names (group names) for display order in the active language, ignoring case and
 * accents. English and the pseudo-locale keep the device's order (localeCompare with no locale,
 * exactly as before languages existed); a locale with a `collation` uses it.
 */
export function compareNames(a, b, locale = state.locale) {
  const tag = Object.hasOwn(LOCALES, locale) ? LOCALES[locale].collation : undefined;
  if (!tag) return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
  if (!collators.has(tag)) collators.set(tag, new Intl.Collator(tag, { sensitivity: 'base' }));
  return collators.get(tag).compare(String(a), String(b));
}

/** The active UI locale ('en' or 'zh-TW'; 'xx' in the pseudo-locale). */
export const getLocale = () => state.locale;
/** The locale to pass to Intl formatters (undefined: the device's conventions). */
export const formatLocale = () => state.format;
/** The saved language setting: 'auto' or a locale tag. */
export const getLangSetting = () => state.setting;

const readPref = () => { try { return globalThis.localStorage?.getItem(LANG_PREF) ?? null; } catch { return null; } };
/** Save this device's language ('auto' or a locale in LOCALES); never synced or exported. */
export function saveLangSetting(value) {
  const v = value === 'auto' || Object.hasOwn(LOCALES, value) ? value : 'auto';
  try {
    if (v === 'auto') globalThis.localStorage?.removeItem(LANG_PREF); else globalThis.localStorage?.setItem(LANG_PREF, v);
  } catch { /* private mode: the choice lasts this visit */ }
  state.setting = v;
  return v;
}

/** Tests only: use `dict` as the dictionary for `locale` (then setLocale(locale) to switch to it). */
export function setDictionaryForTests(locale, dict) { dicts.set(locale, dict); }

async function dictFor(locale) {
  if (locale === PSEUDO) {
    if (!dicts.has(PSEUDO)) dicts.set(PSEUDO, pseudoDict(en));
    return dicts.get(PSEUDO);
  }
  if (!dicts.has(locale)) {
    const mod = await LOCALES[locale].load();
    dicts.set(locale, mod.default);
  }
  return dicts.get(locale);
}

/**
 * Switch to `locale` (a key of LOCALES, or PSEUDO); loads its dictionary when needed. A locale that
 * fails to load leaves English in place. Sets the document's lang. `matched` and `deviceLocale`
 * decide the formatting locale (see formatLocaleFor).
 */
export async function setLocale(locale, { matched = true, deviceLocale = deviceFormatLocale() } = {}) {
  const want = locale === PSEUDO || Object.hasOwn(LOCALES, locale) || dicts.has(locale) ? locale : FALLBACK;
  let dict = en;
  let use = FALLBACK;
  try { dict = await dictFor(want); use = want; } catch (err) { console.error(`i18n: ${want} could not be loaded; using English.`, err); }
  state.locale = use;
  state.dict = dict;
  state.format = formatLocaleFor(use, { matched: use === want && matched, deviceLocale });
  if (globalThis.document?.documentElement) document.documentElement.lang = use === PSEUDO ? PSEUDO_LANG : use;
  return use;
}

function deviceFormatLocale() {
  try { return new Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

/**
 * At start-up: the saved setting (or ?lang=xx for the pseudo-locale), resolved against the
 * device's languages, then loaded. Resolves with the active locale.
 */
export async function initLanguage({ search = globalThis.location?.search ?? '', languages } = {}) {
  const saved = readPref();
  state.setting = saved && Object.hasOwn(LOCALES, saved) ? saved : 'auto';
  if (new URLSearchParams(search).get('lang') === PSEUDO) return setLocale(PSEUDO, { matched: false });
  const nav = globalThis.navigator;
  const langs = languages ?? (nav?.languages?.length ? [...nav.languages] : [nav?.language]);
  const { locale, matched } = resolveLocale(state.setting, langs);
  return setLocale(locale, { matched });
}

/* Markup ---------------------------------------------------------------------------------------- */

/** Replace an element's own words with `text`, keeping its child elements and surrounding spaces. */
function setOwnText(el, text) {
  if (!el.children.length) {
    const raw = el.textContent;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.slice(lead.length).match(/\s*$/)[0];
    const next = raw.trim() ? `${lead}${text}${trail}` : text;
    if (raw !== next) el.textContent = next;
    return;
  }
  const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
  if (!node) { el.prepend(text); return; }
  const v = node.nodeValue;
  const lead = v.match(/^\s*/)[0];
  const trail = v.slice(lead.length).match(/\s*$/)[0];
  const next = `${lead}${text}${trail}`;
  if (v !== next) node.nodeValue = next;
}

/**
 * Put the active locale's words into markup under `root`:
 *   data-i18n="key"            the element's own text (child elements such as hints are kept)
 *   data-i18n-html="key"       the element's markup, from an "...Html" key
 *   data-i18n-attr="aria-label:key; title:key"   attributes
 *   data-i18n-native="key"     the native app's wording instead (js/app.js applies it there)
 * index.html keeps its English text too, so the page reads the same before this runs. The
 * contents of <template> elements are filled in as well.
 */
export function applyI18n(root = document) {
  for (const tpl of root.querySelectorAll('template')) applyI18n(tpl.content);
  for (const el of root.querySelectorAll('[data-i18n]')) setOwnText(el, t(el.dataset.i18n));
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const html = tHTML(el.dataset.i18nHtml);
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) { const v = t(key); if (el.getAttribute(attr) !== v) el.setAttribute(attr, v); }
    }
  }
}

/* Relative days --------------------------------------------------------------------------------- */

/**
 * "Today", "Tomorrow", "In 3 days", "Yesterday", "3 days ago" for a whole number of days from
 * today, starting with a capital where the language has them ({ capital: false } for the middle
 * of a sentence: "in 3 days"). These are words, so they're in the UI's language (not the
 * formatting locale: a zh-CN phone in zh-TW still reads 3 天後, English on a Japanese phone "In 3
 * days"); bracketed in the pseudo-locale. Used by the due-soon banner.
 */
export function relativeDays(n, locale, { capital = true } = {}) {
  const loc = locale ?? wordsLocale();
  const s = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }).format(Math.round(n), 'day');
  const out = capital ? s.charAt(0).toLocaleUpperCase(loc) + s.slice(1) : s;
  return state.locale === PSEUDO && locale === undefined ? pseudo(out) : out;
}
const wordsLocale = () => (state.locale === PSEUDO ? FALLBACK : state.locale);

/**
 * A date written by Intl with words in it (month and weekday names, for the calendar): in the UI's
 * language, like relativeDays(), so a zh-CN phone in zh-TW reads 週一, not 周一. When the device
 * speaks that language in the same script, its own variant is kept, so the order is the device's
 * ("5 December 2026" on an en-GB phone, "December 5, 2026" on an en-US one). Bracketed in the
 * pseudo-locale, so its longer names show where they would be cut.
 */
export function dateWords(date, options, device = deviceFormatLocale()) {
  const ui = wordsLocale();
  const loc = device && sameLanguage(device, ui) ? device : ui;
  const s = new Intl.DateTimeFormat(loc, options).format(date);
  return state.locale === PSEUDO ? pseudo(s) : s;
}
/** How the calendar's column heads name the weekdays in the UI's language: LOCALES `weekdays`. */
export const weekdayStyle = () => (Object.hasOwn(LOCALES, state.locale) && LOCALES[state.locale].weekdays) || 'short';

/* Pseudo-locale --------------------------------------------------------------------------------- */

const ACCENTED = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ',
  n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ',
  N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};
const KEEP = /(\{\w+\}|<[^>]*>|&#?\w+;)/;

/**
 * One English string in the pseudo-locale: letters accented, about 30% longer, in [ ]. {params},
 * tags and entities stay as they are, so filled-in values and markup still work.
 */
export function pseudo(s) {
  const parts = String(s).split(KEEP);
  let letters = 0;
  const body = parts.map((p, i) => {
    if (i % 2) return p;
    letters += (p.match(/\p{L}/gu) || []).length;
    return p.replace(/[A-Za-z]/g, (c) => ACCENTED[c] ?? c);
  }).join('');
  if (!letters) return s; // nothing to translate ("·", "/", a lone placeholder)
  // The padding comes in words of up to five, so it wraps like real text (one long run of tildes
  // would be an unbreakable word no translation has, and would only test that).
  const pad = '~'.repeat(Math.max(1, Math.round(letters * 0.3))).match(/~{1,5}/g).join(' ');
  return `[${body} ${pad}]`;
}
export const pseudoDict = (dict) => Object.fromEntries(Object.entries(dict).map(([k, v]) => [k, pseudo(v)]));
