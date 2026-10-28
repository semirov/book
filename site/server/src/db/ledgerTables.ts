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
  -- ADR-044: the sentence that carries this statement. Null for a row written before v25; no
  -- REFERENCES clause (SQLite cannot add one by ALTER, and fresh and migrated installs must match).
  sentence_id           TEXT,
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
  -- ADR-044: the sentence that carries this mention; null for a row written before v25.
  sentence_id        TEXT,
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
  -- ADR-044: the sentence that carries this literal; null for a row written before v25.
  sentence_id  TEXT,
  start        INTEGER NOT NULL,
  end          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS literals_value ON literals(literal, chapter);
`;

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
] as const;

/**
 * The ledger's guards. `facts_no_delete` is the decision's own promise; the three FTS triggers
 * are what makes a search result a statement about the current text. The reset re-creates all of
 * them after its wipe, so the promise survives an empty book too.
 */
export const LEDGER_REQUIRED_TRIGGERS = [
  'facts_no_delete',
  'blocks_fts_ai',
  'blocks_fts_ad',
  'blocks_fts_au',
] as const;
