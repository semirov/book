/**
 * Replaying a block version (ADR-043 D5, BOOK-176): the change span's before/after, without a
 * second copy of the book.
 *
 * A version stores its full text only on a **checkpoint** (`ver === 1 || ver % 8 === 0`); every
 * other version stores its spans and nothing else. So the text of version N is: the nearest
 * checkpoint at or before N, then each later version's spans applied forwards, in version order.
 *
 * The replay is exact and it is checked: a span whose `removed` does not sit at its offsets throws
 * rather than producing a plausible text. Under a correct ledger it never throws; if it does, the
 * ledger and the prose have already disagreed, and that must be loud.
 *
 * A version that stores **neither** a delta nor a checkpoint is an *unknown* step, and the honest
 * answer is `null`: the ingest writes exactly that shape today (`spans='[]'`, `text=''` on a
 * non-checkpoint version), and skipping it would return the previous text as if nothing had
 * happened — the one lie this function must never tell.
 */

import type { Db } from '../db/db.ts';
import { applyForward, parseSpans } from './spans.ts';

export type ReplayResult = { text: string; checkpointVer: number };

type CheckpointRow = { ver: number; text: string };
type VersionRow = { ver: number; spans: string | null; text: string };

/**
 * The block's text at `ver`, replayed from the nearest checkpoint. `null` when the block has no
 * checkpoint at or before `ver`, or when a version in between records neither a delta nor a
 * checkpoint: a ledger that cannot answer gives the honest answer, never the previous text.
 */
export function replayBlock(db: Db, input: { blockUid: string; ver: number }): ReplayResult | null {
  const checkpoint = db
    .prepare(
      `SELECT ver, text FROM block_versions
        WHERE block_uid = ? AND ver <= ? AND text != ''
        ORDER BY ver DESC LIMIT 1`,
    )
    .get(input.blockUid, input.ver) as CheckpointRow | undefined;
  if (checkpoint === undefined) return null;
  const later = db
    .prepare(
      `SELECT ver, spans, text FROM block_versions
        WHERE block_uid = ? AND ver > ? AND ver <= ?
        ORDER BY ver`,
    )
    .all(input.blockUid, checkpoint.ver, input.ver) as VersionRow[];
  let text = checkpoint.text;
  for (const row of later) {
    const spans = parseSpans(row.spans);
    // No delta and no checkpoint: the step that produced this version is not recorded, so the
    // text after it is unknown. A checkpoint is the only other way to know it, and it is empty.
    if (spans.length === 0 && row.text === '') return null;
    text = applyForward(text, spans);
  }
  return { text, checkpointVer: checkpoint.ver };
}
