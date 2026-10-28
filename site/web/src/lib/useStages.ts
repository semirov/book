/**
 * The page's stage log (BOOK-167): the `pass:stage` frames a reader's page has seen, kept in
 * one place so the strip and the chapter can read the same story.
 *
 * IFACE — the log's lifecycle:
 *
 *   (a) states: `log` (one bounded list per chapter, empty when nothing arrived) and the
 *       in-flight `passes` the chapters already use (`lib/passes.ts`), derived from the log so
 *       the two facts can never disagree.
 *   (b) on each: the socket's `pass:stage` frame is appended by `note`; `hello` (a new server
 *       session) resets the log by `reset`. Nothing else writes it.
 *   (c) bounds: the last 40 events per chapter, deduped by `passId` + `stageSeq`, sorted by
 *       the pass's own order. No polling, no timer, no unbounded growth.
 *   (d) ownership: this hook, mounted once by `App`, owns the page's copy; the strip owns no
 *       growing store and the chapter reads what it is handed. A cleared session is cleared
 *       for every reader surface at once.
 */

import { PASS_STAGES, type PassStageEvent } from '@book/shared';
import { useCallback, useMemo, useState } from 'react';

import { applyStage, type Passes } from './passes.ts';

/** One chapter's stages: bounded, deduped, in the pass's order. */
export type StagesLog = Readonly<Record<number, readonly PassStageEvent[]>>;

export const MAX_STAGE_EVENTS = 40;

const EMPTY_LOG: StagesLog = Object.freeze({});

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

export type Stages = {
  log: StagesLog;
  /** The chapter → pass in flight map the chapters already read (`lib/passes.ts`). */
  passes: Passes;
  note: (event: PassStageEvent) => void;
  reset: () => void;
};

export function useStages(): Stages {
  const [log, setLog] = useState<StagesLog>(EMPTY_LOG);
  const note = useCallback((event: PassStageEvent) => {
    setLog((current) => appendStage(current, event));
  }, []);
  const reset = useCallback(() => {
    setLog((current) => (Object.keys(current).length === 0 ? current : EMPTY_LOG));
  }, []);
  const passes = useMemo(() => inFlightOf(log), [log]);
  return { log, passes, note, reset };
}
