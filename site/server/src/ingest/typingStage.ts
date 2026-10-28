/**
 * The `typing` stage (docs/writer-lane.md §1–§3): the revision is on the page and the reader's
 * page is printing it. Only a change-driven write is a lane stage — the site holds no counter,
 * and a hand edit or a machine-only revision carries no change to attribute it to.
 *
 * A stage is a fact about the page, not a condition of the write: a store that refuses the row
 * is logged and the revision stands.
 */

import type { AppliedChapter } from './applyChapter.ts';
import type { Db } from '../db/db.ts';
import { appendStage } from '../stages/repo.ts';

export function appendTypingStage(
  db: Db,
  chapter: AppliedChapter,
  now: number,
  log: (message: string, context: Record<string, unknown>) => void,
): void {
  const { changeId, stepId } = chapter.cause;
  if (changeId === null || stepId === null) return;
  try {
    appendStage(db, {
      chapter: chapter.n,
      passId: stepId,
      stage: 'typing',
      at: now,
      actor: { process: 'site', model: null },
      changeId,
      summary: `правка на странице: ревизия ${chapter.rev}, текст печатается`,
    });
  } catch (error) {
    log('stage not recorded', { n: chapter.n, error: error instanceof Error ? error.message : String(error) });
  }
}
