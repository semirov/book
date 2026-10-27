import type { CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { filingInk, filingNumber, isAlive, isLanded, sortFilings, type SentenceFilings } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 — the mark at the sentence.
 *
 * Two forms, one box: the **alive** filing prints its numeral (`28.8 × 13.2`), the **landed**
 * change prints a 1 × 16 px tick. Both sit in a 40 × 44 px target that starts exactly at the
 * prose's right edge, centred on the anchored line, and both are written through CSSOM — no
 * `style` attribute reaches the markup. An alive filing wins the slot over a landed one:
 * alive is louder, and the object opened from the numeral lists the applied change too.
 *
 * Below 1024 the numeral leaves the text (the phone gutter cannot hold it): the mark is the
 * 1 px tick only, in a 24 × 44 target, and the numeral lives in the strip. The state is never
 * colour alone — the tick is a different *shape* from the numeral, and the word travels with
 * the strip row and the note.
 */
export function FilingMark({
  filings,
  onOpen,
  onOpenRevision,
}: {
  filings: SentenceFilings;
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
  /** The landed change's tick opens the revision object. */
  onOpenRevision: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const ordered = sortFilings(filings.all);
  const alive = ordered.find(isAlive);
  const landed = ordered.find(isLanded);
  const newest = alive ?? landed;
  const aliveCount = ordered.filter(isAlive).length;
  const slot = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Placed in the margin at the **anchored line's** top: the sentence span's first layout box
  // (not the mark's own inline box, which sits at the sentence's last character). The 44 px
  // target is centred on the line: offsetTop + lineHeight / 2 − 22.
  useMeasuredLayout(() => {
    const anchor = slot.current;
    const target = button.current;
    if (anchor === null || target === null) return;
    const parent = anchor.offsetParent as HTMLElement | null;
    if (parent === null) return;
    const sentence = anchor.parentElement;
    const line = sentence === null ? anchor.offsetTop : sentence.offsetTop;
    const lineHeight = Number.parseFloat(getComputedStyle(parent).lineHeight);
    const half = Number.isFinite(lineHeight) ? lineHeight / 2 : 0;
    target.style.top = `${line + half - 22}px`;
  }, [newest?.id, filings.number]);

  if (alive !== undefined) {
    const ink = filingInk(alive);
    const extra = aliveCount - 1;
    return (
      <span className="filing-mark-slot" ref={slot}>
        <button
          ref={button}
          type="button"
          className={`filing-mark filing-alive ink-${ink.tone}`}
          data-number={filingNumber(alive)}
          data-state="alive"
          aria-label={`замечание ${filingNumber(alive)} · ${filingMarginalia(alive).word}${extra > 0 ? ` · ещё ${extra}` : ''}`}
          onClick={(event) => onOpen(alive, event.currentTarget)}
        >
          <span className="filing-mark-num">{filingNumber(alive)}</span>
        </button>
      </span>
    );
  }

  if (landed !== undefined) {
    return (
      <span className="filing-mark-slot" ref={slot}>
        <button
          ref={button}
          type="button"
          className="filing-mark filing-tick"
          data-number={filingNumber(landed)}
          data-state="accepted"
          aria-label={`${filingMarginalia(landed).word} · открыть запись ${filingNumber(landed)}`}
          onClick={(event) => onOpenRevision(landed, event.currentTarget)}
        >
          <span className="filing-tick-bar" aria-hidden="true" />
        </button>
      </span>
    );
  }
  return null;
}

/** The class a cited sentence carries: the shape says the state, the ink only repeats it. */
export function citedClass(filings: SentenceFilings | undefined): string | null {
  // BOOK-90: an alive filing wins the slot, and the sentence's rule follows the same filing —
  // a landed change in the same group must not switch the underline off.
  const newest = filings?.all.find(isAlive) ?? filings?.all[0];
  if (filings === undefined || newest === undefined || filings.stale) return null;
  const ink = filingInk(newest);
  if (ink.rule === 'none') return null;
  return `cited rule-${ink.rule} ink-${ink.tone}`;
}
