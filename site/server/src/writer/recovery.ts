/**
 * BOOK-219's invariant, in one place: **a pass either closes with `done`, or the chapter goes
 * back to the revision the pass found.** There is no third exit.
 *
 * Four doors lead out of a pass without a close — a gate that never answered, a rights refusal
 * (the worst: the engine already closed the step as `escalated:rights` over live text), an
 * unparsable gate answer, and a close the engine refused. Each of them calls `takeBack` and then
 * `parkAfter`, so the sentence the reader reads is always a true one: the text went back, or it
 * stands without the check it never had.
 *
 * The state is read through getters because it moves: the revision the pass started from is known
 * only after `start`, and the landing only after `land`.
 */

import type { WriterAssignment } from '@book/shared';

import type { EngineClient } from './client.ts';
import type { Lane, PassResult } from './passLane.ts';
import { backSentence, putBack, type PutBack } from './putBack.ts';
import type { ParkInput } from './reasons.ts';

export type RecoveryState = {
  /** The revision `start` named, `null` before one. */
  rev: () => number | null;
  /** The sha `start` named. */
  sha: () => string;
  /** Whether **this run** landed anything (a resumed step's earlier landing is not counted). */
  landed: () => boolean;
  /** The text as it now stands: the last revision this run landed. */
  text: () => string;
};

export type Recovery = {
  /** Put this pass's own landing back; `none` when there is nothing of ours to undo. */
  takeBack(why: string): Promise<PutBack>;
  /** Park after the way back: the sentence says what happened to the text, the detail keeps why. */
  parkAfter(why: ParkInput, back: PutBack, kind?: 'gate' | 'rights'): Promise<PassResult>;
};

export function createRecovery(input: {
  engine: Pick<EngineClient, 'restore' | 'reconcile' | 'text'>;
  lane: Pick<Lane, 'park' | 'landedAt'>;
  job: Pick<WriterAssignment, 'stepId'>;
  chapter: number;
  state: RecoveryState;
  log: (line: string) => void;
}): Recovery {
  const { engine, lane, job, chapter, state, log } = input;

  async function takeBack(why: string): Promise<PutBack> {
    return await putBack({
      engine,
      job,
      chapter,
      started: { rev: state.rev(), sha: state.sha() },
      landing: lane.landedAt(),
      landed: state.landed(),
      text: state.text(),
      why,
      log,
    });
  }

  async function parkAfter(why: ParkInput, back: PutBack, kind: 'gate' | 'rights' = 'gate'): Promise<PassResult> {
    const sentence = backSentence(back, kind);
    const detail = back.kind === 'unverified' ? `${why.detail} · ${back.detail}`.slice(0, 300) : why.detail;
    return await lane.park({ ...why, ...(sentence === null ? {} : { sentence }), detail });
  }

  return { takeBack, parkAfter };
}
