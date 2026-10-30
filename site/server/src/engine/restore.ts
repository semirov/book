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
import * as store from './store.ts';
import { isEngineError, refuse, type EngineDeps } from './types.ts';

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

// ── the refusal's restore: the pre-pass revision, back ──────────────────────
//
// A refusal means **no text of this pass is in the book**. The mechanism is the operator's own
// restore (`restoreRevision`): a new revision carrying the pre-pass text, appended, never a file
// put back. Three answers, and no fourth:
//
//   · nothing was landed, or the chapter had no text before the pass (`rev_before` 0: a draft's
//     first edition) → nothing to put back;
//   · the pre-pass text is already what the site serves → nothing to do (a second refusal of the
//     same chapter is a no-op, so a cascade can restore every step without doubling revisions);
//   · otherwise the served text must still be this step's own landing. If it is not, somebody
//     else wrote the chapter after the pass, and restoring over them would destroy that work:
//     the refusal stops with `TEXT_STUCK` instead of closing over moved text.

export type PrePassRestore =
  | { restored: false }
  | { restored: true; rev: number; sha: string };

type TargetRevision = { rev: number; snapshot: string };

function textStuck(chapter: number, detail: string, extra: Record<string, unknown> = {}): never {
  refuse(
    'TEXT_STUCK',
    409,
    `главу ${String(chapter)} нельзя вернуть к прежней редакции (${detail}) — заявка не закрыта`,
    extra,
  );
}

/** The sha of a revision's snapshot, read back and parsed exactly as the applier will. */
function revisionSha(deps: EngineDeps, chapter: number, target: TargetRevision): string {
  const text = readSnapshot(deps.config.dataDir, target.snapshot);
  if (text === null) textStuck(chapter, `снимок ревизии ${String(target.rev)} не найден`);
  return parseChapter(chapter, text).sha256;
}

/**
 * Put one step's chapter back to the revision the step started from. A refusal that cannot do
 * this must not close: `TEXT_STUCK` is the loud stop, never a decision over text that moved.
 */
export function restorePrePass(deps: EngineDeps, step: store.StepRow, now: number): PrePassRestore {
  const { db } = deps;
  const chapter = step.chapter;
  if (step.landed_at === null || chapter === null) return { restored: false };
  const before = step.rev_before ?? 0;
  // The pre-pass state of a chapter that did not exist is «no chapter», and there is no revision
  // to publish it as: a draft's first edition stays (its premise is settled by the text itself).
  if (before < 1) return { restored: false };
  const current = getChapterRow(db, chapter);
  if (current === undefined) textStuck(chapter, 'глава исчезла');
  const target = db
    .prepare('SELECT rev, snapshot FROM revisions WHERE chapter = ? AND rev = ?')
    .get(chapter, before) as TargetRevision | undefined;
  if (target === undefined) textStuck(chapter, `ревизии ${String(before)} нет`);
  const sha = revisionSha(deps, chapter, target);
  if (current.sha256 === sha) return { restored: false };
  if (step.landed_sha !== null && current.sha256 !== step.landed_sha) {
    textStuck(chapter, 'глава уже не тот текст, что записал шаг');
  }
  let restored: RestoreResult;
  try {
    restored = restoreRevision(deps, { chapter, rev: before, now });
  } catch (error) {
    // A restore the applier refuses (a moved frame, an empty or missing revision) is the same
    // fact: the pre-pass text cannot be published. The code says so once, for the caller.
    if (isEngineError(error)) textStuck(chapter, error.message, { cause: error.code });
    throw error;
  }
  // The published text must be the pre-pass text, and the chapter must now serve that revision:
  // a restore that returned something else would be a close over text nobody put back.
  if (restored.sha !== sha) textStuck(chapter, 'восстановленная редакция не совпала с прежней', { sha: restored.sha });
  return { restored: true, rev: restored.rev, sha: restored.sha };
}

/**
 * Every chapter a ripple wrote, back to its own pre-pass revision — the refusal of a cascade
 * change means none of its text stands, not only the last step's.
 */
export function restoreCascadePrePass(deps: EngineDeps, cascadeId: string, now: number): number {
  let restored = 0;
  for (const step of store.listCascadeSteps(deps.db, cascadeId)) {
    if (restorePrePass(deps, step, now).restored) restored += 1;
  }
  return restored;
}
