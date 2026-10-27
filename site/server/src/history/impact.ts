/**
 * Impact analysis (§6F.5): what a change actually did, materialized at close and
 * rebuildable from `events` + `steps` + `revisions` + `overwrites`.
 *
 * Two directions the SPEC asks for: «what did change X do?» (O(1) by `change_id`) and
 * «which changes touched chapter 9?» (an index range scan on `events(chapter, hseq)`).
 * Neither reads prose.
 */

import type { ChangeImpactDto, SeamBoundary } from '@book/shared';
import { measuredRub, parseSeams } from '@book/shared';

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { safeJson } from './payload.ts';

type ImpactRow = {
  change_id: string;
  chapters_touched: string;
  chapters_rewritten: string;
  blocks_changed: number;
  chars_added: number;
  chars_removed: number;
  overwrites: number;
  seams: string;
  depth_down: number;
  depth_up: number;
  tokens: number;
  cost_rub: number;
  cost_priced: number;
  ms: number;
  from_hseq: number;
  to_hseq: number;
  computed_at: string;
};

type ChangeRow = { id: string; chapter: number; cascade_id: string | null; enqueued_at: string; finished_at: string | null };
type StepRow = {
  step_id: string;
  chapter: number | null;
  outcome: string | null;
  seams_out: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  cost_priced: number;
  chars_delta: number | null;
  hseq_from: number | null;
  hseq_to: number | null;
  at: string;
};
type CascadeRow = { id: string; status: string; depth_fwd: number; depth_bwd: number; opened_at: string; closed_at: string | null };
type RevisionRow = { added: number; changed: number; removed: number; hseq: number | null };

function fromRow(row: ImpactRow): ChangeImpactDto {
  return {
    changeId: row.change_id,
    chaptersTouched: safeJson<number[]>(row.chapters_touched) ?? [],
    chaptersRewritten: safeJson<number[]>(row.chapters_rewritten) ?? [],
    blocksChanged: row.blocks_changed,
    charsAdded: row.chars_added,
    charsRemoved: row.chars_removed,
    overwrites: row.overwrites,
    seams: safeJson<Array<{ boundary: SeamBoundary; resolved: boolean }>>(row.seams) ?? [],
    depth: { down: row.depth_down, up: row.depth_up },
    tokens: row.tokens,
    costRub: measuredRub(row.cost_rub, row.cost_priced === 1),
    ms: row.ms,
    history: { fromHseq: row.from_hseq, toHseq: row.to_hseq },
    computedAt: row.computed_at,
  };
}

function stepsOfChange(db: Db, change: ChangeRow): StepRow[] {
  return db
    .prepare(
      `SELECT step_id, chapter, outcome, seams_out, tokens_in, tokens_out, cost_rub, cost_priced, chars_delta,
              hseq_from, hseq_to, at
         FROM steps
        WHERE step_id IN (SELECT step_id FROM leases WHERE change_id = ?)
           OR cascade_id IN (SELECT id FROM cascades WHERE change_id = ?)
        ORDER BY at`,
    )
    .all(change.id, change.id) as StepRow[];
}

/** Compute the impact of one change from the rows; deterministic, so a rebuild is stable. */
export function computeImpact(db: Db, changeId: string, nowMs: number = Date.now()): ChangeImpactDto | null {
  const change = db
    .prepare('SELECT id, chapter, cascade_id, enqueued_at, finished_at FROM changes WHERE id = ?')
    .get(changeId) as ChangeRow | undefined;
  if (change === undefined) return null;

  const steps = stepsOfChange(db, change);
  const cascade = change.cascade_id === null
    ? undefined
    : (db.prepare('SELECT id, status, depth_fwd, depth_bwd, opened_at, closed_at FROM cascades WHERE id = ?').get(
        change.cascade_id,
      ) as CascadeRow | undefined);

  const touched = new Set<number>([change.chapter]);
  const rewritten = new Set<number>();
  for (const step of steps) {
    if (step.chapter === null) continue;
    touched.add(step.chapter);
    if (step.outcome === 'rewritten' || step.outcome === 'published_with_finding') rewritten.add(step.chapter);
  }

  const revisions = db
    .prepare(
      `SELECT added, changed, removed, hseq FROM revisions
        WHERE change_id = ? OR cascade_id IN (SELECT id FROM cascades WHERE change_id = ?)`,
    )
    .all(change.id, change.id) as RevisionRow[];
  const blocksChanged = revisions.reduce((sum, row) => sum + row.added + row.changed + row.removed, 0);

  let charsAdded = 0;
  let charsRemoved = 0;
  for (const step of steps) {
    const delta = step.chars_delta ?? 0;
    if (delta > 0) charsAdded += delta;
    else charsRemoved += Math.abs(delta);
  }

  const overwriteRow = db.prepare('SELECT COUNT(*) AS n FROM overwrites WHERE by_change_id = ?').get(change.id) as {
    n: number;
  };

  const seams: Array<{ boundary: SeamBoundary; resolved: boolean }> = [];
  for (const step of steps) {
    for (const seam of parseSeams(safeJson(step.seams_out))) {
      if (seams.some((known) => known.boundary === seam.boundary)) continue;
      seams.push({ boundary: seam.boundary, resolved: cascade?.status === 'closed' });
    }
  }

  const hseqs = steps.flatMap((step) => [step.hseq_from, step.hseq_to]).filter((value): value is number => value !== null);
  for (const revision of revisions) if (revision.hseq !== null) hseqs.push(revision.hseq);
  const fromHseq = hseqs.length === 0 ? 0 : Math.min(...hseqs);
  const toHseq = hseqs.length === 0 ? 0 : Math.max(...hseqs);

  const closedMs = cascade?.closed_at === null || cascade?.closed_at === undefined
    ? Date.parse(change.finished_at ?? toIso(nowMs))
    : Date.parse(cascade.closed_at);

  return {
    changeId: change.id,
    chaptersTouched: [...touched].sort((left, right) => left - right),
    chaptersRewritten: [...rewritten].sort((left, right) => left - right),
    blocksChanged,
    charsAdded,
    charsRemoved,
    overwrites: overwriteRow.n,
    seams,
    depth: { down: cascade?.depth_bwd ?? 0, up: cascade?.depth_fwd ?? 0 },
    tokens: steps.reduce((sum, step) => sum + step.tokens_in + step.tokens_out, 0),
    // BOOK-23: the projection inherits the same rule as the change DTO — only a ripple whose
    // steps were priced has a money figure, and a sum of placeholder zeros stays absent.
    costRub: measuredRub(
      steps.reduce((sum, step) => sum + step.cost_rub, 0),
      steps.some((step) => step.cost_priced === 1),
    ),
    ms: Math.max(0, closedMs - Date.parse(cascade?.opened_at ?? change.enqueued_at)),
    history: { fromHseq, toHseq },
    computedAt: toIso(nowMs),
  };
}

/** Write the projection (§6F.5: once, at close; a rebuild may overwrite it). */
export function recordImpact(db: Db, changeId: string, nowMs: number = Date.now()): ChangeImpactDto | null {
  const impact = computeImpact(db, changeId, nowMs);
  if (impact === null) return null;
  db.prepare(
    `INSERT INTO change_impact
       (change_id, chapters_touched, chapters_rewritten, blocks_changed, chars_added, chars_removed,
        overwrites, seams, depth_down, depth_up, tokens, cost_rub, cost_priced, ms, from_hseq, to_hseq, computed_at)
     VALUES
       (@changeId, @chaptersTouched, @chaptersRewritten, @blocksChanged, @charsAdded, @charsRemoved,
        @overwrites, @seams, @depthDown, @depthUp, @tokens, @costRub, @costPriced, @ms, @fromHseq, @toHseq, @computedAt)
     ON CONFLICT(change_id) DO UPDATE SET
       chapters_touched = excluded.chapters_touched,
       chapters_rewritten = excluded.chapters_rewritten,
       blocks_changed = excluded.blocks_changed,
       chars_added = excluded.chars_added,
       chars_removed = excluded.chars_removed,
       overwrites = excluded.overwrites,
       seams = excluded.seams,
       depth_down = excluded.depth_down,
       depth_up = excluded.depth_up,
       tokens = excluded.tokens,
       cost_rub = excluded.cost_rub,
       cost_priced = excluded.cost_priced,
       ms = excluded.ms,
       from_hseq = excluded.from_hseq,
       to_hseq = excluded.to_hseq,
       computed_at = excluded.computed_at`,
  ).run({
    changeId: impact.changeId,
    chaptersTouched: JSON.stringify(impact.chaptersTouched),
    chaptersRewritten: JSON.stringify(impact.chaptersRewritten),
    blocksChanged: impact.blocksChanged,
    charsAdded: impact.charsAdded,
    charsRemoved: impact.charsRemoved,
    overwrites: impact.overwrites,
    seams: JSON.stringify(impact.seams),
    depthDown: impact.depth.down,
    depthUp: impact.depth.up,
    tokens: impact.tokens,
    costRub: impact.costRub ?? 0,
    costPriced: impact.costRub === null ? 0 : 1,
    ms: impact.ms,
    fromHseq: impact.history.fromHseq,
    toHseq: impact.history.toHseq,
    computedAt: impact.computedAt,
  });
  return impact;
}

/** The materialized projection, or a computed one for a change that has not closed yet. */
export function readImpact(db: Db, changeId: string, nowMs: number = Date.now()): ChangeImpactDto | null {
  const row = db.prepare('SELECT * FROM change_impact WHERE change_id = ?').get(changeId) as ImpactRow | undefined;
  if (row !== undefined) return fromRow(row);
  return computeImpact(db, changeId, nowMs);
}

/** Rebuild every closed change's projection; returns how many were written (§6F.5, T-impact). */
export function rebuildImpacts(db: Db, nowMs: number = Date.now()): number {
  const rows = db
    .prepare(`SELECT id FROM changes WHERE finished_at IS NOT NULL ORDER BY seq`)
    .all() as Array<{ id: string }>;
  let written = 0;
  for (const row of rows) {
    if (recordImpact(db, row.id, nowMs) !== null) written += 1;
  }
  return written;
}
