/**
 * Filing triage on the engine's side (BOOK-206, ADR-045 §2–§4): the claim, the one stored
 * verdict, and the six attempts that bound a read. Three routes, no model, no network — ADR-012
 * holds: the engine parses a row and writes a row, and the key stays in the writer.
 *
 *   · `POST /internal/triage/next {session}` — claim one due filing out of its own ledger
 *     (`comment_attempts`, the row `CommentService.post` already writes) and answer what the
 *     writer is to read: the envelope, the world it is judged against, the attempt's place in the
 *     count, how wide the reading now is, and — when gate C has already spoken — the recorded
 *     verdict, so only the missing half is asked. The money guard runs **before** the claim: a
 *     paused day hands out nothing and touches no row.
 *   · `POST /internal/triage/verdict {commentId, n, verdict, spend}` — re-parse the answer
 *     against an envelope rebuilt from rows, one `INSERT OR IGNORE` money row, and one write of
 *     `comment_attempts.verdict` + `comments.audit_*`. A second answer for the same attempt is
 *     `{stored:false, already:true}` and charges nothing.
 *   · `POST /internal/triage/fail {commentId, n, code}` — the try was spent, not the filing: the
 *     backoff goes on the attempt row and one `comment_events('triage.failed')` records the code.
 *
 * The owner's correction of 2026-10-29 («нет, сроков не надо — только конечное количество
 * попыток») is the bound: six attempts, no clock. The third failure widens the reading; the sixth
 * is **desperate** and buys no model call at all — the ladder's floor rung is applied by the
 * coded rule (`feedback/disposition.ts`) and the record says `desperate`. Only when the floor
 * cannot apply (a lock, or a recorded `OFF` the floor would contradict) is the filing refused
 * (`rejected`, `TRIAGE_REFUSED_LINE`). No filing waits on a timer, because no timer decides one.
 *
 * What never happens here: a filing is never refused for its **words** (that is gate B, gate C and
 * the ladder in `feedback/disposition.ts`) — this refusal is about a read that never happened.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { normalizeInterventionKind, validateIntent } from '@book/shared';

import { assertBudgetAllowsPass, budgetCapsOf } from '../budget.ts';
import {
  TRIAGE_MAX_TRIES,
  TRIAGE_WIDEN_AFTER,
  claimTriage,
  desperateTriage,
  dueTriage,
  readAttempt,
  scheduleRetry,
  triageBackoffMs,
  widenReading,
} from '../comments/triage.ts';
import { appendCommentEvent, readBlock, readCommentRow, type CommentRow } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { buildEnvelope, withWorld, type FilingEnvelope } from '../feedback/envelope.ts';
import { filingValues } from '../feedback/batches.ts';
import { parseTriageAnswer, type TriageAnswer } from '../feedback/triageReading.ts';
import { chargeTriageSpend } from '../feedback/triage.ts';
import { chapterVocabulary } from '../feedback/vocabulary.ts';
import { recordAlert } from './alerts.ts';
import { createTriageFloor } from './triageFloor.ts';
import { refuse, type EngineAlert, type EngineDeps } from './types.ts';

/** The world a filing is judged against: the anchor block and its two neighbours, bounded. */
export const WORLD_MAX_CHARS = 6_000;

/** The one answer the writer receives for `next`, or the reason there is none. */
export type TriageAssignment = {
  commentId: string;
  /** The attempt number the verdict must name. */
  attempt: number;
  /** The attempt's place in the count, and the count itself: «попытка N из 6». */
  tries: number;
  of: number;
  /** `'rung'` once the third failure widened the reading; null while it is narrow. */
  widened: string | null;
  wideningNote: string | null;
  chapter: number;
  kind: string | null;
  /** The filing as the server writes it: the four untrusted values plus the world. */
  envelope: FilingEnvelope;
  world: string | null;
  /** Gate C's stored answer, when the filing was already judged: only the reading is asked. */
  recordedVerdict: 'FITS' | 'OFF' | null;
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
 * One failed try's answer. `desperate` says the model's part of the count is spent: the engine
 * applied its own floor rung instead of buying a sixth call (`nextAt: null`). `cap` is the one
 * refusal, and it happens only when no floor rung could apply.
 */
export type TriageFailResult = {
  tries: number;
  nextAt: string | null;
  cap: boolean;
  /** The engine's coded sixth attempt ran; the filing was placed at the floor. */
  desperate?: boolean;
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

export function createFilingTriage(deps: EngineDeps): FilingTriage {
  const { db, config } = deps;
  const caps = budgetCapsOf(config);
  const floorAt = createTriageFloor(deps);
  const iso = (ms: number): string => new Date(ms).toISOString();

  function next(session: string): TriageNextResult {
    const at = deps.clock.now();
    const now = iso(at);
    // The engine's own attempts run **before** the money guard: the floor rung buys no call, and
    // a paused day must not turn an exhausted counter into an open-ended wait.
    endReadsAndFloors(now);
    try {
      assertBudgetAllowsPass(db, caps, at);
    } catch (error) {
      if (error instanceof Error && 'code' in error && String((error as { code: unknown }).code).startsWith('BUDGET_')) {
        return { assignment: null, reason: 'budget' };
      }
      throw error;
    }
    for (const candidate of dueTriage(db, now)) {
      // The claim before this one expired rather than ended in `fail`: the process that held it
      // died under the call (M4). A backoff clears the claim, so a live row never lands here.
      if (candidate.claimUntil !== null && Date.parse(candidate.claimUntil) <= at) {
        noteAbandoned(candidate.commentId, candidate.n, candidate.tries, now, 'claim-abandoned');
      }
      if (!claimTriage(db, { commentId: candidate.commentId, n: candidate.n, session, now })) continue;
      const row = readCommentRow(db, candidate.commentId);
      if (row === undefined) continue;
      const asked = readAttempt(db, candidate.commentId, candidate.n);
      const ask = triageAskOf(db, row);
      return {
        commentId: row.id,
        attempt: candidate.n,
        // The claim already counted this try; the row is the authority for the widening.
        tries: asked?.tries ?? candidate.tries + 1,
        of: TRIAGE_MAX_TRIES,
        widened: asked?.widened ?? null,
        wideningNote: asked?.widening_note ?? null,
        chapter: row.chapter,
        kind: normalizeInterventionKind(row.intervention_kind),
        envelope: ask.envelope,
        world: ask.world,
        recordedVerdict: row.audit_verdict === 'FITS' || row.audit_verdict === 'OFF' ? row.audit_verdict : null,
      };
    }
    return null;
  }

  /**
   * One alert per attempt, ever: a marker event makes the writer's 5 s cadence silent after the
   * first. The detail names the shape (`claim-abandoned`, `cap-abandoned`), never a model's words.
   */
  function noteAbandoned(commentId: string, n: number, tries: number, at: string, detail: string): void {
    if (abandonedSeen(commentId, n)) return;
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

  /** Has this attempt's abandoned claim already been named? One marker, one alert. */
  function abandonedSeen(commentId: string, n: number): boolean {
    const prior = db
      .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.abandoned'`)
      .all(commentId) as Array<{ meta: string | null }>;
    return prior.some((event) => {
      try {
        return (JSON.parse(event.meta ?? '{}') as { attempt?: number }).attempt === n;
      } catch {
        return false;
      }
    });
  }

  /**
   * The engine's own answer for the rows the model can no longer answer: every latest attempt
   * still `submitted`, its model makes spent and no claim live is either placed at the floor rung
   * (the sixth attempt, no call bought) or refused with the one sentence. No clock is read.
   */
  function endReadsAndFloors(now: string): void {
    for (const ended of desperateTriage(db, now)) {
      floorAt.floor(ended.commentId, ended.n, now);
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
      // Gate C's own columns: first answer wins, and a recorded verdict is never rewritten.
      db.prepare(
        `UPDATE comments
            SET audit_verdict = ?, audit_reason = ?, audited_at = ?, audited_by = ?
          WHERE id = ? AND audit_verdict IS NULL`,
      ).run(stored.verdict, stored.reason, at, `triage:${input.spend.model}`.slice(0, 64), input.commentId);
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
      // A settled attempt is already answered — refused, placed or held — and a late report is the
      // same failure, never a fourth call: no event, no charge, no second alert.
      if (attempt.outcome !== 'submitted' || attempt.verdict !== null) {
        return { tries: attempt.tries, nextAt: attempt.next_at, cap: attempt.outcome === 'refused', already: true };
      }
      // A retried report is the same failure: the *try* already has its event and its backoff,
      // and a second one would count one broken call twice. The next try is a new key.
      const prior = db
        .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.failed'`)
        .all(input.commentId) as Array<{ meta: string | null }>;
      const metas = prior.map((event) => {
        try {
          return JSON.parse(event.meta ?? '{}') as { attempt?: number; try?: number };
        } catch {
          return {};
        }
      });
      const reported = metas.some((meta) => meta.attempt === input.n && meta.try === attempt.tries);
      if (reported) {
        // The attempt is open here, so the try's failure is already recorded and no cap can have
        // been reached by this report: the same answer as the first one, without a second event.
        return { tries: attempt.tries, nextAt: attempt.next_at, cap: false, already: true };
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
      if (backoff === null) {
        // The model's last try failed: the sixth attempt is the engine's own floor, no call bought.
        // It either places the filing at the floor rung or refuses it with the one sentence — and
        // either way the event that says so carries the count.
        appendCommentEvent(db, input.commentId, 'triage.failed', at, {
          code: input.code.slice(0, 60),
          attempt: input.n,
          try: attempt.tries,
          of: TRIAGE_MAX_TRIES,
        });
        floorAt.floor(input.commentId, input.n, at);
        const after = readAttempt(db, input.commentId, input.n);
        const refused = after?.outcome === 'refused';
        return {
          tries: after?.tries ?? attempt.tries,
          nextAt: null,
          cap: refused,
          ...(refused ? {} : { desperate: true as const }),
        };
      }
      // The third failure is where the reading stops being narrow: the row records it before the
      // fourth claim is made, so the widening is a fact of the ledger and not of one process.
      if (attempt.tries === TRIAGE_WIDEN_AFTER) widenReading(db, { commentId: input.commentId, n: input.n });
      appendCommentEvent(db, input.commentId, 'triage.failed', at, {
        code: input.code.slice(0, 60),
        attempt: input.n,
        try: attempt.tries,
        of: TRIAGE_MAX_TRIES,
      });
      const nextAt = iso(atMs + backoff);
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
