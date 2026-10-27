/**
 * The one backfill Gate B needs (BOOK-61 review B3).
 *
 * A row posted before this deploy carries no rights verdict, and the gates behind it read a
 * `NULL` as "no answer", so every in-flight filing would be stuck forever — the reader's note
 * would wait on a gate nobody ever asked. `migrate` therefore asks the same deterministic
 * question of every undecided row once: the scan, its fixed sentence, its flag.
 *
 * It is **idempotent and cheap**: a `meta` mark makes it a one-time pass per schema version, and
 * the query itself only ever sees rows that are still `NULL` and still open (`new`/`batched`/
 * `delivered` — no gate has spoken to the reader yet, which is also B1's status rule). A row the
 * scan flags keeps its `NULL` verdict by design; it is not re-scanned on every boot.
 */

import type { Db } from '../db/db.ts';
import { getMeta, setMeta } from '../db/repo/meta.ts';
import { scanFiling } from './apply.ts';
import { flagRights, recordRights } from './record.ts';

const MARK = 'rights.backfill';
const VERSION = 'v15';

export type RightsBackfillReport = {
  /** False when a previous run already did the work: the pass is one-time per version. */
  ran: boolean;
  scanned: number;
  clear: number;
  refused: number;
  flag: number;
};

type UndecidedRow = {
  id: string;
  chapter: number;
  body: string;
  proposed_text: string | null;
  quote: string | null;
  status: string;
};

/** The label the pass writes with its answers: a backfilled verdict is never anonymous. */
const BY = 'backfill';

export function backfillRights(db: Db, at: string): RightsBackfillReport {
  const report: RightsBackfillReport = { ran: false, scanned: 0, clear: 0, refused: 0, flag: 0 };
  if (getMeta(db, MARK) === VERSION) return report;

  const rows = db
    .prepare(
      `SELECT id, chapter, body, proposed_text, quote, status FROM comments
        WHERE rights_verdict IS NULL AND status IN ('new','batched','delivered')
        ORDER BY created_at, id`,
    )
    .all() as UndecidedRow[];

  db.transaction(() => {
    for (const row of rows) {
      const scan = scanFiling(db, row.chapter, { body: row.body, proposed: row.proposed_text, quote: row.quote });
      report.scanned += 1;
      report[scan.verdict] += 1;
      if (scan.verdict === 'clear') {
        recordRights(db, { commentId: row.id, verdict: 'CLEAR', rule: null, source: 'scan', by: BY, at });
        continue;
      }
      if (scan.verdict === 'flag') {
        flagRights(db, { commentId: row.id, detail: scan.detail, at });
        continue;
      }
      recordRights(db, {
        commentId: row.id,
        verdict: 'REFUSED',
        rule: scan.rule,
        source: 'scan',
        by: BY,
        at,
        // A `new` row has not reached anyone yet: B's refusal is the reader's line. A row
        // already in triage keeps its status — the verdict is recorded, the decision is not
        // taken from the pass that holds it (B3).
        publishRefusal: row.status === 'new',
      });
    }
    setMeta(db, MARK, VERSION);
  })();
  report.ran = true;
  return report;
}
