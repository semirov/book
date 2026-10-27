import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import { getFront } from './api.ts';
import { withRevision, type BookData } from './lib/bookState.ts';

/** The trailing window the export line waits out after the last text frame. */
const WINDOW_MS = 1_000;

/**
 * BOOK-60 / BOOK-DOC-41 §6 — the end matter's edition number follows the text.
 *
 * The frame is the trigger, `/api/front` is the durable value: `chapter:created`,
 * `chapter:revision` and `front:updated` all move the edition hash, and the page must not keep
 * naming the edition before the last one. A burst of frames (a cascade rewriting neighbours)
 * collapses into one read — trailing debounce of a second — and only one request is ever in
 * flight. A failure is silent: the line keeps the last number it had, and the next frame asks
 * again. An old payload without `revision` is left alone.
 */
export function useFrontRevision(
  setData: Dispatch<SetStateAction<BookData | null>>,
): () => void {
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const pending = useRef(false);
  /** The request the timer starts; a ref, so the single-flight retry can call it back. */
  const runRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    runRef.current = () => {
      if (inFlight.current) {
        pending.current = true;
        return;
      }
      inFlight.current = true;
      void getFront()
        .then((front) => {
          if (typeof front.revision !== 'number') return;
          const revision = front.revision;
          setData((current) => (current === null ? current : withRevision(current, revision)));
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight.current = false;
          if (pending.current) {
            pending.current = false;
            runRef.current();
          }
        });
    };
  }, [setData]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const note = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      runRef.current();
    }, WINDOW_MS);
  }, []);

  return note;
}
