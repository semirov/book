/**
 * BOOK-166 — a draft step is work only while its filing is live.
 *
 * A step opened before the rule, or one whose premise was settled or voided, has no reader
 * behind it: it is closed here with a reason, so the lane never spins on the same unbound step
 * every cycle while a real filing waits behind it in the queue.
 */

import { appendEvent } from '../history/log.ts';
import * as store from './store.ts';
import type { Db } from '../db/db.ts';

/** A draft step with no pending premise is nobody's work. */
export function unfiledDraft(db: Db, step: store.StepRow): boolean {
  if (step.pass !== 'draft') return false;
  if (step.premise_change === null) return true;
  const premise = store.getChange(db, step.premise_change);
  return premise === undefined || premise.status !== 'pending';
}

/** Close it as `interrupted` with its reason; `true` when the step was closed. */
export function closeUnfiledDraft(db: Db, step: store.StepRow, atIso: string, nowMs: number): boolean {
  if (!unfiledDraft(db, step)) return false;
  store.updateStep(db, step.step_id, {
    outcome: 'interrupted',
    closed_at: atIso,
    note: 'заявки нет — шаг без заказчика закрыт',
  });
  appendEvent(
    db,
    { kind: 'step.closed', stepId: step.step_id, chapter: step.chapter, payload: { outcome: 'interrupted', noFiling: true } },
    nowMs,
  );
  return true;
}
