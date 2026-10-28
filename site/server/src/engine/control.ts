/**
 * The engine's internal API (ARCHITECTURE.md §4.2, §6A.11): loopback/compose only, bearer
 * token, never proxied by Caddy.
 *
 * It is a thin adapter over `createEngine`: every route validates its shape, calls one
 * method, and returns the same object the CLI prints. A refusal is a stable `code` plus an
 * HTTP status, never a stack trace — the session loop branches on the code.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { TOTAL_CHAPTERS, validateIntent, validateInterventionKind } from '@book/shared';

import { tokenMatches } from '../util/secret.ts';
import type { Db } from '../db/db.ts';
import { appendStage, resolvePass, StageInputError } from '../stages/repo.ts';
import { isEngineError } from './types.ts';
import type { Engine } from './service.ts';

/** `DB_BUSY` | `SCHEMA_MISMATCH` for a `better-sqlite3` error, `null` for anything else. */
function databaseFailure(error: unknown): { code: string; status: number; message: string } | null {
  const message = error instanceof Error ? error.message : '';
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'SQLITE_BUSY' || /database is locked|database table is locked/u.test(message)) {
    return { code: 'DB_BUSY', status: 503, message: 'база занята другим запросом — повторите' };
  }
  if (code.startsWith('SQLITE_') || /no such column|no such table/u.test(message)) {
    return { code: 'SCHEMA_MISMATCH', status: 500, message: 'схема базы не совпадает с кодом — нужна миграция' };
  }
  return null;
}

export type ControlOptions = {
  engine: Engine;
  token: string;
  logger?: boolean;
  version?: string;
  /**
   * The stage store (`docs/writer-lane.md §3`). The engine process owns the same database the
   * site reads, so `/internal/stage` writes there; a control app built without it (a REST-only
   * test) refuses the route instead of pretending the stage was stored.
   */
  db?: Db;
  /**
   * The chapter's own words, injected by the process that owns the manuscript (§12.3). The
   * enqueue path validates the reader's intent before it can become a change; without the
   * projection (a cold database) the vocabulary is empty and the new-entity rule is skipped.
   */
  vocabulary?: (chapter: number) => readonly string[];
};

const session = z.string().min(1).max(64);
const id = z.string().min(1).max(80);

/**
 * BOOK-187: the text now travels in the body, so one route needs more room than Fastify's 64 KB
 * default. A chapter is at most `CHAPTER_CHARS.max` (30 000) characters and 60 000 is the door's
 * own bound; in UTF-8 that is under 240 KB, and a quarter of a megabyte is the whole envelope.
 */
const TEXT_CHARS_MAX = 60_000;
const LAND_BODY_LIMIT = 512 * 1024;
/** The most chapters one `/internal/text` call may ask for: the chapter, its two neighbours, and room. */
const TEXT_CHAPTERS_MAX = 8;

const nextBody = z
  .object({
    for: z.enum(['fwd', 'bwd', 'filing']).optional(),
    // BOOK-61: `rights` is Gate B, offered only for a step whose scan flagged.
    role: z.enum(['editor', 'consultant', 'rights']).optional(),
    session,
  })
  .refine((value) => (value.for === undefined) !== (value.role === undefined), {
    message: 'exactly one of for|role is required',
  });

const startBody = z.object({
  leaseId: id,
  decision: z.enum(['adapt', 'drop', 'void']).optional(),
  reason: z.string().max(500).optional(),
  intent: z.string().max(600).optional(),
});

/** BOOK-117 §4: a first pass for one named chapter, because a lane only offers its own next slot. */
const passBody = z.object({ chapter: z.number().int().min(1).max(TOTAL_CHAPTERS), session });

const landBody = z.object({
  leaseId: id,
  /** The writer's own text: the engine never reads a manuscript file (BOOK-187). */
  text: z.string().max(TEXT_CHARS_MAX).optional(),
  /** The first sheet's whole text, for a `front` step. */
  frontRaw: z.string().max(TEXT_CHARS_MAX).optional(),
  noWrite: z.boolean().optional(),
  rev: z.number().int().min(0).max(1_000_000).optional(),
});

/** The chapters a prompt may quote, by number: 1..8 of them, each a real chapter. */
const textBody = z.object({
  chapters: z.array(z.number().int().min(1).max(TOTAL_CHAPTERS)).min(1).max(TEXT_CHAPTERS_MAX),
});

/** `--revert`: the revision to bring back; omitted means the one before the current. */
const restoreBody = z.object({
  chapter: z.number().int().min(1).max(TOTAL_CHAPTERS),
  rev: z.number().int().min(0).max(1_000_000).optional(),
});

const verdictBody = z.object({
  stepId: id,
  // BOOK-61: Gate B answers CLEAR/REFUSED on the same row the two prose roles answer
  // HOLDS/GAP; the pair is read together below, and a mismatched pair is refused.
  role: z.enum(['editor', 'consultant', 'rights']),
  session,
  verdict: z.enum(['HOLDS', 'GAP', 'CLEAR', 'REFUSED']),
  rule: z.string().max(40).nullish(),
  findings: z.unknown().optional(),
  /**
   * ADR-038: a **shape** check only. `max(120)` bounds what a session can store; whether the
   * model is present and whether it is the pipeline's is the engine's rule, so the CLI, this
   * route and a direct caller refuse with the same code (`MODEL_REQUIRED`).
   */
  model: z.string().max(120).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
});

const doneBody = z.object({
  leaseId: id,
  seams: z.unknown().optional(),
  note: z.string().max(400).optional(),
  model: z.string().max(120).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  /** BOOK-117: `operator` closes on the model that answered; the default is the pinned lane. */
  provenance: z.enum(['pipeline', 'operator']).optional(),
});

/** BOOK-62: `seen` closes a prose step too, so it carries the same model and token fields. */
const seenBody = z.object({
  leaseId: id,
  note: z.string().max(400).optional(),
  model: z.string().max(120).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
});
/**
 * An escalation names no model of its own (ADR-038 §2): a caller that burned tokens reports them,
 * and one that claims nothing keeps the null/0 default. The triple is the same shape `done` takes.
 * BOOK-117 adds `cause`: a broken pass is not a refusal of the reader's intervention.
 */
const escalateBody = z.object({
  leaseId: id,
  because: z.string().min(1).max(400),
  model: z.string().max(120).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  /** `failed` when the pass broke rather than refused the work; a broken pass is not a refusal. */
  cause: z.enum(['refused', 'failed']).optional(),
});
const reopenBody = z.object({ stepId: id, because: z.string().max(200).optional() });
const beatBody = z.object({ leaseId: id });
const traceBody = z.object({ id });
const nothing = z.object({}).optional();

const reconcileBody = z.object({
  chapter: z.number().int().min(1).max(TOTAL_CHAPTERS).optional(),
  because: z.string().max(200).optional(),
  actor: z.string().max(40).optional(),
});

const enqueueBody = z.object({
  kind: z.enum(['reader_edit', 'accepted_comment', 'continuity', 'operator']),
  chapter: z.number().int().min(1).max(TOTAL_CHAPTERS),
  intent: z.string().min(1).max(600),
  anchor: z
    .object({
      blockIds: z.array(z.string()).max(8),
      quote: z.string().max(280),
      prefix: z.string().max(40),
      suffix: z.string().max(40),
    })
    .nullish(),
  proposedText: z.string().nullish(),
  scopeHint: z.enum(['phrase', 'chapter']).optional(),
  commentId: z.string().max(80).nullish(),
  sessionId: z.string().max(64).nullish(),
});

/**
 * A lane stage (`docs/writer-lane.md §2`). The shape is checked here; the vocabulary, the
 * summary/span bounds and the `truncated` flag are `stage.ts`'s job, so the door and the
 * store cannot drift. `chapter` and `changeId` are not in the body: they are the step's.
 */
const stageBody = z.object({
  passId: id,
  stageSeq: z.number().int().min(1).max(1_000_000).nullish(),
  stage: z.string().min(1).max(32),
  at: z.number().int().min(0),
  actor: z.object({ process: z.string().min(1).max(32), model: z.string().max(120).nullish() }),
  summary: z.string().min(1).max(4_000),
  span: z
    .array(
      z.object({
        blockId: z.string().max(120).nullish(),
        before: z.string().max(20_000),
        after: z.string().max(20_000),
        truncated: z.boolean().optional(),
      }),
    )
    .max(64)
    .nullish(),
  tokens: z.object({ in: z.number().int().min(0), out: z.number().int().min(0) }).nullish(),
  costUsd: z.number().min(0).max(1_000_000).nullish(),
});

/**
 * `authorization: Bearer <token>` is required on every route, including health. The health
 * check in the compose file already sends it; a loopback port is not an access control.
 */
export async function buildControl(options: ControlOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    // Constant-time, length-hiding (audit m6): `===` would leak the token's prefix.
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (options.token.length === 0 || !tokenMatches(options.token, presented)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'internal API: bearer token required' });
    }
    return undefined;
  });

  app.get('/internal/health', async () => ({
    ok: true,
    version: options.version ?? '0.0.0',
    state: options.engine.state(),
  }));

  app.get('/internal/state', async () => ({ ok: true, data: options.engine.state() }));

  app.post('/internal/next', async (request) => {
    const body = nextBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.next(body) };
  });
  app.post('/internal/pass', async (request) => {
    const body = passBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.openChapterPass(body.chapter, body.session) };
  });
  app.post('/internal/start', async (request) => {
    const body = startBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.start(body.leaseId, { decision: body.decision, reason: body.reason, intent: body.intent }) };
  });
  app.post('/internal/land', { bodyLimit: LAND_BODY_LIMIT }, async (request) => {
    const body = landBody.parse(request.body ?? {});
    return {
      ok: true,
      data: options.engine.land(body.leaseId, {
        text: body.text,
        frontRaw: body.frontRaw,
        noWrite: body.noWrite,
        rev: body.rev,
      }),
    };
  });
  /**
   * BOOK-187: the text a prompt may quote, **from rows only** — the chapter the writer is on, its
   * neighbours, and the landed text a gate judges. The body is canonical and carries no title
   * line; the prompt prints the title itself.
   */
  app.post('/internal/text', async (request) => {
    const body = textBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.text(body.chapters) };
  });
  /**
   * BOOK-187 / ADR-043 §3 row 9: `--revert` is a **new** revision (`cause_kind = 'restore'`)
   * published through the applier, never a file put back.
   */
  app.post('/internal/restore', async (request) => {
    const body = restoreBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.restore({ chapter: body.chapter, rev: body.rev }) };
  });
  app.post('/internal/verdict', async (request, reply) => {
    const body = verdictBody.parse(request.body ?? {});
    if (body.role === 'rights') {
      if (body.verdict !== 'CLEAR' && body.verdict !== 'REFUSED') {
        return reply.code(422).send({ code: 'INVALID_VERDICT', message: 'a rights verdict is CLEAR|REFUSED' });
      }
      return {
        ok: true,
        data: options.engine.verdictRights(body.stepId, {
          role: 'rights',
          session: body.session,
          verdict: body.verdict,
          rule: body.rule ?? null,
          model: body.model ?? 'stub',
          tokensIn: body.tokensIn ?? 0,
          tokensOut: body.tokensOut ?? 0,
        }),
      };
    }
    if (body.verdict !== 'HOLDS' && body.verdict !== 'GAP') {
      return reply.code(422).send({ code: 'INVALID_VERDICT', message: 'a prose verdict is HOLDS|GAP' });
    }
    return {
      ok: true,
      data: options.engine.verdict(body.stepId, {
        role: body.role,
        session: body.session,
        verdict: body.verdict,
        findings: body.findings,
        model: body.model ?? '',
        tokensIn: body.tokensIn ?? 0,
        tokensOut: body.tokensOut ?? 0,
      }),
    };
  });
  app.post('/internal/done', async (request) => {
    const body = doneBody.parse(request.body ?? {});
    return {
      ok: true,
      data: options.engine.done(body.leaseId, {
        seams: body.seams ?? [],
        note: body.note,
        model: body.model ?? '',
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
        provenance: body.provenance,
      }),
    };
  });
  app.post('/internal/seen', async (request) => {
    const body = seenBody.parse(request.body ?? {});
    return {
      ok: true,
      data: options.engine.seen(body.leaseId, body.note ?? null, {
        model: body.model ?? '',
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
      }),
    };
  });
  app.post('/internal/escalate', async (request) => {
    const body = escalateBody.parse(request.body ?? {});
    return {
      ok: true,
      data: options.engine.escalate(body.leaseId, body.because, {
        model: body.model,
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
        cause: body.cause,
      }),
    };
  });
  /** BOOK-117: reopen a landed, escalated step so the gates it now satisfies can close it. */
  app.post('/internal/reopen', async (request) => {
    const body = reopenBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.reopen(body.stepId, body.because ?? '') };
  });
  app.post('/internal/beat', async (request) => {
    const body = beatBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.beat(body.leaseId) };
  });
  app.post('/internal/beat-all', async (request) => {
    nothing.parse(request.body ?? {});
    options.engine.heartbeat();
    return { ok: true, data: options.engine.state() };
  });
  app.post('/internal/trace', async (request) => {
    const body = traceBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.trace(body.id) };
  });
  /**
   * §13.3: with a `chapter` this is the mark on a restore (re-runs the validator and records
   * the operator's reason); without one it is the maintenance pass over the engine's leases.
   */
  app.post('/internal/reconcile', async (request) => {
    const body = reconcileBody.parse(request.body ?? {});
    if (body.chapter === undefined) return { ok: true, data: options.engine.reconcile() };
    return {
      ok: true,
      data: options.engine.reconcileRestore({
        chapter: body.chapter,
        because: body.because ?? '',
        ...(body.actor === undefined ? {} : { actor: body.actor }),
      }),
    };
  });
  app.post('/internal/changes', async (request, reply) => {
    const body = enqueueBody.parse(request.body ?? {});
    // BOOK-9: `feedback/accept.ts` is the only creator of `accepted_comment` — it writes the
    // change and links the comment to it in one transaction. A change minted here would leave
    // the comment "not accepted" and allow a second change for the same intervention.
    if (body.kind === 'accepted_comment') {
      return reply.code(422).send({
        code: 'ACCEPTED_COMMENT_RESERVED',
        message: 'принятое замечание ставит в очередь триаж, а не этот маршрут',
      });
    }
    // BOOK-16: an intent that names a comment is judged as the kind that comment carries —
    // the same column `queue.ts` copies into the change. An unknown stored kind is refused
    // with a code here, never dropped to "no kind" and accepted.
    const stored =
      body.commentId === null || body.commentId === undefined
        ? null
        : options.engine.commentKind(body.commentId);
    const kindCheck = stored === null ? null : validateInterventionKind(stored);
    if (kindCheck !== null && !kindCheck.ok) {
      return reply.code(422).send({ code: kindCheck.code, message: kindCheck.reason });
    }
    // §12.3: the intent is the second injection surface — it reaches a writer prompt. The
    // same schema the CLI and the decisions tailer use runs here, before the row exists, and
    // it refuses the frozen ending for a reader-driven change (ADR-024).
    const verdict = validateIntent(body.intent, body.chapter, {
      ...(options.vocabulary === undefined ? {} : { vocabulary: options.vocabulary(body.chapter) }),
      kind: kindCheck === null ? null : kindCheck.kind,
    });
    if (!verdict.ok) {
      // 422 for every schema refusal, and the code is the verdict's — the session loop
      // branches on `code`, not on the status.
      return reply.code(422).send({ code: verdict.code, message: verdict.reason });
    }
    return {
      ok: true,
      data: options.engine.enqueue({
        kind: body.kind,
        chapter: body.chapter,
        intent: verdict.intent,
        anchor: body.anchor ?? null,
        proposedText: body.proposedText ?? null,
        scopeHint: body.scopeHint,
        commentId: body.commentId ?? null,
        sessionId: body.sessionId ?? null,
      }),
    };
  });

  /**
   * `docs/writer-lane.md §3`: the only write door for a lane stage. The chapter is read from
   * the step named by `passId`, never from the body; an omitted `stageSeq` is the store's
   * assignment, and a repeated `(passId, stageSeq)` returns the stored row.
   */
  app.post('/internal/stage', async (request, reply) => {
    const body = stageBody.parse(request.body ?? {});
    if (options.db === undefined) {
      return reply.code(503).send({ code: 'STAGES_UNAVAILABLE', message: 'the stage store is not attached' });
    }
    const pass = resolvePass(options.db, body.passId);
    if (pass === null) {
      return reply.code(422).send({ code: 'UNKNOWN_PASS', message: 'no step carries this pass id' });
    }
    try {
      return { ok: true, data: appendStage(options.db, { ...body, chapter: pass.chapter, changeId: pass.changeId }) };
    } catch (error) {
      if (error instanceof StageInputError) {
        return reply.code(422).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        code: 'INVALID',
        message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      });
    }
    if (isEngineError(error)) {
      return reply.code(error.status).send({ code: error.code, message: error.message, detail: error.detail });
    }
    // BOOK-145: a database error is not a caller's mistake, and a bare INTERNAL hid two real
    // faults in prod («database is locked» on a stage, «no such column» on a close). Each gets a
    // code an operator can act on: `DB_BUSY` is retryable, `SCHEMA_MISMATCH` means the binary and
    // the file disagree and a migration is owed.
    request.log.error({ err: error }, 'engine request failed');
    const db = databaseFailure(error);
    if (db !== null) return reply.code(db.status).send({ code: db.code, message: db.message });
    return reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
  });

  return app;
}
