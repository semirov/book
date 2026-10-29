/**
 * BOOK-220 §11.3 — «повторить» as a hook: the offer, the phase and the one call.
 *
 * Kept apart from `Record.tsx` so the record stays a record: the facts ride the frames
 * (`lib/filingLive.ts`, `lib/liveChange.ts`), the decision is `lib/retry.ts`, and this file is
 * the one place that knows the POST. A tap re-queues the same filing once; the phase then turns
 * the record back to its live state, or says the honest thing when the endpoint is not there.
 */

import type { CommentDto } from '@book/shared';
import { useCallback, useRef, useState } from 'react';

import { retryComment } from '../api.ts';
import { changeLineOf, useLiveChange } from './liveChange.ts';
import { decisionOf, readingOf, updateOf, useFilingLive } from './filingLive.ts';
import { retryOffer, type RetryOffer } from './retry.ts';

/** `idle` — nothing tapped; `started` — re-queued; `unavailable` — the endpoint said no. */
export type RetryPhase = 'idle' | 'started' | 'unavailable';

export type Retry = {
  offer: RetryOffer;
  phase: RetryPhase;
  /** One tap, one call: a second tap while the first is in flight is not a second repeat. */
  run: () => void;
};

export function useRetry(comment: CommentDto | null): Retry {
  const change = useLiveChange();
  const filing = useFilingLive();
  const [phase, setPhase] = useState<RetryPhase>('idle');
  const busy = useRef(false);
  const offer = retryOffer({
    comment,
    change: changeLineOf(change, comment?.changeId ?? null),
    reading: readingOf(filing, comment?.id),
    update: updateOf(filing, comment?.id),
    decision: decisionOf(filing, comment?.id),
  });
  const id = comment?.id ?? null;
  const run = useCallback((): void => {
    if (id === null || busy.current) return;
    busy.current = true;
    retryComment(id)
      .then(() => setPhase('started'))
      .catch(() => setPhase('unavailable'))
      .finally(() => {
        busy.current = false;
      });
  }, [id]);
  return { offer, phase, run };
}
