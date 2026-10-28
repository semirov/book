/**
 * BOOK-117, the owner's rule of 2026-10-28 — re-opening a step to close it with the verdicts it
 * earned. A step that landed its text and was escalated by a rule it can now satisfy (Gate B did
 * not exist for it, a transport broke the close) is re-opened for that answer: the chapter stays
 * where it is, the gates are re-asked, and `done` closes it.
 *
 * Narrow on purpose: only an `escalated` step, only with `landed_at`, and only while the chapter
 * is still the text the step landed. A step whose text moved has nothing left to close.
 */

import { NOTE_MAX_CHARS } from '@book/shared';

import { appendEvent } from '../history/log.ts';
import * as store from './store.ts';
import { readChapterRows } from './text.ts';
import { refuse, type EngineDeps } from './types.ts';

export function reopenStep(
  deps: EngineDeps,
  stepId: string,
  because: string,
  options: { now?: number } = {},
): { stepId: string; reopened: true } {
  const at = options.now ?? deps.clock.now();
  const { db } = deps;
  const step = store.getStep(db, stepId);
  if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${stepId}`);
  if (step.outcome !== 'escalated') {
    refuse('STEP_NOT_ESCALATED', 409, `step ${stepId} is ${String(step.outcome ?? 'open')}, not escalated`);
  }
  if (step.landed_at === null) refuse('NOT_LANDED', 409, `step ${stepId} has no landed text to close`);
  if (step.chapter !== null) {
    const chapter = readChapterRows(db, step.chapter);
    if (!chapter.exists || chapter.sha256 !== step.landed_sha) {
      refuse(
        'STEP_TEXT_MOVED',
        409,
        `глава ${String(step.chapter)} уже не тот текст, что закрывал шаг — переоткрывать нечего`,
      );
    }
  }
  store.updateStep(db, stepId, { outcome: null, closed_at: null, note: because.slice(0, NOTE_MAX_CHARS) });
  // A reopen is a fresh window, not the fourth attempt of the closed one: the reaper counts
  // expired leases per change, and a step escalated after three of them would be escalated on
  // the next tick instead of being asked anything (`gate_timeout`, seen in prod 2026-10-28).
  const change = db
    .prepare('SELECT change_id FROM leases WHERE step_id = ? AND change_id IS NOT NULL ORDER BY acquired_at DESC LIMIT 1')
    .get(stepId) as { change_id: string } | undefined;
  if (change !== undefined) store.updateChange(db, change.change_id, { attempts: 0 });
  appendEvent(
    db,
    // A reopen is an opening with a reason: the events table's vocabulary is closed, and a
    // second kind for «opened again» would need a table rebuild for one word.
    { kind: 'step.opened', stepId, cascadeId: step.cascade_id, chapter: step.chapter, payload: { reopened: true, because } },
    at,
  );
  return { stepId, reopened: true };
}
