// The one setting for the local test server's port: PEEK_PORT from the environment, else 8090.
// scripts/serve.mjs serves on it; test runners and sweep scripts read it from here (run this file
// with Node and it prints the port). Never 8080 or 8765: other local projects use those.
// Uses Node built-ins only.

import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 8090;

const fromEnv = Number(process.env.PEEK_PORT);
export const PEEK_PORT = Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536 ? fromEnv : DEFAULT_PORT;

/** The base URL the test pages are served from. */
export const PEEK_BASE = `http://127.0.0.1:${PEEK_PORT}`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(PEEK_PORT);
