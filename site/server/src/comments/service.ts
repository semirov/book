/**
 * Posting a comment (ARCHITECTURE.md §12.1, §12.4, §12.5, §12.8, §14, §9).
 *
 * The order is the security design and must not be rearranged:
 *   identity → idempotent replay → queue backpressure → CAPTCHA → sanitize → dedupe →
 *   anchor → guard → rate slots → store → broadcast.
 *
 * A failed CAPTCHA consumes **no** rate slot and stores nothing (§12.8); a duplicate is
 * refused before it counts; a guard verdict is stored and shown, never silently dropped.
 * An idempotent replay is answered from the stored row even when it raced us at the one
 * await in this path: the UNIQUE index on `idem_key` is the serialisation point, never a 500.
 * The service never builds a prompt and never calls a model.
 */

import {
  COMMENT_DEDUPE_WINDOW_MS,
  COMMENT_MAX_CHARS,
  COMMENT_RAW_MAX_BYTES,
  EDIT_MAX_CHARS,
  EDIT_RAW_MAX_BYTES,
  type CommentAnchor,
  type CommentBudget,
  type PostCommentInput,
  type PostCommentResponse,
} from '@book/shared';

import type { CaptchaVerifier } from '../captcha/verify.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { IdentityRow } from '../db/repo/identities.ts';
import { sha256Hex } from '../util/hash.ts';
import { newCommentId } from '../util/ulid.ts';
import { classifyComment } from './guard.ts';
import {
  appendCommentEvent,
  findDuplicate,
  insertComment,
  readBlock,
  readChapterBase,
  readCommentRow,
  readCommentRowByIdemKey,
  toCommentDto,
  type CommentRow,
} from './repo.ts';
import { sanitizeAffix, sanitizeAuthor, sanitizeBody, sanitizeProposed, sanitizeQuote } from './sanitize.ts';
import type { RateLimiter } from '../rate/limiter.ts';
import { commentIdentityKey, commentSpecs, editIdentityKey, editSpecs } from '../rate/policy.ts';

export type CommentServiceDeps = {
  db: Db;
  config: Config;
  limiter: RateLimiter;
  captcha: CaptchaVerifier;
  now?: () => Date;
  ipHash?: (ipKey: string) => string;
  emit?: (type: 'comment:added', data: unknown) => void;
  idFactory?: (nowMs: number) => string;
};

export type PostContext = { identity: IdentityRow; ip: string; ipKey: string };

export type ServiceFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  retryAfterMs?: number;
  resetAt?: string;
  currentText?: string;
};

export type ServiceResult = { ok: true; status: number; body: PostCommentResponse } | ServiceFailure;

const QUEUE_RETRY_FALLBACK_MS = 15 * 60_000;

export class CommentService {
  private readonly db: Db;
  private readonly config: Config;
  private readonly limiter: RateLimiter;
  private readonly captcha: CaptchaVerifier;
  private readonly now: () => Date;
  private readonly ipHash: (ipKey: string) => string;
  private readonly emit: ((type: 'comment:added', data: unknown) => void) | undefined;
  private readonly idFactory: (nowMs: number) => string;

  constructor(deps: CommentServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.limiter = deps.limiter;
    this.captcha = deps.captcha;
    this.now = deps.now ?? (() => new Date());
    this.ipHash = deps.ipHash ?? ((ipKey: string) => sha256Hex(ipKey));
    this.emit = deps.emit;
    this.idFactory = deps.idFactory ?? newCommentId;
  }

  /** §14: the composer shows what is left, so the limit is never a surprise. */
  budget(identityId: string): CommentBudget {
    const comments = this.limiter.check({
      key: commentIdentityKey(identityId),
      limit: this.config.commentsPerHourIdentity,
      windowMs: 60 * 60_000,
    });
    const edits = this.limiter.check({
      key: editIdentityKey(identityId),
      limit: this.config.editSubmissionsPerDay,
      windowMs: 24 * 60 * 60_000,
    });
    return {
      perHour: comments.limit,
      remaining: comments.remaining,
      resetAt: comments.resetAtMs === null ? null : new Date(comments.resetAtMs).toISOString(),
      editsPerDay: edits.limit,
      editsRemaining: edits.remaining,
      editsResetAt: edits.resetAtMs === null ? null : new Date(edits.resetAtMs).toISOString(),
    };
  }

  async post(input: PostCommentInput, context: PostContext): Promise<ServiceResult> {
    const now = this.now();
    const at = now.toISOString();

    if (context.identity.blocked !== 0) {
      return fail(403, 'BLOCKED', 'замечания от этого автора не принимаются');
    }
    // Chapter 67 is frozen against reader-driven changes (§6C.4, ADR-024).
    if (isPresent(input.proposedText) && input.chapter === 67) {
      return fail(403, 'ENDING_FROZEN', 'финал заморожен: правка читателя в главу 67 не входит');
    }

    // Idempotent replay: the same key returns the first result, never a second comment.
    const replay = this.replay(input, context.identity.id);
    if (replay !== null) return replay;

    const queue = this.queueState();
    if (queue.full) {
      return {
        ok: false,
        status: 503,
        code: 'QUEUE_FULL',
        message: 'очередь правок заполнена — попробуйте позже',
        retryAfterMs: queue.retryAfterMs,
      };
    }

    // CAPTCHA first, before anything is stored and before any slot is consumed (§12.8).
    const captcha = await this.captcha(input.captchaToken, { ip: context.ip });
    if (!captcha.ok) {
      if (captcha.code === 'CAPTCHA_UNAVAILABLE') {
        return {
          ok: false,
          status: 503,
          code: 'CAPTCHA_UNAVAILABLE',
          message: captcha.message,
          retryAfterMs: this.config.captchaTimeoutMs,
        };
      }
      return { ok: false, status: 403, code: 'CAPTCHA_FAILED', message: captcha.message };
    }

    // The CAPTCHA call is the one await before the write, so a second request with the same
    // key can land while this one waits: the checks below re-read the store instead of
    // trusting the snapshot taken above.

    if (typeof input.body !== 'string') return fail(422, 'INVALID', 'нужен текст замечания');
    if (Buffer.byteLength(input.body, 'utf8') > COMMENT_RAW_MAX_BYTES) {
      return fail(422, 'TOO_LONG', `замечание длиннее ${COMMENT_MAX_CHARS} символов`);
    }
    const body = sanitizeBody(input.body);
    if (!body.ok) return fail(422, body.code, body.message);

    let proposedText: string | null = null;
    if (isPresent(input.proposedText)) {
      // Bytes first: a 10 000-character intervention in Cyrillic is 20 000 B, and the raw
      // bound is sized so the promise the composer shows is the one the server keeps.
      if (Buffer.byteLength(input.proposedText, 'utf8') > EDIT_RAW_MAX_BYTES) {
        return fail(422, 'TOO_LONG', `правка длиннее ${EDIT_MAX_CHARS} символов`);
      }
      const proposed = sanitizeProposed(input.proposedText);
      if (proposed === null || !proposed.ok) {
        return fail(422, proposed === null ? 'INVALID' : proposed.code, proposed?.message ?? 'предложенная правка пустая');
      }
      proposedText = proposed.text;
    }

    const duplicate = findDuplicate(
      this.db,
      context.identity.id,
      body.hash,
      new Date(now.getTime() - COMMENT_DEDUPE_WINDOW_MS).toISOString(),
    );
    if (duplicate !== undefined) {
      // The same key means the same submission: a replay that overlapped us at the CAPTCHA
      // await is answered with the first result, not with a duplicate verdict.
      if (isPresent(input.idempotencyKey) && duplicate.idem_key === input.idempotencyKey) {
        const replayed = this.replay(input, context.identity.id);
        if (replayed !== null) return replayed;
      }
      return fail(409, 'DUPLICATE', 'такое замечание уже отправлено');
    }

    const anchor = this.resolveAnchor(input);
    if (anchor.ok === false) return anchor.failure;

    const guard = classifyComment(body.text, proposedText);
    const specs = [
      ...commentSpecs(this.config, this.ipHash, context.ipKey, context.identity.id),
      ...(proposedText === null ? [] : editSpecs(this.config, context.identity.id)),
    ];
    const consumed = this.limiter.consume(specs);
    if (!consumed.allowed) {
      const blocked = consumed.blocked;
      const resetAt = blocked.resetAtMs === null ? undefined : new Date(blocked.resetAtMs).toISOString();
      if (blocked.key.startsWith('edit:id:')) {
        return {
          ok: false,
          status: 429,
          code: 'EDIT_DAILY_LIMIT',
          message: 'правка уже была сегодня — одна правка в сутки на читателя',
          retryAfterMs: blocked.retryAfterMs,
          ...(resetAt === undefined ? {} : { resetAt }),
        };
      }
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        message: 'слишком много замечаний — попробуйте позже',
        retryAfterMs: blocked.retryAfterMs,
        ...(resetAt === undefined ? {} : { resetAt }),
      };
    }

    const id = this.idFactory(now.getTime());
    try {
      insertComment(this.db, {
        id,
        identityId: context.identity.id,
        chapter: input.chapter,
        blockId: anchor.anchor.blockId,
        blockIndex: anchor.anchor.blockIndex,
        baseRev: input.baseRev ?? anchor.baseRev,
        quote: anchor.anchor.quote,
        prefix: anchor.anchor.prefix,
        suffix: anchor.anchor.suffix,
        author: sanitizeAuthor(context.identity.display_name),
        body: body.text,
        proposedText,
        bodySha: body.hash,
        flags: guard.flags,
        ipHash: this.ipHash(context.ipKey),
        status: guard.status,
        guard: guard.guard,
        reason: guard.reason,
        createdAt: at,
        idemKey: input.idempotencyKey ?? null,
      });
    } catch (error) {
      // Backstop for a replay that still raced us: the UNIQUE index on `idem_key` is the
      // real serialisation point, so the loser reads the winner's row instead of a 500.
      const raced = isUniqueViolation(error) ? this.replay(input, context.identity.id) : null;
      if (raced === null) throw error;
      return raced;
    }
    appendCommentEvent(this.db, id, 'posted', at, { status: guard.status, flags: guard.flags });
    if (guard.status === 'quarantined') {
      appendCommentEvent(this.db, id, 'quarantined', at, { reason: guard.reason });
    }

    const row = readCommentRow(this.db, id);
    if (row === undefined) return fail(500, 'INTERNAL', 'замечание не сохранилось');
    const dto = toCommentDto(this.db, row);
    this.emit?.('comment:added', {
      id: dto.id,
      chapter: dto.chapter,
      anchor: dto.anchor,
      author: dto.author,
      authorColor: dto.authorColor,
      body: dto.body,
      status: dto.status,
      reason: dto.reason,
      createdAt: dto.createdAt,
    });
    return { ok: true, status: 201, body: { comment: dto, remaining: this.budget(context.identity.id), queue: { depth: this.queueState().depth } } };
  }

  /** The soft cap is global, not per identity: it protects the lane, not a person (§14). */
  queueState(): { depth: number; full: boolean; retryAfterMs: number } {
    const depth = (this.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'pending'`).get() as {
      n: number;
    }).n;
    return {
      depth,
      full: depth >= this.config.queueSoftCap,
      retryAfterMs: this.medianChangeMs() ?? QUEUE_RETRY_FALLBACK_MS,
    };
  }

  private medianChangeMs(): number | null {
    const rows = this.db
      .prepare(
        `SELECT started_at, finished_at FROM changes
          WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
          ORDER BY seq DESC LIMIT 20`,
      )
      .all() as Array<{ started_at: string; finished_at: string }>;
    const durations = rows
      .map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    if (durations.length === 0) return null;
    return durations[Math.floor(durations.length / 2)] ?? null;
  }

  private response(row: CommentRow): PostCommentResponse {
    return {
      comment: toCommentDto(this.db, row),
      remaining: this.budget(row.identity_id),
      queue: { depth: this.queueState().depth },
    };
  }

  /**
   * An idempotent replay returns the first result, never a second comment. `null` means
   * there is no row for this key yet, i.e. the caller may proceed with the submission.
   */
  private replay(input: PostCommentInput, identityId: string): ServiceResult | null {
    if (!isPresent(input.idempotencyKey)) return null;
    const existing = readCommentRowByIdemKey(this.db, input.idempotencyKey);
    if (existing === undefined) return null;
    if (existing.identity_id === identityId) {
      return { ok: true, status: 201, body: this.response(existing) };
    }
    // A key is scoped to one reader; a foreign key is a collision, not a replay.
    return fail(409, 'DUPLICATE', 'такое замечание уже отправлено');
  }

  /**
   * A comment attaches to a paragraph from one revision. If that paragraph has changed,
   * the composer must be told (`STALE_ANCHOR`) rather than attach the note to the wrong
   * place (§9, §12.1).
   */
  private resolveAnchor(
    input: PostCommentInput,
  ): { ok: true; anchor: CommentAnchor; baseRev: number | null } | { ok: false; failure: ServiceFailure } {
    const base = readChapterBase(this.db, input.chapter);
    if (base === undefined) {
      return {
        ok: false,
        failure: fail(409, 'STALE_ANCHOR', 'глава ещё не написана — замечание можно оставить к главе целиком'),
      };
    }
    const quote = sanitizeQuote(input.quote);
    const blockId = isPresent(input.blockId) ? input.blockId : null;
    const baseRev = typeof input.baseRev === 'number' ? input.baseRev : null;

    if (blockId === null) {
      return {
        ok: true,
        baseRev: baseRev ?? base.rev,
        anchor: {
          blockId: null,
          blockIndex: null,
          quote: null,
          prefix: sanitizeAffix(input.prefix),
          suffix: sanitizeAffix(input.suffix),
          resolved: true,
        },
      };
    }

    const block = readBlock(this.db, blockId);
    const stale =
      block === undefined ||
      block.chapter !== input.chapter ||
      (quote !== null && !block.text.includes(quote)) ||
      (baseRev !== null && baseRev !== base.rev);
    if (stale) {
      return {
        ok: false,
        failure: {
          ok: false,
          status: 409,
          code: 'STALE_ANCHOR',
          message: 'абзац изменился — вот он сейчас, привяжите замечание заново',
          ...(block === undefined ? {} : { currentText: block.text }),
        },
      };
    }

    return {
      ok: true,
      baseRev: baseRev ?? base.rev,
      anchor: {
        blockId,
        blockIndex: block.idx,
        quote,
        prefix: sanitizeAffix(input.prefix),
        suffix: sanitizeAffix(input.suffix),
        resolved: true,
      },
    };
  }
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `idem_key` is UNIQUE; the second writer of one key hits this and must be answered with the
 * first writer's response. Anything else (another constraint, another error) still throws.
 *
 * Exported for the one check a test cannot stage through the service: the shape of the
 * driver's error. In a single process the replay above always wins the race on the same
 * event loop; this branch is what a second writer would meet.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return typeof message !== 'string' || message.includes('idem_key');
  }
  return false;
}

function fail(status: number, code: string, message: string): ServiceFailure {
  return { ok: false, status, code, message };
}
