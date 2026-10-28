/**
 * The schema of ARCHITECTURE.md §8, revision 4 — **version 16** (M6b added `revisions.hseq`
 * and the per-version block chain; M7 adds the operator's `reconciles` mark on a restore,
 * §13.3; BOOK-6 adds `chapters.basis`, the slot that holds only its basis sentence; BOOK-7
 * adds `front_matter.about_sha256` and the chapter-level premise (`changes.premise`,
 * `steps.premise_change`); BOOK-9 adds the auditor's verdict to a comment, recorded before
 * triage can accept it; BOOK-16 adds the intervention's kind to the comment and the change;
 * BOOK-18 adds `document.status` to the history's vocabulary, in `EVENTS_TABLE_SQL`;
 * BOOK-23 adds `cost_priced` to the three tables that hold a money figure, so «measured» and
 * «placeholder zero» are different data, not the same 0); BOOK-113 adds `identities.edit_exempt`
 * — off by default — so the owner can test a change without waiting out the daily edit budget,
 * while every other reader keeps it; BOOK-61 adds the three gates of
 * BOOK-DOC-42 — Gate A's hold (`comments.held_*`), Gate B's verdict (`comments.rights_*`,
 * `steps.rights_scan`) and the conditional `rights` role on both gate tables); BOOK-137 adds the
 * frame mark to the comment and the change, and the paperwork mode to the change, so a filing
 * that touched the canon sentence is recorded as paperwork instead of disappearing; BOOK-58 adds
 * the terms a reader accepted (`comments.terms_version`, `comments.terms_sha`) and the moment a
 * landed variant was entered (`comments.accepted_at`, `comments.accepted_terms_version`), so
 * «which terms did the reader accept?» has an answer years later; BOOK-158 adds the attempt
 * ledger (`comment_attempts`) and `triage` to the ledger's pass vocabulary, so a refusal can be
 * explained, revised and charged without spending the reader's daily edit); BOOK-176 adds the span ledger (BOOK-DOC-69) and v23 adds `identities.is_author` — the imprint's own reader (owner, 2026-10-28).
 * Text tables are a projection of the manuscript files; the engine tables are the only home of
 * process facts. Every table §8 names exists here, and the retired `obligations` table does not (§23.5, ADR-023).
 *
 * **The `chapter` CHECKs below stay `BETWEEN 1 AND 67` although the book is 42 chapters
 * (BOOK-155).** A row written before the cut (chapter 65) is real prose and must survive;
 * SQLite cannot narrow a CHECK without rebuilding the table, and a rebuild would reject that
 * row. The columns are therefore a **storage** bound, and the book's range (`TOTAL_CHAPTERS`)
 * is enforced at ingest, in the routes and in the engine — see `tables.ts` for the same note
 * next to `CHAPTERS_TABLE_SQL`.
 */

export const SCHEMA_VERSION = 23;

/**
 * Two standalone table definitions live in `tables.ts` because both the full schema here and
 * an incremental migration need them (§13.3, §6F.3, BOOK-6); they are re-exported so a reader
 * of the schema still finds every table in one place.
 */
import { BLOCK_VERSIONS_TABLE_SQL, CHAPTERS_TABLE_SQL, COMMENT_ATTEMPTS_TABLE_SQL, EVENTS_TABLE_SQL, GATE_TABLES_SQL, PASS_SPEND_TABLE_SQL, PASS_STAGES_TABLE_SQL, RECONCILES_TABLE_SQL } from './tables.ts';
import { LEDGER_FTS_SQL, LEDGER_REQUIRED_TABLES, LEDGER_REQUIRED_TRIGGERS, LEDGER_TABLES_SQL } from './ledgerTables.ts';

export {
  BLOCK_VERSIONS_TABLE_SQL,
  COMMENT_ATTEMPTS_TABLE_SQL,
  PASS_STAGES_TABLE_SQL,
  PASS_SPEND_TABLE_SQL,
  CHAPTERS_COLUMNS,
  CHAPTERS_TABLE_SQL,
  EVENTS_TABLE_SQL,
  EVENTS_TRIGGERS_SQL,
  GATE_TABLES_SQL,
  RECONCILES_TABLE_SQL,
  STEPS_COLUMNS,
  chaptersTableSql,
} from './tables.ts';
export { LEDGER_FTS_SQL, LEDGER_REQUIRED_TABLES, LEDGER_REQUIRED_TRIGGERS, LEDGER_TABLES_SQL } from './ledgerTables.ts';

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
  UNIQUE (cascade_id, seq)
);
CREATE INDEX steps_chapter ON steps(chapter, at);
CREATE INDEX steps_open ON steps(outcome, at);
`;

export const SCHEMA_SQL = `
${CHAPTERS_TABLE_SQL}

CREATE TABLE front_matter (                    -- manuscript/00-front.md: title + annotation (§6C.2)
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  title       TEXT    NOT NULL,                -- line 1, ≤80 chars, validated by F021
  about       TEXT    NOT NULL,                -- page 2, 300–4 000 chars in up to 12 blocks, validated by F021
  rev         INTEGER NOT NULL DEFAULT 1,
  sha256      TEXT    NOT NULL,                -- hash of the whole file
  about_sha256 TEXT   NOT NULL DEFAULT '',     -- hash of the published annotation (owner edit / basis)
  updated_at  TEXT    NOT NULL
);

CREATE TABLE blocks (
  id        TEXT PRIMARY KEY,                  -- 'ch08#9c1f0a3b' (+ '-2' for duplicates)
  chapter   INTEGER NOT NULL REFERENCES chapters(n) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,                  -- position in the current revision
  text      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  first_rev INTEGER NOT NULL,
  last_rev  INTEGER NOT NULL
);
CREATE INDEX blocks_chapter_idx ON blocks(chapter, idx);

CREATE TABLE revisions (
  chapter   INTEGER NOT NULL REFERENCES chapters(n) ON DELETE CASCADE,
  rev       INTEGER NOT NULL,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('create','rewrite','edit','polish','restore')),
  cause_kind TEXT NOT NULL CHECK (cause_kind IN ('draft','change','cascade','front','ending','sweep','operator','restore')),
  change_id TEXT REFERENCES changes(id),
  cascade_id TEXT REFERENCES cascades(id),
  step_id   TEXT REFERENCES steps(step_id),
  added     INTEGER NOT NULL,
  changed   INTEGER NOT NULL,
  removed   INTEGER NOT NULL,
  snapshot  TEXT NOT NULL,                     -- 'versions/ch08/3f9c….md'
  attributed INTEGER NOT NULL DEFAULT 1,       -- 0 = no lease matched (F015)
  hseq      INTEGER,                           -- the log entry that produced this revision (§6F.2)
  log_note  TEXT,
  PRIMARY KEY (chapter, rev)
);
CREATE INDEX revisions_hseq ON revisions(chapter, hseq);

-- ── the writing engine (§6A) ───────────────────────────────────────────────
-- Invariant: exactly one row of 'lane' exists; it serializes changes.

CREATE TABLE changes (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,  -- THE fifo order, immutable
  id           TEXT NOT NULL UNIQUE,               -- 'chg_01JB7…'
  kind         TEXT NOT NULL CHECK (kind IN ('reader_edit','accepted_comment','continuity','operator')),
  -- BOOK-16: which world-fact the source intervention brought. Null for a continuity/operator
  -- change and for a comment stored before BOOK-16; the four ids are in shared/src/intervention.ts.
  intervention_kind TEXT CHECK (intervention_kind IN ('document','decision','testimony','erasure')),
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  anchor       TEXT,                               -- JSON {blockIds,quote,prefix,suffix}
  intent       TEXT NOT NULL,                      -- ≤200 chars, what must become true
  intent_original TEXT,                            -- set when relevance adapted it
  proposed_text TEXT,                              -- reader_edit only, never applied verbatim
  source_comment TEXT REFERENCES comments(id),
  source_session TEXT,                             -- 'fwd' | 'bwd' for continuity
  base_rev     INTEGER NOT NULL,
  base_sha256  TEXT NOT NULL,
  base_blocks  TEXT NOT NULL,                      -- JSON array of block hashes
  scope_hint   TEXT NOT NULL CHECK (scope_hint IN ('phrase','chapter')),
  -- BOOK-137: how the filing sat against the frozen frame, and — when it touched it — the
  -- paperwork mode it was filed as. A registered change is a document, not an edit.
  frame        TEXT CHECK (frame IN ('touched','adjacent','untouched')),
  frame_mode   TEXT CHECK (frame_mode IN ('оформление','поправка','расхождение')),
  premise      INTEGER NOT NULL DEFAULT 0,       -- BOOK-7: 1 = a chapter-level premise, not prose (base_rev 0, no anchor)
  status       TEXT NOT NULL CHECK (status IN
                 ('pending','processing','stale','done','void','escalated','failed')),
  relevance    TEXT,                               -- JSON Relevance (§6A.7)
  outcome      TEXT,                               -- applied|adapted|dropped|superseded|budget|edge|oscillation|origin|science|rights
  reason       TEXT,                               -- public one-liner when dropped/escalated
  cascade_id   TEXT,
  model        TEXT,                               -- frozen at close (§6D.5)
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_rub     REAL    NOT NULL DEFAULT 0,         -- a placeholder zero unless cost_priced (BOOK-23)
  cost_priced  INTEGER NOT NULL DEFAULT 0,         -- BOOK-23: 1 = cost_rub is a measurement, 0 = never priced
  cost_usd     REAL    NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,         -- legacy sum, kept for one migration cycle
  enqueued_at  TEXT NOT NULL,
  started_at   TEXT, finished_at TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX changes_lane ON changes(status, seq);
CREATE INDEX changes_chapter ON changes(chapter, seq);
CREATE UNIQUE INDEX changes_premise_pending ON changes(chapter) WHERE premise = 1 AND status = 'pending'; -- BOOK-7: one queued premise per chapter

CREATE TABLE change_events (               -- append-only audit of status/intent transitions
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id  TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,                -- queued|processing|stale|adapted|decided|escalated|released|cancelled
  meta       TEXT                          -- JSON, no prose bodies beyond intent
);

CREATE TABLE cascades (
  id          TEXT PRIMARY KEY,                    -- 'csc_01JB7…'
  change_id   TEXT NOT NULL REFERENCES changes(id),
  status      TEXT NOT NULL CHECK (status IN ('open','closed','escalated','aborted')),
  outcome     TEXT,                                -- consistent|absorbed|frontier|escalated:*
  wave        INTEGER NOT NULL DEFAULT 0,
  depth_fwd   INTEGER NOT NULL DEFAULT 0,
  depth_bwd   INTEGER NOT NULL DEFAULT 0,
  step_count  INTEGER NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  budget      TEXT NOT NULL,                       -- JSON, frozen at open (§6A.6)
  opened_at   TEXT NOT NULL, closed_at TEXT
);

${STEPS_TABLE_SQL}

${GATE_TABLES_SQL}

CREATE TABLE leases (
  id           TEXT PRIMARY KEY,                   -- 'lea_01JB7…'
  step_id      TEXT NOT NULL,                      -- one lease per step (§6B.4 rule 1)
  change_id    TEXT REFERENCES changes(id),
  cascade_id   TEXT REFERENCES cascades(id),
  lane         TEXT CHECK (lane IN ('forward','backward')),
  chapter      INTEGER CHECK (chapter BETWEEN 1 AND 67),   -- null for the title lease
  is_front     INTEGER NOT NULL DEFAULT 0 CHECK (is_front IN (0,1)),
  kind         TEXT NOT NULL CHECK (kind IN ('draft','change','cascade','front','ending','sweep')),
  session      TEXT NOT NULL,                      -- 'fwd' | 'bwd'
  expected_rev INTEGER NOT NULL,
  acquired_at  TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  released_at  TEXT, release_reason TEXT,
  CHECK ((chapter IS NOT NULL AND is_front = 0) OR (chapter IS NULL AND is_front = 1))
);
CREATE UNIQUE INDEX leases_live_target             -- one live lease per chapter, and one for the title
  ON leases(COALESCE(chapter, 0)) WHERE released_at IS NULL;

CREATE TABLE lane (                                -- single row; the FIFO mutex
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  holder   TEXT,                                   -- change id or null
  heartbeat_at TEXT
);
INSERT INTO lane (id, holder, heartbeat_at) VALUES (1, NULL, NULL);

CREATE TABLE comments (
  id           TEXT PRIMARY KEY,               -- 'cmt_01JB7…' (ULID, sortable)
  identity_id  TEXT NOT NULL REFERENCES identities(id),   -- Yandex subject (ADR-021)
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  block_id     TEXT,                           -- null = chapter-level
  block_idx    INTEGER,                        -- position at posting time (display only)
  base_rev     INTEGER,                        -- the revision the quote came from (§6A.7, M5)
  quote        TEXT,                           -- exact text at posting time (≤280 chars)
  prefix       TEXT,                           -- ≤40 chars before the quote
  suffix       TEXT,                           -- ≤40 chars after
  author       TEXT NOT NULL,                  -- display name snapshot at posting time, ≤32 chars
  body         TEXT NOT NULL,                  -- ≤1200 chars, normalized
  proposed_text TEXT,                          -- a reader's suggested wording; data, never applied verbatim
  -- BOOK-16: the intervention's kind — one of four world-facts, required with proposed_text
  -- for a new row. Null is valid for a note and for every row stored before BOOK-16.
  intervention_kind TEXT CHECK (intervention_kind IN ('document','decision','testimony','erasure')),
  body_sha     TEXT NOT NULL,                  -- sha256(normalized body), for dedupe
  flags        TEXT NOT NULL DEFAULT '[]',     -- JSON guard flags; advisory, travels in a batch
  ip_hash      TEXT NOT NULL,                  -- HMAC-SHA256(salt, ip or /64)
  status       TEXT NOT NULL,                  -- new|batched|delivered|accepted|applied|registered|superseded|rejected|quarantined|expired|hidden
  -- BOOK-137: the mark the classifier gave this filing at posting time (null before v16).
  frame        TEXT CHECK (frame IN ('touched','adjacent','untouched')),
  guard        TEXT,                           -- null|'legal'|'instruction'|'spam'|'dup'
  created_at   TEXT NOT NULL,
  delivered_at TEXT,                           -- when it entered a batch
  decided_at   TEXT,                           -- triage accept/reject
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
  idem_key     TEXT UNIQUE
);
CREATE INDEX comments_chapter ON comments(chapter, created_at);
CREATE INDEX comments_status  ON comments(status, created_at);
CREATE INDEX comments_ip      ON comments(ip_hash, created_at);
CREATE INDEX comments_identity ON comments(identity_id, created_at);

CREATE TABLE comment_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  -- BOOK-61 adds held (Gate A stopped the row before a model could read it) and rights
  -- (Gate B decided it); BOOK-58 adds applied (a landed variant was entered into the book and
  -- the reader's terms were recorded). Free text, so the vocabulary is documented here and
  -- nowhere else.
  type       TEXT NOT NULL,                    -- posted|quarantined|held|released|queued|delivered|decided|rights|hidden|expired|applied
  meta       TEXT                              -- JSON, no bodies
);

CREATE TABLE feedback_batches (
  id          TEXT PRIMARY KEY,                -- 'bat_01JB7…'
  created_at  TEXT NOT NULL,
  closed_at   TEXT,
  chapter     INTEGER,
  loop        TEXT,
  count       INTEGER NOT NULL,
  path        TEXT NOT NULL,                   -- 'batches/bat_….jsonl'
  comment_ids TEXT NOT NULL                    -- JSON array
);

-- ── identity and attribution (ADR-021) ─────────────────────────────────────

CREATE TABLE identities (
  id            TEXT PRIMARY KEY,              -- opaque ULID, never the Yandex sub
  yandex_sub    TEXT NOT NULL UNIQUE,          -- the stable subject from the IdP; never rendered
  display_name  TEXT NOT NULL,                 -- chosen by the reader, ≤32 chars, editable in one place
  hide_from_authors INTEGER NOT NULL DEFAULT 0, -- opt-out of the end-matter list (§6C.5)
  blocked       INTEGER NOT NULL DEFAULT 0,    -- moderation: cannot post
  -- BOOK-113: 1 = the daily edit budget (identity *and* network) does not apply to this
  -- identity. Off by default; the comment budget still applies.
  edit_exempt   INTEGER NOT NULL DEFAULT 0,
  is_author     INTEGER NOT NULL DEFAULT 0,     -- 1 = the imprint's author (owner, 2026-10-28): a reader, never a row
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                -- opaque, not the cookie value
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  cookie_hash TEXT NOT NULL UNIQUE,            -- sha256 of the opaque cookie (the cookie itself is never stored)
  created_at  TEXT NOT NULL, expires_at TEXT NOT NULL,
  ip_hash     TEXT, user_agent_hash TEXT,
  revoked_at  TEXT
);
CREATE INDEX sessions_identity ON sessions(identity_id, expires_at);

CREATE TABLE contributions (                   -- projection of §6C.5, refreshed nightly and on demand
  identity_id TEXT PRIMARY KEY REFERENCES identities(id),
  edits       INTEGER NOT NULL,
  chars       INTEGER NOT NULL,                -- characters whose last cause is this reader's change
  share       REAL    NOT NULL,                -- chars / totalChars, 0..1
  first_at    TEXT NOT NULL, last_at TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- ── history, provenance, impact (§6F) ───────────────────────────────────────
-- Append-only. The triggers below refuse UPDATE/DELETE; 'history/log.ts' is the only writer.

${EVENTS_TABLE_SQL}

${RECONCILES_TABLE_SQL}

CREATE TABLE front_revisions (                 -- every title + annotation revision (§6C.2, §6F.2)
  rev        INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  about      TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  snapshot   TEXT NOT NULL,                    -- 'versions/front/<sha256>.md'
  hseq       INTEGER NOT NULL,
  at         TEXT NOT NULL,
  change_id  TEXT, step_id TEXT
);

CREATE TABLE block_lineage (                   -- one row per block identity that ever existed (§6F.3)
  block_id    TEXT PRIMARY KEY,                -- 'ch08#aa11bb22'
  chapter     INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  first_rev   INTEGER NOT NULL,
  last_rev    INTEGER,                         -- null while the block is still in the text
  first_hseq  INTEGER NOT NULL,
  last_hseq   INTEGER,
  cause_kind  TEXT NOT NULL CHECK (cause_kind IN
                ('change','cascade','draft','sweep','operator','unattributed')),
  change_id   TEXT, identity_id TEXT,
  chars       INTEGER NOT NULL,
  replaced_by TEXT                             -- the block that took its place; null = erased
);
CREATE INDEX lineage_chapter ON block_lineage(chapter, first_hseq);
CREATE INDEX lineage_cause   ON block_lineage(change_id);

${BLOCK_VERSIONS_TABLE_SQL}

${PASS_STAGES_TABLE_SQL}

${PASS_SPEND_TABLE_SQL}

${COMMENT_ATTEMPTS_TABLE_SQL}

${LEDGER_TABLES_SQL}${LEDGER_FTS_SQL}   -- BOOK-176 / BOOK-DOC-69: the ledger and its full-text mirror

CREATE TABLE overwrites (                      -- explicit «переписано в T правкой X» (§6F.3)
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id     TEXT NOT NULL,
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  hseq         INTEGER NOT NULL, at TEXT NOT NULL,
  by_change_id TEXT, by_step_id TEXT,
  by_kind      TEXT NOT NULL CHECK (by_kind IN
                 ('change','cascade','draft','sweep','operator','unattributed')),
  by_label     TEXT NOT NULL,                  -- 'Аня' · 'автор' · 'правка вне процесса'
  replaced_by  TEXT,
  previous_cause TEXT                          -- the change that introduced the erased block
);
CREATE INDEX overwrites_block   ON overwrites(block_id);
CREATE INDEX overwrites_chapter ON overwrites(chapter, hseq);

CREATE TABLE change_impact (                   -- materialized at close, rebuildable (§6F.5)
  change_id          TEXT PRIMARY KEY REFERENCES changes(id) ON DELETE CASCADE,
  chapters_touched   TEXT NOT NULL,            -- JSON array
  chapters_rewritten TEXT NOT NULL,            -- JSON array
  blocks_changed     INTEGER NOT NULL,
  chars_added        INTEGER NOT NULL,
  chars_removed      INTEGER NOT NULL,
  overwrites         INTEGER NOT NULL,
  seams              TEXT NOT NULL,            -- JSON [{boundary,resolved}]
  depth_down         INTEGER NOT NULL,
  depth_up           INTEGER NOT NULL,
  tokens             INTEGER NOT NULL,
  cost_rub           REAL    NOT NULL,
  cost_priced        INTEGER NOT NULL DEFAULT 0,   -- BOOK-23: 1 = cost_rub is a measurement
  ms                 INTEGER NOT NULL,
  from_hseq          INTEGER NOT NULL,
  to_hseq            INTEGER NOT NULL,
  computed_at        TEXT NOT NULL
);

CREATE TABLE contribution_history (            -- daily erosion series, one row per identity per day (§6F.4)
  identity_id TEXT NOT NULL REFERENCES identities(id),
  day         TEXT NOT NULL,                   -- 'YYYY-MM-DD' UTC
  edits       INTEGER NOT NULL,
  chars       INTEGER NOT NULL,
  share       REAL    NOT NULL,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (identity_id, day)
);

CREATE TABLE rate_events ( key TEXT NOT NULL, ts INTEGER NOT NULL );
CREATE INDEX rate_events_key_ts ON rate_events(key, ts);

CREATE TABLE meta ( k TEXT PRIMARY KEY, v TEXT NOT NULL );
`;

/** Tables that must exist after migration — used by the boot probe. */
export const REQUIRED_TABLES = [
  'chapters',
  'front_matter',
  'blocks',
  'revisions',
  'changes',
  'change_events',
  'cascades',
  'steps',
  'gate_verdicts',
  'gate_dispatches',
  'leases',
  'lane',
  'comments',
  'comment_events',
  'comment_attempts',
  'feedback_batches',
  'identities',
  'sessions',
  'contributions',
  'events',
  'reconciles',
  'front_revisions',
  'block_lineage',
  'block_versions',
  'overwrites',
  'pass_stages',
  'pass_spend',
  'change_impact',
  'contribution_history',
  'rate_events',
  'meta',
  ...LEDGER_REQUIRED_TABLES,
] as const;

/** §6F.1: the log is append-only; a missing trigger means the promise is not kept (F027). */
export const REQUIRED_TRIGGERS = ['events_no_update', 'events_no_delete', ...LEDGER_REQUIRED_TRIGGERS] as const;
