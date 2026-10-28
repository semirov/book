import type { MouseEvent } from 'react';

import { CHAIN_FAILED_LINE } from '../lib/history.ts';
import type { WordFacts } from '../lib/provenance.ts';

/**
 * BOOK-128 #3815 / #3863, review M6 — «откуда это слово» as the **legacy strip's body**.
 *
 * The margin placement this file was written for is gone: `record.css` carries the word's
 * record on the reading path, and this component is reachable only through the shipped strip's
 * own store (`Seam.tsx` `prov` prop) — the re-anchor path and the empty-chapter machinery. It
 * is therefore a plain flow block inside that strip: one `--rule-2` hairline, the note's 6/0/8,
 * no fill, no shadow, no scroll, no close, no `z-index`, and **no `data-margin-item`** — the
 * page's margin pass no longer has a claim on this node.
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
  // The block no longer enters the page's margin ledger (review M6): it is in the strip's own
  // flow, so the pass has nothing to place and is never scheduled.

  // Nothing is claimed before the log answers: the block mounts with the answer, not with a
  // default (`…` would be a fourth state the design does not have).
  if (view === null && !failed) return null;

  if (view === null) {
    return (
      <div className={PROV_BLOCK_CLASS}>
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
    <div className={PROV_BLOCK_CLASS}>
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
