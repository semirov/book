import { isChapterNumber, type ChapterDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { getChapterRow, listBlocks } from '../../db/repo/chapters.ts';
import type { RouteDeps } from '../deps.ts';

const paramsSchema = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'integer', minimum: 1, maximum: 67 } },
  additionalProperties: false,
} as const;

export function registerChapterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { n: number } }>('/api/chapters/:n', { schema: { params: paramsSchema } }, async (request, reply) => {
    const n = Number(request.params.n);
    if (!isChapterNumber(n)) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such chapter' });
    }
    const row = getChapterRow(deps.db, n);
    if (row === undefined || row.block_count === 0) {
      // An unwritten slot is not an error condition of the site — 404 is the normal answer.
      return reply
        .code(404)
        .header('cache-control', 'public, max-age=2')
        .send({ code: 'NOT_WRITTEN', message: 'chapter is not written yet' });
    }

    const etag = `"ch${String(n).padStart(2, '0')}-r${row.rev}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'public, max-age=5, stale-while-revalidate=30');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();

    const body: ChapterDto = {
      n: row.n,
      rev: row.rev,
      chars: row.chars,
      writtenAt: row.written_at,
      updatedAt: row.updated_at,
      blocks: listBlocks(deps.db, n).map((block) => ({
        id: block.id,
        i: block.idx,
        text: block.text,
        hash: block.hash,
      })),
    };
    return reply.send(body);
  });
}
