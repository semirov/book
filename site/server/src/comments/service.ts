/**
 * Posting a comment (ARCHITECTURE.md §12.1, §12.4, §12.5, §12.8, §14, §9).
 *
 * The order is the security design and must not be rearranged:
 *   identity → idempotent replay → queue backpressure → CAPTCHA (only when a provider is
 *   configured) → sanitize → dedupe → anchor → guard (A) → rights scan (B) → attempts →
 *   budget/rate slots → store → rights write (B) → broadcast.
 *
 * Gate B's **scan** runs before the budget and its refusal spends no slot (BOOK-61 review m2);
 * its **write** is after the insert, because a verdict is a column on the row and not a field
 * of the request. The comment budget is `budget.ts` (BOOK-113).
 *
 * BOOK-158: the daily edit budget left this path. It is spent by an **accepted** filing only
 * (`feedback/cli.ts`, BOOK-DOC-4 rule 5), so a refusal costs the reader nothing; what bounds a
 * submission here is the attempt ledger (`attempts.ts`) — three tries a filing a UTC day, five
 * an identity and fifteen a network, and not one of them on the same words about the same place
 * twice in twenty-four hours. A refused submission counts there, because that is the model's
 * attention; an identical resubmission does not, because it never reaches a model at all.
 *
 * BOOK-64 (2026-10-27): the shipped gate is the authenticated identity plus the comment and
 * edit rate limits, so with `captchaProvider: 'none'` the verification step is skipped and the
 * request carries no token. The verifier stays wired for the day a challenge returns; it is
 * unused, not removed.
 *
 * A failed CAPTCHA consumes **no** rate slot and stores nothing (§12.8); a duplicate is
 * refused before it counts; a guard verdict is stored and shown, never silently dropped.
 * An idempotent replay is answered from the stored row even when it raced us at the one
 * await in this path: the UNIQUE index on `idem_key` is the serialisation point, never a 500.
 * The service never builds a prompt and never calls a model.
 */

import {
  COMMENT_DEDUPE_WINDOW_MS,
  TERMS_VERSION,
  TOO_MANY_FILINGS,
  acceptedTermsText,
  classifyFrame,
  type CommentBudget,
  type InterventionKind,
  type PostCommentInput,
  type PostCommentResponse,
} from '@book/shared';

import type { CaptchaVerifier } from '../captcha/verify.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { IdentityRow } from '../db/repo/identities.ts';
import { resolveQuoteSentence } from '../sentences/anchor.ts';
import { sha256Hex } from '../util/hash.ts';
import { newCommentId } from '../util/ulid.ts';
import {
  ATTEMPTS_PER_IDENTITY_DAY,
  ATTEMPTS_PER_NETWORK_DAY,
  anchorSha,
  identityAttemptsToday,
  networkAttemptsToday,
  recordAttempt,
  setAttemptOutcome,
  identicalAttempt,
  utcDayEnd,
} from './attempts.ts';
import { resolveAnchor } from './anchor.ts';
import { readBudget } from './budget.ts';
import { fail, isPresent, type ServiceFailure } from './failure.ts';
import { readFilingText } from './filing.ts';
import { commentAddedPayload } from './frame.ts';
import { classifyComment } from './guard.ts';
import {
  appendCommentEvent,
  findDuplicate,
  insertComment,
  readCommentRow,
  readCommentRowByIdemKey,
  toCommentDto,
  type CommentRow,
} from './repo.ts';
import { sanitizeAuthor } from './sanitize.ts';
import type { RateLimiter } from '../rate/limiter.ts';
import { commentSpecs } from '../rate/policy.ts';
import { applyRights, scanFiling } from '../rights/apply.ts';
import { emitFilingUpdate } from '../feedback/filingFrame.ts';
import { filingStateOf } from './filingState.ts';

export type CommentServiceDeps = {
  db: Db;
  config: Config;
  limiter: RateLimiter;
  captcha: CaptchaVerifier;
  now?: () => Date;
  ipHash?: (ipKey: string) => string;
  emit?: (type: 'comment:added' | 'filing:update', data: unknown) => void;
  idFactory?: (nowMs: number) => string;
};

export type PostContext = { identity: IdentityRow; ip: string; ipKey: string };

export type { ServiceFailure } from './failure.ts';

export type ServiceResult = { ok: true; status: number; body: PostCommentResponse } | ServiceFailure;

const QUEUE_RETRY_FALLBACK_MS = 15 * 60_000;

export class CommentService {
  private readonly db: Db;
  private readonly config: Config;
  private readonly limiter: RateLimiter;
  private readonly captcha: CaptchaVerifier;
  private readonly now: () => Date;
  private readonly ipHash: (ipKey: string) => string;
  private readonly emit: ((type: 'comment:added' | 'filing:update', data: unknown) => void) | undefined;
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

  /**
   * §14: the composer shows what is left, so the limit is never a surprise (the two counters
   * and the BOOK-113 exemption live in `budget.ts`).
   */
  budget(identityId: string, ipKey: string): CommentBudget {
    return readBudget(
      { db: this.db, config: this.config, limiter: this.limiter, ipHash: this.ipHash },
      identityId,
      ipKey,
    );
  }

  async post(input: PostCommentInput, context: PostContext): Promise<ServiceResult> {
    const now = this.now();
    const at = now.toISOString();

    if (context.identity.blocked !== 0) {
      return fail(403, 'BLOCKED', 'замечания от этого автора не принимаются');
    }

    // Idempotent replay: the same key returns the first result, never a second comment.
    const replay = this.replay(input, context.identity.id, context.ipKey);
    if (replay !== null) return replay;

    const queue = this.queueState();
    if (queue.full) {
      return {
        ok: false,
        status: 503,
        code: 'QUEUE_FULL',
        // BOOK-218 — the reader's sentence, not the machinery's: one constant both sides read.
        message: TOO_MANY_FILINGS,
        retryAfterMs: queue.retryAfterMs,
      };
    }

    // CAPTCHA first, before anything is stored and before any slot is consumed (§12.8).
    // Only when a provider is configured: with `none` the identity above and the rate slots
    // below are the gate, and there is no token to verify (BOOK-64).
    if (this.config.captchaProvider !== 'none') {
      const captcha = await this.captcha(input.captchaToken ?? undefined, { ip: context.ip });
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
    }

    // The CAPTCHA call is the one await before the write, so (when a challenge runs) a second
    // request with the same key can land while this one waits: the checks below re-read the
    // store instead of trusting the snapshot taken above.

    // BOOK-158: one reader's submission is read by the same rules as a revision of it.
    const text = readFilingText({
      body: input.body,
      proposedText: input.proposedText,
      interventionKind: input.interventionKind,
    });
    if (text.ok === false) return text;
    const body = { text: text.body.text, hash: text.body.hash };
    const proposedText = text.proposedText;
    const interventionKind: InterventionKind | null = text.kind;

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
        const replayed = this.replay(input, context.identity.id, context.ipKey);
        if (replayed !== null) return replayed;
      }
      return fail(409, 'DUPLICATE', 'такое замечание уже отправлено', duplicate.id);
    }

    const anchor = resolveAnchor(this.db, input);
    if (anchor.ok === false) return anchor.failure;
    // ADR-044: the filing hangs on the sentence its quote sits in, when that quote resolves to
    // exactly one stored sentence. No resolution is not a refusal — the block anchor is the
    // legacy path, and an old block has no sentences to resolve against.
    const sentence =
      anchor.anchor.blockId === null
        ? null
        : resolveQuoteSentence(this.db, {
            blockId: anchor.anchor.blockId,
            quote: anchor.anchor.quote,
            prefix: anchor.anchor.prefix,
            suffix: anchor.anchor.suffix,
          });
    // BOOK-137: how this filing sits against the frozen frame, taken once, stored once. The
    // mark is data about the reader's aim; the sentence's letters are protected at a landing.
    const frame = classifyFrame({
      chapter: input.chapter,
      quote: anchor.anchor.quote,
      blockIndex: anchor.anchor.blockIndex,
      blockText: anchor.blockText,
      blockCount: anchor.blockCount,
    });

    const guard = classifyComment(body.text, proposedText);
    const filing = { body: body.text, proposed: proposedText, quote: anchor.anchor.quote };
    // Gate B's scan (BOOK-61): the law is asked before any budget is spent, so a refused
    // filing costs the reader no slot. The answer is written to the row after the insert —
    // a verdict is a column, and the row must exist first.
    const rights = scanFiling(this.db, input.chapter, filing);

    // BOOK-158: a submission that may reach a model is an attempt, and the counters are the
    // model's attention — not the reader's daily edit, which is spent by an accepted filing
    // alone (`feedback/cli.ts`). A refusal spends here, an identical resubmission does not.
    const nowMs = now.getTime();
    const identityToday = identityAttemptsToday(this.db, context.identity.id, nowMs);
    const networkToday = networkAttemptsToday(this.db, this.ipHash(context.ipKey), nowMs);
    if (identityToday >= ATTEMPTS_PER_IDENTITY_DAY || networkToday >= ATTEMPTS_PER_NETWORK_DAY) {
      // One public line for both caps: the reader is told the day, never which counter ran out.
      // BOOK-158: the answer names when the tries come back (the next 00:00 UTC), as the
      // revision path's `ATTEMPTS_EXHAUSTED` does, so the form can print the return.
      return {
        ok: false,
        status: 429,
        code: 'ATTEMPT_LIMIT',
        message: 'слишком много попыток сегодня — попробуйте завтра',
        budget: identityToday >= ATTEMPTS_PER_IDENTITY_DAY ? 'identity' : 'ip',
        reopenAt: new Date(utcDayEnd(nowMs)).toISOString(),
      };
    }
    if (
      identicalAttempt(
        this.db,
        context.identity.id,
        body.hash,
        anchorSha({
          chapter: input.chapter,
          block_id: anchor.anchor.blockId,
          quote: anchor.anchor.quote,
          prefix: anchor.anchor.prefix,
          suffix: anchor.anchor.suffix,
        }),
        nowMs,
      )
    ) {
      return fail(409, 'IDENTICAL', 'это уже было — поправьте формулировку');
    }

    const specs = commentSpecs(this.config, this.ipHash, context.ipKey, context.identity.id);
    const consumed = rights.verdict === 'refused' ? { allowed: true as const } : this.limiter.consume(specs);
    if (!consumed.allowed) {
      const blocked = consumed.blocked;
      const resetAt = blocked.resetAtMs === null ? undefined : new Date(blocked.resetAtMs).toISOString();
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
        // The anchor decides the revision (`resolveAnchor`): a written chapter never stores
        // `base_rev 0`, an unwritten one always does (BOOK-111).
        baseRev: anchor.baseRev,
        quote: anchor.anchor.quote,
        prefix: anchor.anchor.prefix,
        suffix: anchor.anchor.suffix,
        // ADR-044: the sentence and the reader's selection inside it, or null for the block anchor.
        sentenceId: sentence?.sentenceId ?? null,
        selStart: sentence?.selStart ?? null,
        selEnd: sentence?.selEnd ?? null,
        author: sanitizeAuthor(context.identity.display_name),
        body: body.text,
        proposedText,
        interventionKind,
        bodySha: body.hash,
        flags: guard.flags,
        ipHash: this.ipHash(context.ipKey),
        status: guard.status,
        frame,
        guard: guard.guard,
        reason: guard.reason,
        createdAt: at,
        idemKey: input.idempotencyKey ?? null,
        // BOOK-58: the record of what this reader accepted. The server is the authority on
        // which terms are in force — the request carries no version — and the hash is of the
        // exact text the page printed, recomputable from `TERMS_VERSION` years later.
        termsVersion: TERMS_VERSION,
        termsSha: sha256Hex(acceptedTermsText()),
      });
    } catch (error) {
      // Backstop for a replay that still raced us: the UNIQUE index on `idem_key` is the
      // real serialisation point, so the loser reads the winner's row instead of a 500.
      const raced = isUniqueViolation(error) ? this.replay(input, context.identity.id, context.ipKey) : null;
      if (raced === null) throw error;
      return raced;
    }
    appendCommentEvent(this.db, id, 'posted', at, { status: guard.status, flags: guard.flags });
    if (guard.status === 'quarantined') {
      appendCommentEvent(this.db, id, 'quarantined', at, { reason: guard.reason });
    }
    // Gate B (BOOK-61): the law outranks the scope; its own column, written once. The scan
    // above is handed over so the answer the budget respected is the answer stored.
    applyRights(this.db, id, input.chapter, filing, at, rights);

    const row = readCommentRow(this.db, id);
    if (row === undefined) return fail(500, 'INTERNAL', 'замечание не сохранилось');
    // BOOK-158: every stored filing is attempt `n = 1`; a row a gate refused here is already
    // decided, so its attempt is closed with the same answer instead of waiting for triage.
    const n = recordAttempt(this.db, row, at);
    if (row.status === 'rejected') setAttemptOutcome(this.db, id, n, 'refused', at);
    else if (row.status === 'quarantined') setAttemptOutcome(this.db, id, n, 'held', at);

    const dto = toCommentDto(this.db, row, nowMs);
    this.emit?.('comment:added', commentAddedPayload(dto));
    // BOOK-DOC-84 #17: a filing the gates stopped before triage says so at once — «на проверке»
    // is state with a frame, not a fact only a refetch could learn.
    emitFilingUpdate(this.db, (type, data) => this.emit?.(type, data), {
      commentId: row.id,
      chapter: row.chapter,
      state: row.status === 'quarantined' ? 'quarantined' : row.held_rule !== null ? 'held' : filingStateOf(row.status),
      changeId: row.change_id,
      at: Date.parse(dto.createdAt),
    });
    return { ok: true, status: 201, body: { comment: dto, remaining: this.budget(context.identity.id, context.ipKey), queue: { depth: this.queueState().depth } } };
  }

  /** The soft cap is global, not per identity: it protects the lane, not a person (§14). */
  queueState(): { depth: number; full: boolean; retryAfterMs: number } {
    const depth = (this.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0`).get() as {
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

  private response(row: CommentRow, ipKey: string): PostCommentResponse {
    return {
      comment: toCommentDto(this.db, row, this.now().getTime()),
      remaining: this.budget(row.identity_id, ipKey),
      queue: { depth: this.queueState().depth },
    };
  }

  /**
   * An idempotent replay returns the first result, never a second comment. `null` means
   * there is no row for this key yet, i.e. the caller may proceed with the submission.
   */
  private replay(input: PostCommentInput, identityId: string, ipKey: string): ServiceResult | null {
    if (!isPresent(input.idempotencyKey)) return null;
    const existing = readCommentRowByIdemKey(this.db, input.idempotencyKey);
    if (existing === undefined) return null;
    if (existing.identity_id === identityId) {
      return { ok: true, status: 201, body: this.response(existing, ipKey) };
    }
    // A key is scoped to one reader; a foreign key is a collision, not a replay. The row is
    // another reader's, and may be hidden from this one (quarantined, or never theirs to see),
    // so the refusal names no comment id: 409 and nothing more.
    return fail(409, 'DUPLICATE', 'такое замечание уже отправлено');
  }
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
