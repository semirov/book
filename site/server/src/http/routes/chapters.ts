import { TOTAL_CHAPTERS, isChapterNumber, type ChapterDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { getChapterRow, listBlocks } from '../../db/repo/chapters.ts';
import { chapterEtag } from '../../util/etag.ts';
import { checkFrameDrift, frameFile } from '../frameDrift.ts';
import type { RouteDeps } from '../deps.ts';

const paramsSchema = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'integer', minimum: 1, maximum: 67 } },
  additionalProperties: false,
} as const;

/**
 * The frame files already reported as unreadable in this process. A mount that is gone answers
 * every request the same way, so the line is written once — an operator reads one reason, not
 * a log flood; `ch01` and `ch67` are separate files and report separately.
 */
const unreadableReported = new Set<string>();

/**
 * The drift already reported, per frame file: the pair of texts, not a flag. A projection that
 * stays wrong would otherwise write both paragraphs into the log on every reader's page view;
 * one line per *distinct* drift is news, a repeat is not. Agreement clears the entry, so the
 * same drift coming back later is reported again.
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

    // BOOK-109: the frame the reader is about to see against the one the file holds. Only
    // ch01/ch67 cost a read, and only a real disagreement is logged — with both strings, so
    // the line says which side is wrong without a second request. Each distinct drift is one
    // line: a page view is not news (see `loggedDrift`).
    const check = checkFrameDrift({ bookRoot: deps.config.bookRoot }, n, blocks);
    if (check === null) {
      // Back in agreement: forget the drift, so a recurrence is reported again.
      if (n === 1 || n === TOTAL_CHAPTERS) loggedDrift.delete(frameFile(deps.config.bookRoot, n));
    } else if ('unreadable' in check) {
      if (!unreadableReported.has(check.file)) {
        unreadableReported.add(check.file);
        request.log.error({ chapter: n, file: check.file, reason: check.unreadable }, 'FRAME_DRIFT unreadable');
      }
    } else {
      const signature = `${check.served}\n${check.manuscript}`;
      if (loggedDrift.get(check.file) !== signature) {
        loggedDrift.set(check.file, signature);
        request.log.error(
          { chapter: n, file: check.file, served: check.served, manuscript: check.manuscript },
          'FRAME_DRIFT',
        );
      }
    }

    // The tag still names the projection, not only the revision: emptying keeps `rev` (BOOK-6).
    reply.header('etag', `"${chapterEtag(n, row.rev, row.basis === 1)}"`);
    return reply.send(body);
  });
}
