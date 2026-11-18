// English: every word the app shows, by key (js/i18n.js t()). English is bundled and is the
// fallback for anything another locale lacks. Another locale is a copy of this file with the same
// keys and the same {placeholders} (tests/i18n.node.test.js checks both).
//
// Keys are namespaced by screen. Plural forms are `key.one` / `key.other` (and whatever forms the
// language has: zh-TW has only `.other`), chosen by t(key, { count }). Keys ending in "Html" hold a
// few tags (such as <strong>); keep the same tags in a translation.
//
// Not here, on purpose: user data (item, group and category names, the preset names in
// js/services.js), the 12 recovery words, the Import with AI prompt (js/import-ai-prompt.js) and
// the JSON it asks for, CSV column headers and values, backup and sync formats, currency codes.
//
// LEGAL: keys marked "legal check" are legal or privacy wording, copied as-is. Each translation of
// them needs a legal check for that language before it ships.

export default {
  // Dates and cycles (js/util.js)
  'cycle.perMonth': '/ mo',
  'cycle.perYear': '/ yr',
  'date.renews.today': 'Renews today',
  'date.renews.tomorrow': 'Renews tomorrow',
  'date.renews.inDays.one': 'Renews in {count} day',
  'date.renews.inDays.other': 'Renews in {count} days',
  'date.renews.on': 'Renews {date}',
  'date.payment.today': 'Payment today',
  'date.payment.tomorrow': 'Payment tomorrow',
  'date.payment.inDays.one': 'Payment in {count} day',
  'date.payment.inDays.other': 'Payment in {count} days',
  'date.payment.on': 'Payment {date}',
};
