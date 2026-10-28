/**
 * The one place a `block_deltas` row appears (ADR-041 §2.2, BOOK-187 AC 10).
 *
 * `history/blocks.ts` calls this from `insertVersion` — the single function that creates a block
 * version — so the delta and the version are written by the same statement sequence, inside the
 * caller's transaction: a version without its delta is impossible to commit halfway.
 *
 * Three rules decide the row, and each one exists to keep the row honest:
 *
 *   · **the previous text comes from the ledger**, `replayBlock` over the block's own checkpoint
 *     and spans (and, since this step, over the deltas of the versions that carry no spans). It is
 *     never read from a file and never taken on trust: a version whose predecessor cannot be
 *     replayed gets **no row** and one line naming the code, because an invented op list would
 *     make every later blame a guess;
 *   · **`source` says who aligned the two texts**: `patch` when the caller supplied the exact span
 *     of this version (the applier knows where the change was), `diff` when this module computed
 *     the alignment (an ingest rewrite has no per-character correspondence to declare);
 *   · **the op list is verified before it is stored**: `applyDelta(prev, ops)` must reproduce the
 *     version's text, and the op lengths must be the two texts' code-point lengths. A disagreement
 *     is a ledger that no longer describes the prose, and it is recorded as such, not stored.
 *
 * Idempotent by primary key: `(block_uid, to_ver)` is inserted with `ON CONFLICT DO NOTHING`, so a
 * replayed import cannot grow the table or change what an earlier write decided.
 */

import type { Db } from '../db/db.ts';
import { replayBlock } from '../ledger/replay.ts';
import { cpLength, parseSpans } from '../ledger/spans.ts';
import { applyDelta, deltaLengths, diffOps, opsOfSpan, serializeDeltaOps, spanFits, type DeltaOp } from './delta.ts';

/** The code a skipped delta is reported with: one line, greppable, and asserted by a test. */
export const DELTA_DANGLING_CODE = 'DELTA_DANGLING';

export type DeltaSkipReason = 'not-changed' | 'no-predecessor' | 'delta-mismatch';

export type DeltaWriteInput = {
  db: Db;
  chapter: number;
  blockUid: string;
  ver: number;
  prevVer: number | null;
  /** The version's operation: only a `revised` version has a change to describe. */
  op: 'introduced' | 'revised' | 'erased';
  /** The version's whole text — what the writer already knows, never a re-read. */
  nextText: string;
  /** The JSON span list stored on the version; one span is the exact patch of this version. */
  spans: string | null | undefined;
  rev: number;
  hseq: number;
  at: string;
  changeId: string | null;
  stepId: string | null;
};

export type DeltaWriteResult =
  | { written: true; source: 'patch' | 'diff'; ops: DeltaOp[] }
  | { written: false; reason: DeltaSkipReason };

/** The paragraph's text one version earlier, or null when the ledger cannot replay it. */
function predecessorText(db: Db, blockUid: string, prevVer: number | null): string | null {
  if (prevVer === null || prevVer < 1) return null;
  return replayBlock(db, { blockUid, ver: prevVer })?.text ?? null;
}

export function recordBlockDelta(input: DeltaWriteInput): DeltaWriteResult {
  // An introduced block was born at this version (there is nothing before it to describe), and an
  // erased one keeps the text it already had — the block left the chapter, its words did not move.
  if (input.op !== 'revised') return { written: false, reason: 'not-changed' };

  const prevText = predecessorText(input.db, input.blockUid, input.prevVer);
  if (prevText === null) return dangling(input, 'no-predecessor');
  if (prevText === input.nextText) return { written: false, reason: 'not-changed' };

  const spans = parseSpans(input.spans);
  const exact = spans.length === 1 ? spans[0] : undefined;
  // A real patch: the caller named the replaced stretch, so the op list is that span written out.
  const source: 'patch' | 'diff' = exact !== undefined ? 'patch' : 'diff';
  if (exact !== undefined && !spanFits(prevText, exact)) {
    // The span does not describe the text the ledger replayed: it belongs to another text, so the
    // op list derived from it would be a description of a change that never happened here.
    return dangling(input, 'delta-mismatch');
  }
  const ops = exact !== undefined ? opsOfSpan(prevText, exact) : diffOps(prevText, input.nextText);

  if (applyDelta(prevText, ops) !== input.nextText) return dangling(input, 'delta-mismatch');
  const lengths = deltaLengths(ops);
  if (lengths.oldLen !== cpLength(prevText) || lengths.newLen !== cpLength(input.nextText)) {
    return dangling(input, 'delta-mismatch');
  }

  input.db
    .prepare(
      `INSERT INTO block_deltas
         (block_uid, from_ver, to_ver, chapter, rev, ops, old_len, new_len, source, change_id, step_id, hseq, at)
       VALUES
         (@blockUid, @fromVer, @toVer, @chapter, @rev, @ops, @oldLen, @newLen, @source, @changeId, @stepId, @hseq, @at)
       ON CONFLICT(block_uid, to_ver) DO NOTHING`,
    )
    .run({
      blockUid: input.blockUid,
      fromVer: input.prevVer ?? 0,
      toVer: input.ver,
      chapter: input.chapter,
      rev: input.rev,
      ops: serializeDeltaOps(ops),
      oldLen: lengths.oldLen,
      newLen: lengths.newLen,
      source,
      changeId: input.changeId,
      stepId: input.stepId,
      hseq: input.hseq,
      at: input.at,
    });
  return { written: true, source, ops };
}

function dangling(input: DeltaWriteInput, reason: DeltaSkipReason): DeltaWriteResult {
  // The version stays (the prose is what it is); only its op list is missing, and the line names
  // the exact block so a later backfill can find the gap instead of guessing at it.
  console.warn(
    `${DELTA_DANGLING_CODE} ${reason}: block ${input.blockUid} v${String(input.ver)} (chapter ${String(input.chapter)}, rev ${String(input.rev)})`,
  );
  return { written: false, reason };
}
