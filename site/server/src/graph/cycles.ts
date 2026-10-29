/**
 * The cycles of a closure (ADR-040 §3.4, BOOK-174) — **reported, never thrown**.
 *
 * With G1 a cycle through `cause`, `promise`, `absence` or `decision` is impossible by
 * construction, so the only loop the book can hold is `document`: a form that cites itself, a
 * report that predicts its own correction. That is the deliberate device, not a data error — so a
 * closure that walks into one still reports every node, and `CLOSURE_UNSTABLE` names the loop
 * with its nodes and the edge path that closes it (§4.3).
 *
 * One closed walk per back edge of a depth-first search from each node in book order, deduped by
 * the node/edge set: enumerating every elementary cycle is exponential and buys nothing here — a
 * plan needs to be told «these facts come back to themselves», once.
 */

import type { ClosureCycle, ClosureEdge, ClosureNode } from './closure.ts';

/** Edge order for the search: the id is unique per (from, to, kind, chapter), so it is total. */
const byId = (left: ClosureEdge, right: ClosureEdge): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * Every cycle inside the induced subgraph, as the node ids and the edge path that closes it.
 *
 * One closed walk per back edge of a depth-first search from each node in book order, deduped by
 * the node/edge set: enumerating every elementary cycle is exponential and buys nothing the
 * design asks for — the graph's only legal circularity is a `document` loop, and naming it once
 * is what `CLOSURE_UNSTABLE` prints (§4.3).
 */
export function findCycles(nodes: readonly ClosureNode[], edges: readonly ClosureEdge[]): ClosureCycle[] {
  const adjacency = new Map<string, Array<{ to: string; id: string }>>();
  for (const node of nodes) adjacency.set(node.factId, []);
  for (const edge of [...edges].sort(byId)) {
    const list = adjacency.get(edge.fromFact);
    if (list === undefined) continue;
    list.push({ to: edge.toFact, id: edge.id });
  }

  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const stackEdges: string[] = [];
  const found = new Map<string, ClosureCycle>();

  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const seen = state.get(next.to);
      if (seen === undefined) {
        stackEdges.push(next.id);
        visit(next.to);
        stackEdges.pop();
      } else if (seen === 1) {
        const from = stack.lastIndexOf(next.to);
        if (from < 0) continue;
        const cycleNodes = stack.slice(from);
        const cycleEdges = [...stackEdges.slice(from), next.id];
        const key = `${[...cycleNodes].sort().join(',')}|${[...cycleEdges].sort().join(',')}`;
        if (!found.has(key)) found.set(key, { nodes: cycleNodes, edges: cycleEdges });
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of nodes) if (!state.has(node.factId)) visit(node.factId);
  return [...found.values()].sort((left, right) => {
    const leftKey = left.nodes.join(',');
    const rightKey = right.nodes.join(',');
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.edges.length - right.edges.length;
  });
}
