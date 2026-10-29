import type { CommentDto } from '@book/shared';
import { filingWord } from '@book/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { changeNumber } from '../lib/changeStatus.ts';
import { filingInk, isAlive, isLanded, sortFilings, type SentenceFilings } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 — the mark at the sentence, and BOOK-220 §11.3 — **one mark per filing group**.
 *
 * The mark is the only element in the margin that prints a filing's number. It used to cut a
 * token out of the filing's id (`№4НТ`) while the note beside it printed the same token again:
 * one filing, two numbers on one line, and the same number a third time in the record. The
 * number is now the change's own `seq` — a number the book can back (`012`) — the note prints
 * no number, and a group that really holds several filings carries their count (`ещё 2`) in the
 * mark's accessible name and in the note's head, never the same number twice.
 *
 * Two forms, one box: an **alive** filing prints its number (`28.8 × 13.2`), a **landed**
 * change prints a 1 × 16 px tick, and a filing no change number was ever given prints the tick
 * too — an ordinal cut out of an id is a claim no row makes. Both sit in a 40 × 44 px target
 * that starts exactly at the prose's right edge, centred on the anchored line, and both are
 * written through CSSOM — no `style` attribute reaches the markup. An alive filing wins the
 * slot over a landed one: alive is louder.
 *
 * Below 1024 the numeral leaves the text (the phone gutter cannot hold it): the mark is the
 * 1 px tick only, in a 24 × 44 target, and the numeral lives in the strip. The state is never
 * colour alone — the tick is a different *shape* from the numeral, and the word travels with
 * the strip row and the note.
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
    const number = filingWord(alive.changeSeq);
    // An alive filing with no change number has no ordinal to print: the tick is the honest
    // shape, and the accessible name still says who it is.
    if (alive.changeSeq === null || alive.changeSeq === undefined) {
      return (
        <span className="filing-mark-slot" ref={slot}>
          <button
            ref={button}
            type="button"
            className={`filing-mark filing-alive filing-bare ink-${ink.tone}`}
            data-number={number}
            data-state="alive"
            aria-label={`${number} · ${filingMarginalia(alive).word}${extra > 0 ? ` · ещё ${String(extra)}` : ''}`}
            onClick={(event) => onOpen(alive, event.currentTarget)}
          >
            <span className="filing-tick-bar" aria-hidden="true" />
          </button>
        </span>
      );
    }
    return (
      <span className="filing-mark-slot" ref={slot}>
        <button
          ref={button}
          type="button"
          className={`filing-mark filing-alive ink-${ink.tone}`}
          data-number={number}
          data-state="alive"
          {...(extra > 0 ? { 'data-extra': String(extra) } : {})}
          aria-label={`${number} · ${filingMarginalia(alive).word}${extra > 0 ? ` · ещё ${String(extra)}` : ''}`}
          onClick={(event) => onOpen(alive, event.currentTarget)}
        >
          <span className="filing-mark-num">{changeNumber(alive.changeSeq)}</span>
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
          data-number={filingWord(landed.changeSeq)}
          data-state="accepted"
          aria-label={`${filingMarginalia(landed).word} · открыть запись ${filingWord(landed.changeSeq)}`}
          onClick={(event) => onOpen(landed, event.currentTarget)}
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
