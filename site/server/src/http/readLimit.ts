/**
 * The read API's budget (audit M6, ARCHITECTURE.md §14).
 *
 * The expensive reads are the history projections, the reader's own record, the end matter and
 * the two whole-book aggregates page views ask for on every load: `/api/history/at/:hseq` alone
 * is 67 indexed lookups, `/diff` recomputes a span on every call, `/api/me/decisions` and
 * `/api/authors` measure the whole book for every request (`/api/authors` also reads every
 * identity, the projection and each contributor's first change; `/api/authors/me` adds the
 * survival join), `/api/front` carries the contributor count, and `/api/cost` sums every step's
 * tokens and money. Nothing here is cacheable (BOOK-109: the app answers `no-store`), so every
 * repeat is a real transfer; the two aggregates are remembered per book state, but the rest
 * have nothing to absorb a repeat, and a script can ask for all of it thousands of times —
 * they take a per-network window in the same `rate_events` store as everything else: one
 * limiter, one salt, one hash, no second store to drift.
 *
 * The key is the hashed network, never the address: `rate_events` only ever holds a hash.
 *
 * BOOK-138: the export has a budget of its own, beside this one. See `EXPORT_LIMITED_PATHS`.
 */

import type { FastifyInstance } from 'fastify';

import { clientIp, ipKey as networkKey, type HeaderBag } from '../util/ip.ts';
import type { RouteDeps } from './deps.ts';

/**
 * The prefixes that take the read budget. `/api/state` is the SPA's poll and the cheapest;
 * `/api/front` is page 1 (the byline aggregate); `/api/cost` is the footer's outlay (the steps
 * aggregate); `/api/me` is the reader's own record; `/api/authors` is the end matter — the
 * whole-book measurement plus every contributor's first change, public and anonymous, and its
 * `/me` sibling pays the same measurement.
 *
 * The byline count is *not* shared with the list here: the list's own measurement already
 * yields the number (`contributors.length`, the same filter `authors/count.ts` applies), so a
 * caller that needs both pays once, while `/api/front` cannot take the list's measurement
 * without paying the full list on page 1's hot path — so the count keeps its grouped `COUNT`
 * and `authors.test.ts` pins the two numbers equal.
 *
 * BOOK-138: `/book.fb2` is **not** here. It was, and a reader's second click in a row shared a
 * 60-slot window with the page's own polling — a page that polls `no-store` every second could
 * spend the budget before the reader clicked twice. The export therefore takes its own key
 * (`EXPORT_LIMITED_PATHS`): same window, same configured limit, same store, a different
 * prefix, so neither budget can starve the other. A `304` spends a slot too: it is still a
 * request to this host, and a script that revalidates in a loop is a script.
 */
export const READ_LIMITED_PREFIXES = [
  '/api/history',
  '/api/changes',
  '/api/state',
  '/api/front',
  '/api/cost',
  '/api/me',
  '/api/authors',
] as const;

/**
 * BOOK-138 — the export's own budget, per network: the same window and the same configured
 * limit as the reads, counted for `GET` and `HEAD`, refused with the same `429` and
 * `retry-after`. A download is the one read a reader asks for deliberately, so the page's
 * polls must not be able to take it away. Exact paths, not prefixes: `/book.fb2/anything` is
 * not this file, and `/book.fb2x` is not this route.
 */
export const EXPORT_LIMITED_PATHS = ['/book.fb2'] as const;

/**
 * The stage replay is a poll surface (`docs/writer-lane.md §3`), while the chapter body beside
 * it is page load: the chapter read stays outside the budget, its stages do not.
 */
const READ_LIMITED_PATTERNS = [/^\/api\/chapters\/\d{1,3}\/stages$/u];

export const READ_WINDOW_MS = 60_000;

export function readLimitKey(ipHash: (ipKey: string) => string, key: string): string {
  return `read:ip:${ipHash(key)}`;
}

/** The export's key: the same hashed network, a prefix of its own so the two never collide. */
export function exportLimitKey(ipHash: (ipKey: string) => string, key: string): string {
  return `export:ip:${ipHash(key)}`;
}

/** Does this URL take the read budget? A query string is not part of the decision. */
export function isReadLimited(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (READ_LIMITED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  return READ_LIMITED_PATTERNS.some((pattern) => pattern.test(path));
}

/** Does this URL take the export budget? Exact path only — `/book.fb2x` is another route. */
export function isExportLimited(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return EXPORT_LIMITED_PATHS.some((exact) => path === exact);
}

/**
 * One `onRequest` hook for every read surface: a GET/HEAD on a limited prefix consumes one
 * slot of `READ_PER_MINUTE` — from the read budget or from the export's own, never both. A
 * refusal is the uniform `{code, message, retryAfterMs}` shape with `retry-after`, so a client
 * can wait instead of guessing.
 */
export function registerReadLimit(app: FastifyInstance, deps: RouteDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    const exportBudget = isExportLimited(request.url);
    if (!exportBudget && !isReadLimited(request.url)) return undefined;

    const peer = request.socket?.remoteAddress ?? request.ip ?? '';
    const trusted = deps.config.trustedProxies.split(',').map((part) => part.trim());
    const ip = clientIp(request.headers as HeaderBag, peer, trusted);
    const network = networkKey(ip);
    const verdict = deps.limiter.consume([
      {
        key: exportBudget ? exportLimitKey(deps.ipHash, network) : readLimitKey(deps.ipHash, network),
        limit: deps.config.readPerMinute,
        windowMs: READ_WINDOW_MS,
      },
    ]);
    if (verdict.allowed) return undefined;

    const retryAfterMs = verdict.blocked.retryAfterMs;
    return reply
      .code(429)
      .header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
      .header('cache-control', 'no-store')
      .send({
        code: 'RATE_LIMITED',
        message: 'слишком много запросов — попробуйте позже',
        retryAfterMs,
      });
  });
}
