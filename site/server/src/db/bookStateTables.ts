/**
 * BOOK-187 / ADR-043 G6, ADR-041 §2.2 — **v28: the book's own state leaves the filesystem.**
 *
 * They live here rather than in `tables.ts` for the same reason the ledger's, the sentence's and the
 * push tables do: two builders (`schema.ts` for a fresh install, `migrateV28.ts` for an upgrade)
 * read one constant, and neither file may grow past the size gate.
 *
 * Four additive tables, each one replacing a file that used to be the only home of a fact:
 *
 *   · `book_frame` — the two canon sentence rows, seeded by the migration from the constants the
 *     image compiles in (`shared/src/book.ts`). The letters of the canon are content, so they live
 *     in the volume; the image keeps the independent witness the three-source check compares
 *     against. A fresh database therefore serves ch01/ch42 before it has any prose;
 *   · `writer_state` — the lane's one row: the UTC day, how many passes it has spent and when it
 *     may run again. It replaces `writer/state.json`;
 *   · `pass_transcripts` — one row per stage of a pass, redacted at write: section ids and shas,
 *     an answer's sha and length, a verdict code — never a prompt body, an endpoint, a session or
 *     a reader's words. It replaces `writer/transcripts/*.json`;
 *   · `block_deltas` — ADR-041 §2.2 verbatim: one retain/insert/delete op list per changed block
 *     version, the row that makes a version replayable, blame a walk and two revisions diffable.
 *     Stage 2 of the text moves into rows writes it; the table ships now so its shape is fixed
 *     before the writer depends on it.
 *
 * Every statement is `IF NOT EXISTS`, so a fresh install (which builds them from `SCHEMA_SQL`),
 * an upgraded v27 install (which builds them here) and a second run of the step agree.
 */
export const V28_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS book_frame (        -- the canon sentences, seeded by the image (G6)
  chapter   INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  position  TEXT NOT NULL CHECK (position IN ('first','last')),
  text      TEXT NOT NULL,                     -- the sentence as the image compiles it
  sha256    TEXT NOT NULL,                     -- sha256(text), so the witness is comparable alone
  seeded_at TEXT NOT NULL,                     -- the migration moment that wrote the row
  PRIMARY KEY (chapter, position)
);

CREATE TABLE IF NOT EXISTS writer_state (      -- the lane's counters, once writer/state.json
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  day          TEXT NOT NULL,                  -- UTC yyyy-mm-dd of the counter
  passes       INTEGER NOT NULL DEFAULT 0,
  last_pass_at TEXT,
  pause_until  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pass_transcripts (  -- one row per stage of a pass, redacted at write
  pass_id   TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  at        TEXT NOT NULL,
  role      TEXT NOT NULL,                     -- draft|repair|continue|gate:editor|gate:consultant|gate:rights
  content_redacted TEXT NOT NULL,              -- JSON facts only: section ids+shas, answer sha+len, verdict/failure code
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  prompt_bundle TEXT,                          -- the bundle sha the pass ran under (ADR-043 G3)
  PRIMARY KEY (pass_id, seq)
);
CREATE INDEX IF NOT EXISTS pass_transcripts_at ON pass_transcripts(at);

CREATE TABLE IF NOT EXISTS block_deltas (      -- ADR-041 §2.2: the change itself, per block version
  block_uid TEXT NOT NULL,
  from_ver  INTEGER NOT NULL,
  to_ver    INTEGER NOT NULL,
  chapter   INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  rev       INTEGER NOT NULL,
  ops       TEXT NOT NULL,                     -- JSON: [["retain",812],["insert",12,"Свет погас."]]
  old_len   INTEGER NOT NULL,                  -- code points
  new_len   INTEGER NOT NULL,
  source    TEXT NOT NULL CHECK (source IN ('patch','diff')),
  change_id TEXT, step_id TEXT, hseq INTEGER NOT NULL,
  at        TEXT NOT NULL,
  PRIMARY KEY (block_uid, to_ver)
);
CREATE INDEX IF NOT EXISTS block_deltas_rev  ON block_deltas(chapter, rev);
CREATE INDEX IF NOT EXISTS block_deltas_hseq ON block_deltas(hseq);
`;

/** The four tables the boot probe must find after v28 — spread into `REQUIRED_TABLES`. */
export const V28_REQUIRED_TABLES = ['book_frame', 'writer_state', 'pass_transcripts', 'block_deltas'] as const;
