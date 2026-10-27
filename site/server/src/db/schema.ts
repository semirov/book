/**
 * The schema of ARCHITECTURE.md §8, revision 4 — **version 13** (M6b added `revisions.hseq`
 * and the per-version block chain; M7 adds the operator's `reconciles` mark on a restore,
 * §13.3; BOOK-6 adds `chapters.basis`, the slot that holds only its basis sentence; BOOK-7
 * adds `front_matter.about_sha256` and the chapter-level premise (`changes.premise`,
 * `steps.premise_change`); BOOK-9 adds the auditor's verdict to a comment, recorded before
 * triage can accept it; BOOK-16 adds the intervention's kind to the comment and the change;
 * BOOK-18 adds `document.status` to the history's vocabulary, in `EVENTS_TABLE_SQL`;
 * BOOK-23 adds `cost_priced` to the three tables that hold a money figure, so «measured»
 * and «placeholder zero» are different data, not the same 0).
 * Text tables are a projection of the manuscript files; the engine tables are the only home
 * of process facts. Every table §8 names exists here, and the retired `obligations` table
 * does not (§23.5, ADR-023).
 */

export const SCHEMA_VERSION = 13;

/**
 * Two standalone table definitions live in `tables.ts` because both the full schema here and
 * an incremental migration need them (§13.3, §6F.3, BOOK-6); they are re-exported so a reader
 * of the schema still finds every table in one place.
 */
import { BLOCK_VERSIONS_TABLE_SQL, CHAPTERS_TABLE_SQL, EVENTS_TABLE_SQL, RECONCILES_TABLE_SQL } from './tables.ts';

export {
  BLOCK_VERSIONS_TABLE_SQL,
  CHAPTERS_COLUMNS,
  CHAPTERS_TABLE_SQL,
  EVENTS_TABLE_SQL,
  RECONCILES_TABLE_SQL,
  chaptersTableSql,
} from './tables.ts';

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
  closed_at   TEXT,
  UNIQUE (cascade_id, seq)
);
CREATE INDEX steps_chapter ON steps(chapter, at);
CREATE INDEX steps_open ON steps(outcome, at);

CREATE TABLE gate_dispatches (                   -- who was handed the gate for this step (§6B.4)
  step_id     TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('editor','consultant')),
  session     TEXT NOT NULL,                     -- the session the verdict must come back from
  dispatched_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (step_id, role)
);`;

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
  'closed_at',
] as const;

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
  intent       TEXT NOT NULL,                      -- ≤600 chars, what must become true
  intent_original TEXT,                            -- set when relevance adapted it
  proposed_text TEXT,                              -- reader_edit only, never applied verbatim
  source_comment TEXT REFERENCES comments(id),
  source_session TEXT,                             -- 'fwd' | 'bwd' for continuity
  base_rev     INTEGER NOT NULL,
  base_sha256  TEXT NOT NULL,
  base_blocks  TEXT NOT NULL,                      -- JSON array of block hashes
  scope_hint   TEXT NOT NULL CHECK (scope_hint IN ('phrase','chapter')),
  premise      INTEGER NOT NULL DEFAULT 0,       -- BOOK-7: 1 = a chapter-level premise, not prose (base_rev 0, no anchor)
  status       TEXT NOT NULL CHECK (status IN
                 ('pending','processing','stale','done','void','escalated','failed')),
  relevance    TEXT,                               -- JSON Relevance (§6A.7)
  outcome      TEXT,                               -- applied|adapted|dropped|superseded|budget|edge|oscillation|origin
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

CREATE TABLE gate_verdicts (                     -- provenance of the hidden roles (§6B.3)
  step_id     TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('editor','consultant')),
  verdict     TEXT NOT NULL CHECK (verdict IN ('HOLDS','GAP')),
  findings    TEXT NOT NULL DEFAULT '[]',        -- JSON; admin-only, never public
  cycles      INTEGER NOT NULL DEFAULT 0,
  model       TEXT NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  late        INTEGER NOT NULL DEFAULT 0,        -- 1 = arrived after GATE_TTL_MS
  PRIMARY KEY (step_id, role)
);

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
  status       TEXT NOT NULL,                  -- new|batched|delivered|accepted|applied|superseded|rejected|quarantined|expired|hidden
  guard        TEXT,                           -- null|'legal'|'instruction'|'spam'|'dup'
  created_at   TEXT NOT NULL,
  delivered_at TEXT,                           -- when it entered a batch
  decided_at   TEXT,                           -- triage accept/reject
  reason       TEXT,                           -- public one-liner (≤200 chars), Russian
  batch_id     TEXT,
  change_id    TEXT REFERENCES changes(id),    -- the queued change, when accepted
  applied_chapter INTEGER,
  applied_rev  INTEGER,
  -- The auditor's verdict (BOOK-9): one row, written once, before triage. FITS is the
  -- only permission a change has; OFF also refuses the comment in the same act.
  audit_verdict TEXT CHECK (audit_verdict IN ('FITS','OFF')),
  audit_reason  TEXT,                          -- the auditor's plain reason (≤200 chars), never a taxonomy
  audited_at    TEXT,
  audited_by    TEXT,                          -- the operator/session label, ≤64 chars
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
  type       TEXT NOT NULL,                    -- posted|quarantined|queued|delivered|decided|released|hidden|expired
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
  'change_impact',
  'contribution_history',
  'rate_events',
  'meta',
] as const;

/** §6F.1: the log is append-only; a missing trigger means the promise is not kept (F027). */
export const REQUIRED_TRIGGERS = ['events_no_update', 'events_no_delete'] as const;
