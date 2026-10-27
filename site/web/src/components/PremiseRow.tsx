import type { PremiseRow as PremiseRowData } from '../lib/premise.ts';

/**
 * BOOK-90 A — the empty chapter is one row, once.
 *
 *   `02 ················································`
 *
 * Numeral at the prose's left edge (mono, `--fs-micro`, tabular), then the dotted field to
 * the prose's right edge. The right end belongs to the page number (BOOK-89): the row is a
 * grid whose last cell is `1fr`, so adding that cell later is a data change, not a layout
 * change.
 *
 * **The row prints no state word.** It is a chapter number, a leader and — when the slot
 * holds one — the premise's own quote. «замысел» is a label of the interface, and the
 * reading surface prints the book: the state belongs to the strip the reader opens, to the
 * chronicle and to the panels. A held premise keeps its quote in the field; the tap opens the
 * premise's own card.
 */
export function PremiseRow({
  row,
  onOpen,
}: {
  row: PremiseRowData;
  onOpen: (origin: HTMLElement) => void;
}) {
  return (
    // BOOK-77 (audit F1): a filled slot shows the premise's own first line — a reader's words.
    <div className="premise ym-hide-content">
      <button
        type="button"
        className="premise-row"
        data-state={row.quote === null ? 'empty' : 'held'}
        aria-label={`глава ${row.n}`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="premise-n">{String(row.n).padStart(2, '0')}</span>
        {row.quote === null ? (
          <span className="premise-field premise-leader" aria-hidden="true" />
        ) : (
          <span className="premise-field premise-quote">«{row.quote}»</span>
        )}
      </button>
    </div>
  );
}
