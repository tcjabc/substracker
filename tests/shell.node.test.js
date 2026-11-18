// Node test: every shipped script is in the service worker's offline shell, so a module the app
// imports can't be missing when the PWA opens offline. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

// Scripts deliberately left out of the shell and cached on first use instead (sw.js RUNTIME), each
// with its reason. Keep this list short: anything here is unavailable offline until first used.
const RUNTIME_CACHED = {
  // three.js, about 690 KB: only the Insights Ring (js/donut-3d.js) imports it, on demand. Offline
  // before that first use, the import fails and the flat donut shows instead.
  'three.module.min.js': 'large, used only by the 3D Ring',
};

async function swLists() {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const list = (name) => {
    const m = sw.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `${name} list found in sw.js`);
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  };
  return { shell: list('SHELL'), runtime: list('RUNTIME') };
}

test('every file in js/ is precached by sw.js (or deliberately runtime-cached)', async () => {
  const { shell, runtime } = await swLists();
  const scripts = (await readdir(new URL('js/', root))).filter((f) => f.endsWith('.js'));
  for (const f of scripts) {
    if (f in RUNTIME_CACHED) continue;
    assert.ok(shell.has(`./js/${f}`), `sw.js SHELL is missing ./js/${f}`);
  }
  // Locale files load on first use (js/i18n.js) but are precached, so every language works offline.
  const locales = (await readdir(new URL('js/locales/', root))).filter((f) => f.endsWith('.js'));
  assert.ok(locales.includes('en.js'), 'js/locales/en.js exists');
  for (const f of locales) assert.ok(shell.has(`./js/locales/${f}`), `sw.js SHELL is missing ./js/locales/${f}`);
  for (const p of shell) {
    const m = p.match(/^\.\/js\/locales\/(.+)$/);
    if (m) assert.ok(locales.includes(m[1]), `sw.js SHELL lists ${p}, which doesn't exist`);
  }
  // The exceptions must exist, really be runtime-cached by sw.js, and not also be precached.
  for (const f of Object.keys(RUNTIME_CACHED)) {
    assert.ok(scripts.includes(f), `js/${f} is listed as runtime-cached but doesn't exist`);
    assert.ok(runtime.has(`./js/${f}`), `sw.js RUNTIME is missing ./js/${f}`);
    assert.ok(!shell.has(`./js/${f}`), `./js/${f} should not be in the precached SHELL`);
  }
  assert.equal(runtime.size, Object.keys(RUNTIME_CACHED).length, 'sw.js RUNTIME lists only the files explained here');
});

test('vendored libraries ship with their licence files', async () => {
  const files = await readdir(new URL('js/', root));
  for (const [lib, licence] of [['jsqr.js', 'jsqr.LICENSE.txt'], ['three.module.min.js', 'three.LICENSE.txt']]) {
    assert.ok(files.includes(lib), `js/${lib} exists`);
    assert.ok(files.includes(licence), `js/${licence} ships beside js/${lib}`);
  }
  const three = await readFile(new URL('js/three.module.min.js', root), 'utf8');
  assert.match(three.slice(0, 200), /@license[\s\S]*Three\.js Authors[\s\S]*MIT/, 'three.js keeps its licence header');
  assert.match(three.slice(0, 400), /const \w+="170"/, 'three.js is r170, the release the Ring was tuned on');
});
