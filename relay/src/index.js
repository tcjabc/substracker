// Peek Budget relay Worker: routes /v1/rooms/:roomId/{push,pull,live} to the room's Durable Object
// and applies CORS. It stores nothing itself and never logs requests, tokens or bodies.

import { Room } from './room.js';
import { LIMITS, isRoomId, originAllowed } from './room-logic.js';

export { Room };

const ROUTE = /^\/v1\/rooms\/([^/]+)\/(push|pull|live)$/;
const METHOD = { push: 'POST', pull: 'GET', live: 'GET' };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Client',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowed = originAllowed(origin, env.ALLOWED_ORIGINS);
  // A browser page from another origin gets a plain refusal; native and command-line clients send no Origin.
  if (origin && !allowed) return json(403, { error: 'origin_not_allowed', message: 'This origin may not use the relay.' }, { Vary: 'Origin' });
  const cors = allowed ? corsHeaders(origin) : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const m = ROUTE.exec(url.pathname);
  if (!m) return json(404, { error: 'not_found', message: 'Unknown endpoint.' }, cors);
  const [, roomId, action] = m;
  if (!isRoomId(roomId)) return json(400, { error: 'bad_room', message: 'A room id is 32 hex characters.' }, cors);
  if (request.method !== METHOD[action]) return json(405, { error: 'method_not_allowed', message: `Use ${METHOD[action]}.` }, { ...cors, Allow: METHOD[action] });
  if (action === 'live' && request.headers.get('Upgrade') !== 'websocket') {
    return json(426, { error: 'upgrade_required', message: 'Open /live as a WebSocket.' }, cors);
  }
  if (action === 'push' && Number(request.headers.get('Content-Length') ?? 0) > LIMITS.maxBodyBytes) {
    return json(413, { error: 'too_large', message: `A push may be at most ${LIMITS.maxBodyBytes} bytes.` }, cors);
  }

  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const res = await stub.fetch(request);
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      // Name only: messages could in principle echo input.
      console.error(`relay: unexpected ${err?.name ?? 'error'}`);
      return json(500, { error: 'internal', message: 'The relay had a problem. Try again later.' });
    }
  },
};
