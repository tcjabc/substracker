# Peek Budget relay

A small Cloudflare Worker that passes encrypted changes between the devices of one household. Each household is a **room**: one Durable Object holding an append-only log of sealed envelopes in SQLite. The relay can't read any of them; devices encrypt and decrypt with a key the relay never sees.

```
src/index.js       Worker: routes /v1/rooms/:roomId/… to the room, CORS
src/room.js        Durable Object "Room": SQLite storage, hibernating WebSockets
src/room-logic.js  The rules (auth, validation, limits, rate limit) with no Cloudflare APIs, tested in Node
test/              Node tests for room-logic.js
wrangler.toml      Worker config: Durable Object binding + SQLite migration, allowed origins, logging
```

## API

All endpoints are under `/v1/rooms/:roomId`, where `roomId` is 32 hex characters. Requests carry `Authorization: Bearer <token>`. The room id and token are both derived from the household key (see `js/crypto.js` in the app), so they look random and are different for every household.

| Request | Response |
| --- | --- |
| `POST /push` with `{ "envelopes": [{ "id", "wall", "c" }, …] }` | `{ "head", "accepted", "rejected": [ids] }` |
| `GET /pull?after=N&limit=500` | `{ "entries": [{ "seq", "id", "wall", "c" }, …], "head" }` |
| `GET /live` (WebSocket) | messages `{ "type": "head", "seq" }` |

- **Push** is idempotent: an envelope id that's already stored is skipped, never an error. `accepted` counts the new ones. An envelope whose `wall` is more than 24 hours ahead of the relay's clock is refused (listed in `rejected`) while the rest of the push is stored.
- **Pull** returns entries in `seq` order, at most 500 at a time. Page with `after` = the last `seq` you got until you reach `head`.
- **Live** never carries data. On connect, and after every push that stored something, it sends the current `head` to the other connected devices, which then pull. A WebSocket can't carry an `Authorization` header from a browser, so the client offers the subprotocols `peek-sync.v1` and `bearer.<token>`; the relay answers with `peek-sync.v1`. Send `ping` to keep it open (answered with `pong` without waking the object). The optional `?client=<random id>` only stops a device being told about its own push.
- **Rooms** come into existence on the first push, which stores a SHA-256 of that device's token (trust on first use). After that, any other token gets `401`. Pull or live on a room that doesn't exist gets `404`; nothing is created.

Errors are JSON `{ "error": code, "message": text }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `bad_json`, `bad_request`, `bad_envelope`, `bad_room` | Malformed request |
| 401 | `unauthorized` | Missing token, or not this room's token |
| 403 | `origin_not_allowed` | A browser origin not in `ALLOWED_ORIGINS` |
| 404 | `no_room` | Pull/live on a room nobody has pushed to |
| 413 | `too_large`, `too_many` | Body over 1 MB, or over 500 envelopes |
| 429 | `rate_limited` | Over 120 requests in a burst / 2 per second for the room (`Retry-After` says when) |
| 507 | `room_full` | The room has 200,000 entries; nothing more is stored |

Limits are in `LIMITS` in `src/room-logic.js`.

## What the relay can and cannot see

It **cannot** see item names, amounts, categories, notes or anything else you enter, the household key, or the encryption key. It can't make changes that devices would accept: envelopes are AES-GCM sealed and devices drop any that fail to open.

It **can** see, and Cloudflare could see:

- The room id (random-looking, one per household) and the token (stored only as a SHA-256 hash).
- How many changes are sent, when, and roughly how large they are (contents are padded to 64-byte steps).
- Each change's `wall` time: when it was made, to the millisecond. It needs this to refuse far-future stamps.
- IP addresses and connection times, at Cloudflare's network level. The relay code doesn't record or log them.

It stores nothing about clients: no IPs, user agents or device names. It keeps only `seq`, envelope `id`, `wall`, `c` and the time each entry arrived. It could also refuse to relay, replay or drop changes. Devices treat every change as idempotent and order-independent, so a replay does nothing; dropped changes simply don't arrive.

Logging: `wrangler.toml` turns off per-request invocation logs, which record URLs and request metadata. The code never logs bodies, tokens or envelopes; it only logs the name of an unexpected error.

## Run locally

No Cloudflare account is needed for local development.

```sh
cd relay
npm install
npx wrangler dev            # serves http://localhost:8787 with a local Durable Object
```

In the app, open the dev screen (add `?dev=1` to the URL, or tap the version line in Settings 7 times), set the relay URL to `http://localhost:8787`, and paste or generate a household key. Local data is kept under `relay/.wrangler/` (ignored by git).

Tests (Node 20 or later, no install needed):

```sh
npm test                    # here: the relay logic. From the repository root, npm test runs these too.
```

## Deploy

```sh
cd relay
npm install
npx wrangler login          # opens the browser to sign in to Cloudflare
npx wrangler deploy         # creates the Worker and the Room Durable Object class (migration v1)
```

`wrangler deploy` prints the URL, for example `https://peek-budget-relay.<your-subdomain>.workers.dev`. Put that in the app's dev screen. SQLite-backed Durable Objects are available on the Workers Free plan.

If the app is served from somewhere other than `https://tcjabc.github.io`, change `ALLOWED_ORIGINS` in `wrangler.toml` and deploy again. Native apps (Android `https://localhost`, iOS `capacitor://localhost`) are already listed.
