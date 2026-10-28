import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { edgesOf, liveFactsAsOf, walk, WALK_NODE_VALVE } from '../../../src/ledger/graph/edges.ts';
import { AT } from '../helpers.ts';
import { graphFixture, type GraphFixture } from './fixtures.ts';

let db: Db;
let fixture: GraphFixture;

function open(): void {
  db = openDatabase(':memory:');
  migrate(db);
  fixture = graphFixture(db);
}

function fact(id: string, chapter: number): string {
  return fixture.fact({ id, chapter, statement: `claim ${id}` });
}

function chain(ids: ReadonlyArray<[string, number]>): void {
  for (const [id, chapter] of ids) fact(id, chapter);
  ids.forEach(([id], index) => {
    const next = ids[index + 1];
    if (next === undefined) return;
    fixture.edge({ from: id, to: next[0], chapter: next[1], kind: 'follows', onComponent: 'value', at: AT });
  });
}

afterEach(() => {
  db.close();
});

describe('walk — the closure over fact_dependency, no chapter window', () => {
  it('reaches ch20 from ch02 in both directions', () => {
    open();
    // A path that crosses the whole book: ch02 → ch05 → ch11 → ch20, plus a premise behind the seed.
    chain([
      ['f:root', 1],
      ['f:ch02', 2],
      ['f:ch05', 5],
      ['f:ch11', 11],
      ['f:ch20', 20],
    ]);
    const result = walk(db, ['f:ch05'], { direction: 'both' });
    expect(result.truncated).toBe(false);
    expect(result.nodes.map((node) => `${node.factId}@${String(node.chapter)}`)).toEqual([
      'f:ch02@2',
      'f:ch05@5',
      'f:ch11@11',
      'f:ch20@20',
      'f:root@1',
    ]);
    const ch20 = result.nodes.find((node) => node.factId === 'f:ch20');
    expect(ch20).toMatchObject({ hops: 2, direction: 'forward' });
    expect(ch20?.via.map((hop) => hop.to)).toEqual(['f:ch11', 'f:ch20']);
    const root = result.nodes.find((node) => node.factId === 'f:root');
    expect(root).toMatchObject({ hops: 2, direction: 'backward' });
    expect(result.edges).toHaveLength(4);
  });

  it('honours a direction and a depth limit without truncating discovery', () => {
    open();
    chain([
      ['f:a', 2],
      ['f:b', 3],
      ['f:c', 4],
    ]);
    expect(walk(db, ['f:a'], { direction: 'forward' }).nodes.map((node) => node.factId)).toEqual(['f:a', 'f:b', 'f:c']);
    expect(walk(db, ['f:c'], { direction: 'forward' }).nodes.map((node) => node.factId)).toEqual(['f:c']);
    expect(walk(db, ['f:b'], { direction: 'backward' }).nodes.map((node) => node.factId)).toEqual(['f:a', 'f:b']);
    const shallow = walk(db, ['f:a'], { direction: 'forward', depthLimit: 1 });
    expect(shallow.nodes.map((node) => node.factId)).toEqual(['f:a', 'f:b']);
    // A depth limit is a sanity bound, not a valve: it is not reported as truncation.
    expect(shallow.truncated).toBe(false);
  });

  it('trips the node valve and says so, instead of pretending the graph ended', () => {
    open();
    chain([
      ['f:a', 2],
      ['f:b', 3],
      ['f:c', 4],
      ['f:d', 5],
    ]);
    const result = walk(db, ['f:a'], { nodeValve: 3 });
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.map((node) => node.factId)).toEqual(['f:a', 'f:b', 'f:c']);
    expect(result.truncated).toBe(true);
    expect(WALK_NODE_VALVE).toBe(1_500);
  });

  it('trips the valve on the seeds themselves when a filing names more than the valve allows', () => {
    open();
    fact('f:a', 2);
    fact('f:b', 3);
    const result = walk(db, ['f:a', 'f:b'], { nodeValve: 1 });
    expect(result.nodes.map((node) => node.factId)).toEqual(['f:a']);
    expect(result.truncated).toBe(true);
  });

  it('is deterministic: the same rows print the same walk', () => {
    open();
    chain([
      ['f:a', 2],
      ['f:c', 4],
      ['f:b', 3],
    ]);
    fixture.edge({ from: 'f:a', to: 'f:b', chapter: 3, kind: 'references', onComponent: 'identity', at: AT });
    const first = walk(db, ['f:a']);
    const second = walk(db, ['f:a']);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.nodes.map((node) => node.factId)).toEqual(['f:a', 'f:b', 'f:c']);
    // The edges reported are the ones that discovered a node: f:c → f:b leads back to a fact the
    // walk already has, so it is not part of the closure's own telling.
    expect(first.edges.map((edge) => `${edge.from_fact}>${edge.to_fact}:${edge.kind}`)).toEqual([
      'f:a>f:b:references',
      'f:a>f:c:follows',
    ]);
  });

  it('ignores a seed that is not a fact and answers an empty walk', () => {
    open();
    fact('f:a', 2);
    const result = walk(db, ['f:ghost', 'f:a']);
    expect(result.nodes.map((node) => node.factId)).toEqual(['f:a']);
    expect(walk(db, []).nodes).toEqual([]);
  });
});

describe('the graph reads', () => {
  it('edgesOf answers both endpoints, and liveFactsAsOf is the chapter window of a fact', () => {
    open();
    fact('f:a', 2);
    fact('f:b', 9);
    fixture.edge({ from: 'f:a', to: 'f:b', chapter: 9, kind: 'follows', at: AT });
    expect(edgesOf(db, 'f:a').map((edge) => [edge.from_fact, edge.to_fact])).toEqual([['f:a', 'f:b']]);
    expect(edgesOf(db, 'f:b')).toHaveLength(1);
    expect(edgesOf(db, 'f:ghost')).toEqual([]);

    expect([...liveFactsAsOf(db, 5).keys()]).toEqual(['f:a']);
    expect([...liveFactsAsOf(db, 9).keys()]).toEqual(['f:a', 'f:b']);
    // A change filed at chapter 6 makes the fact false from chapter 6 on — ch05 still believes it.
    db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                            status, enqueued_at)
       VALUES ('chg_x', 'operator', 6, 'намерение', 1, 'sha', '[]', 'phrase', 'done', ?)`,
    ).run(AT);
    db.prepare(`UPDATE facts SET invalidated_at = ?, invalidated_by_change = 'chg_x' WHERE id = 'f:a'`).run(AT);
    expect([...liveFactsAsOf(db, 5).keys()]).toEqual(['f:a']);
    expect([...liveFactsAsOf(db, 9).keys()]).toEqual(['f:b']);
  });
});
