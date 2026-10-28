/**
 * The sentence tables (ADR-044 §2.5, schema v25) — declared once, here, because the full schema
 * (`schema.ts`) and migration v25 have to build exactly the same objects: a fresh install reads
 * them from `SCHEMA_SQL`, an upgraded install gets them from `migrateV25`, and the failure this
 * file prevents is a table that exists in a test and not on the server.
 *
 * A **sentence** is a stored span of a block's text: `start`/`end` are code points into
 * `blocks.text`, `end` exclusive, and `idx` is display order. `id` is assigned, never derived
 * (`snt_` + ULID) — `text_hash` is an attribute used to re-attach and to check, never the key.
 * The rows are segmented once, at write time, by the shared segmenter
 * (`shared/src/sentences.ts`); a read-time split may only ever *check* them (`sentences/drift.ts`).
 *
 * `block_id` carries no foreign key on purpose: blocks are replaced on a rewrite, and a sentence
 * of a paragraph that left the book is still history. `split_from`/`merged_into` do reference
 * `sentences(id)`: a split or a merge of a live row names a row that must exist.
 *
 * `erased_at` is the live/closed mark: null = live, set on a merge (the right half closes into
 * the surviving left id) and on an erase (the row stays with its last span). The partial unique
 * index is what makes «one live sentence per place» a database fact rather than a convention.
 *
 * `sentence_touches` is the provenance ledger: one row per sentence per operation that changed
 * it. The migration fabricates none — an imported sentence has no known edit, and inventing one
 * would be worse than saying so (ADR-044 S8).
 *
 * Every statement is `IF NOT EXISTS`, so a fresh install, an upgrade and a replayed migration
 * all run the same text and a second run is a no-op rather than an error.
 */

export const SENTENCE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sentences (
  id          TEXT PRIMARY KEY,                 -- 'snt_' + ULID
  block_id    TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  start       INTEGER NOT NULL,                 -- code points into blocks.text
  end         INTEGER NOT NULL,                 -- exclusive
  text_hash   TEXT NOT NULL,                    -- blake2b-128 (hex 32) of the normalised sentence
  seg_version INTEGER NOT NULL,
  split_from  TEXT REFERENCES sentences(id),
  merged_into TEXT REFERENCES sentences(id),
  erased_at   TEXT,                             -- null = live; set on merge and erase
  CHECK (end > start)
);
CREATE UNIQUE INDEX IF NOT EXISTS sentences_live_place ON sentences(block_id, idx) WHERE erased_at IS NULL;
CREATE INDEX IF NOT EXISTS sentences_block ON sentences(block_id, idx);

CREATE TABLE IF NOT EXISTS sentence_touches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sentence_id TEXT NOT NULL REFERENCES sentences(id),
  change_id   TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('born','text','moved','split','merge','erase')),
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sentence_touches_sentence ON sentence_touches(sentence_id, at);
CREATE INDEX IF NOT EXISTS sentence_touches_change   ON sentence_touches(change_id, at);
`;

/** The sentence tables the boot probe insists on: a missing one is a schema that lies. */
export const SENTENCE_REQUIRED_TABLES = ['sentences', 'sentence_touches'] as const;
