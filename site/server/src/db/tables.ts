/**
 * Table definitions that are needed in two places: the full schema (`schema.ts`) and the
 * incremental migration that adds them to an existing database (`migrate.ts`).
 *
 * They are declared once, here, so a fresh install and an upgraded install cannot drift
 * apart — the failure mode this file exists to prevent is a column that exists in tests (a
 * fresh install) and not on the server (an upgrade).
 *
 * **Why the chapter CHECK still says `BETWEEN 1 AND 67` although the book is 42 chapters
 * (BOOK-155):** a row written before the cut (chapter 65) is real prose and must survive. SQLite
 * cannot narrow a CHECK without rebuilding the table, and a rebuild would reject that row. So
 * the column stays a **storage** bound and the book's own range (`TOTAL_CHAPTERS`) is enforced
 * where the book is read: the ingest, the routes and the engine. Nothing outside 1..42 is
 * served or projected.
 */

/**
 * `chapters` — the prose projection of the manuscript, and the one table BOOK-6 widened.
 * It is a named constant because migration v7 has to build the *same* table (SQLite cannot
 * add a CHECK to an existing column), and a migrated install must be indistinguishable from
 * a fresh one.
 *
 * The `n` CHECK is a storage bound, not the book's length — see the header.
 */
export const CHAPTERS_TABLE_SQL = `CREATE TABLE chapters (
  n           INTEGER PRIMARY KEY CHECK (n BETWEEN 1 AND 67),
  rev         INTEGER NOT NULL DEFAULT 0,      -- increments per observed file change
  title       TEXT,                            -- line 1 of the file; null = «Глава N» (§6C.3)
  sha256      TEXT    NOT NULL,
  chars       INTEGER NOT NULL,                -- prose only; the title line is excluded
  block_count INTEGER NOT NULL,
  basis       INTEGER NOT NULL DEFAULT 0 CHECK (basis IN (0,1)),
                                               -- 1 = the file is exactly its basis sentence (BOOK-6):
                                               -- one block to read, chars 0, not written; a heading
                                               -- above the sentence is still the title (owner, 2026-10-28)
  written_at  TEXT    NOT NULL,                -- first sighting
  updated_at  TEXT    NOT NULL,
  parse_error TEXT,
  -- BOOK-176 / ADR-043 D9: fact-shaped tokens (a date, an n/m number, a «№» reference) in the
  -- live text that no fact mention covers. A counted gap, not a verdict: a chapter with a gap
  -- still reads and still lands, it just cannot be quoted as evidence.
  ledger_gap  INTEGER NOT NULL DEFAULT 0
);`;

/** The same table under another name — migration v7 builds it, copies, then swaps the names. */
export function chaptersTableSql(name: string): string {
  return CHAPTERS_TABLE_SQL.replace('CREATE TABLE chapters', `CREATE TABLE ${name}`);
}

/** Every column of `chapters`, in table order — the v7 rebuild copies exactly these. */
export const CHAPTERS_COLUMNS = [
  'n',
  'rev',
  'title',
  'sha256',
  'chars',
  'block_count',
  'basis',
  'written_at',
  'updated_at',
  'parse_error',
  'ledger_gap',
] as const;

export const BLOCK_VERSIONS_TABLE_SQL = `CREATE TABLE block_versions (               -- stable paragraph identity across rewrites (§6F.3)
  block_uid   TEXT NOT NULL,                   -- ULID; survives a rewrite that changes the text
  ver         INTEGER NOT NULL,                -- 1..n, monotonic inside a uid
  chapter     INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  rev         INTEGER NOT NULL,                -- the revision that wrote this version
  hseq        INTEGER NOT NULL,                -- the log entry of that revision
  block_id    TEXT NOT NULL,                   -- content-derived id at this version ('ch08#aa11bb22')
  text_hash   TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('introduced','revised','kept','erased')),
  prev_ver    INTEGER,                         -- the version this one replaced
  replaced_by TEXT,                            -- the uid that took its place; null = the chain ends
  change_id   TEXT, step_id TEXT,
  actor_kind  TEXT NOT NULL, actor_label TEXT NOT NULL, identity_id TEXT,
  at          TEXT NOT NULL,
  spans       TEXT NOT NULL DEFAULT '[]',      -- BOOK-176: JSON BlockSpan[] of this version
  -- BOOK-176 / ADR-043 D5: the full block text, written only on a checkpoint (ver 1, 8, 16 …);
  -- '' everywhere else. A change span is replayed forward from the nearest checkpoint.
  text        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (block_uid, ver)
);
CREATE INDEX block_versions_block   ON block_versions(block_id);
CREATE INDEX block_versions_chapter ON block_versions(chapter, rev);
CREATE INDEX block_versions_hseq    ON block_versions(hseq);`;

/**
 * §13.3: a restore never ran the gates, so the chapter is `ungated` until the next step
 * touches it or an operator runs `reconcile`. This table is the operator's mark: what was
 * restored, by whom, why, and what the validator said afterwards. It is a record, not a
 * permission — the text is already published.
 */
export const RECONCILES_TABLE_SQL = `CREATE TABLE reconciles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter     INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  rev         INTEGER NOT NULL,                -- the restore revision this mark belongs to
  at          TEXT    NOT NULL,
  actor       TEXT    NOT NULL,                -- who ran it: 'operator' by default
  because     TEXT    NOT NULL,                -- ≤200 chars, the operator's own words
  validation  TEXT    NOT NULL DEFAULT '{}',   -- JSON: {errors, warnings, passed, findings[]}
  hseq        INTEGER,                         -- the operator.restore log entry (the act)
  UNIQUE (chapter, rev)
);
CREATE INDEX reconciles_chapter ON reconciles(chapter, rev);`;

/**
 * The append-only guards of `events` (§6F.1, ADR-027, F027). One constant because the schema,
 * the v12 rebuild and the operator's launch reset (`reset/book.ts`) must create exactly these
 * two triggers: a reset drops them to delete the log, then puts this text back, so the promise
 * is restored rather than remembered.
 */
export const EVENTS_TRIGGERS_SQL = `CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only (ADR-027)'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only (ADR-027)'); END;`;

/** The names of those two guards — the launch reset drops exactly these before its wipe. */
export const EVENTS_TRIGGER_NAMES = ['events_no_update', 'events_no_delete'] as const;

/**
 * The writer lane's stages (docs/writer-lane.md §3, BOOK-117): one row per stage a pass
 * passed. `seq` is the store's own order and the replay cursor; `stage_seq` is the order
 * inside the pass, assigned by the store when the site emits a stage it holds no counter for.
 * No foreign key to `steps`: a stage is a fact about what happened even if the step is reaped.
 * It lives here because both the full schema and migration v16 (BOOK-117) build the same table.
 */
export const PASS_STAGES_TABLE_SQL = `CREATE TABLE pass_stages (                 -- one row per lane stage (docs/writer-lane.md §2)
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,   -- the store's own order = the replay cursor
  pass_id       TEXT NOT NULL,                       -- the engine's step id
  chapter       INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  stage_seq     INTEGER NOT NULL,                    -- monotonic inside the pass, from 1
  stage         TEXT NOT NULL CHECK (stage IN
                  ('queued','read','verdict','drafting','typing','landed','refused')),
  at            TEXT NOT NULL,                       -- ISO-8601 UTC, when the work happened
  actor_process TEXT NOT NULL CHECK (actor_process IN ('engine','writer','site','auditor')),
  actor_model   TEXT,                                -- null when no model ran
  change_id     TEXT,                                -- the change this pass carries, when any
  summary       TEXT NOT NULL,                       -- one factual line, ≤200 chars
  span          TEXT,                                -- JSON StageSpan[], null off 'landed'
  tokens_in     INTEGER,                             -- one call's on 'drafting', the pass's on 'landed'
  tokens_out    INTEGER,
  cost_usd      REAL,                                -- null off 'landed'
  UNIQUE (pass_id, stage_seq)
);
CREATE INDEX pass_stages_chapter_seq ON pass_stages(chapter, seq);`;

/**
 * The money ledger (BOOK-117): one row per pass that closed, the only place a spend total
 * comes from. `pass_id` is the engine's step id and UNIQUE, so a re-close is not a second
 * charge; `day` is the UTC date of `at`, which is what makes the day's cap lift by itself at
 * 00:00 UTC. `priced = 0` means the model has no rate and `usd` is the honest zero (BOOK-23).
 * It lives here because both the full schema and migration v17 (BOOK-117) build the same table.
 */
export const PASS_SPEND_TABLE_SQL = `CREATE TABLE pass_spend (                 -- the money ledger (BOOK-117)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,                        -- ISO UTC, when the pass closed
  day        TEXT NOT NULL,                        -- 'YYYY-MM-DD' (UTC), taken from 'at'
  pass_id    TEXT NOT NULL UNIQUE,                 -- the engine's step id, or 'triage:<commentId>:<n>'
  chapter    INTEGER,
  pass       TEXT NOT NULL CHECK (pass IN ('draft','change','cascade','front','ending','sweep','triage')),
  change_id  TEXT,
  model      TEXT,                                 -- the model the step closed with (null: none)
  tokens_in  INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  usd        REAL NOT NULL,                        -- costUsd of the step's tokens, 6 dp
  priced     INTEGER NOT NULL CHECK (priced IN (0,1)), -- 1 = usd is a measurement
  provenance TEXT CHECK (provenance IN ('pipeline','operator')) -- who ran the pass (BOOK-117)
);
CREATE INDEX pass_spend_day ON pass_spend(day);`;

/**
 * BOOK-158 — the attempt ledger: one row per submission a model may be asked to judge.
 *
 * A **filing** is the comment row and keeps its id through every revision; an **attempt** is
 * one submission of it, numbered `n` from 1 in submission order. The ledger is the only place
 * the model's attention is counted: a refusal spends a day's edit budget nowhere (that budget
 * belongs to an accepted filing, BOOK-DOC-4 rule 5), but it does spend an attempt here, so a
 * refused reader can be told how many tries are left, when the cooldown ends and whether the
 * same words already reached a model. `day` is the UTC date of `at`, which is what makes the
 * filing's three tries and the identity/network caps lift at 00:00 UTC by themselves.
 *
 * It lives here because both the full schema and migration v20 build the same table.
 */
export const COMMENT_ATTEMPTS_TABLE_SQL = `CREATE TABLE comment_attempts (          -- BOOK-158: submissions a model may judge
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,                   -- 1.. per filing, in submission order
  at          TEXT NOT NULL,                      -- ISO UTC of the submission that will be evaluated
  day         TEXT NOT NULL,                      -- UTC date of 'at'
  body_sha    TEXT NOT NULL,                      -- normalised body hash at submission time
  anchor_sha  TEXT NOT NULL,                      -- hash of block_id|quote|prefix|suffix (or the premise)
  quote       TEXT,
  outcome     TEXT CHECK (outcome IN ('submitted','accepted','refused','held','expired')),
  decided_at  TEXT,
  model       TEXT, tokens_in INTEGER, tokens_out INTEGER, usd REAL, priced INTEGER,
  UNIQUE (comment_id, n)
);
CREATE INDEX comment_attempts_day ON comment_attempts(day);
CREATE INDEX comment_attempts_comment ON comment_attempts(comment_id, at);
CREATE INDEX comment_attempts_body ON comment_attempts(body_sha, anchor_sha, day);`;

/**
 * `events` — the book's clock (§6F.1), and the one table whose inline CHECK grows with the
 * history's vocabulary. It is a named constant because BOOK-18 adds `document.status` and
 * SQLite cannot widen a CHECK with ALTER, so migration v12 rebuilds the table with its rows,
 * indexes and append-only triggers kept. A migrated install must equal a fresh one.
 */
export const EVENTS_TABLE_SQL = `CREATE TABLE events (                          -- the book's clock (§6F.1)
  hseq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'chapter.created','chapter.revised','chapter.restored','front.revised',
                 'change.queued','change.processing','change.stale','change.decided',
                 'cascade.opened','cascade.closed','step.opened','step.landed','step.closed',
                 'gate.recorded','overwrite','operator.restore','operator.release','operator.hide',
                 'document.status')),
  chapter      INTEGER CHECK (chapter BETWEEN 1 AND 67),
  is_front     INTEGER NOT NULL DEFAULT 0 CHECK (is_front IN (0,1)),
  rev          INTEGER,
  change_id    TEXT, cascade_id TEXT, step_id TEXT,
  author_kind  TEXT NOT NULL CHECK (author_kind IN
                 ('reader','author','writer','operator','unattributed')),
  identity_id  TEXT,                           -- nulled on an erasure request (§17); the label stays
  author_label TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL DEFAULT '{}',     -- JSON, ≤32 KB, never a chapter body
  prev_hseq    INTEGER
);
CREATE INDEX events_chapter ON events(chapter, hseq);
CREATE INDEX events_change  ON events(change_id, hseq);
CREATE INDEX events_kind    ON events(kind, hseq);
CREATE INDEX events_at      ON events(at);

${EVENTS_TRIGGERS_SQL}`;

/**
 * The two gate tables (BOOK-61). They live apart from `steps` because `ensureStepLifecycle`
 * rebuilds `steps` on an old install while both gate tables already exist — and because the
 * migration that widened `role` rebuilds them together.
 *
 * Gate B is conditional: the `rights` role exists only when a step's scan flagged or when a
 * filing's rights answer is required, so `GATE_ROLES` (engine/gates.ts) stays editor,
 * consultant. `gate_verdicts.verdict` is coupled to the role: a rights answer is CLEAR or
 * REFUSED, a prose answer is HOLDS or GAP, and one gate's word never stands for another's.
 */
export const GATE_TABLES_SQL = `
CREATE TABLE gate_dispatches (                   -- who was handed the gate for this step (§6B.4)
  step_id     TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('editor','consultant','rights')),
  session     TEXT NOT NULL,                     -- the session the verdict must come back from
  dispatched_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (step_id, role)
);

CREATE TABLE gate_verdicts (                     -- provenance of the hidden roles (§6B.3)
  step_id     TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('editor','consultant','rights')),
  verdict     TEXT NOT NULL
              CHECK ((role = 'rights' AND verdict IN ('CLEAR','REFUSED'))
                  OR (role IN ('editor','consultant') AND verdict IN ('HOLDS','GAP'))),
  findings    TEXT NOT NULL DEFAULT '[]',        -- JSON; admin-only, never public
  cycles      INTEGER NOT NULL DEFAULT 0,
  model       TEXT NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  late        INTEGER NOT NULL DEFAULT 0,        -- 1 = arrived after GATE_TTL_MS
  PRIMARY KEY (step_id, role)
);`;

/**
 * The `steps` table is the one table M3 needs more than §8 sketched: a step exists *before*
 * it is closed (it carries the lease and hangs both gate verdicts off its id), so `outcome`
 * is null while the step is open, and the land/close facts are columns rather than a second
 * table. `migrate.ts` rebuilds a pre-M3 `steps` table in place; the shape is declared once,
 * here, and reused by the repair so the two cannot drift.
 */

/** Every column a rebuilt `steps` table must carry (the repair in `migrate.ts` checks them). */
export const STEPS_COLUMNS = [
  'step_id',
  'cascade_id',
  'seq',
  'wave',
  'lane',
  'pass',
  'chapter',
  'boundary',
  'premise_change',
  'outcome',
  'rev_before',
  'rev_after',
  'seams_in',
  'seams_out',
  'blocks_touched',
  'chars_delta',
  'model',
  'tokens_in',
  'tokens_out',
  'cost_rub',
  'cost_priced',
  'hseq_from',
  'hseq_to',
  'lease_id',
  'session',
  'at',
  'ms',
  'note',
  'cycle',
  'last_findings',
  'start_sha',
  'landed_at',
  'landed_sha',
  'pre_blocks',
  'rights_scan',
  'closed_at',
  'provenance',
] as const;
