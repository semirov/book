/**
 * The chapter frames the bridge emits from `revisions` rows (BOOK-DOC-84 §2.1 #4, #5, #6).
 *
 * In production no manuscript watcher is booted (ADR-043): a write reaches the rows through the
 * engine's `land`, and the site learns it by reading `revisions`. That makes three frames out of
 * one cursor:
 *
 *  · `chapter:applied` — the write of a pass (the row names a step): the print's clock and the
 *    bounded delta (`applied.ts`, D1);
 *  · `chapter:created` — a create with **no** step (an import, an operator's restore of an empty
 *    slot): metadata and a `fetch` hint, never the text (ADR-004);
 *  · `chapter:revision` — any other stepless write (a restore, an operator's edit, an import):
 *    the same patch the watcher would have sent, so the two paths cannot drift.
 *
 * A block whose snapshot cannot be read still says what the row knows; the patch is then empty
 * and `patchTruncated` is true, which is a refetch for the client, not a guess.
 */

import {
  directionOf,
  isChapterNumber,
  partOf,
  type ChapterAppliedPayload,
  type ChapterCause,
  type ChapterCreatedPayload,
  type ChapterRevisionPayload,
  type FrontUpdatedPayload,
  type Lane,
  type ServerEventType,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { chapterEtag } from '../util/etag.ts';
import { readApplied } from './applied.ts';

type ChapterRow = { n: number; title: string | null; rev: number; chars: number; basis: number };

/** The `revisions` row a chapter frame is built from (§2.1 #4/#5/#6). */
export type RevisionEventRow = {
  chapter: number;
  rev: number;
  at: string;
  kind: string;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  attributed: number;
  hseq: number | null;
};

type RevisionRow = {
  chapter: number;
  rev: number;
  at: string;
  kind: string;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  attributed: number;
  hseq: number | null;
};

function chapterRow(db: Db, n: number): ChapterRow | undefined {
  return db.prepare('SELECT n, title, rev, chars, basis FROM chapters WHERE n = ?').get(n) as ChapterRow | undefined;
}

/** `chapter:applied` — the write, in the shape §2.1 #6 names. */
export function appliedFrame(
  db: Db,
  dataDir: string,
  chapter: number,
  rev: number,
): ChapterAppliedPayload | null {
  const read = readApplied({ db, dataDir, chapter, rev });
  if (read === null) return null;
  return {
    n: read.n,
    rev: read.rev,
    hseq: read.hseq,
    appliedAt: read.appliedAt,
    createdAt: read.createdAt,
    kind: read.kind,
    cause: read.cause,
    patch: read.patch,
    patchTruncated: read.patchTruncated,
    span: read.span,
    chars: read.chars,
    delta: read.delta,
    blocksTouched: read.blocksTouched,
    attributed: read.attributed,
  };
}

/** The cause block `chapter:created` carries; the lane is the step's, else the chapter's half. */
function createdCause(db: Db, row: RevisionRow, chapter: number): ChapterCause {
  const step =
    row.step_id === null
      ? undefined
      : (db.prepare('SELECT lane, lease_id FROM steps WHERE step_id = ?').get(row.step_id) as
          | { lane: Lane | null; lease_id: string | null }
          | undefined);
  const kind = row.change_id !== null ? 'change' : row.cascade_id !== null ? 'cascade' : row.kind === 'restore' ? 'restore' : 'operator';
  return {
    kind,
    lane: step?.lane ?? directionOf(chapter),
    leaseId: step?.lease_id ?? null,
    changeId: row.change_id,
    cascadeId: row.cascade_id,
    stepId: row.step_id,
  };
}

/**
 * `chapter:created` — a create with no step: the row and the chapter, nothing else. A create is
 * never a print: the typed text of a pass is `chapter:applied`, and a slot a reader has never
 * seen has no ink to move.
 */
export function createdFrame(db: Db, chapter: number, row: RevisionRow): ChapterCreatedPayload | null {
  if (!isChapterNumber(chapter)) return null;
  const chapterRow_ = chapterRow(db, chapter);
  if (chapterRow_ === undefined) return null;
  return {
    n: chapter,
    title: chapterRow_.title,
    rev: row.rev,
    chars: chapterRow_.chars,
    part: partOf(chapter),
    direction: directionOf(chapter),
    cause: createdCause(db, row, chapter),
    // ADR-004: the frame names the payload, it never carries the prose.
    fetch: { path: `/api/chapters/${String(chapter)}`, etag: chapterEtag(chapter, row.rev, chapterRow_.basis === 1) },
    createdAt: row.at,
    attributed: row.attributed === 1,
  };
}

/** `chapter:revision` — a stepless write: the same patch the watcher would have published. */
export function revisionFrame(db: Db, dataDir: string, chapter: number, row: RevisionRow): ChapterRevisionPayload | null {
  if (!isChapterNumber(chapter)) return null;
  const chapterRow_ = chapterRow(db, chapter);
  if (chapterRow_ === undefined) return null;
  const read = readApplied({ db, dataDir, chapter, rev: row.rev });
  return {
    n: chapter,
    rev: row.rev,
    hseq: row.hseq,
    title: chapterRow_.title,
    chars: read?.chars ?? chapterRow_.chars,
    delta: read?.delta ?? 0,
    kind: row.kind as ChapterRevisionPayload['kind'],
    cause: {
      changeId: row.change_id,
      cascadeId: row.cascade_id,
      wave: null,
      lane: read?.cause.lane ?? directionOf(chapter),
      direction: directionOf(chapter),
      stepId: row.step_id,
      seamsIn: [],
      seamsOut: [],
    },
    patch: read?.patch ?? [],
    patchTruncated: read?.patchTruncated ?? true,
    attributed: row.attributed === 1,
    updatedAt: row.at,
  };
}

/** Frames one emitter takes: the bridge's own `emit`, injected so this module owns no socket. */
export type FrameEmit = (type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown) => void;

export type NarratorDeps = { db: Db; dataDir: string; emit: FrameEmit };

/**
 * The chapter's frames, one class so the two cursors live beside the queries that move them:
 * `revisions.rowid` for the chapter domain, `front_revisions.rev` for the first sheet. A prime
 * skips what is already in the rows (a restart narrates nothing old); `replay` reads from zero.
 */
export class ChapterNarrator {
  private revision = 0;
  private front = 0;
  private readonly deps: NarratorDeps;

  constructor(deps: NarratorDeps) {
    this.deps = deps;
  }

  prime(replay: boolean): void {
    if (replay) {
      this.revision = 0;
      this.front = 0;
      return;
    }
    const revision = this.deps.db.prepare('SELECT MAX(rowid) AS id FROM revisions').get() as { id: number | null };
    const front = this.deps.db.prepare('SELECT MAX(rev) AS rev FROM front_revisions').get() as { rev: number | null };
    this.revision = revision.id ?? 0;
    this.front = front.rev ?? 0;
  }

  /** One poll: the write first (a print is clocked from it), then the first sheet. */
  tick(): number {
    return this.drainRevisions() + this.drainFront();
  }


  /**
   * One cursor, three frames: a write by a pass is `chapter:applied`; a create with no step is
   * `chapter:created`; any other stepless write is `chapter:revision`. The watcher keeps its
   * import path — this is the production path a `land` takes (ADR-043).
   */
  private drainRevisions(): number {
    const rows = this.deps.db
      .prepare(
        `SELECT rowid AS rowid, chapter, rev, at, kind, change_id, cascade_id, step_id, attributed, hseq
           FROM revisions WHERE rowid > ? ORDER BY rowid`,
      )
      .all(this.revision) as Array<RevisionEventRow & { rowid: number }>;
    let emitted = 0;
    for (const row of rows) {
      this.revision = row.rowid;
      if (row.step_id !== null) {
        const applied = appliedFrame(this.deps.db, this.deps.dataDir, row.chapter, row.rev);
        if (applied !== null) {
          this.deps.emit('chapter:applied', applied);
          emitted += 1;
        }
        continue;
      }
      if (row.rev === 1) {
        const created = createdFrame(this.deps.db, row.chapter, row);
        if (created !== null) {
          this.deps.emit('chapter:created', created);
          emitted += 1;
        }
        continue;
      }
      const revision = revisionFrame(this.deps.db, this.deps.dataDir, row.chapter, row);
      if (revision !== null) {
        this.deps.emit('chapter:revision', revision);
        emitted += 1;
      }
    }
    return emitted;
  }

  /** `front:updated` from `front_revisions.hseq` — a title step's write (`applyFront.ts`). */
  private drainFront(): number {
    const rows = this.deps.db
      .prepare('SELECT rev, title, about, hseq, at, change_id, step_id FROM front_revisions WHERE rev > ? ORDER BY rev')
      .all(this.front) as Array<{
      rev: number;
      title: string;
      about: string;
      hseq: number;
      at: string;
      change_id: string | null;
      step_id: string | null;
    }>;
    let emitted = 0;
    for (const row of rows) {
      this.front = row.rev;
      const payload: FrontUpdatedPayload = {
        title: row.title.length > 0 ? row.title : null,
        about: row.about.length > 0 ? row.about : null,
        rev: row.rev,
        previousRev: row.rev - 1,
        cause: {
          kind: row.change_id !== null ? 'change' : row.step_id !== null ? 'front' : 'operator',
          changeId: row.change_id,
          cascadeId: null,
          stepId: row.step_id,
        },
      };
      this.deps.emit('front:updated', payload);
      emitted += 1;
    }
    return emitted;
  }


}
