/**
 * The read API's budget (audit M6, ARCHITECTURE.md §14).
 *
 * The expensive reads are the history projections: `/api/history/at/:hseq` alone is 67
 * indexed lookups, and `/diff` recomputes a span on every call. They are public and
 * cacheable, but a script that ignores the cache can still ask for them thousands of times,
 * so they take a per-network window in the same `rate_events` store as everything else —
 * one limiter, one salt, one hash, no second store to drift.
 *
 * The key is the hashed network, never the address: `rate_events` only ever holds a hash.
 */

import type { FastifyInstance } from 'fastify';

import { clientIp, ipKey as networkKey, type HeaderBag } from '../util/ip.ts';
import type { RouteDeps } from './deps.ts';

/** The prefixes that take the read budget. `/api/state` is the SPA's poll and the cheapest. */
export const READ_LIMITED_PREFIXES = ['/api/history', '/api/changes', '/api/state'] as const;

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
