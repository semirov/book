/**
 * Time travel as a query, not a restore (§6F.2).
 *
 * ```
 * bookAt(h) = { front: max(rev) where hseq <= h, n: max(rev) where chapter = n and hseq <= h }
 * ```
 *
 * One indexed lookup per chapter for metadata and one for the first sheet; a body is fetched
 * lazily per chapter with its own `ETag` (`ch09@h1043`), so scrubbing the timeline never
 * transfers a book. A chapter that did not exist at `h` is reported as absent — absence is
 * shown as absence, never as an empty chapter.
 */

import { allChapterNumbers } from '@book/shared';
import type { BookAtChapterDto, BookAtDto, HistoryChapterDto } from '@book/shared';

import type { Db } from '../db/db.ts';
import { getChapterRow, listBlocks, listChapterRows, type ChapterRow } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import { toIso } from '../util/time.ts';
import { readSnapshot } from '../versions/snapshots.ts';
import { hseqAtOrBefore, lastHseq } from './events.ts';
import { safeJson } from './payload.ts';

type RevisionAtRow = {
  rev: number;
  at: string;
  snapshot: string;
  cause_kind: string;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  hseq: number;
};

type MetaRow = { payload: string };

/**
 * The metadata of a chapter at a moment comes from its own log entry: the body is in the
 * snapshot store, the title and the size are not (`revisions` never carried them, §8).
 */
function chapterMetaAt(db: Db, chapter: number, hseq: number): { title: string | null; chars: number } {
  const row = db
    .prepare(
      `SELECT payload FROM events
        WHERE chapter = ? AND hseq <= ? AND kind IN ('chapter.created','chapter.revised','chapter.restored')
        ORDER BY hseq DESC LIMIT 1`,
    )
    .get(chapter, hseq) as MetaRow | undefined;
  if (row === undefined) return { title: null, chars: 0 };
  const payload = safeJson<{ title?: unknown; chars?: unknown }>(row.payload);
  return {
    title: typeof payload?.title === 'string' ? payload.title : null,
    chars: typeof payload?.chars === 'number' ? payload.chars : 0,
  };
}

function revisionAt(db: Db, chapter: number, hseq: number): RevisionAtRow | undefined {
  return db
    .prepare(
      `SELECT rev, at, snapshot, cause_kind, change_id, cascade_id, step_id, hseq
         FROM revisions
        WHERE chapter = ? AND hseq IS NOT NULL AND hseq <= ?
        ORDER BY rev DESC LIMIT 1`,
    )
    .get(chapter, hseq) as RevisionAtRow | undefined;
}

/**
 * Normalize the scrubber's input: `hseq` is authoritative; an ISO moment resolves to the
 * last event at or before it, never the other way round (§6F.2).
 */
export function resolveMoment(db: Db, moment: number | string | null | undefined): number {
  if (typeof moment === 'number' && Number.isFinite(moment)) {
    return Math.max(0, Math.min(Math.trunc(moment), lastHseq(db)));
  }
  if (typeof moment === 'string' && moment.length > 0) {
    if (/^\d+$/u.test(moment)) return resolveMoment(db, Number(moment));
    const parsed = Date.parse(moment);
    if (Number.isNaN(parsed)) return lastHseq(db);
    return hseqAtOrBefore(db, toIso(parsed));
  }
  return lastHseq(db);
}

export function bookAt(db: Db, moment?: number | string | null): BookAtDto {
  const last = lastHseq(db);
  const hseq = resolveMoment(db, moment);
  const reached = db.prepare('SELECT at FROM events WHERE hseq <= ? ORDER BY hseq DESC LIMIT 1').get(hseq) as
    | { at: string }
    | undefined;

  const fromLog = db
    .prepare(`SELECT rev, title, about FROM front_revisions WHERE hseq <= ? ORDER BY rev DESC LIMIT 1`)
    .get(hseq) as { rev: number; title: string; about: string } | undefined;

  // §6F.1 rule 4: the log is never the source of truth for "now" — the files are. At the
  // right edge of the scrubber the served projection wins, so an install that predates
  // M6b still answers «the book as it is» honestly instead of reporting absent chapters.
  const isNow = hseq >= last;
  const liveFront = isNow ? getFrontRow(db) : undefined;
  const liveChapters = isNow ? new Map(listChapterRows(db).map((row) => [row.n, row])) : null;
  const front =
    liveFront !== undefined
      ? { rev: liveFront.rev, title: liveFront.title, about: liveFront.about }
      : fromLog === undefined
        ? null
        : { rev: fromLog.rev, title: fromLog.title, about: fromLog.about };

  const chapters: BookAtChapterDto[] = allChapterNumbers().map((n) => {
    const live: ChapterRow | undefined = liveChapters?.get(n);
    if (live !== undefined) {
      const written = live.block_count > 0 && live.basis === 0;
      return { n, rev: live.rev, written, title: written ? live.title : null, chars: written ? live.chars : 0 };
    }
    const revision = revisionAt(db, n, hseq);
    if (revision === undefined) return { n, rev: 0, written: false, title: null, chars: 0 };
    const meta = chapterMetaAt(db, n, hseq);
    return {
      n,
      rev: revision.rev,
      written: true,
      title: meta.title,
      chars: meta.chars,
    };
  });

  return { hseq, at: reached?.at ?? null, front, chapters, lastHseq: last };
}

/** One chapter as it was at a moment; null when it did not exist yet (404, §6F.2). */
export function chapterAt(
  db: Db,
  dataDir: string,
  n: number,
  moment?: number | string | null,
): HistoryChapterDto | null {
  const hseq = resolveMoment(db, moment);
  // The right edge is the served projection, not the last revision (§6F.1 rule 4). For a
  // written chapter the two agree — the cause still comes from its last revision — but a slot
  // emptied down to its basis sentence has no revision at all (BOOK-6), and the prose of the
  // last one is not "now". Same rule as `bookAt`.
  if (hseq >= lastHseq(db)) {
    const live = getChapterRow(db, n);
    if (live !== undefined && live.block_count > 0) {
      const last = live.basis === 0 ? revisionAt(db, n, hseq) : undefined;
      return {
        n,
        hseq,
        at: last?.at ?? live.updated_at,
        rev: live.rev,
        title: live.title,
        chars: live.chars,
        blocks: listBlocks(db, n).map((block) => ({ id: block.id, i: block.idx, text: block.text, hash: block.hash })),
        cause:
          last === undefined
            ? null
            : {
                kind: last.cause_kind,
                changeId: last.change_id,
                cascadeId: last.cascade_id,
                stepId: last.step_id,
              },
      };
    }
  }

  const revision = revisionAt(db, n, hseq);
  if (revision === undefined) return null;
  const text = readSnapshot(dataDir, revision.snapshot);
  if (text === null) return null;
  const parsed = parseChapter(n, text);
  return {
    n,
    hseq: revision.hseq,
    at: revision.at,
    rev: revision.rev,
    title: parsed.title,
    chars: parsed.chars,
    blocks: parsed.blocks.map((block) => ({ id: block.id, i: block.i, text: block.text, hash: block.hash })),
    cause: {
      kind: revision.cause_kind,
      changeId: revision.change_id,
      cascadeId: revision.cascade_id,
      stepId: revision.step_id,
    },
  };
}
