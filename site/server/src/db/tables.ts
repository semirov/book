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

export { PASS_STAGES_TABLE_SQL } from './stageTables.ts';

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
  provenance TEXT CHECK (provenance IN ('pipeline','operator','pipeline-estimated')) -- who ran it (BOOK-117), estimated or measured (BOOK-219)
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
  -- BOOK-206 (v30): the claim, the tries and the verdict. A filing is claimed by a conditional
  -- UPDATE on this row, so the queue is the ledger the posting request already writes.
  claim_by    TEXT,                               -- the writer session that holds the claim
  claim_until TEXT,                               -- ISO UTC; an expired claim makes the row due again
  tries       INTEGER NOT NULL DEFAULT 0,         -- calls bought for this attempt (cap 5, BOOK-DOC-84 §10.8)
  next_at     TEXT,                               -- ISO UTC: the backoff a failed call set
  verdict     TEXT,                               -- the validated book.verdict/v1 answer, written once
  verdict_at  TEXT,
  -- BOOK-DOC-84 §10.8: the third failure widens the reading; the sixth attempt is desperate.
  widened     TEXT,                               -- the widening code ('as-document'), null before the third failure
  desperate   INTEGER NOT NULL DEFAULT 0,         -- 1 = the deterministic sixth attempt, no model call
  UNIQUE (comment_id, n)
);
CREATE INDEX comment_attempts_day ON comment_attempts(day);
CREATE INDEX comment_attempts_comment ON comment_attempts(comment_id, at);
CREATE INDEX comment_attempts_body ON comment_attempts(body_sha, anchor_sha, day);
CREATE INDEX comment_attempts_due ON comment_attempts(outcome, next_at);`;

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
  'reopened_at',
  'desperate',
  'widened',
] as const;

/**
 * `steps` — one step is one chapter edit plus its two gates. It lives here because two places
 * build it: the full schema, and `ensureStepLifecycle` in `migrate.ts`, which rebuilds a pre-M3
 * table from exactly these columns (a migrated install must equal a fresh one).
 */
export const STEPS_TABLE_SQL = `CREATE TABLE steps (                             -- one step = one chapter edit + its two gates
  step_id     TEXT PRIMARY KEY,                  -- 'stp_01JB7…'
  cascade_id  TEXT REFERENCES cascades(id) ON DELETE CASCADE,   -- null for draft/front/sweep
  seq         INTEGER NOT NULL,                  -- order within the cascade, assigned by the engine
  wave        INTEGER NOT NULL,
  lane        TEXT CHECK (lane IN ('forward','backward')),
  pass        TEXT NOT NULL CHECK (pass IN ('draft','change','cascade','front','ending','sweep')),
  chapter     INTEGER CHECK (chapter BETWEEN 1 AND 67),          -- null for 'front'
  boundary    TEXT NOT NULL,                     -- '5' (n = boundary n−1|n), 'front', 'ending'
  premise_change TEXT REFERENCES changes(id),    -- BOOK-7: the chapter-level premise this draft consumes
  outcome     TEXT CHECK (outcome IN              -- null while the step is open
                ('rewritten','holds','published_with_finding','evaluated','escalated','interrupted')),
  rev_before  INTEGER, rev_after INTEGER,
  seams_in    TEXT,                              -- JSON [{boundary,reason}]
  seams_out   TEXT,                              -- JSON [{boundary,reason}]
  blocks_touched INTEGER, chars_delta INTEGER,
  model       TEXT,                              -- the writer model used for this step
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_rub    REAL    NOT NULL DEFAULT 0,        -- frozen at close (§6D.5); a placeholder zero unless cost_priced (BOOK-23)
  cost_priced INTEGER NOT NULL DEFAULT 0,        -- BOOK-23: 1 = cost_rub is a measurement, 0 = never priced
  hseq_from   INTEGER, hseq_to INTEGER,          -- the history span this step wrote (§6F.1)
  lease_id    TEXT, session TEXT,
  at          TEXT NOT NULL, ms INTEGER, note TEXT,
  cycle       INTEGER NOT NULL DEFAULT 0,        -- writer revisions consumed (§6B.4)
  last_findings TEXT,                            -- admin-only: what sent the writer back (§6B.2)
  start_sha   TEXT,                              -- sha of the text the step started from (recovery)
  landed_at   TEXT,                              -- the file was written (or "already true")
  landed_sha  TEXT,                              -- sha of the landed text; a gate reads this
  pre_blocks  TEXT,                              -- JSON block hashes before the write (delta ratio)
  -- BOOK-61: Gate B's deterministic scan of the blocks this step wrote.
  -- JSON {"verdict":"clear"|"flag","rule":…,"block":…,"detail":…}; cleared when landed_sha moves.
  -- A refusal is never stored here: the law's own class refuses the land, a quote is a flag.
  rights_scan TEXT,
  closed_at   TEXT,
  -- BOOK-117: who ran the pass — 'pipeline' (the lane on the pin) or 'operator' (a repair).
  provenance  TEXT CHECK (provenance IN ('pipeline','operator')),
  -- BOOK-117: when the step was re-opened to be closed with the verdicts it earned. The step
  -- wall is measured from MAX(at, reopened_at), so a reopen is a fresh window and a step older
  -- than the wall can still be closed (at itself never moves: it is the step's opening).
  reopened_at TEXT,
  -- BOOK-DOC-84 §10.8: the ladder's own facts — the sixth attempt, the widening it runs under.
  -- Null/0 until the ladder moves. The write mode is not repeated here: BOOK-173 records it
  -- with the plan (change_plans.mode), and the widening is read from the widened column.
  desperate   INTEGER NOT NULL DEFAULT 0,
  widened     TEXT,
  UNIQUE (cascade_id, seq)
);
CREATE INDEX steps_chapter ON steps(chapter, at);
CREATE INDEX steps_open ON steps(outcome, at);
`;

/**
 * `comments` — one reader's filing, and everything the site knows about how it was read
 * (§8, §12.2). BOOK-174 adds the disposition chain: `disposition`, `lock`, `carrier_kind`
 * and `quote_kept` (the verbatim fragment behind a document, or the refusing stamp), beside
 * ADR-044's `sentence_id` that anchors the reading. Null in all four is the honest answer for
 * a row written before v27 — it was never read this way.
 */
export const COMMENTS_TABLE_SQL = `CREATE TABLE comments (
  id           TEXT PRIMARY KEY,               -- 'cmt_01JB7…' (ULID, sortable)
  -- BOOK-218: the filing's own public number — what a reader reads («замечание 12»). It is
  -- explicit, not an implicit rowid: VACUUM and a table rebuild may renumber a rowid, and a
  -- number a reader was shown must never move. Assigned at insert, unique, 1-based.
  -- DEFAULT 0 is what makes ALTER TABLE … ADD COLUMN NOT NULL legal on a v29 install, and the
  -- default is stated here so the fresh and the migrated shapes are one: the product's writer
  -- always assigns the next number, and the unique index refuses a second unnumbered row.
  number       INTEGER NOT NULL DEFAULT 0,
  identity_id  TEXT NOT NULL REFERENCES identities(id),   -- Yandex subject (ADR-021)
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  block_id     TEXT,                           -- null = chapter-level
  block_idx    INTEGER,                        -- position at posting time (display only)
  base_rev     INTEGER,                        -- the revision the quote came from (§6A.7, M5)
  quote        TEXT,                           -- exact text at posting time (≤280 chars)
  prefix       TEXT,                           -- ≤40 chars before the quote
  suffix       TEXT,                           -- ≤40 chars after
  -- ADR-044: the sentence the quote sits in, and the reader's selection inside it. Null is the
  -- legacy block anchor — a row written before v25, or a quote that straddles a boundary.
  -- No REFERENCES clause: see the note at the top of this file.
  sentence_id  TEXT,
  sel_start    INTEGER,                        -- code points from the sentence's start
  sel_end      INTEGER,                        -- exclusive; null/null = the whole sentence
  author       TEXT NOT NULL,                  -- display name snapshot at posting time, ≤32 chars
  body         TEXT NOT NULL,                  -- ≤1200 chars, normalized
  proposed_text TEXT,                          -- a reader's suggested wording; data, never applied verbatim
  -- BOOK-16: the intervention's kind — one of four world-facts, required with proposed_text
  -- for a new row. Null is valid for a note and for every row stored before BOOK-16.
  intervention_kind TEXT CHECK (intervention_kind IN ('document','decision','testimony','erasure')),
  body_sha     TEXT NOT NULL,                  -- sha256(normalized body), for dedupe
  flags        TEXT NOT NULL DEFAULT '[]',     -- JSON guard flags; advisory, travels in a batch
  ip_hash      TEXT NOT NULL,                  -- HMAC-SHA256(salt, ip or /64)
  status       TEXT NOT NULL,                  -- new|batched|delivered|accepted|applied|registered|superseded|rejected|escalated|quarantined|expired|hidden
  -- BOOK-137: the mark the classifier gave this filing at posting time (null before v16).
  frame        TEXT CHECK (frame IN ('touched','adjacent','untouched')),
  guard        TEXT,                           -- null|'legal'|'instruction'|'spam'|'dup'
  created_at   TEXT NOT NULL,
  delivered_at TEXT,                           -- when it entered a batch
  decided_at   TEXT,                           -- triage accept/reject/escalate
  reason       TEXT,                           -- public one-liner (≤200 chars), Russian
  batch_id     TEXT,
  change_id    TEXT REFERENCES changes(id),    -- the queued change, when accepted
  applied_chapter INTEGER,
  applied_rev  INTEGER,
  -- BOOK-9: the auditor's verdict, written once, before triage. FITS is the
  -- only permission a change has; OFF also refuses the comment in the same act.
  audit_verdict TEXT CHECK (audit_verdict IN ('FITS','OFF')),
  audit_reason  TEXT,                          -- the auditor's plain reason (≤200 chars), never a taxonomy
  audited_at    TEXT,
  audited_by    TEXT,                          -- the operator/session label, ≤64 chars
  -- BOOK-61 Gate A: a hold and who decided it. held_rule is the filter's own id (INJ-…), so
  -- the operator sees why the row stopped; the public line stays «проверяется», never the
  -- taxonomy. A released row keeps these columns as the record of the hold.
  held_rule    TEXT,
  held_by      TEXT CHECK (held_by IN ('filter','classifier','operator')),
  held_at      TEXT,
  -- BOOK-61 Gate B: the rights verdict of a filing. One column per writer, first verdict wins;
  -- rights_source says what decided — the deterministic scan, the rights gate, an operator.
  rights_verdict TEXT CHECK (rights_verdict IN ('CLEAR','REFUSED')),
  rights_rule    TEXT,
  rights_at      TEXT,
  rights_by      TEXT,
  rights_source  TEXT CHECK (rights_source IN ('scan','model','operator')),
  -- BOOK-58: the terms a submission accepted, written once at posting from the shared copy
  -- (shared/src/terms.ts), and the moment a landed variant was entered into the book. The
  -- acceptance columns are the row's own record: accepted_terms_version copies the row's
  -- terms_version, so a later text change cannot rewrite what a reader once accepted.
  terms_version TEXT,
  terms_sha     TEXT,
  accepted_at   TEXT,
  accepted_terms_version TEXT,
  -- BOOK-174 §5: how the filing was read. Null is the honest answer for every row written
  -- before v27 — it was never read this way, and nothing invents a reading for it.
  disposition   TEXT CHECK (disposition IN ('as_said','through_paper','refused_in_world','inadmissible','escalated')),
  lock          TEXT CHECK (lock IN ('rights','harm','frame','finale')),
  carrier_kind  TEXT CHECK (carrier_kind IN ('document','speech','registry_discrepancy','numbered_object','unheeded_joke','obligatory_joke')),
  quote_kept    TEXT,                          -- the verbatim fragment, or the refusing stamp
  idem_key     TEXT UNIQUE
);
`;

/**
 * BOOK-218 — the filing's public number is unique and never reused. Created beside the table so
 * a fresh install (`SCHEMA_SQL`) and an upgrade (`migrateV32`) state the same index once.
 */
export const COMMENTS_NUMBER_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS comments_number ON comments(number);';

/**
 * BOOK-174 §7 — the editor's materialised reading of how often the world refuses. One row per
 * scope (`reader_chapter` | `chapter` | `part`), recomputed from `comments` and read by the
 * operator's `feedback.mjs limits` only: no counter ever reaches a reader surface.
 */
export const DISPOSITION_COUNTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS disposition_counts (
  scope      TEXT NOT NULL CHECK (scope IN ('reader_chapter','chapter','part')),
  key        TEXT NOT NULL,
  accepted   INTEGER NOT NULL DEFAULT 0,
  in_world   INTEGER NOT NULL DEFAULT 0,
  run        INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;
