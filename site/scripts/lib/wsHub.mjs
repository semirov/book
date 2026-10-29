/**
 * scripts/lib/wsHub.mjs — the harness's `/ws`: a real WebSocket hub the script can refuse.
 *
 * The reconnect harness needs a socket that **fails the way a dead server fails**, six times in a
 * row, and then comes back with an authoritative snapshot. A stub client would prove nothing
 * about `BookSocket`, so the harness drives the real class against a real endpoint and the
 * endpoint is what goes away: while `refuse` is set, every upgrade is answered by closing the
 * TCP connection (the page sees a `1006`, exactly as it would with the process gone).
 *
 * CDP's `Network.setBlockedURLs` was measured first and does not intercept the WebSocket
 * handshake in the harness's Chromium (the path pattern, the absolute `ws://…` URL and `*` all
 * let it connect), so the refusal lives here, on the server side — the honest shape anyway.
 *
 * The page owns the payloads: it POSTs its `before`/`after` `hello` envelopes to `/fixtures` and
 * the hub only relays whichever one it currently holds, so the wire shapes stay the page's own
 * (typed, and shared with the DOM tests) and this file stays transport.
 *
 *   const hub = await startHub();
 *   hub.refuse = true;           // every upgrade is refused from now on
 *   hub.dropAll();               // and the live connection goes away
 *   hub.advance();               // the next accepted hello carries `after`
 *   hub.refuse = false;          // the endpoint answers again
 *   await hub.close();
 */

import { createServer } from 'node:http';

import { WebSocketServer } from 'ws';

/** Read one request body, bounded: the harness posts two snapshots and nothing else. */
async function bodyOf(request, limit = 2_000_000) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk.toString('utf8');
    if (raw.length > limit) throw new Error('hub: the fixture body is too large');
  }
  return raw;
}

export async function startHub() {
  const state = {
    /** The two `hello` payloads the page posted: the state before the outage, and after it. */
    fixtures: null,
    /** While set, every `/ws` upgrade is destroyed: the endpoint is down. */
    refuse: false,
    /** Which fixture the next accepted hello carries. */
    after: false,
    /** Upgrades refused and connections accepted, as the harness's own numbers. */
    refused: 0,
    accepted: 0,
  };

  const server = createServer(async (request, response) => {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers).end();
      return;
    }
    if (request.method === 'POST' && request.url === '/fixtures') {
      try {
        state.fixtures = JSON.parse(await bodyOf(request));
        response.writeHead(204, headers).end();
      } catch (error) {
        response.writeHead(400, headers).end(String(error?.message ?? error));
      }
      return;
    }
    if (request.method === 'GET' && request.url === '/counts') {
      response.writeHead(200, { ...headers, 'content-type': 'application/json' });
      response.end(JSON.stringify({ refused: state.refused, accepted: state.accepted }));
      return;
    }
    response.writeHead(404, headers).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on('upgrade', (request, socket, head) => {
    let path = null;
    try {
      path = new URL(request.url ?? '/', 'http://hub.invalid').pathname;
    } catch {
      path = null;
    }
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    if (state.refuse || state.fixtures === null) {
      state.refused += 1;
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    state.accepted += 1;
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    const hello = state.after ? state.fixtures.after : state.fixtures.before;
    ws.send(JSON.stringify({ v: 1, type: 'hello', seq: 1, ts: new Date().toISOString(), data: hello }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('hub: the server did not bind a port');
  const origin = `http://127.0.0.1:${String(address.port)}`;

  return {
    origin,
    wsUrl: `ws://127.0.0.1:${String(address.port)}/ws`,
    state,
    /** The next hello carries the post-outage snapshot. */
    advance() {
      state.after = true;
    },
    /** Drop every live connection the way a dead process does (no close frame: `1006`). */
    dropAll() {
      for (const ws of clients) ws.terminate();
      clients.clear();
    },
    /** Wait until the page has posted its two payloads. */
    async ready(timeoutMs = 5_000) {
      const started = Date.now();
      while (state.fixtures === null) {
        if (Date.now() - started > timeoutMs) throw new Error('hub: the page posted no fixtures');
        await new Promise((done) => setTimeout(done, 20));
      }
      return state.fixtures;
    },
    async close() {
      for (const ws of clients) ws.terminate();
      clients.clear();
      await new Promise((done) => wss.close(() => done()));
      await new Promise((done) => server.close(() => done()));
    },
  };
}
