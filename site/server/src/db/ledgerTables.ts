/**
 * The ledger's tables (BOOK-176, decision BOOK-DOC-69) — declared once, here, because the full
 * schema (`schema.ts`) and migration v22 have to build exactly the same objects: a fresh
 * install reads them from `SCHEMA_SQL`, an upgraded install gets them from `migrateV22`, and
 * the failure this file prevents is a table that exists in a test and not on the server.
 *
 * What the ledger is: the book's storage moves from «the block's text is the truth» to «every
 * change of a block is one span that can be undone» — `block_versions.spans` holds the spans
 * of a version, `facts` holds the world's statements with their lifetime, `threads` and
 * `thread_events` hold a story line and the state machine it may move through, `mentions` binds
 * a stretch of block text to a fact, a thread or a literal, `literals` is the extracted
 * document/date index, and `blocks_fts` is the full-text mirror of `blocks` the search reads.
 *
 * Every statement is `IF NOT EXISTS`. A fresh install and an upgrade both run this text, and a
 * second run (a migration replayed, a reset restoring its triggers) must be a no-op rather than
 * an error — that is what makes the v22 step idempotent.
 *
 * Facts are never deleted (BOOK-DOC-69): a statement that stops being true is invalidated, and
 * the trigger below is the promise, not a convention. It is dropped by the launch reset only,
 * together with every other trigger it re-creates, because a reset empties the book on purpose.
 */

/**
 * The graph of the ripple (BOOK-173, BOOK-DOC-75 §1.2) — migration v24.
 *
 * `edges` is the dependency the ledger did not have: «this fact stands on that one». `chapter` is
 * where the relation is *told*, not where either endpoint lives; `on_component` is the component
 * of the source the target actually consumes (`value` · `identity` · `status` · `existence`) —
 * the one column that turns «the path proves its premise changed» into a query instead of a
 * judgement. `origin` says who wrote the row: the deterministic backfill, the writer's plan, or
 * the owner's own act. A duplicate is the same statement: the unique index is the idempotency key
 * `assertDependency` relies on.
 *
 * `fact_dependency` is the owner's name for this relation (BOOK-173 addendum §2). It is a view,
 * not a second table: one row per edge, no copy to drift.
 *
 * **Growth, and why there is no pruner.** An edge is retired, never aged out: when a fact is
 * invalidated the trigger below deletes the rows that name it, because a walk over a retired
 * premise is a plan that lies. The backfill re-asserts a row when the link is still told in the
 * text (that is what makes a re-run idempotent), and it skips facts that are invalidated, so a
 * retired link does not come back. What reads `edges`: `walk`/`allEdges` (the closure of every
 * plan), `fact_dependency` (the owner's review query) and `drainablePlans` indirectly through the
 * frozen `closure`. Row rate: one row per told relation per chapter, the whole book measured at
 * ~1.1 per fact, so a book-sized run is thousands of rows and a reset is the only wipe.
 */
export const LEDGER_GRAPH_SQL = `
CREATE TABLE IF NOT EXISTS edges (
  id           TEXT PRIMARY KEY,
  from_fact    TEXT NOT NULL REFERENCES facts(id),
  to_fact      TEXT NOT NULL REFERENCES facts(id),
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind         TEXT NOT NULL CHECK (kind IN ('follows','fulfils','references','contradicts')),
  on_component TEXT NOT NULL DEFAULT 'value'
                              CHECK (on_component IN ('value','identity','status','existence')),
  evidence     TEXT NOT NULL DEFAULT '',
  origin       TEXT NOT NULL DEFAULT 'backfill' CHECK (origin IN ('backfill','writer','owner')),
  created_at   TEXT NOT NULL,
  CHECK (from_fact <> to_fact)
);
CREATE UNIQUE INDEX IF NOT EXISTS edges_pair ON edges(from_fact, to_fact, kind, chapter);
CREATE INDEX IF NOT EXISTS edges_from ON edges(from_fact);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_fact);
CREATE VIEW IF NOT EXISTS fact_dependency AS
  SELECT from_fact, to_fact, chapter, kind, on_component, evidence, origin FROM edges;
CREATE TRIGGER IF NOT EXISTS facts_retire_edges
  AFTER UPDATE OF invalidated_at ON facts
  WHEN new.invalidated_at IS NOT NULL
  BEGIN
    DELETE FROM edges WHERE from_fact = new.id OR to_fact = new.id;
  END;
`;

/**
 * The frozen plan of a change (BOOK-173, BOOK-DOC-75 §3) — migration v24.
 *
 * `closure` is the plan without its patches, `patches` the list the writer produces per chapter,
 * `bounds` the caps frozen at estimate, `iterations` the append-only journal of the fixpoint. The
 * diff is deliberately absent: the readable before/after comes from `block_versions` by `blockId`,
 * so the text keeps one home.
 *
 * **One row per change, and the journal is the budget.** `UNIQUE (change_id)` is what makes the
 * bounds cumulative per change rather than per plan: a re-land of the same step updates this row
 * and appends to `iterations` instead of writing a second plan, so «what has this change already
 * spent?» is one journal sum and a cap cannot be reset by planning again. The row is written in
 * the landing's own transaction, so a crash lands neither the revision nor the plan.
 *
 * `parked_at`/`park_reason` are the one way a plan stops: `RIPPLE_REFUSED` after two refusals of
 * the same node, `CLOSURE_UNSTABLE`, a `wide` outcome, or a verification that did not hold. The
 * reason is a sentence for the author; `drainablePlans` excludes a parked row, so nothing retries
 * a plan the book already gave up on. `claimed_at`/`claimed_by` are the lane claim of the process
 * that is draining it, so two `--ripple` runs never take the same plan.
 *
 * **Growth.** One row per change and it is never pruned: the retire paths are the launch reset
 * (which empties the book) and a backfill/rebuild, both of which delete the whole table. Expected
 * rate is the lane's own: at most one row per filed change and one journal entry per chapter,
 * tens a day at the `maxPassesPerDay` ceiling — a book-sized table is thousands of rows, not
 * millions, which is why a pruner would be a second way to lose the budget.
 */
export const CHANGE_PLANS_SQL = `
CREATE TABLE IF NOT EXISTS change_plans (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS change_plans_change ON change_plans(change_id);
`;

/**
 * The ordinary tables of the ledger, their indexes and the one guard the decision names.
 * Order matters only for readability: `facts` and `threads` come first because `mentions` and
 * `thread_events` reference them; SQLite resolves the references when a row is written.
 */
export const LEDGER_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id                    TEXT PRIMARY KEY,
  chapter               INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind                  TEXT NOT NULL CHECK (kind IN ('document','decision','testimony','erasure','state')),
  statement             TEXT NOT NULL,
  term                  TEXT,                       -- canonical surface form used for mention binding
  valid_from_chapter    INTEGER NOT NULL CHECK (valid_from_chapter BETWEEN 1 AND 67),
  invalidated_at        TEXT,                       -- ISO time; null while valid
  invalidated_by_change TEXT REFERENCES changes(id),
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_asof ON facts(valid_from_chapter, invalidated_by_change);
CREATE INDEX IF NOT EXISTS facts_term ON facts(term);
CREATE TRIGGER IF NOT EXISTS facts_no_delete BEFORE DELETE ON facts
  BEGIN SELECT RAISE(ABORT, 'facts are never deleted (BOOK-DOC-69)'); END;

CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('forward','backward')),
  opened_at_chapter INTEGER NOT NULL CHECK (opened_at_chapter BETWEEN 1 AND 67),
  closed_at_chapter INTEGER CHECK (closed_at_chapter BETWEEN 1 AND 67),
  state             TEXT NOT NULL CHECK (state IN ('opened','advanced','complicated','closed'))
);
CREATE TABLE IF NOT EXISTS thread_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  chapter   INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind      TEXT NOT NULL CHECK (kind IN ('opened','advanced','complicated','closed')),
  fact_id   TEXT REFERENCES facts(id),
  note      TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_events_thread ON thread_events(thread_id, chapter);

CREATE TABLE IF NOT EXISTS mentions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id            TEXT NOT NULL,
  block_id           TEXT NOT NULL,
  chapter            INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  start              INTEGER NOT NULL,             -- 0-based code points, inclusive, in block text
  end                INTEGER NOT NULL,             -- exclusive
  kind               TEXT NOT NULL CHECK (kind IN ('fact','thread','document','date')),
  fact_id            TEXT REFERENCES facts(id),
  thread_id          TEXT REFERENCES threads(id),
  resolved_by_change TEXT,
  -- ADR-043 D3: an asserted fact and a consumed one are different records. Stage 2 sets 'use'.
  role               TEXT CHECK (role IN ('assert','use')),
  witness            TEXT NOT NULL DEFAULT '',   -- the exact text at [start,end)
  edge_path          TEXT NOT NULL DEFAULT '[]', -- JSON array, filled by the closure stage
  CHECK (end > start),
  CHECK ((kind = 'fact' AND fact_id IS NOT NULL AND thread_id IS NULL)
      OR (kind = 'thread' AND thread_id IS NOT NULL AND fact_id IS NULL)
      OR (kind IN ('document','date') AND fact_id IS NULL AND thread_id IS NULL)),
  CHECK ((kind = 'fact' AND role IS NOT NULL) OR (kind <> 'fact' AND role IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS mentions_span ON mentions(span_id, start, end, kind);
CREATE INDEX IF NOT EXISTS mentions_fact ON mentions(fact_id);
CREATE INDEX IF NOT EXISTS mentions_thread ON mentions(thread_id);
CREATE INDEX IF NOT EXISTS mentions_block ON mentions(block_id);

CREATE TABLE IF NOT EXISTS literals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  literal      TEXT NOT NULL,                      -- normalised: '65-11877-арх', '2065-09-14'
  raw          TEXT NOT NULL,
  block_id     TEXT NOT NULL,
  span_id      TEXT,
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  mention_kind TEXT NOT NULL CHECK (mention_kind IN ('document','date')),
  start        INTEGER NOT NULL,
  end          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS literals_value ON literals(literal, chapter);
${LEDGER_GRAPH_SQL}${CHANGE_PLANS_SQL}`;

/**
 * The full-text mirror `searchBlocks` reads. `content='blocks'` keeps the prose in one place
 * (the FTS index stores only the terms), and the three triggers keep it in step with every
 * write the block tables ever make — an `UPDATE blocks` rebuilds the row instead of leaving the
 * old phrase findable, which is the property BOOK-176 asks for.
 */
export const LEDGER_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  text, content='blocks', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS blocks_fts_au AFTER UPDATE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

/** The ledger tables the boot probe insists on: a missing one is a schema that lies. */
export const LEDGER_REQUIRED_TABLES = [
  'facts',
  'threads',
  'thread_events',
  'mentions',
  'literals',
  'blocks_fts',
  'edges',
  'change_plans',
] as const;

/**
 * The ledger's guards. `facts_no_delete` is the decision's own promise; the three FTS triggers
 * are what makes a search result a statement about the current text. The reset re-creates all of
 * them after its wipe, so the promise survives an empty book too.
 */
export const LEDGER_REQUIRED_TRIGGERS = [
  'facts_no_delete',
  'facts_retire_edges',
  'blocks_fts_ai',
  'blocks_fts_ad',
  'blocks_fts_au',
] as const;
