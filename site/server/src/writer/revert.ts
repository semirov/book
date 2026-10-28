/**
 * `--revert --chapter N` (`docs/writer-lane.md` §5): undo the last change to a chapter.
 *
 * Since BOOK-187 the undo is a **new revision**, not a file put back (ADR-043 §3 row 9): the
 * engine reads the target revision's snapshot text, publishes it through the same applier every
 * other write goes through, and records it with `cause_kind = 'restore'`. The writer writes
 * nothing at all — it keeps no pre-image, because a landing that is refused touches nothing, so
 * the rows the site serves *are* the pre-image.
 *
 * What the writer does is say what happened: it prints the revision the engine published, the one
 * it replaced and the sha of the restored text, and then asks for the operator's mark
 * (`POST /internal/reconcile`) — the restore is published without gates, and the mark is what
 * closes that gap.
 */

import { TOTAL_CHAPTERS, isChapterNumber } from '@book/shared';

import type { EngineClient, RestoreView } from './client.ts';
import { reasonOf } from './reasons.ts';

export type RevertInput = {
  chapter: number;
  engine: EngineClient;
  /** A revision to bring back; omitted means the one before the current («undo the last change»). */
  rev?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type RevertOutcome = {
  status: 'reverted' | 'nothing' | 'failed';
  chapter: number;
  /** Where the text came from: the site's history, always — the writer keeps no pre-image. */
  source: 'site-history';
  /** The revision the chapter carries after the call, and the one it had before. */
  rev: number | null;
  previousRev: number | null;
  /** sha256 of the text the applier stored — the hash the operator checks. */
  sha: string | null;
  /** The engine named a hash and a revision: the answer is a fact, not a claim. */
  verified: boolean;
  reconciled: boolean;
  reason?: string;
};

const SHA256 = /^[0-9a-f]{64}$/u;

function baseOutcome(chapter: number): RevertOutcome {
  return {
    status: 'failed',
    chapter,
    source: 'site-history',
    rev: null,
    previousRev: null,
    sha: null,
    verified: false,
    reconciled: false,
  };
}

function outcomeOf(chapter: number, answer: RestoreView): RevertOutcome {
  return {
    status: 'failed',
    chapter,
    source: 'site-history',
    rev: answer.rev,
    previousRev: answer.previousRev,
    sha: answer.sha,
    verified: SHA256.test(answer.sha),
    reconciled: false,
  };
}

export async function revertChapter(input: RevertInput): Promise<RevertOutcome> {
  const log = input.log ?? (() => undefined);
  const { chapter } = input;
  const base = baseOutcome(chapter);
  if (!isChapterNumber(chapter)) {
    return { ...base, reason: `главы ${String(chapter)} нет: глава — число от 1 до ${String(TOTAL_CHAPTERS)}` };
  }
  if (input.dryRun === true) {
    // A restore is a revision: there is no way to preview one without publishing it. The dry run
    // says so instead of pretending the chapter would move.
    log(`глава ${String(chapter)}: dry-run — восстановление публикует новую ревизию; ничего не опубликовано`);
    return {
      ...base,
      status: 'nothing',
      reason: 'dry-run: ревизия не опубликована',
    };
  }

  let answer: RestoreView;
  try {
    answer = await input.engine.restore(chapter, input.rev);
  } catch (error) {
    return { ...base, reason: reasonOf(error) };
  }

  const outcome = outcomeOf(chapter, answer);
  if (!outcome.verified) {
    return { ...outcome, status: 'failed', reason: 'движок не назвал sha восстановленного текста' };
  }
  log(
    `глава ${String(chapter)}: новая ревизия ${String(answer.rev)} (было ${String(answer.previousRev)}), sha ${answer.sha}`,
  );
  if (answer.rev === answer.previousRev) {
    log(`глава ${String(chapter)}: текст уже совпадает с этой ревизией — восстанавливать нечего`);
    return { ...outcome, status: 'nothing' };
  }

  // The restored text is published without gates; the operator's mark is what closes that gap.
  let reconciled = false;
  try {
    await input.engine.reconcile(
      chapter,
      `revert: глава вернулась к ревизии ${String(answer.previousRev)} (sha ${answer.sha})`,
    );
    reconciled = true;
  } catch (error) {
    log(`глава ${String(chapter)}: reconcile не выполнен — ${reasonOf(error)}`);
  }
  return { ...outcome, status: 'reverted', reconciled };
}
