/**
 * BOOK-220 M3 — the stages of the one pass the record shows.
 *
 * A reader who was not connected when a pass ran can never receive its `pass:stage` frames; the
 * record's `правка` section prints the pass's close from the frame (`state.passes`), and its
 * stages come from `GET /api/chapters/:n/stages?pass=<stepId>` — bounded to **one pass**, read
 * once, when the section opens. The answer is kept for the session (a stage log is history, not
 * a live feed); a failure is not kept, and the section says so instead of waiting forever.
 */

import { useEffect, useState } from 'react';

import type { PassStageEvent } from '@book/shared';

import { getStages } from '../api.ts';

const STAGES_LIMIT = 50;

const answers = new Map<string, readonly PassStageEvent[]>();
const inflight = new Map<string, Promise<readonly PassStageEvent[]>>();

const keyOf = (chapter: number, pass: string): string => `${String(chapter)}:${pass}`;

/** One pass's stored stages, in the pass's own order; a repeat is the memo, not a request. */
export function loadPassStages(chapter: number, pass: string): Promise<readonly PassStageEvent[]> {
  const key = keyOf(chapter, pass);
  const memo = answers.get(key);
  if (memo !== undefined) return Promise.resolve(memo);
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  const request = getStages(chapter, { pass, limit: STAGES_LIMIT })
    .then((stages) => {
      const ordered = [...stages].sort((left, right) => left.stageSeq - right.stageSeq);
      answers.set(key, ordered);
      return ordered;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

export type PassStagesRead = { stages: readonly PassStageEvent[]; failed: boolean };

/**
 * The one read a record's `правка` section makes for the pass it shows. `null` (no closed pass,
 * or a pass of no chapter) costs nothing.
 */
export function usePassStages(chapter: number | null, pass: string | null): PassStagesRead {
  const [read, setRead] = useState<PassStagesRead>(() => ({
    stages: chapter === null || pass === null ? [] : (answers.get(keyOf(chapter, pass)) ?? []),
    failed: false,
  }));

  useEffect(() => {
    if (chapter === null || pass === null) return;
    const memo = answers.get(keyOf(chapter, pass));
    if (memo !== undefined) {
      setRead({ stages: memo, failed: false });
      return;
    }
    setRead({ stages: [], failed: false });
    let cancelled = false;
    void loadPassStages(chapter, pass)
      .then((stages) => {
        if (!cancelled) setRead({ stages, failed: false });
      })
      .catch(() => {
        if (!cancelled) setRead({ stages: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [chapter, pass]);

  return chapter === null || pass === null ? { stages: [], failed: false } : read;
}

/** Tests only: the memo is per module lifetime, and a fresh case wants a fresh client. */
export function resetPassStages(): void {
  answers.clear();
  inflight.clear();
}
