/**
 * The reader's own decisions (`GET /api/me/decisions`) — BOOK-13, BOOK-DOC-4 rule 4.
 *
 * The end of an intervention is addressed to the reader who made it: «правка внесена ·
 * главы 7–9 · волна 2 · решением · изменилось 12 абзацев · ваша доля 0,4 %» (BOOK-59: a
 * change makes one wave, so only a wave above it is named). That sentence must
 * survive a reload, so it is derived from the rows the engine already wrote — never from a
 * frame, which is a broadcast and forgets itself. Four tables answer it:
 *
 *   `comments`            the viewer's own intervention and its public decision/reason;
 *   `changes`             what was made of it (outcome, public intent, finish time);
 *   `cascades`            how many waves it ran;
 *   `change_impact`       how many paragraphs it changed, and which chapters it touched.
 *
 * Own only: the identity comes from the session cookie, never from a parameter, and the
 * answer carries no identity key — the comment ids are public objects of the thread. The
 * one share number is the same measurement `/api/authors/me` prints, floored the same way,
 * so the end matter cannot contradict itself. The historical share is the measured day at
 * or before the decision (`contribution_history`), never a curve between two points.
 *
 * Cost: one indexed query for the decisions, one for the open ids, one for the historical
 * share, and one measurement — the same one the reader's own trace already pays.
 */

import {
  MY_DECISIONS_LIMIT,
  MY_OPEN_LIMIT,
  TOTAL_CHAPTERS,
  floorShare,
  holdsInternalCode,
  readerReason,
  type ChangeOutcome,
  type ChangeStatus,
  type MeasuredShareDto,
  type MyDecisionDto,
  type MyDecisionOutcome,
  type MyDecisionsDto,
} from '@book/shared';

import { dispositionFieldsOf } from '../comments/dispositionReport.ts';
import { filingChanges, decisiveChange } from '../comments/filingState.ts';
import { isStopped, stoppedLine } from '../comments/states.ts';
import { premiseLanded } from '../comments/repo.ts';
import type { Db } from '../db/db.ts';
import { decisionOutcome, publicIntent } from '../engineState/changes.ts';
import { safeJson } from '../engineState/rows.ts';
import { computeShares } from '../history/erosion.ts';
import { readImpact } from '../history/impact.ts';

type DecisionRow = {
  comment_id: string;
  chapter: number;
  comment_status: string;
  comment_reason: string | null;
  comment_created_at: string;
  decided_at: string | null;
  change_id: string | null;
  /** BOOK-7 — 1 = the intervention became its chapter's premise, not a rewrite. */
  change_premise: number | null;
  change_status: string | null;
  change_outcome: string | null;
  change_reason: string | null;
  change_intent: string | null;
  change_finished_at: string | null;
  /** ADR-044 — the filing's own sentence and its filed paragraph; null = the block anchor. */
  block_id: string | null;
  block_idx: number | null;
  /** BOOK-174 — how the filing was read; null for a row written before v27. */
  disposition: string | null;
  lock: string | null;
  carrier_kind: string | null;
  quote_kept: string | null;
  sentence_id: string | null;
  waves: number | null;
  chapters_touched: string | null;
  blocks_changed: number | null;
  /** The chapter of the intervention as the book has it now. */
  chapter_basis: number | null;
  chapter_blocks: number | null;
};

/** The change the record reads, after `decisiveChange` — never the linked row alone (BOOK-136). */
type DecisionState = {
  id: string;
  status: string;
  outcome: string | null;
  reason: string | null;
  premise: boolean;
};

/**
 * One reader's interventions, newest first. A comment is in the record when it reached a
 * decision (`decided_at`) or was refused at the door (the guard writes `rejected` without
 * a decision, and that refusal is exactly what the reader must see). A comment still in the
 * triage pass is not a decision: it is in `open`, where the client uses it only as a key.
 */
const DECISIONS_SQL = `
  SELECT c.id            AS comment_id,
         c.chapter       AS chapter,
         c.status        AS comment_status,
         c.reason        AS comment_reason,
         c.created_at    AS comment_created_at,
         c.decided_at    AS decided_at,
         c.block_id      AS block_id,
         c.block_idx     AS block_idx,
         c.disposition   AS disposition,
         c.lock          AS lock,
         c.carrier_kind  AS carrier_kind,
         c.quote_kept    AS quote_kept,
         c.sentence_id   AS sentence_id,
         ch.id           AS change_id,
         ch.premise      AS change_premise,
         ch.status       AS change_status,
         ch.outcome      AS change_outcome,
         ch.reason       AS change_reason,
         ch.intent       AS change_intent,
         ch.finished_at  AS change_finished_at,
         cas.wave        AS waves,
         imp.chapters_touched,
         imp.blocks_changed,
         chp.basis       AS chapter_basis,
         chp.block_count AS chapter_blocks
    FROM comments c
    LEFT JOIN changes ch       ON ch.id = c.change_id
    LEFT JOIN cascades cas     ON cas.id = ch.cascade_id
    LEFT JOIN change_impact imp ON imp.change_id = ch.id
    LEFT JOIN chapters chp      ON chp.n = c.chapter
   WHERE c.identity_id = ?
     AND (c.decided_at IS NOT NULL OR c.status = 'rejected')
   ORDER BY COALESCE(ch.finished_at, c.decided_at, c.created_at) DESC, c.id DESC
   LIMIT ?`;

/** The client's key to its own live frame: own comments that have no decision yet. */
const OPEN_SQL = `
  SELECT id FROM comments
   WHERE identity_id = ? AND decided_at IS NULL AND status NOT IN ('rejected', 'hidden', 'expired')
   ORDER BY created_at DESC, id DESC
   LIMIT ?`;

/** The last measured day at or before the decision; its own `day` travels with the number. */
const SHARE_THEN_SQL = `
  SELECT day, share FROM contribution_history
   WHERE identity_id = ? AND day <= ?
   ORDER BY day DESC LIMIT 1`;

/** Statuses that are a promise, not a result: the reader's line says «ждёт очереди». */
const WAITING = new Set<string>(['pending', 'processing', 'stale']);

export function readMyDecisions(db: Db, identityId: string): MyDecisionsDto {
  const rows = db.prepare(DECISIONS_SQL).all(identityId, MY_DECISIONS_LIMIT) as DecisionRow[];
  const open = (
    db.prepare(OPEN_SQL).all(identityId, MY_OPEN_LIMIT) as Array<{ id: string }>
  ).map((row) => row.id);

  // The same measurement and the same rounding the reader's own trace uses: two numbers
  // that could disagree on one page are worse than no number.
  const { totalChars, items } = computeShares(db);
  const chars = items.find((item) => item.identityId === identityId)?.chars ?? 0;

  return {
    items: rows.map((row) => toDecision(db, identityId, row)),
    open,
    share: totalChars === 0 ? 0 : floorShare(chars / totalChars),
  };
}

/**
 * The change the record reads: the filing's **newest** fact (BOOK-136), so a stop on the current
 * attempt outranks an older landing and a landing newer than the stop is still the answer
 * (`comments/filingState.ts` `decisiveChange`). `null` means the linked change row is gone.
 */
function stateOf(db: Db, row: DecisionRow): DecisionState | null {
  if (row.change_id === null) return null;
  const chosen = decisiveChange(filingChanges(db, row.comment_id, row.change_id));
  if (chosen === undefined) {
    // A legacy row whose change row the ledger does not hold: its own stored columns are the
    // record.
    return row.change_status === null
      ? null
      : {
          id: row.change_id,
          status: row.change_status,
          outcome: row.change_outcome,
          reason: row.change_reason,
          premise: row.change_premise === 1,
        };
  }
  return {
    id: chosen.id,
    status: chosen.status,
    outcome: chosen.outcome,
    reason: chosen.reason,
    premise: chosen.premise === 1,
  };
}

function toDecision(db: Db, identityId: string, row: DecisionRow): MyDecisionDto {
  const state = stateOf(db, row);
  const outcome = outcomeOf(row, state);
  const measured = outcome === 'applied' || outcome === 'adapted';
  // BOOK-7: a premise has no ripple of its own — no waves, no paragraphs to count; it entered
  // the chapter's first edition, and saying more than that would invent facts.
  const premise = state?.premise ?? row.change_premise === 1;
  // A change read from the ledger that is not the linked row tells the outcome, not the numbers:
  // the projection in the SQL row belongs to the linked change, and no number is borrowed.
  const linked = state === null || state.id === row.change_id;
  const impactId = linked ? row.change_id : (state?.id ?? null);
  // The change's own close is when its effect became a fact; a comment without a change is
  // decided by the comment's own decision.
  const decidedAt = row.change_finished_at ?? row.decided_at ?? row.comment_created_at;
  // `recordImpact` lands a moment after the close event the frame announces, so a decision
  // read in that instant may not have its projection yet: compute it, once, for that case.
  const storedBlocks = linked ? row.blocks_changed : null;
  const impact =
    measured && !premise && storedBlocks === null && impactId !== null ? readImpact(db, impactId) : null;
  return {
    commentId: row.comment_id,
    changeId: impactId,
    chapter: row.chapter,
    premise,
    intent: measured && linked && row.change_intent !== null ? publicIntent(row.change_intent) : null,
    outcome,
    reason: reasonOf(row, outcome, state),
    chapters: measured ? chaptersOf(linked ? touchedChapters(row, impact) : (impact?.chaptersTouched ?? []), row.chapter) : [],
    waves: measured && !premise && linked ? row.waves : null,
    blocks: measured && !premise ? (storedBlocks ?? impact?.blocksChanged ?? null) : null,
    // A refusal has no share of its own to show: the number is absent, never zero.
    shareAtDecision: measured ? shareThen(db, identityId, decidedAt) : null,
    decidedAt,
    // BOOK-174: the reader's own line carries the reading of their filing, derived from the
    // stored chain — the same three lines the filing's own record prints.
    report: dispositionFieldsOf(db, row).report,
  };
}

function outcomeOf(row: DecisionRow, state: DecisionState | null): MyDecisionOutcome {
  // A failed attempt on a premise decides nothing — the attempt's code is not a
  // verdict, so its chapter's text answers for it: written means applied, unwritten means the
  // filing is still waiting. A change that decided in human words (a refusal, a supersede)
  // keeps its own mapping below, and a refusal always beats a landing.
  if (state !== null && state.premise) {
    // BOOK-206 B2 — a stop on the **current** attempt outranks the chapter's text: the premise's
    // own pass never landed, whatever another pass wrote into that chapter. A landing newer than
    // the stop is the state instead (`decisiveChange`), so it reads `applied` below.
    if (isStopped(state.status)) return 'refused';
    const landed = premiseLanded({
      premise: 1,
      status: state.status,
      reason: state.reason,
      written: row.chapter_basis === 0 && (row.chapter_blocks ?? 0) > 0,
    });
    // An attempt is not a decision: a landed premise is applied, an unsettled one still waits —
    // it never reads as «замысел не взят» on the strength of an engine code.
    if (landed) return 'applied';
    if (holdsInternalCode(state.reason)) return 'queued';
  }
  if (state === null) {
    // BOOK-206: a filing is never parked for a person any more, so the old «waits for the
    // author» outcome is gone. A legacy row (written before the boot migration re-opened it)
    // reads as a refusal with the gate's own line: the record never invents a wait.
    return row.comment_status === 'rejected' || row.comment_status === 'escalated' ? 'refused' : 'dropped';
  }
  if (WAITING.has(state.status)) return 'queued';
  // BOOK-137: paperwork is not text. A filing accepted on the frozen frame is «рассмотрено»,
  // and the reader's own record must not borrow the word a landing earned.
  if (state.outcome === 'registered') return 'registered';
  // One vocabulary for the outcome, shared with the frame and the change card. BOOK-206: the
  // reader's own vocabulary has no «waits for the author» — a change a gate stopped is «не
  // принята» with the gate's own line, exactly as a landed refusal reads. BOOK-206 B2: a stop
  // is one state (`isStopped`), the same one the filing DTO derives — `escalated` and `failed`
  // never split into two reader answers.
  if (isStopped(state.status)) return 'refused';
  const outcome = decisionOutcome({
    status: state.status as ChangeStatus,
    outcome: state.outcome as ChangeOutcome | null,
  });
  return outcome === 'escalated' ? 'refused' : outcome;
}

/** A refusal's reason is the comment's public line; a stop's is the change's own. */
function reasonOf(row: DecisionRow, outcome: MyDecisionOutcome, state: DecisionState | null): string | null {
  // A reason is a sentence a reader may read — never an internal code, on either the comment's
  // line or the change's. A filing refused under a lock has no change and speaks with its own
  // line; a change a gate stopped (outcome `refused` since BOOK-206) speaks with the change's.
  if (state === null) return readerReason(row.comment_reason);
  // BOOK-206 B2: a stopped change speaks with its own stop sentence, derived exactly as the
  // filing DTO derives it. The row's acceptance line («входит в книгу») is not a fact about a
  // pass the engine stopped, and «остаётся в очереди» is not one either.
  if (isStopped(state.status)) return stoppedLine(state.reason);
  if (outcome === 'refused') return readerReason(row.comment_reason) ?? readerReason(state.reason);
  const changeReason = readerReason(state.reason);
  // A premise that landed answers with its own acceptance line when the change row carries an
  // engine code instead of a landing: the failed attempt is not what happened to the premise.
  if (outcome === 'applied' && state.premise && holdsInternalCode(state.reason)) {
    return readerReason(row.comment_reason) ?? changeReason;
  }
  return changeReason;
}

/** Chapters as the projection knows them: the stored row, else the freshly computed one. */
function touchedChapters(row: DecisionRow, impact: { chaptersTouched: number[] } | null): number[] {
  const stored = safeJson<unknown>(row.chapters_touched);
  if (Array.isArray(stored)) {
    const list = stored.filter((value): value is number => typeof value === 'number' && Number.isInteger(value));
    if (list.length > 0) return list;
  }
  return impact === null ? [] : impact.chaptersTouched;
}

/** Chapters the ripple touched, ascending, with the origin always in it. */
function chaptersOf(touched: readonly number[], origin: number): number[] {
  return [...new Set([...touched, origin])]
    .filter((n) => n >= 1 && n <= TOTAL_CHAPTERS)
    .sort((left, right) => left - right);
}

function shareThen(db: Db, identityId: string, decidedAt: string): MeasuredShareDto | null {
  // The measurement is daily, so the nearest earlier day is the honest reading — and its
  // own `day` travels with the number, so the page can say «на 20.10», never «на момент
  // правки». A day that was never measured answers nothing at all.
  const row = db.prepare(SHARE_THEN_SQL).get(identityId, decidedAt.slice(0, 10)) as
    | { day: string; share: number }
    | undefined;
  return row === undefined ? null : { share: floorShare(row.share), day: row.day };
}
