/**
 * Full rescan of the manuscript into SQLite (ADR-002: files are the only source of truth
 * for text). Boot runs this once; M2 replaces the trigger with a watcher, not the logic.
 *
 * A chapter that disappeared from the directory is removed from the projection — files
 * win, always (§18) — while its text stays recoverable from `data/versions/`.
 */

import type { Db } from '../db/db.ts';
import { deleteChapterRow, getChapterRow, listChapterRows, replaceBlocks, upsertChapterRow } from '../db/repo/chapters.ts';
import { insertRevision } from '../db/repo/revisions.ts';
import { toIso } from '../util/time.ts';import { writeSnapshot } from '../versions/snapshots.ts';
import { diffBlocks } from './diffBlocks.ts';
import { parseChapter } from './parseChapter.ts';
import { scanManuscript } from './scanManuscript.ts';

export type ReconcileReport = {
  scanned: number;
  created: number[];
  revised: number[];
  unchanged: number[];
  removed: number[];
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
    ignored: scan.ignored,
    readErrors: scan.readErrors,
    at,
  };

  const run = db.transaction(() => {
    for (const scanned of scan.chapters) {
      const parsed = parseChapter(scanned.n, scanned.raw);
      const existing = getChapterRow(db, scanned.n);
      // The file's mtime is when the text was written; booting the site is not a writing event.
      const observedAt = toIso(Math.min(scanned.mtimeMs, nowMs));

      if (existing === undefined) {
        upsertChapterRow(db, {
          n: parsed.n,
          rev: 1,
          sha256: parsed.sha256,
          chars: parsed.chars,
          blockCount: parsed.blocks.length,
          writtenAt: observedAt,
          updatedAt: observedAt,
        });
        replaceBlocks(db, parsed.n, 1, parsed.blocks);
        const snapshot = writeSnapshot(options.dataDir, parsed.n, parsed.sha256, parsed.text);
        insertRevision(db, {
          chapter: parsed.n,
          rev: 1,
          at: observedAt,
          kind: 'create',
          // No lease exists in M0: an observed write is reported as local and unattributed (F015).
          causeKind: 'local',
          changeId: null,
          cascadeId: null,
          stageSeq: null,
          added: parsed.blocks.length,
          changed: 0,
          removed: 0,
          snapshot,
          attributed: false,
          logNote: 'first sighting',
        });
        report.created.push(parsed.n);
        continue;
      }

      if (existing.sha256 === parsed.sha256) {
        report.unchanged.push(parsed.n);
        continue;
      }

      const rev = existing.rev + 1;
      const before = db
        .prepare('SELECT hash FROM blocks WHERE chapter = ? ORDER BY idx')
        .all(parsed.n)
        .map((row) => (row as { hash: string }).hash);
      const diff = diffBlocks(
        before,
        parsed.blocks.map((block) => block.hash),
      );
      const rewrite = before.length > 0 && diff.changed + diff.removed >= before.length;

      upsertChapterRow(db, {
        n: parsed.n,
        rev,
        sha256: parsed.sha256,
        chars: parsed.chars,
        blockCount: parsed.blocks.length,
        writtenAt: existing.written_at,
        updatedAt: observedAt,
      });
      replaceBlocks(db, parsed.n, rev, parsed.blocks);
      const snapshot = writeSnapshot(options.dataDir, parsed.n, parsed.sha256, parsed.text);
      insertRevision(db, {
        chapter: parsed.n,
        rev,
        at: observedAt,
        kind: rewrite ? 'rewrite' : 'edit',
        causeKind: 'local',
        changeId: null,
        cascadeId: null,
        stageSeq: null,
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        snapshot,
        attributed: false,
        logNote: null,
      });
      report.revised.push(parsed.n);
    }

    const onDisk = new Set(scan.chapters.map((chapter) => chapter.n));
    for (const row of listChapterRows(db)) {
      if (!onDisk.has(row.n)) {
        deleteChapterRow(db, row.n);
        report.removed.push(row.n);
      }
    }
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
