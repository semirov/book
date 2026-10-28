/**
 * The three push tables (BOOK-189) — declared once, here, because the full schema (`schema.ts`)
 * and migration v26 have to build exactly the same objects: a fresh install reads them from
 * `SCHEMA_SQL`, an upgraded install gets them from `migrateV26`, and the failure this file
 * prevents is a table that exists in a test and not on the server. (v26, not 24: 24 belongs to
 * ADR-043, and v25 — the sentence — landed before the push tables did.)
 *
 * Why three tables and not one:
 *
 *   · `push_subscriptions` is a **capability**, one row per device. The endpoint is the address
 *     the push service gave the browser: it is a secret (whoever holds it can post to that
 *     device), so it is never returned, never logged and never put in a payload, and it is
 *     `UNIQUE` because re-subscribing the same device is an update, not a second reader;
 *   · `push_log` is the **claim**: at most one notification per identity and chapter, forever.
 *     The engine is a state machine that can be replayed from its rows; without a claim a
 *     replayed land would announce the same chapter again, and the reader would hear «глава
 *     написана» twice for one chapter;
 *   · `push_outbox` is the **queue**, written in the same transaction as the claim and drained
 *     by the site process, which is the only one allowed to touch the network (ADR-012 keeps
 *     the engine offline). `expires_at` is what stops a site that was down for a day from
 *     delivering yesterday's news, and `next_at`/`attempts` bound the retries.
 *
 * Every statement is `IF NOT EXISTS`: a fresh install, an upgrade and a replayed migration all
 * run this text, and the second run must be a no-op rather than an error.
 */

/** One row per device: the push capability the browser handed us, owned by one reader. */
export const PUSH_SUBSCRIPTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,                 -- 'psh_' + ULID
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,             -- capability: never returned, never logged
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_used_at TEXT
);
`;

/**
 * The claim: at most one notification per reader and chapter, forever. It is written *before*
 * the outbox row, so «duplicate» is a fact of the database rather than a check two writers race.
 */
export const PUSH_LOG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS push_log (
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  chapter     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('landed','decision')),
  at          TEXT NOT NULL,
  PRIMARY KEY (identity_id, chapter)
);
`;

/** The queue the site drains; `UNIQUE (identity_id, chapter)` repeats the claim as a constraint. */
export const PUSH_OUTBOX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS push_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  chapter     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  url         TEXT NOT NULL,
  tag         TEXT NOT NULL,
  at          TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     TEXT NOT NULL,
  UNIQUE (identity_id, chapter)
);
`;

/**
 * The indexes, apart from the tables on purpose: a migration has to be able to run them
 * unconditionally. A table that already exists is not proof its indexes do — a run interrupted
 * between «table» and «index» leaves a database that passes the table probe and answers the
 * claim, the per-identity lookup and the due-row scan with a full scan. `IF NOT EXISTS` makes
 * that repair free on a healthy install.
 */
export const PUSH_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS push_subscriptions_identity ON push_subscriptions(identity_id, created_at);
CREATE INDEX IF NOT EXISTS push_log_identity          ON push_log(identity_id, at);
CREATE INDEX IF NOT EXISTS push_outbox_due            ON push_outbox(next_at);
`;

/** All three tables and their indexes, in the order a fresh install builds them. */
export const PUSH_TABLES_SQL = `${PUSH_SUBSCRIPTIONS_TABLE_SQL}${PUSH_LOG_TABLE_SQL}${PUSH_OUTBOX_TABLE_SQL}${PUSH_INDEXES_SQL}`;

/** What the boot probe must find after migration; one list, read by `schema.ts` and by `probe`. */
export const PUSH_REQUIRED_TABLES = ['push_subscriptions', 'push_log', 'push_outbox'] as const;
