import { useEffect, type ReactElement } from 'react';

import { CAPACITY_PLATE, CAPACITY_STATE } from '../lib/capacity.ts';
import { applyStickyOffsets } from '../lib/headerOffset.ts';

/**
 * BOOK-75 — the hall is full, and the reader is in the queue.
 *
 * A strip at the foot of the page, not a page: the prose is REST and keeps reading under a
 * full hub (AC2), so replacing the book would take away what is still perfectly readable.
 * No button either (AC3): the socket reconnects on its own, and a control would only invite
 * a reader to hammer a closed door. The plate is fixed, so it never moves a line above it.
 *
 * The plate is also the band a jump can land under (owner, 2026-10-28): it reports its own
 * height to the anchor contract (`applyStickyOffsets` → `--offset-bottom`) whenever it
 * appears or leaves, so the footer keeps its room over the bottom edge.
 */
export function CapacityPlate({ active }: { active: boolean }): ReactElement | null {
  // After the DOM reflects `active`: the plate is mounted, so it measures, or it is gone, so
  // the bottom offset falls back to the breathing space alone.
  useEffect(() => {
    applyStickyOffsets(document);
  }, [active]);
  if (!active) return null;
  return (
    <aside className="capacity-plate" role="status" aria-live="polite" data-capacity="waiting">
      <p className="capacity-plate-line">{CAPACITY_PLATE}</p>
      <p className="capacity-plate-state">{CAPACITY_STATE}</p>
    </aside>
  );
}
