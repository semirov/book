/**
 * The change half of a close: one status, its outcome, one public sentence and the rows a
 * decision leaves (ARCHITECTURE.md §6A.7, §6F.5, BOOK-206 B2).
 *
 * Two doors end a change, and only two — `written` and `refused`. A pass that took the text
 * closes it `done`; a stop closes it `void · dropped` with a sentence the reader may print
 * (`stopChange`). `escalated` is not a change status any more: it is the *step's* word for
 * «stopped by a rule», which is exactly why a stop here cannot leave the filing in limbo.
 *
 * It lives apart from `close.ts` because both the close and the refusal (`refuse.ts`) write it,
 * and neither may own the other.
 */

import type { CascadeOutcome, ChangeOutcome, ChangeStatus } from '@book/shared';

import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { recordAcceptance } from '../comments/acceptance.ts';
import { recordImpact } from '../history/impact.ts';
import { publishIndexNotices } from './indexNotice.ts';
import { rippleOutcomeFor } from './ripple.ts';
import { sendPassEvent } from '../push/passEvent.ts';
import { toIso } from '../util/time.ts';
import { alertKind, recordAlert } from './alerts.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';

export function releaseLane(deps: EngineDeps, changeId: string): void {
  const lane = store.readLane(deps.db);
  if (lane.holder === changeId) store.releaseLaneRow(deps.db, changeId);
}

/**
 * Close one change and write what the decision leaves behind: its tokens and model frozen from
 * its steps, the acceptance of a reader's variant that landed, one `change_events` row, one
 * `change.decided` event, the index notices, the impact projection, the lane, and the reader's
 * own notification.
 *
 * `onlyFrom` makes the transition conditional: a caller that may lose a race (the queue's own
 * tick refusing the same pending row twice) gets `false` and writes nothing at all — the second
 * close of one change is a no-op, never a second decision.
 *
 * `options.notify: false` is the one seam a caller needs when the filing's **reader** already
 * heard the truth from another row: a superseded attempt is closed `void · dropped` so the ledger
 * is complete, but its filing's text landed through another change, and the push a `void` row
 * announces («правка по главе N отклонена») would contradict the page that says «внесено». The
 * decision itself is still recorded — `change_events('decided')` and `change.decided` are what
 * every surface derives the filing's state from — only the announcement and the admin alert are
 * not made. Every existing caller keeps the default.
 */
export function closeChange(
  deps: EngineDeps,
  change: store.ChangeRow,
  status: ChangeStatus,
  outcome: ChangeOutcome,
  reason: string | null,
  now: number,
  onlyFrom: ChangeStatus | null = null,
  options: { notify?: boolean } = {},
): boolean {
  const db = deps.db;
  // BOOK-173 §7: a change that stood a ripple is `ripple`, never `applied`; the plan is evidence.
  const settled = rippleOutcomeFor(db, change.id, outcome) as ChangeOutcome;
  // Tokens and the model are frozen here, once (§6D.5); cost stays the placeholder zero and the
  // row is not priced, so BOOK-23 reads it as «not measured» (`measuredRub`), never as free.
  const steps = store.stepsOfChange(db, change.id);
  const tokensIn = steps.reduce((sum, step) => sum + step.tokens_in, 0);
  const tokensOut = steps.reduce((sum, step) => sum + step.tokens_out, 0);
  const writerModel = steps.find((step) => step.pass === 'change' && step.model !== null)?.model ?? null;
  const patch = {
    status,
    outcome: settled,
    reason,
    finished_at: toIso(now),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    model: writerModel,
  };
  if (onlyFrom !== null) {
    const confirmed = db
      .prepare(
        `UPDATE changes SET status = @status, outcome = @outcome, reason = @reason, finished_at = @finished_at,
                tokens_in = @tokens_in, tokens_out = @tokens_out, model = @model
          WHERE id = @id AND status = @from`,
      )
      .run({ ...patch, id: change.id, from: onlyFrom }).changes;
    // No confirmation, no side effect: a row another tick already decided keeps that decision.
    if (confirmed !== 1) return false;
  } else {
    store.updateChange(db, change.id, patch);
  }
  // BOOK-58 §10: a reader's variant that landed is entered into the book — the acceptance
  // record is written here, once, from the change's own outcome (`recordAcceptance` is silent
  // for anything that did not land, and for a change that is not a reader's).
  recordAcceptance(db, change.id, toIso(now));
  appendChangeEvent(db, change.id, status === 'escalated' ? 'escalated' : 'decided', { outcome: settled, reason }, now);
  appendEvent(
    db,
    {
      kind: 'change.decided',
      changeId: change.id,
      cascadeId: change.cascade_id,
      payload: { status, outcome: settled, reason },
    },
    now,
  );
  // BOOK-18: one public statement when a document's status moved, then the artifact is
  // refreshed. Both live inside the index module's own guard and cannot fail this close.
  publishIndexNotices(deps, change, now);
  // §6F.5: the impact is materialized once, at close, and is a projection (§T-impact).
  recordImpact(db, change.id, now);
  releaseLane(deps, change.id);
  // BOOK-189: the reader who filed for this change hears how it was decided. The row's status
  // and outcome are written above, so `sendPassEvent` reads the decision it is announcing rather
  // than guessing it; a failed push is not a failed close (the helper never throws). A caller that
  // closes a row the filing has already answered elsewhere says `notify: false` — see above.
  if (options.notify !== false) sendPassEvent(db, { kind: 'decision', changeId: change.id }, now);
  return true;
}

/**
 * The refusal's change half — the only way a filing ends without text.
 *
 * `void · dropped` with one public sentence is what `comments/states.ts` reads as `rejected`
 * (`decided(reason)`): the page says «не принято» in the writer's own words, the change card
 * says the same, and nothing retries it. The alert is the operator's copy of the same fact —
 * recorded once, here, inside the caller's transaction.
 */
export function stopChange(
  deps: EngineDeps,
  change: store.ChangeRow,
  reason: string,
  now: number,
  cause: CascadeOutcome,
  onlyFrom: ChangeStatus | null = null,
  options: { notify?: boolean } = {},
): boolean {
  if (!closeChange(deps, change, 'void', 'dropped', reason, now, onlyFrom, options)) return false;
  // The alert is the operator's copy of the stop. When the row being closed is a superseded
  // attempt the reader never lost — its text landed elsewhere — an `origin` alert would be a false
  // finding on the operator's panel, so that one caller asks for silence (`notify: false`).
  if (options.notify === false) return true;
  recordAlert(deps, {
    kind: alertKind(cause),
    at: toIso(now),
    changeId: change.id,
    cascadeId: change.cascade_id,
    stepId: null,
    detail: reason,
  });
  return true;
}
