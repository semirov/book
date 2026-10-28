import type { CommentDto } from '@book/shared';

import { filingNumber } from '../lib/filings.ts';
import { filingConsequence } from '../lib/marginalia.ts';
import type { InterventionRow, RowWindow } from '../lib/recState.ts';

/**
 * BOOK-128 comment #3863 — the record's three repeated shapes: a section header, a list of rows
 * with the count law, and a filing read in full. They live beside `Record.tsx` because they are
 * drawn, not decided: every word and every count comes from `lib/recState.ts`.
 */

/** A section header: label, count, one chevron that rotates and never lays out. */
export function SectionHeader({
  label,
  count,
  open,
  onPress,
}: {
  label: string;
  count: string | null;
  open: boolean;
  onPress: () => void;
}) {
  return (
    <button type="button" className="rec-section" aria-expanded={open} data-open={open ? 'true' : 'false'} onClick={onPress}>
      <span className="rec-section-label">{label}</span>
      <span className="rec-section-side">
        {count === null ? null : <span className="rec-section-count">{count}</span>}
        <span className="rec-chevron" aria-hidden="true" />
      </span>
    </button>
  );
}

export function RowsList({
  rows,
  lifted,
  total,
  history = false,
  onLift,
  onFold,
  onOpen,
}: {
  rows: RowWindow<InterventionRow | { id: string; facts: string; specimen: string }>;
  lifted: boolean;
  total: number;
  history?: boolean;
  onLift: () => void;
  onFold: () => void;
  onOpen?: (row: InterventionRow) => void;
}) {
  return (
    <div className="rec-rows">
      {rows.rows.map((row) => {
        if (history) {
          return (
            <div className="rec-row" key={row.id} data-kind="history">
              <p className="rec-row-facts">{row.facts}</p>
              <p className="rec-row-specimen">{row.specimen}</p>
            </div>
          );
        }
        return (
          <button
            type="button"
            className="rec-row"
            data-kind="intervention"
            data-own={(row as InterventionRow).own ? 'true' : undefined}
            key={row.id}
            onClick={() => onOpen?.(row as InterventionRow)}
          >
            <span className="rec-row-facts">{row.facts}</span>
            <span className="rec-row-specimen">{row.specimen}</span>
          </button>
        );
      })}
      {rows.more > 0 ? (
        <button type="button" className="rec-fold" onClick={onLift}>
          {`ещё ${String(rows.more)} →`}
        </button>
      ) : null}
      {rows.over > 0 ? (
        <div className="rec-fold rec-fold-end">
          <span>{`показаны 6 из ${String(total)}`}</span>
          {lifted ? (
            <button type="button" onClick={onFold}>
              свернуть
            </button>
          ) : null}
        </div>
      ) : null}
      {rows.over === 0 && lifted && total > 6 ? (
        <button type="button" className="rec-fold" onClick={onFold}>
          свернуть
        </button>
      ) : null}
    </div>
  );
}

/** A filing read in full — the same body, not a card: back row, text, state, the deck's line. */
export function FilingBody({ comment, onBack }: { comment: CommentDto; onBack: () => void }) {
  return (
    <div className="rec-filing" data-kind="filing">
      <button type="button" className="rec-back" onClick={onBack}>
        ← замечания
      </button>
      <p className="rec-filing-facts">
        {`${filingNumber(comment)} · ${comment.author} · ${filingConsequence(comment)}`}
      </p>
      <p className="rec-filing-text">{comment.body}</p>
    </div>
  );
}
