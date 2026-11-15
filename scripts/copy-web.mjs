// Copy the shipped web app into www/ for Capacitor (`webDir`). The PWA itself has no build step;
// this only gathers the files GitHub Pages serves, leaving out tests and dev files.
// Uses Node built-ins only.

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

// Keep in step with the SHELL list in sw.js.
const SHIPPED = ['index.html', 'manifest.json', 'sw.js', 'js', 'css', 'icons'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const entry of SHIPPED) {
  const from = join(root, entry);
  await stat(from); // fail loudly if a shipped file is missing
  await cp(from, join(out, entry), { recursive: true });
}
console.log(`Copied ${SHIPPED.join(', ')} to www/`);
