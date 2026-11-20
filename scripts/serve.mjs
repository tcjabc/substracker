// A local static server for trying the app and running the in-browser tests (tests/*.html): the
// repository root on 127.0.0.1, on the port from scripts/port.mjs (PEEK_PORT, else 8090), and it
// tells the browser never to cache, so a test always runs the files as they are now. It stops with a
// message if the port is taken rather than picking another. `npm run serve`, or
// `node scripts/serve.mjs [root]` to serve another folder. Uses Node built-ins only.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEEK_PORT } from './port.mjs';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store, must-revalidate' });
    res.end(body);
  };
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) return send(403, 'Forbidden');
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) return send(404, 'Not found');
    send(200, req.method === 'HEAD' ? '' : body, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
  } catch {
    send(400, 'Bad request');
  }
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PEEK_PORT} is taken. Free it, or set PEEK_PORT to another port.` : err.message);
  process.exit(1);
});
server.listen(PEEK_PORT, '127.0.0.1', () => console.log(`Serving ${root} at http://127.0.0.1:${PEEK_PORT}`));
