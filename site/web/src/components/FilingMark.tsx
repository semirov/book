import type { CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { filingInk, filingWord, type SentenceFilings } from '../lib/filings.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-DOC-34 §2.5 — the mark a filing leaves on its sentence.
 *
 * The visible numeral **is** the button: what the reader sees is what the reader taps, with a
 * 24×24 target, keyboard focusable, and the state's ink. A mark that were only a colour would
 * be unreadable to a reader who cannot see it.
 *
 * BOOK-33: the target must not eat the prose. The button is laid into the paragraph's right
 * margin on the mark's own line (the line is measured once through CSSOM — no `style`
 * attribute reaches the markup), so the 24×24 box is outside the text band: measured at
 * 390×844, zero characters of prose fall inside it. A tap on the sentence still opens the seam.
 */
export function FilingMark({
  filings,
  onOpen,
}: {
  filings: SentenceFilings;
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const newest = filings.all[0];
  const slot = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Placed in the margin at this mark's line. The layout effect runs before paint (the mark
  // never appears at the wrong line), and it re-measures only when the mark's own text or the
  // filing it names changes — not on every render of the paragraph around it.
  useMeasuredLayout(() => {
    const offsets = slot.current;
    const target = button.current;
    if (offsets === null || target === null) return;
    if ((offsets.offsetParent as HTMLElement | null) === null) return;
    target.style.top = `${offsets.offsetTop}px`;
  }, [filings.number, filings.quote, filings.extra]);

  if (newest === undefined) return null;
  const ink = filingInk(newest);
  return (
    <span className="filing-mark-slot" ref={slot}>
      <button
        ref={button}
        type="button"
        className={`filing-mark ink-${ink.tone}`}
        data-number={filings.number}
        aria-label={`замечание ${filings.number} · ${filingWord(newest)}${
          filings.extra > 0 ? ` · ещё ${filings.extra}` : ''
        }`}
        onClick={(event) => onOpen(newest, event.currentTarget)}
      >
        {/* The numeral alone fits the 24 px target; the overflow count is in the label and
            in the strip's «ещё N →», not in a glyph that would widen the mark past its box. */}
        <span className="filing-mark-num">{filings.number}</span>
      </button>
    </span>
  );
}

/** The class a cited sentence carries: the shape says the state, the ink only repeats it. */
export function citedClass(filings: SentenceFilings | undefined): string | null {
  const newest = filings?.all[0];
  if (filings === undefined || newest === undefined || filings.stale) return null;
  const ink = filingInk(newest);
  if (ink.rule === 'none') return null;
  return `cited rule-${ink.rule} ink-${ink.tone}`;
}
