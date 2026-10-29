/**
 * The writer's answer to a base that moved (§6A.7, BOOK-219) — the one place `start` is called.
 *
 * Under FIFO a change is nearly always recorded against a revision an earlier change has since
 * rewritten: `engine.start` then refuses `RELEVANCE_DECISION` and hands the judgement to the
 * writer. That is the normal case, not a dead end, so the lane answers it itself: it re-reads the
 * chapter it is about and calls `start` once more with `adapt`, the assignment's own intent and a
 * public sentence naming the base that moved. No new prompt, no model call — a filing is always
 * read. Anything else the engine refuses (a released lease, a wall, a broken contract) is returned
 * as a failure, and the pass branches on its code exactly as it did before.
 */

import type { WriterAssignment } from '@book/shared';

import type { EngineClient, StartView } from './client.ts';
import type { Lane } from './passLane.ts';
import { codeOf, failureOf, reasonOf, type Failure } from './reasons.ts';

export type StartInput = {
  engine: Pick<EngineClient, 'start'>;
  lane: Pick<Lane, 'loadText'>;
  job: WriterAssignment;
  chapter: number;
  log: (line: string) => void;
};

export type OpenResult = { ok: true; started: StartView } | { ok: false; failure: Failure };

/** The public reason an adaptation records: the moved base, in one sentence, no code word. */
export function movedBaseReason(chapter: number): string {
  return `основание сдвинулось: заявка применена к текущей редакции главы ${String(chapter)}`;
}

/** The intent an adapted change carries: the assignment's own, never an invented one. */
export function intentOf(job: WriterAssignment): string {
  return job.intent?.value ?? job.premise?.intent.value ?? '';
}

export async function startWriting(input: StartInput): Promise<OpenResult> {
  try {
    return { ok: true, started: await input.engine.start(input.job.leaseId) };
  } catch (error) {
    // Only the moved base is the writer's to answer; every other refusal is the pass's decision.
    if (codeOf(error) !== 'RELEVANCE_DECISION') return { ok: false, failure: failureOf(error) };
  }
  let started: StartView;
  try {
    await input.lane.loadText([input.chapter]);
    started = await input.engine.start(input.job.leaseId, {
      decision: 'adapt',
      intent: intentOf(input.job),
      reason: movedBaseReason(input.chapter),
    });
  } catch (error) {
    return { ok: false, failure: failureOf(error) };
  }
  const rev = started.expectedRev;
  input.log(
    rev === undefined
      ? `[writer] relevance: adapt к текущей редакции главы ${String(input.chapter)}`
      : `[writer] relevance: adapt к редакции ${String(rev)}`,
  );
  return { ok: true, started };
}

/**
 * A **resumed** step's base (BOOK-219): `start` on a step that already landed answers the revision
 * it stands at and touches nothing, so it is the read for "what does a revert return to". The pass
 * needs it because a resumed step's gate may still say `revise`, and the re-landing that follows is
 * this run's own — it must have a revision to go back to. A refusal here only leaves the base
 * unknown, which the way back reports as such; it never stops the pass.
 */
export async function resumeBase(input: Omit<StartInput, 'lane'>): Promise<{ rev: number | null; sha: string }> {
  try {
    const started = await input.engine.start(input.job.leaseId);
    return { rev: typeof started.revAfter === 'number' ? started.revAfter : null, sha: started.sha ?? '' };
  } catch (error) {
    input.log(`[writer] база возобновлённого шага не прочитана: ${reasonOf(error)}`);
    return { rev: null, sha: '' };
  }
}
