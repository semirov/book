import type { PremiseRow as PremiseRowData } from '../lib/premise.ts';
import { PREMISE_HINT } from '../lib/premise.ts';

/**
 * BOOK-90 A — the empty chapter is one row, once.
 *
 *   `02  замысел ········································`
 *
 * Numeral at the prose's left edge (mono, `--fs-micro`, tabular), the word immediately after
 * it (one 12 px gap, the label register), then the dotted field to the prose's right edge.
 * The right end belongs to the page number (BOOK-89): the row is a grid whose last cell is
 * `1fr`, so adding that cell later is a data change, not a layout change.
 *
 * The row is the slot's *only* numeral and the hint is the page's only one: the renderer that
 * knows the chapter order decides `firstEmpty`, and this row prints the sentence only while
 * its own strip is closed — when the strip is open, the strip carries it (and only then). A
 * held premise keeps its quote in the field; the tap opens the premise's own card.
 */
export function PremiseRow({
  row,
  hint = false,
  onOpen,
}: {
  row: PremiseRowData;
  /** The first empty chapter with its strip closed: only this row prints the sentence. */
  hint?: boolean;
  onOpen: (origin: HTMLElement) => void;
}) {
  return (
    // BOOK-77 (audit F1): a filled slot shows the premise's own first line — a reader's words.
    <div className="premise ym-hide-content">
      <button
        type="button"
        className="premise-row"
        data-state={row.quote === null ? 'empty' : 'held'}
        aria-label={`глава ${row.n} · ${row.word}`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="premise-n">{String(row.n).padStart(2, '0')}</span>
        <span className="premise-label">{row.word}</span>
        {row.quote === null ? (
          <span className="premise-field premise-leader" aria-hidden="true" />
        ) : (
          <span className="premise-field premise-quote">«{row.quote}»</span>
        )}
      </button>
      {hint ? <p className="premise-hint">{PREMISE_HINT}</p> : null}
    </div>
  );
}
