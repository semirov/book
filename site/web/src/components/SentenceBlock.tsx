import type { ParagraphChainDto } from '@book/shared';
import { useEffect, useLayoutEffect } from 'react';

import { attachOutsideClose } from '../lib/outsideClose.ts';

import { CHAIN_FAILED_LINE, NO_HISTORY_LINE } from '../lib/history.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';
import { SENTENCE_LABEL, sentenceFacts, type SentenceFrame } from '../lib/sentence.ts';
import { Skeleton } from './Skeleton.tsx';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-128 comment #3815 — «откуда эта фраза» is marginalia, exactly like the word's record.
 *
 * At ≥1024 the block is a margin item (`data-margin-item="sentence"`) anchored on the line the
 * `⋯` door sits on: the seat is a zero-height block after the paragraph, so the prose cannot
 * move while the answer is read, and the pass places the block against the very line that asked
 * the question. At ≤1023 the same node is in flow under the paragraph — a 44 px row carrying
 * the one word `фраза`, the sentence quoted, then its three facts, full measure, `--rule` tie.
 *
 * The block owns no close and no CTA: the `⋯` door that opened it is the toggle, `Escape` and an
 * outside tap put it away, and focus goes back to the door. Its visible label is `фраза`; the
 * accessible name may say the rest.
 *
 * The failure line and the wait are not facts and stay as they were: `история не прочиталась`
 * with `повторить` (retry is the one control a failed read may keep), and the skeleton.
 */
export const SENTENCE_BLOCK_CLASS = 'sentence-block ym-hide-content';

export function SentenceBlock({
  chain,
  loading,
  failed,
  quote,
  frame,
  place,
  onRetry,
  onClose,
}: {
  chain: ParagraphChainDto | null;
  loading: boolean;
  /** The read failed: a line and a retry, never a fact list. */
  failed: boolean;
  /** The sentence the door speaks about — quoted above the facts, in the book's quote style. */
  quote: string;
  /** BOOK-137: the canon sentence (`frame`) or page 2 (`basis`); `none` for writable prose. */
  frame: SentenceFrame;
  /** `margin` inside the prose (`ProseParagraph`); `flow` where there is no margin channel. */
  place: 'margin' | 'flow';
  onRetry: () => void;
  /** `Escape` or an outside tap: the door that opened the block is the only close it has. */
  onClose: () => void;
}) {
  // The block is a change of the page's margin: the pass runs before paint.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [chain, loading, failed, place]);

  // The block owns no ✕ (§ the design's one-close rule): it is put away by `Escape`, by a tap
  // on a fine pointer outside it, or by pressing its own door again — and the caller hands focus
  // back to that door.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // The card over this layer owns Escape while it is open (one box, one way out).
      if (event.key !== 'Escape' || document.querySelector('.filing-panel') !== null) return;
      onClose();
    };
    const detach = attachOutsideClose({
      isInside: (target) => target.closest('.sentence-block') !== null,
      onOutside: onClose,
    });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      detach();
    };
  }, [onClose]);

  // A 404 on writable prose is an answer with nothing in it («у этой строки нет истории»); the
  // frozen surfaces are facts on their own and print their three lines with no chain at all.
  const facts = chain === null && frame === 'none' ? null : sentenceFacts({ chain, frame });

  const block = (
    <div
      className={place === 'margin' ? SENTENCE_BLOCK_CLASS : `${SENTENCE_BLOCK_CLASS} sentence-flow`}
      data-margin-item="sentence"
      role="group"
      aria-label="откуда эта фраза"
      aria-busy={loading ? 'true' : undefined}
    >
      <p className="sentence-label">{SENTENCE_LABEL}</p>
      {loading ? <Skeleton variant="chain" /> : null}
      {/* A failed read is not an absence: the same state line the chronicle uses (BOOK-70). */}
      {!loading && failed ? (
        <div className="state-line">
          <span>{CHAIN_FAILED_LINE}</span>
          <button type="button" onClick={onRetry}>
            повторить
          </button>
        </div>
      ) : null}
      {!loading && !failed && facts === null ? <p className="sentence-fact">{NO_HISTORY_LINE}</p> : null}
      {facts === null ? null : (
        <>
          <blockquote className="sentence-quote">«{quote}»</blockquote>
          <div className="sentence-facts">
            <p className="sentence-fact sentence-hand">{facts.hand}</p>
            <p className="sentence-fact">{facts.mutable}</p>
            <p className="sentence-fact">{facts.trail}</p>
          </div>
        </>
      )}
    </div>
  );

  // The seat is the margin item's own coordinate space: zero height at ≥1024, so the paragraph
  // below does not move when the block mounts; in flow the block is its own wrapper.
  return place === 'margin' ? <div className="sentence-seat">{block}</div> : block;
}
