import type { ReactElement } from 'react';

import { statusLine } from '../lib/skeleton.ts';
import { usePending } from '../usePending.ts';

/**
 * BOOK-DOC-43 §3, §4 and §6 — the wait before the inventory (BOOK-66).
 *
 * The boot surface has no bars: its field is the page's own paper, sized to the cover's frame
 * by `.boot-wait`, so the first paint already is the final rectangle. The one sentence is
 * printed in the frame's top gutter, absolutely placed, so it adds 0 px to the height and
 * nothing below ever moves when it leaves.
 *
 * Quiet for the first 150 ms — a same-origin answer never shows anything at all — then the
 * label; at 2 000 ms the same element carries the slow sentence. Extracted from `App` so the
 * threshold is provable without booting the app (a socket, analytics), which would make the
 * timing test a test of everything else.
 */
export function BootWait({ active }: { active: boolean }): ReactElement | null {
  const stage = usePending(active);
  const line = statusLine('boot', stage);
  if (line === null) return null;
  return (
    <p className="boot-status" role="status" aria-live="polite" aria-atomic="true">
      {line}
    </p>
  );
}
