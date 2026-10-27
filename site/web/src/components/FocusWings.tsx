import type { CascadeWingsDto } from '@book/shared';

import type { Wing } from '../lib/cascade.ts';
import { wingLine, wingReachedCopy } from '../lib/cascade.ts';
import { scaleTicks } from '../lib/focus.ts';

/**
 * The focus view's two wings and its local window (ARCHITECTURE §11.9, BOOK-DOC-4).
 *
 * Both directions of one consequence are printed at once: each wing says its direction, its
 * own wave, its state and the chapters it reached. A wing that never opened prints nothing and
 * is skipped (BOOK-137): a diagnostic is not reading. The window is a plain grid of chapters
 * around the ripple, so a 7–9 ripple does not collapse into one pixel of a 67-chapter scale —
 * and the grid needs no inline style (CSP forbids them): the column count is a precomputed
 * class, the marks are classes, and a frame arriving changes a class, never the layout height.
 */
export function FocusWings({ wings, live }: { wings: CascadeWingsDto; live: boolean }) {
  // BOOK-56: the wings are the cascade's history; with no reader change they are absent.
  if (!live) return null;
  return (
    <div className="focus-wings">
      {(['down', 'up'] as const).map((side: Wing) => {
        const reached = wingReachedCopy(wings[side]);
        const line = wingLine(side, wings[side]);
        // BOOK-137: an empty wing is no slot at all — no state word, no dash, no span.
        if (line === '' && reached === '') return null;
        return (
          <div className="focus-wing" key={side} data-state={wings[side].state}>
            {line === '' ? null : <span className="focus-wing-h">{line}</span>}
            {/* An empty wing prints nothing: no dash, no empty span (BOOK-70). */}
            {reached === '' ? null : <span className="focus-wing-r">{reached}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A local window of chapters as a grid: origin, the chapter in flight, and the span between. */
export function FocusTrack({
  from,
  to,
  origin,
  current,
}: {
  from: number;
  to: number;
  origin: number;
  current: number;
}) {
  const width = Math.min(15, Math.max(1, to - from + 1));
  // A ripple reaches at most five chapters per wing, so `focusScale` stays within fifteen
  // columns. If a wider window ever arrives, the chapter in flight keeps its mark.
  const start = current > from + width - 1 ? current - width + 1 : from;
  const labelled = new Set([...scaleTicks(start, start + width - 1), origin, current]);
  return (
    <div className={`focus-track w-${width}`} aria-hidden="true">
      {Array.from({ length: width }, (_, index) => start + index).map((n) => {
        const between = (n > origin && n < current) || (n < origin && n > current);
        const marks = `${n === origin ? ' is-origin' : ''}${between ? ' is-between' : ''}${
          n === current ? ' is-current' : ''
        }`;
        return (
          <span className={`focus-cell${marks}`} key={`cell-${n}`} data-chapter={n === current ? current : undefined}>
            <i className="focus-tick" />
            {labelled.has(n) ? <span className="focus-tick-label">{String(n).padStart(2, '0')}</span> : null}
          </span>
        );
      })}
    </div>
  );
}
