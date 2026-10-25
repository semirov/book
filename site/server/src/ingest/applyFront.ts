/**
 * One observed `00-front.md` → the live title and page 2 (§6C.2, F021) and one front
 * revision in the log (§6F.2).
 *
 * A malformed first sheet is stored as empty strings, never as a fabricated title or
 * blurb: the cover falls back to the site's own word «Книга» and page 2 renders nothing.
 * The problems are returned so `/healthz`/the admin view can report F021.
 */

import type { Db } from '../db/db.ts';
import { getFrontRow, upsertFrontRow } from '../db/repo/front.ts';
import { appendEvent } from '../history/log.ts';
import { toIso } from '../util/time.ts';
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
  | { status: 'unchanged'; title: string | null; about: string | null; rev: number; problems: string[] }
  | {
      status: 'created' | 'revised';
      title: string | null;
      about: string | null;
      rev: number;
      previousRev: number;
      changed: { title: boolean; about: boolean };
      problems: string[];
      updatedAt: string;
      /** The log entry this revision produced, and who caused it (§6F.1). */
      hseq: number;
      cause: WriteCause;
      actor: WriteActor;
    };

export function applyFrontFile(input: ApplyFrontInput): ApplyFrontResult {
  const { db } = input;
  const parsed = parseFront(input.raw);
  const existing = getFrontRow(db);
  // Any F021 fault hides page 2 — the site never shows a blurb from a malformed sheet
  // (§11.8) — while a valid title still carries the cover.
  const title = parsed.title ?? '';
  const about = parsed.problems.length > 0 ? '' : (parsed.about ?? '');
  const updatedAt = toIso(Math.min(input.mtimeMs, input.nowMs));

  if (existing !== undefined && existing.sha256 === parsed.sha256) {
    return {
      status: 'unchanged',
      title: existing.title.length > 0 ? existing.title : null,
      about: existing.about.length > 0 ? existing.about : null,
      rev: existing.rev,
      problems: parsed.problems,
    };
  }

  const previousRev = existing?.rev ?? 0;
  const rev = previousRev + 1;
  const changed = {
    title: (existing?.title ?? '') !== title,
    about: (existing?.about ?? '') !== about,
  };
  const cause = input.cause ?? frontWriteCause(db, input.nowMs);
  const actor = actorForCause(db, cause);

  const run = db.transaction((): ApplyFrontResult => {
    upsertFrontRow(db, { title, about, rev, sha256: parsed.sha256, updatedAt });
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
        payload: { title, changed, sha256: parsed.sha256, aboutChars: about.length },
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
      rev,
      previousRev,
      changed,
      problems: parsed.problems,
      updatedAt,
      hseq,
      cause,
      actor,
    };
  });

  try {
    return run();
  } catch (error) {
    // The same race as a chapter write: the site and the engine may both publish this
    // first sheet. Whoever loses finds the revision published and the text equal.
    const message = error instanceof Error ? error.message : '';
    const published = getFrontRow(db);
    if (/UNIQUE constraint failed|PRIMARY KEY/u.test(message) && published?.sha256 === parsed.sha256) {
      return {
        status: 'unchanged',
        title: published.title.length > 0 ? published.title : null,
        about: published.about.length > 0 ? published.about : null,
        rev: published.rev,
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
