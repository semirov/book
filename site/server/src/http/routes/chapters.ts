import { TOTAL_CHAPTERS, isChapterNumber, type ChapterDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { getChapterRow, listBlocks } from '../../db/repo/chapters.ts';
import { frameOf } from '../../db/repo/frame.ts';
import { chapterEtag } from '../../util/etag.ts';
import { checkFrameDrift, framePositionOf, frameSource } from '../frameDrift.ts';
import type { RouteDeps } from '../deps.ts';

const paramsSchema = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'integer', minimum: 1, maximum: TOTAL_CHAPTERS } },
  additionalProperties: false,
} as const;

/**
 * The frame rows already reported as unreadable in this process. A volume that lost its row
 * answers every request the same way, so the line is written once — an operator reads one reason,
 * not a log flood; `1/first` and `42/last` are separate rows and report separately.
 */
const unreadableReported = new Set<string>();

/**
 * The drift already reported, per frame row: the pair of texts, not a flag. A row that stays
 * wrong would otherwise write both paragraphs into the log on every reader's page view; one line
 * per *distinct* drift is news, a repeat is not. Agreement clears the entry, so the same drift
 * coming back later is reported again.
 */
const loggedDrift = new Map<string, string>();

export function registerChapterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { n: number } }>('/api/chapters/:n', { schema: { params: paramsSchema } }, async (request, reply) => {
    const n = Number(request.params.n);
    if (!isChapterNumber(n)) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such chapter' });
    }
    const row = getChapterRow(deps.db, n);
    if (row === undefined || row.block_count === 0) {
      // An empty slot is not an error condition of the site — 404 is the normal answer.
      // A basis-only slot is not one: it carries the frozen frame as its one paragraph and
      // is served like prose, while the catalog keeps it `written: false` (BOOK-6). The cache
      // policy is the app's (`http/cache.ts`), so the 404 carries none of its own (BOOK-109).
      return reply.code(404).send({ code: 'NOT_WRITTEN', message: 'chapter is not written yet' });
    }

    const blocks = listBlocks(deps.db, n);
    const body: ChapterDto = {
      n: row.n,
      title: row.title,
      rev: row.rev,
      chars: row.chars,
      basis: row.basis === 1,
      writtenAt: row.written_at,
      updatedAt: row.updated_at,
      blocks: blocks.map((block) => ({
        id: block.id,
        i: block.idx,
        text: block.text,
        hash: block.hash,
      })),
    };

    // BOOK-109 / BOOK-187: the frame the reader is about to see against the row `book_frame`
    // holds. Only ch01/ch42 cost a row, and only a real disagreement is logged — with both
    // strings, so the line says which side is wrong without a second request. Each distinct drift
    // is one line: a page view is not news (see `loggedDrift`).
    const check = checkFrameDrift({ frameOf: (chapter, position) => frameOf(deps.db, chapter, position) }, n, blocks);
    if (check === null) {
      // Back in agreement: forget the drift, so a recurrence is reported again.
      const position = framePositionOf(n);
      if (position !== null) loggedDrift.delete(frameSource(n, position));
    } else if ('unreadable' in check) {
      if (!unreadableReported.has(check.source)) {
        unreadableReported.add(check.source);
        request.log.error({ chapter: n, source: check.source, reason: check.unreadable }, 'FRAME_DRIFT unreadable');
      }
    } else {
      const signature = `${check.served}\n${check.stored}`;
      if (loggedDrift.get(check.source) !== signature) {
        loggedDrift.set(check.source, signature);
        request.log.error(
          { chapter: n, source: check.source, served: check.served, stored: check.stored },
          'FRAME_DRIFT',
        );
      }
    }

    // The tag still names the projection, not only the revision: emptying keeps `rev` (BOOK-6).
    reply.header('etag', `"${chapterEtag(n, row.rev, row.basis === 1)}"`);
    return reply.send(body);
  });
}
