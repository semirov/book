/**
 * The **public** projection of a change (ARCHITECTURE.md §6A.7, §6A.8, §6B.6, §9, §11.7).
 *
 * Built from `changes`, `cascades`, `steps` and the public label of the comment. The gate
 * table is read for two things only: the **mode** of a retroactive cause (`modes.ts`), as a
 * plain list of the three fixed words, and — BOOK-76 — the physics pass, reduced to one word
 * (`scienceCheckOf`). An editor verdict, a consultant verdict, a finding's text, a severity
 * and a role still have no representation in these types at all.
 *
 * Three aggregates are public on purpose — the iteration number («правка 3»), whether a
 * finding survived («замечание сохранено») and the modes a cause was filed under; all are
 * facts about the ripple, not the hidden roles' words (§6B.6). BOOK-76 adds a fourth fact
 * of the same kind: whether the physics pass held, which is the one gate fact the reader is
 * told (§BOOK-DOC-52 §3).
 */

import {
  PUBLIC_INTENT_MAX_CHARS,
  measuredRub,
  normalizeInterventionKind,
  parseSeams,
  readerReason,
  seamReason,
  type ChangeCostDto,
  type ChangeDto,
  type ChangeOutcome,
  type ChangeStatus,
  type ChangeStepDto,
  type ChangeSummaryDto,
  type PublicRelevance,
  type PublicSeam,
  type RetroMode,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { chapterWritten, premiseLanded } from '../comments/repo.ts';
import { modesOfSteps } from './modes.ts';
import { stepsOfCascade } from './reader.ts';
import { wingsOf, wingSteps } from './wings.ts';
import {
  boundaryOf,
  chapterOfStep,
  countRows,
  safeJson,
  type CascadeRow,
  type ChangeRow,
  type StepRow,
} from './rows.ts';

/** §10.3a: the quoted intent is capped on every public surface. */
export function publicIntent(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= PUBLIC_INTENT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, PUBLIC_INTENT_MAX_CHARS - 1)}…`;
}

/** Public display name of a comment's author; `null` until M5 stores identities. */
export function readAuthor(db: Db, commentId: string | null): string | null {
  if (commentId === null) return null;
  const row = db.prepare('SELECT author FROM comments WHERE id = ?').get(commentId) as { author: string } | undefined;
  return row?.author ?? null;
}

export function readChangeRow(db: Db, id: string): ChangeRow | undefined {
  return db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as ChangeRow | undefined;
}

export function readCascadeRow(db: Db, id: string): CascadeRow | undefined {
  return db.prepare('SELECT * FROM cascades WHERE id = ?').get(id) as CascadeRow | undefined;
}

export function readStepRow(db: Db, stepId: string): StepRow | undefined {
  return db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId) as StepRow | undefined;
}

/** Public relevance of a change row, for `change:processing` (§10.3a). */
export function readRelevance(raw: string | null): PublicRelevance | null {
  return publicRelevance(raw);
}

function publicRelevance(raw: string | null): PublicRelevance | null {
  const value = safeJson<PublicRelevance>(raw);
  if (value === null || typeof value !== 'object') return null;
  return {
    grade: value.grade,
    revAtRecord: value.revAtRecord,
    revNow: value.revNow,
    anchor: value.anchor,
    applies: value.applies,
    overlap: value.overlap,
    chapterRewritten: value.chapterRewritten === true,
    evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 6).map((line) => seamReason(line)) : [],
    reason: typeof value.reason === 'string' ? seamReason(value.reason) : null,
  };
}

/** Steps that belong to a change: its ripple's steps plus the origin step (which has no cascade). */
export function stepsOfChange(db: Db, change: ChangeRow): StepRow[] {
  const rows: StepRow[] = [];
  if (change.cascade_id !== null) rows.push(...stepsOfCascade(db, change.cascade_id));
  const origin = db
    .prepare(
      `SELECT s.* FROM steps s JOIN leases l ON l.step_id = s.step_id
        WHERE l.change_id = ? AND s.cascade_id IS NULL ORDER BY s.seq, s.at`,
    )
    .all(change.id) as StepRow[];
  for (const step of origin) if (!rows.some((known) => known.step_id === step.step_id)) rows.push(step);
  return rows.sort((left, right) => left.at.localeCompare(right.at) || left.seq - right.seq);
}

function publicStep(step: StepRow): ChangeStepDto {
  return {
    seq: step.seq,
    wave: step.wave,
    wing: step.lane === 'backward' ? 'downward' : step.lane === 'forward' ? 'upward' : null,
    chapter: chapterOfStep(step),
    pass: step.pass,
    boundary: boundaryOf(step.boundary, step.pass, step.chapter),
    outcome: step.outcome,
    revBefore: step.rev_before,
    revAfter: step.rev_after,
    seamsIn: parseSeams(safeJson(step.seams_in)),
    seamsOut: parseSeams(safeJson(step.seams_out)),
    charsDelta: step.chars_delta,
    note: step.note,
    at: step.at,
    cycles: step.cycle,
    findingSurvived: step.outcome === 'published_with_finding',
  };
}

function publicCascadeOf(
  cascade: CascadeRow | undefined,
  steps: StepRow[],
  nowMs: number,
  origin: number,
  modes: RetroMode[],
): ChangeDto['cascade'] {
  if (cascade === undefined) return null;
  const rewritten = new Set<number>();
  const checked = new Set<number>();
  for (const step of steps) {
    if (step.chapter === null) continue;
    if (step.outcome === 'rewritten' || step.outcome === 'published_with_finding') rewritten.add(step.chapter);
    else if (step.outcome === 'holds' || step.outcome === 'evaluated') checked.add(step.chapter);
  }
  for (const n of rewritten) checked.delete(n);

  const seams: PublicSeam[] = [];
  for (const step of steps) {
    for (const seam of parseSeams(safeJson(step.seams_out))) {
      if (!seams.some((known) => known.boundary === seam.boundary)) {
        seams.push({ boundary: seam.boundary, reason: seam.reason, resolved: cascade.status === 'closed' });
      }
    }
  }
  const closedMs = cascade.closed_at === null ? nowMs : Date.parse(cascade.closed_at);
  return {
    id: cascade.id,
    status: cascade.status,
    outcome: cascade.outcome,
    wave: cascade.wave,
    depth: { forward: cascade.depth_fwd, backward: cascade.depth_bwd },
    chaptersChecked: [...checked].sort((left, right) => left - right),
    chaptersRewritten: [...rewritten].sort((left, right) => left - right),
    seams,
    wings: wingsOf(wingSteps(steps), origin, cascade.status),
    modes,
    gates: {
      cycles: steps.reduce((sum, step) => sum + step.cycle, 0),
      findingSurvived: steps.some((step) => step.outcome === 'published_with_finding'),
    },
    tokens: { total: steps.reduce((sum, step) => sum + step.tokens_in + step.tokens_out, 0) },
    ms: Math.max(0, closedMs - Date.parse(cascade.opened_at)),
  };
}

/**
 * BOOK-76 — the physics pass as one public word. `'failed'` if any step was answered `GAP`
 * (a blockerless `GAP` is stored as `HOLDS`, so a `GAP` row is always a blocker);
 * `'passed'` only when every step of the change has a consultant row; `null` otherwise —
 * no steps, or a step not yet answered. The role name never leaves web copy.
 */
function scienceCheckOf(db: Db, steps: readonly StepRow[]): 'passed' | 'failed' | null {
  if (steps.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT step_id, verdict FROM gate_verdicts WHERE role = 'consultant'
        AND step_id IN (${steps.map(() => '?').join(',')})`,
    )
    .all(...steps.map((step) => step.step_id)) as Array<{ step_id: string; verdict: 'HOLDS' | 'GAP' }>;
  if (rows.some((row) => row.verdict === 'GAP')) return 'failed';
  return rows.length === steps.length ? 'passed' : null;
}

function positionOf(db: Db, change: ChangeRow): number | null {
  // BOOK-7: a premise waits for its chapter's first pass, not for the lane — it has no place
  // in the queue and must not shift anybody else's.
  if (change.status !== 'pending' || change.premise === 1) return null;
  return countRows(
    db,
    `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0 AND seq <= ?`,
    change.seq,
  );
}

/**
 * The cost as the public DTO carries it: the model and the tokens when they exist, and the
 * money only when the row is marked as priced (`cost_priced`). Nothing was spent and nothing
 * was measured is the same absence — `null`.
 */
function publicCost(change: ChangeRow): ChangeCostDto | null {
  if (change.model === null && change.tokens_in + change.tokens_out === 0) return null;
  return {
    model: change.model,
    tokensIn: change.tokens_in,
    tokensOut: change.tokens_out,
    rub: measuredRub(change.cost_rub, change.cost_priced === 1),
  };
}

/** `GET /api/changes/:id` — the change card's one call (§9, §11.7). */
export function readChange(db: Db, id: string, nowMs: number): ChangeDto | null {
  const change = readChangeRow(db, id);
  if (change === undefined) return null;
  const steps = stepsOfChange(db, change);
  const cascade = change.cascade_id === null ? undefined : readCascadeRow(db, change.cascade_id);
  const modes = modesOfSteps(db, steps.map((step) => step.step_id));
  const cascadeSteps = cascade === undefined ? [] : stepsOfCascade(db, cascade.id);
  const applied = new Map<number, number>();
  for (const step of steps) {
    if (step.chapter !== null && step.rev_after !== null) applied.set(step.chapter, step.rev_after);
  }
  const hseqFrom = steps.map((step) => step.hseq_from).filter((value): value is number => typeof value === 'number');
  const hseqTo = steps.map((step) => step.hseq_to).filter((value): value is number => typeof value === 'number');
  return {
    id: change.id,
    seq: change.seq,
    kind: change.kind,
    // BOOK-16: the kind the reader declared, as the card prints it — or null when there is
    // none to print (a continuity change, a comment stored before BOOK-16).
    interventionKind: normalizeInterventionKind(change.intervention_kind),
    chapter: change.chapter,
    intent: publicIntent(change.intent),
    premise: change.premise === 1,
    // The one derived landing fact — the change's own answer plus the book's, from
    // `premiseLanded` (a refusal beats a landing; a failed attempt decides nothing).
    premiseLanded: premiseLanded({
      premise: change.premise,
      status: change.status,
      reason: change.reason,
      written: chapterWritten(db, change.chapter),
    }),
    source: { commentId: change.source_comment, author: readAuthor(db, change.source_comment) },
    base: { rev: change.base_rev },
    scopeHint: change.scope_hint,
    status: change.status,
    outcome: (change.outcome as ChangeOutcome | null) ?? null,
    // A reason is a sentence for a reader: an internal code never leaves the server.
    reason: readerReason(change.reason),
    position: positionOf(db, change),
    relevance: publicRelevance(change.relevance),
    cascade:
      cascade === undefined
        ? null
        : publicCascadeOf(cascade, cascadeSteps, nowMs, change.chapter, modes),
    modes,
    steps: steps.map(publicStep),
    appliedRevs: [...applied]
      .map(([chapter, rev]) => ({ chapter, rev }))
      .sort((left, right) => left.chapter - right.chapter),
    cost: publicCost(change),
    // BOOK-76: the one gate fact a reader is told — the physics pass, as one word.
    scienceCheck: scienceCheckOf(db, steps),
    history:
      hseqFrom.length > 0 && hseqTo.length > 0
        ? { fromHseq: Math.min(...hseqFrom), toHseq: Math.max(...hseqTo) }
        : null,
    enqueuedAt: change.enqueued_at,
    startedAt: change.started_at,
    decidedAt: change.finished_at,
  };
}

export type ChangeFilter = {
  status?: ChangeStatus;
  chapter?: number;
  limit?: number;
  before?: number;
};

function summaryOf(db: Db, change: ChangeRow): ChangeSummaryDto {
  const steps = stepsOfChange(db, change);
  const chapters: number[] = [change.chapter];
  const rewritten: number[] = [];
  for (const step of steps) {
    if (step.chapter === null) continue;
    if (!chapters.includes(step.chapter)) chapters.push(step.chapter);
    if (
      (step.outcome === 'rewritten' || step.outcome === 'published_with_finding') &&
      !rewritten.includes(step.chapter)
    ) {
      rewritten.push(step.chapter);
    }
  }
  const cascade = change.cascade_id === null ? undefined : readCascadeRow(db, change.cascade_id);
  return {
    id: change.id,
    seq: change.seq,
    chapter: change.chapter,
    intent: publicIntent(change.intent),
    premise: change.premise === 1,
    // The same derived fact the card carries — a landed premise says «внесено».
    premiseLanded: premiseLanded({
      premise: change.premise,
      status: change.status,
      reason: change.reason,
      written: chapterWritten(db, change.chapter),
    }),
    status: change.status,
    outcome: (change.outcome as ChangeOutcome | null) ?? null,
    reason: readerReason(change.reason),
    position: positionOf(db, change),
    enqueuedAt: change.enqueued_at,
    decidedAt: change.finished_at,
    chapters,
    rewritten: rewritten.sort((left, right) => left - right),
    steps: steps.length,
    modes: modesOfSteps(db, steps.map((step) => step.step_id)),
    cascade: cascade === undefined ? null : { id: cascade.id, status: cascade.status, outcome: cascade.outcome },
  };
}

/** `GET /api/changes` — newest first, cursor by `seq` (§9). */
export function listChanges(db: Db, filter: ChangeFilter = {}): ChangeSummaryDto[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.chapter !== undefined) {
    where.push('chapter = ?');
    params.push(filter.chapter);
  }
  if (filter.before !== undefined) {
    where.push('seq < ?');
    params.push(filter.before);
  }
  const limit = Math.min(50, Math.max(1, filter.limit ?? 20));
  const sql = `SELECT seq, id, kind, chapter, intent, premise, source_comment, base_rev, scope_hint, status,
      relevance, outcome, reason, cascade_id, model, tokens_in, tokens_out, cost_rub,
      enqueued_at, started_at, finished_at, attempts
    FROM changes${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY seq DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as ChangeRow[];
  return rows.map((row) => summaryOf(db, row));
}

/** The decision frame's outcome vocabulary, derived from the row (§10.3a). */
export function decisionOutcome(
  change: Pick<ChangeRow, 'status' | 'outcome'> | Pick<ChangeDto, 'status' | 'outcome'>,
): 'applied' | 'adapted' | 'dropped' | 'superseded' | 'escalated' | 'failed' {
  if (change.status === 'escalated') return 'escalated';
  if (change.status === 'failed') return 'failed';
  if (change.status === 'void') return change.outcome === 'superseded' ? 'superseded' : 'dropped';
  if (change.outcome === 'adapted') return 'adapted';
  return 'applied';
}

/** Distinct chapters a change touched, origin first; used by `change:decided`. */
export function chaptersOfChange(db: Db, change: ChangeRow): number[] {
  const chapters = [change.chapter];
  for (const step of stepsOfChange(db, change)) {
    if (step.chapter !== null && !chapters.includes(step.chapter)) chapters.push(step.chapter);
  }
  return chapters;
}
