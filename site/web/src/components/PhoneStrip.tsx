import type { CommentDto } from '@book/shared';
import { interventionKindLabel } from '@book/shared';

import { filingInk, filingNumber, stripFilings } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';

/**
 * BOOK-90 — the phone strip, at <1024.
 *
 * The same object family as the seam's strip and the same facts as the margin note, on one
 * 44 px row: numeral, kind, the state word and the door. It sits **inside** the paragraph as
 * its last child, so arriving filings never re-wrap the lines above it; `.p`'s justification
 * and `pre-line` would otherwise justify a list of buttons, so both are reset here.
 *
 * Two rows and «ещё N →» (the existing overflow rule). No count, no badge, no hover-only
 * affordance: the row is the target and the word is in the DOM.
 */
export function PhoneStrip({
  comments,
  skipQuote,
  onOpen,
}: {
  /** Alive filings of this paragraph, in reading order. */
  comments: readonly CommentDto[];
  /** The sentence whose seam is open: its own rows already show it. */
  skipQuote: string | null;
  onOpen: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const rows = comments.filter((comment) => skipQuote === null || comment.anchor.quote !== skipQuote);
  if (rows.length === 0) return null;
  const { shown, more } = stripFilings({ all: rows });
  const hidden = rows[shown.length];
  return (
    <span className="phone-strip ym-hide-content">
      {shown.map((comment) => {
        const marginalia = filingMarginalia(comment);
        const ink = filingInk(comment);
        const kind = interventionKindLabel(comment.interventionKind);
        // BOOK-218 — the filing's own public number, the same one the mark prints.
        const number = Number.isFinite(comment.number) ? filingNumber(comment) : null;
        return (
          <button
            key={comment.id}
            type="button"
            className="phone-strip-row"
            data-status={comment.status}
            data-number={number ?? undefined}
            onClick={(event) => onOpen(comment, event.currentTarget)}
          >
            {/* §11.3 — the phone's number is the change's own, as the mark's is: a token cut
                from an id is not an ordinal the book can back. */}
            {number === null ? null : (
              <span className={`phone-strip-n ink-word-${ink.tone}`}>{number}</span>
            )}
            {kind === null ? null : (
              <>
                {number === null ? null : (
                  <span className="phone-strip-dot" aria-hidden="true">
                    ·
                  </span>
                )}
                <span className="phone-strip-kind">{kind}</span>
              </>
            )}
            {number === null && kind === null ? null : (
              <span className="phone-strip-dot" aria-hidden="true">
                ·
              </span>
            )}
            <span className={`phone-strip-word ink-word-${ink.tone}`}>{marginalia.word}</span>
            <span className="phone-strip-go" aria-hidden="true">
              →
            </span>
          </button>
        );
      })}
      {more === 0 || hidden === undefined ? null : (
        <button type="button" className="phone-strip-row phone-strip-more" onClick={(event) => onOpen(hidden, event.currentTarget)}>
          ещё {more} →
        </button>
      )}
    </span>
  );
}
