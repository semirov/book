/**
 * BOOK-145 — a step the engine already took away is not a failure of this pass (`pass.ts`, split
 * at the arch bound): the lane says so in one line, asks `next` again at once and never closes
 * the dead step; a run that landed puts its own text back first (BOOK-219).
 */

import type { PassResult } from './laneTypes.ts';
import type { Recovery } from './recovery.ts';

/** A step the engine already took away: a scheduling event, never a prose event. */
const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type GoneHelpers = {
  log: (line: string) => void;
  job: { stepId: string; changeId: string | null };
  recovery: Recovery;
  published: () => boolean;
};

function goneOf(helpers: GoneHelpers, code: string | null, detail: string): PassResult | null {
  if (code === null || !GONE_CODES.has(code)) return null;
  helpers.log(`lease released by the engine — taking the next filing (${code}: ${detail.slice(0, 120)})`);
  return {
    status: 'gone',
    stepId: helpers.job.stepId,
    changeId: helpers.job.changeId,
    reason: 'lease released by the engine — taking the next filing',
  };
}

/**
 * BOOK-145 + BOOK-219: the wall that took the step away is why `gone` is right, but a run that
 * landed has already published, so the text goes back first — `gone` on its own is the answer
 * only when the way back finds nothing of ours (`none`), exactly as the rights path tells it.
 */
export async function goneAfterBack(
  helpers: GoneHelpers,
  code: string | null,
  detail: string,
): Promise<PassResult | null> {
  const answer = goneOf(helpers, code, detail);
  if (answer === null) return null;
  if (!helpers.published()) return answer;
  const back = await helpers.recovery.takeBack('шаг снят движком');
  if (back.kind === 'unverified') helpers.log(`[writer] откат не подтверждён: ${back.detail}`);
  return answer;
}

