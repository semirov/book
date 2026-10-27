import type { ParagraphChainDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePanel } from '../lib/cssom.ts';
import { chainHead } from '../lib/history.ts';
import { formatTime } from '../lib/format.ts';
import { placePopover, samePlacement, type AnchorRect, type PopoverPlacement } from '../lib/popover.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * «откуда эта фраза» — the paragraph's lineage chain (ARCHITECTURE §6F.3).
 *
 * The chain is finite by construction: one introduction, at most one continuation per
 * version, and an erasure where it ends. The head repeats the SPEC's public copy
 * («переписано в 14:20 правкой 7 · было: правка 3 (Аня)») so the same sentence is used in
 * the chronicle, the book and the change card.
 *
 * Placement (owner, 2026-10-27): with an anchor the panel is fixed over the tapped phrase,
 * flips above it when the bottom of the screen has no room, and is clamped inside the
 * viewport. It is measured on open and when the chain arrives — there is no scroll listener
 * and the equality guard drops a measurement that changes nothing, so one measurement is one
 * render and scrolling the page can neither move nor blink it. Without an anchor the panel
 * keeps the old bottom-sheet shape.
 */
export function ParagraphChain({
  chain,
  loading,
  onClose,
  anchor = null,
}: {
  chain: ParagraphChainDto | null;
  loading: boolean;
  onClose: () => void;
  anchor?: AnchorRect | null;
}) {
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  useMeasuredLayout(() => {
    if (anchor === null) {
      setPlacement((current) => (current === null ? current : null));
      return;
    }
    const node = panel.current;
    if (node === null || typeof window === 'undefined') return;
    const size = { width: node.offsetWidth, height: node.scrollHeight };
    const next = placePopover(anchor, size, { width: window.innerWidth, height: window.innerHeight });
    // Equality guard: a measurement that agrees with the current box changes no state, so
    // one measurement is one render and the panel cannot oscillate.
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchor, chain, loading]);

  // BOOK-30: the measured box goes through CSSOM (`placePanel`), not a `style` attribute,
  // so no inline style reaches the markup; it runs before paint, after the same measurement.
  useMeasuredLayout(() => {
    placePanel(panel.current, placement);
  }, [placement]);

  // BOOK-77 (audit F1): the chain names the readers who wrote each version — masked in both
  // placements, because the panel is also mounted outside the chronicle.
  return (
    <aside
      className={`chain ym-hide-content${placement === null ? '' : ' chain-anchored'}`}
      role="dialog"
      aria-label="откуда эта фраза"
      ref={panel}
    >
      <div className="chain-head">
        <span className="chain-title">откуда эта фраза</span>
        <button type="button" className="chain-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      {loading ? <p className="chr-empty">цепочка читается…</p> : null}
      {!loading && chain === null ? <p className="chr-empty">у этой строки нет истории</p> : null}
      {chain === null ? null : (
        <>
          <p className="chain-line">{chain.line}</p>
          <p className="chain-state">{chainHead(chain)}</p>
          <ol className="chain-list">
            {chain.versions.map((version) => (
              <li key={`${version.blockUid}-${version.ver}`} className={`chain-row op-${version.op}`}>
                <span className="chain-ver">{version.ver}</span>
                <span className="chain-copy">
                  {version.op === 'introduced' ? 'написано' : version.op === 'revised' ? 'переписано' : 'убрано'}
                  {' · '}
                  {formatTime(version.at)}
                  {version.actor?.label ? ` · ${version.actor.label}` : ''}
                </span>
                <code className="chain-id">{version.blockId}</code>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
