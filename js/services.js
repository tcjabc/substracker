// Known services: display name, logo domain, default category and extra aliases.

export const SERVICES = [
  { name: 'Netflix', domain: 'netflix.com', category: 'Entertainment', aliases: [] },
  { name: 'Spotify', domain: 'spotify.com', category: 'Music', aliases: ['spotify premium'] },
  { name: 'YouTube Premium', domain: 'youtube.com', category: 'Entertainment', aliases: ['youtube', 'yt premium', 'youtube music'] },
  { name: 'Disney+', domain: 'disneyplus.com', category: 'Entertainment', aliases: ['disney plus', 'disney'] },
  { name: 'iCloud', domain: 'icloud.com', category: 'Cloud storage', aliases: ['icloud+', 'apple icloud', 'icloud plus'] },
  { name: 'Google One', domain: 'one.google.com', category: 'Cloud storage', aliases: ['googleone', 'google drive'] },
  { name: 'ChatGPT', domain: 'chatgpt.com', category: 'AI', aliases: ['chat gpt', 'chatgpt plus', 'openai'] },
  { name: 'Claude', domain: 'claude.ai', category: 'AI', aliases: ['claude pro', 'claude max', 'anthropic'] },
  { name: 'Adobe', domain: 'adobe.com', category: 'Software', aliases: ['adobe creative cloud', 'creative cloud', 'photoshop', 'lightroom'] },
  { name: 'Microsoft 365', domain: 'microsoft.com', category: 'Productivity', aliases: ['office 365', 'm365', 'microsoft office'] },
  { name: 'Nintendo', domain: 'nintendo.com', category: 'Gaming', aliases: ['nintendo switch online', 'switch online'] },
  { name: 'PlayStation', domain: 'playstation.com', category: 'Gaming', aliases: ['playstation plus', 'ps plus', 'ps+', 'psn'] },
  { name: 'Xbox', domain: 'xbox.com', category: 'Gaming', aliases: ['xbox game pass', 'game pass', 'gamepass'] },
  { name: 'Notion', domain: 'notion.so', category: 'Productivity', aliases: ['notion plus'] },
  { name: 'Canva', domain: 'canva.com', category: 'Productivity', aliases: ['canva pro'] },
];

export const DEFAULT_CATEGORIES = [
  'Entertainment', 'Music', 'Gaming', 'AI', 'Cloud storage',
  'Productivity', 'Software', 'News', 'Fitness', 'Utilities', 'Other',
];

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

/** Normalise user input like "https://www.netflix.com/tw/" to "www.netflix.com". */
export function cleanDomain(input) {
  let d = (input || '').trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  return d;
}
