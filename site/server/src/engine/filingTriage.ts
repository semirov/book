/**
 * Filing triage on the engine's side (BOOK-206, ADR-045 §2–§4): the claim, the one stored
 * verdict, and the bounded retry. Three routes, no model, no network — ADR-012 holds: the
 * engine parses a row and writes a row, and the key stays in the writer.
 *
 *   · `POST /internal/triage/next {session}` — claim one due filing out of its own ledger
 *     (`comment_attempts`, the row `CommentService.post` already writes) and answer what the
 *     writer is to read: the envelope, the world it is judged against, and — when gate C has
 *     already spoken — the recorded verdict, so only the missing half is asked. The money guard
 *     runs **before** the claim: a paused day hands out nothing and touches no row.
 *   · `POST /internal/triage/verdict {commentId, n, verdict, spend}` — re-parse the answer
 *     against an envelope rebuilt from rows, one `INSERT OR IGNORE` money row, and one write of
 *     `comment_attempts.verdict` + `comments.audit_*`. A second answer for the same attempt is
 *     `{stored:false, already:true}` and charges nothing.
 *   · `POST /internal/triage/fail {commentId, n, code}` — the try was spent, not the filing:
 *     the backoff goes on the attempt row, one `comment_events('triage.failed')` records the
 *     code, and at the cap the row is **not** left out of every query: the attempt goes back to
 *     the next UTC midnight with a fresh budget, the row's line names the time, and an engine
 *     alert makes the rate visible (BOOK-206 B5). A claim that expired with its process is
 *     settled the same way, once, with a `triage.abandoned` marker (M4). The row stays `new`.
 *
 * What never happens here: a filing is never refused, never escalated and never deleted. The
 * ladder that places it lives in `feedback/disposition.ts` and runs in the site (ADR-045 §5).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { normalizeInterventionKind, validateIntent } from '@book/shared';

import { assertBudgetAllowsPass, budgetCapsOf } from '../budget.ts';
import {
  TRIAGE_MAX_TRIES,
  claimTriage,
  clearRetryLine,
  dueTriage,
  readAttempt,
  rescheduleTomorrow,
  scheduleRetry,
  triageBackoffMs,
} from '../comments/attempts.ts';
import { appendCommentEvent, readBlock, readCommentRow, type CommentRow } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { buildEnvelope, withWorld, type FilingEnvelope } from '../feedback/envelope.ts';
import { filingValues } from '../feedback/batches.ts';
import { parseTriageAnswer, type TriageAnswer } from '../feedback/triageReading.ts';
import { chargeTriageSpend } from '../feedback/triage.ts';
import { chapterVocabulary } from '../feedback/vocabulary.ts';
import { recordAlert } from './alerts.ts';
import { refuse, type EngineAlert, type EngineDeps } from './types.ts';

/** The world a filing is judged against: the anchor block and its two neighbours, bounded. */
export const WORLD_MAX_CHARS = 6_000;

/** The one answer the writer receives for `next`, or the reason there is none. */
export type TriageAssignment = {
  commentId: string;
  /** The attempt number the verdict must name. */
  attempt: number;
  chapter: number;
  kind: string | null;
  /** The filing as the server writes it: the four untrusted values plus the world. */
  envelope: FilingEnvelope;
  world: string | null;
  /** Gate C's stored answer, when the filing was already judged: only the reading is asked. */
  recordedVerdict: 'FITS' | 'OFF' | null;
  /** §10.8: the widening this attempt runs under (`as-document` after the third failure). */
  widened: string | null;
};

export type TriageNextResult = TriageAssignment | null | { assignment: null; reason: 'budget' };

export type TriageSpendInput = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** BOOK-219: the provider reported no usage; the writer read the counts off the text. */
  estimated?: boolean;
};

export type TriageVerdictResult =
  | { stored: true; attempt: number; verdict: 'FITS' | 'OFF'; rung: string }
  | { stored: false; already: true };

/**
 * One failed try's answer. `cap` is the day's last try — and, since BOOK-206 B5, not a terminal:
 * the engine has already put the attempt back to the next UTC midnight (`nextAt`) with a fresh
 * budget, so `tries` in the result is the spent count and the row is due again tomorrow.
 */
export type TriageFailResult = {
  tries: number;
  nextAt: string | null;
  cap: boolean;
  /** §10.8: the fifth failure hands over to the deterministic sixth — no call, no wait. */
  desperate?: true;
  already?: true;
};

/** What one failed call cost, when the provider reported it: the money is still spent. */
export type TriageFailSpend = TriageSpendInput;

export type FilingTriage = {
  next(session: string): TriageNextResult;
  verdict(input: { commentId: string; n: number; verdict: unknown; spend: TriageSpendInput }): TriageVerdictResult;
  fail(input: {
    commentId: string;
    n: number;
    code: string;
    detail?: string;
    /** AC5: a call that failed still cost money, and the ledger is where a day is bounded. */
    spend?: TriageFailSpend;
  }): TriageFailResult;
};

/** The anchor paragraph and its neighbours, read from rows and bounded — never a manuscript. */
export function worldOf(db: Db, row: Pick<CommentRow, 'chapter' | 'block_id'>): string | null {
  const anchor = row.block_id === null ? undefined : readBlock(db, row.block_id);
  const blocks =
    anchor === undefined
      ? (db.prepare('SELECT text FROM blocks WHERE chapter = ? ORDER BY idx LIMIT 2').all(row.chapter) as Array<{
          text: string;
        }>)
      : (db
          .prepare('SELECT text FROM blocks WHERE chapter = ? AND idx BETWEEN ? AND ? ORDER BY idx')
          .all(row.chapter, anchor.idx - 1, anchor.idx + 1) as Array<{ text: string }>);
  const world = blocks.map((block) => block.text).join('\n\n');
  return world.length === 0 ? null : world.slice(0, WORLD_MAX_CHARS);
}

/** The filing as an envelope plus the world, from rows only — the one builder both routes use. */
export function triageAskOf(db: Db, row: CommentRow): { envelope: FilingEnvelope; world: string | null } {
  const chapter = db.prepare('SELECT rev FROM chapters WHERE n = ?').get(row.chapter) as { rev: number } | undefined;
  const world = worldOf(db, row);
  const envelope = buildEnvelope({
    id: row.id,
    chapter: row.chapter,
    block: row.block_id,
    rev: row.base_rev ?? chapter?.rev ?? 0,
    kind: normalizeInterventionKind(row.intervention_kind),
    values: filingValues(row),
  });
  return { envelope: withWorld(envelope, world), world };
}

/** An attempt whose whole budget is spent and no call is live: nothing will pick it up again. */
type CappedAttempt = { commentId: string; n: number; tries: number; claimUntil: string | null };

/**
 * BOOK-206 B5/M4 — the rows no query reaches any more: the latest attempt still waits for an
 * answer, its tries are all spent and no claim is live. A writer killed after `next` three times
 * lands here (the claims expired, no `fail` was ever called), as does a row an older build left
 * at the cap; without this sweep both are excluded from `dueTriage` forever, silently.
 */
function cappedAttempts(db: Db, now: string, limit = 8): CappedAttempt[] {
  return db
    .prepare(
      `SELECT c.id AS commentId, a.n AS n, a.tries AS tries, a.claim_until AS claimUntil
         FROM comments c
         JOIN comment_attempts a ON a.comment_id = c.id
        WHERE c.status = 'new' AND c.disposition IS NULL
          AND c.rights_verdict = 'CLEAR'
          AND a.n = (SELECT MAX(n) FROM comment_attempts WHERE comment_id = c.id)
          AND a.outcome = 'submitted'
          AND a.verdict IS NULL
          AND a.tries >= ?
          -- §10.8: a desperate attempt is not abandoned — it waits for the site's deterministic
          -- settlement, and sweeping it to the next day would undo the ladder's last rung.
          AND a.desperate = 0
          AND (a.claim_until IS NULL OR a.claim_until <= ?)
        ORDER BY c.created_at, c.id
        LIMIT ?`,
    )
    .all(TRIAGE_MAX_TRIES, now, limit) as CappedAttempt[];
}

export function createFilingTriage(deps: EngineDeps): FilingTriage {
  const { db, config } = deps;
  const caps = budgetCapsOf(config);
  const iso = (ms: number): string => new Date(ms).toISOString();

  function next(session: string): TriageNextResult {
    const at = deps.clock.now();
    try {
      // The money guard runs before any row is read: a paused day hands out no triage.
      assertBudgetAllowsPass(db, caps, at);
    } catch (error) {
      if (error instanceof Error && 'code' in error && String((error as { code: unknown }).code).startsWith('BUDGET_')) {
        return { assignment: null, reason: 'budget' };
      }
      throw error;
    }
    const now = iso(at);
    // BOOK-206 M4/B5: a row whose claims all expired (a writer killed under the call) never
    // called `fail`, so nothing else would ever reach it. It gets the next day, once, with an
    // alert — the same honest shape the cap takes.
    settleAbandoned(now);
    for (const candidate of dueTriage(db, now)) {
      // The try about to be spent is the last one, and the claim before it expired rather than
      // ended in `fail`: the previous claims were abandoned with the process (M4).
      if (
        candidate.tries >= TRIAGE_MAX_TRIES - 1 &&
        candidate.claimUntil !== null &&
        Date.parse(candidate.claimUntil) <= at
      ) {
        noteAbandoned(candidate.commentId, candidate.n, candidate.tries, now, 'claim-abandoned');
      }
      if (!claimTriage(db, { commentId: candidate.commentId, n: candidate.n, session, now })) continue;
      const row = readCommentRow(db, candidate.commentId);
      if (row === undefined) continue;
      const claimed = readAttempt(db, candidate.commentId, candidate.n);
      // §10.1: the claim is a row the page hears (`filing:reading{claimed}`), with the try it just
      // bought. One row per claim, named by the attempt it belongs to.
      appendCommentEvent(db, candidate.commentId, 'triage.claimed', now, {
        attempt: candidate.n,
        try: claimed?.tries ?? 0,
        ...(claimed?.widened === null || claimed?.widened === undefined ? {} : { widened: claimed.widened }),
      });
      const ask = triageAskOf(db, row);
      return {
        commentId: row.id,
        attempt: candidate.n,
        chapter: row.chapter,
        kind: normalizeInterventionKind(row.intervention_kind),
        envelope: ask.envelope,
        world: ask.world,
        recordedVerdict: row.audit_verdict === 'FITS' || row.audit_verdict === 'OFF' ? row.audit_verdict : null,
        widened: claimed?.widened ?? null,
      };
    }
    return null;
  }

  /**
   * One alert per attempt, ever: a marker event makes the writer's 5 s cadence silent after the
   * first, and `comment_events` is also where the site's bridge reads the fact. The detail names
   * the shape (`claim-abandoned`, `cap-abandoned`), never a model's words.
   */
  function noteAbandoned(commentId: string, n: number, tries: number, at: string, detail: string): void {
    const prior = db
      .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.abandoned'`)
      .all(commentId) as Array<{ meta: string | null }>;
    const seen = prior.some((event) => {
      try {
        return (JSON.parse(event.meta ?? '{}') as { attempt?: number }).attempt === n;
      } catch {
        return false;
      }
    });
    if (seen) return;
    appendCommentEvent(db, commentId, 'triage.abandoned', at, { attempt: n, tries, detail });
    recordAlert(deps, {
      kind: 'triage' satisfies EngineAlert['kind'],
      at,
      changeId: null,
      cascadeId: null,
      stepId: null,
      detail: `triage ${commentId} #${String(n)}: ${detail} after ${String(tries)} tries`,
    });
  }

  /** Give every capped attempt its next day: `tries` 0, `next_at` 00:00 UTC, the sentence written. */
  function settleAbandoned(now: string): void {
    for (const capped of cappedAttempts(db, now)) {
      // An expired claim is a process that died under the call; no claim at all is an older build
      // that left the row at the cap. Both are abandoned, and both are named as such.
      noteAbandoned(capped.commentId, capped.n, capped.tries, now, capped.claimUntil === null ? 'cap-abandoned' : 'claim-abandoned');
      rescheduleTomorrow(db, { commentId: capped.commentId, n: capped.n, nowMs: Date.parse(now) });
    }
  }

  function verdict(input: {
    commentId: string;
    n: number;
    verdict: unknown;
    spend: TriageSpendInput;
  }): TriageVerdictResult {
    const at = iso(deps.clock.now());
    return db.transaction((): TriageVerdictResult => {
      const row = readCommentRow(db, input.commentId);
      if (row === undefined) refuse('UNKNOWN_COMMENT', 404, `no comment ${input.commentId}`);
      const attempt = readAttempt(db, input.commentId, input.n);
      if (attempt === undefined) refuse('UNKNOWN_ATTEMPT', 404, `no attempt ${String(input.n)}`);
      // One verdict, one reading: a retried call never re-judges a stored one, and never charges.
      if (attempt.verdict !== null || attempt.outcome !== 'submitted') {
        return { stored: false, already: true };
      }
      const { envelope } = triageAskOf(db, row);
      const parsed = parseTriageAnswer(input.verdict, envelope);
      if (!parsed.ok) refuse(parsed.code, 422, parsed.detail);
      const answer: TriageAnswer = parsed.answer;
      // A recorded verdict is never rewritten (ADR-045 §4, §6): the answer must restate it. The
      // writer checks this too, but the row is the authority — a direct caller cannot re-judge.
      if (row.audit_verdict !== null && row.audit_verdict !== answer.verdict) {
        refuse('VERDICT_LOCKED', 422, `${row.id} already carries ${row.audit_verdict}; a recorded verdict is never rewritten`);
      }
      // The second injection guard: the intent becomes the change's one-goal sentence, so it is
      // judged with the chapter's own vocabulary before anything is stored.
      const intent = validateIntent(answer.reading.intent, row.chapter, {
        vocabulary: chapterVocabulary(db, row.chapter),
        kind: normalizeInterventionKind(row.intervention_kind),
      });
      if (!intent.ok) refuse(intent.code, 422, intent.reason);
      const stored: TriageAnswer = { ...answer, reading: { ...answer.reading, intent: intent.intent } };

      const written = db
        .prepare(
          `UPDATE comment_attempts SET verdict = ?, verdict_at = ?
            WHERE comment_id = ? AND n = ? AND verdict IS NULL`,
        )
        .run(JSON.stringify(stored), at, input.commentId, input.n).changes;
      if (written !== 1) return { stored: false, already: true };
      // BOOK-206 B5: the reading the rescheduled sentence promised has happened — the line goes,
      // and the row waits for its placement like any filing (the acceptance writes its own).
      clearRetryLine(db, input.commentId);
      // Gate C's own columns: first answer wins, and a recorded verdict is never rewritten.
      db.prepare(
        `UPDATE comments
            SET audit_verdict = ?, audit_reason = ?, audited_at = ?, audited_by = ?
          WHERE id = ? AND audit_verdict IS NULL`,
      ).run(stored.verdict, stored.reason, at, `triage:${input.spend.model}`.slice(0, 64), input.commentId);
      // §10.1: the answer landing is its own frame (`filing:reading{read}`), with the try that
      // bought it; the sink (`comment:decision`) is the site's, never this row.
      appendCommentEvent(db, input.commentId, 'triage.read', at, {
        attempt: input.n,
        try: attempt.tries,
        verdict: stored.verdict,
        ...(attempt.widened === null ? {} : { widened: attempt.widened }),
      });
      chargeTriageSpend(db, {
        chapter: row.chapter,
        passId: `triage:${input.commentId}:${String(input.n)}`,
        at,
        model: input.spend.model,
        tokensIn: input.spend.tokensIn,
        tokensOut: input.spend.tokensOut,
        usd: input.spend.usd,
        // BOOK-219: an answer the provider did not measure is the pipeline's estimate, and the
        // ledger row says so — the prose lane's close writes the same word for the same reason.
        ...(input.spend.estimated === true ? { estimated: true } : {}),
      });
      return {
        stored: true,
        attempt: input.n,
        verdict: stored.verdict === 'OFF' ? 'OFF' : 'FITS',
        rung: stored.reading.rung,
      };
    })();
  }

  function fail(input: {
    commentId: string;
    n: number;
    code: string;
    detail?: string;
    spend?: TriageFailSpend;
  }): TriageFailResult {
    const atMs = deps.clock.now();
    const at = iso(atMs);
    return db.transaction((): TriageFailResult => {
      const attempt = readAttempt(db, input.commentId, input.n);
      if (attempt === undefined) refuse('UNKNOWN_ATTEMPT', 404, `no attempt ${String(input.n)}`);
      // A retried report is the same failure: the *try* already has its event and its backoff,
      // and a second one would count one broken call twice. The next try is a new key.
      const prior = db
        .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.failed'`)
        .all(input.commentId) as Array<{ meta: string | null }>;
      const metas = prior.map((event) => {
        try {
          return JSON.parse(event.meta ?? '{}') as { attempt?: number; try?: number; cap?: boolean };
        } catch {
          return {};
        }
      });
      const reported = metas.some((meta) => meta.attempt === input.n && meta.try === attempt.tries);
      if (reported) {
        return { tries: attempt.tries, nextAt: attempt.next_at, cap: attempt.tries >= TRIAGE_MAX_TRIES, already: true };
      }
      // The call happened and the provider priced it: the row is the try's own pass id, so a
      // retried report cannot charge the same call twice (`INSERT OR IGNORE`).
      if (input.spend !== undefined) {
        const chapter = (db.prepare('SELECT chapter FROM comments WHERE id = ?').get(input.commentId) as
          | { chapter: number }
          | undefined)?.chapter;
        if (chapter !== undefined) {
          chargeTriageSpend(db, {
            chapter,
            passId: `triage:${input.commentId}:${String(input.n)}:${String(attempt.tries)}`,
            at,
            ...input.spend,
          });
        }
      }
      const backoff = triageBackoffMs(attempt.tries);
      const nextAt = backoff === null ? null : iso(atMs + backoff);
      // §10.8: the third failure widens the reading itself — one event, one code, attempts 4–5
      // run under it. The widening is the row's state, never a client's guess.
      const widensNow = attempt.tries === 3 && attempt.widened === null;
      if (widensNow) {
        db.prepare('UPDATE comment_attempts SET widened = ? WHERE comment_id = ? AND n = ?').run(
          'as-document',
          input.commentId,
          input.n,
        );
        appendCommentEvent(db, input.commentId, 'triage.widened', at, {
          attempt: input.n,
          try: attempt.tries,
          widened: 'as-document',
        });
      }
      appendCommentEvent(db, input.commentId, 'triage.failed', at, {
        code: input.code.slice(0, 60),
        attempt: input.n,
        try: attempt.tries,
        // §10.8: the sixth is not a wait. The cap carries no `retryAt`: it is the last try, and
        // the site settles what a desperate attempt can settle without a model call.
        ...(nextAt === null ? { cap: true, desperate: true } : { retryAt: nextAt }),
        ...(attempt.widened === null && !widensNow ? {} : { widened: attempt.widened ?? 'as-document' }),
      });
      if (nextAt === null) {
        // §10.8: five failures are the ceiling of bought calls. The sixth is deterministic and
        // cheap; the engine marks it and alerts once, and the site's applier settles it.
        db.prepare(
          'UPDATE comment_attempts SET desperate = 1, next_at = NULL, claim_by = NULL, claim_until = NULL WHERE comment_id = ? AND n = ?',
        ).run(
          input.commentId,
          input.n,
        );
        recordAlert(deps, {
          kind: 'triage' satisfies EngineAlert['kind'],
          at,
          changeId: null,
          cascadeId: null,
          stepId: null,
          detail: `triage ${input.commentId} #${String(input.n)}: ${TRIAGE_MAX_TRIES} tries, last code ${input.code.slice(0, 60)} — desperate sixth`,
        });
        return { tries: attempt.tries, nextAt: null, cap: true, desperate: true };
      }
      scheduleRetry(db, { commentId: input.commentId, n: input.n, nextAt });
      return { tries: attempt.tries, nextAt, cap: false };
    })();
  }

  return { next, verdict, fail };
}

const session = z.string().min(1).max(64);
const commentId = z.string().min(1).max(80);
const attemptNo = z.number().int().min(1).max(1_000_000);

const triageNextBody = z.object({ session });
const triageSpendBody = z.object({
  model: z.string().min(1).max(120),
  tokensIn: z.number().int().min(0).max(100_000_000),
  tokensOut: z.number().int().min(0).max(100_000_000),
  usd: z.number().min(0).max(1_000),
  /** BOOK-219: the provider reported no usage — the writer's estimate, named as one. */
  estimated: z.boolean().optional(),
});
const triageVerdictBody = z.object({
  commentId,
  n: attemptNo,
  // The model's answer, closed and post-checked by `feedback/triageReading.ts` — the route only
  // bounds its size.
  verdict: z.unknown(),
  spend: triageSpendBody,
});
const triageFailBody = z.object({
  commentId,
  n: attemptNo,
  /** An engine code (`PROVIDER_TIMEOUT`, `READING_MALFORMED`, `INTENT_SHAPE`), never prose. */
  code: z.string().min(1).max(60),
  detail: z.string().max(400).optional(),
  /** AC5: present when the provider reported usage — a failed call is money all the same. */
  spend: triageSpendBody.optional(),
});

/** The three routes, registered by `buildControl` under the same bearer guard as every other. */
export function registerTriageRoutes(app: FastifyInstance, triage: FilingTriage): void {
  app.post('/internal/triage/next', async (request) => {
    const body = triageNextBody.parse(request.body ?? {});
    return { ok: true, data: triage.next(body.session) };
  });
  app.post('/internal/triage/verdict', async (request) => {
    const body = triageVerdictBody.parse(request.body ?? {});
    return { ok: true, data: triage.verdict(body) };
  });
  app.post('/internal/triage/fail', async (request) => {
    const body = triageFailBody.parse(request.body ?? {});
    return { ok: true, data: triage.fail(body) };
  });
}
