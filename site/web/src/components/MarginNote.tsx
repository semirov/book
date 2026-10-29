import type { CommentDto } from '@book/shared';
import { interventionKindLabel } from '@book/shared';
import { useEffect, useLayoutEffect } from 'react';

import { filingInk, filingQuote } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 — the note in the margin, at ≥1024. BOOK-220 §11.3 — the note prints **no number**.
 *
 * One `<button>` per sentence group, the whole box tappable. It is `position: absolute` inside
 * the sentence's span, so it contributes **zero** to the paragraph's layout: the prose cannot
 * move because a note appeared. The 188 px box starts past the mark: 16 px of air right of
 * the prose's right edge (`--mark-air`), then the numeral's 40 px target (`--mark-hit`), so
 * `--note-gap` is 56 and the note starts where the numeral's target ends. Its tie is the top
 * hairline, and every number is a token — nothing here reads the frame's `--shell`/`--measure`.
 *
 * The filing's number belongs to the mark beside the line (`FilingMark`); repeating it here is
 * what the owner saw as `№4НТ №4НТ` on one line. The note reads what the mark cannot say: the
 * state word, the count of the group when there really are several (`ещё 2`), the quoted
 * phrase, the kind and the author, and the one line of what happens next. No timestamp: the
 * stamp belongs to the record this note opens.
 */
export function MarginNote({
  comment,
  extra = 0,
  onOpen,
}: {
  comment: CommentDto;
  /** More filings share this sentence; the count is printed only when it is not zero. */
  extra?: number;
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const marginalia = filingMarginalia(comment);
  const ink = filingInk(comment);
  const kind = interventionKindLabel(comment.interventionKind);
  const who = kind === null ? comment.author : `${kind} · ${comment.author}`;
  const more = extra > 0 ? `ещё ${String(extra)}` : null;

  // The note's own mount is a change of the page's margin: the pass runs before paint.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [comment.id, comment.status]);

  return (
    <button
      type="button"
      className="margin-note ym-hide-content"
      data-margin-item="note"
      data-status={comment.status}
      {...(more === null ? {} : { 'data-extra': String(extra) })}
      onClick={(event) => onOpen(comment, event.currentTarget)}
    >
      <span className="margin-note-head">
        <span className={`margin-note-word ink-word-${ink.tone}`}>{marginalia.word}</span>
        {more === null ? null : <span className="margin-note-more">{more}</span>}
      </span>
      <span className="margin-note-quote">«{filingQuote(comment, 120)}»</span>
      <span className="margin-note-who">{who}</span>
      {/* BOOK-189 — a landed filing whose receipt was never stored has no second line: the
          word alone is the fact, and an empty span is not a line. */}
      {marginalia.consequence.length === 0 ? null : (
        <span className="margin-note-next">{marginalia.consequence}</span>
      )}
    </button>
  );
}
