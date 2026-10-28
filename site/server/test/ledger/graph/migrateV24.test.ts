import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { migrateV24 } from '../../../src/db/migrateV24.ts';
import { LEDGER_REQUIRED_TABLES, SCHEMA_VERSION } from '../../../src/db/schema.ts';
import { assertDependency } from '../../../src/ledger/graph/edges.ts';
import { seedChange } from '../helpers.ts';
import { claimPlan, parkPlan, storePlan, type RipplePlan } from '../../../src/ledger/graph/plan.ts';

/**
 * The v24 shape a fresh install and an upgraded one must share (BOOK-173).
 *
 * The failure this file exists for is the review's blocker: `main` already had a v23 (the author
 * marker, `migrateV23.ts`), so a ledger step that also claimed 23 never ran on a server already at
 * 23 — it booted without `edges` and `change_plans` and every ripple was `local`. The two upgrade
 * paths are proven here: **v22 → v24** (an engine that never saw either step) and **v23 → v24**
 * (a server that has the author marker and must still get the graph).
 */
const GRAPH_OBJECTS = [
  'edges',
  'edges_pair',
  'edges_from',
  'edges_to',
  'change_plans',
  'change_plans_change',
  'fact_dependency',
  'facts_retire_edges',
] as const;

const AT = '2026-10-28T12:00:00Z';

function objectsOf(db: Db): Array<{ type: string; name: string; sql: string }> {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name IN (${GRAPH_OBJECTS.map(() => '?').join(', ')})
        ORDER BY type, name`,
    )
    .all(...GRAPH_OBJECTS) as Array<{ type: string; name: string; sql: string }>;
}

function seedFact(db: Db, id: string, chapter: number): void {
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
     VALUES (?, ?, 'state', 'заявление', 'заявление', ?, ?)`,
  ).run(id, chapter, chapter, AT);
}

/** Turn a v24 database into the v22 one an upgrade from the span ledger actually finds. */
function shapeAsV22(db: Db): void {
  db.exec('DROP TRIGGER IF EXISTS facts_retire_edges');
  db.exec('DROP VIEW IF EXISTS fact_dependency');
  db.exec('DROP TABLE IF EXISTS change_plans');
  db.exec('DROP TABLE IF EXISTS edges');
  db.exec('DELETE FROM facts');
  db.pragma('user_version = 22');
}

/** …and into the v23 one `main` shipped (the author marker), which must still get the graph. */
function shapeAsV23(db: Db): void {
  db.exec('DROP TRIGGER IF EXISTS facts_retire_edges');
  db.exec('DROP VIEW IF EXISTS fact_dependency');
  db.exec('DROP TABLE IF EXISTS change_plans');
  db.exec('DROP TABLE IF EXISTS edges');
  db.exec('DELETE FROM facts');
  db.pragma('user_version = 23');
}

let db: Db;

afterEach(() => {
  db.close();
});

describe('migration v24 — the ripple graph on a fresh install', () => {
  it('creates edges, change_plans and the owner-named view, and reaches version 24', () => {
    db = openDatabase(':memory:');
    expect(SCHEMA_VERSION).toBe(24);
    expect(migrate(db).to).toBe(SCHEMA_VERSION);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);

    const names = objectsOf(db);
    expect(names.map((row) => `${row.type}:${row.name}`)).toEqual([
      'index:change_plans_change',
      'index:edges_from',
      'index:edges_pair',
      'index:edges_to',
      'table:change_plans',
      'table:edges',
      'trigger:facts_retire_edges',
      'view:fact_dependency',
    ]);
    for (const table of ['edges', 'change_plans']) {
      expect(LEDGER_REQUIRED_TABLES).toContain(table);
    }

    // The owner's name is queryable and answers one row per edge.
    seedFact(db, 'f:one', 3);
    seedFact(db, 'f:two', 4);
    assertDependency(db, {
      from: 'f:one',
      to: 'f:two',
      chapter: 4,
      kind: 'follows',
      onComponent: 'status',
      evidence: '«заявление»: ch03 → ch04',
      at: AT,
      id: 'edg_one',
    });
    expect(db.prepare('SELECT * FROM fact_dependency').all()).toEqual([
      {
        from_fact: 'f:one',
        to_fact: 'f:two',
        chapter: 4,
        kind: 'follows',
        on_component: 'status',
        evidence: '«заявление»: ch03 → ch04',
        origin: 'backfill',
      },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('migration v24 — the same shape on an upgraded install', () => {
  it('builds the same objects from a v22 database, and stays idempotent', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);

    shapeAsV22(db);
    expect(objectsOf(db)).toEqual([]);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(22);

    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // A second boot has nothing to do, and the step itself is idempotent for a build that re-runs it.
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(() => migrateV24(db)).not.toThrow();
    expect(objectsOf(db)).toEqual(fresh);
  });

  it('runs on a server already at v23 (the author marker), which is the blocker this file proves', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);

    shapeAsV23(db);
    expect(objectsOf(db)).toEqual([]);
    // The author marker's own step is already applied: 23 is the version a real server holds.
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(23);
    expect((db.pragma('table_info(identities)') as Array<{ name: string }>).map((row) => row.name)).toContain(
      'is_author',
    );

    expect(migrate(db)).toEqual({ from: 23, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    // The ledger the app cannot run without is now there, on a book that was already at 23.
    expect(() => assertDependency(db, { from: 'f:ghost', to: 'f:ghost2', chapter: 1, kind: 'follows' })).toThrow(
      /FOREIGN KEY/u,
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('the edge table is one statement, and it is a fact about two facts', () => {
  it('is idempotent on (from, to, kind, chapter) and keeps the first writer origin', () => {
    db = openDatabase(':memory:');
    migrate(db);
    seedFact(db, 'f:a', 2);
    seedFact(db, 'f:b', 9);
    const first = assertDependency(db, {
      from: 'f:a',
      to: 'f:b',
      chapter: 9,
      kind: 'fulfils',
      onComponent: 'value',
      evidence: 'first reading',
      origin: 'backfill',
      at: AT,
      id: 'edg_a',
    });
    const second = assertDependency(db, {
      from: 'f:a',
      to: 'f:b',
      chapter: 9,
      kind: 'fulfils',
      onComponent: 'identity',
      evidence: 'second reading',
      origin: 'writer',
      at: AT,
      id: 'edg_b',
    });
    expect(second).toEqual({ ...first, on_component: 'identity', evidence: 'second reading' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 });
    // The same pair in another chapter is a different telling of the relation, not a duplicate.
    assertDependency(db, { from: 'f:a', to: 'f:b', chapter: 12, kind: 'fulfils', at: AT });
    expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 2 });
  });

  it('refuses an unknown endpoint, a self-edge and a chapter outside the book', () => {
    db = openDatabase(':memory:');
    migrate(db);
    seedFact(db, 'f:a', 2);
    expect(() => assertDependency(db, { from: 'f:a', to: 'f:ghost', chapter: 3, kind: 'follows', at: AT })).toThrow(
      /FOREIGN KEY/u,
    );
    expect(() => assertDependency(db, { from: 'f:a', to: 'f:a', chapter: 3, kind: 'follows', at: AT })).toThrow(
      /two different facts/u,
    );
    expect(() => assertDependency(db, { from: 'f:a', to: 'f:b', chapter: 0, kind: 'follows', at: AT })).toThrow(
      /chapter out of range/u,
    );
    // The backfill and the writer are the only two origins an automatic row may carry.
    seedFact(db, 'f:b', 3);
    expect(() =>
      assertDependency(db, { from: 'f:a', to: 'f:b', chapter: 3, kind: 'follows', origin: 'writer', at: AT }),
    ).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 });
  });

  it('retires the rows that name a fact the moment it is invalidated', () => {
    db = openDatabase(':memory:');
    migrate(db);
    seedFact(db, 'f:a', 2);
    seedFact(db, 'f:b', 3);
    assertDependency(db, { from: 'f:a', to: 'f:b', chapter: 3, kind: 'follows', at: AT, id: 'edg_x' });
    db.prepare('UPDATE facts SET invalidated_at = ?, invalidated_by_change = NULL WHERE id = ?').run(AT, 'f:a');
    // A walk over a retired premise is a plan that lies: the graph loses the rows, not the fact.
    expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 2 });
  });
});

describe('change_plans is one row per change', () => {
  function plan(changeId: string, outcome: RipplePlan['outcome'] = 'ripple'): RipplePlan {
    return {
      changeId,
      chapter: 5,
      outcome,
      proven: true,
      seeds: [],
      nodes: [],
      edges: [],
      edgeDetail: [],
      patches: [],
      closureSize: { nodes: 0, edges: 0, chapters: 1, parts: 1 },
      chaptersTouched: [5],
      bounds: { chars: 4000, usd: 0.6, iterations: 4, nodes: 1500, edges: 3000 },
      unresolved: [],
      truncated: false,
    };
  }

  it('keys on change_id: a re-plan updates the one row and keeps the journal', () => {
    db = openDatabase(':memory:');
    migrate(db);
    seedChange(db, { id: 'chg_one', chapter: 5, at: AT });
    const first = storePlan(db, plan('chg_one'), AT);
    db.prepare(`UPDATE change_plans SET iterations = '[{"chapter":12,"landed":true}]' WHERE id = ?`).run(first);
    const second = storePlan(db, plan('chg_one', 'wide'), AT);
    expect(second).toBe(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_plans').get()).toEqual({ n: 1 });
    const row = db.prepare('SELECT outcome, iterations, bounds FROM change_plans').get() as {
      outcome: string;
      iterations: string;
      bounds: string;
    };
    // The newest reading of the closure, the journal and the frozen caps of the first estimate.
    expect(row.outcome).toBe('wide');
    expect(row.iterations).toContain('"chapter":12');
    expect(JSON.parse(row.bounds).usd).toBe(0.6);
  });

  it('parks and releases the claim on the same row', () => {
    db = openDatabase(':memory:');
    migrate(db);
    seedChange(db, { id: 'chg_two', chapter: 5, at: AT });
    const planRowId = storePlan(db, plan('chg_two'), AT);
    expect(claimPlan(db, planRowId, 'proc-a', Date.parse(AT))).toBe(true);
    expect(claimPlan(db, planRowId, 'proc-b', Date.parse(AT))).toBe(false);
    // A claim older than the TTL is a process that died: the next one may take it.
    expect(claimPlan(db, planRowId, 'proc-b', Date.parse(AT) + 31 * 60 * 1000)).toBe(true);
    parkPlan(db, planRowId, 'волна остановлена', AT);
    const row = db.prepare('SELECT park_reason, parked_at FROM change_plans WHERE id = ?').get(planRowId) as {
      park_reason: string | null;
      parked_at: string | null;
    };
    expect(row.park_reason).toBe('волна остановлена');
    expect(row.parked_at).toBe(AT);
  });
});
