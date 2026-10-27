/**
 * The writer lane's stage frames, reduced to the one fact the reader's page can use: a pass
 * is working on this chapter **right now** (`docs/writer-lane.md` §2–3).
 *
 * Why the page needs it: a landed pass writes the chapter file and the revision row in the
 * **engine**, while the `chapter:revision` frames come from the **site**, whose watcher then
 * finds the file already ingested and publishes nothing. So the text changes under a page
 * that never hears about it — unless the page remembers that a pass was in flight and treats
 * the next refetch of that chapter as what a change-driven patch is: text that prints.
 *
 * Pure and synchronous, so the reducer is testable without mounting the page.
 */

import { PASS_STAGES, type PassStage, type PassStageEvent } from '@book/shared';

/** The pass the page holds for one chapter: the facts the stage frames carried. */
export type PassState = {
  passId: string;
  changeId: string | null;
  stage: PassStage;
};

/** One entry per chapter with a pass in flight; a chapter without a pass has no key. */
export type Passes = Record<number, PassState>;

/** The stages that say the pass is still working; `typing` belongs to a pass already in flight. */
const IN_FLIGHT: readonly PassStage[] = ['queued', 'read', 'verdict', 'drafting'];

/** The stages that end a pass: the chapter is written (`landed`) or was left alone (`refused`). */
const SETTLED: readonly PassStage[] = ['landed', 'refused'];

/**
 * One `pass:stage` frame applied to the held state.
 *
 * - `queued · read · verdict · drafting` mark the chapter in flight;
 * - `landed · refused` clear it — the pass is over either way;
 * - any other stage (an older `typing`, a stage a newer server invents) changes nothing and
 *   never throws: an unknown frame must not break a page that is already printing;
 * - `landed` of one pass does not clear another pass's key: the pass that ends a chapter's
 *   flight is the pass that held it.
 *
 * The same object comes back when nothing changed, so a frame that says nothing new costs
 * no re-render.
 */
export function applyStage(state: Passes, event: PassStageEvent): Passes {
  const n = event.chapter;
  if (!Number.isInteger(n) || n < 1) return state;
  // The frame's `stage` is typed, but it arrives from the wire: check the vocabulary it claims.
  const stage: string = event.stage;
  if (!(PASS_STAGES as readonly string[]).includes(stage)) return state;

  if (IN_FLIGHT.includes(event.stage)) {
    const held = state[n];
    if (held !== undefined && held.passId === event.passId && held.stage === event.stage) return state;
    return { ...state, [n]: { passId: event.passId, changeId: event.changeId ?? null, stage: event.stage } };
  }

  if (!SETTLED.includes(event.stage)) return state;

  const held = state[n];
  if (held === undefined || held.passId !== event.passId) return state;
  const next = { ...state };
  delete next[n];
  return next;
}
