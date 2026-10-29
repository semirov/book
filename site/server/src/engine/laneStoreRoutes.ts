/**
 * The writer lane's two stores, as the engine's doors (BOOK-187 AC5, AC7).
 *
 * The writer process holds no database handle and must not get one (one writer kernel per
 * process, BOOK-183), so everything it needs to remember lives behind these three authenticated
 * routes — registered into the same control app as `/internal/stage`, under the same bearer guard:
 *
 *  · `GET /internal/writer-state?day=…` — the lane's counter as the caller's day sees it;
 *  · `POST /internal/writer-state` — count one pass, in one transaction, and answer the row;
 *  · `POST /internal/transcript` — a pass's redacted receipt, pruned on write;
 *  · `POST /internal/writer-boot` — the process's boot marker for the sample queue (BOOK-DOC-80).
 *
 * Shape validation lives here, next to the body limits it depends on; the storage rules live in
 * `db/repo/writerState.ts` and `db/repo/transcripts.ts`. A control app built without a database (a
 * REST-only test) refuses all three with 503 rather than pretending they were stored.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/db.ts';
import {
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  TRANSCRIPT_ROLES,
  TRANSCRIPT_ROW_BYTES_MAX,
  TRANSCRIPT_ROWS_MAX,
  insertTranscripts,
} from '../db/repo/transcripts.ts';
import { isIsoDay, readWriterState, recordWriterState } from '../db/repo/writerState.ts';
import { markWriterBoot } from '../ledger/graph/verification.ts';
import { ulid } from '../util/ulid.ts';

/**
 * Sixteen receipts of at most 4 KB each are 64 KB of content before any JSON around them, which
 * is over Fastify's 64 KB app default: the route carries its own, and nothing else gets wider.
 */
const TRANSCRIPT_BODY_LIMIT = 128 * 1024;

/**
 * The day is the caller's bucket, so it is validated as a real calendar date here: `2026-02-30`
 * is a typo, not a day, and it must not become a bucket nobody can ask for again.
 */
const dayString = z
  .string()
  .max(10)
  .refine(isIsoDay, { message: 'day must be a real YYYY-MM-DD date' });

const writerStateQuery = z.object({ day: dayString });

const writerStateBody = z.object({
  day: dayString,
  spent: z.boolean(),
  /** `undefined` leaves the column alone, `null` clears it, an ISO moment sets it. */
  pauseUntil: z
    .string()
    .max(40)
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'pauseUntil must be an ISO moment' })
    .nullable()
    .optional(),
  now: z.number().int().min(0).optional(),
});

/** One row of a receipt: a fixed role vocabulary, two counters, the redacted facts as JSON. */
const transcriptRowBody = z.object({
  seq: z.number().int().min(1).max(64),
  at: z.number().int().min(0),
  role: z.enum(TRANSCRIPT_ROLES),
  tokensIn: z.number().int().min(0).default(0),
  tokensOut: z.number().int().min(0).default(0),
  promptBundle: z.string().max(80).nullish(),
  content: z.string().min(2).max(TRANSCRIPT_ROW_BYTES_MAX),
});

const transcriptBody = z
  .object({
    passId: z.string().min(1).max(80),
    rows: z.array(transcriptRowBody).min(1).max(TRANSCRIPT_ROWS_MAX),
  })
  .superRefine((body, ctx) => {
    // Bytes, not characters: a receipt of Cyrillic is not smaller than a receipt of Latin, and the
    // bound is what keeps one row from becoming a second copy of the canon.
    body.rows.forEach((row, index) => {
      if (Buffer.byteLength(row.content, 'utf8') > TRANSCRIPT_ROW_BYTES_MAX) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index, 'content'],
          message: `a transcript row is at most ${String(TRANSCRIPT_ROW_BYTES_MAX)} bytes`,
        });
      }
    });
  });

export type LaneStoreDeps = {
  /** The engine's own connection; absent on a control app built for a route-level test. */
  db?: Db;
  /** `TRANSCRIPT_RETENTION_DAYS` from the boot config; the ADR's 30 when nobody said. */
  transcriptRetentionDays?: number;
};

export function registerLaneStoreRoutes(app: FastifyInstance, deps: LaneStoreDeps): void {
  const db = deps.db ?? null;
  const retentionDays = deps.transcriptRetentionDays ?? DEFAULT_TRANSCRIPT_RETENTION_DAYS;

  app.get('/internal/writer-state', async (request, reply) => {
    if (db === null) {
      return reply.code(503).send({ code: 'WRITER_STATE_UNAVAILABLE', message: 'the writer-state store is not attached' });
    }
    // Fastify always hands a query object; a missing `day` is the schema's refusal, not ours.
    const query = writerStateQuery.parse(request.query);
    return { ok: true, data: readWriterState(db, query.day) };
  });

  app.post('/internal/writer-state', async (request, reply) => {
    if (db === null) {
      return reply.code(503).send({ code: 'WRITER_STATE_UNAVAILABLE', message: 'the writer-state store is not attached' });
    }
    const body = writerStateBody.parse(request.body ?? {});
    const data: Parameters<typeof recordWriterState>[1] = { day: body.day, spent: body.spent };
    if (body.pauseUntil !== undefined) data.pauseUntil = body.pauseUntil;
    if (body.now !== undefined) data.now = body.now;
    return { ok: true, data: recordWriterState(db, data) };
  });

  app.post('/internal/transcript', { bodyLimit: TRANSCRIPT_BODY_LIMIT }, async (request, reply) => {
    if (db === null) {
      return reply.code(503).send({ code: 'TRANSCRIPTS_UNAVAILABLE', message: 'the transcript store is not attached' });
    }
    const body = transcriptBody.parse(request.body ?? {});
    return {
      ok: true,
      data: insertTranscripts(db, {
        passId: body.passId,
        rows: body.rows.map((row) => ({ ...row, promptBundle: row.promptBundle ?? null })),
        retentionDays,
      }),
    };
  });

  /**
   * BOOK-DOC-80: the marker a writer process writes once per boot. `INSERT OR IGNORE` on one `meta`
   * key, so a second process booting under a standing marker writes nothing and answers the same.
   */
  app.post('/internal/writer-boot', async (_request, reply) => {
    if (db === null) {
      return reply.code(503).send({ code: 'WRITER_BOOT_UNAVAILABLE', message: 'the writer-state store is not attached' });
    }
    markWriterBoot(db, ulid());
    return { ok: true, data: { marked: true } };
  });
}
