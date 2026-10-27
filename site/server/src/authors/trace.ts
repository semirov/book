/**
 * The reader's own trace (BOOK-DOC-4): «пережила N ревизий, сейчас 0,4 %».
 *
 * This is the one place the share is addressed to the reader themself, so it is own-only:
 * the identity comes from the session cookie, never from a parameter, and the answer
 * carries no identity key — the display name is the only handle (audit m3). The numbers
 * are the same measurement the authors list prints, so the end matter cannot contradict
 * itself; the series is the measured days, never a curve interpolated between two points.
 */

import { floorShare, type MyTraceDto } from '@book/shared';

import type { Db } from '../db/db.ts';
import { readIdentity } from '../db/repo/identities.ts';
import { computeShares, readSeries } from '../history/erosion.ts';

/**
 * «Пережила N ревизий»: how many chapter revisions the reader's currently surviving
 * characters have lived through — every revision of their chapter after the one that wrote
 * a surviving paragraph, counted once per (chapter, revision) pair up to the chapter's
 * current revision. Nothing survives → 0, and the copy then says exactly that.
 */
const SURVIVED_SQL = `
  SELECT COUNT(*) AS n FROM (
    SELECT DISTINCT v.chapter AS chapter, r.rev AS rev
      FROM block_versions v
      JOIN (SELECT block_uid, MAX(ver) AS ver FROM block_versions GROUP BY block_uid) last
        ON last.block_uid = v.block_uid AND last.ver = v.ver
      JOIN chapters ch ON ch.n = v.chapter
      JOIN revisions r ON r.chapter = v.chapter AND r.rev > v.rev AND r.rev <= ch.rev
     WHERE v.identity_id = ? AND v.op != 'erased' AND v.chars > 0
  ) survived`;

export function survivedRevisions(db: Db, identityId: string): number {
  // `COUNT(*)` always yields one row; the cast is the shape, not a guess.
  return (db.prepare(SURVIVED_SQL).get(identityId) as { n: number }).n;
}

export function readMyTrace(db: Db, identityId: string): MyTraceDto {
  const identity = readIdentity(db, identityId);
  const { totalChars, items } = computeShares(db);
  const own = items.find((item) => item.identityId === identityId);
  const chars = own?.chars ?? 0;

  return {
    label: identity?.display_name ?? 'читатель',
    edits: own?.edits ?? 0,
    chars,
    share: totalChars === 0 ? 0 : floorShare(chars / totalChars),
    series: readSeries(db, identityId),
    hidden: identity?.hide_from_authors === 1,
    survivedRevisions: survivedRevisions(db, identityId),
  };
}
