/**
 * Which way an edge may run (BOOK-185 §3; BOOK-DOC-77 §3).
 *
 * A `cause` and a `promise` run from an earlier fact to a later one — an effect cannot cause its
 * cause — and every other kind starts at the effect and points back, so its from-chapter is never
 * later than its to-chapter. A `document` edge is free in both directions: a paper and the act it
 * records have no order in time.
 *
 * Pure and without a database: the validator hands two resolved endpoints over and gets a reason
 * or nothing. The module exists because `validate.ts` reached the file limit, not because a reader
 * should reach for it from anywhere else.
 */

import type { EdgeEndpoint } from './judged.ts';
import type { EdgeKind } from './schema.ts';
import type { EstablishedFact } from './validate.ts';

/** A local ref (`f1`) resolved to its endpoint, or an established key resolved to its row. */
export function endpointOf(
  value: string | { key: string },
  refs: Map<string, EdgeEndpoint>,
  established: Map<string, EstablishedFact>,
): EdgeEndpoint | null {
  if (typeof value === 'string') return refs.get(value) ?? null;
  const live = established.get(value.key);
  if (live === undefined) return null;
  return { key: live.key, kind: live.kind, chapter: live.chapter, factId: live.id, source: 'established' };
}

/** `null` when the order holds, a reason when it does not. */
export function orderProblem(kind: EdgeKind, from: EdgeEndpoint, to: EdgeEndpoint): string | null {
  if (kind === 'document') return null;
  if (kind === 'cause' || kind === 'promise') {
    if (from.chapter < to.chapter) return null;
    return `a ${kind} edge runs from an earlier fact to a later one: from chapter ${String(from.chapter)} is not earlier than to chapter ${String(to.chapter)}`;
  }
  if (from.chapter <= to.chapter) return null;
  return `an ${kind} edge starts at the same chapter or earlier, never later: from chapter ${String(from.chapter)} is later than to chapter ${String(to.chapter)}`;
}
