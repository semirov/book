/**
 * `pass_transcripts` — the pass's receipt as rows (BOOK-187 AC7, ADR-043 §1 «transcripts — DB»).
 *
 * What a pass asked and what answered used to be a JSON file per pass (`writer/transcripts/`,
 * 20 files and 7 MB of unredacted prompt and answer bodies). It is now one row per model call,
 * and the row is **facts only**: the prompt's sha and its sections' shas and lengths, the answer's
 * sha and length, a verdict code. The redaction itself happens in the writer (`writer/transcript.ts`)
 * — this module stores what it is handed and never reads the bodies back.
 *
 * Two invariants live here rather than in the route:
 *  · a repeated `(pass_id, seq)` stores nothing new (`ON CONFLICT DO NOTHING`), so a retried call
 *    after a timeout cannot double a pass's receipt;
 *  · retention runs **in the same transaction** as the insert: rows older than
 *    `TRANSCRIPT_RETENTION_DAYS` go, whatever pass they belong to.
 */

import type { Db } from '../db.ts';
import { toIso } from '../../util/time.ts';

/** AC7: one pass is at most this many model calls the writer reports in one go. */
export const TRANSCRIPT_ROWS_MAX = 16;
/** AC7: one row's payload is at most 4 KB — a receipt, not a second copy of the canon. */
export const TRANSCRIPT_ROW_BYTES_MAX = 4 * 1024;
/** AC7's default retention; `config.ts` reads `TRANSCRIPT_RETENTION_DAYS` over it. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 30;

/** The transcript's own vocabulary: the writer's call kinds (`writer/transcript.ts`). */
export const TRANSCRIPT_ROLES = [
  'draft',
  'repair',
  'continue',
  'gate:editor',
  'gate:consultant',
  'gate:rights',
] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export type TranscriptRowInput = {
  /** 1..n within the pass. */
  seq: number;
  /** Epoch ms of the call; stored as an ISO moment so a query can prune on it. */
  at: number;
  role: TranscriptRole;
  tokensIn: number;
  tokensOut: number;
  /** The prompt bundle the call ran under (ADR-043 G3); null when the image carried no stamp. */
  promptBundle: string | null;
  /** The redacted facts, as JSON — produced by the writer, stored verbatim. */
  content: string;
};

export type TranscriptInput = {
  passId: string;
  rows: readonly TranscriptRowInput[];
  /** Days a row is kept; the route passes the configured value. */
  retentionDays: number;
  now?: number;
};

export type TranscriptResult = { stored: number; pruned: number };

/**
 * Store the rows and prune the old ones, one `IMMEDIATE` transaction: the sweep and the insert are
 * one fact about the table, and a second connection must not read between them. `stored` counts
 * rows that were actually new; a repeated seq inserts nothing and is not a failure.
 */
export function insertTranscripts(db: Db, input: TranscriptInput): TranscriptResult {
  const at = input.now ?? Date.now();
  const cutoff = toIso(at - input.retentionDays * 24 * 60 * 60 * 1000);
  const write = db.transaction((): TranscriptResult => {
    const insert = db.prepare(
      `INSERT INTO pass_transcripts (pass_id, seq, at, role, content_redacted, tokens_in, tokens_out, prompt_bundle)
       VALUES (@passId, @seq, @at, @role, @content, @tokensIn, @tokensOut, @promptBundle)
       ON CONFLICT(pass_id, seq) DO NOTHING`,
    );
    let stored = 0;
    for (const row of input.rows) {
      const result = insert.run({
        passId: input.passId,
        seq: row.seq,
        at: toIso(row.at),
        role: row.role,
        content: row.content,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        promptBundle: row.promptBundle,
      });
      stored += Number(result.changes);
    }
    const pruned = Number(db.prepare('DELETE FROM pass_transcripts WHERE at < ?').run(cutoff).changes);
    return { stored, pruned };
  });
  return write.immediate();
}
