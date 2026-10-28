import { focusHash } from '../lib/focus.ts';
import type { PremiseRow as PremiseRowData } from '../lib/premise.ts';
import { ReviseNote } from './ReviseNote.tsx';

/**
 * BOOK-90 A — the chapter's one row, and BOOK-137 — the premise filing's only entry.
 *
 *   `02 ················································`
 *   `02 «смена переходит на ночь» ················ ждёт`
 *
 * Numeral at the prose's left edge (mono, `--fs-micro`, tabular), then the dotted field to
 * the prose's right edge. The right end belongs to the page number (BOOK-89): the row is a
 * grid whose last cell is `1fr`, so adding that cell later is a data change, not a layout
 * change.
 *
 * **The row prints the book, and one word when the slot is taken.** It is a chapter number, a
 * leader and — when the slot holds one — the premise's own quote, followed by that premise's
 * state word («ждёт»). Why a word after all: an empty slot and a pending filing must not read
 * alike, or the reader who already filed taps again and is refused (BOOK-111, owner
 * 2026-10-27). The word is the deck's own (`filingMarginalia`), never a label invented here.
 *
 * BOOK-137 — the entry's **one** number and its **one** `прицел` sit on a quiet line under the
 * row, as siblings of the row's button: a link inside the button would fire both acts on one
 * tap, and a second number on the page would be a second entry.
 */
export function PremiseRow({
  row,
  onOpen,
  onRevise,
}: {
  row: PremiseRowData;
  onOpen: (origin: HTMLElement) => void;
  /** BOOK-158: «исправить» reopens the strip on the refused premise. */
  onRevise: (origin: HTMLElement) => void;
}) {
  return (
    // BOOK-77 (audit F1): a filled slot shows the premise's own first line — a reader's words.
    <div className="premise ym-hide-content">
      <button
        type="button"
        className="premise-row"
        data-state={row.quote === null ? 'empty' : 'held'}
        data-comment-id={row.commentId ?? undefined}
        aria-label={row.word === null ? `глава ${row.n}` : `глава ${row.n} · ${row.word}`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="premise-n">{String(row.n).padStart(2, '0')}</span>
        {row.quote === null ? (
          <span className="premise-field premise-leader" aria-hidden="true" />
        ) : (
          <span className="premise-field premise-quote">«{row.quote}»</span>
        )}
        {row.word === null ? null : <span className="premise-label">{row.word}</span>}
      </button>
      {row.reason === null ? null : (
        // BOOK-158: a refused premise says why, under the row: the word «ждёт» alone would read
        // as an ordinary wait and the reader would not know what to change.
        <p className="premise-note">{row.reason}</p>
      )}
      {row.note === null ? null : (
        // BOOK-136: the attempt came back empty — the deck's one sentence, under the row and
        // never inside it (the row is the book; this line is the record's own fact).
        <p className="premise-note">{row.note}</p>
      )}
      {row.revise === null ? null : (
        <ReviseNote view={row.revise} onRevise={onRevise} className="premise-revise" />
      )}
      {row.attempt === null ? null : (
        <p className="premise-meta">
          {/* The number is the attempt's, not the chapter's: the row already carries the
              chapter's numeral, and a second one would read as a second place in the book. */}
          {row.attempt.number === null ? null : (
            <span className="premise-attempt">{row.attempt.number}</span>
          )}
          <a className="premise-open" href={focusHash(row.attempt.id)}>
            прицел →
          </a>
        </p>
      )}
    </div>
  );
}
