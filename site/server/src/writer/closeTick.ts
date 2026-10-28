/**
 * The pass's close (`POST /internal/done`), one retry, typed (BOOK-117, BOOK-173 §4/§5).
 *
 * `done` is the only call that ends the pass, and the two ways it can fail are not the same: a
 * transport failure is retried once (the call is idempotent by design), while `STEP_CLOSED` says
 * the engine already closed the step — which is the close this pass asked for, not a failure. It
 * lives outside `pass.ts` because the pass is at the file-size wall and this is a rule with its own
 * tests, not a step of the sequence.
 */

import type { DoneInput, DoneView, EngineClient } from './client.ts';
import { failureOf, isTransportFailure, type Failure } from './reasons.ts';

export type CloseTick = { closed: DoneView | null; failure: Failure | null };

/** `stepId` is the step the pass is closing: `STEP_CLOSED` still answers with a real step id. */
export async function closeTick(input: {
  engine: EngineClient;
  stepId: string;
  body: DoneInput;
  log: (line: string) => void;
}): Promise<CloseTick> {
  let failure: Failure | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const closed = await input.engine.done(input.body);
      return { closed, failure };
    } catch (error) {
      failure = failureOf(error);
      // The step is closed either way; `done` on it is a no-op, and the pass says what it did.
      if (failure.code === 'STEP_CLOSED') {
        return {
          closed: { stepId: input.stepId, outcome: 'already-closed', cascadeId: null, changeStatus: null },
          failure: null,
        };
      }
      if (!isTransportFailure(failure) || attempt > 0) break;
      input.log(`[writer] done не прошёл (${failure.code ?? 'транспорт'}): ${failure.detail} — повтор`);
    }
  }
  return { closed: null, failure };
}
