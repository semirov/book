/**
 * The writer lane's three text doors (BOOK-173 §7, BOOK-187): one chapter of a ripple, the text a
 * prompt may quote, and `--revert`.
 *
 * They live apart from `control.ts` because that file is the app's assembly and was at the
 * file-size wall; the bodies they parse are in `bodySchemas.ts`, so a bound is written once.
 */

import type { FastifyInstance } from 'fastify';

import { restoreBody, rippleBody, textBody } from './bodySchemas.ts';
import type { Engine } from './service.ts';

export function registerWriterDoors(app: FastifyInstance, doors: { engine: Engine }): void {
  /**
   * BOOK-173 §7: one chapter of a ripple. Its own step (`pass: 'cascade'`), its own lease and its
   * own gates — a long ripple is a sequence of normal passes, not one process that walks a book.
   */
  app.post('/internal/ripple/open', async (request) => {
    const body = rippleBody.parse(request.body ?? {});
    return { ok: true, data: doors.engine.openChapterPass(body.chapter, body.session, body.changeId) };
  });
  /**
   * BOOK-187: the text a prompt may quote, **from rows only** — the chapter the writer is on, its
   * neighbours, and the landed text a gate judges. The body is canonical and carries no title
   * line; the prompt prints the title itself.
   */
  app.post('/internal/text', async (request) => {
    const body = textBody.parse(request.body ?? {});
    return { ok: true, data: doors.engine.text(body.chapters) };
  });
  /**
   * BOOK-187 / ADR-043 §3 row 9: `--revert` is a **new** revision (`cause_kind = 'restore'`)
   * published through the applier, never a file put back.
   */
  app.post('/internal/restore', async (request) => {
    const body = restoreBody.parse(request.body ?? {});
    return { ok: true, data: doors.engine.restore({ chapter: body.chapter, rev: body.rev }) };
  });
}
