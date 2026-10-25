/**
 * `GET /api/comments`, `GET /api/comments/:id`, `POST /api/comments` (ARCHITECTURE.md §9,
 * §12.1, §12.8, §14).
 *
 * Reading is public; writing needs a Yandex session. The author is taken from the session,
 * never from the body, so nobody can post under another reader's name. Every failure is the
 * uniform `{code, message, retryAfterMs?}` shape, with a Russian message the composer can
 * show as-is.
 */

import type { CommentPage, PostCommentInput } from '@book/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { CommentService } from '../../comments/service.ts';
import { listCommentRows, readCommentRow, toCommentDto } from '../../comments/repo.ts';
import { parseCookies } from '../../util/cookies.ts';
import { clientIp, ipKey } from '../../util/ip.ts';
import { SESSION_COOKIE } from '../../identity/session.ts';
import { checkMutation } from '../origin.ts';
import type { RouteDeps } from '../deps.ts';

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'INVALID', message });
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

/**
 * A query string is text: `8abc` and `8.9` must be refused, not truncated to 8 (which is
 * what `parseInt` does). Only a decimal literal is a number here.
 */
function queryInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return null;
  return integer(Number(value), min, max);
}

/** A cursor is a comment id: `cmt_` then 26 characters of the ULID alphabet (no I, L, O, U). */
const COMMENT_ID = /^cmt_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

export function registerCommentRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const service = new CommentService({
    db: deps.db,
    config: deps.config,
    limiter: deps.limiter,
    captcha: deps.captcha,
    now: deps.now,
    ipHash: deps.ipHash,
    ...(deps.emit === undefined ? {} : { emit: (type, data) => deps.emit?.(type, data) }),
  });

  app.get('/api/comments', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    let chapter: number | undefined;
    if (query.chapter !== undefined) {
      const parsed = queryInteger(query.chapter, 1, 67);
      if (parsed === null) return invalid(reply, 'chapter must be 1..67');
      chapter = parsed;
    }
    let limit = 20;
    if (query.limit !== undefined) {
      const parsed = queryInteger(query.limit, 1, 50);
      if (parsed === null) return invalid(reply, 'limit must be 1..50');
      limit = parsed;
    }
    let before: string | undefined;
    if (query.before !== undefined && query.before !== '') {
      if (typeof query.before !== 'string' || !COMMENT_ID.test(query.before)) {
        return invalid(reply, 'before must be a comment id');
      }
      before = query.before;
    }
    const rows = listCommentRows(deps.db, { limit, ...(chapter === undefined ? {} : { chapter }), ...(before === undefined ? {} : { before }) });
    const page: CommentPage = {
      items: rows.map((row) => toCommentDto(deps.db, row)),
      nextBefore: rows.length === limit && rows[0] !== undefined ? rows[0].id : null,
    };
    return reply.header('cache-control', 'no-store').send(page);
  });

  app.get('/api/comments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = readCommentRow(deps.db, id);
    if (row === undefined || row.status === 'hidden') {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such comment' });
    }
    return reply.header('cache-control', 'no-store').send(toCommentDto(deps.db, row));
  });

  app.post('/api/comments', async (request, reply) => {
    const guard = checkMutation(request, deps.config.publicOrigin);
    if (guard !== 'ok') {
      return reply.code(403).send({
        code: guard,
        message: guard === 'ORIGIN' ? 'запрос с чужого источника отклонён' : 'нужен application/json',
      });
    }

    const session = deps.sessions.read(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (session === null) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'войдите через Яндекс, чтобы оставить замечание' });
    }

    const parsed = parsePostBody(request);
    if ('error' in parsed) return reply.code(400).send({ code: 'INVALID', message: parsed.error });

    const trusted = deps.config.trustedProxies.split(',').map((part) => part.trim());
    const peer = request.socket.remoteAddress ?? request.ip;
    const ip = clientIp(request.headers as Record<string, string | string[] | undefined>, peer, trusted);

    const result = await service.post(parsed.input, {
      identity: session.identity,
      ip,
      ipKey: ipKey(ip),
    });
    if (result.ok === false) {
      if (result.retryAfterMs !== undefined) {
        reply.header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      }
      return reply.code(result.status).send({
        code: result.code,
        message: result.message,
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        ...(result.resetAt === undefined ? {} : { resetAt: result.resetAt }),
        ...(result.currentText === undefined ? {} : { currentText: result.currentText }),
      });
    }
    return reply.code(result.status).header('cache-control', 'no-store').send(result.body);
  });
}

function parsePostBody(
  request: FastifyRequest,
): { input: PostCommentInput } | { error: string } {
  const body = request.body;
  if (body === null || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const value = body as Record<string, unknown>;

  const chapter = integer(value.chapter, 1, 67);
  if (chapter === null) return { error: 'chapter must be 1..67' };
  if (typeof value.body !== 'string') return { error: 'body must be a string' };
  if (typeof value.captchaToken !== 'string') return { error: 'captchaToken must be a string' };

  const input: PostCommentInput = {
    chapter,
    body: value.body,
    captchaToken: value.captchaToken,
  };
  if (typeof value.blockId === 'string') input.blockId = value.blockId;
  if (typeof value.quote === 'string') input.quote = value.quote;
  if (typeof value.prefix === 'string') input.prefix = value.prefix;
  if (typeof value.suffix === 'string') input.suffix = value.suffix;
  if (typeof value.baseRev === 'number' && Number.isInteger(value.baseRev)) input.baseRev = value.baseRev;
  if (typeof value.proposedText === 'string') input.proposedText = value.proposedText;
  if (typeof value.idempotencyKey === 'string' && value.idempotencyKey.length <= 100) {
    input.idempotencyKey = value.idempotencyKey;
  }
  return { input };
}
