/**
 * `GET /api/me/decisions` — the reader's own record of what happened to their interventions
 * (BOOK-13, BOOK-DOC-4 rule 4).
 *
 * Own only and session-gated: the identity comes from the cookie, and there is no id in the
 * path or the query, so the route cannot be turned into a way of reading another reader's
 * history. `no-store`, because a decision that just landed must not be answered from a copy.
 */

import type { FastifyInstance } from 'fastify';

import { readMyDecisions } from '../../authors/decisions.ts';
import type { RouteDeps } from '../deps.ts';
import { sessionOf, unauthenticated } from '../session.ts';

export function registerMeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/me/decisions', async (request, reply) => {
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    return reply
      .header('cache-control', 'no-store')
      .send(readMyDecisions(deps.db, session.identity.id));
  });
}
