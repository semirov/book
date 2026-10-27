/**
 * The engine's tables, one place (ARCHITECTURE.md §8).
 *
 * Hand-written SQL over `better-sqlite3` — the same choice as the site (ADR-001): there is
 * no ORM to fight, and every statement here is one fact the engine owns. Only `book-engine`
 * writes these tables; the site reads them.
 */

import type { InterventionKind } from '@book/shared';

import type { Db } from '../db/db.ts';
import { insertRow, updateRow } from './rows.ts';

export { getMeta, setMeta } from './rows.ts';

export type ChangeRow = {
  seq: number;
  id: string;
  kind: 'reader_edit' | 'accepted_comment' | 'continuity' | 'operator';
  /** BOOK-16 — the kind of the intervention that raised this change; null for the rest. */
  intervention_kind: InterventionKind | null;
  chapter: number;
  anchor: string | null;
  intent: string;
  intent_original: string | null;
  proposed_text: string | null;
  source_comment: string | null;
  source_session: string | null;
  base_rev: number;
  base_sha256: string;
  base_blocks: string;
  scope_hint: 'phrase' | 'chapter';
  /** BOOK-7 — 1 = a chapter-level premise (`base_rev 0`, no anchor), never claimed by the lane. */
  premise: number;
  status: 'pending' | 'processing' | 'stale' | 'done' | 'void' | 'escalated' | 'failed';
  relevance: string | null;
  outcome: string | null;
  reason: string | null;
  cascade_id: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  /** BOOK-23: 1 = `cost_rub` is a measurement; 0 = the placeholder zero of an unpriced row. */
  cost_priced: number;
  cost_usd: number;
  tokens: number;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
};

export type StepRow = {
  step_id: string;
  cascade_id: string | null;
  seq: number;
  wave: number;
  lane: 'forward' | 'backward' | null;
  pass: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';
  chapter: number | null;
  boundary: string;
  /** BOOK-7 — the premise this draft step consumes; null for every other pass. */
  premise_change: string | null;
  outcome:
    | 'rewritten'
    | 'holds'
    | 'published_with_finding'
    | 'evaluated'
    | 'escalated'
    | 'interrupted'
    | null;
  rev_before: number | null;
  rev_after: number | null;
  seams_in: string | null;
  seams_out: string | null;
  blocks_touched: number | null;
  chars_delta: number | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  /** BOOK-23: 1 = `cost_rub` is a measurement, 0 = never priced. */
  cost_priced: number;
  hseq_from: number | null;
  hseq_to: number | null;
  lease_id: string | null;
  session: string | null;
  at: string;
  ms: number | null;
  note: string | null;
  cycle: number;
  last_findings: string | null;
  start_sha: string | null;
  landed_at: string | null;
  landed_sha: string | null;
  pre_blocks: string | null;
  rights_scan: string | null;         // BOOK-61 — Gate B's scan of the new blocks, as JSON
  closed_at: string | null;
};

export type LeaseRow = {
  id: string;
  step_id: string;
  change_id: string | null;
  cascade_id: string | null;
  lane: 'forward' | 'backward' | null;
  chapter: number | null;
  is_front: number;
  kind: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';
  session: string;
  expected_rev: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
};

export type CascadeRow = {
  id: string;
  change_id: string;
  status: 'open' | 'closed' | 'escalated' | 'aborted';
  outcome: string | null;
  wave: number;
  depth_fwd: number;
  depth_bwd: number;
  step_count: number;
  tokens: number;
  budget: string;
  opened_at: string;
  closed_at: string | null;
};

export type VerdictRow = {
  step_id: string;
  /** `rights` is the conditional Gate B role (BOOK-61); the table couples it to its verdict. */
  role: 'editor' | 'consultant' | 'rights';
  verdict: 'HOLDS' | 'GAP' | 'CLEAR' | 'REFUSED';
  findings: string;
  cycles: number;
  model: string;
  tokens_in: number;
  tokens_out: number;
  at: string;
  late: number;
};

export type DispatchRow = {
  step_id: string;
  role: 'editor' | 'consultant' | 'rights';   // BOOK-61: `rights` only when a scan flagged
  session: string;
  dispatched_at: string;
  expires_at: string;
};

export type LaneRow = { id: number; holder: string | null; heartbeat_at: string | null };

// ── changes ──────────────────────────────────────────────────────────────────
export type NewChange = {
  id: string;
  kind: string;
  /** BOOK-16 — the intervention's kind, carried from the comment; null for other changes. */
  interventionKind: InterventionKind | null;
  chapter: number;
  anchor: string | null;
  intent: string;
  proposedText: string | null;
  sourceComment: string | null;
  sourceSession: string | null;
  baseRev: number;
  baseSha: string;
  baseBlocks: string;
  scopeHint: string;
  /** BOOK-7 — 1 when the chapter had no text and the intervention is its premise. */
  premise: 0 | 1;
  /** Defaults to a queued change; a premise admitted after another one is born superseded. */
  status?: 'pending' | 'void';
  outcome?: string | null;
  reason?: string | null;
  finishedAt?: string | null;
  enqueuedAt: string;
};

export function insertChange(db: Db, change: NewChange): number {
  const row = {
    status: 'pending',
    outcome: null,
    reason: null,
    finishedAt: null,
    ...change,
  };
  const result = db
    .prepare(
      `INSERT INTO changes
         (id, kind, intervention_kind, chapter, anchor, intent, proposed_text, source_comment, source_session,
          base_rev, base_sha256, base_blocks, scope_hint, premise, status, outcome, reason, finished_at, enqueued_at)
       VALUES
         (@id, @kind, @interventionKind, @chapter, @anchor, @intent, @proposedText, @sourceComment, @sourceSession,
          @baseRev, @baseSha, @baseBlocks, @scopeHint, @premise, @status, @outcome, @reason, @finishedAt, @enqueuedAt)`,
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

export function getChange(db: Db, id: string): ChangeRow | undefined {
  return db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as ChangeRow | undefined;
}

export function headPending(db: Db): ChangeRow | undefined {
  // BOOK-7: a premise waits for its chapter's first pass, not for the lane — it is never the
  // head of the FIFO queue and can never stall the change behind it.
  return db
    .prepare(`SELECT * FROM changes WHERE status = 'pending' AND premise = 0 ORDER BY seq LIMIT 1`)
    .get() as ChangeRow | undefined;
}

export function listPending(db: Db): ChangeRow[] {
  return db.prepare(`SELECT * FROM changes WHERE status = 'pending' ORDER BY seq`).all() as ChangeRow[];
}

export function countPending(db: Db): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0`).get() as { n: number }
  ).n;
}

export function countProcessing(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'processing'`).get() as { n: number }).n;
}

export function updateChange(db: Db, id: string, patch: Record<string, string | number | null>): void {
  updateRow(db, 'changes', 'id', id, patch);
}

// ── cascades ─────────────────────────────────────────────────────────────────

export type NewCascade = {
  id: string;
  changeId: string;
  budget: string;
  openedAt: string;
};

export function insertCascade(db: Db, cascade: NewCascade): void {
  insertRow(db, 'cascades', {
    id: cascade.id,
    change_id: cascade.changeId,
    status: 'open',
    wave: 0,
    depth_fwd: 0,
    depth_bwd: 0,
    step_count: 0,
    tokens: 0,
    budget: cascade.budget,
    opened_at: cascade.openedAt,
  });
}

export function getCascade(db: Db, id: string): CascadeRow | undefined {
  return db.prepare('SELECT * FROM cascades WHERE id = ?').get(id) as CascadeRow | undefined;
}

export function updateCascade(db: Db, id: string, patch: Record<string, string | number | null>): void {
  updateRow(db, 'cascades', 'id', id, patch);
}

export function getOpenCascade(db: Db): CascadeRow | undefined {
  return db.prepare(`SELECT * FROM cascades WHERE status = 'open' ORDER BY opened_at LIMIT 1`).get() as
    | CascadeRow
    | undefined;
}

export function listOpenCascades(db: Db): CascadeRow[] {
  return db.prepare(`SELECT * FROM cascades WHERE status = 'open' ORDER BY opened_at`).all() as CascadeRow[];
}

// ── steps ────────────────────────────────────────────────────────────────────

export type NewStep = {
  stepId: string;
  cascadeId: string | null;
  seq: number;
  wave: number;
  lane: 'forward' | 'backward' | null;
  pass: string;
  chapter: number | null;
  boundary: string;
  seamsIn: string;
  revBefore: number | null;
  at: string;
  /** BOOK-7 — the premise a draft step consumes; omitted for every other pass. */
  premiseChange?: string | null;
};

export function insertStep(db: Db, step: NewStep): void {
  insertRow(db, 'steps', {
    step_id: step.stepId,
    cascade_id: step.cascadeId,
    seq: step.seq,
    wave: step.wave,
    lane: step.lane,
    pass: step.pass,
    chapter: step.chapter,
    boundary: step.boundary,
    premise_change: step.premiseChange ?? null,
    seams_in: step.seamsIn,
    rev_before: step.revBefore,
    at: step.at,
    cycle: 0,
  });
}

export function getStep(db: Db, stepId: string): StepRow | undefined {
  return db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId) as StepRow | undefined;
}

export function updateStep(db: Db, stepId: string, patch: Record<string, string | number | null>): void {
  updateRow(db, 'steps', 'step_id', stepId, patch);
}

export function listCascadeSteps(db: Db, cascadeId: string): StepRow[] {
  return db.prepare('SELECT * FROM steps WHERE cascade_id = ? ORDER BY seq').all(cascadeId) as StepRow[];
}

export function listOpenSteps(db: Db): StepRow[] {
  return db.prepare('SELECT * FROM steps WHERE outcome IS NULL ORDER BY at').all() as StepRow[];
}

/** Every step that ever belonged to a change: its origin, its ripple, its edges. */
export function stepsOfChange(db: Db, changeId: string): StepRow[] {
  return db
    .prepare(
      `SELECT DISTINCT steps.* FROM steps
         LEFT JOIN leases ON leases.step_id = steps.step_id
         LEFT JOIN cascades ON cascades.id = steps.cascade_id
        WHERE leases.change_id = ? OR cascades.change_id = ?
        ORDER BY steps.at, steps.seq`,
    )
    .all(changeId, changeId) as StepRow[];
}

export function countOpenSteps(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM steps WHERE outcome IS NULL').get() as { n: number }).n;
}

// ── leases ───────────────────────────────────────────────────────────────────

export type NewLease = {
  id: string;
  stepId: string;
  changeId: string | null;
  cascadeId: string | null;
  lane: 'forward' | 'backward' | null;
  chapter: number | null;
  isFront: 0 | 1;
  kind: string;
  session: string;
  expectedRev: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
};

export function insertLease(db: Db, lease: NewLease): void {
  insertRow(db, 'leases', {
    id: lease.id,
    step_id: lease.stepId,
    change_id: lease.changeId,
    cascade_id: lease.cascadeId,
    lane: lease.lane,
    chapter: lease.chapter,
    is_front: lease.isFront,
    kind: lease.kind,
    session: lease.session,
    expected_rev: lease.expectedRev,
    acquired_at: lease.acquiredAt,
    heartbeat_at: lease.heartbeatAt,
    expires_at: lease.expiresAt,
  });
}

export function getLease(db: Db, id: string): LeaseRow | undefined {
  return db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as LeaseRow | undefined;
}

export function updateLease(db: Db, id: string, patch: Record<string, string | number | null>): void {
  updateRow(db, 'leases', 'id', id, patch);
}

export function liveLeaseForStep(db: Db, stepId: string): LeaseRow | undefined {
  return db.prepare('SELECT * FROM leases WHERE step_id = ? AND released_at IS NULL').get(stepId) as
    | LeaseRow
    | undefined;
}

export function liveLeaseForSession(db: Db, session: string): LeaseRow[] {
  return db
    .prepare('SELECT * FROM leases WHERE session = ? AND released_at IS NULL ORDER BY acquired_at')
    .all(session) as LeaseRow[];
}

export function liveLeases(db: Db): LeaseRow[] {
  return db.prepare('SELECT * FROM leases WHERE released_at IS NULL').all() as LeaseRow[];
}

export function expiredLeases(db: Db, nowIso: string): LeaseRow[] {
  return db
    .prepare('SELECT * FROM leases WHERE released_at IS NULL AND expires_at <= ? ORDER BY expires_at')
    .all(nowIso) as LeaseRow[];
}

// ── gates ────────────────────────────────────────────────────────────────────

export function getVerdict(db: Db, stepId: string, role: string): VerdictRow | undefined {
  return db.prepare('SELECT * FROM gate_verdicts WHERE step_id = ? AND role = ?').get(stepId, role) as
    | VerdictRow
    | undefined;
}

export function listVerdicts(db: Db, stepId: string): VerdictRow[] {
  return db
    .prepare(
      `SELECT * FROM gate_verdicts WHERE step_id = ?
        ORDER BY CASE role WHEN 'editor' THEN 0 ELSE 1 END`,
    )
    .all(stepId) as VerdictRow[];
}

export function upsertVerdict(db: Db, verdict: Omit<VerdictRow, 'late'> & { late: number }): void {
  db.prepare(
    `INSERT INTO gate_verdicts (step_id, role, verdict, findings, cycles, model, tokens_in, tokens_out, at, late)
     VALUES (@step_id, @role, @verdict, @findings, @cycles, @model, @tokens_in, @tokens_out, @at, @late)
     ON CONFLICT(step_id, role) DO UPDATE SET
       verdict = excluded.verdict, findings = excluded.findings, cycles = excluded.cycles,
       model = excluded.model, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
       at = excluded.at, late = excluded.late`,
  ).run(verdict);
}

export function deleteVerdicts(db: Db, stepId: string): void {
  db.prepare('DELETE FROM gate_verdicts WHERE step_id = ?').run(stepId);
}

export function getDispatch(db: Db, stepId: string, role: string): DispatchRow | undefined {
  return db.prepare('SELECT * FROM gate_dispatches WHERE step_id = ? AND role = ?').get(stepId, role) as
    | DispatchRow
    | undefined;
}

export function upsertDispatch(db: Db, dispatch: DispatchRow): void {
  db.prepare(
    `INSERT INTO gate_dispatches (step_id, role, session, dispatched_at, expires_at)
     VALUES (@step_id, @role, @session, @dispatched_at, @expires_at)
     ON CONFLICT(step_id, role) DO UPDATE SET
       session = excluded.session, dispatched_at = excluded.dispatched_at, expires_at = excluded.expires_at`,
  ).run(dispatch);
}

export function deleteDispatch(db: Db, stepId: string, role: string): void {
  db.prepare('DELETE FROM gate_dispatches WHERE step_id = ? AND role = ?').run(stepId, role);
}

export function deleteDispatches(db: Db, stepId: string): void {
  db.prepare('DELETE FROM gate_dispatches WHERE step_id = ?').run(stepId);
}

export function listDispatches(db: Db, stepId: string): DispatchRow[] {
  return db.prepare('SELECT * FROM gate_dispatches WHERE step_id = ?').all(stepId) as DispatchRow[];
}

// ── lane ─────────────────────────────────────────────────────────────────────

export function readLane(db: Db): LaneRow {
  return db.prepare('SELECT * FROM lane WHERE id = 1').get() as LaneRow;
}

/** The FIFO mutex: at most one holder, and claiming is a conditional UPDATE, not a check. */
export function claimLaneRow(db: Db, holder: string, at: string): boolean {
  return (
    db.prepare('UPDATE lane SET holder = ?, heartbeat_at = ? WHERE id = 1 AND holder IS NULL').run(holder, at)
      .changes === 1
  );
}

export function heartbeatLaneRow(db: Db, holder: string, at: string): boolean {
  return (
    db.prepare('UPDATE lane SET heartbeat_at = ? WHERE id = 1 AND holder = ?').run(at, holder).changes === 1
  );
}

export function releaseLaneRow(db: Db, holder: string): boolean {
  return db.prepare('UPDATE lane SET holder = NULL, heartbeat_at = NULL WHERE id = 1 AND holder = ?').run(holder)
    .changes === 1;
}

export function forceReleaseLane(db: Db): void {
  db.prepare('UPDATE lane SET holder = NULL, heartbeat_at = NULL WHERE id = 1').run();
}
