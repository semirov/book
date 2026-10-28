/**
 * The ingest's side of the sentence ledger (ADR-044 §3.1) — the one place a chapter file becomes
 * sentences, because `applyChapterFile` is the only function that may publish a chapter revision:
 * the boot scan, the watcher and the engine's `land` all go through it.
 *
 * What this is **not**: a patch. A file change is observed, not applied, so the paragraphs that
 * left the chapter have no edit behind them and the new ones have no author of their own — a
 * `sentence_touches` row here would be invented provenance, and the ledger's whole value is that
 * it does not invent any. Ingest therefore does two things only:
 *
 *   · a block id that is in `before` and not in `after` has its live sentences **closed**
 *     (`erased_at = at`): the rows stay, so history can still answer «what was that sentence»,
 *     and no anchor is served from them any more;
 *   · every `after` block is segmented by the shared segmenter, idempotently (the store skips a
 *     block that already has live rows). Ids are content-derived, so a paragraph that comes back
 *     unchanged is the same block id and keeps its sentences; one that comes back after having
 *     been closed is a new life and gets fresh ids — the closed rows are history, not a cache.
 *
 * Both statements run inside the caller's transaction: a publish that fails must leave neither a
 * block nor a sentence behind.
 */

import { chapterLabel } from '@book/shared';

import type { Db } from '../db/db.ts';
import { insertImportedSentences } from './store.ts';

/** What the reconcile did, so the caller can report it without a second query. */
export type ReconcileResult = { closed: number; inserted: number };

/**
 * Close the sentences of the paragraphs the chapter lost, segment the ones it has now.
 *
 * `chapter` is not decoration: block ids carry the chapter (`ch08#aa11bb22`), and a caller that
 * mixed two chapters' lists would close or segment the wrong text. A foreign id refuses the whole
 * publish (it rolls back with the caller's transaction) instead of silently doing half the job.
 */
export function reconcileChapterSentences(
  db: Db,
  input: {
    chapter: number;
    before: ReadonlyArray<{ id: string }>;
    after: ReadonlyArray<{ id: string; text: string }>;
    at: string;
  },
): ReconcileResult {
  const prefix = `ch${chapterLabel(input.chapter)}#`;
  const foreign = [...input.before, ...input.after].find((block) => !block.id.startsWith(prefix));
  if (foreign !== undefined) {
    throw new Error(`sentence reconcile: ${foreign.id} does not belong to chapter ${String(input.chapter)}`);
  }

  const keep = new Set(input.after.map((block) => block.id));
  const close = db.prepare('UPDATE sentences SET erased_at = ? WHERE block_id = ? AND erased_at IS NULL');
  let closed = 0;
  for (const block of input.before) {
    if (keep.has(block.id)) continue;
    closed += close.run(input.at, block.id).changes;
  }

  let inserted = 0;
  for (const block of input.after) {
    inserted += insertImportedSentences(db, { blockId: block.id, text: block.text, at: input.at }).inserted;
  }
  return { closed, inserted };
}
