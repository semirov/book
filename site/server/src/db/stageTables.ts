/**
 * The writer lane's stage table (`tables.ts`, split at the arch bound).
 *
 * Both the full schema and the incremental migrations build the same `pass_stages`, so its one
 * `CREATE` lives here and is re-exported by `tables.ts`.
 */

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
                  ('queued','read','verdict','drafting','typing','landed','refused','revising','widening')),
  at            TEXT NOT NULL,                       -- ISO-8601 UTC, when the work happened
  actor_process TEXT NOT NULL CHECK (actor_process IN ('engine','writer','site','auditor')),
  actor_model   TEXT,                                -- null when no model ran
  change_id     TEXT,                                -- the change this pass carries, when any
  summary       TEXT NOT NULL,                       -- one factual line, ≤200 chars
  span          TEXT,                                -- JSON StageSpan[], null off 'landed'
  tokens_in     INTEGER,                             -- one call's on 'drafting', the pass's on 'landed'
  tokens_out    INTEGER,
  cost_usd      REAL,                                -- null off 'landed'
  -- BOOK-DOC-84 §10.8: the ladder, stored as facts and never parsed out of a summary.
  attempt       INTEGER,                             -- 1..6, the store counts the step's leases
  max_attempts  INTEGER,                             -- 5, or 6 on the desperate attempt
  widened       TEXT,                                -- the widening code ('wider-edit', …), null before the third failure
  desperate     INTEGER NOT NULL DEFAULT 0,           -- 1 = the sixth, deterministic attempt
  gate          TEXT CHECK (gate IN ('editor','consultant','rights')),
  round         INTEGER,                             -- the gate round inside the pass, 1..5
  iteration     INTEGER,                             -- steps.cycle at the pass's start (0..4)
  verdict       TEXT CHECK (verdict IN ('HOLDS','GAP','CLEAR','REFUSED')),
  UNIQUE (pass_id, stage_seq)
);
CREATE INDEX pass_stages_chapter_seq ON pass_stages(chapter, seq);`;