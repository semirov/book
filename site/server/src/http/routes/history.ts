/**
 * `GET /api/history/*` (ARCHITECTURE.md §6F.2, §6F.5, §9): the chronicle, time travel, the
 * paragraph chain, impact and the authors' erosion series.
 *
 * All of it is public and read-only: the past is generated from the log and the snapshot
 * store, and it never feeds the editor, the engine or the queue.
 *
 * No route here sets a freshness header and none answers a conditional request: the app's one
 * policy (`http/cache.ts`) marks every `/api/` answer `no-store`, because the chronicle moves
 * under a fixed URL and a reused copy is a stale chronicle (BOOK-109). The chapter's ETag stays
 * as the name of the moment it serves.
 */

import type {
  BookAtDto,
  ChangeImpactDto,
  ContributorsDto,
  HistoryChapterDto,
  HistoryDiffDto,
  HistoryTimelineDto,
  ParagraphChainDto,
} from '@book/shared';
import { TOTAL_CHAPTERS, isChapterNumber } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { chapterAt, bookAt, resolveMoment } from '../../history/book.ts';
import { lastHseq } from '../../history/events.ts';
import { readImpact } from '../../history/impact.ts';
import { readContributors, readDiff, readParagraphChain } from '../../history/query.ts';
import { readRecord } from '../../history/record.ts';
import type { RouteDeps } from '../deps.ts';

const chapterParams = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'integer', minimum: 1, maximum: TOTAL_CHAPTERS } },
  additionalProperties: false,
} as const;

type MomentQuery = { at?: string | number; before?: string | number; limit?: string | number; chapter?: string | number };

function positive(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function registerHistoryRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db } = deps;

  /**
   * The record's spine: one change a reader made, newest first, cursor by the change's last
   * `hseq`. `kind` and per-event filters are gone with the event list itself (BOOK-65).
   */
  app.get<{ Querystring: MomentQuery }>('/api/history/timeline', async (request, reply) => {
    const { before, limit } = request.query;
    const body: HistoryTimelineDto = {
      ...readRecord(db, {
        before: positive(before),
        limit: positive(limit),
      }),
      at: new Date(deps.now().getTime()).toISOString(),
    };
    return reply.send(body);
  });

  /** The book as it was: metadata only, no bodies (§6F.2). */
  app.get<{ Params: { hseq: string } }>('/api/history/at/:hseq', async (request, reply) => {
    const moment = request.params.hseq;
    if (moment !== 'now' && !/^\d+$/u.test(moment) && Number.isNaN(Date.parse(moment))) {
      return reply.code(422).send({ code: 'INVALID_MOMENT', message: 'hseq must be a number, an ISO time or "now"' });
    }
    const body: BookAtDto = bookAt(db, moment === 'now' ? null : moment);
    return reply.send(body);
  });

  /** One chapter as it was, with its own ETag: `ch09@h1043` (§6F.2). */
  app.get<{ Params: { n: number }; Querystring: MomentQuery }>(
    '/api/history/chapters/:n',
    { schema: { params: chapterParams } },
    async (request, reply) => {
      const n = Number(request.params.n);
      if (!isChapterNumber(n)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such chapter' });
      const hseq = resolveMoment(db, request.query.at ?? null);
      const body = chapterAt(db, deps.config.dataDir, n, hseq) as HistoryChapterDto | null;
      if (body === null) {
        return reply
          .code(404)
          .send({ code: 'NOT_WRITTEN_THEN', message: 'chapter did not exist at that moment' });
      }
      const etag = `"ch${String(n).padStart(2, '0')}@h${body.hseq}"`;
      return reply.header('etag', etag).send(body);
    },
  );

  /** The change log for a span, capped at 500 operations (§6F.2). */
  app.get<{ Querystring: MomentQuery }>('/api/history/diff', async (request, reply) => {
    const from = resolveMoment(db, request.query.before ?? 0);
    const to = resolveMoment(db, request.query.at ?? null);
    const chapter = positive(request.query.chapter);
    if (chapter !== undefined && !isChapterNumber(chapter)) {
      return reply.code(422).send({ code: 'INVALID_CHAPTER', message: `chapter must be 1..${TOTAL_CHAPTERS}` });
    }
    const body: HistoryDiffDto = readDiff(db, from, to, chapter);
    return reply.send(body);
  });

  /** The lineage chain of one paragraph: where it came from, what rewrote it (§6F.3). */
  app.get<{ Params: { blockId: string } }>('/api/history/paragraphs/:blockId', async (request, reply) => {
    const blockId = request.params.blockId;
    if (blockId.length === 0 || blockId.length > 80) {
      return reply.code(422).send({ code: 'INVALID_BLOCK', message: 'block id is required' });
    }
    const body = readParagraphChain(db, blockId) as ParagraphChainDto | null;
    if (body === null) return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such paragraph' });
    return reply.send(body);
  });

  /** What a change actually did (§6F.5); a projection, recomputed when absent. */
  app.get<{ Params: { changeId: string } }>('/api/history/impact/:changeId', async (request, reply) => {
    const body = readImpact(db, request.params.changeId, deps.now().getTime()) as ChangeImpactDto | null;
    if (body === null) return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such change' });
    return reply.send(body);
  });

  /** Whose text survived, and how the share moved (§6F.4). */
  app.get('/api/history/contributors', async (_request, reply) => {
    const body: ContributorsDto = readContributors(db);
    return reply.send(body);
  });

  /** The scrubber's right edge and a cheap "is there anything new" probe. */
  app.get('/api/history/status', async (_request, reply) => {
    const hseq = lastHseq(db);
    const row = db.prepare('SELECT at FROM events WHERE hseq = ?').get(hseq) as { at: string } | undefined;
    return reply.send({ hseq, at: row?.at ?? null });
  });
}
