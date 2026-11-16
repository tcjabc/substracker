// One Durable Object per room (addressed by the room id). SQLite storage holds the append-only
// entry log and the room's token hash; live WebSockets use the Hibernation API, so idle rooms cost
// nothing. The socket only ever says "there is something new"; data always goes through /pull.

import { DurableObject } from 'cloudflare:workers';
import { RoomCore, PROTOCOL, bearer, protocolToken, isClientId } from './room-logic.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    wall INTEGER NOT NULL,
    c TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );`;

/** RoomCore's storage adapter over the object's SQLite database. Tables appear on the first push only. */
class SqlStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
  }

  exists() {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").toArray().length > 0
      && this.tokenHash() !== null;
  }

  tokenHash() {
    return this.sql.exec('SELECT token_hash FROM room WHERE id = 1').toArray()[0]?.token_hash ?? null;
  }

  claim(hash, at) {
    return this.storage.transactionSync(() => {
      this.sql.exec(SCHEMA);
      this.sql.exec('INSERT OR IGNORE INTO room (id, token_hash, created_at) VALUES (1, ?, ?)', hash, at);
      return this.tokenHash();
    });
  }

  head() {
    if (!this.exists()) return 0;
    return this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS head FROM entries').one().head;
  }

  /** Store new envelopes, skipping ids already present; returns how many were new. */
  insert(list, at) {
    // Check first rather than INSERT OR IGNORE: with AUTOINCREMENT an ignored row still uses up
    // a seq, which would leave gaps and make head - before overcount.
    return this.storage.transactionSync(() => {
      let added = 0;
      for (const e of list) {
        if (this.sql.exec('SELECT 1 FROM entries WHERE id = ?', e.id).toArray().length) continue;
        this.sql.exec('INSERT INTO entries (id, wall, c, received_at) VALUES (?, ?, ?, ?)', e.id, e.wall, e.c, at);
        added++;
      }
      return added;
    });
  }

  after(seq, limit) {
    return this.sql.exec('SELECT seq, id, wall, c FROM entries WHERE seq > ? ORDER BY seq LIMIT ?', seq, limit).toArray();
  }
}

const json = ({ status, body, headers }) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new RoomCore(new SqlStore(ctx.storage));
    // Clients may send "ping" to keep a connection open; it's answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').pop();
    if (action === 'push') {
      const r = await this.core.push({ token: bearer(request.headers.get('Authorization')), bodyText: await request.text() });
      if (r.status === 200 && r.body.accepted > 0) this.notify(r.body.head, request.headers.get('X-Sync-Client'));
      return json(r);
    }
    if (action === 'pull') {
      return json(await this.core.pull({
        token: bearer(request.headers.get('Authorization')),
        after: url.searchParams.get('after'),
        limit: url.searchParams.get('limit'),
      }));
    }
    if (action === 'live') return this.live(request, url);
    return json({ status: 404, body: { error: 'not_found', message: 'Unknown endpoint.' } });
  }

  async live(request, url) {
    const denied = await this.core.live({ token: protocolToken(request.headers.get('Sec-WebSocket-Protocol')) });
    if (denied) return json(denied);
    const client = url.searchParams.get('client');
    const [clientSide, server] = Object.values(new WebSocketPair());
    // The tag is a random id the page picks per load, used only to skip telling a device about its own push.
    this.ctx.acceptWebSocket(server, isClientId(client) ? [client] : []);
    server.send(JSON.stringify({ type: 'head', seq: this.core.store.head() }));
    return new Response(null, { status: 101, webSocket: clientSide, headers: { 'Sec-WebSocket-Protocol': PROTOCOL } });
  }

  /** Tell every other connected device there is something new. */
  notify(seq, fromClient) {
    const msg = JSON.stringify({ type: 'head', seq });
    for (const ws of this.ctx.getWebSockets()) {
      if (isClientId(fromClient) && this.ctx.getTags(ws).includes(fromClient)) continue;
      try { ws.send(msg); } catch { /* closing; it will reconnect and pull */ }
    }
  }

  webSocketMessage() {
    // Clients never send data on the socket ("ping" is auto-answered); anything else is ignored.
  }

  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already closed, or a reserved code */ }
  }

  webSocketError() {}
}
