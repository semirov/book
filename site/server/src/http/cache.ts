/**
 * BOOK-109 — nothing that carries prose may be kept by a client or a proxy; static files whose
 * bytes name them may.
 *
 * The owner's phone kept showing the *old* ch01/ch67 while this host served the canon: the
 * files, `/api/chapters/1|67`, the HTML and the bundle were all correct, so the copy the phone
 * printed had to come from a cache. A `304` is exactly the permission to keep that copy, and
 * `max-age` is the permission not to ask at all — neither is safe for a book that is written
 * in public, where the same URL answers with new prose minutes later.
 *
 * So the policy lives in one module, above every route:
 *
 *   · `onRequest` drops the conditional headers of every request that is not one of the static
 *     files whose ETag follows their own bytes — Vite's content-hashed `/assets/*`, the fonts,
 *     `theme.js` (the pre-paint script) and the favicon. Those carry no prose, so a `304` there
 *     is a real saving (172 KB of woff2 re-downloaded per page load is not); everywhere else a
 *     `304` would tell a client to reuse exactly the copy this pass exists to eliminate;
 *   · `onSend` marks every `/api/` answer, `/healthz` and every HTML document `no-store`, and
 *     does it *after* the route wrote its headers — a route cannot loosen the rule,
 *     `@fastify/static` keeps its own policy for the rest.
 *
 * ETags stay: they still name the representation (a test, a proxy log and a future client can
 * compare them), and outside prose they still answer `304`.
 */

import type { FastifyInstance } from 'fastify';

/**
 * The static surfaces allowed to revalidate: Vite's output (names change with the bytes), the
 * font files, the pre-paint theme script and the favicon. None of them holds a sentence of the
 * book, and their tags are computed from the file, so a `304` cannot keep stale prose alive.
 */
const REVALIDATABLE = ['/assets/', '/fonts/', '/theme.js', '/favicon.svg'] as const;

/**
 * BOOK-119: an asset name is the hash of its bytes (`index-Bx12_3de.js`), so the same URL can
 * only ever mean the same content — across releases too. A year plus `immutable` is the only
 * honest policy for it, and it is what makes a stale shell's fetch instant instead of a
 * revalidation. HTML and the API stay `no-store` below, and that rule wins.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The path without its query — a query string never decides the policy. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

function revalidatable(path: string): boolean {
  return REVALIDATABLE.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix));
}

export function registerCachePolicy(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (revalidatable(pathOf(request.url))) return undefined;
    // A conditional request for anything the book says must be answered with the body: a 304
    // would tell the client to reuse the copy this pass removes.
    delete request.headers['if-none-match'];
    delete request.headers['if-modified-since'];
    return undefined;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const path = pathOf(request.url);
    const contentType = String(reply.getHeader('content-type') ?? '');
    // BOOK-119: a hashed asset may be kept for a year. A miss on `/assets/` is a 404 JSON, not
    // an asset — never pin that, and never let a browser keep the answer past the next publish.
    if (path.startsWith('/assets/')) {
      reply.header('cache-control', reply.statusCode < 400 ? IMMUTABLE : 'no-store');
    }
    // `/healthz` explicitly: a probe that fails (a 500 from the error handler) must not be
    // stored either — "is this host up" is a fact about now, not a cached document.
    if (path.startsWith('/api/') || path === '/healthz' || contentType.startsWith('text/html')) {
      // Overrides whatever the route or the static layer set: the answer is a statement about
      // a book being written, and a stored copy of it is a stale copy by construction.
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
