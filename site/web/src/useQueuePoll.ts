import { useEffect, type Dispatch, type SetStateAction } from 'react';

import { getQueue } from './api.ts';
import type { BookData } from './lib/bookState.ts';

/**
 * `/api/queue` is polled only while the engine is alive (§9); the socket carries the rest.
 *
 * Split out of `App` when BOOK-56 added the history flag: the page component is close to the
 * architecture's 500-line bound, and this effect owns no state of the page's own.
 */
export function useQueuePoll(
  dataRef: { current: BookData | null },
  setData: Dispatch<SetStateAction<BookData | null>>,
): void {
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const status = dataRef.current?.state.engine.status;
      if (status === 'down' || status === 'absent' || status === 'unknown') return;
      void getQueue()
        .then((queue) =>
          setData((current) =>
            current === null ? current : { ...current, state: { ...current.state, queue } },
          ),
        )
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [dataRef, setData]);
}
