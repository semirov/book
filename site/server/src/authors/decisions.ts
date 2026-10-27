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
  seamReason,
  type ChangeOutcome,
  type ChangeStatus,
  type MeasuredShareDto,
  type MyDecisionDto,
  type MyDecisionOutcome,
  type MyDecisionsDto,
} from '@book/shared';

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
  waves: number | null;
  chapters_touched: string | null;
  blocks_changed: number | null;
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
         ch.id           AS change_id,
         ch.premise      AS change_premise,
         ch.status       AS change_status,
         ch.outcome      AS change_outcome,
         ch.reason       AS change_reason,
         ch.intent       AS change_intent,
         ch.finished_at  AS change_finished_at,
         cas.wave        AS waves,
         imp.chapters_touched,
         imp.blocks_changed
    FROM comments c
    LEFT JOIN changes ch       ON ch.id = c.change_id
    LEFT JOIN cascades cas     ON cas.id = ch.cascade_id
    LEFT JOIN change_impact imp ON imp.change_id = ch.id
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

function toDecision(db: Db, identityId: string, row: DecisionRow): MyDecisionDto {
  const outcome = outcomeOf(row);
  const measured = outcome === 'applied' || outcome === 'adapted';
  // BOOK-7: a premise has no ripple of its own — no waves, no paragraphs to count; it entered
  // the chapter's first edition, and saying more than that would invent facts.
  const premise = row.change_premise === 1;
  // The change's own close is when its effect became a fact; a comment without a change is
  // decided by the comment's own decision.
  const decidedAt = row.change_finished_at ?? row.decided_at ?? row.comment_created_at;
  // `recordImpact` lands a moment after the close event the frame announces, so a decision
  // read in that instant may not have its projection yet: compute it, once, for that case.
  const impact =
    measured && !premise && row.blocks_changed === null && row.change_id !== null
      ? readImpact(db, row.change_id)
      : null;
  return {
    commentId: row.comment_id,
    changeId: row.change_id,
    chapter: row.chapter,
    premise,
    intent: measured && row.change_intent !== null ? publicIntent(row.change_intent) : null,
    outcome,
    reason: reasonOf(row, outcome),
    chapters: measured ? chaptersOf(touchedChapters(row, impact), row.chapter) : [],
    waves: measured && !premise ? row.waves : null,
    blocks: measured && !premise ? (row.blocks_changed ?? impact?.blocksChanged ?? null) : null,
    // A refusal has no share of its own to show: the number is absent, never zero.
    shareAtDecision: measured ? shareThen(db, identityId, decidedAt) : null,
    decidedAt,
  };
}

function outcomeOf(row: DecisionRow): MyDecisionOutcome {
  if (row.change_id === null || row.change_status === null) {
    return row.comment_status === 'rejected' ? 'refused' : 'dropped';
  }
  if (WAITING.has(row.change_status)) return 'queued';
  // One vocabulary for the outcome, shared with the frame and the change card.
  return decisionOutcome({
    status: row.change_status as ChangeStatus,
    outcome: row.change_outcome as ChangeOutcome | null,
  });
}

/** A refusal's reason is the comment's public line; a stop's is the change's own. */
function reasonOf(row: DecisionRow, outcome: MyDecisionOutcome): string | null {
  if (outcome === 'refused' || row.change_id === null) {
    return row.comment_reason === null ? null : seamReason(row.comment_reason);
  }
  return row.change_reason === null ? null : seamReason(row.change_reason);
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
