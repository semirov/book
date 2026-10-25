/**
 * The schema of ARCHITECTURE.md §8, verbatim in spirit: text tables are a projection of
 * the manuscript files; the engine tables are the only home of process facts.
 *
 * M0 creates the whole schema — including queue, cascade, obligation and comment tables —
 * so M3–M5 add code, not migrations. `lane` holds exactly one row: the FIFO mutex.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE chapters (
  n           INTEGER PRIMARY KEY CHECK (n BETWEEN 1 AND 67),
  rev         INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT    NOT NULL,
  chars       INTEGER NOT NULL,
  block_count INTEGER NOT NULL,
  written_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  parse_error TEXT
);

CREATE TABLE blocks (
  id        TEXT PRIMARY KEY,
  chapter   INTEGER NOT NULL REFERENCES chapters(n) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  first_rev INTEGER NOT NULL,
  last_rev  INTEGER NOT NULL
);
CREATE INDEX blocks_chapter_idx ON blocks(chapter, idx);

CREATE TABLE changes (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('reader_edit','accepted_comment','continuity','operator')),
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  anchor       TEXT,
  intent       TEXT NOT NULL,
  intent_original TEXT,
  proposed_text TEXT,
  source_comment TEXT,
  source_session TEXT,
  base_rev     INTEGER NOT NULL,
  base_sha256  TEXT NOT NULL,
  base_blocks  TEXT NOT NULL,
  scope_hint   TEXT NOT NULL CHECK (scope_hint IN ('block','chapter','seam')),
  status       TEXT NOT NULL CHECK (status IN
                 ('pending','processing','stale','done','void','escalated','failed')),
  relevance    TEXT,
  outcome      TEXT,
  reason       TEXT,
  cascade_id   TEXT,
  tokens       INTEGER NOT NULL DEFAULT 0,
  enqueued_at  TEXT NOT NULL,
  started_at   TEXT, finished_at TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX changes_lane ON changes(status, seq);
CREATE INDEX changes_chapter ON changes(chapter, seq);

CREATE TABLE cascades (
  id          TEXT PRIMARY KEY,
  change_id   TEXT NOT NULL REFERENCES changes(id),
  status      TEXT NOT NULL CHECK (status IN ('open','closed','escalated','aborted')),
  outcome     TEXT,
  wave        INTEGER NOT NULL DEFAULT 0,
  depth_fwd   INTEGER NOT NULL DEFAULT 0,
  depth_bwd   INTEGER NOT NULL DEFAULT 0,
  steps       INTEGER NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  budget      TEXT NOT NULL,
  opened_at   TEXT NOT NULL, closed_at TEXT
);

CREATE TABLE revisions (
  chapter   INTEGER NOT NULL REFERENCES chapters(n) ON DELETE CASCADE,
  rev       INTEGER NOT NULL,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('create','rewrite','edit','reweiter','restore')),
  cause_kind TEXT NOT NULL CHECK (cause_kind IN ('draft','cascade','local','canon','operator','restore')),
  change_id TEXT REFERENCES changes(id),
  cascade_id TEXT REFERENCES cascades(id),
  stage_seq INTEGER,
  added     INTEGER NOT NULL,
  changed   INTEGER NOT NULL,
  removed   INTEGER NOT NULL,
  snapshot  TEXT NOT NULL,
  attributed INTEGER NOT NULL DEFAULT 1,
  log_note  TEXT,
  PRIMARY KEY (chapter, rev)
);

CREATE TABLE change_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id  TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  meta       TEXT
);

CREATE TABLE cascade_stages (
  cascade_id  TEXT NOT NULL REFERENCES cascades(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  wave        INTEGER NOT NULL,
  lane        TEXT NOT NULL CHECK (lane IN ('forward','backward')),
  chapter     INTEGER NOT NULL,
  boundary    INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('evaluate','rewrite','absorbed','escalated','interrupted')),
  verdict     TEXT,
  rev_before  INTEGER, rev_after INTEGER,
  obligations_in  TEXT,
  obligations_out TEXT,
  invalidated TEXT,
  blocks_touched INTEGER, chars_delta INTEGER,
  lease_id    TEXT, session TEXT,
  at          TEXT NOT NULL, ms INTEGER, note TEXT,
  PRIMARY KEY (cascade_id, seq)
);

CREATE TABLE obligations (
  id           TEXT PRIMARY KEY,
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind         TEXT NOT NULL CHECK (kind IN ('fact','existence','sequence','knowledge','lexical')),
  stmt         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('satisfied','open','unexplained','stale','pending')),
  cause_kind   TEXT NOT NULL CHECK (cause_kind IN ('chapter','canon','none')),
  cause_chapter INTEGER CHECK (cause_chapter BETWEEN 1 AND 67),
  cause_ref    TEXT,
  check_kind   TEXT NOT NULL CHECK (check_kind IN ('auto','judge')),
  test         TEXT,
  created_at   TEXT NOT NULL, updated_at TEXT NOT NULL,
  source       TEXT NOT NULL
);
CREATE INDEX obligations_chapter ON obligations(chapter, state);
CREATE INDEX obligations_cause  ON obligations(cause_kind, cause_chapter);

CREATE TABLE leases (
  id           TEXT PRIMARY KEY,
  change_id    TEXT REFERENCES changes(id),
  cascade_id   TEXT REFERENCES cascades(id),
  lane         TEXT CHECK (lane IN ('forward','backward')),
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  kind         TEXT NOT NULL CHECK (kind IN ('draft','rewrite','evaluate','sweep','seam')),
  session      TEXT NOT NULL,
  expected_rev INTEGER NOT NULL,
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT,
  release_reason TEXT
);
CREATE UNIQUE INDEX leases_live_chapter ON leases(chapter) WHERE released_at IS NULL;

CREATE TABLE lane (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  holder   TEXT,
  heartbeat_at TEXT
);
INSERT INTO lane (id, holder, heartbeat_at) VALUES (1, NULL, NULL);

CREATE TABLE comments (
  id           TEXT PRIMARY KEY,
  chapter      INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  block_id     TEXT,
  block_idx    INTEGER,
  quote        TEXT,
  prefix       TEXT,
  suffix       TEXT,
  author       TEXT NOT NULL,
  body         TEXT NOT NULL,
  body_sha     TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  status       TEXT NOT NULL,
  guard        TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  decided_at   TEXT,
  reason       TEXT,
  batch_id     TEXT,
  change_id    TEXT REFERENCES changes(id),
  applied_chapter INTEGER,
  applied_rev  INTEGER,
  idem_key     TEXT UNIQUE
);
CREATE INDEX comments_chapter ON comments(chapter, created_at);
CREATE INDEX comments_status  ON comments(status, created_at);
CREATE INDEX comments_ip      ON comments(ip_hash, created_at);

CREATE TABLE comment_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  meta       TEXT
);

CREATE TABLE feedback_batches (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  closed_at   TEXT,
  chapter     INTEGER,
  loop        TEXT,
  count       INTEGER NOT NULL,
  path        TEXT NOT NULL,
  comment_ids TEXT NOT NULL
);

CREATE TABLE rate_events ( key TEXT NOT NULL, ts INTEGER NOT NULL );
CREATE INDEX rate_events_key_ts ON rate_events(key, ts);

CREATE TABLE meta ( k TEXT PRIMARY KEY, v TEXT NOT NULL );
`;

/** Tables that must exist after migration — used by the boot probe. */
export const REQUIRED_TABLES = [
  'chapters',
  'blocks',
  'revisions',
  'changes',
  'change_events',
  'cascades',
  'cascade_stages',
  'obligations',
  'leases',
  'lane',
  'comments',
  'comment_events',
  'feedback_batches',
  'rate_events',
  'meta',
] as const;
