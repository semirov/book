/**
 * The one-shot import: an existing file tree → rows (ADR-041 §1, BOOK-187 AC2).
 *
 * **This is the only module allowed to read a manuscript directory, and it is unreachable from
 * a normal boot.** The book's text lives in `chapters`/`blocks`, so a restart has nothing to
 * rescan; an operator runs this deliberately, once, to bring a tree of chapter files into a
 * volume (a migration, a restored checkout, a fixture in a test). Nothing else in `server/src`
 * may open a chapter file: `scripts/arch.mjs`'s text-home rule fails such an import.
 *
 * The import is idempotent by text: a file whose bytes match the row is `unchanged`, a changed
 * one is a revision. A chapter that disappeared from the directory is removed from the
 * projection — files win, always (§18) — while its text stays recoverable from `data/versions/`.
 * The same is true of the first sheet: `00-front.md` is the only source of the cover and page 2.
 */

import { isChapterNumber } from '@book/shared';

import type { Db } from '../db/db.ts';
import { deleteChapterRow, listChapterRows } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { toIso } from '../util/time.ts';
import { applyChapterFile } from './applyChapter.ts';
import { applyFrontFile, removeFront } from './applyFront.ts';
import { scanManuscript } from './scanManuscript.ts';

export type FrontReconcileState = 'created' | 'revised' | 'unchanged' | 'removed' | 'missing';

export type ReconcileReport = {
  scanned: number;
  created: number[];
  revised: number[];
  unchanged: number[];
  removed: number[];
  /** Slots that hold only their basis sentence: projected as one paragraph, still unwritten (BOOK-6). */
  emptied: number[];
  /**
   * Files whose frame is not the book's frame (ch01/ch42, BOOK-137): nothing was published from
   * them, the projection keeps the sentence it serves, and the boot goes on.
   */
  frameRejected: number[];
  front: FrontReconcileState;
  /** The manuscript directory itself is absent (a bad mount): nothing is removed. */
  missing: boolean;
  /** F021 problems of the observed first sheet; a malformed sheet is an error, not a crash. */
  frontProblems: string[];
  ignored: string[];
  readErrors: Array<{ fileName: string; message: string }>;
  at: string;
};

export type ReconcileOptions = {
  bookRoot: string;
  dataDir: string;
  now?: Date;
};

export function reconcile(db: Db, options: ReconcileOptions): ReconcileReport {
  const nowMs = (options.now ?? new Date()).getTime();
  const at = toIso(nowMs);
  const scan = scanManuscript(options.bookRoot);
  const report: ReconcileReport = {
    scanned: scan.chapters.length,
    created: [],
    revised: [],
    unchanged: [],
    removed: [],
    emptied: [],
    frameRejected: [],
    front: 'missing',
    missing: scan.missing,
    frontProblems: [],
    ignored: scan.ignored,
    readErrors: scan.readErrors,
    at,
  };

  const run = db.transaction(() => {
    for (const scanned of scan.chapters) {
      const result = applyChapterFile({
        db,
        dataDir: options.dataDir,
        n: scanned.n,
        raw: scanned.raw,
        mtimeMs: scanned.mtimeMs,
        nowMs,
      });
      if (result.status === 'created') report.created.push(result.n);
      else if (result.status === 'revised') report.revised.push(result.n);
      else if (result.status === 'unchanged') report.unchanged.push(result.n);
      else if (result.status === 'emptied') report.emptied.push(result.n);
      else if (result.status === 'frame-rejected') report.frameRejected.push(result.n);
      // `empty`: a zero-byte first sight is a slot in progress; a previous revision is
      // kept rather than blanked (§6.2). The watcher adds the 5 s follow-up rule. A slot
      // reduced to its basis sentence is not that case: it is `emptied` (BOOK-6) and keeps
      // the frame as its one paragraph.
    }

    // A missing directory is an infrastructure fault, not an empty book (§6.2): the last
    // known text stays served and nothing is deleted until the mount is back.
    if (scan.missing) return;

    const onDisk = new Set(scan.chapters.map((chapter) => chapter.n));
    for (const row of listChapterRows(db)) {
      // A row outside the book's range is storage, not a projection: the scan cannot see it by
      // design (`scanManuscript` skips `ch65.md`), so it must not be read as a vanished file
      // and deleted. It is never served either — see `deriveState` (BOOK-155).
      if (!isChapterNumber(row.n)) continue;
      if (!onDisk.has(row.n)) {
        deleteChapterRow(db, row.n);
        report.removed.push(row.n);
      }
    }

    if (scan.front === null) {
      if (getFrontRow(db) !== undefined) {
        removeFront(db);
        report.front = 'removed';
      }
      return;
    }

    const front = applyFrontFile({
      db,
      dataDir: options.dataDir,
      raw: scan.front.raw,
      mtimeMs: scan.front.mtimeMs,
      nowMs,
    });
    report.front = front.status;
    report.frontProblems = front.problems;
  });
  run();

  return report;
}

/** Used by `/healthz` to say when the repository was last read. */
export function rememberScan(db: Db, report: ReconcileReport): void {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(
    'last_scan_at',
    report.at,
  );
}

/** Kept for the boot log: who is in the projection right now. */
export function knownChapterNumbers(db: Db): number[] {
  return listChapterRows(db).map((row) => row.n);
}
