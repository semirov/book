/**
 * Sentence storage (ADR-044 §2, schema v25) — rows only; the decisions about *which* sentence a
 * filing, a fact or a literal hangs on live in `anchor.ts` and in the surfaces that call it.
 *
 * The one-shot segmenter of the migration writes the rows that predate the sentence table
 * (`insertImportedSentences`); from stage 2 on, `sentences/transform.ts` is the writer of every
 * later row, inside the applier's transaction. That is why this module exposes the read side as
 * well: a consumer that needs a sentence by place, by id, or the live list of a block must never
 * write its own SQL, or two callers will eventually disagree about what «live» means.
 */

import { SEGMENTER_VERSION, splitSentences } from '@book/shared';

import type { Db } from '../db/db.ts';
import { ulid } from '../util/ulid.ts';
import { sentenceHash } from './hash.ts';

/** One row of `sentences`, as stored. `erased_at` null = live. */
export type SentenceRow = {
  id: string;
  block_id: string;
  idx: number;
  start: number;
  end: number;
  text_hash: string;
  seg_version: number;
  split_from: string | null;
  merged_into: string | null;
  erased_at: string | null;
};

/** The vocabulary of `sentence_touches.kind` — the three outcomes of a boundary edit plus place. */
export type SentenceTouchKind = 'born' | 'text' | 'moved' | 'split' | 'merge' | 'erase';

const COLUMNS = 'id, block_id, idx, start, end, text_hash, seg_version, split_from, merged_into, erased_at';

/** The live sentences of a block, in display order. */
export function listLiveSentences(db: Db, blockId: string): SentenceRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM sentences WHERE block_id = ? AND erased_at IS NULL ORDER BY idx`)
    .all(blockId) as SentenceRow[];
}

/** One live sentence by id, or null — a closed row is history, not an anchor. */
export function findLiveSentence(db: Db, sentenceId: string): SentenceRow | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM sentences WHERE id = ? AND erased_at IS NULL`)
    .get(sentenceId) as SentenceRow | undefined;
  return row ?? null;
}

/** Does the block have any sentence row at all, live or closed? The migration's idempotency test. */
export function blockHasSentences(db: Db, blockId: string): boolean {
  const row = db.prepare('SELECT 1 AS found FROM sentences WHERE block_id = ? LIMIT 1').get(blockId);
  return row !== undefined;
}

/** What the one-shot segmenter wrote, so a caller can report a count without a second query. */
export type ImportedSentences = { rows: SentenceRow[]; inserted: number };

/**
 * Segment one block's text and store the rows — the migration's one-shot import, and the only
 * place a sentence is ever born without a patch (ADR-044 §5 step 2).
 *
 * Idempotent by block: a block that already has **live** rows is left untouched and those rows are
 * returned with `inserted: 0`. A block with only closed rows is a paragraph that came back after it
 * left the chapter — a new life, so it is segmented afresh (the closed rows stay as history).
 *
 * The spans come from the shared segmenter, so the ingest and the client cannot disagree about
 * where a sentence ends; `seg_version` records which rule set cut them, and `text_hash` is the
 * content attribute a later re-attachment compares.
 *
 * `at` is accepted for the call site's symmetry with `touchSentence` and is deliberately not
 * stored: the sentence rows carry no timestamp of their own, and the migration writes no touch —
 * an imported sentence has no known edit, and inventing one would be worse than saying so (S8).
 */
export function insertImportedSentences(
  db: Db,
  input: { blockId: string; text: string; at?: string },
): ImportedSentences {
  const existing = listLiveSentences(db, input.blockId);
  if (existing.length > 0) return { rows: existing, inserted: 0 };

  const insert = db.prepare(
    `INSERT INTO sentences (id, block_id, idx, start, end, text_hash, seg_version, split_from, merged_into, erased_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  );
  const rows: SentenceRow[] = [];
  const write = db.transaction(() => {
    splitSentences(input.text).forEach((span, idx) => {
      const row: SentenceRow = {
        id: `snt_${ulid()}`,
        block_id: input.blockId,
        idx,
        start: span.start,
        end: span.end,
        text_hash: sentenceHash(span.text),
        seg_version: SEGMENTER_VERSION,
        split_from: null,
        merged_into: null,
        erased_at: null,
      };
      insert.run(row.id, row.block_id, row.idx, row.start, row.end, row.text_hash, row.seg_version);
      rows.push(row);
    });
  });
  write();
  return { rows, inserted: rows.length };
}

/** One provenance row: this sentence was touched this way, by this change, at this moment. */
export function touchSentence(
  db: Db,
  input: { sentenceId: string; changeId: string | null; kind: SentenceTouchKind; at: string },
): void {
  db.prepare(
    `INSERT INTO sentence_touches (sentence_id, change_id, kind, at) VALUES (?, ?, ?, ?)`,
  ).run(input.sentenceId, input.changeId, input.kind, input.at);
}

/**
 * The live sentence whose span **contains** `[start, end)`, or null. Used by a later stage to
 * place a mention or a literal: a span that starts in one sentence and ends in another belongs to
 * neither, and a caller that guessed the first one would put a fact where the reader did not say
 * it. The interval is code points, `end` exclusive, in the block's current text.
 */
export function resolveSentenceCovering(
  db: Db,
  input: { blockId: string; start: number; end: number },
): SentenceRow | null {
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.end < input.start) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM sentences
        WHERE block_id = ? AND erased_at IS NULL AND start <= ? AND end >= ?
        ORDER BY idx LIMIT 1`,
    )
    .get(input.blockId, input.start, input.end) as SentenceRow | undefined;
  return row ?? null;
}
