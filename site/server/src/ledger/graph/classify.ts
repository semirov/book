/**
 * Mandatory or optional — an adapter over main's closure (BOOK-173, BOOK-DOC-75 §2).
 *
 * The graph and the rule that splits it are BOOK-185's (`graph/closure.ts`): `closure()` walks
 * `fact_dependency` in both directions across the whole book, and `mandatoryOf()` answers «which
 * node loses its only support» by the mechanical test — a node in another chapter is mandatory
 * when its only live incoming edge comes from a fact the patch touched, or when it is already
 * orphaned. This module does two things on top and nothing else:
 *
 *   1. it drops the seeds — a seed is where the change happens and is patched at the point, so
 *      counting it as a consequence would make `local` unreachable;
 *   2. it drops the facts this change already patched — an executed node is not mandatory again,
 *      which is what keeps a repair from parking as `CLOSURE_UNSTABLE` for its own work.
 *
 * Every reason is main's own, machine-checkable (`sole support: <edge id>`), and never a sentence
 * the code pretended to read. The engine calls no model here: sets and a comparison, the same
 * answer every run.
 */

import type { Db } from '../../db/db.ts';
import { mandatoryOf, type ClosureNode, type Direction } from '../../graph/closure.ts';

export type ClassifiedNode = {
  factId: string;
  chapter: number;
  mandatory: boolean;
  reason: string;
  /** Main's own word: `ancestor` (the cause side), `descendant` (the consequence side). */
  direction: Direction;
  /** Edges from the nearest seed — main's `distance`. */
  hops: number;
  /** The edge that reached this node at its smallest distance; `''` for a node that is not reached. */
  via: string;
};

export type ClassifyOptions = {
  /** The chapter the change lands in. A node here is the change itself, not a consequence. */
  origin: number;
  /** The seed facts — «the point of change», not consequences, so they are not classified. */
  seeds: readonly string[];
  /** The facts the patch removed, rewrote or added: their support no longer stands (main's `touched`). */
  touched: readonly string[];
  /** Facts a caller already knows lost their support (main's `orphaned`). */
  orphaned?: readonly string[];
  /** Facts already patched in this change — an executed node is not mandatory again. */
  executed?: Iterable<string>;
};

/**
 * Classify the closure. The split is `mandatoryOf()`'s; this function only decides which nodes
 * reach it. Order is by fact id, so the same ledger prints the same plan.
 */
export function classify(db: Db, nodes: readonly ClosureNode[], options: ClassifyOptions): ClassifiedNode[] {
  const seeds = new Set(options.seeds);
  const executed = new Set<string>(options.executed ?? []);
  const consequences = nodes.filter((node) => !seeds.has(node.factId));
  const split = mandatoryOf(db, consequences, {
    origin: options.origin,
    touched: options.touched,
    orphaned: options.orphaned ?? [],
  });
  const mandatoryIds = new Set(split.mandatory.map((verdict) => verdict.factId));
  const reasonOf = new Map([...split.mandatory, ...split.optional].map((verdict) => [verdict.factId, verdict.reason]));
  const classified: ClassifiedNode[] = [];
  for (const node of consequences) {
    const reason = reasonOf.get(node.factId);
    if (reason === undefined) continue;
    // An executed node is optional whatever the ledger says now: the change already patched it,
    // and the doubt the drainer watches for is a node that comes **back** by another edge.
    const executedHere = executed.has(node.factId);
    classified.push({
      factId: node.factId,
      chapter: node.chapter,
      mandatory: mandatoryIds.has(node.factId) && !executedHere,
      reason: executedHere ? 'executed' : reason,
      direction: node.direction,
      hops: node.distance,
      via: node.via ?? '',
    });
  }
  return classified.sort((left, right) =>
    left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0,
  );
}
