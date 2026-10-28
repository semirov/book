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
 *     `304` would tell a client to reuse exactly the copy this pass exists to eliminate.
 *
 *     BOOK-60 adds one exact path to that set: `/book.fb2`. Its ETag names the edition hash —
 *     computed from the stored file hashes of the front matter and all 67 chapters — and, since
 *     BOOK-133, the cover's sha256, so a `304` there can only ever name the same paragraphs and
 *     the same image the client already holds. The exemption is safe *because* the name is the
 *     content; a tag that named anything else would put the stale-prose defect straight back.
 *     The answer is `no-store` (BOOK-138), so no browser is told to keep these bytes and none
 *     revalidates them on its own: the exemption answers the client that sends `If-None-Match`
 *     of its own accord, and it buys that client a `304` instead of 1.5 MB. The fields the tag
 *     does not name — `program-used`, `src-url`, `title-info/date` — are boot-time constants
 *     (BOOK-DOC-41 §1), so they ride along on a `304` without making it stale.
 *   · `onSend` marks every `/api/` answer, `/healthz` and every HTML document `no-store`, and
 *     does it *after* the route wrote its headers — a route cannot loosen the rule,
 *     `@fastify/static` keeps its own policy for the rest. `/book.fb2` is not HTML and not
 *     under `/api/`, so its route states the policy itself: BOOK-138 makes it `no-store` too,
 *     because the edition changes with every chapter and a stored copy of the file is a stale
 *     copy. The tag stays, so an explicit `If-None-Match` still gets a truthful `304`.
 *
 *     BOOK-157 excepts one file from `no-store`: `/sw.js`. A service worker's script is not
 *     prose — it carries the offline document and a list of files whose names are their hashes —
 *     and a browser must be able to keep it at all, or it cannot register one (`no-store` on the
 *     script makes registration fail). It is `no-cache` instead: stored, and revalidated before
 *     every use, so a reader never runs a worker from an older release. It is not in
 *     `REVALIDATABLE`, so the conditional headers are dropped and the browser gets the bytes of
 *     *this* release rather than a `304` for an older worker.
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
 * BOOK-60: the one non-static surface allowed to revalidate. Since BOOK-133 its tag is the
 * edition hash *and* the cover's sha256, so it names the paragraphs and the image themselves —
 * see the module comment.
 */
const REVALIDATABLE_EXACT = ['/book.fb2'] as const;

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
  if (REVALIDATABLE_EXACT.some((exact) => path === exact)) return true;
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
    // BOOK-157: the service worker's script is the one file a browser must be able to keep and
    // must never run from an older release — `no-store` would make registration fail outright.
    // A 404 for it is not a worker either: keep a miss unstorable, like an asset miss.
    if (path === '/sw.js') {
      reply.header('cache-control', reply.statusCode < 400 ? 'no-cache' : 'no-store');
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
