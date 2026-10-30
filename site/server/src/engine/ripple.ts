/**
 * The ripple, engine side (BOOK-173, BOOK-DOC-75 §3, §7).
 *
 * **Why the plan is computed here and not in the writer.** The closure is a read of the ledger —
 * `facts`, `mentions`, `edges`, `change_plans` — and the writer owns no database: it writes prose
 * and asks the engine about state. `land` is the one moment the engine already holds both sides of
 * the edit (the pre-image hashes from `start`, the texts of the two revisions), and it is the last
 * moment before the gates spend anything. So `land` plans: seeds are the facts mentioned inside the
 * blocks this landing changed, the walk is `buildPlan`'s, and the answer travels back to the writer
 * on the land response as an additive field.
 *
 * **The engine calls no model here** (ADR-012). Seeds, closure, classification, price and the
 * three outcomes are a function of rows; the one model call of the ripple — the causality judge —
 * is the writer lane's, over the closure only (`writer/ripple/judge.ts`). Nothing in this file
 * talks to a provider, a socket or a clock it was not handed.
 *
 * **What this file also owns.** The ripple's own door: `openRippleStep` opens one chapter's
 * step for a change that is already `ripple`, and `rippleOutcomeFor` is the one place that says a
 * change which stood the closure is `ripple` rather than `applied`.
 */

import { appendEvent } from '../history/log.ts';
import { listBlocks } from '../db/repo/chapters.ts';
import type { Db } from '../db/db.ts';
import { rebindMentions, retireUnassertedFacts } from '../ledger/graph/land.ts';
import {
  buildPlan,
  changedChars,
  defaultBounds,
  parkPlan,
  storePlan,
  PLAN_CLAIM_TTL_MS,
  type PlanContext,
  type PlanOutcome,
  type RipplePlan,
} from '../ledger/graph/plan.ts';
import { readSnapshot } from '../versions/snapshots.ts';
import { toIso } from '../util/time.ts';
import { newStepId } from '../util/ulid.ts';
import { changeForStep, preBlocksOf, boundaryFor } from './helpers.ts';
import { currentRev } from './closeRead.ts';
import { acquireLease } from './leases.ts';
import * as store from './store.ts';
import { readChapterRows } from './text.ts';
import { writerAssignment } from './trace.ts';
import { refuse, type EngineDeps } from './types.ts';
import { readerReason } from '../writer/reasons.ts';
import { TOTAL_CHAPTERS, directionOf, type WriterAssignment } from '@book/shared';

/**
 * The share of a chapter a landing may change and still be a **patch**. The same bound the writer's
 * applier enforces (`WRITER_PATCH_MAX_FRACTION`, 0.15 of the chapter, BOOK-DOC-75 §6): a landing
 * above it is a rewrite, and a rewrite is not a patch whose consequences a ripple can walk.
 */
export const RIPPLE_PATCH_FRACTION = 0.15;

/** The plan `land` returns: the frozen answer the writer reacts to. */
export type LandingPlan = { plan: RipplePlan; planId: string };

/** One drainable plan: its row, the change it belongs to and the frozen closure. */
export type DrainablePlan = { planRowId: string; plan: RipplePlan; iterations: number };

type RevisionRow = { snapshot: string };

/**
 * The whole chapter text of a revision, from the content-addressed store (§8.3). `''` when the
 * row or the file is gone: a landing with no readable pre-image has no «before», and the plan
 * still stands — its seeds are facts, not a diff.
 */
function previousText(deps: EngineDeps, chapter: number, rev: number): string {
  const row = deps.db
    .prepare('SELECT snapshot FROM revisions WHERE chapter = ? AND rev = ?')
    .get(chapter, rev) as RevisionRow | undefined;
  if (row === undefined) return '';
  return readSnapshot(deps.config.dataDir, row.snapshot) ?? '';
}

/**
 * The blocks this landing replaced: a block id is content-derived, so an edited paragraph loses its
 * old identity. The old ids are the version rows this landing superseded — the previous version of
 * the same `block_uid` (a paragraph rewritten) and the `erased` rows (a paragraph that left the
 * book) — and they are where the facts the patch overran are named.
 */
function replacedBlocksOf(db: Db, chapter: number, rev: number): string[] {
  const rows = db
    .prepare(
      `SELECT p.block_id AS blockId
         FROM block_versions v
         JOIN block_versions p ON p.block_uid = v.block_uid AND p.ver = v.prev_ver
        WHERE v.chapter = ? AND v.rev = ? AND v.prev_ver IS NOT NULL
        UNION
       SELECT block_id AS blockId FROM block_versions
        WHERE chapter = ? AND rev = ? AND op = 'erased'
        ORDER BY 1`,
    )
    .all(chapter, rev, chapter, rev) as Array<{ blockId: string }>;
  return rows.map((row) => row.blockId);
}

/**
 * The facts this landing touched: mentions whose span sat inside a block the landing wrote or
 * replaced. «Changed» is the engine's own measure — the blocks whose hash is not in the pre-image
 * `start` captured, plus the blocks their ids replaced — never a diff of two texts.
 *
 * The writer's landing path publishes prose, not ledger rows: no extractor runs here, so the
 * mentions of the *edited* blocks are the ones that were asserted in them before the patch. That
 * is also the right question — «which claim stood in the paragraph this patch overran?».
 */
function seedFactsOf(db: Db, touched: readonly string[]): string[] {
  if (touched.length === 0) return [];
  const holes = touched.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT DISTINCT fact_id AS factId FROM mentions
        WHERE kind = 'fact' AND fact_id IS NOT NULL AND block_id IN (${holes})
        ORDER BY fact_id`,
    )
    .all(...touched) as Array<{ factId: string }>;
  return rows.map((row) => row.factId);
}

/**
 * Plan the landing that just happened. `null` when there is nothing to plan: not a point patch
 * (only a `change` step opens a change), no change behind the step, or a landing that moved no
 * block (a re-land of the same sha is a no-op and plans nothing).
 *
 * **Called from `settleLanding`**, which `land` runs inside the ingest's transaction (BOOK-173
 * review, fix 3): the `change_plans` row commits with the revision or not at all. Before that, a
 * crash between the two left a landed change with no plan, and a re-land wrote a second plan and
 * reset the bounds. The mention re-bind and the retirement of overrun claims run in that same
 * transaction (`settleLanding`), so the plan reads the blocks this landing wrote and not the ones
 * it replaced.
 */
export function planLanding(
  deps: EngineDeps,
  step: store.StepRow,
  revAfter: number,
  context: PlanContext = {},
): LandingPlan | null {
  if (step.pass !== 'change' || step.chapter === null) return null;
  const { db } = deps;
  const chapter = step.chapter;
  const change = changeForStep(db, step);
  if (change === undefined) return null;

  const before = new Set(preBlocksOf(step).map((block) => block.hash));
  const edited = listBlocks(db, chapter).filter((block) => !before.has(block.hash));
  if (edited.length === 0) return null;

  const touched = [...edited.map((block) => block.id), ...replacedBlocksOf(db, chapter, revAfter)];
  const after = readChapterRows(db, chapter).raw;
  const previous = previousText(deps, chapter, step.rev_before ?? Math.max(0, revAfter - 1));
  return planText(deps, change, chapter, previous, after, touched, context);
}

/** A block as a landing's text carries it: the content-derived id, and the hash `start` counted. */
export type LandingBlock = { id: string; hash: string };

/**
 * BOOK-222 — the plan of the text a pass **holds as a candidate**: computed at `land`, before
 * anything is served, because the writer reacts to the closure before the gates spend (§4, §7)
 * and the reader's line on the origin pass is written from it. The same plan the publish freezes
 * again (`settleLanding`), so the two readings of one text cannot disagree: the ids are the ones
 * this text will carry (a block id is content-derived), and a served block that text no longer
 * holds is a block it replaced — which is where the facts the patch overruns are named.
 *
 * `null` when there is nothing to plan: not a `change` step, no change behind it, or a candidate
 * that moved no block (a re-land of the same prose).
 */
export function planCandidate(
  deps: EngineDeps,
  step: store.StepRow,
  after: string,
  blocks: ReadonlyArray<LandingBlock>,
  context: PlanContext = {},
): LandingPlan | null {
  if (step.pass !== 'change' || step.chapter === null) return null;
  const { db } = deps;
  const chapter = step.chapter;
  const change = changeForStep(db, step);
  if (change === undefined) return null;

  const before = new Set(preBlocksOf(step).map((block) => block.hash));
  const edited = blocks.filter((block) => !before.has(block.hash));
  if (edited.length === 0) return null;
  const kept = new Set(blocks.map((block) => block.id));
  const replaced = listBlocks(db, chapter).filter((block) => !kept.has(block.id)).map((block) => block.id);
  const previous = previousText(deps, chapter, step.rev_before ?? currentRev(db, chapter));
  return planText(deps, change, chapter, previous, after, [...edited.map((block) => block.id), ...replaced], context);
}

/**
 * The plan of one text, whatever wrote it: the seeds of the blocks it touched, the walk, then the
 * one row per change. A rewrite is a whole-chapter decision and gets the empty `local` record
 * instead (BOOK-173 §7) — the writer is answered `null` either way when there is no closure.
 */
function planText(
  deps: EngineDeps,
  change: store.ChangeRow,
  chapter: number,
  previous: string,
  after: string,
  touched: readonly string[],
  context: PlanContext,
): LandingPlan | null {
  const { db } = deps;
  const seeds = seedFactsOf(db, touched);
  // A rewrite is a whole-chapter decision, not a patch: «a patch fixes words; a ripple fixes
  // consequences», and only the first has a point to walk away from. The measure is the writer's
  // own patch bound (§6: 15 % of the chapter's characters changed, not blocks replaced).
  if (after.length === 0 || changedChars(previous, after) > RIPPLE_PATCH_FRACTION * after.length) {
    // BOOK-173 §7: the landing still leaves a **record** — an empty, `local` plan row that says
    // «no closure was walked, this was not a point patch», keeps the mode and the estimate, and
    // is what a dispatched gate reads. Nothing drains it (`drainablePlans` wants `ripple`), and
    // the writer is answered `null`: there is no closure to react to.
    recordNonPatch(deps, change.id, chapter, context);
    return null;
  }
  const plan = buildPlan({ db, changeId: change.id, chapter, seeds, before: previous, after });
  // One row per change (§3, `change_plans`): a re-land of this step updates the row and keeps the
  // journal — the newest closure, the oldest caps, and the spend that already happened — so the
  // bounds are cumulative per change and a re-plan cannot reset them.
  // BOOK-173 §4: the plan carries the mode the pass ran and the estimate it was opened with — the
  // close replaces the estimate with the actual (`pricePlanAfterPass`).
  const planId = storePlan(db, plan, toIso(deps.clock.now()), {
    mode: context.mode ?? null,
    priceUsd: context.priceUsd ?? null,
  });
  return { plan, planId };
}

/**
 * The record a landing that is not a point patch leaves behind (BOOK-173 §7): `local`, no nodes,
 * no edges, no patches — the bounds are the closed caps, so a later `ripple` reading of the same
 * change updates this same row (`change_plans` is one row per change).
 */
function recordNonPatch(deps: EngineDeps, changeId: string, chapter: number, context: PlanContext): void {
  storePlan(
    deps.db,
    {
      changeId,
      chapter,
      outcome: 'local',
      proven: false,
      seeds: [],
      nodes: [],
      edges: [],
      edgeDetail: [],
      patches: [],
      closureSize: { nodes: 0, edges: 0, chapters: 1, parts: 1 },
      chaptersTouched: [chapter],
      bounds: defaultBounds(),
      unresolved: [],
      truncated: false,
    },
    toIso(deps.clock.now()),
    { mode: context.mode ?? null, priceUsd: context.priceUsd ?? null },
  );
}

/**
 * The ledger half of a landing, as one call: re-bind the mentions that survived, freeze the plan
 * the writer will react to, and retire the claims the patch overran (BOOK-173 review round 3,
 * fixes 1 and 3).
 *
 * **Why one call.** `land` runs this inside the ingest's own transaction when it publishes, and
 * again, in a transaction of its own, when the site's watcher published the same bytes first — the
 * revision exists either way, and a landing that skipped its ledger owed a plan it never froze and
 * a retirement it never made. `storePlan` is idempotent per change (`change_plans` is 1:1), so the
 * second door cannot write a second plan.
 *
 * **The order is the contract.** The mentions are re-bound first, so the plan and the retirement
 * both read the blocks this landing wrote; the plan is frozen next, because its seeds are the
 * claims the patch is *about* — and the retirement last, with those seeds in `keep`: retiring a
 * seed would delete the edges the closure was just computed over. A cascade chapter's plan is the
 * origin's (one row per change), so a ripple landing retires and never re-plans.
 */
export function settleLanding(
  deps: EngineDeps,
  step: store.StepRow,
  rev: number,
  context: PlanContext = {},
): LandingPlan | null {
  if (step.chapter === null) return null;
  const { db } = deps;
  const chapter = step.chapter;
  rebindMentions(db, chapter);
  const planned = planLanding(deps, step, rev, context);
  if (step.pass === 'change' || step.pass === 'cascade') {
    const change = changeForStep(db, step);
    if (change !== undefined) {
      const keep = planned === null ? [] : planned.plan.seeds.map((seed) => seed.factId);
      retireUnassertedFacts(db, { chapter, changeId: change.id, keep, at: toIso(deps.clock.now()) });
    }
  }
  return planned;
}

type PlanRow = {
  id: string;
  change_id: string;
  closure: string;
  outcome: string;
  iterations: string;
  /** The caps frozen at the first estimate — the column is the truth, not the closure's copy. */
  bounds: string;
};

/**
 * The plans still owed work: the change stood the closure (`outcome = 'ripple'`) and is closed,
 * so the chapters are a queue of normal passes. Oldest plan first — one process iteration takes
 * one chapter (§7), so the order is the order the ripple starts.
 *
 * **A parked or claimed plan is not work** (BOOK-173 review, fixes 5 and 6): a park is the book's
 * decision to stop (`parked_at` is set by the drainer), and a claim belongs to the process that
 * is draining it (`claimed_at`, 30-minute TTL). Both are excluded here so a retrying driver
 * cannot pay for the same refusal twice and two `--ripple` processes cannot take one chapter.
 */
export function drainablePlans(db: Db, now: number = Date.now()): DrainablePlan[] {
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.change_id AS change_id, p.closure AS closure,
              p.outcome AS outcome, p.iterations AS iterations, p.bounds AS bounds
         FROM change_plans p JOIN changes c ON c.id = p.change_id
        WHERE p.outcome = 'ripple' AND c.outcome = 'ripple'
          AND p.parked_at IS NULL
          AND (p.claimed_at IS NULL OR p.claimed_at < ?)
        ORDER BY p.created_at, p.id`,
    )
    .all(toIso(now - PLAN_CLAIM_TTL_MS)) as PlanRow[];
  const plans = rows.map((row) => ({
    planRowId: row.id,
    plan: {
      ...(JSON.parse(row.closure) as RipplePlan),
      outcome: 'ripple' as const,
      bounds: JSON.parse(row.bounds) as RipplePlan['bounds'],
    },
    iterations: (JSON.parse(row.iterations) as unknown[]).length,
  }));
  // A plan whose every mandatory chapter has already been taken is not work: the drainer stops
  // when no unexecuted mandatory node remains (§4), and the journal is where «executed» lives.
  return plans.filter((entry) => pendingMandatory(db, entry) > 0);
}

/** How many mandatory nodes still sit in a chapter the journal has not taken yet. */
function pendingMandatory(db: Db, entry: DrainablePlan): number {
  const row = db.prepare('SELECT iterations FROM change_plans WHERE id = ?').get(entry.planRowId) as
    | { iterations: string }
    | undefined;
  const journal = row === undefined ? [] : (JSON.parse(row.iterations) as Array<{ nodes?: string[] }>);
  const taken = new Set(journal.flatMap((iteration) => iteration.nodes ?? []));
  return entry.plan.nodes.filter(
    (node) => node.mandatory && node.chapter !== entry.plan.chapter && !taken.has(node.factId),
  ).length;
}

/**
 * A change that stood a ripple closes as `ripple`, not as `applied` — the outcome vocabulary's
 * one new word. Everything else keeps the outcome the close decided.
 *
 * **Only a plan that is itself a ripple** (BOOK-173 review, fix 7): a `wide` plan means the author
 * has not decided yet, and labelling that change `ripple` would put it in the drainer's queue with
 * no door that may open it. A wide plan is **parked** here, in the author's words, so the change
 * keeps the outcome it earned and `--ripple` says «припаркован: решает автор» instead of finding
 * an empty queue.
 */
export function rippleOutcomeFor(db: Db, changeId: string, outcome: string): string {
  if (outcome !== 'applied') return outcome;
  const latest = latestPlan(db, changeId);
  if (latest === null) return outcome;
  if (latest.plan.outcome === 'ripple') return 'ripple';
  if (latest.plan.outcome === 'wide') {
    parkPlan(db, latest.planRowId, readerReason('WIDE_NEEDS_AUTHOR', 'правка задевает слишком много'));
  }
  return outcome;
}

/** The plan a change is priced against: what the reviewable table prints (`change_plans` is 1:1). */
export function latestPlan(db: Db, changeId: string): DrainablePlan | null {
  const row = db
    .prepare(
      `SELECT id AS id, change_id AS change_id, closure AS closure, outcome AS outcome,
              iterations AS iterations, bounds AS bounds
         FROM change_plans WHERE change_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(changeId) as PlanRow | undefined;
  if (row === undefined) return null;
  return {
    planRowId: row.id,
    plan: {
      ...(JSON.parse(row.closure) as RipplePlan),
      outcome: row.outcome as PlanOutcome,
      bounds: JSON.parse(row.bounds) as RipplePlan['bounds'],
    },
    iterations: (JSON.parse(row.iterations) as unknown[]).length,
  };
}

function revOf(db: Db, chapter: number): number {
  const row = db.prepare('SELECT rev FROM chapters WHERE n = ?').get(chapter) as { rev: number } | undefined;
  return row?.rev ?? 0;
}

/**
 * Open one chapter's step for a ripple already planned (`pass: 'cascade'`, no cascade row — the
 * chapters are independent normal passes, each with its own lease, gates and close). The door
 * refuses what a ripple may never do: an empty slot, the frozen ending, a change that is not a
 * ripple, and a chapter the plan does not name.
 */
export function openRippleStep(
  deps: EngineDeps,
  input: { changeId: string; chapter: number; session: string },
): WriterAssignment {
  const { db } = deps;
  const change = store.getChange(db, input.changeId);
  if (change === undefined) refuse('CHANGE_MISSING', 404, `no change ${input.changeId}`);
  if (change.outcome !== 'ripple') {
    refuse('NOT_A_RIPPLE', 409, `change ${change.id} is not a ripple (outcome ${change.outcome ?? 'null'})`);
  }
  if (!Number.isInteger(input.chapter) || input.chapter < 1 || input.chapter > TOTAL_CHAPTERS) {
    refuse('INVALID_CHAPTER', 422, `a ripple chapter is 1..${String(TOTAL_CHAPTERS)}`);
  }
  if (input.session.trim().length === 0 || input.session.length > 64) {
    refuse('INVALID_SESSION', 422, 'a session name is required');
  }
  const latest = latestPlan(db, change.id);
  if (latest === null) refuse('PLAN_MISSING', 409, `change ${change.id} has no plan`);
  // BOOK-173 review, fix 7: a `wide` plan is the author's decision, not a chapter to patch. The
  // door refuses it here, before any step, lease or gate — an automatic pass may never be the
  // answer to «the change is too big to decide alone».
  if (latest.plan.outcome === 'wide') {
    refuse('WIDE_NEEDS_AUTHOR', 409, 'правка задевает слишком много — эту главу решает автор, волна не открыта', {
      plan: latest.planRowId,
    });
  }
  const planned = new Set(latest.plan.nodes.filter((node) => node.mandatory).map((node) => node.chapter));
  if (!planned.has(input.chapter)) {
    refuse('NOT_PLANNED', 422, `глава ${String(input.chapter)} не названа обязательной ни одним узлом плана`);
  }
  const own = readChapterRows(db, input.chapter);
  if (!own.exists) refuse('NEIGHBOUR_MISSING', 409, `глава ${String(input.chapter)} ещё не написана`);

  const at = deps.clock.now();
  const stepId = newStepId(at);
  store.insertStep(db, {
    stepId,
    cascadeId: null,
    seq: 0,
    wave: 0,
    lane: directionOf(input.chapter),
    pass: 'cascade',
    chapter: input.chapter,
    boundary: boundaryFor(input.chapter),
    seamsIn: '[]',
    revBefore: revOf(db, input.chapter),
    at: toIso(at),
  });
  appendEvent(
    db,
    {
      kind: 'step.opened',
      stepId,
      changeId: change.id,
      chapter: input.chapter,
      payload: { pass: 'cascade', ripple: true, plan: latest.planRowId },
    },
    at,
  );
  const step = store.getStep(db, stepId) as store.StepRow;
  const lease = acquireLease(deps, {
    step,
    session: input.session,
    expectedRev: step.rev_before ?? revOf(db, input.chapter),
    changeId: change.id,
  });
  return writerAssignment(deps, step, lease.id, change.id);
}
