/**
 * The plan of a ripple (BOOK-173, BOOK-DOC-75 §3).
 *
 * `buildPlan` is the whole deterministic half of the ripple: resolve the seeds, walk the graph in
 * both directions with no chapter window, classify every reachable node, and freeze the result
 * with its caps. It calls no model and writes nothing; `storePlan` is the one writer.
 *
 * Three outcomes, and the difference is not a mood:
 *
 *   · `local`  — no mandatory node: the change is patched at the point and nothing else claims it;
 *   · `ripple` — mandatory nodes exist and every cap holds: each one is patched on its chapter;
 *   · `wide`   — a cap is exceeded, the node valve trips, or a `contradicts` edge sits on the walk
 *                (an outcome reversal): the owner decides, the closure is printed whole.
 *
 * **`proven: false` is not «nothing depends on it».** When a seed names no live fact the plan says
 * so — `unresolved[]` lists the ids it could not bind — and the reader is told «не доказано». The
 * zero that a thin ledger produces is the ledger's failure, never evidence of independence.
 *
 * **The chapter cap is deliberately absent.** The owner's overrule (BOOK-173 addendum) removed it:
 * a chapter count is a banned proxy for money. What bounds a ripple is the changed characters, the
 * money, the iteration count and the discovery valve, and each of them routes to `wide` with the
 * closure intact, never to a smaller closure.
 */

import { partOf } from '@book/shared';

import type { Db } from '../../db/db.ts';
import { toIso } from '../../util/time.ts';
import { ulid } from '../../util/ulid.ts';
import { classify, type Reason } from './classify.ts';
import { movedComponents, type Component } from './components.ts';
import { allEdges, assertedFacts, liveFactsAsOf, walk, WALK_EDGE_VALVE, WALK_NODE_VALVE, type WalkDirection } from './edges.ts';

/** BOOK-DOC-75 §6: 4 000 changed characters per change, cumulative. */
export const RIPPLE_MAX_CHANGED_CHARS = 4_000;
/** BOOK-DOC-75 §8: the money bound of an automatic ripple, cumulative. */
export const RIPPLE_MAX_USD = 0.6;
/** BOOK-DOC-75 §4: four iterations, then `CLOSURE_UNSTABLE` unless the plan is verified. */
export const RIPPLE_MAX_ITERATIONS = 4;

export type PlanOutcome = 'local' | 'ripple' | 'wide';

export type PlanSeed = { factId: string; chapter: number; blockId: string | null; changed: Component[] };

export type PlanNode = {
  factId: string;
  chapter: number;
  blockId: string | null;
  mandatory: boolean;
  reason: Reason;
  direction: WalkDirection;
  hops: number;
  /** The edge ids from the seed to this node — the reviewable `via` chain. */
  via: string[];
  /**
   * The node's claim, verbatim (BOOK-DOC-75 §3): what the causality judge is shown instead of a
   * chapter. Empty when the fact row has no statement — the judge prints the id then.
   */
  quote: string;
};

/**
 * One edge of the walk as the judge and the review table print it (BOOK-DOC-75 §5): the two ends,
 * the kind, the component the target consumes, and the evidence the backfill recorded. Frozen with
 * the plan, so a judge re-run asks the same question of the same rows.
 */
export type PlanEdge = { id: string; from: string; to: string; kind: string; on: string; statement: string };

/** A patch is the writer's, produced per chapter; at planning the list is empty by design. */
export type PlanPatch = { chapter: number; blockId: string; oldText: string; newText: string; reason: string };

/** The caps, frozen at estimate — what the change was priced against, not what it later spent. */
export type PlanBounds = {
  chars: number;
  usd: number;
  iterations: number;
  nodes: number;
  edges: number;
};

export type RipplePlan = {
  changeId: string;
  chapter: number;
  outcome: PlanOutcome;
  /**
   * Every seed resolved to a live fact. `false` = the ledger cannot name what changed, and a plan
   * with no seeds at all is unproven too: nothing was named, so nothing was proved.
   */
  proven: boolean;
  seeds: PlanSeed[];
  nodes: PlanNode[];
  /** The ids of the edges the walk used. */
  edges: string[];
  /** The same edges with both ends, for the judge's `user` turn and the reviewable table. */
  edgeDetail: PlanEdge[];
  patches: PlanPatch[];
  closureSize: { nodes: number; edges: number; chapters: number; parts: number };
  chaptersTouched: number[];
  bounds: PlanBounds;
  /** The seed ids that found no live fact — printed, never swallowed. */
  unresolved: string[];
  /** The node valve tripped: the closure is a data bug, and the plan says so. */
  truncated: boolean;
};

export type PlanCaps = {
  chars?: number;
  usd?: number;
  iterations?: number;
  nodes?: number;
  edges?: number;
  /** The writer's price of the patches, when it has one; above `usd` the plan is `wide`. */
  estimatedUsd?: number;
  /** The iteration the change is on; above `iterations` the plan is `wide`. */
  iterationsUsed?: number;
};

export type BuildPlanInput = {
  db: Db;
  changeId: string;
  chapter: number;
  /** Seed fact ids, or the same with the components the caller measured for each. */
  seeds: ReadonlyArray<string | { factId: string; changed?: readonly Component[] }>;
  before: string;
  after: string;
  bounds?: PlanCaps;
  /** Facts already patched in this change: an executed node is not mandatory again. */
  executed?: readonly string[];
};

/** Characters an edit actually changed: the one region between the common prefix and suffix. */
export function changedChars(before: string, after: string): number {
  if (before === after) return 0;
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  return before.length + after.length - 2 * (prefix + suffix);
}

/** Every fact's claim by id — the quote a node carries, whatever chapter established it. */
function statementsOf(db: Db): Map<string, string> {
  const rows = db.prepare('SELECT id, statement FROM facts').all() as Array<{ id: string; statement: string }>;
  return new Map(rows.map((row) => [row.id, row.statement]));
}

/** The block a fact is mentioned in, live only — the byte address the plan points at. */
function blockOfFacts(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT m.fact_id AS factId, m.block_id AS blockId
         FROM mentions m JOIN blocks b ON b.id = m.block_id
        WHERE m.kind = 'fact' AND m.fact_id IS NOT NULL
        ORDER BY m.fact_id, m.chapter, m.start`,
    )
    .all() as Array<{ factId: string; blockId: string }>;
  const map = new Map<string, string>();
  for (const row of rows) if (!map.has(row.factId)) map.set(row.factId, row.blockId);
  return map;
}

function capsOf(input: PlanCaps): PlanBounds {
  return {
    chars: input.chars ?? RIPPLE_MAX_CHANGED_CHARS,
    usd: input.usd ?? RIPPLE_MAX_USD,
    iterations: input.iterations ?? RIPPLE_MAX_ITERATIONS,
    nodes: input.nodes ?? WALK_NODE_VALVE,
    edges: input.edges ?? WALK_EDGE_VALVE,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Assemble, classify and freeze the plan. Deterministic: the same rows and the same two texts
 * produce a byte-identical plan, so a stored plan and a recomputed one can be compared.
 */
export function buildPlan(input: BuildPlanInput): RipplePlan {
  const { db } = input;
  const bounds = capsOf(input.bounds ?? {});
  const live = liveFactsAsOf(db, input.chapter);
  const blocks = blockOfFacts(db);
  const statements = statementsOf(db);
  const measured = movedComponents(input.before, input.after);
  const unresolved: string[] = [];
  const seeds: PlanSeed[] = [];
  for (const raw of input.seeds) {
    const wanted = typeof raw === 'string' ? { factId: raw, changed: undefined } : raw;
    const fact = live.get(wanted.factId);
    if (fact === undefined) {
      unresolved.push(wanted.factId);
      continue;
    }
    seeds.push({
      factId: fact.id,
      chapter: fact.chapter,
      blockId: blocks.get(fact.id) ?? null,
      changed: [...(wanted.changed ?? measured)].sort(),
    });
  }
  seeds.sort((left, right) => compare(left.factId, right.factId));
  const seedIds = seeds.map((seed) => seed.factId);

  const walked = walk(db, seedIds, { direction: 'both', nodeValve: bounds.nodes });
  const moved = new Set<Component>(seeds.flatMap((seed) => seed.changed));
  const classified = classify(walked.nodes, {
    moved,
    seeds: seedIds,
    asserted: assertedFacts(db),
    executed: new Set(input.executed ?? []),
  });
  const nodes: PlanNode[] = classified.map((node) => ({
    factId: node.factId,
    chapter: node.chapter,
    blockId: blocks.get(node.factId) ?? null,
    mandatory: node.mandatory,
    reason: node.reason,
    direction: node.direction,
    hops: node.hops,
    via: node.via,
    quote: statements.get(node.factId) ?? '',
  }));

  const chaptersTouched = [...new Set([...seeds.map((seed) => seed.chapter), ...nodes.map((node) => node.chapter)])].sort(
    (left, right) => left - right,
  );
  const parts = new Set(chaptersTouched.map((chapter) => partOf(chapter) ?? 'frame'));
  const mandatory = nodes.filter((node) => node.mandatory).length;
  // A reversal inside the closure is a `wide` even when the walk found both ends by another
  // path: the contradiction is a statement about the change, not about the discovery tree.
  const closure = new Set(walked.nodes.map((node) => node.factId));
  const reversed = allEdges(db).some(
    (edge) => edge.kind === 'contradicts' && closure.has(edge.from_fact) && closure.has(edge.to_fact),
  );
  const overChars = changedChars(input.before, input.after) > bounds.chars;
  const overMoney = input.bounds?.estimatedUsd !== undefined && input.bounds.estimatedUsd > bounds.usd;
  const overIterations =
    input.bounds?.iterationsUsed !== undefined && input.bounds.iterationsUsed > bounds.iterations;
  const overValve = walked.truncated || walked.edges.length > bounds.edges;
  const outcome: PlanOutcome =
    overChars || overMoney || overIterations || overValve || reversed
      ? 'wide'
      : mandatory > 0
        ? 'ripple'
        : 'local';

  return {
    changeId: input.changeId,
    chapter: input.chapter,
    outcome,
    // Nothing was named, nothing was proved: an empty seed list is not a clean bill of health.
    proven: seeds.length > 0 && unresolved.length === 0,
    seeds,
    nodes,
    edges: walked.edges.map((edge) => edge.id),
    edgeDetail: walked.edges.map((edge) => ({
      id: edge.id,
      from: edge.from_fact,
      to: edge.to_fact,
      kind: edge.kind,
      on: edge.on_component,
      statement: edge.evidence,
    })),
    patches: [],
    closureSize: {
      nodes: walked.nodes.length,
      edges: walked.edges.length,
      chapters: chaptersTouched.length,
      parts: parts.size,
    },
    chaptersTouched,
    bounds,
    unresolved,
    truncated: walked.truncated,
  };
}

type PlanRow = {
  id: string;
  change_id: string;
  chapter: number;
  outcome: PlanOutcome;
  closure: string;
  patches: string;
  bounds: string;
  iterations: string;
  parked_at: string | null;
  park_reason: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  created_at: string;
};

/**
 * Freeze a plan into `change_plans` — **one row per change** (BOOK-173 review, fix 3).
 *
 * A re-land of the same step is the same change, so it updates this row instead of writing a
 * second one: the closure and the patches are the newest reading, `created_at`, `bounds` and the
 * `iterations` journal stay, and that is what makes the caps cumulative per change — «already
 * spent» is the journal's sum, and no re-plan can reset it. The park and the claim are cleared,
 * because a plan computed from a new landing is new evidence for a drained lane.
 *
 * The caller runs this inside the landing's transaction (`engine/ripple.ts`), so a crash lands
 * neither the revision nor the plan.
 */
export function storePlan(db: Db, plan: RipplePlan, at?: string): string {
  const id = `pln_${ulid()}`;
  db.prepare(
    `INSERT INTO change_plans
       (id, change_id, chapter, outcome, closure, patches, bounds, iterations, created_at)
     VALUES (@id, @changeId, @chapter, @outcome, @closure, @patches, @bounds, '[]', @at)
     ON CONFLICT(change_id) DO UPDATE SET
       chapter = excluded.chapter,
       outcome = excluded.outcome,
       closure = excluded.closure,
       patches = excluded.patches,
       parked_at = NULL,
       park_reason = NULL,
       claimed_at = NULL,
       claimed_by = NULL`,
  ).run({
    id,
    changeId: plan.changeId,
    chapter: plan.chapter,
    outcome: plan.outcome,
    closure: JSON.stringify({ ...plan, patches: [] }),
    patches: JSON.stringify(plan.patches),
    bounds: JSON.stringify(plan.bounds),
    at: at ?? toIso(Date.now()),
  });
  return planRowIdOf(db, plan.changeId) ?? id;
}

/** The row id a change's plan lives under — one row per change, whatever wrote it first. */
export function planRowIdOf(db: Db, changeId: string): string | null {
  const row = db.prepare('SELECT id FROM change_plans WHERE change_id = ?').get(changeId) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * Park a plan: the one way it stops. `reason` is the author's sentence — a code word never lands
 * in this column — and `drainablePlans` reads `parked_at` to leave the row alone, so a retrying
 * driver cannot pay for the same refusal twice. Idempotent: a second park keeps the first
 * moment and the first sentence, which is the record of why it stopped.
 */
export function parkPlan(db: Db, planRowId: string, reason: string, at?: string): void {
  db.prepare(
    `UPDATE change_plans SET parked_at = COALESCE(parked_at, ?), park_reason = COALESCE(park_reason, ?)
      WHERE id = ?`,
  ).run(at ?? toIso(Date.now()), reason, planRowId);
}

/** How long a claim lives: a process that died mid-chapter must not freeze the plan forever. */
export const PLAN_CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Take the plan's claim, so two `--ripple` processes never drain the same chapters. One
 * conditional UPDATE is the whole mutex — the row is taken iff it is free or its holder is older
 * than `PLAN_CLAIM_TTL_MS` (a process that died mid-chapter). `false` means somebody else has it.
 */
export function claimPlan(db: Db, planRowId: string, by: string, at?: number): boolean {
  const nowMs = at ?? Date.now();
  const stale = toIso(nowMs - PLAN_CLAIM_TTL_MS);
  const result = db
    .prepare(
      `UPDATE change_plans SET claimed_at = ?, claimed_by = ?
        WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ?)`,
    )
    .run(toIso(nowMs), by, planRowId, stale);
  return result.changes > 0;
}

/** Give the claim back. Only the holder's own claim is released — never another process's. */
export function releasePlanClaim(db: Db, planRowId: string, by: string): void {
  db.prepare('UPDATE change_plans SET claimed_at = NULL, claimed_by = NULL WHERE id = ? AND claimed_by = ?').run(
    planRowId,
    by,
  );
}

/** A plan that stopped: what the CLI prints instead of silently retrying it. */
export type ParkedPlan = { planRowId: string; changeId: string; chapter: number; reason: string; at: string };

/** A plan another process is draining right now: the CLI says so instead of «nothing to do». */
export type ClaimedPlan = { planRowId: string; changeId: string; claimedBy: string; claimedAt: string };

/** The plans under a live claim, oldest claim first. */
export function claimedPlans(db: Db, now?: number): ClaimedPlan[] {
  const rows = db
    .prepare(
      `SELECT id AS planRowId, change_id AS changeId, claimed_by AS claimedBy, claimed_at AS claimedAt
         FROM change_plans
        WHERE claimed_at IS NOT NULL AND claimed_at >= ?
        ORDER BY claimed_at, id`,
    )
    .all(toIso((now ?? Date.now()) - PLAN_CLAIM_TTL_MS)) as ClaimedPlan[];
  return rows;
}

/** Every parked plan, newest park first — the operator's own queue of things the author owes. */
export function parkedPlans(db: Db): ParkedPlan[] {
  const rows = db
    .prepare(
      `SELECT id, change_id AS changeId, chapter, park_reason AS reason, parked_at AS at
         FROM change_plans WHERE parked_at IS NOT NULL ORDER BY parked_at DESC, id`,
    )
    .all() as ParkedPlan[];
  return rows.map((row) => ({ ...row, reason: row.reason ?? '' }));
}

/** Every plan a change has been priced with — one row, oldest first (`change_plans` is 1:1). */
export function plansFor(db: Db, changeId: string): RipplePlan[] {
  const rows = db
    .prepare(`SELECT * FROM change_plans WHERE change_id = ? ORDER BY created_at, id`)
    .all(changeId) as PlanRow[];
  return rows.map(hydrate);
}

function hydrate(row: PlanRow): RipplePlan {
  const closure = JSON.parse(row.closure) as RipplePlan;
  return {
    ...closure,
    outcome: row.outcome,
    patches: JSON.parse(row.patches) as PlanPatch[],
    bounds: JSON.parse(row.bounds) as PlanBounds,
  };
}

/**
 * The plans of the changes still in flight: a queued, running or escalated change has a plan its
 * reader and its writer both need. A closed change (`done`, `void`, `failed`) is history.
 */
export function openPlans(db: Db): RipplePlan[] {
  const rows = db
    .prepare(
      `SELECT p.* FROM change_plans p JOIN changes c ON c.id = p.change_id
        WHERE c.status IN ('pending','processing','stale','escalated')
        ORDER BY p.created_at, p.id`,
    )
    .all() as PlanRow[];
  return rows.map(hydrate);
}
