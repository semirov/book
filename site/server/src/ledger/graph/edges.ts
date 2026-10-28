/**
 * The dependency graph and the walk over it (BOOK-173, BOOK-DOC-75 §1.2, §2).
 *
 * An edge is one statement: «`to_fact` consumes `on_component` of `from_fact`», told at a
 * chapter. `assertDependency` is the only writer of a row — a duplicate is the same statement and
 * returns the row that already stands, so a backfill run twice writes once.
 *
 * `walk` is the closure: every fact reachable from the seeds in **both** directions, with the
 * hop that discovered each one, so «why is this node here?» has an answer and the plan prints it.
 * It stops when the frontier is empty — no chapter window, no reach cap (the owner's overrule,
 * BOOK-173 addendum) — and the one cap it has is a data-bug valve: more than `nodeValve` nodes is
 * not a book, and the caller routes that to `wide` with the closure printed, never to «we stopped
 * looking».
 *
 * **Measured, and why this shape.** Two implementations were built and run on a fixture of 1 000
 * facts / 700 edges (50 runs, median, Node 22): a recursive CTE over `edges` and the in-memory
 * adjacency below, loaded once per walk. A tiny closure (15 nodes) costs the CTE 0.17 ms and the
 * adjacency 0.44 ms — the CTE wins by a hair, because it never scans the other 685 edges. A wide
 * closure (390 nodes, the shape the real book's 149-node filings have) costs the CTE **7.65 ms**
 * and the adjacency **0.68 ms**: the CTE must `UNION`-dedupe on `(fact_id, hops)` to stay
 * depth-bounded, so a hub is re-emitted once per distinct depth and the intermediate set explodes
 * with depth — and it cannot carry the path. The shipped walk is the adjacency one: 11× faster on
 * the case that matters, and the only one that can say *via which edge* a node is here.
 */

import type { Db } from '../../db/db.ts';
import { resolveSentenceCovering } from '../../sentences/store.ts';
import { toIso } from '../../util/time.ts';
import { ulid } from '../../util/ulid.ts';
import type { FactRow } from '../facts.ts';
import { factAsOf, invalidateFact } from '../facts.ts';
import type { Component } from './components.ts';

export type EdgeKind = 'follows' | 'fulfils' | 'references' | 'contradicts';
export type EdgeOrigin = 'backfill' | 'writer' | 'owner';

export type EdgeRow = {
  id: string;
  from_fact: string;
  to_fact: string;
  chapter: number;
  kind: EdgeKind;
  on_component: Component;
  evidence: string;
  origin: EdgeOrigin;
  created_at: string;
};

export type AssertDependencyInput = {
  from: string;
  to: string;
  chapter: number;
  kind: EdgeKind;
  onComponent?: Component;
  evidence?: string;
  origin?: EdgeOrigin;
  /** Test seam: a frozen clock, so a fixture is byte-identical between runs. */
  at?: string;
  /** Test seam: a frozen id for the row a call creates. */
  id?: string;
};

/**
 * Register one dependency. Idempotent on `(from_fact, to_fact, kind, chapter)` — the unique index
 * the schema declares — so a re-run updates the reading of the same statement instead of adding a
 * second one. The origin of the first writer is kept: a backfilled row does not turn into a
 * writer's row because a later pass asserted the same thing.
 */
export function assertDependency(db: Db, input: AssertDependencyInput): EdgeRow {
  if (!Number.isInteger(input.chapter) || input.chapter < 1 || input.chapter > 67) {
    throw new Error(`edge chapter out of range: ${String(input.chapter)}`);
  }
  if (input.from === input.to) throw new Error('an edge needs two different facts');
  const id = input.id ?? `edg_${ulid()}`;
  db.prepare(
    `INSERT INTO edges (id, from_fact, to_fact, chapter, kind, on_component, evidence, origin, created_at)
     VALUES (@id, @from, @to, @chapter, @kind, @onComponent, @evidence, @origin, @at)
     ON CONFLICT(from_fact, to_fact, kind, chapter) DO UPDATE SET
       on_component = excluded.on_component,
       evidence = excluded.evidence`,
  ).run({
    id,
    from: input.from,
    to: input.to,
    chapter: input.chapter,
    kind: input.kind,
    onComponent: input.onComponent ?? 'value',
    evidence: input.evidence ?? '',
    origin: input.origin ?? 'backfill',
    at: input.at ?? toIso(Date.now()),
  });
  return db
    .prepare(
      `SELECT * FROM edges WHERE from_fact = ? AND to_fact = ? AND kind = ? AND chapter = ?`,
    )
    .get(input.from, input.to, input.kind, input.chapter) as EdgeRow;
}

/** Every edge an endpoint touches, in a canonical order. */
export function edgesOf(db: Db, factId: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT * FROM edges WHERE from_fact = ? OR to_fact = ?
        ORDER BY chapter, from_fact, to_fact, kind, id`,
    )
    .all(factId, factId) as EdgeRow[];
}

/** Every edge of the graph, in a canonical order — the read a whole-book walk starts from. */
export function allEdges(db: Db): EdgeRow[] {
  return db.prepare('SELECT * FROM edges ORDER BY id').all() as EdgeRow[];
}

/** The facts true at a chapter, by id — the «still live?» question a seed and a node ask. */
export function liveFactsAsOf(db: Db, chapter: number): Map<string, FactRow> {
  return new Map(factAsOf(db, chapter).map((fact) => [fact.id, fact]));
}

/**
 * The facts whose claim is still asserted, measured against **text, not block identity**.
 *
 * A block id is content-derived, so a patch that rewrites one paragraph gives it a new id and
 * every mention bound to the old id points at a row that no longer exists. Reading assertion
 * through that id made a patched node look unasserted, which turned a mandatory node optional and
 * made `CLOSURE_UNSTABLE` unreachable — the exact bug the review of BOOK-173 found. So the question
 * is asked of the chapter's *current* text:
 *
 *   1. fast path — the mention is still bound to a live block and that block still holds the
 *      witness (`land` re-binds the survivors, so this is the normal case);
 *   2. survivor path — the block is gone: the witness must occur in a paragraph the chapter holds
 *      now, in paragraph order. `land` re-binds by the same rule (`rebindMentions`), so this is
 *      the fallback for rows written before a re-bind or for a mention whose block was replaced
 *      by a later watcher pass rather than by a landing;
 *   3. otherwise the claim was edited away and the fact is *not* asserted — which is what makes
 *      «its claim is still asserted» a query and not a memory of the backfill.
 */
export function assertedFacts(db: Db): Set<string> {
  const live = liveBlocksByChapter(db);
  const liveIds = new Set<string>();
  const textById = new Map<string, string>();
  for (const blocks of live.values()) {
    for (const block of blocks) {
      liveIds.add(block.id);
      textById.set(block.id, block.text);
    }
  }
  const rows = db
    .prepare(
      `SELECT m.fact_id AS factId, m.block_id AS blockId, m.chapter AS chapter, m.witness AS witness
         FROM mentions m
        WHERE m.kind = 'fact' AND m.fact_id IS NOT NULL AND m.witness != ''`,
    )
    .all() as Array<{ factId: string; blockId: string; chapter: number; witness: string }>;
  const asserted = new Set<string>();
  for (const row of rows) {
    if (asserted.has(row.factId)) continue;
    const own = liveIds.has(row.blockId) ? textById.get(row.blockId) : undefined;
    if (own !== undefined && own.includes(row.witness)) {
      asserted.add(row.factId);
      continue;
    }
    const survivors = live.get(row.chapter) ?? [];
    if (survivors.some((block) => block.text.includes(row.witness))) asserted.add(row.factId);
  }
  return asserted;
}

/** A live block of one chapter, in paragraph order — the address a mention is re-bound to. */
function liveBlocksByChapter(db: Db): Map<number, Array<{ id: string; text: string }>> {
  const rows = db.prepare('SELECT id, chapter, text FROM blocks ORDER BY chapter, idx').all() as Array<{
    id: string;
    chapter: number;
    text: string;
  }>;
  const map = new Map<number, Array<{ id: string; text: string }>>();
  for (const row of rows) {
    const list = map.get(row.chapter) ?? [];
    list.push({ id: row.id, text: row.text });
    map.set(row.chapter, list);
  }
  return map;
}

/**
 * Re-bind a chapter's mentions to its live blocks (BOOK-173 review, fix 4).
 *
 * A patch replaces the `blocks` rows of the chapter, so a mention of a rewritten paragraph keeps a
 * `block_id` that no longer exists. Re-binding is the cheap half of the fix — one indexed read of
 * the chapter's blocks and one scan of its fact mentions — and it is done **inside the landing's
 * transaction** (the ingest's own, see `engine/ripple.ts`), because «the mention follows the text
 * the same write produced» is the invariant, not a later repair. The witness is the address: the
 * mention's code-point span is recomputed where the witness now sits, in paragraph order.
 *
 * A witness the landing removed is not re-bound and not deleted: the fact row keeps its history,
 * the stale mention keeps pointing where it pointed, and `assertedFacts` reads the claim as gone.
 * Returns how many mentions moved, which is what a test and the log line need.
 */
export function rebindMentions(db: Db, chapter: number): number {
  const live = liveBlocksByChapter(db).get(chapter) ?? [];
  if (live.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, block_id AS blockId, witness FROM mentions
        WHERE chapter = ? AND kind = 'fact' AND witness != ''`,
    )
    .all(chapter) as Array<{ id: number; blockId: string; witness: string }>;
  const liveIds = new Set(live.map((block) => block.id));
  const update = db.prepare('UPDATE mentions SET block_id = ?, start = ?, end = ?, sentence_id = ? WHERE id = ?');
  let moved = 0;
  for (const row of rows) {
    if (liveIds.has(row.blockId)) continue;
    for (const block of live) {
      const at = block.text.indexOf(row.witness);
      if (at < 0) continue;
      const start = Array.from(block.text.slice(0, at)).length;
      const end = start + Array.from(row.witness).length;
      // ADR-044 §4 / BOOK-173 §2.4: the mention follows the **sentence** to the row the patch
      // re-attached, with the new offsets. No live sentence covers the span (it straddles a split,
      // or its row was erased) → no id: the mention keeps its block anchor, which is the legacy
      // fallback. An id is never invented and never kept past its row.
      const sentence = resolveSentenceCovering(db, { blockId: block.id, start, end });
      update.run(block.id, start, end, sentence === null ? null : sentence.id, row.id);
      moved += 1;
      break;
    }
  }
  return moved;
}

/**
 * Retire the claims a landing overran (BOOK-173 review round 3, fix 3; BOOK-DOC-75 §1.3, §2 —
 * «facts of the patched blocks are retired, their incident edges retired»).
 *
 * The question is `assertedFacts`' own, asked after the landing wrote its blocks: a fact whose
 * witness no longer occurs in the chapter's text is a claim the book stopped making, so its row is
 * invalidated — never deleted — with the change that dropped it, and `facts_retire_edges` deletes
 * its incident edges. Without this the trigger never fired in production and a walk kept crossing
 * a claim nobody asserts any more.
 *
 * Two guards keep the retirement honest:
 *   · a candidate is a mention whose block **this landing replaced** — a fact whose carrier is
 *     still live is not a fact this patch overran;
 *   · a fact that is still asserted anywhere is never invalidated, and neither is one the caller
 *     names in `keep` — the landing's seeds, whose edges the plan it just froze walks over.
 *
 * `changeId` is what `factAsOf` reads to ask «false from when», so it is required: an invalidation
 * with no change would take the edges and record no reason.
 */
export function retireUnassertedFacts(
  db: Db,
  input: { chapter: number; changeId: string; keep: readonly string[]; at?: string },
): string[] {
  const candidates = db
    .prepare(
      `SELECT DISTINCT m.fact_id AS factId
         FROM mentions m JOIN facts f ON f.id = m.fact_id
        WHERE m.chapter = ? AND m.kind = 'fact' AND m.fact_id IS NOT NULL AND m.witness != ''
          AND f.invalidated_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = m.block_id)
        ORDER BY m.fact_id`,
    )
    .all(input.chapter) as Array<{ factId: string }>;
  if (candidates.length === 0) return [];
  const keep = new Set(input.keep);
  const asserted = assertedFacts(db);
  const retired: string[] = [];
  for (const row of candidates) {
    if (keep.has(row.factId)) continue;
    if (asserted.has(row.factId)) continue;
    invalidateFact(db, { id: row.factId, changeId: input.changeId, at: input.at });
    retired.push(row.factId);
  }
  return retired;
}

export type WalkHop = { edgeId: string; kind: EdgeKind; onComponent: Component; to: string };
export type WalkDirection = 'seed' | 'forward' | 'backward';
export type WalkNode = {
  factId: string;
  chapter: number;
  hops: number;
  direction: WalkDirection;
  /** The hop chain from the seed: `via[0]` is the first hop, the one the predicate reads. */
  via: WalkHop[];
};
export type WalkResult = { nodes: WalkNode[]; edges: EdgeRow[]; truncated: boolean };

export type WalkOptions = {
  /** `both` is the closure the design asks for; a direction is a debugging and test aid. */
  direction?: 'both' | 'forward' | 'backward';
  /** Sanity bound for a graph defect, not a window: the measured longest path is 13. */
  depthLimit?: number;
  /** The node valve: the point past which the closure is a data bug, not a book. */
  nodeValve?: number;
};

/** A whole-graph read is one scan; beyond that the walk is memory-bound, not query-bound. */
export const WALK_DEPTH_LIMIT = 24;
export const WALK_NODE_VALVE = 1_500;
export const WALK_EDGE_VALVE = 3_000;

type Step = { edge: EdgeRow; to: string; direction: 'forward' | 'backward' };

/** Neighbours of every fact in both directions, in a deterministic order, loaded once. */
function adjacency(db: Db): Map<string, Step[]> {
  const map = new Map<string, Step[]>();
  const push = (key: string, step: Step): void => {
    const list = map.get(key) ?? [];
    list.push(step);
    map.set(key, list);
  };
  for (const edge of allEdges(db)) {
    push(edge.from_fact, { edge, to: edge.to_fact, direction: 'forward' });
    push(edge.to_fact, { edge, to: edge.from_fact, direction: 'backward' });
  }
  for (const list of map.values()) {
    list.sort(
      (left, right) =>
        compare(left.to, right.to) ||
        compare(left.edge.kind, right.edge.kind) ||
        left.edge.chapter - right.edge.chapter ||
        compare(left.edge.id, right.edge.id) ||
        compare(left.direction, right.direction),
    );
  }
  return map;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chaptersOf(db: Db): Map<string, number> {
  const rows = db.prepare('SELECT id, chapter FROM facts').all() as Array<{ id: string; chapter: number }>;
  return new Map(rows.map((row) => [row.id, row.chapter]));
}

/**
 * The closure, breadth first: the first visit of a node is its shortest path, and the neighbour
 * order above is the tie-break, so two runs over the same rows print the same plan. A seed that
 * does not exist is simply not a node — the caller decides whether that is `proven: false`.
 */
export function walk(db: Db, seeds: readonly string[], options: WalkOptions = {}): WalkResult {
  const direction = options.direction ?? 'both';
  const depthLimit = options.depthLimit ?? WALK_DEPTH_LIMIT;
  const nodeValve = options.nodeValve ?? WALK_NODE_VALVE;
  const chapters = chaptersOf(db);
  const graph = adjacency(db);
  const wanted = (step: Step): boolean =>
    direction === 'both' || (direction === 'forward' ? step.direction === 'forward' : step.direction === 'backward');

  const seen = new Map<string, WalkNode>();
  const queue: WalkNode[] = [];
  let truncated = false;
  for (const seed of [...new Set(seeds)].sort(compare)) {
    if (!chapters.has(seed)) continue;
    if (seen.has(seed)) continue;
    if (seen.size >= nodeValve) {
      truncated = true;
      break;
    }
    const node: WalkNode = { factId: seed, chapter: chapters.get(seed) ?? 0, hops: 0, direction: 'seed', via: [] };
    seen.set(seed, node);
    queue.push(node);
  }

  const used = new Map<string, EdgeRow>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    if (node === undefined || node.hops >= depthLimit) continue;
    for (const step of graph.get(node.factId) ?? []) {
      if (!wanted(step)) continue;
      if (seen.has(step.to)) continue;
      if (seen.size >= nodeValve) {
        truncated = true;
        break;
      }
      const hop: WalkHop = {
        edgeId: step.edge.id,
        kind: step.edge.kind,
        onComponent: step.edge.on_component,
        to: step.to,
      };
      const next: WalkNode = {
        factId: step.to,
        chapter: chapters.get(step.to) ?? 0,
        hops: node.hops + 1,
        direction: step.direction,
        via: [...node.via, hop],
      };
      seen.set(step.to, next);
      queue.push(next);
      used.set(step.edge.id, step.edge);
    }
    if (truncated) break;
  }

  const nodes = [...seen.values()].sort((left, right) => compare(left.factId, right.factId));
  const edges = [...used.values()].sort(
    (left, right) =>
      compare(left.from_fact, right.from_fact) ||
      compare(left.to_fact, right.to_fact) ||
      compare(left.kind, right.kind) ||
      left.chapter - right.chapter ||
      compare(left.id, right.id),
  );
  return { nodes, edges, truncated };
}
