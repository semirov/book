/**
 * Migration v29 (BOOK-185 stage 3, BOOK-DOC-77) — the run ledger, the widened `facts` with its
 * identity and its provenance, the edge table and `threads.extracted_by`, appended after main's
 * v28 (the book's own state) on a volume whose text is already rows (ADR-043, BOOK-DOC-76).
 *
 * The property that matters is not «the table was created» but «a v28 install upgraded is the
 * install a fresh one is»: `facts` cannot widen its `kind` CHECK in place, so v29 rebuilds it, and
 * a rebuild subtly different from `SCHEMA_SQL` is a bug nobody sees until a query behaves
 * differently on the volume than in a test. So the fresh shape is captured first and compared with
 * the migrated one column for column — including ADR-044's `sentence_id`, which the rebuild must
 * carry — and the step's failure modes (inventing a value, dropping a row, losing a guard) are
 * asserted separately. The run record's own rules follow: the tuple is an index and not a key, the
 * two vocabularies, the foreign keys, the one-live-fact-per-key rule, and the reset over it.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { EXTRACTION_RUNS_TABLE_SQL, FACT_KINDS } from '../../src/db/ledgerTables.ts';
import { migrate } from '../../src/db/migrate.ts';
import { factsShapeIsCurrent, migrateV29, rebuildFacts } from '../../src/db/migrateV29.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { resetBook } from '../../src/reset/book.ts';
import { createFixture } from '../helpers.ts';
import { bookFiles, seedBook } from '../resetSeed.ts';

const AT = '2026-10-29T09:00:00Z';

type ColumnRow = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
type ForeignKeyRow = { table: string; from: string; to: string; on_update: string; on_delete: string };

function info(db: Db, table: string): ColumnRow[] {
  return db.pragma(`table_info(${table})`) as ColumnRow[];
}

function names(db: Db, table: string): string[] {
  return info(db, table).map((column) => column.name);
}

function foreignKeys(db: Db, table: string): ForeignKeyRow[] {
  return db.pragma(`foreign_key_list(${table})`) as ForeignKeyRow[];
}

function objectSql(db: Db, type: string, name: string): string {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

/** The indexes the schema declares — the implicit `sqlite_autoindex_*` of a TEXT PRIMARY KEY is not one. */
function indexNames(db: Db, table: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
           AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
      )
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * The `facts` table a real v28 install holds, copied literally: five kind words, ADR-044's
 * `sentence_id`, and none of BOOK-185's columns. It is the shape the rebuild has to find, and it
 * must not be imported from the module under test — a fixture that changed with the code would
 * prove nothing.
 */
const V28_FACTS_COLUMNS = [
  'id',
  'chapter',
  'kind',
  'statement',
  'term',
  'sentence_id',
  'valid_from_chapter',
  'invalidated_at',
  'invalidated_by_change',
  'created_at',
];

const V28_FACTS_SQL = `CREATE TABLE facts (
  id                    TEXT PRIMARY KEY,
  chapter               INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind                  TEXT NOT NULL CHECK (kind IN ('document','decision','testimony','erasure','state')),
  statement             TEXT NOT NULL,
  term                  TEXT,
  sentence_id           TEXT,
  valid_from_chapter    INTEGER NOT NULL CHECK (valid_from_chapter BETWEEN 1 AND 67),
  invalidated_at        TEXT,
  invalidated_by_change TEXT REFERENCES changes(id),
  created_at            TEXT NOT NULL
)`;

const V28_FACTS_GUARDS_SQL = `
CREATE INDEX facts_asof ON facts(valid_from_chapter, invalidated_by_change);
CREATE INDEX facts_term ON facts(term);
CREATE TRIGGER facts_no_delete BEFORE DELETE ON facts
  BEGIN SELECT RAISE(ABORT, 'facts are never deleted (BOOK-DOC-69)'); END;
`;

const V28_THREAD_COLUMNS = ['id', 'label', 'direction', 'opened_at_chapter', 'closed_at_chapter', 'state'];

const V28_THREADS_SQL = `CREATE TABLE threads (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('forward','backward')),
  opened_at_chapter INTEGER NOT NULL CHECK (opened_at_chapter BETWEEN 1 AND 67),
  closed_at_chapter INTEGER CHECK (closed_at_chapter BETWEEN 1 AND 67),
  state             TEXT NOT NULL CHECK (state IN ('opened','advanced','complicated','closed'))
)`;

/** Replace one table with its v28 declaration, keeping the rows both shapes share. */
function reshape(
  db: Db,
  table: string,
  ddl: string,
  columns: readonly string[],
  guards: string,
  triggers: readonly string[],
  indexes: readonly string[],
): void {
  const present = new Set(names(db, table));
  for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index}`);
  // `legacy_alter_table` is what keeps a rename from rewriting every child's REFERENCES.
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_v28_hold`);
  db.exec(ddl);
  const shared = columns.filter((column) => present.has(column));
  db.exec(`INSERT INTO ${table} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM ${table}_v28_hold`);
  db.exec(`DROP TABLE ${table}_v28_hold`);
  db.exec(guards);
}

/** Turn a v29 database back into the v28 one an upgrade actually finds. */
function shapeAsV28(db: Db): void {
  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true }) ?? 0);
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    // Nothing may reference the run ledger once it goes.
    db.exec('DROP TABLE IF EXISTS fact_dependency');
    db.exec('DROP TABLE IF EXISTS extraction_runs');
    reshape(db, 'facts', V28_FACTS_SQL, V28_FACTS_COLUMNS, V28_FACTS_GUARDS_SQL, ['facts_no_delete'], [
      'facts_asof',
      'facts_term',
      'facts_key_live',
    ]);
    reshape(db, 'threads', V28_THREADS_SQL, V28_THREAD_COLUMNS, '', [], []);
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
  }
  db.pragma('user_version = 28');
}

function insertRun(db: Db, over: Partial<Record<string, string | number>> = {}): string {
  const row = {
    id: 'run_one',
    chapter: 8,
    rev: 1,
    text_sha: 'sha-text',
    prompt_sha: 'sha-prompt',
    model: 'test-model',
    pass: 'extract',
    at: AT,
    status: 'ok',
    ...over,
  };
  db.prepare(
    `INSERT INTO extraction_runs (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status)
     VALUES (@id, @chapter, @rev, @textSha, @promptSha, @model, @pass, @at, @status)`,
  ).run({
    id: row.id,
    chapter: row.chapter,
    rev: row.rev,
    textSha: row.text_sha,
    promptSha: row.prompt_sha,
    model: row.model,
    pass: row.pass,
    at: row.at,
    status: row.status,
  });
  return String(row.id);
}

function insertFact(db: Db, over: Partial<Record<string, string | number | null>> = {}): void {
  const row = { id: 'fct_a', chapter: 8, kind: 'date', key: 'date:2065-09-14', ...over };
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at, key, sentence)
     VALUES (@id, @chapter, @kind, 'Служебное утверждение.', NULL, @chapter, @at, @key, '')`,
  ).run({ ...row, at: AT });
}

function insertEdge(db: Db, over: Partial<Record<string, string | number>> = {}): void {
  const row = { id: 'fdp_one', from: 'fct_a', to: 'fct_b', chapter: 8, kind: 'cause', ...over };
  db.prepare(
    `INSERT INTO fact_dependency (id, "from", "to", chapter, kind, statement, origin, step_id, rev, at)
     VALUES (@id, @from, @to, @chapter, @kind, 'Служебное следствие.', 'registered', 'stp_one', 1, @at)`,
  ).run({ ...row, at: AT });
}

let db: Db;

afterEach(() => {
  db.close();
});

describe('migration v29 — the graph on a volume that holds its text', () => {
  it('builds the same shape on a fresh and on a migrated install, and keeps every v28 column', () => {
    const fresh = openDatabase(':memory:');
    migrate(fresh);
    expect(SCHEMA_VERSION).toBe(29);
    const freshShape = {
      facts: info(fresh, 'facts'),
      dependency: info(fresh, 'fact_dependency'),
      threads: info(fresh, 'threads'),
      runs: info(fresh, 'extraction_runs'),
      factIndexes: indexNames(fresh, 'facts'),
      dependencyIndexes: indexNames(fresh, 'fact_dependency'),
      runIndexes: indexNames(fresh, 'extraction_runs'),
      factKeys: foreignKeys(fresh, 'facts'),
      dependencyKeys: foreignKeys(fresh, 'fact_dependency'),
    };
    fresh.close();

    db = openDatabase(':memory:');
    migrate(db);
    // A book with history: an invalidated fact carrying ADR-044's sentence, and a story line.
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, sentence_id, valid_from_chapter, created_at)
       VALUES ('fct_old', 8, 'state', 'Служебное утверждение.', NULL, 'snt_one', 8, ?)`,
    ).run(AT);
    db.prepare('UPDATE facts SET invalidated_at = ? WHERE id = ?').run(AT, 'fct_old');
    db.prepare(
      `INSERT INTO threads (id, label, direction, opened_at_chapter, closed_at_chapter, state)
       VALUES ('thr_one', 'служебная линия', 'forward', 8, NULL, 'opened')`,
    ).run();

    shapeAsV28(db);
    // The fixture is honest: it is a v28 install, with no graph and no run ledger.
    expect(names(db, 'facts')).toEqual(V28_FACTS_COLUMNS);
    expect(objectSql(db, 'table', 'facts')).not.toContain("'date'");
    expect(names(db, 'threads')).toEqual(V28_THREAD_COLUMNS);
    expect(() => db.prepare('SELECT id FROM fact_dependency').all()).toThrow(/no such table/u);
    expect(() => db.prepare('SELECT id FROM extraction_runs').all()).toThrow(/no such table/u);

    expect(migrate(db)).toEqual({ from: 28, to: 29 });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(29);

    // The property: the upgraded tables are the fresh ones, column for column (name, type,
    // NOT NULL, default, key position), index for index, reference for reference.
    expect(info(db, 'facts')).toEqual(freshShape.facts);
    expect(info(db, 'fact_dependency')).toEqual(freshShape.dependency);
    expect(info(db, 'threads')).toEqual(freshShape.threads);
    expect(info(db, 'extraction_runs')).toEqual(freshShape.runs);
    expect(indexNames(db, 'facts')).toEqual(freshShape.factIndexes);
    expect(indexNames(db, 'fact_dependency')).toEqual(freshShape.dependencyIndexes);
    expect(indexNames(db, 'extraction_runs')).toEqual(freshShape.runIndexes);
    expect(foreignKeys(db, 'facts')).toEqual(freshShape.factKeys);
    expect(foreignKeys(db, 'fact_dependency')).toEqual(freshShape.dependencyKeys);
    // The partial index is one live fact per key, not one row per key.
    expect(objectSql(db, 'index', 'facts_key_live')).toContain('WHERE invalidated_at IS NULL');
    // The guard came back with the rebuild, and the row it guards survived it.
    expect(objectSql(db, 'trigger', 'facts_no_delete')).toContain('facts are never deleted');
    // ADR-044's carrier is copied, not dropped by the rebuild.
    expect(names(db, 'facts')).toContain('sentence_id');

    // Every row survived, and no migration invented an identity or a run for it: an empty key,
    // sentence and provenance, and a NULL supersession, are the honest answers for a v28 row.
    expect(
      db.prepare('SELECT id, sentence_id, key, sentence, extracted_by, superseded_by_extraction FROM facts').get(),
    ).toEqual({
      id: 'fct_old',
      sentence_id: 'snt_one',
      key: '',
      sentence: '',
      extracted_by: '',
      superseded_by_extraction: null,
    });
    expect(db.prepare('SELECT id, extracted_by FROM threads').all()).toEqual([{ id: 'thr_one', extracted_by: '' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('replays as a no-op, and adds nothing when SCHEMA_SQL already built the v29 shape', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertRun(db);
    insertFact(db);
    const built = objectSql(db, 'table', 'facts');
    const guard = objectSql(db, 'trigger', 'facts_no_delete');
    const runs = objectSql(db, 'table', 'extraction_runs');

    expect(migrate(db)).toEqual({ from: 29, to: 29 });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(29);
    expect(rebuildFacts(db)).toBe(false);
    expect(objectSql(db, 'table', 'facts')).toBe(built);
    expect(objectSql(db, 'trigger', 'facts_no_delete')).toBe(guard);

    // The step itself is idempotent too, for a build that runs it twice.
    expect(() => migrateV29(db)).not.toThrow();
    expect(objectSql(db, 'table', 'facts')).toBe(built);
    expect(objectSql(db, 'table', 'extraction_runs')).toBe(runs);
    expect(db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get()).toEqual({ n: 1 });

    // A fresh install runs the step after `SCHEMA_SQL`, which already built every object.
    const scratch = openDatabase(':memory:');
    try {
      scratch.exec(SCHEMA_SQL);
      expect(factsShapeIsCurrent(scratch)).toBe(true);
      expect(() => migrateV29(scratch)).not.toThrow();
      expect(info(scratch, 'facts')).toEqual(info(db, 'facts'));
      expect(indexNames(scratch, 'facts')).toEqual(['facts_asof', 'facts_key_live', 'facts_term']);
      expect(names(scratch, 'threads')).toContain('extracted_by');
    } finally {
      scratch.close();
    }
  });

  it('creates `facts` when the install has no table at all and rebuilds it without its old guards', () => {
    db = openDatabase(':memory:');
    // The defensive path: v22 always creates `facts` first, but `rebuildFacts` is exported and
    // must not read a missing table as an error — a table that is not there is not the shape.
    expect(factsShapeIsCurrent(db)).toBe(false);
    expect(rebuildFacts(db)).toBe(true);
    expect(names(db, 'facts')).toEqual([...V28_FACTS_COLUMNS, 'key', 'sentence', 'extracted_by', 'superseded_by_extraction']);
    expect(indexNames(db, 'facts')).toEqual(['facts_asof', 'facts_key_live', 'facts_term']);
    expect(objectSql(db, 'trigger', 'facts_no_delete')).toContain('facts are never deleted');
    expect(rebuildFacts(db)).toBe(false);
  });

  it('keeps the old table whole when the rebuild cannot finish', () => {
    db = openDatabase(':memory:');
    migrate(db);
    shapeAsV28(db);
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES ('fct_keep', 2, 'state', 'Служебное состояние.', NULL, 2, ?)`,
    ).run(AT);
    // An object already holding the temporary name makes the swap fail after the trigger and the
    // indexes are gone — the case the savepoint exists for.
    db.exec('CREATE VIEW facts_v29 AS SELECT 1 AS n');

    expect(() => rebuildFacts(db)).toThrow(/facts_v29/u);
    // Nothing of the old table was lost, and its guards came back with the rollback.
    expect(names(db, 'facts')).toEqual(V28_FACTS_COLUMNS);
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 1 });
    expect(indexNames(db, 'facts')).toEqual(['facts_asof', 'facts_term']);
    expect(objectSql(db, 'trigger', 'facts_no_delete')).toContain('facts are never deleted');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('the extraction run record', () => {
  it('keeps every answer to one question: the tuple is an index, not a key', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertRun(db);
    // BOOK-DOC-77 §5: «supersede, never overwrite». A forced re-ask is another row, so the
    // previous raw answer survives the answer that replaces it.
    expect(objectSql(db, 'table', 'extraction_runs')).not.toMatch(/UNIQUE/u);
    expect(() => insertRun(db, { id: 'run_two' })).not.toThrow();
    expect(indexNames(db, 'extraction_runs')).toEqual(['extraction_runs_chapter', 'extraction_runs_question']);
    expect(() => insertRun(db, { id: 'run_recall', pass: 'recall' })).not.toThrow();
    expect(() => insertRun(db, { id: 'run_rev2', rev: 2 })).not.toThrow();
    expect(() => insertRun(db, { id: 'run_model', model: 'another-model' })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get()).toEqual({ n: 5 });
    expect(db.prepare("SELECT id FROM extraction_runs WHERE id IN ('run_one','run_two') ORDER BY id").all()).toEqual([
      { id: 'run_one' },
      { id: 'run_two' },
    ]);
  });

  it('refuses a pass, a status or a chapter outside the schema’s vocabulary', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertRun(db);
    expect(() => insertRun(db, { id: 'run_bad_pass', pass: 'merge' })).toThrow(/CHECK constraint failed/u);
    expect(() => insertRun(db, { id: 'run_bad_status', status: 'partial' })).toThrow(/CHECK constraint failed/u);
    let rev = 2;
    for (const pass of ['extract', 'recall']) {
      for (const status of ['ok', 'refused', 'error']) {
        expect(() => insertRun(db, { id: `run_${pass}_${status}`, pass, status, rev })).not.toThrow();
        rev += 1;
      }
    }
    expect(() => insertRun(db, { id: 'run_ch0', chapter: 0 })).toThrow(/CHECK constraint failed/u);
    expect(() => insertRun(db, { id: 'run_ch68', chapter: 68 })).toThrow(/CHECK constraint failed/u);
  });

  it('refuses a fact or an edge that names a run nobody wrote', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertFact(db, { id: 'fct_a' });
    insertFact(db, { id: 'fct_b', key: 'document:65-11877-арх', kind: 'document' });
    insertEdge(db);
    expect(() => db.prepare(`UPDATE facts SET superseded_by_extraction = 'run_missing' WHERE id = 'fct_a'`).run()).toThrow(
      /FOREIGN KEY constraint failed/u,
    );
    expect(() => db.prepare(`UPDATE fact_dependency SET retired_by_run = 'run_missing'`).run()).toThrow(
      /FOREIGN KEY constraint failed/u,
    );
    const run = insertRun(db);
    expect(() => db.prepare(`UPDATE facts SET superseded_by_extraction = ? WHERE id = 'fct_a'`).run(run)).not.toThrow();
    expect(() => db.prepare(`UPDATE fact_dependency SET retired_by_run = ?`).run(run)).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('the fact_dependency edge and the facts vocabulary', () => {
  it('accepts the five world kinds and refuses a sixth, a missing endpoint and a duplicate claim', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertFact(db, { id: 'fct_a' });
    insertFact(db, { id: 'fct_b', key: 'document:65-11877-арх', kind: 'document' });
    for (const kind of ['cause', 'promise', 'document', 'absence', 'decision']) {
      expect(() => insertEdge(db, { id: `fdp_${kind}`, from: 'fct_a', to: 'fct_b', kind })).not.toThrow();
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_dependency').get()).toEqual({ n: 5 });
    expect(() => insertEdge(db, { id: 'fdp_bad', from: 'fct_a', to: 'fct_b', kind: 'consequence' })).toThrow(
      /CHECK constraint failed/u,
    );
    expect(() => insertEdge(db, { id: 'fdp_ghost', from: 'fct_a', to: 'fct_missing', kind: 'cause' })).toThrow(
      /FOREIGN KEY constraint failed/u,
    );
    // The same reason, the same consequence, the same kind, the same chapter is one claim.
    expect(() => insertEdge(db, { id: 'fdp_again', from: 'fct_a', to: 'fct_b', kind: 'cause' })).toThrow(
      /UNIQUE constraint failed/u,
    );
    // Told in a later chapter it is a second telling, and the row is allowed.
    expect(() => insertEdge(db, { id: 'fdp_later', from: 'fct_a', to: 'fct_b', kind: 'cause', chapter: 9 })).not.toThrow();
  });

  it('refuses a kind outside the ten words, and allows exactly those ten', () => {
    db = openDatabase(':memory:');
    migrate(db);
    expect(FACT_KINDS).toHaveLength(10);
    expect(() => insertFact(db, { id: 'fct_rumour', kind: 'rumour' })).toThrow(/CHECK constraint failed/u);
    for (const kind of FACT_KINDS) {
      expect(() => insertFact(db, { id: `fct_${kind}`, kind, key: `k:${kind}` })).not.toThrow();
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 10 });
  });

  it('allows one live fact per key, and an invalidated one beside it', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertFact(db, { id: 'fct_a', kind: 'date', key: 'date:2065-09-14' });
    // A second assertion of the same date is a `use` mention, not a fact.
    expect(() => insertFact(db, { id: 'fct_b', kind: 'date', key: 'date:2065-09-14' })).toThrow(
      /UNIQUE constraint failed: facts\.key/u,
    );
    // The fact stopped being true: its successor may hold the same identity in the same text.
    db.prepare('UPDATE facts SET invalidated_at = ? WHERE id = ?').run(AT, 'fct_a');
    expect(() => insertFact(db, { id: 'fct_c', kind: 'date', key: 'date:2065-09-14' })).not.toThrow();
    expect(() => insertFact(db, { id: 'fct_d', kind: 'date', key: 'date:2065-09-14' })).toThrow(
      /UNIQUE constraint failed: facts\.key/u,
    );
    // Several rows whose identity was never derived are legal — a legacy row is not a duplicate.
    insertFact(db, { id: 'fct_e', kind: 'state', key: '' });
    insertFact(db, { id: 'fct_f', kind: 'state', key: '' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE key = ''`).get()).toEqual({ n: 2 });
  });

  it('recreates the run ledger text on an install that already has it', () => {
    db = openDatabase(':memory:');
    migrate(db);
    insertRun(db);
    expect(() => db.exec(EXTRACTION_RUNS_TABLE_SQL)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get()).toEqual({ n: 1 });
  });
});

describe('the reset over the graph', () => {
  it('empties fact_dependency before facts and extraction_runs after them, reference-clean', () => {
    const target = createFixture(bookFiles());
    try {
      reconcile(target.db, { bookRoot: target.root, dataDir: target.dataDir });
      seedBook(target);
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get() as { n: number }).n).toBe(1);
      expect((target.db.prepare('SELECT COUNT(*) AS n FROM fact_dependency').get() as { n: number }).n).toBe(2);

      const report = resetBook(target.db, { dataDir: target.dataDir, now: new Date(AT), dryRun: false });
      // The counters saw the graph, and the wipe removed it: a fact names the run that retired it,
      // so a wipe that kept the run would keep the audit of a book that no longer exists.
      expect(report.tables.find((entry) => entry.key === 'extraction_runs')?.rows).toBe(1);      expect(report.tables.find((entry) => entry.key === 'fact_dependency')?.rows).toBe(2);
      for (const table of ['facts', 'extraction_runs', 'fact_dependency']) {
        expect(target.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }
      expect(target.db.pragma('foreign_key_check')).toEqual([]);
      // The guard and the key rule survive the wipe: a reset restores the promise, not drops it.
      expect(objectSql(target.db, 'trigger', 'facts_no_delete')).toContain('facts are never deleted');
      expect(indexNames(target.db, 'facts')).toEqual(['facts_asof', 'facts_key_live', 'facts_term']);
    } finally {
      target.close();
    }
  });
});
