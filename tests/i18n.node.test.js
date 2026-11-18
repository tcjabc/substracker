// Node tests for js/i18n.js and the dictionaries in js/locales/: lookups, {placeholders}, plural
// forms, the English fallback (never a raw key), choosing a locale and a formatting locale, the
// pseudo-locale, the relative-day helper, and that the keys in the source and in every locale
// file agree. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import * as i18n from '../js/i18n.js';
import en from '../js/locales/en.js';
import { money, moneyParts } from '../js/util.js';
import { rollPlan } from '../js/count-anim.js';

const root = new URL('../', import.meta.url);
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

/* Lookups ---------------------------------------------------------------------------------------- */

test('t() fills {placeholders} and leaves unknown ones as they are', () => {
  assert.equal(i18n.interpolate('Saved {name}', { name: 'a.csv' }), 'Saved a.csv');
  assert.equal(i18n.interpolate('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(i18n.interpolate('{n}{n}', { n: 0 }), '00');
  assert.equal(i18n.interpolate('no params', undefined), 'no params');
  assert.equal(i18n.t('date.renews.on', { date: '3 Nov' }), 'Renews 3 Nov');
});

test('t() picks the plural form with Intl.PluralRules', () => {
  assert.equal(i18n.t('date.renews.inDays', { count: 1 }), 'Renews in 1 day');
  assert.equal(i18n.t('date.renews.inDays', { count: 3 }), 'Renews in 3 days');
  assert.equal(i18n.t('date.renews.inDays', { count: 0 }), 'Renews in 0 days');
});

test('tHTML() keeps the template\'s tags and escapes every param', () => {
  const out = i18n.interpolate('<strong>{x}</strong>', { x: '&lt;b&gt;' });
  assert.equal(out, '<strong>&lt;b&gt;</strong>');
  // A real Html key, with a value that would otherwise be markup.
  const key = Object.keys(en).find((k) => /Html(\.\w+)?$/.test(k));
  if (key) {
    const names = [...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const html = i18n.tHTML(key.replace(/\.(one|other)$/, ''), Object.fromEntries(names.map((n) => [n, n === 'count' ? 2 : '<i>"x"</i>'])));
    assert.ok(!html.includes('<i>'), 'params are escaped');
  }
});

test('a key missing in English warns once and shows nothing, never the key', () => {
  const warn = console.warn;
  const seen = [];
  console.warn = (m) => seen.push(m);
  try {
    assert.equal(i18n.t('no.such.key'), '');
    assert.equal(i18n.t('no.such.key'), '');
    assert.equal(i18n.t('no.such.key', { count: 2 }), '');
  } finally { console.warn = warn; }
  assert.equal(seen.length, 1, 'warned once');
  assert.match(seen[0], /no\.such\.key/);
});

test('a key missing in another locale falls back to English, with a warning', async () => {
  const warn = console.warn;
  const seen = [];
  console.warn = (m) => seen.push(m);
  try {
    // A made-up locale with one key and only the "other" plural form, like zh-TW.
    i18n.setDictionaryForTests('zz-test', { 'date.renews.today': 'Z today', 'date.renews.inDays.other': 'Z {count}' });
    assert.equal(await i18n.setLocale('zz-test'), 'zz-test');
    assert.equal(i18n.t('date.renews.today'), 'Z today');
    assert.equal(i18n.t('date.renews.inDays', { count: 1 }), 'Z 1', "its own forms, not English's");
    assert.equal(i18n.t('date.renews.tomorrow'), 'Renews tomorrow', 'English for the missing key');
    assert.equal(i18n.t('date.renews.tomorrow'), 'Renews tomorrow');
    await i18n.setLocale(i18n.PSEUDO);
    assert.match(i18n.t('date.renews.today'), /^\[Ŕéñéŵš ţóďáý ~+\]$/, 'pseudo text');
  } finally {
    console.warn = warn;
    await i18n.setLocale('en');
  }
  assert.equal(seen.filter((m) => m.includes('date.renews.tomorrow')).length, 1, 'warned once');
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.t('date.renews.today'), 'Renews today');
});

/* Choosing the locale ---------------------------------------------------------------------------- */

test('auto follows the device\'s languages, else English; a saved locale wins', () => {
  const avail = ['en', 'zh-TW'];
  assert.deepEqual(i18n.resolveLocale('auto', ['zh-TW', 'en'], avail), { locale: 'zh-TW', matched: true });
  assert.deepEqual(i18n.resolveLocale('auto', ['zh-HK'], avail), { locale: 'zh-TW', matched: true }, 'same language and script');
  assert.deepEqual(i18n.resolveLocale('auto', ['zh-CN'], avail), { locale: 'en', matched: false }, 'Simplified is another script');
  assert.deepEqual(i18n.resolveLocale('auto', ['ja', 'en-GB'], avail), { locale: 'en', matched: true });
  assert.deepEqual(i18n.resolveLocale('auto', ['fr'], avail), { locale: 'en', matched: false });
  assert.deepEqual(i18n.resolveLocale('auto', [], avail), { locale: 'en', matched: false });
  assert.deepEqual(i18n.resolveLocale('en', ['zh-TW'], avail), { locale: 'en', matched: true });
  assert.deepEqual(i18n.resolveLocale('xx', ['en'], avail), { locale: 'en', matched: true }, 'the pseudo-locale is never a setting');
  // Today only English exists.
  assert.deepEqual(i18n.resolveLocale('auto', ['zh-TW']), { locale: 'en', matched: false });
  assert.deepEqual(Object.keys(i18n.LOCALES), ['en']);
});

test('numbers and dates keep the device\'s conventions unless another language was picked', () => {
  assert.equal(i18n.formatLocaleFor('en', { deviceLocale: 'en-GB' }), undefined, 'en-GB keeps "18 Nov"');
  assert.equal(i18n.formatLocaleFor('en', { deviceLocale: 'en-US' }), undefined, 'en-US keeps "Nov 18"');
  assert.equal(i18n.formatLocaleFor('en', { matched: false, deviceLocale: 'ja-JP' }), undefined, 'English only as a fallback: as before');
  assert.equal(i18n.formatLocaleFor('zh-TW', { deviceLocale: 'zh-Hant-TW' }), undefined);
  assert.equal(i18n.formatLocaleFor('zh-TW', { deviceLocale: 'en-GB' }), 'zh-TW', 'picked by hand');
  assert.equal(i18n.formatLocaleFor('en', { deviceLocale: 'zh-TW' }), 'en', 'English picked on a Chinese device');
  assert.equal(i18n.formatLocaleFor(i18n.PSEUDO, { deviceLocale: 'en-GB' }), undefined);
});

test('the setting is saved per device under substracker.lang; auto removes it', () => {
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  });
  try {
    assert.equal(i18n.saveLangSetting('en'), 'en');
    assert.equal(store.get('substracker.lang'), 'en');
    assert.equal(i18n.getLangSetting(), 'en');
    assert.equal(i18n.saveLangSetting('xx'), 'auto', 'the pseudo-locale is never saved');
    assert.equal(store.has('substracker.lang'), false);
    assert.equal(i18n.saveLangSetting('auto'), 'auto');
    assert.equal(store.size, 0);
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
});

test('initLanguage: ?lang=xx is the pseudo-locale; otherwise English', async () => {
  assert.equal(await i18n.initLanguage({ search: '?lang=xx', languages: ['en-GB'] }), i18n.PSEUDO);
  assert.equal(i18n.formatLocale(), undefined);
  assert.equal(await i18n.initLanguage({ search: '', languages: ['zh-TW'] }), 'en');
  assert.equal(i18n.formatLocale(), undefined, 'English as a fallback keeps the device\'s formats');
  assert.equal(await i18n.initLanguage({ search: '?lang=de', languages: ['en-US'] }), 'en');
});

/* Formatting ------------------------------------------------------------------------------------- */

test('money() and moneyParts() take the formatting locale; English is unchanged', () => {
  assert.equal(money(30000, 'TWD'), new Intl.NumberFormat(undefined, {
    style: 'currency', currency: 'TWD', currencyDisplay: 'symbol', minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(30000), 'no locale: the device default, as in 1.15.0');
  assert.equal(money(1234.5, 'EUR', 'de-DE'), '1.234,5 €');
  assert.equal(moneyParts(1234.5, 'EUR', 'de-DE').map((p) => p.value).join(''), money(1234.5, 'EUR', 'de-DE'));
  assert.equal(money(30000, 'TWD', 'zh-TW'), '$30,000');
});

test('the rolling totals end exactly on the formatted text in any locale', () => {
  for (const [loc, cur] of [['de-DE', 'EUR'], ['zh-TW', 'TWD'], ['ar-EG', 'USD'], ['hi-IN', 'INR'], [undefined, 'TWD']]) {
    const glyphs = Array.from({ length: 10 }, (_, d) => moneyParts(d, cur, loc).filter((p) => p.type === 'integer').map((p) => p.value).join(''));
    for (const [a, b] of [[0, 30000], [1234.5, 99.99], [500, 512]]) {
      const plan = rollPlan(moneyParts(a, cur, loc), moneyParts(b, cur, loc), glyphs);
      const end = plan.map((s) => (s.t === 'lit' ? s.text : s.cells[s.to])).join('');
      assert.equal(end, money(b, cur, loc), `${loc} ${cur} ${a} → ${b}`);
    }
  }
});

test('relativeDays: Today, Tomorrow, In 3 days, with a capital', () => {
  assert.equal(i18n.relativeDays(0, 'en'), 'Today');
  assert.equal(i18n.relativeDays(1, 'en'), 'Tomorrow');
  assert.equal(i18n.relativeDays(3, 'en'), 'In 3 days');
  assert.equal(i18n.relativeDays(-1, 'en'), 'Yesterday');
  assert.equal(i18n.relativeDays(2.4, 'en'), 'In 2 days');
  assert.equal(i18n.relativeDays(1, 'zh-TW'), '明天');
});

/* Pseudo-locale ---------------------------------------------------------------------------------- */

test('the pseudo-locale brackets, accents and lengthens, keeping {params} and tags', () => {
  const p = i18n.pseudo('Saved {name}');
  assert.match(p, /^\[Šáṽéď \{name\} ~+\]$/);
  assert.equal(i18n.pseudo('<strong>{x}</strong> of {y}'), '[<strong>{x}</strong> óƒ {y} ~]');
  assert.equal(i18n.pseudo('·'), '·', 'nothing to translate');
  assert.equal(i18n.pseudo('{count}'), '{count}');
  const long = 'Outgoings are more than income this month';
  const tildes = (i18n.pseudo(long).match(/~/g) || []).length;
  assert.ok(tildes >= 0.25 * long.replace(/\W/g, '').length, 'about 30% longer');
  assert.ok(i18n.pseudo(long).match(/~+/g).every((run) => run.length <= 5), 'in short words, so it wraps like text');
  const d = i18n.pseudoDict(en);
  assert.deepEqual(Object.keys(d), Object.keys(en));
});

/* Keys: source, English and the other locales ----------------------------------------------------- */

const pluralBase = (k) => {
  const m = k.match(/^(.*)\.(zero|one|two|few|many|other)$/);
  return m && Object.hasOwn(en, `${m[1]}.other`) ? m[1] : null;
};
const placeholders = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const tags = (s) => [...String(s).matchAll(/<(\/?[a-z]+)[^>]*>/g)].map((m) => m[1]).join(' ');

async function sources() {
  const files = ['index.html'];
  for (const f of await readdir(new URL('js/', root))) if (f.endsWith('.js')) files.push(`js/${f}`);
  // Vendored code, the wordlist, and js/i18n.js itself (its comments show the attribute syntax).
  const skip = new Set(['js/jsqr.js', 'js/qrcode.js', 'js/three.module.min.js', 'js/wordlist.js', 'js/i18n.js']);
  return Promise.all(files.filter((f) => !skip.has(f)).map(async (f) => [f, await readFile(new URL(f, root), 'utf8')]));
}

/**
 * Every key the source uses: t('…') and tHTML('…') calls and the data-i18n attributes (`used`),
 * plus keys written as plain strings elsewhere, such as a map of keys passed to t() later
 * (`mentioned`). Every used key must exist; every English key must be used or mentioned.
 */
async function usedKeys() {
  const used = new Map();
  const mentioned = new Set();
  const add = (k, f) => { if (!used.has(k)) used.set(k, f); };
  const dynamic = [];
  for (const [f, src] of await sources()) {
    for (const m of src.matchAll(/(['"])([a-z][\w-]*(?:\.[\w-]+)+)\1/g)) mentioned.add(m[2]);
    for (const m of src.matchAll(/\b(?:t|tHTML)\(\s*(['"])([^'"]+)\1/g)) add(m[2], f);
    for (const m of src.matchAll(/\b(?:t|tHTML)\(\s*`/g)) dynamic.push(`${f}: ${src.slice(m.index, m.index + 40)}`);
    for (const m of src.matchAll(/data-i18n(?:-html|-native)?="([^"]+)"/g)) add(m[1], f);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) { const k = pair.split(':')[1]?.trim(); if (k) add(k, f); }
    }
  }
  return { used, mentioned, dynamic };
}

test('every key the source uses is in en.js, and keys are never built at run time', async () => {
  const { used, dynamic } = await usedKeys();
  assert.deepEqual(dynamic, [], 'write keys as plain strings, so they can be checked');
  const missing = [...used].filter(([k]) => !Object.hasOwn(en, k) && !Object.hasOwn(en, `${k}.other`)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, [], 'keys used but not in js/locales/en.js');
});

test('every key in en.js is used somewhere', async () => {
  const { used, mentioned } = await usedKeys();
  const seen = (k) => k && (used.has(k) || mentioned.has(k));
  const unused = Object.keys(en).filter((k) => !seen(k) && !seen(pluralBase(k)));
  assert.deepEqual(unused, [], 'keys in js/locales/en.js that nothing uses');
});

test('en.js: plural groups have one and other; values are text; Html keys only where there are tags', () => {
  const groups = new Map();
  for (const [k, v] of Object.entries(en)) {
    assert.equal(typeof v, 'string', `${k} is text`);
    assert.ok(v.length > 0, `${k} is not empty`);
    const b = pluralBase(k);
    if (b) groups.set(b, [...(groups.get(b) ?? []), k.slice(b.length + 1)]);
    if (/<\/?[a-z]+[\s>]/.test(v)) assert.match(k, /Html(\.\w+)?$/, `${k} holds markup, so its name ends in Html`);
    assert.doesNotMatch(v, /[​-‏⁠﻿]/, `${k} has no invisible characters`);
  }
  for (const [b, forms] of groups) assert.deepEqual(forms.sort(), ['one', 'other'], `${b} has the English plural forms`);
});

/**
 * Problems with a locale dictionary against English: the same keys (plural groups with exactly
 * the language's own forms), the same {placeholders} and, for Html keys, the same tags.
 */
export function localeProblems(tag, dict) {
  const out = [];
  const forms = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  const want = new Set();
  for (const k of Object.keys(en)) {
    const b = pluralBase(k);
    if (b) for (const f of forms) want.add(`${b}.${f}`); else want.add(k);
  }
  for (const k of want) if (!Object.hasOwn(dict, k)) out.push(`${tag}: missing ${k}`);
  for (const k of Object.keys(dict)) if (!want.has(k)) out.push(`${tag}: ${k} is not an English key (or not a ${tag} plural form)`);
  for (const k of Object.keys(dict)) {
    if (!want.has(k)) continue;
    if (typeof dict[k] !== 'string' || !dict[k]) { out.push(`${tag}: ${k} is empty`); continue; }
    const b = pluralBase(k);
    const ref = b ? en[`${b}.other`] : en[k];
    const a = placeholders(dict[k]), e = placeholders(ref);
    const ok = b && !k.endsWith('.other') ? a.every((x) => e.includes(x)) : JSON.stringify(a) === JSON.stringify(e);
    if (!ok) out.push(`${tag}: ${k} has {${a.join('}, {')}} but English has {${e.join('}, {')}}`);
    if (/Html(\.\w+)?$/.test(k) && tags(dict[k]) !== tags(ref)) out.push(`${tag}: ${k} has different tags`);
  }
  return out;
}

test('every other locale file has the same keys and {placeholders} as en.js', async () => {
  const files = (await readdir(new URL('js/locales/', root))).filter((f) => f.endsWith('.js') && f !== 'en.js');
  for (const f of files) {
    const tag = f.replace(/\.js$/, '');
    assert.ok(Object.hasOwn(i18n.LOCALES, tag), `js/locales/${f} is registered in LOCALES (js/i18n.js)`);
    const dict = (await import(new URL(`js/locales/${f}`, root))).default;
    assert.deepEqual(localeProblems(tag, dict), [], `js/locales/${f}`);
  }
  for (const tag of Object.keys(i18n.LOCALES)) assert.ok(tag === 'en' || files.includes(`${tag}.js`), `${tag} has its file`);
});

test('the locale check catches missing keys, extra keys, wrong forms and changed placeholders', () => {
  const zh = {};
  for (const k of Object.keys(en)) { const b = pluralBase(k); if (!b) zh[k] = en[k]; else if (k.endsWith('.other')) zh[`${b}.other`] = en[k]; }
  assert.deepEqual(localeProblems('zh-TW', zh), [], 'zh-TW needs only .other');
  const keys = Object.keys(zh);
  const bad = { ...zh, 'extra.key': 'x' };
  delete bad[keys[0]];
  const withParam = keys.find((k) => placeholders(zh[k]).length);
  bad[withParam] = zh[withParam].replace(/\{(\w+)\}/, '{oops}');
  const plural = [...new Set(Object.keys(en).map(pluralBase).filter(Boolean))][0];
  bad[`${plural}.one`] = 'x';
  const problems = localeProblems('zh-TW', bad).join('\n');
  assert.match(problems, new RegExp(`missing ${keys[0].replace(/\./g, '\\.')}`));
  assert.match(problems, /extra\.key is not an English key/);
  assert.match(problems, /\{oops\}/);
  assert.match(problems, /\.one is not an English key \(or not a zh-TW plural form\)/);
  const enCopy = Object.fromEntries(Object.entries(en));
  assert.deepEqual(localeProblems('en', enCopy), []);
  delete enCopy[`${plural}.one`];
  assert.match(localeProblems('en', enCopy).join('\n'), /missing .*\.one/);
});

test('PLURAL_FORMS covers what Intl.PluralRules can return', () => {
  for (const tag of ['en', 'zh-TW', 'ar', 'ru', 'pl', 'cy']) {
    for (const f of new Intl.PluralRules(tag).resolvedOptions().pluralCategories) assert.ok(PLURAL_FORMS.includes(f), `${tag} ${f}`);
  }
});
