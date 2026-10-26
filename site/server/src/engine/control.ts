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

import { validateIntent } from '@book/shared';

import { tokenMatches } from '../util/secret.ts';
import { isEngineError } from './types.ts';
import type { Engine } from './service.ts';

export type ControlOptions = {
  engine: Engine;
  token: string;
  logger?: boolean;
  version?: string;
  /**
   * The chapter's own words, injected by the process that owns the manuscript (§12.3). The
   * enqueue path validates the reader's intent before it can become a change; without the
   * projection (a cold database) the vocabulary is empty and the new-entity rule is skipped.
   */
  vocabulary?: (chapter: number) => readonly string[];
};

const session = z.string().min(1).max(64);
const id = z.string().min(1).max(80);

const nextBody = z
  .object({
    for: z.enum(['fwd', 'bwd']).optional(),
    role: z.enum(['editor', 'consultant']).optional(),
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

const landBody = z.object({
  leaseId: id,
  noWrite: z.boolean().optional(),
  rev: z.number().int().min(0).max(1_000_000).optional(),
});

const verdictBody = z.object({
  stepId: id,
  role: z.enum(['editor', 'consultant']),
  session,
  verdict: z.enum(['HOLDS', 'GAP']),
  findings: z.unknown().optional(),
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
});

const seenBody = z.object({ leaseId: id, note: z.string().max(400).optional() });
const escalateBody = z.object({ leaseId: id, because: z.string().min(1).max(400) });
const beatBody = z.object({ leaseId: id });
const traceBody = z.object({ id });
const nothing = z.object({}).optional();

const reconcileBody = z.object({
  chapter: z.number().int().min(1).max(67).optional(),
  because: z.string().max(200).optional(),
  actor: z.string().max(40).optional(),
});

const enqueueBody = z.object({
  kind: z.enum(['reader_edit', 'accepted_comment', 'continuity', 'operator']),
  chapter: z.number().int().min(1).max(67),
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
  app.post('/internal/start', async (request) => {
    const body = startBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.start(body.leaseId, { decision: body.decision, reason: body.reason, intent: body.intent }) };
  });
  app.post('/internal/land', async (request) => {
    const body = landBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.land(body.leaseId, { noWrite: body.noWrite, rev: body.rev }) };
  });
  app.post('/internal/verdict', async (request) => {
    const body = verdictBody.parse(request.body ?? {});
    return {
      ok: true,
      data: options.engine.verdict(body.stepId, {
        role: body.role,
        session: body.session,
        verdict: body.verdict,
        findings: body.findings,
        model: body.model ?? 'stub',
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
        model: body.model,
        tokensIn: body.tokensIn,
        tokensOut: body.tokensOut,
      }),
    };
  });
  app.post('/internal/seen', async (request) => {
    const body = seenBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.seen(body.leaseId, body.note ?? null) };
  });
  app.post('/internal/escalate', async (request) => {
    const body = escalateBody.parse(request.body ?? {});
    return { ok: true, data: options.engine.escalate(body.leaseId, body.because) };
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
    // §12.3: the intent is the second injection surface — it reaches a writer prompt. The
    // same schema the CLI and the decisions tailer use runs here, before the row exists, and
    // it refuses the frozen ending for a reader-driven change (ADR-024).
    const verdict = validateIntent(body.intent, body.chapter, {
      ...(options.vocabulary === undefined ? {} : { vocabulary: options.vocabulary(body.chapter) }),
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
    request.log.error({ err: error }, 'engine request failed');
    return reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
  });

  return app;
}
