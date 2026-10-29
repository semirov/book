import type { CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect } from 'react';

import { filingInk, filingNum, filingNumber, isAlive, isLanded, sortFilings, type SentenceFilings } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 / BOOK-218 — the mark at the sentence.
 *
 * Two forms, one box: the **alive** filing prints its numeral (`28.8 × 13.2`), the **landed**
 * change prints a 1 × 16 px tick. Both sit in a 40 × 44 px target that starts on the prose's
 * own right edge (`left: 100%` of the paragraph), and both are placed by the margin's own
 * ledger (`lib/marginPass.ts`), like every note of the channel: the mark is an item of the
 * channel, so `max(anchorTop, cursor)` keeps it off the object before it and the prose never
 * carries it. An alive filing wins the slot over a landed one: alive is louder, and the object
 * opened from the numeral lists the applied change too.
 *
 * Below 1024 the numeral leaves the text (the phone gutter cannot hold it): the mark is the
 * 1 px tick only, in a 24 × 44 target, and the numeral lives in the strip. The state is never
 * colour alone — the numeral is underlined while the filing is live and struck through when it
 * is stopped, the tick is a different *shape*, and the word travels in the accessible name and
 * with the strip row.
 */
export function FilingMark({
  filings,
  onOpen,
}: {
  filings: SentenceFilings;
  /** Both forms open the record at this sentence: the numeral a filing, the tick a landed one. */
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const ordered = sortFilings(filings.all);
  const alive = ordered.find(isAlive);
  const landed = ordered.find(isLanded);
  const newest = alive ?? landed;
  const aliveCount = ordered.filter(isAlive).length;

  // The mark is a margin item: its mount is a change of the page's channel, so the pass runs
  // before paint — the same one pass the notes ask for.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [newest?.id, newest?.status, filings.number]);

  if (alive !== undefined) {
    const ink = filingInk(alive);
    const extra = aliveCount - 1;
    return (
      <button
        type="button"
        className={`filing-mark filing-alive ink-${ink.tone}`}
        data-margin-item="mark"
        data-number={filingNum(alive)}
        data-state="alive"
        aria-label={`${filingNumber(alive)} · ${filingMarginalia(alive).word}${extra > 0 ? ` · ещё ${extra}` : ''}`}
        onClick={(event) => onOpen(alive, event.currentTarget)}
      >
        <span className="filing-mark-num">{filingNum(alive)}</span>
      </button>
    );
  }

  if (landed !== undefined) {
    return (
      <button
        type="button"
        className="filing-mark filing-tick"
        data-margin-item="mark"
        data-number={filingNum(landed)}
        data-state="accepted"
        aria-label={`${filingNumber(landed)} · ${filingMarginalia(landed).word}`}
        onClick={(event) => onOpen(landed, event.currentTarget)}
      >
        <span className="filing-tick-bar" aria-hidden="true" />
      </button>
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
