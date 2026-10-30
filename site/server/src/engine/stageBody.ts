/**
 * The lane stage's request body (`docs/writer-lane.md §2`): the shape is checked here, the
 * vocabulary and the bounds are `stage.ts`'s job, and `chapter`/`changeId` come from the step,
 * never from the body. Split from `control.ts` when §10.8's fields pushed it past the arch bound.
 */

import { z } from 'zod';

const id = z.string().min(1).max(80);

/**
 * A lane stage (`docs/writer-lane.md §2`): the shape is checked here, the vocabulary and the bounds
 * are `stage.ts`'s job, and `chapter`/`changeId` come from the step, never from the body.
 */
export const stageBody = z.object({
  passId: id,
  stageSeq: z.number().int().min(1).max(1_000_000).nullish(),
  stage: z.string().min(1).max(32),
  at: z.number().int().min(0),
  actor: z.object({ process: z.string().min(1).max(32), model: z.string().max(120).nullish() }),
  summary: z.string().min(1).max(4_000),
  span: z
    .array(
      z.object({
        blockId: z.string().max(120).nullish(),
        before: z.string().max(20_000),
        after: z.string().max(20_000),
        truncated: z.boolean().optional(),
      }),
    )
    .max(64)
    .nullish(),
  tokens: z.object({ in: z.number().int().min(0), out: z.number().int().min(0) }).nullish(),
  costUsd: z.number().min(0).max(1_000_000).nullish(),
  // BOOK-DOC-84 §10.8 — the ladder's facts; `normalizeStageEvent` validates the vocabulary and
  // the store fills `attempt`/`iteration` from its own rows when the writer leaves them out.
  attempt: z.number().int().min(1).max(6).nullish(),
  maxAttempts: z.number().int().min(5).max(6).nullish(),
  widened: z.string().max(40).nullish(),
  desperate: z.boolean().optional(),
  gate: z.enum(['editor', 'consultant', 'rights']).nullish(),
  round: z.number().int().min(1).max(5).nullish(),
  iteration: z.number().int().min(0).max(4).nullish(),
  verdict: z.enum(['HOLDS', 'GAP', 'CLEAR', 'REFUSED']).nullish(),
  deadlineAt: z.number().int().min(0).nullish(),
});

