import type { CommentDto } from '@book/shared';
import type { ReactNode } from 'react';

import { filingNumber } from '../lib/filings.ts';
import { filingConsequence } from '../lib/marginalia.ts';
import { RECORD_CUT, type InterventionRow, type RowWindow } from '../lib/recState.ts';

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
  /** The pressed header itself: the record keeps it under the finger across the switch. */
  onPress: (control: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className="rec-section"
      aria-expanded={open}
      data-open={open ? 'true' : 'false'}
      onClick={(event) => onPress(event.currentTarget)}
    >
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
  history = false,
  onLift,
  onFold,
  onOpen,
}: {
  rows: RowWindow<InterventionRow | { id: string; facts: string; specimen: string }>;
  lifted: boolean;
  history?: boolean;
  onLift: () => void;
  onFold: () => void;
  onOpen?: (row: InterventionRow) => void;
}) {
  // One source for one invariant: the list's length is what the window shows plus what its door
  // still hides. A `total` handed in beside them could disagree with both (BOOK-199 m3).
  const shown = rows.rows.length;
  const total = shown + rows.rest;
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
      {rows.rest > 0 ? (
        <div className="rec-fold rec-fold-end">
          <span>{`показаны ${String(shown)} из ${String(total)}`}</span>
          {/* BOOK-199 m3 — the count is never a dead end: its own control opens the rest. */}
          <button type="button" onClick={onLift}>{`ещё ${String(rows.rest)} →`}</button>
        </div>
      ) : lifted && total > RECORD_CUT ? (
        <button type="button" className="rec-fold" onClick={onFold}>
          свернуть
        </button>
      ) : null}
    </div>
  );
}

/**
 * BOOK-128 #3863 — the quote with the touched word underlined: decoration only, no box, no
 * second node. The word is a paragraph offset; the anchor's sentence start turns it into an
 * index inside the quote. A word outside its own sentence is not underlined, and the sentence
 * reads whole.
 */
export function QuoteBody({
  quote,
  word,
  sentenceStart,
}: {
  quote: string;
  word: { start: number; end: number } | null;
  sentenceStart: number | null;
}): ReactNode {
  if (word === null || sentenceStart === null) return quote;
  const from = word.start - sentenceStart;
  const to = word.end - sentenceStart;
  if (from < 0 || to > quote.length || to <= from) return quote;
  return (
    <>
      {quote.slice(0, from)}
      <span className="rec-word">{quote.slice(from, to)}</span>
      {quote.slice(to)}
    </>
  );
}

/** The words `вмешаться` says when the sentence already carries a live filing. */
export const EXISTING_FILING_LINE = 'у этой фразы уже есть заявка — открыть её?';

/**
 * BOOK-128 #3862 — that notice, in the same body: the filing is offered, and a new one stays
 * possible. Two targets, each 44 px; the record's `keepPlace` wraps both.
 */
export function ExistingFilingNotice({ onOpen, onNew }: { onOpen: () => void; onNew: () => void }) {
  return (
    <div className="rec-notice">
      <p className="rec-notice-line">{EXISTING_FILING_LINE}</p>
      <div className="rec-notice-acts">
        <button type="button" className="rec-notice-open" onClick={onOpen}>
          открыть заявку →
        </button>
        <button type="button" className="rec-notice-new" onClick={onNew}>
          всё равно написать
        </button>
      </div>
    </div>
  );
}

/**
 * A filing read in full — the same body, not a card: back row, its facts, the sentence it was
 * filed on and the sentence that stands there now, then the reader's words. The record opens
 * with this body when a numeral, a margin note or a place door names the filing.
 */
export function FilingBody({
  comment,
  onBack,
  before = null,
  after = null,
}: {
  comment: CommentDto;
  onBack: () => void;
  /** The filing's stored sentence, when the book rewrote it (`было`). */
  before?: string | null;
  /** The sentence as it stands now (`стало`). */
  after?: string | null;
}) {
  return (
    <div className="rec-filing ym-hide-content" data-kind="filing">
      <button type="button" className="rec-back" onClick={onBack}>
        ← замечания
      </button>
      <p className="rec-filing-facts">
        {`${filingNumber(comment)} · ${comment.author} · ${filingConsequence(comment)}`}
      </p>
      {before === null ? null : (
        <p className="rec-change-row">
          <span className="rec-change-label">было</span>
          <span className="rec-change-quote">«{before}»</span>
        </p>
      )}
      {after === null ? null : (
        <p className="rec-change-row">
          <span className="rec-change-label">стало</span>
          <span className="rec-change-quote">«{after}»</span>
        </p>
      )}
      <p className="rec-filing-text">{comment.body}</p>
    </div>
  );
}
