/**
 * One observed chapter file → the projection + one revision + one log entry (§6.3, §6F.1).
 *
 * This is the only function that may raise a chapter's `rev`; the boot scan, the watcher and
 * the engine's `land` all call it, so a rescan, a live write and an engine landing cannot
 * disagree. The revision, its `hseq`, the paragraph chain and the overwrite rows are written
 * in **one transaction** — if the log entry fails, the revision is not published.
 *
 * It never touches the manuscript: the file is already read by the caller.
 */

import { directionOf, partOf, type Lane, type PatchOp, type Part } from '@book/shared';

import type { Db } from '../db/db.ts';
import {
  getChapterRow,
  listBlocks,
  replaceBlocks,
  upsertChapterRow,
  type BlockRow,
  type ChapterRow,
} from '../db/repo/chapters.ts';
import { insertRevision } from '../db/repo/revisions.ts';
import { recordBlockRevision, type BlockOverwrite } from '../history/blocks.ts';
import { appendEvent } from '../history/log.ts';
import { reconcileChapterSentences } from '../sentences/ingest.ts';
import { applySentencePatch, type SentencePatchEdit } from '../sentences/transform.ts';
import { toIso } from '../util/time.ts';
import { writeSnapshot } from '../versions/snapshots.ts';
import { type BlockDiff, diffBlocks } from './diffBlocks.ts';
import {
  actorForCause,
  chapterWriteCause,
  revisionCauseKind,
  type WriteActor,
  type WriteCause,
} from './attribution.ts';
import { frameIntact } from './frameGuard.ts';
import { parseChapter, type ParsedChapter } from './parseChapter.ts';
import { PATCH_MAX_BYTES, patchBlocks, patchSize } from './patchBlocks.ts';
import { restoreCause, restoredFrom } from './restore.ts';

export type ApplyChapterInput = {
  db: Db;
  dataDir: string;
  n: number;
  raw: string;
  /** File mtime: the moment the text was written, not the moment the site saw it. */
  mtimeMs: number;
  nowMs: number;
  /**
   * An explicit attribution override. The engine calls this with the lease it holds; an
   * observer passes nothing and the live lease (if any) is discovered from the database.
   */
  attributed?: boolean;
  /** An explicit cause for a write that is not a step (a restore). */
  cause?: WriteCause;
  /**
   * BOOK-173: run inside **this** transaction, after the revision and its blocks are written.
   * The engine's `land` uses it to re-bind the chapter's mentions and to freeze the ripple plan,
   * so a crash leaves neither the revision nor the plan — the two are one write.
   */
  onPublished?: (published: { n: number; rev: number }) => void;
  /**
   * BOOK-173 §2, ADR-044 §2.2 — the patch this publish is *applying*, as one character edit per
   * block the writer named. A patch is the only write that knows where inside a paragraph it
   * changed anything, so it is the only write that may **keep sentence ids** across the change:
   * `applySentencePatch` re-segments the block and re-attaches ids by `text_hash` in this same
   * transaction. Absent for an observed file write (the watcher's, the boot scan's) — nobody there
   * is applying anything, so the reconcile below is the whole story (ADR-044 §3.1).
   */
  sentences?: ReadonlyArray<SentencePatchEdit>;
};

export type AppliedChapter = {
  n: number;
  rev: number;
  previousRev: number;
  title: string | null;
  chars: number;
  blocks: number;
  delta: number;
  writtenAt: string;
  updatedAt: string;
  diff: BlockDiff;
  patch: PatchOp[];
  patchTruncated: boolean;
  /** Part of the chapter in the book, for `chapter:created`; null for the opening and the finale. */
  part: Part | null;
  direction: Lane;
  /** The log entry this revision produced, and who caused it (§6F.1). */
  hseq: number;
  cause: WriteCause;
  actor: WriteActor;
  attributed: boolean;
  overwrites: BlockOverwrite[];
};

export type ApplyChapterResult =
  | { status: 'unchanged'; n: number }
  /** Zero blocks: an empty slot in progress, or a truncate-then-write the caller must guard. */
  | { status: 'empty'; n: number }
  /**
   * The file's frame is not the book's frame (ch01/ch42, BOOK-137): **nothing was published** —
   * no revision, no `rev` bump, no block replace, no log entry, no snapshot. The projection
   * keeps serving the canon sentence; the caller reports the refusal and moves on.
   */
  | { status: 'frame-rejected'; n: number }
  /**
   * The file now holds only its basis sentence (ch01/ch42): the slot is projected as that
   * one paragraph and stays unwritten — a legitimately empty slot, not an empty write
   * between two saves (§6.2, BOOK-6). The history is not touched.
   */
  | { status: 'emptied'; n: number }
  | ({ status: 'created' } & AppliedChapter)
  | ({ status: 'revised'; kind: 'edit' | 'rewrite' | 'restore' } & AppliedChapter);

const EMPTY_BLOCKS: BlockRow[] = [];

export function applyChapterFile(input: ApplyChapterInput): ApplyChapterResult {
  const { db, n } = input;
  const parsed = parseChapter(n, input.raw);
  const existing = getChapterRow(db, n);
  const observedAt = toIso(Math.min(input.mtimeMs, input.nowMs));

  // "Unchanged" must mean the projection already says what the file says: a row left with the
  // file's sha but no blocks (an install from before the basis projection, BOOK-6) is healed
  // by the next scan instead of staying empty forever.
  const unchanged =
    existing !== undefined &&
    existing.sha256 === parsed.sha256 &&
    existing.basis === (parsed.basis ? 1 : 0) &&
    existing.block_count === parsed.blocks.length;
  if (unchanged) return { status: 'unchanged', n };
  // A slot that holds only its basis sentence (ch01/ch42, BOOK-6) is projected as the one
  // paragraph the reader must see — and as nothing else: no revision, no log entry, no
  // snapshot, because nobody wrote it and it is not a chapter.
  if (parsed.basis) return projectBasis(db, n, existing, parsed, observedAt);
  if (parsed.blocks.length === 0) return { status: 'empty', n };
  // BOOK-137 — the frame is the one text a file may not move, and this is the choke point every
  // publisher goes through: the watcher, the boot scan and the engine's own ingest of a landing.
  // A file whose frame moved publishes nothing at all, because the reader would already be
  // reading the weakened sentence by the time a late `land` refused it. The projection keeps
  // the text and the `rev` it serves; putting the sentence back publishes normally.
  if (!frameIntact(n, input.raw)) return { status: 'frame-rejected', n };

  const observed = input.cause ?? chapterWriteCause(db, n, input.nowMs);
  // §13.3: with no lease, a text that is byte-identical to an earlier stored revision is a
  // rollback, not a hand edit. The site neither blocks it nor credits it to a change.
  const restored =
    input.cause === undefined && observed.leaseId === null ? restoredFrom(db, n, parsed.sha256) : null;
  const cause = restored === null ? observed : restoreCause(restored);
  const actor = actorForCause(db, cause);
  // `attributed` means «a live lease owns this write»; a restore has none, so it is false
  // by construction and the end matter and the panel must say so (F015).
  const attributed = input.attributed ?? (cause.kind !== 'restore' && actor.kind !== 'unattributed');
  /** Restores keep their own revision kind and event kind (§13.3 step 4). */
  const isRestore = cause.kind === 'restore';

  const run = db.transaction((): ApplyChapterResult => {
    const before: BlockRow[] = existing === undefined ? EMPTY_BLOCKS : listBlocks(db, n);
    if (existing === undefined) {
      upsertChapterRow(db, {
        n,
        rev: 1,
        title: parsed.title,
        sha256: parsed.sha256,
        chars: parsed.chars,
        blockCount: parsed.blocks.length,
        basis: false,
        writtenAt: observedAt,
        updatedAt: observedAt,
      });
      replaceBlocks(db, n, 1, parsed.blocks);
      // ADR-044: a published chapter has sentences from the moment it exists — the reader may
      // file against one before the next boot scan runs.
      reconcileChapterSentences(db, { chapter: n, before, after: parsed.blocks, at: observedAt });
      const snapshot = writeSnapshot(input.dataDir, n, parsed.sha256, parsed.text);
      const hseq = appendEvent(
        db,
        {
          kind: 'chapter.created',
          chapter: n,
          rev: 1,
          changeId: cause.changeId,
          cascadeId: cause.cascadeId,
          stepId: cause.stepId,
          authorKind: actor.kind,
          identityId: actor.identityId,
          authorLabel: actor.label,
          payload: {
            title: parsed.title,
            chars: parsed.chars,
            blocks: parsed.blocks.length,
            sha256: parsed.sha256,
            attributed,
          },
        },
        input.nowMs,
      );
      insertRevision(db, {
        chapter: n,
        rev: 1,
        at: observedAt,
        kind: 'create',
        causeKind: revisionCauseKind(cause),
        changeId: cause.changeId,
        cascadeId: cause.cascadeId,
        stepId: cause.stepId,
        added: parsed.blocks.length,
        changed: 0,
        removed: 0,
        snapshot,
        attributed,
        hseq,
        logNote: 'first sighting',
      });
      const recorded = recordBlockRevision({
        db,
        chapter: n,
        rev: 1,
        hseq,
        at: observedAt,
        nowMs: input.nowMs,
        before,
        after: parsed.blocks,
        cause,
        actor,
      });
      input.onPublished?.({ n, rev: 1 });
      return {
        status: 'created',
        n,
        rev: 1,
        previousRev: 0,
        title: parsed.title,
        chars: parsed.chars,
        blocks: parsed.blocks.length,
        delta: parsed.chars,
        writtenAt: observedAt,
        updatedAt: observedAt,
        diff: { added: parsed.blocks.length, changed: 0, removed: 0 },
        patch: [],
        patchTruncated: false,
        part: partOf(n),
        direction: directionOf(n),
        hseq,
        cause,
        actor,
        attributed,
        overwrites: recorded.overwrites,
      };
    }

    const diff = diffBlocks(
      before.map((block) => block.hash),
      parsed.blocks.map((block) => block.hash),
    );
    const rewrite = before.length > 0 && diff.changed + diff.removed >= before.length;
    const rev = existing.rev + 1;
    const patch = patchBlocks(before.length > 0 ? before : EMPTY_BLOCKS, parsed.blocks);
    const truncated = patchSize(patch) > PATCH_MAX_BYTES;
    const kind = isRestore ? 'restore' : rewrite ? 'rewrite' : 'edit';

    upsertChapterRow(db, {
      n,
      rev,
      title: parsed.title,
      sha256: parsed.sha256,
      chars: parsed.chars,
      blockCount: parsed.blocks.length,
      basis: false,
      writtenAt: existing.written_at,
      updatedAt: observedAt,
    });
    replaceBlocks(db, n, rev, parsed.blocks);
    // ADR-044 §2.2 / BOOK-173 §2 — **the unit rule**. A landing that carries the patch it is
    // applying re-segments the blocks it named and re-attaches sentence ids by `text_hash`, in this
    // transaction: a word fix keeps the id, an inserted full stop splits (left keeps it, right born
    // with `split_from`), a removed one merges, a deleted sentence erases. Only the blocks the
    // patch named are touched; every other block's rows are where they were.
    if (input.sentences !== undefined && input.sentences.length > 0) {
      applySentencePatch({
        db,
        chapter: n,
        changeId: cause.changeId,
        at: observedAt,
        edits: input.sentences,
      });
    }
    // ADR-044: the paragraphs this revision dropped have their sentences closed, the ones it
    // holds are segmented — inside the same transaction, so a failed publish leaves neither.
    // After `applySentencePatch` the edited blocks' rows already live under their new block ids, so
    // this reconcile finds the old ids empty (no close) and the new ones populated (no birth): the
    // ids the patch kept are exactly the ids the sentences keep.
    reconcileChapterSentences(db, { chapter: n, before, after: parsed.blocks, at: observedAt });
    const snapshot = writeSnapshot(input.dataDir, n, parsed.sha256, parsed.text);
    const hseq = appendEvent(
      db,
      {
        kind: isRestore ? 'chapter.restored' : 'chapter.revised',
        chapter: n,
        rev,
        changeId: cause.changeId,
        cascadeId: cause.cascadeId,
        stepId: cause.stepId,
        authorKind: actor.kind,
        identityId: actor.identityId,
        authorLabel: actor.label,
        payload: {
          title: parsed.title,
          chars: parsed.chars,
          blocks: parsed.blocks.length,
          sha256: parsed.sha256,
          kind,
          added: diff.added,
          changed: diff.changed,
          removed: diff.removed,
          attributed,
          ...(cause.restoredRev === undefined ? {} : { restoredRev: cause.restoredRev }),
        },
      },
      input.nowMs,
    );
    insertRevision(db, {
      chapter: n,
      rev,
      at: observedAt,
      kind,
      causeKind: revisionCauseKind(cause),
      changeId: cause.changeId,
      cascadeId: cause.cascadeId,
      stepId: cause.stepId,
      added: diff.added,
      changed: diff.changed,
      removed: diff.removed,
      snapshot,
      attributed,
      hseq,
      logNote: cause.kind === 'restore' ? `restore of rev ${cause.restoredRev ?? '?'}` : null,
    });
    const recorded = recordBlockRevision({
      db,
      chapter: n,
      rev,
      hseq,
      at: observedAt,
      nowMs: input.nowMs,
      before,
      after: parsed.blocks,
      cause,
      actor,
    });

    input.onPublished?.({ n, rev });
    return {
      status: 'revised',
      kind,
      n,
      rev,
      previousRev: existing.rev,
      title: parsed.title,
      chars: parsed.chars,
      blocks: parsed.blocks.length,
      delta: parsed.chars - existing.chars,
      writtenAt: existing.written_at,
      updatedAt: observedAt,
      diff,
      patch,
      patchTruncated: truncated,
      part: partOf(n),
      direction: directionOf(n),
      hseq,
      cause,
      actor,
      attributed,
      overwrites: recorded.overwrites,
    };
  });

  try {
    return run();
  } catch (error) {
    // Two processes observe the same write (the site's watcher and the engine's `land`).
    // The loser of the race finds the revision already published: if the text agrees, the
    // fact exists and the call is a no-op — never a second revision and never a 500.
    if (isConstraintError(error) && getChapterRow(db, n)?.sha256 === parsed.sha256) {
      return { status: 'unchanged', n };
    }
    throw error;
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/u.test(error.message);
}

/**
 * Project a slot that is exactly its basis sentence (§BOOK-6), whether it was emptied down
 * to that sentence or first seen with it. The frozen sentence becomes the chapter's one
 * paragraph — the reader must see the opening of chapter 1 and the close of chapter 42 — and
 * nothing else changes: `chars = 0`, `basis = 1`, `written` stays false everywhere, and
 * there is no revision, log entry or snapshot, because nobody wrote it. A former chapter's
 * append-only history stays as it is.
 *
 * The slot's own heading is kept as `chapters.title` (the owner's «Замечаний нет» above the
 * frozen first sentence): the contents and the chapter header print it, and it is a title,
 * not a length — `chars` stays 0, so F007's floor never sees it.
 */
function projectBasis(
  db: Db,
  n: number,
  existing: ChapterRow | undefined,
  parsed: ParsedChapter,
  observedAt: string,
): ApplyChapterResult {
  const rev = existing?.rev ?? 0;
  const run = db.transaction(() => {
    const before: BlockRow[] = existing === undefined ? EMPTY_BLOCKS : listBlocks(db, n);
    upsertChapterRow(db, {
      n,
      rev,
      title: parsed.title,
      sha256: parsed.sha256,
      chars: 0,
      blockCount: parsed.blocks.length,
      basis: true,
      writtenAt: existing?.written_at ?? observedAt,
      updatedAt: observedAt,
    });
    // The chapter row must exist first: `blocks` references it.
    replaceBlocks(db, n, rev, parsed.blocks);
    // A basis slot is one paragraph the reader sees: it gets its sentence like any other text, and
    // the prose it replaced closes.
    reconcileChapterSentences(db, { chapter: n, before, after: parsed.blocks, at: observedAt });
  });
  run();
  return { status: 'emptied', n };
}

/**
 * Remove a chapter whose file disappeared. Files win, always (§18).
 *
 * The sentences go with it: the chapter's paragraphs are closed first (`erased_at`), inside one
 * transaction, so a filing that hung on one of them is not left pointing at a live row of text
 * nobody can read any more. The rows themselves stay — a sentence is history (ADR-044 §2.4).
 */
export function removeChapter(db: Db, n: number): { status: 'removed'; n: number } | { status: 'absent'; n: number } {
  const existing = getChapterRow(db, n);
  if (existing === undefined) return { status: 'absent', n };
  const run = db.transaction(() => {
    reconcileChapterSentences(db, { chapter: n, before: listBlocks(db, n), after: [], at: toIso(Date.now()) });
    db.prepare('DELETE FROM chapters WHERE n = ?').run(n);
  });
  run();
  return { status: 'removed', n };
}
