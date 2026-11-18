// Known services and the default groups. Pure (no DOM), shared by the app and the Node tests.

import en from './locales/en.js';

/*
 * Default groups (docs/plan-intervals-groups.md, section 3 L and 5.2): eleven suggestions, shown in
 * the language in use, in the item sheet's group list and as Import with AI's category examples.
 * They are never forced: no group is created, renamed or deleted for anyone. Choosing one simply
 * writes its name as text, in the language of the moment, and from then on it is the person's own
 * group like any other (the group-name hash, colorField, sees only that text). Names are in
 * js/locales/ (`key`; `names` repeats the English and Chinese ones for matching, and a test keeps
 * them equal); `aliases` are the group names, in lower case, that the merge helper
 * (js/group-merge.js) suggests moving into the preset. Nothing matches names across languages.
 */
export const DEFAULT_GROUPS = Object.freeze([
  { id: 'housing', key: 'group.preset.housing', names: ['Housing', '居住'], aliases: ['housing', 'house', 'home', 'mortgage', 'rent', '居住'] },
  { id: 'utilities', key: 'group.preset.utilities', names: ['Utilities', '生活帳單'], aliases: ['utilities', 'bills', 'internet', 'broadband', 'phone', 'mobile', 'electricity', 'water', 'gas', '生活帳單', '水電瓦斯'] },
  { id: 'food', key: 'group.preset.food', names: ['Food', '餐飲'], aliases: ['food', 'groceries', 'coffee', 'dining', 'restaurants', '餐飲'] },
  { id: 'transport', key: 'group.preset.transport', names: ['Transport', '交通'], aliases: ['transport', 'fuel', 'petrol', 'car', 'parking', 'travel', '交通'] },
  { id: 'software', key: 'group.preset.software', names: ['Software & cloud', '軟體與雲端'], aliases: ['software & cloud', 'software', 'cloud storage', 'cloud', 'ai', 'productivity', 'apps', '軟體與雲端'] },
  { id: 'entertainment', key: 'group.preset.entertainment', names: ['Entertainment', '娛樂'], aliases: ['entertainment', 'streaming', 'gaming', 'games', 'news', 'tv', 'video', '娛樂'] },
  { id: 'hobbies', key: 'group.preset.hobbies', names: ['Hobbies', '嗜好'], aliases: ['hobbies', 'hobby', 'music', 'crafts', '嗜好'] },
  { id: 'education', key: 'group.preset.education', names: ['Education', '教育'], aliases: ['education', 'courses', 'school', 'learning', 'books', '教育'] },
  { id: 'shopping', key: 'group.preset.shopping', names: ['Shopping', '購物'], aliases: ['shopping', 'retail', '購物'] },
  { id: 'health', key: 'group.preset.health', names: ['Health & fitness', '健康與運動'], aliases: ['health & fitness', 'health', 'fitness', 'gym', 'medical', '健康與運動'] },
  { id: 'insurance', key: 'group.preset.insurance', names: ['Insurance & finance', '保險與金融'], aliases: ['insurance & finance', 'insurance', 'finance', 'bank', 'fees', 'loans', '保險與金融'] },
]);

const BY_ID = new Map(DEFAULT_GROUPS.map((g) => [g.id, g]));

/** A default group's English name (Import with AI's prompt is always English). */
export const englishGroupName = (id) => en[BY_ID.get(id).key];

/** The default groups' English names, in table order: Import with AI's category examples. */
export const DEFAULT_CATEGORIES = DEFAULT_GROUPS.map((g) => en[g.key]);

/**
 * The category list before the default groups (1.19.0). Still recognised when an AI reply's line
 * breaks split one (js/import-ai.js), since a chat may keep suggesting them.
 */
export const LEGACY_CATEGORIES = Object.freeze([
  'Entertainment', 'Music', 'Gaming', 'AI', 'Cloud storage',
  'Productivity', 'Software', 'News', 'Fitness', 'Utilities', 'Other',
]);

// Known services: display name, logo domain, the default group its category comes from (`group`,
// see DEFAULT_GROUPS) and extra aliases.
export const SERVICES = [
  { name: 'Netflix', domain: 'netflix.com', group: 'entertainment', aliases: [] },
  { name: 'Spotify', domain: 'spotify.com', group: 'hobbies', aliases: ['spotify premium'] },
  { name: 'YouTube Premium', domain: 'youtube.com', group: 'entertainment', aliases: ['youtube', 'yt premium', 'youtube music'] },
  { name: 'Disney+', domain: 'disneyplus.com', group: 'entertainment', aliases: ['disney plus', 'disney'] },
  { name: 'iCloud', domain: 'icloud.com', group: 'software', aliases: ['icloud+', 'apple icloud', 'icloud plus'] },
  { name: 'Google One', domain: 'one.google.com', group: 'software', aliases: ['googleone', 'google drive'] },
  { name: 'ChatGPT', domain: 'chatgpt.com', group: 'software', aliases: ['chat gpt', 'chatgpt plus', 'openai'] },
  { name: 'Claude', domain: 'claude.ai', group: 'software', aliases: ['claude pro', 'claude max', 'anthropic'] },
  { name: 'Adobe', domain: 'adobe.com', group: 'software', aliases: ['adobe creative cloud', 'creative cloud', 'photoshop', 'lightroom'] },
  { name: 'Microsoft 365', domain: 'microsoft.com', group: 'software', aliases: ['office 365', 'm365', 'microsoft office'] },
  { name: 'Nintendo', domain: 'nintendo.com', group: 'entertainment', aliases: ['nintendo switch online', 'switch online'] },
  { name: 'PlayStation', domain: 'playstation.com', group: 'entertainment', aliases: ['playstation plus', 'ps plus', 'ps+', 'psn'] },
  { name: 'Xbox', domain: 'xbox.com', group: 'entertainment', aliases: ['xbox game pass', 'game pass', 'gamepass'] },
  { name: 'Notion', domain: 'notion.so', group: 'software', aliases: ['notion plus'] },
  { name: 'Canva', domain: 'canva.com', group: 'software', aliases: ['canva pro'] },
].map((svc) => Object.freeze({ ...svc, category: englishGroupName(svc.group) }));

const norm = (s) => s.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');

// Build a lookup of normalised keys, longest first, so "youtube premium" beats "youtube".
const KEYS = SERVICES.flatMap((svc) =>
  [svc.name, ...svc.aliases].map((k) => ({ key: norm(k), svc }))
).sort((a, b) => b.key.length - a.key.length);

/** Return the known service matching a typed name, or null. */
export function matchService(name) {
  const n = norm(name || '');
  if (n.length < 3) return null;
  const hit = KEYS.find(({ key }) => n === key || n.startsWith(key));
  return hit ? hit.svc : null;
}

/** Normalise user input like "https://www.example.com/path/" to "www.example.com". */
export function cleanDomain(input) {
  let d = (input || '').trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  return d;
}
