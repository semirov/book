/**
 * Operator restore (§6F.1, §13.3, §18): a correction is a *new* fact, never a rewrite.
 *
 * The site never writes the manuscript (arch rule 3), so a restore is three steps: the
 * operator puts a snapshot back on disk (`bin/restore.mjs`), the ingest observes an
 * unattributed write, recognises the text as an earlier revision and publishes
 * `chapter.restored` with `attributed:false` — and then the operator's `reconcile` runs the
 * gates and records **whose act this was and why** with `operator.restore`. Restoring
 * therefore leaves the old rows untouched, which is the only way "any moment" keeps meaning
 * anything.
 */

import type { Db } from '../db/db.ts';
import { readSnapshot } from '../versions/snapshots.ts';
import { appendEvent, type HistoryKind } from './log.ts';

export type RestoreSource = { text: string; rev: number; at: string; snapshot: string };

/** The text of a past revision, ready for the operator to put back (read-only for the site). */
export function readRestoreSource(db: Db, dataDir: string, chapter: number, rev: number): RestoreSource | null {
  const row = db
    .prepare('SELECT rev, at, snapshot FROM revisions WHERE chapter = ? AND rev = ?')
    .get(chapter, rev) as { rev: number; at: string; snapshot: string } | undefined;
  if (row === undefined) return null;
  const text = readSnapshot(dataDir, row.snapshot);
  if (text === null) return null;
  return { text, rev: row.rev, at: row.at, snapshot: row.snapshot };
}

export type RestoreRecordInput = {
  chapter: number;
  /** The revision the text was taken from. */
  sourceRev: number;
  /** The restore revision the ingest published, when known. */
  newRev?: number | null;
  /** The operator's own words (≤200 chars): why this text stands again. */
  because?: string;
  nowMs?: number;
};

/**
 * Record the operator's mark: one `operator.restore` row. The text fact
 * (`chapter.restored`) is written by the ingest in the same transaction as the revision, so
 * this function must not write it a second time — two rows for one fact would make the log
 * lie about how many times the text changed.
 */
export function recordOperatorRestore(db: Db, input: RestoreRecordInput): { hseq: number } {
  const nowMs = input.nowMs ?? Date.now();
  const because = (input.because ?? '').trim().slice(0, 200);
  const hseq = appendEvent(
    db,
    {
      kind: 'operator.restore' as HistoryKind,
      chapter: input.chapter,
      rev: input.newRev ?? null,
      authorKind: 'operator',
      authorLabel: 'оператор',
      payload: {
        sourceRev: input.sourceRev,
        rev: input.newRev ?? null,
        ...(because.length === 0 ? {} : { because }),
      },
    },
    nowMs,
  );
  return { hseq };
}
