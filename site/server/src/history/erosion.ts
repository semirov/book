/**
 * Provenance erosion (§6F.4): the share of the text whose *last* cause is a given reader,
 * measured daily and never modelled.
 *
 * The number is last-writer attribution and says so: characters currently carrying this
 * reader's last cause ÷ total characters. A contribution that shrank because a later step
 * rewrote the sentence *is* the erosion. Nothing in the system reacts to a low share — the
 * moment it becomes a score it stops being true.
 */

import type { ContributorPointDto } from '@book/shared';

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';

export type SharePoint = { identityId: string; edits: number; chars: number; share: number };

/** Characters whose latest version was written by each identity, against the whole book. */
export function computeShares(db: Db): { totalChars: number; items: SharePoint[] } {
  const blocks = db
    .prepare(
      `SELECT v.identity_id, SUM(v.chars) AS chars FROM block_versions v
         JOIN (SELECT block_uid, MAX(ver) AS ver FROM block_versions GROUP BY block_uid) last
           ON last.block_uid = v.block_uid AND last.ver = v.ver
        WHERE v.op != 'erased'
        GROUP BY v.identity_id`,
    )
    .all() as Array<{ identity_id: string | null; chars: number }>;
  const totalChars = blocks.reduce((sum, row) => sum + row.chars, 0);

  const edits = db
    .prepare(
      `SELECT c.identity_id AS identity_id, COUNT(*) AS edits FROM (
         SELECT DISTINCT ch.id, cm.identity_id FROM changes ch
           JOIN comments cm ON cm.id = ch.source_comment
       ) c GROUP BY c.identity_id`,
    )
    .all() as Array<{ identity_id: string; edits: number }>;
  const editsById = new Map(edits.map((row) => [row.identity_id, row.edits]));

  const items: SharePoint[] = [];
  for (const row of blocks) {
    if (row.identity_id === null) continue;
    items.push({
      identityId: row.identity_id,
      edits: editsById.get(row.identity_id) ?? 0,
      chars: row.chars,
      share: totalChars === 0 ? 0 : row.chars / totalChars,
    });
  }
  // An identity that only queued changes keeps a zero-share point, so its curve is honest.
  for (const [identityId, count] of editsById) {
    if (items.some((item) => item.identityId === identityId)) continue;
    items.push({ identityId, edits: count, chars: 0, share: 0 });
  }
  return { totalChars, items: items.sort((left, right) => right.chars - left.chars) };
}

/**
 * The nightly measurement: refresh the `contributions` projection and append today's point
 * to `contribution_history`. A day's row is immutable once written — a correction is a new
 * measurement on another day, never an update (§6F.4 rule 2).
 */
export function measureContributions(db: Db, nowMs: number = Date.now()): SharePoint[] {
  const at = toIso(nowMs);
  const day = at.slice(0, 10);
  const { items } = computeShares(db);
  const write = db.transaction(() => {
    for (const item of items) {
      db.prepare(
        `INSERT INTO contributions (identity_id, edits, chars, share, first_at, last_at, computed_at)
         VALUES (@identityId, @edits, @chars, @share, @at, @at, @at)
         ON CONFLICT(identity_id) DO UPDATE SET
           edits = excluded.edits,
           chars = excluded.chars,
           share = excluded.share,
           last_at = excluded.last_at,
           computed_at = excluded.computed_at`,
      ).run({ ...item, at });
      db.prepare(
        `INSERT INTO contribution_history (identity_id, day, edits, chars, share, measured_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(identity_id, day) DO NOTHING`,
      ).run(item.identityId, day, item.edits, item.chars, item.share, at);
    }
  });
  write();
  return items;
}

/** The erosion series of one identity, oldest first. */
export function readSeries(db: Db, identityId: string): ContributorPointDto[] {
  return db
    .prepare('SELECT day, edits, chars, share FROM contribution_history WHERE identity_id = ? ORDER BY day')
    .all(identityId) as ContributorPointDto[];
}

/** The nightly job: measure once at boot and once a day (§20 M6b, §6F.4). */
export function startErosionJob(
  db: Db,
  options: { now?: () => number; intervalMs?: number } = {},
): () => void {
  const now = options.now ?? (() => Date.now());
  const run = (): void => {
    try {
      measureContributions(db, now());
    } catch {
      // A measurement is an observation; a failed one must not stop the site.
    }
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? 24 * 60 * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
