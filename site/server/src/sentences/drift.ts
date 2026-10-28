/**
 * `SEGMENT_DRIFT` — the read-time **check** of stored boundaries (ADR-044 §3.1, §5 step 5).
 *
 * Boundaries were segmented once, at write time, and stored; history holds a foreign key to those
 * rows. A read-time splitter may therefore only ever *check* them: if the segmenter on this build
 * would cut the current text differently from what the table says, the difference is a defect —
 * a rule changed without a version bump, a table written by something other than the segmenter, or
 * a block whose text moved behind the rows' back.
 *
 * What this does about it: **nothing destructive**. It never updates or deletes a sentence and
 * never rewrites the block — re-segmenting on read would silently re-anchor every filing, fact and
 * literal hanging on the affected sentences, which is exactly what the ADR forbids. It records one
 * line in `meta`, once per block id (`INSERT OR IGNORE`, key `sentences.drift:<blockId>`), so the
 * operator report can print the drifted blocks and the surface that caught them can answer with
 * the stored rows it already has. The stored block *identity* is content-derived, so one key per id
 * is one key per block version: a new text is a new id and gets a line of its own.
 */

import { SEGMENTER_VERSION, splitSentences } from '@book/shared';

import type { Db } from '../db/db.ts';
import { sentenceHash } from './hash.ts';
import { listLiveSentences, type SentenceRow } from './store.ts';

/** The place of one sentence, as both sides of the comparison express it. */
export type SentencePlace = { idx: number; start: number; end: number; text_hash: string };

/** What a block reads as: its stored rows, and whether the segmenter still agrees with them. */
export type BlockSentences = { sentences: SentenceRow[]; drift: boolean };

/** The `meta` key a drifted block is logged under — one per block id, so one per block version. */
export function driftKey(blockId: string): string {
  return `sentences.drift:${blockId}`;
}

function places(rows: readonly SentencePlace[]): SentencePlace[] {
  return rows.map((row) => ({ idx: row.idx, start: row.start, end: row.end, text_hash: row.text_hash }));
}

/**
 * Read a block's live sentences and check them against a fresh segmentation of its current text.
 *
 * A block that no longer exists has no text to check: its rows are returned with `drift: false` —
 * the honest answer is «not checked», never «clean» and never a fabricated line.
 */
export function readBlockSentences(
  db: Db,
  blockId: string,
  at: string = new Date().toISOString(),
): BlockSentences {
  const sentences = listLiveSentences(db, blockId);
  const block = db.prepare('SELECT text FROM blocks WHERE id = ?').get(blockId) as
    | { text: string }
    | undefined;
  if (block === undefined) return { sentences, drift: false };

  const current: SentencePlace[] = splitSentences(block.text).map((span, idx) => ({
    idx,
    start: span.start,
    end: span.end,
    text_hash: sentenceHash(span.text),
  }));
  const stored = places(sentences);
  const drift =
    stored.length !== current.length ||
    sentences.some((sentence) => sentence.seg_version !== SEGMENTER_VERSION) ||
    stored.some((place, index) => {
      const expected = current[index];
      return (
        expected === undefined ||
        place.idx !== expected.idx ||
        place.start !== expected.start ||
        place.end !== expected.end ||
        place.text_hash !== expected.text_hash
      );
    });

  if (drift) {
    db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run(
      driftKey(blockId),
      JSON.stringify({ at, stored, current }),
    );
  }
  return { sentences, drift };
}
