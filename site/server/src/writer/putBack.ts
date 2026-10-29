/**
 * The compensating revert of a writer pass (BOOK-219, AC3).
 *
 * The engine dispatches a gate only for a **landed** step (`engine/gates.ts` `NOT_LANDED`), so a
 * pass must publish before its verdict can exist. When the gate never answers, the text it
 * published is not a decision but it *is* live, and the reader was being told «заявка остаётся в
 * очереди» over a revision nobody checked. The fix is therefore not a reorder — it is an undo:
 * the pass puts its own landing back as a new `restore` revision, proves the chapter reads the
 * revision it started from (the returned sha is the pre-pass sha), and marks that restore as
 * reconciled so the panel stops asking about it.
 *
 * Three answers, and the caller says a different sentence for two of them:
 *
 *  · `none` — this pass landed nothing of its own. A **resumed** step's text was published before
 *    this run and is not ours to undo (`job.landed`), and a pass that never landed has nothing to
 *    put back;
 *  · `reverted` — the chapter is the pre-pass text again (verified by sha);
 *  · `unverified` — the restore itself did not complete (or there was no revision behind a first
 *    write). The landed text **stands**, and the park says so: the revision it stands at is in the
 *    detail, never dressed up as «nothing was published».
 *
 * Nothing here reads a file or holds a key: both doors are the engine's own (`/internal/restore`,
 * `/internal/reconcile`), and a refusal from either is a value, not a throw.
 */

import type { WriterAssignment } from '@book/shared';

import type { EngineClient } from './client.ts';
import { reasonOf } from './reasons.ts';

export type PutBackInput = {
  engine: Pick<EngineClient, 'restore' | 'reconcile'>;
  job: Pick<WriterAssignment, 'stepId' | 'landed'>;
  chapter: number;
  /** What `start` said before the pass touched anything: the rev and sha a revert returns to. */
  started: { rev: number | null; sha: string };
  /** The last landing of this pass (`Lane.landedAt`), `null` before one. */
  landing: { rev: number; sha: string } | null;
  /** Whether this run landed at all. */
  landed: boolean;
  log: (line: string) => void;
};

export type PutBack =
  | { kind: 'none' }
  | { kind: 'reverted' }
  | { kind: 'unverified'; detail: string };

export async function putBack(input: PutBackInput): Promise<PutBack> {
  if (input.job.landed === true || !input.landed) return { kind: 'none' };
  const rev = input.started.rev;
  const at = `текст стоит на ревизии ${String(input.landing?.rev ?? 0)}`;
  if (rev === null || rev < 1) return { kind: 'unverified', detail: `у главы нет ревизии до прохода — ${at}` };

  try {
    const restored = await input.engine.restore(input.chapter, rev);
    if (restored.sha !== input.started.sha) {
      return { kind: 'unverified', detail: `откат вернул не ту редакцию: ${at}, а не ревизия ${String(rev)}` };
    }
    input.log(
      `[writer] откат: ревизия ${String(rev)} возвращена (${String(input.landing?.rev ?? 0)} → ${String(restored.rev)})`,
    );
    try {
      // The mark is the panel's, not the reader's: a refusal here cannot undo a text that is
      // already back, so it is logged and the park still says «возвращён».
      await input.engine.reconcile(
        input.chapter,
        `откат прохода ${input.job.stepId}: гейт не ответил, текст возвращён к ревизии ${String(rev)}`,
      );
    } catch (error) {
      input.log(`[writer] сверка отката не отмечена: ${reasonOf(error)}`);
    }
    return { kind: 'reverted' };
  } catch (error) {
    return { kind: 'unverified', detail: `откат не выполнен: ${reasonOf(error)} — ${at}` };
  }
}
