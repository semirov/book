import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { migrateV25 } from '../../../src/db/migrateV25.ts';
import { migrateV33 } from '../../../src/db/migrateV33.ts';
import { LEDGER_REQUIRED_TABLES, SCHEMA_VERSION } from '../../../src/db/schema.ts';
import { seedChange, seedChapter } from '../helpers.ts';
import { claimPlan, parkPlan, storePlan, type RipplePlan } from '../../../src/ledger/graph/plan.ts';

/**
 * The v33 shape a fresh install and every upgraded one must share (BOOK-173, BOOK-DOC-80).
 *
 * The failure this file exists for is the review's blocker, three times over. `main` already had a
 * v23 (the author marker), so a plan step that claimed 23 never ran on a server already at 23 —
 * it booted without `change_plans` and the lane could not plan or drain. Then `main` took **25**
 * (the sentence), 26 (push), 27 (BOOK-174), 28 (BOOK-187, the db-home), **29** (BOOK-185 stage
 * 3, the graph), 30 (BOOK-206's triage ledger) and 31 (BOOK-117's `steps.reopened_at`), and
 * `user_version` only moves forward: a step numbered below an install's version is skipped
 * silently. Then `main` took **32** (BOOK-218's `comments.number`). The plan is **v33**, after all
 * of them, and the paths are proven here: **fresh → 33**, **v22 → 33**, **v23 → 33**,
 * **v25 → 33**, **v28 → 33**, **v29 → 33**, **v30 → 33**, **v31 → 33** and **v32 → 33**.
 *
 * The graph itself is main's `fact_dependency`, created by `migrateV29.ts`; this file asserts the
 * plan does not duplicate it.
 */
const PLAN_OBJECTS = ['change_plans', 'change_plans_change'] as const;

const AT = '2026-10-28T12:00:00Z';

function objectsOf(db: Db): Array<{ type: string; name: string; sql: string }> {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name IN (${PLAN_OBJECTS.map(() => '?').join(', ')})
        ORDER BY type, name`,
    )
    .all(...PLAN_OBJECTS) as Array<{ type: string; name: string; sql: string }>;
}

/**
 * Today's database, shaped as the install an upgrade from `version` actually finds: the plan is
 * not there yet, and everything `main` added on the way is left as it stands — that is the point
 * of the comparisons below.
 */
function shapeWithoutPlan(db: Db, version: number): void {
  db.exec('DROP TABLE IF EXISTS change_plans');
  db.pragma(`user_version = ${version}`);
}

const PLAN_COLUMNS = ['mode', 'price_usd', 'tier1_verdict', 'tier1_usd', 'gates_mode', 'sample_requested', 'sampled_at', 'sample_verdict'] as const;

function planColumns(db: Db): string[] {
  const names = (db.pragma('table_info(change_plans)') as Array<{ name: string }>).map((row) => row.name);
  return [...PLAN_COLUMNS].filter((column) => names.includes(column));
}

let db: Db;

afterEach(() => {
  db.close();
});

describe('migration v33 — the frozen plan on a fresh install', () => {
  it('creates change_plans, reaches the head version, and does not duplicate main’s graph', () => {
    db = openDatabase(':memory:');
    expect(SCHEMA_VERSION).toBe(35);
    expect(migrate(db).to).toBe(SCHEMA_VERSION);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);

    const names = objectsOf(db);
    expect(names.map((row) => `${row.type}:${row.name}`)).toEqual([
      'index:change_plans_change',
      'table:change_plans',
    ]);
    expect(LEDGER_REQUIRED_TABLES).toContain('change_plans');
    // BOOK-185 owns the graph: one table, its name, no view and no second edge table behind it.
    expect(LEDGER_REQUIRED_TABLES).toContain('fact_dependency');
    expect(LEDGER_REQUIRED_TABLES).not.toContain('edges');
    const graph = db
      .prepare(`SELECT type, name FROM sqlite_master WHERE name = 'edges' OR name = 'fact_dependency' ORDER BY type, name`)
      .all();
    expect(graph).toEqual([{ type: 'table', name: 'fact_dependency' }]);
    // BOOK-173 §4: the plan of a change carries the mode it ran and the money it was priced at.
    expect(planColumns(db)).toEqual([...PLAN_COLUMNS]);
    // BOOK-206's v30 step is not shadowed by the renumber: its own columns are all present.
    const attemptColumns = (db.pragma('table_info(comment_attempts)') as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(attemptColumns).toEqual(
      expect.arrayContaining(['claim_by', 'claim_until', 'tries', 'next_at', 'verdict', 'verdict_at']),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('migration v33 — the same shape on an upgraded install', () => {
  it('builds the same objects from a v22 database, and stays idempotent', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);

    shapeWithoutPlan(db, 22);
    expect(objectsOf(db)).toEqual([]);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(22);

    expect(migrate(db)).toEqual({ from: 22, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // A second boot has nothing to do, and the step itself is idempotent for a build that re-runs it.
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(() => migrateV33(db)).not.toThrow();
    expect(objectsOf(db)).toEqual(fresh);
  });

  it('runs on a server already at v23 (the author marker), which is the blocker this file proves', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);

    shapeWithoutPlan(db, 23);
    expect(objectsOf(db)).toEqual([]);
    // The author marker's own step is already applied: 23 is the version a real server holds.
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(23);
    expect((db.pragma('table_info(identities)') as Array<{ name: string }>).map((row) => row.name)).toContain(
      'is_author',
    );

    expect(migrate(db)).toEqual({ from: 23, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(planColumns(db)).toEqual([...PLAN_COLUMNS]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('runs on a server already at v25 (the sentence) and touches no sentence row at all', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);
    const chapter = seedChapter(db, {
      chapter: 12,
      texts: ['Он перечитал записку дважды. Ничего не изменилось.', 'Почерк был чужой.'],
      title: 'Записка',
      at: AT,
    });
    expect(chapter).toHaveLength(2);
    // The sentence step as `main` ran it: every live block segmented once, no touch invented.
    migrateV25(db);
    const sentencesBefore = db.prepare('SELECT * FROM sentences ORDER BY id').all();
    expect(sentencesBefore.length).toBeGreaterThan(0);

    shapeWithoutPlan(db, 25);
    expect(objectsOf(db)).toEqual([]);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(25);
    // The sentence layer is the one thing a v25 install already has: it must survive untouched.
    expect(db.prepare('SELECT * FROM sentences ORDER BY id').all()).toEqual(sentencesBefore);

    expect(migrate(db)).toEqual({ from: 25, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    // Row for row: no id re-derived, no hash moved, no span re-cut, no touch invented by v33.
    expect(db.prepare('SELECT * FROM sentences ORDER BY id').all()).toEqual(sentencesBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sentence_touches').get()).toEqual({ n: 0 });
    expect(planColumns(db)).toEqual([...PLAN_COLUMNS]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('runs on the db-home server already at v28 and keeps every row of its state', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);
    // A v28 volume carries the lane state and a redacted transcript as rows (BOOK-187).
    db.prepare(
      `INSERT INTO writer_state (id, day, passes, last_pass_at, updated_at)
       VALUES (1, '2026-10-28', 2, ?, ?)`,
    ).run(AT, AT);
    const stateBefore = db.prepare('SELECT * FROM writer_state ORDER BY id').all();

    shapeWithoutPlan(db, 28);
    expect(objectsOf(db)).toEqual([]);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(28);

    expect(migrate(db)).toEqual({ from: 28, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    // The step is additive: the state row is byte for byte what the db-home wrote.
    expect(db.prepare('SELECT * FROM writer_state ORDER BY id').all()).toEqual(stateBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('runs on a server already at v29 (main’s graph) and leaves the graph untouched', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES ('f:one', 3, 'state', 'заявление', 'заявление', 3, ?)`,
    ).run(AT);
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES ('f:two', 4, 'state', 'следствие', 'следствие', 4, ?)`,
    ).run(AT);
    db.prepare(
      `INSERT INTO fact_dependency (id, "from", "to", chapter, kind, stance, statement, origin, step_id, rev, at)
       VALUES ('dep_one', 'f:one', 'f:two', 4, 'cause', 'plain', 'служебная зависимость', 'registered', 'stp', 1, ?)`,
    ).run(AT);
    const graphBefore = db.prepare('SELECT * FROM fact_dependency ORDER BY id').all();

    shapeWithoutPlan(db, 29);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(29);

    expect(migrate(db)).toEqual({ from: 29, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    // v33 is the plan only: BOOK-185's rows are exactly what the v29 install left.
    expect(db.prepare('SELECT * FROM fact_dependency ORDER BY id').all()).toEqual(graphBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('runs on a server already at v30 (the triage ledger) and leaves its rows as they stand', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);
    // A v30 volume carries a filing out for its own verdict (BOOK-206): claim, tries, verdict.
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_triage', 'yandex-triage', 'Аня', ?, ?)`,
    ).run(AT, AT);
    db.prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES ('cmt_triage', 'idt_triage', 8, 'Аня', 'текст', 'sha', 'a', 'new', ?)`,
    ).run(AT);
    db.prepare(
      `INSERT INTO comment_attempts
         (comment_id, n, at, day, body_sha, anchor_sha, outcome, claim_by, claim_until, tries, next_at, verdict, verdict_at)
       VALUES ('cmt_triage', 1, ?, '2026-10-28', 'sha', 'anchor', 'submitted',
               'sess-1', ?, 2, ?, '{"verdict":"FITS"}', ?)`,
    ).run(AT, '2026-10-28T12:10:00Z', '2026-10-28T12:05:00Z', AT);
    const attemptsBefore = db.prepare('SELECT * FROM comment_attempts ORDER BY id').all();
    expect(attemptsBefore).toHaveLength(1);

    shapeWithoutPlan(db, 30);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(30);

    expect(migrate(db)).toEqual({ from: 30, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    // The triage ledger is not the plan's business: the row, its claim and its verdict are untouched.
    expect(db.prepare('SELECT * FROM comment_attempts ORDER BY id').all()).toEqual(attemptsBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('runs on a server already at v31 (BOOK-117’s reopen) and keeps the second window', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const fresh = objectsOf(db);
    db.prepare(
      `INSERT INTO steps (step_id, cascade_id, seq, wave, pass, boundary, at, reopened_at, note)
       VALUES ('stp_reopened', NULL, 0, 0, 'draft', 'front', ?, ?, 'second window')`,
    ).run(AT, '2026-10-28T18:00:00Z');
    const stepsBefore = db.prepare('SELECT step_id, at, reopened_at FROM steps ORDER BY step_id').all();

    shapeWithoutPlan(db, 31);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(31);
    // v31 is main's step and stays applied: the column is there before v33 runs.
    expect(planColumns(db)).toEqual([]);

    expect(migrate(db)).toEqual({ from: 31, to: SCHEMA_VERSION });
    expect(objectsOf(db)).toEqual(fresh);
    // The reopen is where the wall measures the second window from: v33 must not reset it.
    expect(db.prepare('SELECT step_id, at, reopened_at FROM steps ORDER BY step_id').all()).toEqual(stepsBefore);
    expect(planColumns(db)).toEqual([...PLAN_COLUMNS]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('only ever moves user_version forward, and refuses a database from a newer build', () => {
    db = openDatabase(':memory:');
    migrate(db);
    // Each upgrade path lands on the head version, and a second boot changes nothing.
    for (const from of [22, 23, 25, 28, 29, 30, 31, 32]) {
      shapeWithoutPlan(db, from);
      expect(migrate(db)).toEqual({ from, to: SCHEMA_VERSION });
    }
    // A v35 volume is not served by a v34 build: the boot refuses, no DDL.
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/understands/u);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION + 1);
  });

  it('widens a change_plans table an earlier build created, keeping every plan row', () => {
    db = openDatabase(':memory:');
    migrate(db);
    seedChange(db, { id: 'chg_plan', chapter: 12, at: AT });
    db.exec('DROP TABLE change_plans');
    // The pre-v33 shape: the same table without `mode` and `price_usd`.
    db.exec(`
      CREATE TABLE change_plans (
        id           TEXT PRIMARY KEY,
        change_id    TEXT NOT NULL REFERENCES changes(id),
        chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
        outcome      TEXT NOT NULL CHECK (outcome IN ('local','ripple','wide')),
        closure      TEXT NOT NULL,
        patches      TEXT NOT NULL,
        bounds       TEXT NOT NULL,
        iterations   TEXT NOT NULL DEFAULT '[]',
        parked_at    TEXT,
        park_reason  TEXT,
        claimed_at   TEXT,
        claimed_by   TEXT,
        created_at   TEXT NOT NULL
      )`);
    db.prepare(
      `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, created_at)
       VALUES ('pln_old', 'chg_plan', 12, 'local', '{}', '[]', '{}', ?)`,
    ).run(AT);
    db.exec('CREATE UNIQUE INDEX change_plans_change ON change_plans(change_id)');
    expect(planColumns(db)).toEqual([]);
    db.pragma('user_version = 25');

    expect(migrate(db)).toEqual({ from: 25, to: SCHEMA_VERSION });
    // The row is history — the plan a change was priced with — and it keeps its id and its closure.
    expect(
      db
        .prepare(
          'SELECT id, change_id, outcome, mode, price_usd, tier1_verdict, gates_mode, sample_requested FROM change_plans',
        )
        .all(),
    ).toEqual([
      {
        id: 'pln_old',
        change_id: 'chg_plan',
        outcome: 'local',
        mode: null,
        price_usd: null,
        tier1_verdict: null,
        gates_mode: null,
        // BOOK-DOC-80: a plan written before the verification record was never sampled.
        sample_requested: 0,
      },
    ]);
    expect(planColumns(db)).toEqual([...PLAN_COLUMNS]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
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
