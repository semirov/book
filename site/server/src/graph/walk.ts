/**
 * The walk of the closure (ADR-040 §3, BOOK-174): discovery, the live-edge map, and the one
 * breadth-first pass that turns a reachable id set into a spanning tree.
 *
 * **Discovery is one recursive CTE per direction, and it has no window.** Not a chapter cap, not
 * a node cap, not a depth cap: the walk stops when the frontier is empty. The owner's objection
 * (rev 2) is the requirement — «правка должна проверить, что вся причинность и следственность
 * будет соблюдена, а это может идти вообще через всю книгу» — so a bounded walk is not a smaller
 * closure, it is a lie that reports «closure empty» while three chapters have gone false.
 *
 * **The walk dedupes by node, never by path.** A recursive `UNION` returns the reachable **id
 * set**; `distance`, `via` and `chapterDistance` are then assigned by one breadth-first pass in
 * JS over the same live edges. Enumerating simple paths instead (`UNION ALL` + a per-path `instr`
 * guard) multiplies paths rather than nodes: two facts supporting one consequence is a diamond,
 * and 22 diamonds in a chain made a single walk take 35 s for 67 facts. `UNION` is cycle-safe and
 * polynomial, and because a CTE can only dedupe by id, the tree is built where a tie-break can be
 * stated: edges sorted by id, and the smallest edge id wins among equal-distance arrivals.
 *
 * **A retired row is not the graph** (BOOK-DOC-77 §5). A fact is live when it is neither
 * invalidated nor superseded by a later run; an edge is live when it is neither superseded nor
 * retired by a run **and both of its endpoints are live**. Every read in this module — the walk,
 * the edge map, the fact loader — applies that one predicate, so a consequence whose cause went
 * false cannot be reached and cannot be counted as supported.
 */

import type { Db } from '../db/db.ts';

export type Direction = 'seed' | 'ancestor' | 'descendant';

export type ClosureNode = {
  factId: string;
  key: string;
  kind: string;
  chapter: number;
  /** Edges walked from the nearest seed. A seed is 0. */
  distance: number;
  /** Chapters the shortest path crosses: distinct chapters on the path, minus one. */
  chapterDistance: number;
  direction: Direction;
  /** The edge that reached this node at `distance`; null for a seed. */
  via: string | null;
};

export type ClosureEdge = {
  id: string;
  fromFact: string;
  toFact: string;
  kind: string;
  chapter: number;
};

export type FactRow = { id: string; key: string; kind: string; chapter: number };

export type EdgeRow = ClosureEdge;

/** One step of the tree: how far a node is from the seed, and the edge that reached it. */
export type Step = { distance: number; via: string | null };

/** What makes a fact the graph: neither invalidated by a change nor retired by a later run. */
export const LIVE_FACT = 'invalidated_at IS NULL AND superseded_by_extraction IS NULL';

/**
 * What makes an edge the graph (BOOK-DOC-77). An edge is retired two ways and both are excluded
 * from every live read: `superseded_by` — another edge replaced this claim — and `retired_by_run`
 * — a later extraction run replaced the whole pass that wrote it. One constant, so the walk, the
 * edge loader and the closure's own reads cannot drift apart.
 */
export const LIVE_EDGE = 'e.superseded_by IS NULL AND e.retired_by_run IS NULL';

/** `LIVE_FACT` under a table alias, for the queries that join `facts` twice. */
export function liveFactOf(alias: string): string {
  return `${alias}.invalidated_at IS NULL AND ${alias}.superseded_by_extraction IS NULL`;
}

/**
 * The walk, written once per direction.
 *
 * `UNION`, not `UNION ALL`: the recursion dedupes by fact id, so a fact is visited once however
 * many ways reach it, and a `document` loop terminates without a path string to compare against.
 * A dead fact is never stepped on — it is history, not a node — so an edge that names a retired
 * fact reaches nothing.
 */
function walkSql(direction: 'ancestor' | 'descendant'): string {
  const from = direction === 'ancestor' ? 'e.from_fact' : 'e.to_fact';
  const joinOn = direction === 'ancestor' ? 'e.to_fact = walk.id' : 'e.from_fact = walk.id';
  return `WITH RECURSIVE walk(id) AS (
      SELECT :seed
      UNION
      SELECT ${from}
        FROM fact_dependency e
        JOIN walk ON ${joinOn}
        JOIN facts f ON f.id = ${from}
       WHERE ${LIVE_EDGE}
         AND ${liveFactOf('f')}
    )
    SELECT id FROM walk ORDER BY id`;
}

/** The reachable id set of one direction: what a `UNION` walk can say, and all it can say. */
export function walk(db: Db, seed: string, direction: 'ancestor' | 'descendant'): string[] {
  const rows = db.prepare(walkSql(direction)).all({ seed }) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** The live facts behind a set of ids; a retired or missing one is not a node. */
export function loadFacts(db: Db, ids: readonly string[]): Map<string, FactRow> {
  const unique = [...new Set(ids)];
  const facts = new Map<string, FactRow>();
  if (unique.length === 0) return facts;
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, key, kind, chapter FROM facts WHERE ${LIVE_FACT} AND id IN (${placeholders})`)
    .all(...unique) as FactRow[];
  for (const row of rows) facts.set(row.id, row);
  return facts;
}

/**
 * Every live edge, by id — the closure walks over these and reports the ones it induced. Both
 * endpoints must be live: an edge a pass left pointing at a retired fact is not a claim about the
 * book any more, even when the edge row itself was never retired.
 */
export function loadLiveEdges(db: Db): Map<string, EdgeRow> {
  const rows = db
    .prepare(
      `SELECT e.id, e.from_fact AS fromFact, e.to_fact AS toFact, e.kind, e.chapter
         FROM fact_dependency e
         JOIN facts f ON f.id = e.from_fact
         JOIN facts t ON t.id = e.to_fact
        WHERE ${LIVE_EDGE}
          AND ${liveFactOf('f')}
          AND ${liveFactOf('t')}`,
    )
    .all() as EdgeRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The live edges, indexed by both ends and sorted by id. The sort is what makes the tree
 * deterministic: among edges that reach a node at the same distance, the smallest id wins,
 * whoever discovered it first.
 */
export type EdgeIndex = {
  byId: ReadonlyMap<string, EdgeRow>;
  out: Map<string, EdgeRow[]>;
  into: Map<string, EdgeRow[]>;
};

export function indexEdges(edges: ReadonlyMap<string, EdgeRow>): EdgeIndex {
  const sorted = [...edges.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const index: EdgeIndex = { byId: edges, out: new Map(), into: new Map() };
  for (const edge of sorted) {
    const out = index.out.get(edge.fromFact) ?? [];
    out.push(edge);
    index.out.set(edge.fromFact, out);
    const into = index.into.get(edge.toFact) ?? [];
    into.push(edge);
    index.into.set(edge.toFact, into);
  }
  return index;
}

/**
 * Breadth-first over the live edges, inside the id set the CTE reached: the shortest distance and
 * the smallest equal-distance edge id, level by level. No path strings and no bare columns — the
 * frontier order cannot leak into the answer, because a tie is broken by the edge id alone.
 */
export function bfs(
  seed: string,
  direction: 'ancestor' | 'descendant',
  index: EdgeIndex,
  reached: ReadonlySet<string>,
): Map<string, Step> {
  const steps = new Map<string, Step>([[seed, { distance: 0, via: null }]]);
  let frontier: string[] = [seed];
  for (let distance = 1; frontier.length > 0; distance += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const edges = (direction === 'ancestor' ? index.into : index.out).get(current) ?? [];
      for (const edge of edges) {
        const step = direction === 'ancestor' ? edge.fromFact : edge.toFact;
        // Only the id set the CTE proved; a step outside it would be a second discovery.
        if (!reached.has(step)) continue;
        const seen = steps.get(step);
        if (seen !== undefined) {
          if (seen.distance === distance && (seen.via ?? '') > edge.id) seen.via = edge.id;
          continue;
        }
        steps.set(step, { distance, via: edge.id });
        next.push(step);
      }
    }
    frontier = next;
  }
  return steps;
}

/**
 * How many chapter boundaries the path crossed: the distinct chapters from the seed to the node,
 * minus one. Same chapter is 0; one edge into the next chapter is 1; a detour through a third
 * chapter is 2 even when both ends sit next door.
 */
export function chapterDistanceOf(
  factId: string,
  tree: ReadonlyMap<string, Step>,
  edges: ReadonlyMap<string, EdgeRow>,
  chapterOf: (id: string) => number,
): number {
  const chapters = new Set<number>([chapterOf(factId)]);
  const visited = new Set<string>([factId]);
  let current = factId;
  for (;;) {
    const row = tree.get(current);
    if (row === undefined || row.via === null) break;
    const edge = edges.get(row.via);
    if (edge === undefined) break;
    const parent = edge.fromFact === current ? edge.toFact : edge.fromFact;
    if (visited.has(parent)) break;
    visited.add(parent);
    chapters.add(chapterOf(parent));
    current = parent;
  }
  return chapters.size - 1;
}

/** Sort key for a node: the book's order first, then the identity, so printing is stable. */
export function compareNodes(left: ClosureNode, right: ClosureNode): number {
  if (left.chapter !== right.chapter) return left.chapter - right.chapter;
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  return left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0;
}

export function compareEdges(left: ClosureEdge, right: ClosureEdge): number {
  if (left.chapter !== right.chapter) return left.chapter - right.chapter;
  if (left.fromFact !== right.fromFact) return left.fromFact < right.fromFact ? -1 : 1;
  if (left.toFact !== right.toFact) return left.toFact < right.toFact ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export type Exploration = { facts: Map<string, FactRow>; nodes: ClosureNode[] };

/** One direction of the walk from one seed, with every node's chapter distance resolved. */
export function explore(
  db: Db,
  seed: string,
  direction: 'ancestor' | 'descendant',
  index: EdgeIndex,
): Exploration {
  const reached = new Set(walk(db, seed, direction));
  const tree = bfs(seed, direction, index, reached);
  const facts = loadFacts(db, [...tree.keys()]);
  const chapterOf = (id: string): number => facts.get(id)?.chapter ?? 0;
  const nodes: ClosureNode[] = [];
  for (const [id, step] of tree) {
    const fact = facts.get(id);
    if (fact === undefined) continue;
    nodes.push({
      factId: id,
      key: fact.key,
      kind: fact.kind,
      chapter: fact.chapter,
      distance: step.distance,
      chapterDistance: chapterDistanceOf(id, tree, index.byId, chapterOf),
      // The seed is the seed, whichever direction was asked for: its distance is 0 in both.
      direction: step.distance === 0 ? 'seed' : direction,
      via: step.via,
    });
  }
  nodes.sort(compareNodes);
  return { facts, nodes };
}
