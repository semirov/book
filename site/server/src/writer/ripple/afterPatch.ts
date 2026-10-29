/**
 * The pass's half of the ripple seam (BOOK-173, BOOK-DOC-75 §3, §5, §7).
 *
 * `land` answers with the plan the engine froze; this module turns that answer into the three
 * things the pass is allowed to do about it — continue, continue with a judged closure, or park —
 * and emits the one reader line each of them owes. It stays out of `pass.ts` on purpose: the pass
 * is at the 500-line wall, and this is a rule with its own tests, not a step of the pipeline.
 *
 * The judge is called **only** for a `ripple`, **only** over the closure, and before the gates
 * spend anything on a chapter that is not yet the change's own. Its three answers:
 *
 *   · `HOLDS`            → the gates of the origin chapter run as they always do;
 *   · `GAP: <sentence>`  → the change is escalated with that sentence; no gate, no second call;
 *   · a refusal to parse → escalated as well. An answer nobody could read is not a HOLDS.
 *
 * A `wide` never reaches the judge: the author decides, and the pass parks with the design's
 * sentence (§3). The point patch stays landed — its `landed` stage was already written — and the
 * escalation carries the plan's numbers, so the decision arrives priced.
 */

import type { WriterAssignment } from '@book/shared';

import type { RipplePlan } from '../../ledger/graph/plan.ts';
import type { Lane } from '../passLane.ts';
import { buildJudgePrompt, judgeCausality } from './judge.ts';
import { planSummary, reactToLanding, wideSentence } from './planAfterPatch.ts';

export type AfterPatchInput = {
  /** The plan the engine returned on `land`; absent for every pass that is not a point patch. */
  plan: RipplePlan | null | undefined;
  chapter: number;
  job: WriterAssignment;
  lane: Lane;
  bookRoot: string;
  now: () => number;
  log: (line: string) => void;
};

export type AfterPatchResult =
  | { kind: 'continue' }
  | { kind: 'park'; sentence: string; cause?: 'refused' };

/** The closure as the judge reads it, asked once and paid for by the lane's own accounting. */
async function judge(input: AfterPatchInput, plan: RipplePlan): Promise<AfterPatchResult> {
  const prompt = buildJudgePrompt({ bookRoot: input.bookRoot, plan });
  const verdict = await judgeCausality({
    prompt,
    ask: async (built) =>
      (
        await input.lane.ask('judge', [
          { role: 'system', content: built.system },
          { role: 'user', content: built.user },
        ])
      ).text,
    log: input.log,
  });
  if (!verdict.ok) {
    // A refusal to parse is a refusal of the closure: the book keeps its last barrier and the
    // change goes to the author with the reason, not with a silent pass.
    return {
      kind: 'park',
      cause: 'refused',
      sentence: `судья причинности не смог ответить на замыкание — правка на месте в книге (глава ${String(input.chapter)}), остальное решает автор`,
    };
  }
  if (verdict.verdict === 'HOLDS') return { kind: 'continue' };
  return {
    kind: 'park',
    cause: 'refused',
    sentence: `замыкание не держится: ${verdict.sentence}`.slice(0, 300),
  };
}

/**
 * React to the landing. A stage is emitted for every outcome the reader must see: the plan line on
 * the origin pass (`read`, per §7) and nothing else — a `wide`'s sentence is the `refused` stage
 * `park` already writes.
 */
export async function afterPatch(input: AfterPatchInput): Promise<AfterPatchResult> {
  const reaction = reactToLanding(input.plan);
  if (reaction.kind === 'continue') return { kind: 'continue' };

  if (reaction.kind === 'wide') {
    input.log(`[writer] ripple wide: ${planSummary(reaction.plan)} — проход паркуется до денег`);
    return {
      kind: 'park',
      sentence: `${wideSentence(reaction.plan)} · план: ${planSummary(reaction.plan)}`.slice(0, 380),
    };
  }

  await input.lane.emit({
    stage: 'read',
    chapter: input.chapter,
    passId: input.job.stepId,
    changeId: input.job.changeId,
    summary: reaction.line,
    model: null,
    at: input.now(),
  });
  return judge(input, reaction.plan);
}
