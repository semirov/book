import type { ParagraphChainDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePanel } from '../lib/cssom.ts';
import { CHAIN_FAILED_LINE, chainHead, NO_HISTORY_LINE } from '../lib/history.ts';
import { formatTime } from '../lib/format.ts';
import { placePopover, samePlacement, viewportOf, type AnchorRect, type PopoverPlacement } from '../lib/popover.ts';
import { statusLine } from '../lib/skeleton.ts';
import { usePending } from '../usePending.ts';
import { Skeleton } from './Skeleton.tsx';

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
  failed,
  onClose,
  onRetry,
  anchor = null,
  live,
}: {
  chain: ParagraphChainDto | null;
  loading: boolean;
  /** The read failed: the panel prints a failure and a retry, never an absence (§10, BOOK-70). */
  failed: boolean;
  onClose: () => void;
  onRetry: () => void;
  anchor?: AnchorRect | null;
  /** BOOK-56: `state.history.live`; the revision apparatus is history, not the text. */
  live: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  /** §4: the status and the form appear only once the wait is real; the head alone before. */
  const stage = usePending(loading);
  const status = statusLine('chain', stage);

  useMeasuredLayout(() => {
    if (anchor === null) {
      setPlacement((current) => (current === null ? current : null));
      return;
    }
    const node = panel.current;
    if (node === null || typeof window === 'undefined') return;
    const size = { width: node.offsetWidth, height: node.scrollHeight };
    // BOOK-137: the visual viewport — a phone's URL bar and keyboard are part of the box.
    const next = placePopover(anchor, size, viewportOf());
    // Equality guard: a measurement that agrees with the current box changes no state, so
    // one measurement is one render and the panel cannot oscillate.
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchor, chain, loading, failed, stage]);

  // BOOK-30: the measured box goes through CSSOM (`placePanel`), not a `style` attribute,
  // so no inline style reaches the markup; it runs before paint, after the same measurement.
  useMeasuredLayout(() => {
    placePanel(panel.current, placement);
  }, [placement]);

  // After every hook: the flag may turn on while the panel is mounted (a reader change just
  // landed), and the hook order must not depend on it.
  if (!live) return null;

  // BOOK-77 (audit F1): the chain names the readers who wrote each version — masked in both
  // placements, because the panel is also mounted outside the chronicle.
  return (
    <aside
      className={`chain ym-hide-content${placement === null ? '' : ' chain-anchored'}`}
      role="dialog"
      aria-label="откуда эта фраза"
      aria-busy={loading ? 'true' : undefined}
      ref={panel}
    >
      <div className="chain-head">
        <span className="chain-title">откуда эта фраза</span>
        <button type="button" className="chain-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      {/* The status keeps the `.chr-empty` slot the panel already has, so it adds no height. */}
      {status === null ? null : (
        <p className="chr-empty" role="status" aria-live="polite" aria-atomic="true">
          {status}
        </p>
      )}
      {stage === 'quiet' ? null : <Skeleton variant="chain" />}
      {/* A failed read is not an absence: the same state line the chronicle uses, same markup
          and same class, so the two surfaces read as one system (BOOK-70). */}
      {!loading && failed ? (
        <div className="state-line">
          <span>{CHAIN_FAILED_LINE}</span>
          <button type="button" onClick={onRetry}>
            повторить
          </button>
        </div>
      ) : null}
      {/* The absence is a fact about a read that came back: never printed for a failure. */}
      {!loading && !failed && chain === null ? <p className="chr-empty">{NO_HISTORY_LINE}</p> : null}
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
