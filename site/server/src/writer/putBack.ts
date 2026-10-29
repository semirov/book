/**
 * The compensating revert of a writer pass (BOOK-219, AC3).
 *
 * Since BOOK-222 a pass lands its text as a **candidate**, so the ordinary exits leave nothing to
 * undo: the refusal drops it and the chapter keeps the text the site already serves. This module
 * is the safety net for the one land that still publishes — a **resumed** step, whose re-landing
 * the engine refuses to hold (there is no unserved revision to replace). When such a pass does not
 * reach `done`, its own landing is live, and the fix is an undo: the pass puts it back as a new
 * `restore` revision, proves the chapter reads the revision it started from (the returned sha is
 * the pre-pass sha), and marks that restore as reconciled so the panel stops asking about it.
 *
 * Three answers, and the caller says a different sentence for two of them:
 *
 *  · `none` — **this run** landed nothing of its own: a pass that never landed, and above all a
 *    resumed step that only read the gates (`landed` is *this run's* landing, never the step's
 *    `job.landed` — a resumed pass that re-lands holds its own revision and puts that one back);
 *    a chapter that no longer reads this pass's text belongs to somebody else's write;
 *  · `reverted` — the chapter is the pre-pass text again (verified by sha);
 *  · `unverified` — the restore itself did not complete (or there was no revision behind a first
 *    write, or the chapter could not be read). The landed text **stands**, and the park says so:
 *    the revision it stands at is in the detail, never dressed up as «nothing was published».
 *
 * Nothing here reads a file or holds a key: both doors are the engine's own (`/internal/restore`,
 * `/internal/reconcile`), and a refusal from either is a value, not a throw.
 */

import type { WriterAssignment } from '@book/shared';

import { parseChapter } from '../ingest/parseChapter.ts';
import type { ChapterTextView } from '../engine/text.ts';
import type { EngineClient } from './client.ts';
import { readerSentences, reasonOf } from './reasons.ts';

export type PutBackInput = {
  engine: Pick<EngineClient, 'restore' | 'reconcile' | 'text'>;
  job: Pick<WriterAssignment, 'stepId'>;
  chapter: number;
  /** What `start` said before the pass touched anything: the rev and sha a revert returns to. */
  started: { rev: number | null; sha: string };
  /** The last landing of this pass (`Lane.landedAt`), `null` before one or when unread. */
  landing: { rev: number; sha: string } | null;
  /** Whether **this run** landed at all — a resumed step's earlier landing is not counted. */
  landed: boolean;
  /** The text this pass landed: a chapter that no longer reads it is not ours to undo. */
  text: string;
  /** Why the way back is taken — the reconcile mark's own words, for the operator's page. */
  why: string;
  log: (line: string) => void;
};

export type PutBack =
  | { kind: 'none' }
  | { kind: 'reverted' }
  | { kind: 'unverified'; detail: string };

/** The body of a chapter text, as the rows carry it: what a landed text and a view compare by. */
function bodyOf(chapter: number, text: string): string {
  return parseChapter(chapter, text).blocks.map((block) => block.text).join('\n\n').trim();
}

/**
 * Does the site serve this text for this chapter? `true`/`false` from the rows, `null` when the
 * chapter cannot be read at all. The one question both the way back and a `land` whose answer was
 * lost ask: the rows are the fact, the response was a report about them.
 */
export async function servesText(
  engine: Pick<EngineClient, 'text'>,
  chapter: number,
  text: string,
): Promise<boolean | null> {
  let view: ChapterTextView | undefined;
  try {
    const answer = await engine.text([chapter]);
    view = answer.chapters.find((entry) => entry.n === chapter);
  } catch {
    return null;
  }
  if (view === undefined || !view.exists) return false;
  return view.text.trim() === bodyOf(chapter, text);
}

/**
 * The reader's sentence for a way back: `rights` is the refused-text story (a rights answer the
 * text never had), `gate` the prose gates'. `null` when nothing of this pass was put back.
 */
export function backSentence(back: PutBack, kind: 'gate' | 'rights' = 'gate'): string | null {
  if (back.kind === 'none') return null;
  if (kind === 'rights') {
    return back.kind === 'reverted' ? readerSentences.rightsReverted : readerSentences.rightsUnverified;
  }
  return back.kind === 'reverted' ? readerSentences.reverted : readerSentences.unverified;
}

export async function putBack(input: PutBackInput): Promise<PutBack> {
  // BOOK-219: the guard is *this run's* landing, never the step's (`job.landed`). A resumed step
  // whose gate said `revise` re-lands, and that re-landing is ours to put back.
  if (!input.landed) return { kind: 'none' };
  const rev = input.started.rev;
  const at = input.landing === null
    ? 'ревизия прохода неизвестна'
    : `текст стоит на ревизии ${String(input.landing.rev)}`;
  if (rev === null || rev < 1) return { kind: 'unverified', detail: `у главы нет ревизии до прохода — ${at}` };
  // BOOK-219: only the text this pass published may be taken back. A chapter somebody else has
  // written since is a newer fact, and undoing it would throw their work away.
  const ours = await servesText(input.engine, input.chapter, input.text);
  if (ours === null) return { kind: 'unverified', detail: `глава не прочитана — ${at}` };
  if (!ours) {
    input.log('[writer] откат не нужен: глава уже не та, что опубликовал проход');
    return { kind: 'none' };
  }

  try {
    const restored = await input.engine.restore(input.chapter, rev);
    if (restored.sha !== input.started.sha) {
      return { kind: 'unverified', detail: `откат вернул не ту редакцию: ${at}, а не ревизия ${String(rev)}` };
    }
    input.log(
      `[writer] откат: ревизия ${String(rev)} возвращена (${input.landing === null ? '—' : String(input.landing.rev)} → ${String(restored.rev)})`,
    );
    try {
      // The mark is the panel's, not the reader's: a refusal here cannot undo a text that is
      // already back, so it is logged and the park still says «возвращён».
      await input.engine.reconcile(
        input.chapter,
        `откат прохода ${input.job.stepId}: ${input.why}, текст возвращён к ревизии ${String(rev)}`,
      );
    } catch (error) {
      input.log(`[writer] сверка отката не отмечена: ${reasonOf(error)}`);
    }
    return { kind: 'reverted' };
  } catch (error) {
    return { kind: 'unverified', detail: `откат не выполнен: ${reasonOf(error)} — ${at}` };
  }
}
