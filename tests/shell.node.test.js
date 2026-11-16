// Node test: every shipped script is in the service worker's offline shell, so a module the app
// imports can't be missing when the PWA opens offline. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('every file in js/ is precached by sw.js', async () => {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const list = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(list, 'SHELL list found');
  const shell = new Set([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const scripts = (await readdir(new URL('js/', root))).filter((f) => f.endsWith('.js'));
  for (const f of scripts) assert.ok(shell.has(`./js/${f}`), `sw.js SHELL is missing ./js/${f}`);
});
