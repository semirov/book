/**
 * T0 (ADR-040 §9): the closure benchmark. It runs one closure per live fact, so `runs` must equal
 * the fact count — a benchmark that silently skipped a seed would be a smaller number pretending
 * to be the book, and one that counted a retired row would measure closures nobody can ask for —
 * and p95 is the number the CLI fails over, not an average that hides a spike.
 *
 * The wall-clock bound here is **load tolerance, not the budget**. The 25 ms budget is `graph
 * bench`'s exit code on the machine that measures the book; a unit test on a shared, loaded box
 * cannot assert it without turning another agent's compile into a red test. The shape assertions
 * (runs, p95 ≥ p50, max ≥ p95, node and json sizes) are what this test is for — plus the
 * converging-support graph, whose per-path walk was 35 s for one closure and would have made the
 * whole benchmark hang.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bench } from '../../src/graph/closure.ts';
import { diamondChain, graphFixture, seedEdge, seedFact, seedRun, type GraphFixture } from './helpers.ts';

let fixture: GraphFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

/** A hub with three chains leaving it: 61 facts, and closures of 20+ nodes from the hub. */
function hubAndChains(): { db: GraphFixture['db']; facts: number } {
  fixture = graphFixture();
  const db = fixture.db;
  seedFact(db, { id: 'fct_hub', chapter: 2, kind: 'document', key: 'document:65-11877-арх' });
  let facts = 1;
  for (let chain = 0; chain < 3; chain += 1) {
    let previous = 'fct_hub';
    for (let step = 1; step <= 20; step += 1) {
      const id = `fct_${String(chain)}_${String(step)}`;
      const chapter = 2 + ((step + chain) % 15);
      seedFact(db, { id, chapter, kind: 'term', key: `term:${id}` });
      seedEdge(db, { id: `dep_${id}`, from: previous, to: id, chapter, kind: 'document' });
      previous = id;
      facts += 1;
    }
  }
  return { db, facts };
}

describe('bench', () => {
  it('runs one closure per live fact and stays inside a load-tolerant bound', () => {
    const { db, facts } = hubAndChains();
    const result = bench(db);
    expect(result.runs).toBe(facts);
    expect(typeof result.p95).toBe('number');
    // 2000 ms: a p95 two orders of magnitude over the budget is a real regression, a slow CI box
    // is not. The 25 ms budget itself is enforced by `graph bench`'s exit code (closureCli.ts).
    expect(result.p95).toBeLessThanOrEqual(2000);
    expect(result.p95).toBeGreaterThanOrEqual(result.p50);
    expect(result.max).toBeGreaterThanOrEqual(result.p95);
    expect(result.nodesMax).toBeGreaterThan(20);
    expect(result.nodesAvg).toBeGreaterThan(1);
    expect(result.jsonBytesMax).toBeGreaterThan(0);
  });

  it('measures only the seeds it was given', () => {
    const { db } = hubAndChains();
    const result = bench(db, { seeds: ['fct_hub'] });
    expect(result.runs).toBe(1);
    expect(result.nodesMax).toBe(61);
    expect(result.p50).toBeGreaterThanOrEqual(0);
  });

  it('reports zero runs for an empty ledger', () => {
    fixture = graphFixture();
    const result = bench(fixture.db);
    expect(result).toMatchObject({ runs: 0, p50: 0, p95: 0, max: 0, nodesAvg: 0, nodesMax: 0, jsonBytesMax: 0 });
  });

  it('measures 22 diamonds of converging support in milliseconds, one closure per fact', () => {
    fixture = graphFixture();
    const made = diamondChain(fixture.db, 22);
    const result = bench(fixture.db);
    expect(result.runs).toBe(made.facts);
    expect(result.nodesMax).toBe(made.facts);
    expect(result.p95).toBeLessThanOrEqual(2000);
    expect(result.p95).toBeGreaterThanOrEqual(result.p50);
  });

  it('does not seed from a fact a later run retired', () => {
    fixture = graphFixture();
    const db = fixture.db;
    seedFact(db, { id: 'fct_live', chapter: 1 });
    seedFact(db, { id: 'fct_dead', chapter: 2 });
    seedRun(db, { id: 'run_two', chapter: 2 });
    db.prepare(`UPDATE facts SET superseded_by_extraction = ? WHERE id = ?`).run('run_two', 'fct_dead');

    const result = bench(db);
    expect(result.runs).toBe(1);
    expect(result.nodesMax).toBe(1);
  });
});
