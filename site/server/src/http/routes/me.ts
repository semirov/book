/**
 * `GET /api/me/decisions` and `GET /api/me/filings` — the reader's own record (BOOK-13,
 * BOOK-DOC-4 rule 4; BOOK-207).
 *
 * Own only and session-gated: the identity comes from the cookie, and there is no id in the
 * path or the query, so the route cannot be turned into a way of reading another reader's
 * history. `no-store`, because a decision that just landed must not be answered from a copy.
 */

import type { FastifyInstance } from 'fastify';

import { readMyDecisions } from '../../authors/decisions.ts';
import { listOwnCommentRows, toCommentDto } from '../../comments/repo.ts';
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

  // BOOK-207 — «ваш след»: the reader's own filings, newest first, the newest 50, from the
  // session cookie only. Read-only; the trail's rows are the thread's own DTOs.
  app.get('/api/me/filings', async (request, reply) => {
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    const items = listOwnCommentRows(deps.db, session.identity.id).map((row) =>
      toCommentDto(deps.db, row),
    );
    return reply.header('cache-control', 'no-store').send({ items });
  });
}
