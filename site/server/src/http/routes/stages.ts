/**
 * `GET /api/chapters/:n/stages` (docs/writer-lane.md §3): what already happened to a chapter's
 * passes, for a reader who was not connected when it happened.
 *
 * Public and replay-only: it reads the stage store, never the manuscript, and returns the
 * stored `at` — a late client learns the stages in order instead of watching an animation
 * from the start. The ETag is the store's own `MAX(seq)`, so a new stage invalidates every
 * chapter's cached list without a per-chapter counter.
 */

import { isChapterNumber } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { listStages, maxStageSeq } from '../../stages/repo.ts';
import type { RouteDeps } from '../deps.ts';

const paramsSchema = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'integer', minimum: 1, maximum: 67 } },
  additionalProperties: false,
} as const;

export const STAGE_LIST_DEFAULT_LIMIT = 50;
export const STAGE_LIST_MAX_LIMIT = 200;

/** `?limit` defaults to 50 and caps at 200; anything unparseable falls back to the default. */
export function stageListLimit(raw: unknown): number {
  if (raw === undefined) return STAGE_LIST_DEFAULT_LIMIT;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return STAGE_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), STAGE_LIST_MAX_LIMIT);
}

export function registerStageRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { n: number }; Querystring: { limit?: string | number; pass?: string } }>(
    '/api/chapters/:n/stages',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const n = Number(request.params.n);
      if (!isChapterNumber(n)) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such chapter' });
      }
      const rawPass = request.query.pass;
      if (rawPass !== undefined && (rawPass.length === 0 || rawPass.length > 80)) {
        return reply.code(422).send({ code: 'INVALID_PASS', message: 'pass must be a pass id' });
      }
      const pass = rawPass ?? null;
      const cursor = maxStageSeq(deps.db);
      const etag = `"stages-${n}-${cursor}"`;
      // BOOK-109: the ETag is compared, never traded for a `304` — a poll of a book being
      // written must be answered with the body, and the stages a late reader gets are the
      // settled ones, with their own `at`. The freshness policy is the app's (`http/cache.ts`).
      return reply
        .header('etag', etag)
        .send({ stages: listStages(deps.db, n, { limit: stageListLimit(request.query.limit), pass }) });
    },
  );
}
