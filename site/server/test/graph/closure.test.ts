/**
 * The closure (BOOK-174, ADR-040 §3) — both directions, unbounded, deterministic.
 *
 * Six things are being pinned here, and each is a way a walk can lie: a hub that reaches eight
 * chapters must report all ten edges (no window), a `document` loop must terminate and be named
 * (no throw), forty nodes over twelve chapters must arrive whole (T4: no truncation), twenty-two
 * converging diamonds must arrive whole in milliseconds (a per-path walk is exponential), a fact a
 * later run retired must not be a node or a support, and the same ledger must print the same bytes
 * twice (determinism) while a retired edge is not walked.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { ancestors, closure, descendants, mandatoryOf } from '../../src/graph/closure.ts';
import {
  diamondChain,
  graphFixture,
  nodeOf,
  seedEdge,
  seedFact,
  seedRun,
  type GraphFixture,
} from './helpers.ts';

let fixture: GraphFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function open(): Db {
  fixture = graphFixture();
  return fixture.db;
}

describe('ancestors and descendants', () => {
  it('walks a hub into every chapter it reaches, one edge away', () => {
    const db = open();
    seedFact(db, { id: 'fct_hub', chapter: 2, kind: 'document', key: 'document:65-11877-арх' });
    const chapters = [1, 1, 2, 3, 4, 5, 6, 7, 8, 8];
    const targets = chapters.map((chapter, index) => {
      const id = `fct_t${String(index)}`;
      seedFact(db, { id, chapter, kind: 'date', key: `date:target-${String(index)}` });
      seedEdge(db, { id: `dep_${String(index)}`, from: 'fct_hub', to: id, chapter, kind: 'document' });
      return { id, chapter, edge: `dep_${String(index)}` };
    });

    const reached = descendants(db, 'fct_hub');
    const walked = reached.filter((node) => node.direction === 'descendant');
    expect(walked).toHaveLength(10);
    expect(reached.find((node) => node.factId === 'fct_hub')?.distance).toBe(0);
    for (const target of targets) {
      const node = walked.find((entry) => entry.factId === target.id);
      expect(node?.distance).toBe(1);
      expect(node?.via).toBe(target.edge);
      expect(node?.chapter).toBe(target.chapter);
      // One edge, so one boundary crossed — unless the seed and the row share a chapter.
      expect(node?.chapterDistance).toBe(target.chapter === 2 ? 0 : 1);
    }
    expect(new Set(reached.map((node) => node.chapter)).size).toBe(8);
    // Nothing points at the hub, so the cause side is the seed alone.
    expect(ancestors(db, 'fct_hub').filter((node) => node.direction === 'ancestor')).toHaveLength(0);
  });

  it('terminates on a document cycle, visits each node once and reports the loop', () => {
    const db = open();
    seedFact(db, { id: 'fct_a', chapter: 1, kind: 'document', key: 'document:form-a' });
    seedFact(db, { id: 'fct_b', chapter: 2, kind: 'document', key: 'document:form-b' });
    const forward = seedEdge(db, { id: 'dep_ab', from: 'fct_a', to: 'fct_b', chapter: 2, kind: 'document' });
    const back = seedEdge(db, { id: 'dep_ba', from: 'fct_b', to: 'fct_a', chapter: 1, kind: 'document' });

    const measured = closure(db, ['fct_a']);
    expect(measured.nodes.map((node) => node.factId).sort()).toEqual(['fct_a', 'fct_b']);
    expect(measured.nodes).toHaveLength(2);
    expect(measured.cycles).toHaveLength(1);
    const [cycle] = measured.cycles;
    expect(cycle?.nodes.slice().sort()).toEqual(['fct_a', 'fct_b']);
    expect(cycle?.edges.slice().sort()).toEqual([forward, back].sort());
    // The seed keeps distance 0 even though the loop reaches it again at 2.
    expect(measured.nodes.find((node) => node.factId === 'fct_a')?.direction).toBe('seed');
    expect(measured.edges).toHaveLength(2);
    expect(measured.back + measured.forward).toBe(1);
  });
});

describe('the closure has no window', () => {
  it('reports forty nodes over twelve chapters in full (T4)', () => {
    const db = open();
    const total = 40;
    seedFact(db, { id: 'fct_0', chapter: 1, kind: 'term', key: 'term:n0' });
    for (let index = 1; index < total; index += 1) {
      const chapter = 1 + (index % 12);
      seedFact(db, { id: `fct_${String(index)}`, chapter, kind: 'term', key: `term:n${String(index)}` });
      seedEdge(db, {
        id: `dep_${String(index)}`,
        from: `fct_${String(index - 1)}`,
        to: `fct_${String(index)}`,
        chapter,
        kind: 'document',
      });
    }

    const measured = closure(db, ['fct_0']);
    expect(measured.nodes).toHaveLength(total);
    expect(measured.chapters).toHaveLength(12);
    expect(new Set(measured.nodes.map((node) => node.factId)).size).toBe(total);
    expect(measured.nodes.map((node) => node.distance)).toContain(total - 1);
    // A chain of 40 facts runs through many chapters, so the whole-book read is on (§4.6).
    expect(measured.parts.length).toBeGreaterThan(1);
  });

  it('is byte-identical for the same ledger and ignores a superseded edge', () => {
    const db = open();
    seedFact(db, { id: 'fct_hub', chapter: 2, kind: 'document', key: 'document:65-11877-арх' });
    seedFact(db, { id: 'fct_kept', chapter: 3, kind: 'date', key: 'date:kept' });
    seedFact(db, { id: 'fct_gone', chapter: 4, kind: 'date', key: 'date:gone' });
    seedEdge(db, { id: 'dep_kept', from: 'fct_hub', to: 'fct_kept', chapter: 3, kind: 'document' });
    // The retired edge is the only one that ever reached `fct_gone`; its successor is another
    // claim about `fct_kept`. A walk that read `superseded_by` as a note would still report it.
    seedEdge(db, { id: 'dep_successor', from: 'fct_hub', to: 'fct_kept', chapter: 3, kind: 'decision' });
    seedEdge(db, {
      id: 'dep_retired',
      from: 'fct_hub',
      to: 'fct_gone',
      chapter: 4,
      kind: 'cause',
      supersededBy: 'dep_successor',
    });

    const first = JSON.stringify(closure(db, ['fct_hub']));
    const second = JSON.stringify(closure(db, ['fct_hub']));
    expect(first).toBe(second);
    expect(first).not.toContain('fct_gone');
    expect(JSON.parse(first).nodes).toHaveLength(2);
    // The retired edge is not in the induced set either: `superseded_by` still means «not the
    // graph», exactly as it did before v24 gave an edge a second way to be retired.
    expect((JSON.parse(first).edges as Array<{ id: string }>).map((edge) => edge.id)).toEqual([
      'dep_kept',
      'dep_successor',
    ]);
  });

  it('ignores an edge a later extraction run retired, in both directions and in the induced set', () => {
    const db = open();
    seedFact(db, { id: 'fct_seed', chapter: 1, kind: 'document', key: 'document:seed' });
    seedFact(db, { id: 'fct_through', chapter: 2, kind: 'term', key: 'term:through' });
    seedFact(db, { id: 'fct_beyond', chapter: 3, kind: 'decision', key: 'decision:beyond' });
    seedRun(db, { id: 'run_one', chapter: 3 });
    seedEdge(db, { id: 'dep_live', from: 'fct_seed', to: 'fct_through', chapter: 2, kind: 'cause' });
    // The only edge that ever reached `fct_beyond` came from the pass this run replaced. A walk
    // that read only `superseded_by` would still report a consequence nothing supports any more.
    seedEdge(db, {
      id: 'dep_retired',
      from: 'fct_through',
      to: 'fct_beyond',
      chapter: 3,
      kind: 'decision',
      retiredByRun: 'run_one',
    });

    expect(descendants(db, 'fct_seed').map((node) => node.factId)).toEqual(['fct_seed', 'fct_through']);
    // The cause side of the far fact is itself: the retired edge no longer leads anywhere.
    expect(ancestors(db, 'fct_beyond').map((node) => node.factId)).toEqual(['fct_beyond']);
    const measured = closure(db, ['fct_seed']);
    expect(measured.edges.map((edge) => edge.id)).toEqual(['dep_live']);
    // And `mandatoryOf` counts the same support: a touched fact with no live incoming edge is a
    // source, not a consequence whose support vanished.
    const nodes = [...measured.nodes, nodeOf('fct_beyond', 3, { key: 'decision:beyond' })];
    const verdict = mandatoryOf(db, nodes, { origin: 1, touched: ['fct_through'] });
    expect(verdict.mandatory).toEqual([]);
    expect(verdict.optional.map((entry) => entry.reason)).toContain('no support to lose');
  });

  it('breaks a tie between two seeds by the smaller seed id', () => {
    const db = open();
    seedFact(db, { id: 'fct_a', chapter: 1, kind: 'document', key: 'document:a' });
    seedFact(db, { id: 'fct_b', chapter: 2, kind: 'document', key: 'document:b' });
    seedFact(db, { id: 'fct_c', chapter: 3, kind: 'term', key: 'term:c' });
    seedEdge(db, { id: 'dep_ac', from: 'fct_a', to: 'fct_c', chapter: 3, kind: 'document' });
    seedEdge(db, { id: 'dep_bc', from: 'fct_b', to: 'fct_c', chapter: 3, kind: 'document' });

    const measured = closure(db, ['fct_b', 'fct_a']);
    const node = measured.nodes.find((entry) => entry.factId === 'fct_c');
    expect(node?.distance).toBe(1);
    expect(node?.via).toBe('dep_ac');
    expect(measured.seeds).toEqual(['fct_a', 'fct_b']);
    expect(measured.nodes.filter((entry) => entry.direction === 'seed')).toHaveLength(2);
  });

  it('marks a caller-known orphan mandatory even when it never had support', () => {
    const db = open();
    seedFact(db, { id: 'fct_s', chapter: 1, kind: 'document', key: 'document:s' });
    seedFact(db, { id: 'fct_alone', chapter: 4, kind: 'term', key: 'term:alone' });
    const measured = closure(db, ['fct_s']);

    // A fact in the closure's chapter set that has no edge at all: a source, until a caller says
    // its support is gone.
    const nodes = [...measured.nodes, nodeOf('fct_alone', 4, { key: 'term:alone' })];
    const plain = mandatoryOf(db, nodes, { origin: 1, touched: ['fct_s'] });
    expect(plain.mandatory).toEqual([]);
    expect(plain.optional.map((entry) => entry.reason)).toContain('no support to lose');

    const declared = mandatoryOf(db, nodes, { origin: 1, touched: ['fct_s'], orphaned: ['fct_alone'] });
    expect(declared.mandatory).toEqual([
      { factId: 'fct_alone', chapter: 4, key: 'term:alone', kind: 'term', reason: 'orphaned: no live support' },
    ]);
  });

  it('returns an empty closure for no seeds rather than walking the book', () => {
    const db = open();
    seedFact(db, { id: 'fct_a', chapter: 1 });
    expect(closure(db, [])).toEqual({
      seeds: [],
      nodes: [],
      edges: [],
      chapters: [],
      parts: [],
      back: 0,
      forward: 0,
      cycles: [],
    });
  });

  it('refuses an invented fact instead of returning an empty closure', () => {
    const db = open();
    expect(() => closure(db, ['fct_nope'])).toThrow(/unknown fact fct_nope/u);
    expect(() => ancestors(db, 'fct_nope')).toThrow(/unknown fact fct_nope/u);
  });

  it('keeps the closer path when two routes reach one node', () => {
    const db = open();
    seedFact(db, { id: 'fct_seed', chapter: 1 });
    seedFact(db, { id: 'fct_mid', chapter: 2 });
    seedFact(db, { id: 'fct_far', chapter: 3 });
    seedFact(db, { id: 'fct_end', chapter: 4 });
    seedEdge(db, { id: 'dep_sm', from: 'fct_seed', to: 'fct_mid', chapter: 2, kind: 'document' });
    seedEdge(db, { id: 'dep_mf', from: 'fct_mid', to: 'fct_far', chapter: 3, kind: 'document' });
    seedEdge(db, { id: 'dep_fe', from: 'fct_far', to: 'fct_end', chapter: 4, kind: 'document' });
    seedEdge(db, { id: 'dep_se', from: 'fct_seed', to: 'fct_end', chapter: 4, kind: 'document' });

    const node = closure(db, ['fct_seed']).nodes.find((entry) => entry.factId === 'fct_end');
    expect(node?.distance).toBe(1);
    expect(node?.via).toBe('dep_se');
    expect(node?.chapterDistance).toBe(1);
  });

  it('breaks an equal-distance tie by the smaller edge id, whatever the insertion order', () => {
    const db = open();
    seedFact(db, { id: 'fct_seed', chapter: 1 });
    seedFact(db, { id: 'fct_left', chapter: 2 });
    seedFact(db, { id: 'fct_right', chapter: 3 });
    seedFact(db, { id: 'fct_end', chapter: 4 });
    seedEdge(db, { id: 'dep_sl', from: 'fct_seed', to: 'fct_left', chapter: 2, kind: 'document' });
    seedEdge(db, { id: 'dep_sr', from: 'fct_seed', to: 'fct_right', chapter: 3, kind: 'document' });
    // Two edges into the same node at the same distance, written in the reverse of id order: the
    // tree must not depend on which one the walk happened to follow first.
    seedEdge(db, { id: 'dep_z', from: 'fct_left', to: 'fct_end', chapter: 4, kind: 'document' });
    seedEdge(db, { id: 'dep_a', from: 'fct_right', to: 'fct_end', chapter: 4, kind: 'document' });

    const first = closure(db, ['fct_seed']);
    const node = first.nodes.find((entry) => entry.factId === 'fct_end');
    expect(node?.distance).toBe(2);
    expect(node?.via).toBe('dep_a');
    // ch04 → ch03 → ch01: three chapters on the path, two boundaries.
    expect(node?.chapterDistance).toBe(2);
    // And the same bytes on a second run: the tie-break is a rule, not an accident of the walk.
    expect(JSON.stringify(closure(db, ['fct_seed']))).toBe(JSON.stringify(first));
  });

  it('walks 22 converging diamonds in full, without multiplying paths', () => {
    const db = open();
    const made = diamondChain(db, 22);
    expect(made).toEqual({ facts: 67, edges: 88 });

    const started = performance.now();
    const measured = closure(db, ['fct_root']);
    const elapsed = performance.now() - started;

    expect(measured.nodes).toHaveLength(67);
    expect(new Set(measured.nodes.map((node) => node.factId)).size).toBe(67);
    expect(measured.edges).toHaveLength(88);
    // The last join is reachable by 2^22 simple paths: a per-path walk took 35 s here, a
    // node-deduped one takes single-digit milliseconds. Two seconds is load tolerance, not a
    // budget — the 25 ms budget belongs to `graph bench` on the machine that measures the book.
    expect(elapsed).toBeLessThan(2000);
    // Each side of a join reaches the join one edge later than the sides themselves, and the join
    // is the smaller edge id of the two.
    const lastJoin = measured.nodes.find((node) => node.factId === 'fct_c21');
    expect(lastJoin?.distance).toBe(44);
    expect(lastJoin?.via).toBe('dep_ac21');
  });

  it('never walks onto, or counts support from, a fact a later run retired', () => {
    const db = open();
    seedFact(db, { id: 'fct_live', chapter: 1 });
    seedFact(db, { id: 'fct_dead', chapter: 2 });
    seedFact(db, { id: 'fct_after', chapter: 3 });
    // Both edges are live rows; the fact in the middle is the one a later extraction retired.
    seedEdge(db, { id: 'dep_a', from: 'fct_live', to: 'fct_dead', chapter: 2 });
    seedEdge(db, { id: 'dep_b', from: 'fct_dead', to: 'fct_after', chapter: 3 });
    seedRun(db, { id: 'run_two', chapter: 2 });
    db.prepare(`UPDATE facts SET superseded_by_extraction = ? WHERE id = ?`).run('run_two', 'fct_dead');

    const measured = closure(db, ['fct_live']);
    expect(measured.nodes.map((node) => node.factId)).toEqual(['fct_live']);
    expect(measured.edges).toEqual([]);

    // The consequence cannot stand on the retired fact: it has no live support left at all, so a
    // caller that knows it is orphaned is the only thing that may mark it mandatory.
    const nodes = [...measured.nodes, nodeOf('fct_after', 3)];
    const plain = mandatoryOf(db, nodes, { origin: 1, touched: ['fct_dead'] });
    expect(plain.mandatory).toEqual([]);
    expect(plain.optional).toEqual([
      { factId: 'fct_after', chapter: 3, key: 'term:fct_after', kind: 'term', reason: 'no support to lose' },
      { factId: 'fct_live', chapter: 1, key: 'fct_live', kind: 'term', reason: 'origin' },
    ]);
  });

  it('refuses a retired fact as a seed instead of answering with an empty closure', () => {
    const db = open();
    seedFact(db, { id: 'fct_dead', chapter: 2 });
    seedRun(db, { id: 'run_two', chapter: 2 });
    db.prepare(`UPDATE facts SET superseded_by_extraction = ? WHERE id = ?`).run('run_two', 'fct_dead');

    expect(() => closure(db, ['fct_dead'])).toThrow(/retired fact fct_dead/u);
    expect(() => ancestors(db, 'fct_dead')).toThrow(/retired fact fct_dead/u);
  });

  it('splits every node into mandatory or optional, and an unreached orphan into mandatory', () => {
    const db = open();
    seedFact(db, { id: 'fct_seed', chapter: 1 });
    seedFact(db, { id: 'fct_cons', chapter: 5 });
    seedFact(db, { id: 'fct_elsewhere', chapter: 9, key: 'term:elsewhere' });
    seedEdge(db, { id: 'dep_sc', from: 'fct_seed', to: 'fct_cons', chapter: 5 });

    const measured = closure(db, ['fct_seed']);
    const split = mandatoryOf(db, measured.nodes, {
      origin: 1,
      touched: ['fct_seed'],
      orphaned: ['fct_elsewhere'],
    });
    // The counts reconcile: the origin node is listed, not dropped, and the orphan the closure
    // never reached is still in the plan.
    expect(split.mandatory).toEqual([
      { factId: 'fct_cons', chapter: 5, key: 'fct_cons', kind: 'term', reason: 'sole support: dep_sc' },
      { factId: 'fct_elsewhere', chapter: 9, key: 'term:elsewhere', kind: 'term', reason: 'orphaned: no live support' },
    ]);
    expect(split.optional).toEqual([
      { factId: 'fct_seed', chapter: 1, key: 'fct_seed', kind: 'term', reason: 'origin' },
    ]);
    expect(split.mandatory.length + split.optional.length).toBe(measured.nodes.length + 1);

    // An `orphaned` id no ledger row answers to is a caller's bug, not a silent omission.
    expect(() => mandatoryOf(db, measured.nodes, { origin: 1, touched: [], orphaned: ['fct_nope'] })).toThrow(
      /unknown fact fct_nope/u,
    );
  });
});
