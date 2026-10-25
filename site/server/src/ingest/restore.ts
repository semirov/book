/**
 * A restore is recognised by its *content*, not by a marker file (§13.3).
 *
 * The operator rolls back by copying a snapshot over the chapter (`data/versions/ch09/
 * <sha256>.md` or `git checkout`), and the site then observes an unattributed write. Without
 * a lease the honest label would be «правка вне процесса»; but if the text is byte-identical
 * to a text this chapter already had, the site knows what happened: a human put an old
 * revision back. That write is a `restore` — no lease, `attributed:false`, `ungated` until
 * `reconcile` runs the gates.
 *
 * Detection is deterministic and needs no operator cooperation: the snapshot filename is the
 * sha256 of the text, so the comparison is a string lookup, and a restore performed while
 * the site was down is classified the same way on the boot rescan.
 */

import type { Db } from '../db/db.ts';

export type RestoredFrom = {
  /** The revision whose text is back. */
  rev: number;
  at: string;
  /** How the operator got here, for the log line: snapshot or git (§13.3 step 2). */
  how: 'snapshot';
};

type RevisionRow = { rev: number; at: string; snapshot: string };

/** The newest earlier revision of `n` whose stored snapshot is exactly `sha256`. */
export function restoredFrom(db: Db, n: number, sha256: string): RestoredFrom | null {
  if (sha256.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT rev, at, snapshot FROM revisions
        WHERE chapter = ? AND snapshot LIKE ?
        ORDER BY rev DESC LIMIT 1`,
    )
    .all(n, `%/${sha256}.md`) as RevisionRow[];
  const row = rows[0];
  if (row === undefined) return null;
  return { rev: row.rev, at: row.at, how: 'snapshot' };
}

/** The cause the ingest records for a restore: no lease, no change, an operator's hand. */
export function restoreCause(from: RestoredFrom): {
  kind: 'restore';
  lane: null;
  leaseId: null;
  changeId: null;
  cascadeId: null;
  stepId: null;
  restoredRev: number;
} {
  return {
    kind: 'restore',
    lane: null,
    leaseId: null,
    changeId: null,
    cascadeId: null,
    stepId: null,
    restoredRev: from.rev,
  };
}
