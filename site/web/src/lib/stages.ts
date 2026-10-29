/**
 * The page's stage log (BOOK-167 / BOOK-DOC-84 §2.2): the `pass:stage` frames a reader's page
 * has seen — one bounded list per chapter, the in-flight fold derived from it. The log lives in
 * the page's client state (`lib/clientState.ts`); `hello`/`state:snapshot` seed it from
 * `live.passes` (never with an empty list), and every later frame appends here.
 *
 * Bounds: the last 40 events per chapter, deduped by `passId` + `stageSeq`, sorted by the
 * pass's own order. No polling, no timer, no unbounded growth.
 */

import { PASS_STAGES, type PassStageEvent } from '@book/shared';

import { applyStage, type Passes } from './passes.ts';

/** One chapter's stages: bounded, deduped, in the pass's order. */
export type StagesLog = Readonly<Record<number, readonly PassStageEvent[]>>;

export const MAX_STAGE_EVENTS = 40;


const byStage = (left: PassStageEvent, right: PassStageEvent): number =>
  left.stageSeq - right.stageSeq || left.at - right.at;

/**
 * The log with one frame applied. A repeated frame (same pass, same `stageSeq`) changes
 * nothing and returns the same object, so a re-delivered frame costs no render; an unknown
 * stage or a chapter that is not a chapter is dropped, never thrown.
 */
export function appendStage(log: StagesLog, event: PassStageEvent): StagesLog {
  const chapter = event.chapter;
  if (!Number.isInteger(chapter) || chapter < 1) return log;
  const stage: string = event.stage;
  if (!(PASS_STAGES as readonly string[]).includes(stage)) return log;
  const held = log[chapter] ?? [];
  if (held.some((one) => one.passId === event.passId && one.stageSeq === event.stageSeq)) return log;
  const next = [...held, event].sort(byStage).slice(-MAX_STAGE_EVENTS);
  return { ...log, [chapter]: next };
}

/**
 * Which chapters hold a pass in flight, folded with `passes.ts`'s own reducer: the reading of
 * the log and the frame stream cannot drift apart because there is one rule, not two.
 */
export function inFlightOf(log: StagesLog): Passes {
  let held: Passes = {};
  for (const chapter of Object.keys(log)) {
    for (const event of log[Number(chapter)] ?? []) held = applyStage(held, event);
  }
  return held;
}
