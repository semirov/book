import { useEffect, useLayoutEffect, type MouseEvent } from 'react';

import { CHAIN_FAILED_LINE } from '../lib/history.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';
import type { WordFacts } from '../lib/provenance.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-128 comment #3815 — «откуда это слово», as a **margin item**, not a panel.
 *
 * One block, one place in the tree: at ≥1024 it is `position: absolute` in the strip's own
 * box (`left: calc(100% + var(--note-gap))` from the prose's edge, one `--rule-2` hairline,
 * no fill, no shadow, no scroll, no close, no `z-index`); at ≤1023 the same node is in flow
 * under the strip's 44 px row, full measure, with a `--rule` hairline. The margin pass places
 * it and writes `data-placed` before paint; a static node is skipped by the pass, so the phone
 * body is never given a channel `top`.
 *
 * What it prints is three facts and, under `печатник` alone, one sentence (`lib/provenance.ts`).
 * There is no CTA here: the strip's `вмешаться` is the only door, and it is already in the row
 * above this block. When a filing stands on the word, line 3 is a real `<a>` to its place —
 * never a `<button>`, so the layer owns no action of its own — and the site's one panel is
 * what it opens.
 *
 * `prov-block ym-hide-content` is the masked root the Webvisor guard (BOOK-77) reads here:
 * one literal, no copy to drift.
 */
export const PROV_BLOCK_CLASS = 'prov-block ym-hide-content';

export function ProvenanceBlock({
  view,
  failed,
  onFiling,
}: {
  view: WordFacts | null;
  /** The read failed: one line, no facts (§8). */
  failed: boolean;
  /** The filing the trace line opens, in the site's one panel. */
  onFiling: (origin: HTMLElement) => void;
}) {
  // The block is a change of the page's margin: the pass runs before paint, once per answer.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [view, failed]);

  // Nothing is claimed before the log answers: the block mounts with the answer, not with a
  // default (`…` would be a fourth state the design does not have).
  if (view === null && !failed) return null;

  if (view === null) {
    return (
      <div className={PROV_BLOCK_CLASS} data-margin-item="prov">
        <p className="prov-loss">{CHAIN_FAILED_LINE}</p>
      </div>
    );
  }

  /** A modified click is the browser's own act: a new tab, a copy of the fragment. */
  const openFiling = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onFiling(event.currentTarget);
  };

  return (
    <div className={PROV_BLOCK_CLASS} data-margin-item="prov">
      <div className="prov-facts">
        <p className="prov-hand">{view.hand}</p>
        <p className="prov-when">{view.when}</p>
        {view.filing === null ? (
          <p className="prov-trace">{view.trace}</p>
        ) : (
          <p className="prov-trace">
            <a className="prov-door" href={view.filing.href} onClick={openFiling}>
              {view.trace}
            </a>
          </p>
        )}
      </div>
      {view.gloss === null ? null : <p className="prov-gloss">{view.gloss}</p>}
    </div>
  );
}
