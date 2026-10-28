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
  UNIQUE (cascade_id, seq)
);
CREATE INDEX steps_chapter ON steps(chapter, at);
CREATE INDEX steps_open ON steps(outcome, at);
`;

 * `comments` — one reader's filing, and everything the site knows about how it was read
 * (§8, §12.2). BOOK-174 adds the disposition chain: `disposition`, `lock`, `carrier_kind`
 * and `quote_kept` (the verbatim fragment behind a document, or the refusing stamp), beside
 * ADR-044's `sentence_id` that anchors the reading. Null in all four is the honest answer for
 * a row written before v27 — it was never read this way.
 */
export const COMMENTS_TABLE_SQL = `CREATE TABLE comments (
  id           TEXT PRIMARY KEY,               -- 'cmt_01JB7…' (ULID, sortable)
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
  -- before v24 — it was never read this way, and nothing invents a reading for it.
  disposition   TEXT CHECK (disposition IN ('as_said','through_paper','refused_in_world','inadmissible','escalated')),
  lock          TEXT CHECK (lock IN ('rights','harm','frame','finale')),
  carrier_kind  TEXT CHECK (carrier_kind IN ('document','speech','registry_discrepancy','numbered_object','unheeded_joke','obligatory_joke')),
  quote_kept    TEXT,                          -- the verbatim fragment, or the refusing stamp
  idem_key     TEXT UNIQUE
);
`;

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
