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
 *
 * BOOK-187 — the ledger's own delta closes that gap. `block_deltas` carries the op list of a
 * version whose spans the ingest never wrote (a whole-body rewrite has no per-character spans to
 * record, but it does have a computed diff), so a step is unknown only when **neither** record
 * exists. The checkpoint stays the start; each later step is its spans or its ops.
 */

import type { Db } from '../db/db.ts';
import { applyDelta, parseDeltaOps } from '../history/delta.ts';
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
  const deltaOf = db.prepare('SELECT ops FROM block_deltas WHERE block_uid = ? AND to_ver = ?');
  let text = checkpoint.text;
  for (const row of later) {
    const spans = parseSpans(row.spans);
    if (spans.length === 0 && row.text === '') {
      // No span and no checkpoint: the step's own op list is the only other record of it. When
      // the ingest wrote one (BOOK-187), replay it; when it did not, the step is unknown.
      const delta = deltaOf.get(input.blockUid, row.ver) as { ops: string } | undefined;
      if (delta === undefined) return null;
      text = applyDelta(text, parseDeltaOps(delta.ops));
      continue;
    }
    text = applyForward(text, spans);
  }
  return { text, checkpointVer: checkpoint.ver };
}
