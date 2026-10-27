import { useEffect, useState } from 'react';

import { SHOW_AFTER_MS, SLOW_AFTER_MS, pendingStage, type PendingStage } from './lib/pending.ts';

/**
 * BOOK-DOC-43 §4 — the stage of a wait (BOOK-66).
 *
 * One timer per threshold, both counted from the moment `active` turns true and both cleared
 * on settle and on unmount: a stale stage would leave a placeholder behind the text, which is
 * exactly the defect the spec names (§10). The returned value is `'quiet'` in the same render
 * that `active` turns false, before the cleanup effect runs, so nothing survives the settle.
 *
 * `active` is component state, never a ref: a settle has to re-render the surface.
 */
export function usePending(active: boolean): PendingStage {
  const [stage, setStage] = useState<PendingStage>(() => pendingStage(0));

  useEffect(() => {
    if (!active) {
      // A settled surface forgets the wait: re-activating starts below the threshold again.
      setStage(pendingStage(0));
      return;
    }
    setStage(pendingStage(0));
    const show = setTimeout(() => setStage(pendingStage(SHOW_AFTER_MS)), SHOW_AFTER_MS);
    const slow = setTimeout(() => setStage(pendingStage(SLOW_AFTER_MS)), SLOW_AFTER_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(slow);
    };
  }, [active]);

  // The settle is visible in this render, not one effect later.
  return active ? stage : 'quiet';
}
