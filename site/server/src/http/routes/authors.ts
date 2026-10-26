/**
 * The end matter's authors list (§6C.5) and the reader's own trace (BOOK-DOC-4).
 *
 * `/api/authors` is public and cacheable: the list is measured, not live, so a reader
 * reloading the page must see the same numbers (rule 6). `/api/authors/me` and
 * `/api/authors/hide` are session-only: the identity comes from the cookie, never from a
 * parameter, and the answer carries no identity key — the display name is the only handle.
 */

import type { FastifyInstance } from 'fastify';

import { readAuthors } from '../../authors/contributions.ts';
import { readMyTrace } from '../../authors/trace.ts';
import { hideSpecs } from '../../rate/policy.ts';
import { checkMutation } from '../origin.ts';
import type { RouteDeps } from '../deps.ts';
import { sessionOf, unauthenticated } from '../session.ts';

export function registerAuthorsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/authors', async (_request, reply) => {
    return reply
      .header('cache-control', 'public, max-age=30')
      .send(readAuthors(deps.db, deps.imprint.author));
  });

  /** Own only: no id in the path or query, so there is no way to ask for another reader. */
  app.get('/api/authors/me', async (request, reply) => {
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    return reply
      .header('cache-control', 'no-store')
      .send(readMyTrace(deps.db, session.identity.id));
  });

  /**
   * «Скрыть из списка авторов» / «вернуть в список» (BOOK-DOC-4): idempotent, reversible,
   * and it touches only `identities.hide_from_authors` — history, edits and the measured
   * share stay exactly where they were. A hidden reader is not listed and is not counted by
   * the byline, but the text they wrote is still theirs.
   */
  app.post('/api/authors/hide', async (request, reply) => {
    const guard = checkMutation(request, deps.config.publicOrigin);
    if (guard !== 'ok') {
      return reply.code(403).send({
        code: guard,
        message: guard === 'ORIGIN' ? 'запрос с чужого источника отклонён' : 'нужен application/json',
      });
    }

    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);

    // §14: a state mutation spends its own budget, like a comment or an edit does.
    const limited = deps.limiter.consume(hideSpecs(session.identity.id));
    if (!limited.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(limited.blocked.retryAfterMs / 1000))));
      return reply.code(429).header('cache-control', 'no-store').send({
        code: 'RATE_LIMITED',
        message: 'слишком много переключений — попробуйте позже',
        retryAfterMs: limited.blocked.retryAfterMs,
      });
    }

    const body = request.body as { hidden?: unknown } | null;
    if (body === null || typeof body !== 'object' || typeof body.hidden !== 'boolean') {
      return reply.code(400).send({ code: 'INVALID', message: 'hidden must be a boolean' });
    }

    deps.db
      .prepare('UPDATE identities SET hide_from_authors = ? WHERE id = ?')
      .run(body.hidden ? 1 : 0, session.identity.id);

    const authors = deps.authorsCount();
    // The fact is broadcast by the route that creates it (§10): the title page and every
    // open end matter follow without a poll.
    deps.emit?.('authors:update', authors);
    return reply.header('cache-control', 'no-store').send({ hidden: body.hidden, authors });
  });
}
