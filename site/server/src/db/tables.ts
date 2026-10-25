/**
 * Table definitions that are needed in two places: the full schema (`schema.ts`) and the
 * incremental migration that adds them to an existing database (`migrate.ts`).
 *
 * They are declared once, here, so a fresh install and an upgraded install cannot drift
 * apart — the failure mode this file exists to prevent is a column that exists in tests (a
 * fresh install) and not on the server (an upgrade).
 */

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
 * The `steps` table is the one table M3 needs more than §8 sketched: a step exists *before*
 * it is closed (it carries the lease and hangs both gate verdicts off its id), so `outcome`
 * is null while the step is open, and the land/close facts are columns rather than a second
 * table. `migrate.ts` rebuilds a pre-M3 `steps` table in place; the shape is declared once,
 * here, and reused by the repair so the two cannot drift.
 */
