/**
 * The closure (ADR-040 §3, BOOK-174) — every fact whose support one change moves, both
 * directions, across the whole book, with the edge that reached each one.
 *
 * The walk itself lives in `walk.ts`: one recursive CTE per direction returns the reachable **id
 * set** (`UNION`, cycle-safe, polynomial), and one breadth-first pass over the same live edges
 * assigns `distance`, `via` and `chapterDistance`. This module is what the closure *is* (the
 * union over seeds, the induced edges, the mandatory/optional split) and how it is measured.
 *
 * `via` is the edge that reached a node at its **smallest** distance, so the closure is a spanning
 * tree and «why did chapter 12 change» is a walk down the tree (§5.2). When two paths tie, the
 * walk that came *from the cause side* wins (`ancestor` before `descendant`), then the smaller
 * seed id, then the smaller edge id — the tie-break is fixed here so the same ledger always
 * prints the same bytes (§3.2 item 6).
 *
 * Cycles are **reported, never thrown** (§3.4): a `document` loop is literature, and a walk that
 * refused to run on one could not measure the book it lives in.
 */

import type { Db } from '../db/db.ts';
import { findCycles } from './cycles.ts';
import { partsOf, type Part } from './parts.ts';
import {
  compareEdges,
  compareNodes,
  explore,
  indexEdges,
  LIVE_FACT,
  liveFactOf,
  loadLiveEdges,
  type ClosureEdge,
  type ClosureNode,
  type Direction,
  type FactRow,
} from './walk.ts';

export type { ClosureEdge, ClosureNode, Direction } from './walk.ts';

export type ClosureCycle = { nodes: string[]; edges: string[] };

export type Closure = {
  seeds: string[];
  nodes: ClosureNode[];
  /** The subgraph induced by the walk: every live edge whose two endpoints are nodes. */
  edges: ClosureEdge[];
  chapters: number[];
  parts: Part[];
  /** Ancestors and descendants, seeds excluded. */
  back: number;
  forward: number;
  cycles: ClosureCycle[];
};

/** The cause side of one fact: «does the cause still lead here?» (§3.1). */
export function ancestors(db: Db, factId: string): ClosureNode[] {
  return oneDirection(db, factId, 'ancestor');
}

/** The consequence side of one fact: «what follows differently now?» (§3.1). */
export function descendants(db: Db, factId: string): ClosureNode[] {
  return oneDirection(db, factId, 'descendant');
}

function oneDirection(db: Db, factId: string, direction: 'ancestor' | 'descendant'): ClosureNode[] {
  const found = explore(db, factId, direction, indexEdges(loadLiveEdges(db)));
  if (!found.facts.has(factId)) refuseMissing(db, [factId]);
  return found.nodes;
}

/**
 * A seed the ledger does not have is a caller's bug; a seed a later run retired is a stale caller.
 * Both are refused, with the sentence that says which — an empty closure would answer «nothing
 * moved» to a question nobody could have asked.
 */
function refuseMissing(db: Db, ids: readonly string[]): never {
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id FROM facts WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string }>;
  const known = new Set(rows.map((row) => row.id));
  const retired = ids.filter((id) => known.has(id)).sort();
  if (retired.length > 0) throw new Error(`retired fact ${retired.join(', ')}`);
  throw new Error(`unknown fact ${[...ids].sort().join(', ')}`);
}

/**
 * The closure of a set of seeds: the union of both walks over every seed, the seeds at distance
 * 0, and the induced edge set. Deterministic — the same ledger and the same seeds produce the
 * same object, and therefore the same bytes.
 */
export function closure(db: Db, seeds: readonly string[]): Closure {
  const wanted = [...new Set(seeds.filter((seed) => seed !== ''))].sort();
  if (wanted.length === 0) {
    return { seeds: [], nodes: [], edges: [], chapters: [], parts: [], back: 0, forward: 0, cycles: [] };
  }

  const edgeMap = loadLiveEdges(db);
  const index = indexEdges(edgeMap);
  const chosen = new Map<string, Chosen>();
  const facts = new Map<string, FactRow>();
  for (const seed of wanted) {
    for (const direction of ['ancestor', 'descendant'] as const) {
      const found = explore(db, seed, direction, index);
      for (const [id, fact] of found.facts) facts.set(id, fact);
      for (const node of found.nodes) {
        const candidate: Chosen = {
          distance: node.distance,
          chapterDistance: node.chapterDistance,
          via: node.via,
          direction,
          seed,
        };
        const current = chosen.get(node.factId);
        if (current === undefined || beats(candidate, current)) chosen.set(node.factId, candidate);
      }
    }
  }

  const missing = wanted.filter((seed) => !facts.has(seed));
  if (missing.length > 0) refuseMissing(db, missing);
  for (const seed of wanted) {
    const current = chosen.get(seed);
    const seedPick: Chosen = { distance: 0, chapterDistance: 0, via: null, direction: 'seed', seed };
    if (current === undefined || beats(seedPick, current)) chosen.set(seed, seedPick);
  }

  const nodes: ClosureNode[] = [];
  for (const [factId, pick] of chosen) {
    const fact = facts.get(factId);
    if (fact === undefined) continue;
    nodes.push({
      factId,
      key: fact.key,
      kind: fact.kind,
      chapter: fact.chapter,
      distance: pick.distance,
      chapterDistance: pick.chapterDistance,
      direction: pick.direction,
      via: pick.via,
    });
  }
  nodes.sort(compareNodes);

  const nodeIds = new Set(nodes.map((node) => node.factId));
  const induced = [...edgeMap.values()].filter((edge) => nodeIds.has(edge.fromFact) && nodeIds.has(edge.toFact));
  induced.sort(compareEdges);

  const chapters = [...new Set(nodes.map((node) => node.chapter))].sort((left, right) => left - right);
  const back = nodes.filter((node) => node.direction === 'ancestor').length;
  const forward = nodes.filter((node) => node.direction === 'descendant').length;

  return {
    seeds: wanted,
    nodes,
    edges: induced,
    chapters,
    parts: partsOf(chapters),
    back,
    forward,
    cycles: findCycles(nodes, induced),
  };
}

type Chosen = {
  distance: number;
  chapterDistance: number;
  via: string | null;
  direction: Direction;
  seed: string;
};

const DIRECTION_RANK: Record<Direction, number> = { seed: 0, ancestor: 1, descendant: 2 };

/** Smallest distance wins; a tie prefers the cause side, then the smaller seed, then the edge. */
function beats(candidate: Chosen, current: Chosen): boolean {
  if (candidate.distance !== current.distance) return candidate.distance < current.distance;
  if (candidate.direction !== current.direction) return DIRECTION_RANK[candidate.direction] < DIRECTION_RANK[current.direction];
  if (candidate.seed !== current.seed) return candidate.seed < current.seed;
  return (candidate.via ?? '') < (current.via ?? '');
}

/** A node the plan must patch, with the mechanical reason it must — never a sentence (§4.2). */
export type NodeVerdict = { factId: string; chapter: number; key: string; kind: string; reason: string };

export type MandatoryInput = {
  /** The chapter the change lands in. A node here is the change itself, not a consequence. */
  origin: number;
  /** The facts the patch removes, rewrites or adds — their support no longer stands. */
  touched: readonly string[];
  /** Facts a caller already knows lost their support; trusted as given, even outside the closure. */
  orphaned?: readonly string[];
};

/**
 * Mandatory vs optional, by the mechanical rule of §4.2 and nothing else: a node in another
 * chapter is mandatory when **its only live incoming edge comes from a touched fact** (its
 * support would vanish) or when it is already orphaned; every other node is optional.
 *
 * The split is total: every node lands in exactly one list, so `mandatory + optional` is the
 * closure and a reader can reconcile the counts. A node in the origin chapter is the change
 * itself — listed as optional for that one reason, `origin`, never dropped. An `orphaned` id the
 * closure never reached is mandatory too: a caller that knows of an unsupported fact is not
 * allowed to have it disappear from the plan.
 *
 * This is deliberately not the editor's test («name the sentence that becomes false»): that
 * verdict is a reader's, and code that pretended to make it would be a judge. The reason string
 * is `sole support: <edge id>` — machine-checkable — not prose.
 */
export function mandatoryOf(
  db: Db,
  nodes: readonly ClosureNode[],
  input: MandatoryInput,
): { mandatory: NodeVerdict[]; optional: NodeVerdict[] } {
  const known = new Set(input.orphaned ?? []);
  const touched = new Set(input.touched);
  const byId = new Map(nodes.map((node) => [node.factId, node]));
  const ids = nodes.filter((node) => node.chapter !== input.origin).map((node) => node.factId);

  const incoming = new Map<string, Array<{ id: string; from: string }>>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT e.id, e."from" AS fromFact, e."to" AS toFact
           FROM fact_dependency e
           JOIN facts f ON f.id = e."from"
          WHERE e.superseded_by IS NULL AND e.retired_by_run IS NULL
            AND ${liveFactOf('f')}
            AND e."to" IN (${placeholders})
          ORDER BY e.id`,
      )
      .all(...ids) as Array<{ id: string; fromFact: string; toFact: string }>;
    for (const row of rows) {
      const list = incoming.get(row.toFact) ?? [];
      list.push({ id: row.id, from: row.fromFact });
      incoming.set(row.toFact, list);
    }
  }

  const mandatory: NodeVerdict[] = [];
  const optional: NodeVerdict[] = [];
  for (const node of nodes) {
    // The change itself: nothing about it «becomes false», so it is listed and never counted.
    if (node.chapter === input.origin) optional.push({ ...verdictOf(node), reason: 'origin' });
  }
  for (const factId of ids) {
    const node = byId.get(factId);
    if (node === undefined) continue;
    const support = incoming.get(factId) ?? [];
    const surviving = support.filter((edge) => !touched.has(edge.from));
    if (support.length === 0) {
      // No incoming edge at all: a source (a paper, a date). Nothing vanished, so nothing is false.
      if (!known.has(factId)) {
        optional.push({ ...verdictOf(node), reason: 'no support to lose' });
        continue;
      }
      mandatory.push({ ...verdictOf(node), reason: 'orphaned: no live support' });
      continue;
    }
    if (surviving.length === 0) {
      mandatory.push({ ...verdictOf(node), reason: `sole support: ${support.map((edge) => edge.id).join(', ')}` });
      continue;
    }
    optional.push({ ...verdictOf(node), reason: `support: ${surviving.map((edge) => edge.id).join(', ')}` });
  }
  for (const factId of known) {
    if (byId.has(factId)) continue;
    mandatory.push({ ...orphanVerdict(db, factId), reason: 'orphaned: no live support' });
  }
  return { mandatory: mandatory.sort(compareVerdicts), optional: optional.sort(compareVerdicts) };
}

function verdictOf(node: ClosureNode): Omit<NodeVerdict, 'reason'> {
  return { factId: node.factId, chapter: node.chapter, key: node.key, kind: node.kind };
}

/** A known orphan the closure never reached: read from the ledger, or refused if it is not there. */
function orphanVerdict(db: Db, factId: string): Omit<NodeVerdict, 'reason'> {
  const row = db.prepare(`SELECT id, key, kind, chapter FROM facts WHERE id = ?`).get(factId) as
    | { id: string; key: string; kind: string; chapter: number }
    | undefined;
  if (row === undefined) throw new Error(`unknown fact ${factId}`);
  return { factId: row.id, chapter: row.chapter, key: row.key, kind: row.kind };
}

function compareVerdicts(left: NodeVerdict, right: NodeVerdict): number {
  return left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0;
}

export type BenchResult = {
  runs: number;
  p50: number;
  p95: number;
  max: number;
  nodesAvg: number;
  nodesMax: number;
  jsonBytesMax: number;
};

/** Nearest-rank percentile over a sorted sample: `p95` of 100 runs is the 95th smallest. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function ms(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * T0 (ADR-040 §9): the full closure for **every live fact** as a seed, timed. The budget is
 * p95 ≤ 25 ms and the CLI fails the build over it; this function only measures, because a
 * measurement that also refused would have no numbers to print.
 *
 * A seed is a live fact: a retired row is history, so counting it would benchmark closures nobody
 * can ask for and inflate `runs` past the fact count of the book.
 *
 * The whole closure is stringified to measure the JSON the plan row would store (§5.1) — the
 * 150 KB ceiling in §3.4 is about those bytes, not about the node count.
 */
export function bench(db: Db, options: { seeds?: readonly string[] } = {}): BenchResult {
  const seeds =
    options.seeds === undefined
      ? (db.prepare(`SELECT id FROM facts WHERE ${LIVE_FACT} ORDER BY id`).all() as Array<{ id: string }>).map(
          (row) => row.id,
        )
      : [...options.seeds];

  const times: number[] = [];
  let nodeSum = 0;
  let nodesMax = 0;
  let jsonBytesMax = 0;
  for (const seed of seeds) {
    const started = performance.now();
    const measured = closure(db, [seed]);
    times.push(performance.now() - started);
    nodeSum += measured.nodes.length;
    nodesMax = Math.max(nodesMax, measured.nodes.length);
    jsonBytesMax = Math.max(jsonBytesMax, Buffer.byteLength(JSON.stringify(measured), 'utf8'));
  }

  const sorted = [...times].sort((left, right) => left - right);
  return {
    runs: seeds.length,
    p50: ms(percentile(sorted, 0.5)),
    p95: ms(percentile(sorted, 0.95)),
    max: ms(sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0)),
    nodesAvg: seeds.length === 0 ? 0 : Math.round((nodeSum / seeds.length) * 100) / 100,
    nodesMax,
    jsonBytesMax,
  };
}
