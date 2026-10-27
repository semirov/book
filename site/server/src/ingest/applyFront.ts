/**
 * One observed `00-front.md` → the live title and page 2 (§6C.2, F021) and one front
 * revision in the log (§6F.2).
 *
 * Who writes decides what the annotation may do (BOOK-7):
 * - **inside a lease** (a ripple/writer pass, engine `land`, or the watcher observing that
 *   pass's file) page 2 is basis: a different annotation is published as a title-only
 *   revision, the stored text wins, and the event names the rejected rewrite
 *   (`FRONT_ANNOTATION_FROZEN`) so the pass is refused at the engine gate;
 * - **outside any lease** it is the owner's hand edit, the same class as a chapter hand
 *   edit: the new annotation is projected, its `aboutSha256` stored, `rev` bumped, and the
 *   history says «правка вне процесса». A later pass is compared to this new basis.
 *
 * A malformed first sheet is stored as empty strings, never as a fabricated title or
 * blurb: the cover falls back to the site's own word «Книга» — and a malformed rewrite never
 * blanks an annotation that already stands. The problems are returned so `/healthz`/the
 * admin view can report F021.
 */

import { FRONT_ANNOTATION_FROZEN } from '@book/shared';

import type { Db } from '../db/db.ts';
import { getFrontRow, upsertFrontRow } from '../db/repo/front.ts';
import { appendEvent } from '../history/log.ts';
import { toIso } from '../util/time.ts';
import { sha256Hex } from '../util/hash.ts';
import { writeFrontSnapshot } from '../versions/snapshots.ts';
import { actorForCause, frontWriteCause, type WriteActor, type WriteCause } from './attribution.ts';
import { parseFront } from './parseFront.ts';

export type ApplyFrontInput = {
  db: Db;
  dataDir: string;
  raw: string;
  mtimeMs: number;
  nowMs: number;
  /** An explicit cause for a write that is not a observed step. */
  cause?: WriteCause;
};

export type ApplyFrontResult =
  | { status: 'unchanged'; title: string | null; about: string | null; aboutSha256: string; rev: number; problems: string[] }
  | {
      status: 'created' | 'revised';
      title: string | null;
      about: string | null;
      aboutSha256: string;
      rev: number;
      previousRev: number;
      problems: string[];
      updatedAt: string;
      /** The log entry this revision produced, and who caused it (§6F.1). */
      hseq: number;
      cause: WriteCause;
      actor: WriteActor;
      /** Whether this revision replaced the page-2 text (an owner edit, not a wave). */
      annotationChanged: boolean;
      /** Set when a leased pass tried to rewrite page 2: the stored annotation wins. */
      annotationRejected: typeof FRONT_ANNOTATION_FROZEN | null;
    };

export function applyFrontFile(input: ApplyFrontInput): ApplyFrontResult {
  const { db } = input;
  const parsed = parseFront(input.raw);
  const existing = getFrontRow(db);
  // Any F021 fault hides a *new* annotation — the site never shows a blurb from a malformed
  // sheet (§11.8) — while a valid title still carries the cover.
  const title = parsed.title ?? '';
  const written = parsed.problems.length > 0 ? '' : (parsed.about ?? '');
  // A live front lease means a pass is writing: page 2 is basis against that pass. Without a
  // lease the write is a hand edit and page 2 follows the file (BOOK-7).
  const cause = input.cause ?? frontWriteCause(db, input.nowMs);
  const published = existing !== undefined && existing.about.length > 0 ? existing.about : null;
  const frozen = cause.leaseId !== null && published !== null;
  // An empty/malformed sheet never blanks a standing annotation; a valid one replaces it
  // outside a lease and is ignored inside one.
  const about = frozen ? published : written.length > 0 ? written : (published ?? '');
  const aboutSha256 = sha256Hex(about);
  const annotationChanged = (existing?.about ?? '') !== about;
  const annotationRejected = frozen && written !== published ? FRONT_ANNOTATION_FROZEN : null;
  const updatedAt = toIso(Math.min(input.mtimeMs, input.nowMs));

  if (existing !== undefined && existing.sha256 === parsed.sha256 && existing.about === about) {
    return {
      status: 'unchanged',
      title: existing.title.length > 0 ? existing.title : null,
      about: existing.about.length > 0 ? existing.about : null,
      aboutSha256: existing.about_sha256.length > 0 ? existing.about_sha256 : aboutSha256,
      rev: existing.rev,
      problems: parsed.problems,
    };
  }

  const previousRev = existing?.rev ?? 0;
  const rev = previousRev + 1;
  const titleChanged = (existing?.title ?? '') !== title;
  const actor = actorForCause(db, cause);

  const run = db.transaction((): ApplyFrontResult => {
    upsertFrontRow(db, { title, about, aboutSha256, rev, sha256: parsed.sha256, updatedAt });
    const snapshot = writeFrontSnapshot(input.dataDir, parsed.sha256, parsed.text);
    const hseq = appendEvent(
      db,
      {
        kind: 'front.revised',
        isFront: true,
        rev,
        changeId: cause.changeId,
        cascadeId: cause.cascadeId,
        stepId: cause.stepId,
        authorKind: actor.kind,
        identityId: actor.identityId,
        authorLabel: actor.label,
        payload: {
          title,
          titleChanged,
          annotationChanged,
          aboutSha256,
          sha256: parsed.sha256,
          aboutChars: about.length,
          ...(annotationRejected === null ? {} : { annotationRejected }),
        },
      },
      input.nowMs,
    );
    db.prepare(
      `INSERT INTO front_revisions (rev, title, about, sha256, snapshot, hseq, at, change_id, step_id)
       VALUES (@rev, @title, @about, @sha256, @snapshot, @hseq, @at, @changeId, @stepId)`,
    ).run({
      rev,
      title,
      about,
      sha256: parsed.sha256,
      snapshot,
      hseq,
      at: updatedAt,
      changeId: cause.changeId,
      stepId: cause.stepId,
    });
    return {
      status: existing === undefined ? 'created' : 'revised',
      title: title.length > 0 ? title : null,
      about: about.length > 0 ? about : null,
      aboutSha256,
      rev,
      previousRev,
      problems: parsed.problems,
      updatedAt,
      hseq,
      cause,
      actor,
      annotationChanged,
      annotationRejected,
    };
  });

  try {
    return run();
  } catch (error) {
    // The same race as a chapter write: the site and the engine may both publish this
    // first sheet. Whoever loses finds the revision published and the text equal.
    const message = error instanceof Error ? error.message : '';
    const publishedRow = getFrontRow(db);
    if (/UNIQUE constraint failed|PRIMARY KEY/u.test(message) && publishedRow?.sha256 === parsed.sha256) {
      return {
        status: 'unchanged',
        title: publishedRow.title.length > 0 ? publishedRow.title : null,
        about: publishedRow.about.length > 0 ? publishedRow.about : null,
        aboutSha256: publishedRow.about_sha256,
        rev: publishedRow.rev,
        problems: parsed.problems,
      };
    }
    throw error;
  }
}

/** The first sheet disappeared: the cover has no title and page 2 no blurb (F021). */
export function removeFront(db: Db): { status: 'removed' | 'absent'; rev: number } {
  const existing = getFrontRow(db);
  if (existing === undefined) return { status: 'absent', rev: 0 };
  db.prepare('DELETE FROM front_matter WHERE id = 1').run();
  return { status: 'removed', rev: existing.rev };
}
