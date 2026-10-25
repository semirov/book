/**
 * The authors query (§6C.5, rule 6: «the query is in `authors/contributions.ts` with
 * fixtures, because a share that wobbles on reload is worse than no share»).
 *
 * The measurement itself lives in `history/erosion.ts` and is shared with the nightly
 * projection: characters whose *last* cause is a reader's change, over the whole book. This
 * module turns that measurement into the end-matter list:
 *
 * - the author is the remainder (`1 − Σ shares`), so the book never reads as co-authored in
 *   law and a hidden contributor's text accrues to the author rather than to nobody;
 * - every share is floored to six decimals, so a printed column can never sum above 1;
 * - the order is total: share, then `firstAt`, then label, then identity — no clock, no map
 *   iteration order, no SQL row order decides anything a reader can see.
 */

import { floorShare, type AuthorsDto, type AuthorContributorDto } from '@book/shared';

import type { Db } from '../db/db.ts';
import { computeShares, readSeries } from '../history/erosion.ts';

type IdentityRow = { id: string; display_name: string; hide_from_authors: number };

/** The oldest queued change of a reader, used when the nightly projection has no row yet. */
function firstChangeAt(db: Db, identityId: string): string | null {
  const row = db
    .prepare(
      `SELECT MIN(ch.enqueued_at) AS at FROM changes ch
         JOIN comments cm ON cm.id = ch.source_comment
        WHERE cm.identity_id = ?`,
    )
    .get(identityId) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/**
 * The one order the end matter uses (§6C.5 rule 6): the biggest trace in the final text
 * first, then the reader who got there first, then the label, then the id. A reader with no
 * recorded date sorts last — an unknown date is not an early one — and every remaining tie
 * is broken by a value that cannot be equal, so the list never depends on row order.
 */
export function compareContributors(left: AuthorContributorDto, right: AuthorContributorDto): number {
  if (left.share !== right.share) return right.share - left.share;
  if (left.firstAt !== right.firstAt) {
    if (left.firstAt === '') return 1;
    if (right.firstAt === '') return -1;
    return left.firstAt < right.firstAt ? -1 : 1;
  }
  if (left.label !== right.label) return left.label < right.label ? -1 : 1;
  return left.identityId < right.identityId ? -1 : left.identityId > right.identityId ? 1 : 0;
}

function firstAt(db: Db, identityId: string, projected: Map<string, string>): string {
  const fromProjection = projected.get(identityId);
  if (fromProjection !== undefined && fromProjection.length > 0) return fromProjection;
  return firstChangeAt(db, identityId) ?? '';
}

/**
 * The end matter's list, for the imprint's author. `authorLabel` comes from the read-only
 * imprint, never from a reader: a name in a copyright notice is a legal statement.
 */
export function readAuthors(db: Db, authorLabel: string): AuthorsDto {
  const { totalChars, items } = computeShares(db);
  const identities = db
    .prepare('SELECT id, display_name, hide_from_authors FROM identities')
    .all() as IdentityRow[];
  const byId = new Map(identities.map((row) => [row.id, row]));

  const projected = new Map<string, string>();
  const firstRows = db
    .prepare('SELECT identity_id, first_at FROM contributions')
    .all() as Array<{ identity_id: string; first_at: string }>;
  for (const row of firstRows) projected.set(row.identity_id, row.first_at);

  const contributors: AuthorContributorDto[] = [];
  for (const item of items) {
    const identity = byId.get(item.identityId);
    // §6C.5 rule 5: an opt-out is neither listed nor named. The edits stay attributed to an
    // anonymous id in the log; the list simply does not publish the reader.
    if (identity === undefined || identity.hide_from_authors === 1) continue;
    contributors.push({
      identityId: item.identityId,
      label: identity.display_name,
      edits: item.edits,
      chars: item.chars,
      share: totalChars === 0 ? 0 : floorShare(item.chars / totalChars),
      firstAt: firstAt(db, item.identityId, projected),
      series: readSeries(db, item.identityId),
    });
  }

  contributors.sort(compareContributors);

  const listed = contributors.reduce((sum, item) => sum + item.share, 0);
  const authorShare = Math.max(0, floorShare(1 - listed));
  const authorChars = Math.max(0, totalChars - contributors.reduce((sum, item) => sum + item.chars, 0));

  const measured = db.prepare('SELECT MAX(measured_at) AS at FROM contribution_history').get() as {
    at: string | null;
  };

  return {
    totalChars,
    measuredAt: measured.at,
    measured: items.length,
    author: { label: authorLabel, share: authorShare, chars: authorChars },
    contributors,
    sum: floorShare(listed + authorShare),
  };
}
