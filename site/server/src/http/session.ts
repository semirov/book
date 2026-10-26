/**
 * The session seam every own-only route shares (ARCHITECTURE.md §9, §17).
 *
 * An own-only surface takes its identity from the cookie and from nowhere else: no path
 * parameter, no query, no body. That rule is only as strong as its weakest caller, so the
 * two steps — read the cookie at all, and answer an anonymous visitor in the one shape —
 * live here once instead of being retyped per route.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { SESSION_COOKIE, type SessionLookup } from '../identity/session.ts';
import { parseCookies } from '../util/cookies.ts';
import type { RouteDeps } from './deps.ts';

export function sessionOf(deps: RouteDeps, request: FastifyRequest): SessionLookup | null {
  return deps.sessions.read(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
}

/** One 401 for every own-only route: signed out is not an error the reader can fix. */
export function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('cache-control', 'no-store')
    .send({ code: 'UNAUTHENTICATED', message: 'войдите через Яндекс, чтобы продолжить' });
}
