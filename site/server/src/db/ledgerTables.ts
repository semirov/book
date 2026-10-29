/**
 * The ledger's tables (BOOK-176, decision BOOK-DOC-69) — declared once, here, because the full
 * schema (`schema.ts`) and migration v22 have to build exactly the same objects: a fresh
 * install reads them from `SCHEMA_SQL`, an upgraded install gets them from `migrateV22`, and
 * the failure this file prevents is a table that exists in a test and not on the server.
 *
 * What the ledger is: the book's storage moves from «the block's text is the truth» to «every
 * change of a block is one span that can be undone» — `block_versions.spans` holds the spans
 * of a version, `facts` holds the world's statements with their lifetime, `fact_dependency`
 * holds the registered claim that one fact is the reason another holds (BOOK-185),
 * `extraction_runs` is the audit of the model pass that wrote them, `threads` and
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
 * BOOK-185: the ten kind words a fact may carry. The first seven are the carriers the extraction
 * stage fills — a date, a document number, a person's name, a term, a promise, a decision, an
 * absence; the last three are the vocabulary BOOK-176 shipped with and must keep working, because
 * a row written then is real history. Declared once here: the CHECK below, the boot probe and
 * migration v29 all read this list.
 */
export const FACT_KINDS = [
  'document',
  'date',
  'name',
  'term',
  'promise',
  'decision',
  'absence',
  'testimony',
  'erasure',
  'state',
] as const;

const FACT_KIND_CHECK = FACT_KINDS.map((kind) => `'${kind}'`).join(',');

/**
 * The columns of `facts` in the order both the fresh install and migration v29 declare them: the
 * v22 set first, then ADR-044's sentence, then the BOOK-185 and BOOK-DOC-77 columns. `migrateV29`
 * copies the intersection of this list and the old table's own columns, so the rebuild never
 * invents a value.
 */
export const FACTS_COLUMNS = [
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
  'key',
  'sentence',
  'extracted_by',
  'superseded_by_extraction',
] as const;

/**
 * BOOK-185 / BOOK-DOC-77 — the record of one extraction pass: what was asked (chapter, revision,
 * text and prompt hashes, model, pass), what came back (`response`, kept verbatim so a run can be
 * replayed and audited), what it cost and what it produced.
 *
 * **Append-only, and that is the design note's §5.** The question's tuple is an index, not a key:
 * a forced re-ask inserts another row and keeps the previous raw answer, because «supersede, never
 * overwrite» is about the audit too. A row is never updated in place; reuse reads the **latest**
 * `status = 'ok'` row for the tuple and answers from it, and the rows a run wrote name their own
 * run through `extracted_by` / `superseded_by_extraction`.
 */
export const EXTRACTION_RUNS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS extraction_runs (
  id             TEXT PRIMARY KEY,
  chapter        INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  rev            INTEGER NOT NULL,
  text_sha       TEXT NOT NULL,                     -- the chapter text the model read
  prompt_sha     TEXT NOT NULL,                     -- the bundle's own version
  model          TEXT NOT NULL,
  pass           TEXT NOT NULL CHECK (pass IN ('extract','recall')),
  at             TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','refused','error')),
  request_sha    TEXT NOT NULL DEFAULT '',
  response       TEXT NOT NULL DEFAULT '',           -- the raw model answer, for replay and audit
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  tokens_cached  INTEGER NOT NULL DEFAULT 0,
  usd            REAL NOT NULL DEFAULT 0,
  facts          INTEGER NOT NULL DEFAULT 0,          -- counts the validator accepted
  uses           INTEGER NOT NULL DEFAULT 0,
  edges          INTEGER NOT NULL DEFAULT 0,
  threads        INTEGER NOT NULL DEFAULT 0,
  rejects        TEXT NOT NULL DEFAULT '[]',          -- JSON [{code, item}], never a rewrite
  error          TEXT
);
CREATE INDEX IF NOT EXISTS extraction_runs_chapter ON extraction_runs(chapter, rev);
CREATE INDEX IF NOT EXISTS extraction_runs_question
  ON extraction_runs(chapter, rev, text_sha, prompt_sha, model, pass);
`;

/**
 * A fact is the world's statement, and BOOK-185 gives it an identity: `key` is the normalised
 * form the extraction stage derives (`date:2065-09-14`, `document:65-11877-арх`,
 * `name:ковалев`), and `sentence` is the sentence that first asserts it, so the graph can be read
 * without re-reading the chapter. Both default to `''`: a row written before v29 was never given
 * either, and inventing one would be a lie.
 *
 * ADR-044's `sentence_id` (v25) stays: the identity of the sentence row the statement is told in,
 * with no `REFERENCES` clause for the same reason as before (SQLite cannot add one by `ALTER`,
 * and fresh and migrated installs must match).
 *
 * BOOK-DOC-77 adds the provenance: `extracted_by` names the run that wrote the row (`''` on a row
 * the ledger wrote itself), and `superseded_by_extraction` names the run that retired it. A
 * superseded row stays — it is what the book believed before that run — but it is no longer the
 * graph, so every live read excludes it (`factAsOf`, the closure).
 */
export const FACTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id                    TEXT PRIMARY KEY,
  chapter               INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind                  TEXT NOT NULL CHECK (kind IN (${FACT_KIND_CHECK})),
  statement             TEXT NOT NULL,
  term                  TEXT,                       -- canonical surface form used for mention binding
  -- ADR-044: the sentence that carries this statement. Null for a row written before v25.
  sentence_id           TEXT,
  valid_from_chapter    INTEGER NOT NULL CHECK (valid_from_chapter BETWEEN 1 AND 67),
  invalidated_at        TEXT,                       -- ISO time; null while valid
  invalidated_by_change TEXT REFERENCES changes(id),
  created_at            TEXT NOT NULL,
  key                   TEXT NOT NULL DEFAULT '',   -- BOOK-185: normalised identity, '' for a pre-v29 row
  sentence              TEXT NOT NULL DEFAULT '',   -- BOOK-185: the asserting sentence (≤280 chars)
  extracted_by          TEXT NOT NULL DEFAULT '',   -- BOOK-DOC-77: the run that wrote it, '' if none
  superseded_by_extraction TEXT REFERENCES extraction_runs(id)   -- retired by a later run, never deleted
);
`;

/**
 * The same table under another name — migration v29 builds the new shape beside the old one,
 * copies, then swaps the names. It deliberately never renames `facts` aside: with foreign keys
 * enabled SQLite rewrites every child's `REFERENCES` to the renamed table, which would leave
 * `mentions` and `thread_events` naming a table that no longer exists. Dropping the old table and
 * renaming the new one in touches no child clause on either setting.
 */
export function factsTableSql(name: string): string {
  return FACTS_TABLE_SQL.replace('CREATE TABLE IF NOT EXISTS facts', `CREATE TABLE IF NOT EXISTS ${name}`);
}

/**
 * The partial unique index is the one-live-fact-per-key rule: a second assertion of the same
 * date or document in a later chapter is a `use` mention, not a new fact. An invalidated row and
 * its live successor coexist — that is what invalidation means — and the empty key of a legacy
 * row never collides with another empty one.
 *
 * It is a statement of its own, not part of `FACTS_INDEXES_SQL`, because it names `key` — a
 * column a pre-v29 table does not have. The shared ledger text runs on a pre-v22 install *before*
 * v29 rebuilds the table, and an index over a missing column would fail that boot. A fresh
 * install reads it from `SCHEMA_SQL`, the upgrade from `migrateV29`, and both end in one shape.
 */
export const FACTS_KEY_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS facts_key_live ON facts(key)
  WHERE invalidated_at IS NULL AND key <> '';
`;

export const FACTS_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS facts_asof ON facts(valid_from_chapter, invalidated_by_change);
CREATE INDEX IF NOT EXISTS facts_term ON facts(term);
`;

export const FACTS_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS facts_no_delete BEFORE DELETE ON facts
  BEGIN SELECT RAISE(ABORT, 'facts are never deleted (BOOK-DOC-69)'); END;
`;

/**
 * BOOK-185 / ADR-040 §2.1 — the edge the closure walks: one registered claim that `"from"` is the
 * reason `"to"` holds, told in a chapter, in one of five world kinds. `stance` is how the reader
 * learns it, not what holds (ADR-040 §2.2), so it is a second column rather than a sixth kind. An
 * edge is retired through `superseded_by`, never deleted — there is no delete trigger because
 * deleting an edge loses no world statement, and the accept path retires instead.
 *
 * The end columns are ADR-040's `"from"`/`"to"`, quoted because `from` is a keyword: the doctor's
 * closure probe (`doctor/inspect.ts`) reads exactly those two names, and the recursive walk in
 * `graph/closure.ts` is written against them.
 *
 * ADR-040's `line TEXT REFERENCES lanes(line)` names the book's eight narrative lanes. This
 * repository's `lane` table is the single-row FIFO mutex (§6A.3), not that vocabulary: an FK to it
 * would be satisfied by every row at once and would lie about what the column means. `line` is
 * therefore plain text — the lane's own key, once that table exists — and no reference is
 * declared until it can be truthful.
 */
export const FACT_DEPENDENCY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS fact_dependency (
  id            TEXT PRIMARY KEY,
  "from"        TEXT NOT NULL REFERENCES facts(id),         -- the reason
  "to"          TEXT NOT NULL REFERENCES facts(id),         -- what holds because of it
  chapter       INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),   -- where it is TOLD
  kind          TEXT NOT NULL CHECK (kind IN ('cause','promise','document','absence','decision')),
  stance        TEXT NOT NULL DEFAULT 'plain' CHECK (stance IN ('plain','revealed','concealed')),
  line          TEXT,                                       -- the lane's key; null outside the lanes
  statement     TEXT NOT NULL,                              -- ≤200 chars by convention, not enforced
  origin        TEXT NOT NULL CHECK (origin IN ('registered','inferred')),
  step_id       TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  superseded_by TEXT REFERENCES fact_dependency(id),        -- retired, never deleted
  at            TEXT NOT NULL,
  extracted_by  TEXT NOT NULL DEFAULT '',                   -- BOOK-DOC-77: the run that wrote it
  retired_by_run TEXT REFERENCES extraction_runs(id),       -- BOOK-DOC-77: the run that retired it
  UNIQUE ("from", "to", kind, chapter)
);
CREATE INDEX IF NOT EXISTS fact_dependency_from ON fact_dependency("from", chapter);
CREATE INDEX IF NOT EXISTS fact_dependency_to   ON fact_dependency("to", chapter);
`;

/**
 * The frozen plan of a change (BOOK-173, BOOK-DOC-75 §3) — migration v32.
 *
 * The ripple's graph is `fact_dependency` (BOOK-185): this is the one table the ripple keeps of
 * its own. `closure` is the plan without its patches, `patches` the list the writer produces per
 * chapter, `bounds` the caps frozen at estimate, `iterations` the append-only journal of the
 * fixpoint. The diff is deliberately absent: the readable before/after comes from `block_versions`
 * by `blockId`, so the text keeps one home. `mode` and `price_usd` travel with the plan because a
 * plan is what a change was written under: the mode the pass ran and the money it was estimated
 * at, replaced by the actual at close.
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
  -- BOOK-173 §4: how the change was written — the mode the pass ran, recorded with the plan so
  -- the answer «did this patch or rewrite?» is a row and not a log line. Null for a plan written
  -- before v32; a change with no plan at all records its mode on the close (step.closed).
  mode         TEXT CHECK (mode IN ('patch','rewrite')),
  -- BOOK-173 §4: the estimate frozen at planning, replaced by the pass's actual at close. Null
  -- means «never priced», never «free» — the same rule cost_priced follows (BOOK-23).
  price_usd    REAL,
  -- BOOK-173, BOOK-DOC-80: the record of the verification a «local only» change got. gates_mode
  -- says whether the full pair read the chapter («full») or only the local judge did — and the
  -- sample's own word changes it to «local_only_rechecked» when the editor later disagreed, so the
  -- row never keeps claiming a clean read it no longer has. tier1_usd is the judge's own price
  -- (null = not priced); sample_requested / sampled_at / sample_verdict are the safeguard's queue.
  tier1_verdict    TEXT CHECK (tier1_verdict IN ('HOLDS','GAP','UNSURE','TIER1_UNPARSED')),
  tier1_usd        REAL,
  gates_mode       TEXT CHECK (gates_mode IN ('local only','full','local_only_rechecked')),
  sample_requested INTEGER NOT NULL DEFAULT 0,
  sampled_at       TEXT,
  sample_verdict   TEXT CHECK (sample_verdict IN ('ok','gap','error')),
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
 * Order matters only for readability: `extraction_runs` comes first (both `facts` and
 * `fact_dependency` reference it), then `facts` and `threads`, which `fact_dependency`,
 * `mentions` and `thread_events` reference; SQLite resolves the references when a row is written.
 * Every statement is `IF NOT EXISTS`, so a reset restoring the guard re-runs this text.
 */
export const LEDGER_TABLES_SQL = `
${EXTRACTION_RUNS_TABLE_SQL}
${FACTS_TABLE_SQL}${FACTS_INDEXES_SQL}${FACTS_TRIGGER_SQL}
${FACT_DEPENDENCY_TABLE_SQL}

CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('forward','backward')),
  opened_at_chapter INTEGER NOT NULL CHECK (opened_at_chapter BETWEEN 1 AND 67),
  closed_at_chapter INTEGER CHECK (closed_at_chapter BETWEEN 1 AND 67),
  state             TEXT NOT NULL CHECK (state IN ('opened','advanced','complicated','closed')),
  extracted_by      TEXT NOT NULL DEFAULT ''     -- BOOK-DOC-77: the run that opened it, '' if none
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
${CHANGE_PLANS_SQL}`;

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
  'extraction_runs',
  'facts',
  'fact_dependency',
  'threads',
  'thread_events',
  'mentions',
  'literals',
  'blocks_fts',
  'change_plans',
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
