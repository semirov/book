import type { CommentDto } from '@book/shared';
import { interventionKindLabel } from '@book/shared';
import { useEffect, useLayoutEffect } from 'react';

import { filingNum, filingNumber, filingQuote } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 / BOOK-218 — the note in the margin, at ≥1024.
 *
 * One `<button>` per filing, the whole box tappable. It is `position: absolute` inside the
 * sentence's span, so it contributes **zero** to the paragraph's layout: the prose cannot
 * move because a note appeared. The 188 px box starts past the mark: 16 px of air right of
 * the prose's right edge (`--mark-air`), then the numeral's 40 px target (`--mark-hit`), so
 * `--note-gap` is 56 and the note starts where the numeral's target ends. Its tie is the top
 * hairline, and every number is a token — nothing here reads the frame's `--shell`/`--measure`.
 *
 * BOOK-218 — the note is a **pointer**, not a second record: the number, the quoted phrase
 * and who filed it. It prints no state word and no next line, because the record states them
 * once; it never re-tells the filing. Its ink is the quiet one, and the state at a glance
 * lives in the mark's shape (underlined while live, struck when stopped) and in this button's
 * `aria-label`, which carries the module's word (`замечание 12 · принято`).
 */
export function MarginNote({
  comment,
  onOpen,
}: {
  comment: CommentDto;
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const word = filingMarginalia(comment).word;
  const kind = interventionKindLabel(comment.interventionKind);
  const who = kind === null ? comment.author : `${kind} · ${comment.author}`;

  // The note's own mount is a change of the page's margin: the pass runs before paint.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [comment.id, comment.status]);

  return (
    <button
      type="button"
      className="margin-note ym-hide-content"
      data-margin-item="note"
      data-number={filingNum(comment)}
      data-status={comment.status}
      aria-label={`${filingNumber(comment)} · ${word}`}
      onClick={(event) => onOpen(comment, event.currentTarget)}
    >
      <span className="margin-note-head">
        <span className="margin-note-n">{filingNum(comment)}</span>
      </span>
      <span className="margin-note-quote">«{filingQuote(comment, 120)}»</span>
      <span className="margin-note-who">{who}</span>
    </button>
  );
}
