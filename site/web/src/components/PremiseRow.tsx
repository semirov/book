import type { CommentDto } from '@book/shared';

import { commentStatusLine } from '../lib/commentView.ts';
import type { PremiseRow as PremiseRowData } from '../lib/premise.ts';
import { PREMISE_HINT } from '../lib/premise.ts';

/**
 * BOOK-DOC-34 §2.4 — the empty slot in the reading flow.
 *
 * A 44 px row: the field number, a dotted field, the word «замысел». It is the site's existing
 * language for an unfilled field, not a call to action, and it disappears the day the chapter
 * is written. A slot that already holds a premise shows that premise and its state instead.
 */
export function PremiseRow({ row, onOpen }: { row: PremiseRowData; onOpen: (origin: HTMLElement) => void }) {
  return (
    // BOOK-77 (audit F1): a filled slot shows the premise's own first line — a reader's words.
    <div className="premise ym-hide-content">
      <button
        type="button"
        className="premise-row"
        data-state={row.quote === null ? 'empty' : 'held'}
        aria-label={`глава ${row.n} · ${row.label}`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="premise-n">{String(row.n).padStart(2, '0')}</span>
        <span className="premise-field">
          {row.quote === null ? null : <span className="premise-quote">«{row.quote}»</span>}
        </span>
        <span className="premise-label">{row.label}</span>
      </button>
      {row.state === null ? null : <p className="premise-state">{row.state}</p>}
      {row.quote === null ? <p className="premise-hint">{PREMISE_HINT}</p> : null}
    </div>
  );
}

/** The premise a chapter already holds, as the register prints it (BOOK-7). */
export function premiseStateWord(premise: CommentDto): string {
  return commentStatusLine(premise).state;
}
