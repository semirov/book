/**
 * A restore is a **new revision**, not a file put back (ADR-043 §3 row 9, ADR-041 §1).
 *
 * `--revert` used to copy a snapshot over `manuscript/chNN.md`; the DB is the only home of the
 * prose now, so the only way back is forward: the target revision's text is read out of
 * `revisions.snapshot` + `versions/`, published through the same applier every other write goes
 * through (`applyChapterFile`), and recorded with `cause_kind = 'restore'`. The old text stays
 * where it was — history is appended to, never rewritten — so the undo is itself auditable.
 *
 * The caller names no text: the chapter and, optionally, a revision. Without a revision the
 * target is the one before the current — «undo the last change».
 */

import { TOTAL_CHAPTERS } from '@book/shared';

import { getChapterRow } from '../db/repo/chapters.ts';
import { applyChapterFile } from '../ingest/applyChapter.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import { restoreCause } from '../ingest/restore.ts';
import { readSnapshot } from '../versions/snapshots.ts';
import { refuse, type EngineDeps } from './types.ts';

export type RestoreInput = {
  chapter: number;
  /** The revision to bring back; omitted means the one before the current. */
  rev?: number;
  now?: number;
};

export type RestoreResult = {
  /** The revision the chapter carries after the restore (a new one when the text moved). */
  rev: number;
  /** sha256 of the text the applier stored — the hash the writer prints. */
  sha: string;
  /** The revision the chapter had before; equal to `rev` when the text was already that one. */
  previousRev: number;
};

type RevisionRow = { rev: number; at: string; snapshot: string };

function revisionOf(db: EngineDeps['db'], chapter: number, rev: number | undefined): RevisionRow {
  if (rev === undefined) {
    // «Undo the last change»: the newest revision below the one the chapter serves now.
    const row = db
      .prepare('SELECT rev, at, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT 1 OFFSET 1')
      .get(chapter) as RevisionRow | undefined;
    if (row === undefined) {
      refuse('REVISION_MISSING', 409, `восстанавливать нечего: у главы ${String(chapter)} нет ревизии до текущей`);
    }
    return row;
  }
  const row = db
    .prepare('SELECT rev, at, snapshot FROM revisions WHERE chapter = ? AND rev = ?')
    .get(chapter, rev) as RevisionRow | undefined;
  if (row === undefined) {
    refuse('REVISION_MISSING', 404, `у главы ${String(chapter)} нет ревизии ${String(rev)}`);
  }
  return row;
}

export function restoreRevision(deps: EngineDeps, input: RestoreInput): RestoreResult {
  const { db } = deps;
  const chapter = input.chapter;
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) {
    refuse('INVALID_CHAPTER', 422, `chapter must be an integer between 1 and ${String(TOTAL_CHAPTERS)}`);
  }
  const at = input.now ?? deps.clock.now();
  const current = getChapterRow(db, chapter);
  if (current === undefined) {
    refuse('CHAPTER_MISSING', 409, `восстанавливать нечего: глава ${String(chapter)} не написана`);
  }
  const target = revisionOf(db, chapter, input.rev);
  const text = readSnapshot(deps.config.dataDir, target.snapshot);
  if (text === null) {
    refuse('SNAPSHOT_MISSING', 409, `снимок ревизии ${String(target.rev)} главы ${String(chapter)} не найден`);
  }

  const applied = applyChapterFile({
    db,
    dataDir: deps.config.dataDir,
    n: chapter,
    raw: text,
    // The restore happens now, not when the old text was written: the revision's `at` is the
    // operator's moment, and its `log_note` names the revision it brought back.
    mtimeMs: at,
    nowMs: at,
    cause: restoreCause({ rev: target.rev, at: target.at, how: 'snapshot' }),
  });
  if (applied.status === 'frame-rejected') {
    refuse('FRAME_CHANGED', 409, 'рамка книги: фраза этой главы не меняется — правка остаётся бумагой');
  }
  if (applied.status === 'empty') {
    refuse('REVISION_EMPTY', 409, `ревизия ${String(target.rev)} главы ${String(chapter)} не содержит текста`);
  }
  if (applied.status === 'created' || applied.status === 'revised') {
    // The applier parsed the same text, so its sha is the one the row now carries.
    return { rev: applied.rev, sha: parseChapter(chapter, text).sha256, previousRev: applied.previousRev };
  }
  // `unchanged`/`emptied`: the chapter already reads as that text — nothing is republished, and
  // the writer says so instead of claiming a restore that published no revision.
  const now = getChapterRow(db, chapter);
  return { rev: now?.rev ?? current.rev, sha: now?.sha256 ?? current.sha256, previousRev: now?.rev ?? current.rev };
}
