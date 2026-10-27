/**
 * The read API's budget (audit M6, ARCHITECTURE.md §14).
 *
 * The expensive reads are the history projections, the reader's own record, the end matter
 * and the title page's byline: `/api/history/at/:hseq` alone is 67 indexed lookups, `/diff`
 * recomputes a span on every call, `/api/me/decisions` and `/api/authors` measure the whole
 * book for every request (`/api/authors` also reads every identity, the projection and each
 * contributor's first change; `/api/authors/me` adds the survival join and is `no-store`, so
 * nothing absorbs a repeat), and `/api/front` carries the contributor count — a whole-book
 * aggregate page 1 asks for on every load. They are cacheable or own-only, but a script can
 * still ask for them thousands of times, so they take a per-network window in the same
 * `rate_events` store as everything else — one limiter, one salt, one hash, no second store
 * to drift.
 *
 * The key is the hashed network, never the address: `rate_events` only ever holds a hash.
 */

import type { FastifyInstance } from 'fastify';

import { clientIp, ipKey as networkKey, type HeaderBag } from '../util/ip.ts';
import type { RouteDeps } from './deps.ts';

/**
 * The prefixes that take the read budget. `/api/state` is the SPA's poll and the cheapest;
 * `/api/front` is page 1 (the byline aggregate); `/api/me` is the reader's own record;
 * `/api/authors` is the end matter — the whole-book measurement plus every contributor's
 * first change, public and anonymous, and its `/me` sibling pays the same measurement.
 *
 * The byline count is *not* shared with the list here: the list's own measurement already
 * yields the number (`contributors.length`, the same filter `authors/count.ts` applies), so a
 * caller that needs both pays once, while `/api/front` cannot take the list's measurement
 * without paying the full list on page 1's hot path — so the count keeps its grouped `COUNT`
 * and `authors.test.ts` pins the two numbers equal.
 */
export const READ_LIMITED_PREFIXES = [
  '/api/history',
  '/api/changes',
  '/api/state',
  '/api/front',
  '/api/me',
  '/api/authors',
] as const;

export const READ_WINDOW_MS = 60_000;

export function readLimitKey(ipHash: (ipKey: string) => string, key: string): string {
  return `read:ip:${ipHash(key)}`;
}

/** Does this URL take the read budget? A query string is not part of the decision. */
export function isReadLimited(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return READ_LIMITED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * One `onRequest` hook for every read surface: a GET/HEAD on a limited prefix consumes one
 * slot of `READ_PER_MINUTE`. A refusal is the uniform `{code, message, retryAfterMs}` shape
 * with `retry-after`, so a client can wait instead of guessing.
 */
export function registerReadLimit(app: FastifyInstance, deps: RouteDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    if (!isReadLimited(request.url)) return undefined;

    const peer = request.socket?.remoteAddress ?? request.ip ?? '';
    const trusted = deps.config.trustedProxies.split(',').map((part) => part.trim());
    const ip = clientIp(request.headers as HeaderBag, peer, trusted);
    const verdict = deps.limiter.consume([
      {
        key: readLimitKey(deps.ipHash, networkKey(ip)),
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
