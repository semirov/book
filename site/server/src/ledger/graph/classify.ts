/**
 * Mandatory or optional — a predicate, not a reading (BOOK-173, BOOK-DOC-75 §2).
 *
 * A node is **mandatory** iff all four hold:
 *
 *   1. its claim is *still asserted* — a live mention of the fact sits in a block whose current
 *      text still contains the witness (the caller measures this; a fact whose text was edited
 *      away binds nothing);
 *   2. a walk from a seed reaches it;
 *   3. the **first hop** of that path consumes a component the change actually moved
 *      (`on_component ∈ moved`) — this is what «the path proves its premise changed» means, and it
 *      is why `edges.on_component` exists at all;
 *   4. it has not already been executed in this change.
 *
 * Everything else reachable is optional, with one closed reason code: `MOTIF` (a premise reached
 * backwards, still standing), `GENERIC_KEY` (the node rides a document bucket — a noun with no
 * number, so its «identity» is the whole class and proves nothing), `TONE` (the first hop consumes
 * a value the change did not touch — the link is voice), or `UNPROVEN_CAUSE` (no asserted claim,
 * or nothing the change moved on the way in).
 *
 * A mandatory node's reason names the edge that made it mandatory — `CAUSE_CHANGED:F12` forward,
 * `SUPPORT_LOST:F9` backward — never a sentence. The engine calls no model here: four sets and a
 * comparison, the same answer every run.
 */

import type { Component } from './components.ts';
import type { WalkDirection, WalkNode } from './edges.ts';

export const OPTIONAL_REASONS = ['TONE', 'MOTIF', 'GENERIC_KEY', 'UNPROVEN_CAUSE'] as const;
export type OptionalReason = (typeof OPTIONAL_REASONS)[number];
export type Reason = `CAUSE_CHANGED:${string}` | `SUPPORT_LOST:${string}` | OptionalReason;

export type ClassifiedNode = {
  factId: string;
  chapter: number;
  mandatory: boolean;
  reason: Reason;
  direction: WalkDirection;
  hops: number;
  /** The edge ids from the seed to this node: `via[0]` is the hop the predicate reads. */
  via: string[];
};

export type ClassifyOptions = {
  /** The components the change moved (`movedComponents(before, after)`). */
  moved: ReadonlySet<Component>;
  /** The seed facts — «the point of change», not consequences, so they are not classified. */
  seeds: readonly string[];
  /** The facts whose claim is still asserted (`assertedFacts(db)`). */
  asserted: ReadonlySet<string>;
  /** Facts already patched in this change — an executed node is not mandatory again. */
  executed?: Iterable<string>;
};

/**
 * Classify the walk. Seeds are skipped: a seed is where the change happens and is patched at the
 * point, so counting it as a consequence would make `local` unreachable.
 */
export function classify(nodes: readonly WalkNode[], options: ClassifyOptions): ClassifiedNode[] {
  const seeds = new Set(options.seeds);
  const executed = new Set<string>(options.executed ?? []);
  const classified: ClassifiedNode[] = [];
  for (const node of nodes) {
    if (seeds.has(node.factId)) continue;
    const via = node.via.map((hop) => hop.edgeId);
    const first = node.via[0];
    const mandatory =
      first !== undefined &&
      node.hops >= 1 &&
      options.asserted.has(node.factId) &&
      options.moved.has(first.onComponent) &&
      !executed.has(node.factId);
    if (mandatory) {
      const code = node.direction === 'backward' ? 'SUPPORT_LOST' : 'CAUSE_CHANGED';
      classified.push({
        factId: node.factId,
        chapter: node.chapter,
        mandatory: true,
        reason: `${code}:${first.edgeId}`,
        direction: node.direction,
        hops: node.hops,
        via,
      });
      continue;
    }
    classified.push({
      factId: node.factId,
      chapter: node.chapter,
      mandatory: false,
      reason: optionalReason(node, options),
      direction: node.direction,
      hops: node.hops,
      via,
    });
  }
  return classified.sort((left, right) =>
    left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0,
  );
}

/** A document fact whose key is the bare noun: «акт», not «акт 4-У». The bucket, not an instance. */
const GENERIC_DOCUMENT = /^f:d:[^\d@]+@/u;

/**
 * Why a reachable node is not mandatory. The order is the design's: an unasserted claim is not a
 * tone question; a premise reached backwards is a motif that still stands; a bucket key is the
 * generic identity the measurement exposed; a hop on a value the change did not touch is voice;
 * anything else was not proved.
 */
function optionalReason(node: WalkNode, options: ClassifyOptions): OptionalReason {
  const first = node.via[0];
  if (first === undefined || node.hops < 1 || !options.asserted.has(node.factId)) return 'UNPROVEN_CAUSE';
  if (node.direction === 'backward') return 'MOTIF';
  if (GENERIC_DOCUMENT.test(node.factId)) return 'GENERIC_KEY';
  if (first.onComponent === 'value') return 'TONE';
  return 'UNPROVEN_CAUSE';
}
