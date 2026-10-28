/**
 * The engine's one conversation with the derived index (BOOK-18 §2, §3).
 *
 * On close it compares the document statuses of the chapters the change actually rewrote —
 * reading «before» from the stored revision snapshot and «after» from the rows — and appends
 * **one** public statement per moved document. It does not rebuild the artifact: extraction
 * is memoised per chapter and the artifact is rebuilt on the next editor dispatch, outside
 * the close transaction, where it is actually read.
 *
 * A chapter with no usable pre-image is dropped instead of being reported as «everything
 * appeared»: a lost snapshot is an absence of evidence, not evidence of a new paper.
 *
 * Erring by design (BOOK-18 §4): a failed diff yields silence, not an error — the index is a
 * tool, and a tool that can stop a close would be a second source of truth. A failed *build*
 * at dispatch is reported through the engine's alert hook (see `reportIndexFailure`).
 */

import type { Db } from '../db/db.ts';
import { appendEvent } from '../history/log.ts';
import { documentMoves, type ChapterTextChange } from '../index/chronicle.ts';
import { toIso } from '../util/time.ts';
import { readSnapshot } from '../versions/snapshots.ts';
import * as store from './store.ts';
import { readChapterRows } from './text.ts';
import type { EngineDeps } from './types.ts';

/** The step outcomes that actually changed the file's prose. */
function rewrote(step: store.StepRow): boolean {
  return step.outcome === 'rewritten' || step.outcome === 'published_with_finding';
}

function snapshotText(deps: Pick<EngineDeps, 'db' | 'config'>, chapter: number, rev: number): string | null {
  if (rev <= 0) return null;
  const row = deps.db
    .prepare('SELECT snapshot FROM revisions WHERE chapter = ? AND rev <= ? ORDER BY rev DESC LIMIT 1')
    .get(chapter, rev) as { snapshot: string } | undefined;
  return row === undefined ? null : readSnapshot(deps.config.dataDir, row.snapshot);
}

/** Chapters this change rewrote, with the earliest pre-image each one had. */
export function changedChapters(
  deps: Pick<EngineDeps, 'db' | 'config'>,
  changeId: string,
): ChapterTextChange[] {
  const firstRev = new Map<number, number>();
  for (const step of store.stepsOfChange(deps.db, changeId)) {
    if (step.chapter === null || !rewrote(step)) continue;
    const rev = step.rev_before ?? 0;
    const known = firstRev.get(step.chapter);
    if (known === undefined || rev < known) firstRev.set(step.chapter, rev);
  }
  const chapters: ChapterTextChange[] = [];
  for (const [chapter, rev] of [...firstRev.entries()].sort(([left], [right]) => left - right)) {
    const before = snapshotText(deps, chapter, rev);
    // A revision existed but its snapshot is gone: the honest answer is no statement, not
    // «everything appeared». A chapter that never existed (rev 0) has no pre-image either.
    if (rev > 0 && before === null) continue;
    const now = readChapterRows(deps.db, chapter);
    chapters.push({ chapter, before, after: now.exists ? now.raw : null });
  }
  return chapters;
}

/** A statement is emitted once per change and document, even if close is retried. */
function publishedDocuments(db: Db, changeId: string): Set<string> {
  const rows = db
    .prepare(`SELECT payload FROM events WHERE change_id = ? AND kind = 'document.status'`)
    .all(changeId) as Array<{ payload: string }>;
  const documents = new Set<string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { document?: unknown };
      if (typeof payload.document === 'string') documents.add(payload.document);
    } catch {
      // A malformed payload is not worth a second statement.
    }
  }
  return documents;
}

export function publishIndexNotices(
  deps: EngineDeps,
  change: store.ChangeRow,
  now: number,
): void {
  try {
    const chapters = changedChapters(deps, change.id);
    if (chapters.length > 0) {
      const published = publishedDocuments(deps.db, change.id);
      for (const move of documentMoves(chapters)) {
        if (published.has(move.document)) continue;
        appendEvent(
          deps.db,
          {
            kind: 'document.status',
            changeId: change.id,
            cascadeId: change.cascade_id,
            payload: { document: move.document, surface: move.surface, chapters: move.chapters },
          },
          now,
        );
      }
    }
  } catch {
    // BOOK-18 §4: the index may be unsure; a close is never refused on its account.
  }
}

/**
 * One alert record when the artifact cannot be built or written at an editor dispatch — the
 * engine's hook logs it, so the failure is not silent. The gate still goes out without a
 * slice; the operator can inspect and fix the directory with `bin/index.mjs show|rebuild`.
 */
export function reportIndexFailure(deps: EngineDeps, stepId: string | null, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    deps.alert?.({
      kind: 'index',
      at: toIso(deps.clock.now()),
      changeId: null,
      cascadeId: null,
      stepId,
      detail: message.replace(/\s+/gu, ' ').trim().slice(0, 200),
    });
  } catch {
    // A failed alert must not become a failed dispatch either.
  }
}
