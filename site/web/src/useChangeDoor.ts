import { useCallback, useEffect, useRef, useState } from 'react';

import { landOnChange } from './lib/changeDoor.ts';
import { changeIdFromSearch } from './lib/changeLink.ts';
import type { ChapterLoader } from './lib/place.ts';

/**
 * The page's one door to a change.
 *
 * Every entry point — the chronicle row, a filing's «правка →», the ribbon, a place that
 * cannot show its paragraph — calls `open`. The door lands on the change's sentence and opens
 * the record there with the `правка` section expanded (`lib/changeDoor.ts`); a change with no
 * sentence lands on its chapter, whose own row prints the section. There is no second overlay
 * and no full-screen surface for a change any more.
 *
 * `?change=<id>` is the same act on load and on a back/forward (`popstate`): one landing per
 * address, never the same one twice.
 */
export type ChangeDoor = {
  open: (changeId: string) => void;
  /** `правка не прочиталась` — the one failure a door of its own still owns. */
  failed: string | null;
};

export function useChangeDoor({
  ready,
  loadChapter,
}: {
  /** The book is on screen: the chapter slots exist, so a landing has somewhere to go. */
  ready: boolean;
  loadChapter?: ChapterLoader;
}): ChangeDoor {
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const landed = useRef<string | null>(null);

  const open = useCallback((changeId: string) => {
    setFailed(null);
    setPending(changeId);
  }, []);

  useEffect(() => {
    if (!ready || pending === null) return;
    const changeId = pending;
    setPending(null);
    void landOnChange({
      changeId,
      ...(loadChapter === undefined ? {} : { load: loadChapter }),
    }).then((result) => {
      if (result.kind === 'failed') setFailed('правка не прочиталась');
    });
  }, [ready, pending, loadChapter]);

  useEffect(() => {
    if (!ready) return;
    const read = (): void => {
      const changeId = changeIdFromSearch(window.location.search);
      if (changeId === null || landed.current === changeId) return;
      landed.current = changeId;
      setFailed(null);
      setPending(changeId);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [ready]);

  return { open, failed };
}
