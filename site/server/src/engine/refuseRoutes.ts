/**
 * `POST /internal/refuse` — the refusal's own door (owner's invariant, 2026-10-29).
 *
 * The writer stops a step and means «this filing is not taken»: the chapter goes back to the
 * revision the pass started from, the change closes `void · dropped` with the sentence, and the
 * reader who filed is told «не принято» in words. One of `leaseId` / `stepId` names the step —
 * the writer holds a lease and says so, an operator or the reaper names the step — and
 * `because` is the public sentence as the reader will read it.
 *
 * A refusal that cannot put the text back answers `TEXT_STUCK` and closes nothing; the step stays
 * open and the operator can see what is stuck (`refuse.ts`).
 *
 * It lives apart from `control.ts` for the same reason the triage routes do: the control app
 * registers a door per module, and the domain module stays free of Fastify.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Engine } from './service.ts';

const id = z.string().min(1).max(80);

const refuseBody = z
  .object({
    leaseId: id.optional(),
    stepId: id.optional(),
    because: z.string().min(1).max(400),
    /** `failed` when the pass broke rather than refused the work — a broken pass is not a refusal. */
    cause: z.enum(['refused', 'failed']).optional(),
  })
  .refine((value) => (value.leaseId === undefined) !== (value.stepId === undefined), {
    message: 'exactly one of leaseId|stepId is required',
  });

export function registerRefuseRoutes(app: FastifyInstance, engine: Engine): void {
  app.post('/internal/refuse', async (request) => {
    const body = refuseBody.parse(request.body ?? {});
    const premiseCause = body.cause;
    return {
      ok: true,
      data:
        body.leaseId === undefined
          ? engine.refuse({
              stepId: body.stepId ?? '',
              because: body.because,
              ...(premiseCause === undefined ? {} : { premiseCause }),
            })
          : engine.refuse({
              leaseId: body.leaseId,
              because: body.because,
              ...(premiseCause === undefined ? {} : { premiseCause }),
            }),
    };
  });
}
