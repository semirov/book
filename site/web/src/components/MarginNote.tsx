import type { CommentDto } from '@book/shared';
import { interventionKindLabel } from '@book/shared';
import { useEffect, useLayoutEffect } from 'react';

import { filingInk, filingNumber, filingQuote } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 — the note in the margin, at ≥1024.
 *
 * One `<button>` per filing, the whole box tappable. It is `position: absolute` inside the
 * sentence's span, so it contributes **zero** to the paragraph's layout: the prose cannot
 * move because a note appeared. The 188 px box starts 40 px right of the prose's right edge
 * (`--note-gap` = the mark's target), its tie is the top hairline, and every number is a
 * token — nothing here reads the frame's `--shell`/`--measure`.
 *
 * What a reader sees without a click: the record's numeral, the state word, the quoted
 * phrase, the kind and the author, and the one line of what happens next. No timestamp: the
 * stamp belongs to the opened object.
 */
export function MarginNote({
  comment,
  onOpen,
}: {
  comment: CommentDto;
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const marginalia = filingMarginalia(comment);
  const ink = filingInk(comment);
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
      data-number={filingNumber(comment)}
      data-status={comment.status}
      onClick={(event) => onOpen(comment, event.currentTarget)}
    >
      <span className="margin-note-head">
        <span className="margin-note-n">{filingNumber(comment)}</span>
        <span className={`margin-note-word ink-word-${ink.tone}`}>{marginalia.word}</span>
      </span>
      <span className="margin-note-quote">«{filingQuote(comment, 120)}»</span>
      <span className="margin-note-who">{who}</span>
      <span className="margin-note-next">{marginalia.consequence}</span>
    </button>
  );
}
