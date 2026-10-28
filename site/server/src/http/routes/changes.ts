/**
 * `GET /api/changes`, `/api/changes/:id`, `/api/queue` (ARCHITECTURE.md §9, §10.3a).
 *
 * The public projection only: a change, its relevance, its steps and its seams. The
 * projection in `engineState/changes.ts` never selects `gate_verdicts`, so no route here
 * can answer with a verdict, a finding or the name of a hidden role (§6B.6).
 *
 * No auth: the book is read in public. No ETag on the list — the queue moves under it, and
 * the SPA already polls it live. No freshness header either: the app's one policy
 * (`http/cache.ts`) answers `no-store` for every `/api/` path (BOOK-109).
 */

import { TOTAL_CHAPTERS, isChapterNumber, type ChangeStatus } from '@book/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { listChanges, readChange } from '../../engineState/changes.ts';
import { readQueue } from '../../engineState/reader.ts';
import type { RouteDeps } from '../deps.ts';

const STATUSES: readonly ChangeStatus[] = ['pending', 'processing', 'stale', 'done', 'void', 'escalated', 'failed'];

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'INVALID', message });
}

function integer(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,7}$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

export function registerChangeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/queue', async (_request, reply) => {
    return reply.header('cache-control', 'no-store').send(deps.engineQueue?.() ?? readQueue(deps.db, Date.now()));
  });

  app.get('/api/changes', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const status = typeof query.status === 'string' ? query.status : undefined;
    if (status !== undefined && !STATUSES.includes(status as ChangeStatus)) {
      return invalid(reply, `status must be one of ${STATUSES.join(', ')}`);
    }
    let chapter: number | undefined;
    if (query.chapter !== undefined) {
      const parsed = integer(query.chapter);
      if (parsed === null || parsed < 1 || parsed > TOTAL_CHAPTERS) return invalid(reply, `chapter must be 1..${TOTAL_CHAPTERS}`);
      chapter = parsed;
    }
    let limit: number | undefined;
    if (query.limit !== undefined) {
      const parsed = integer(query.limit);
      if (parsed === null || parsed < 1 || parsed > 50) return invalid(reply, 'limit must be 1..50');
      limit = parsed;
    }
    let before: number | undefined;
    if (query.before !== undefined) {
      const parsed = integer(query.before);
      if (parsed === null) return invalid(reply, 'before must be a seq');
      before = parsed;
    }

    const changes = listChanges(deps.db, { status: status as ChangeStatus | undefined, chapter, limit, before });
    return reply.send(changes);
  });

  app.get('/api/changes/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const change = readChange(deps.db, id, Date.now());
    // BOOK-155 — a change filed at a number the book no longer has has no card either: the row
    // is storage, and its `chapter` would print «глава 65» and link to an `#ch-65` that is not
    // there. The same 404 the unknown id gets, and no deletion: the listing filter already keeps
    // such a row out of `/api/changes`.
    if (change === null || !isChapterNumber(change.chapter)) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such change' });
    }
    return reply.send(change);
  });
}
