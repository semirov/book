/**
 * Gate B on the prose surface (BOOK-61, BOOK-DOC-42 §1, §3) — the conditional rights gate.
 *
 * The engine does not judge prose and does not read law: it asks, code records, and the
 * sentence a reader sees is fixed per rule id in `rights/rules.ts`. Two acts live here:
 *
 *   • `next` — hand a prose step that has no rights verdict to a rights session. A **flagged**
 *     scan is the question this gate exists for; a **clean** one is offered too (owner,
 *     2026-10-28) so the record says what was checked — the session answers it without a model
 *     call, which keeps Gate B at no model cost when the scan is clean.
 *   • `verdict` — record `CLEAR` or `REFUSED`. `CLEAR` lifts the requirement and the step
 *     closes as usual; `REFUSED` closes it at once as `escalated:rights`, with the rule's
 *     own sentence as the change's public reason. A refusal is a decision about the text,
 *     so there is nothing left for the writer to finish.
 *
 * Both surfaces are separate from the two prose gates on purpose: B answers another
 * question, with another enum, and one gate's word never stands for another's.
 */

import { NOTE_MAX_CHARS, REASON_MAX_CHARS } from '@book/shared';

import { appendEvent } from '../history/log.ts';
import { rightsRefusalLine } from '../rights/rules.ts';
import { toIso } from '../util/time.ts';
import { closeStep } from './close.ts';
import {
  PROSE_PASSES,
  openRightsDispatch,
  recordRightsVerdict,
  type RightsAnswer,
  type RightsAssignment,
} from './gates.ts';
import * as store from './store.ts';
import { refuse, type EngineDeps } from './types.ts';

export type RightsVerdictResult = { verdict: string; action: 'close' | 'escalate'; closed: boolean };

export function createRightsGate(deps: EngineDeps) {
  const { db } = deps;
  const iso = (ms: number = deps.clock.now()): string => toIso(ms);

  function next(session: string): RightsAssignment | null {
    for (const step of store.listOpenSteps(db)) {
      if (step.landed_at === null) continue;
      // BOOK-61 + the owner's rule of 2026-10-28: every prose pass carries a rights answer. A
      // clean scan is offered too — the session answers it mechanically, without a model call.
      if (!PROSE_PASSES.has(step.pass)) continue;
      if (store.getVerdict(db, step.step_id, 'rights')) continue;
      const existing = store.getDispatch(db, step.step_id, 'rights');
      if (existing && existing.session !== session && existing.expires_at > iso()) continue;
      try {
        return openRightsDispatch(deps, step, session);
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'GATE_ANSWERED') {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  function verdict(stepId: string, answer: RightsAnswer & { session: string }): RightsVerdictResult {
    const at = deps.clock.now();
    const step = store.getStep(db, stepId);
    if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${stepId}`);
    if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${stepId} is closed`);
    const recorded = recordRightsVerdict(deps, step, answer, answer.session);
    appendEvent(
      db,
      {
        kind: 'gate.recorded',
        stepId,
        cascadeId: step.cascade_id,
        chapter: step.chapter,
        payload: { role: 'rights', verdict: recorded.verdict, rule: recorded.rule },
      },
      at,
    );
    if (recorded.verdict === 'CLEAR') return { verdict: 'CLEAR', action: 'close', closed: false };

    // The table makes this total: `recordRightsVerdict` refuses a REFUSED without a rule that
    // has a sentence. The fallback keeps the type closed — it is never a default verdict.
    const sentence = (recorded.rule === null ? null : rightsRefusalLine(recorded.rule)) ?? 'не принято';
    closeStep(
      deps,
      step.step_id,
      {
        outcome: 'escalated',
        seamsOut: [],
        note: sentence.slice(0, NOTE_MAX_CHARS),
        model: null,
        tokensIn: Math.max(0, Math.trunc(answer.tokensIn)),
        tokensOut: Math.max(0, Math.trunc(answer.tokensOut)),
        escalation: 'escalated:rights',
        changeReason: sentence.slice(0, REASON_MAX_CHARS),
      },
      at,
    );
    return { verdict: 'REFUSED', action: 'escalate', closed: true };
  }

  return { next, verdict };
}

export type RightsGate = ReturnType<typeof createRightsGate>;
