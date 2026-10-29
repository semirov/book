import { outcomeLine, type ChangeSummaryDto, type CommentDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { changeLines } from '../lib/changeStatus.ts';
import { anchorCopy, commentStamp, commentStatusLine } from '../lib/commentView.ts';
import { failedAttempt, outcomeOf, STATE_WORDS } from '../lib/marginalia.ts';
import { filingNumber } from '../lib/filings.ts';
import { reviseView } from '../lib/revise.ts';
import { reviseFiling } from '../lib/useRevise.ts';
import { ReviseNote } from './ReviseNote.tsx';

/**
 * The **one card** the page keeps: a filing with no sentence to stand on.
 *
 * The sentence's surfaces are the record now — the numeral at a sentence, its margin note, the
 * change a revision tick names, the strip's filing rows: all of them open the record at that
 * sentence, where the filing's body, its quote, its earlier attempts and the change's `правка`
 * live in the register. A premise has no paragraph, and a place door may name an anchor the
 * log no longer resolves to a sentence; those are the named exception, and this card is it.
 *
 * It is a block in the flow (`.filing-panel`, `record-notice`'s hairline geometry): no backdrop,
 * no `position: fixed`, no portal, no focus trap. One `✕` and `Escape` are its only way out.
 */
export const FILING_PANEL_CLASS = 'filing-panel ym-hide-content';

export function FilingCard({
  comment,
  onClose,
  earlierAttempts = [],
  premiseIntent = null,
  placeNote = null,
  nowMs,
  onRevise,
}: {
  comment: CommentDto;
  onClose: () => void;
  /** BOOK-137: earlier attempts, oldest first — inside the entry, never rows of their own. */
  earlierAttempts?: readonly ChangeSummaryDto[];
  /** BOOK-137: the premise's derived reading, from its change's intent. */
  premiseIntent?: string | null;
  /** BOOK-168: the one line when the landing fell back to the chapter. */
  placeNote?: string | null;
  /** BOOK-158: the page's revise clock, so the card's cooldown line counts down. */
  nowMs?: number;
  /** BOOK-158: the card's way back from a refusal. */
  onRevise?: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      className={FILING_PANEL_CLASS}
      role="dialog"
      aria-modal="false"
      aria-label={filingNumber(comment)}
      data-context="filing"
      ref={panel}
      tabIndex={-1}
    >
      <FilingContent
        comment={comment}
        earlierAttempts={earlierAttempts}
        premiseIntent={premiseIntent}
        placeNote={placeNote}
        nowMs={nowMs}
        onClose={onClose}
        {...(onRevise === undefined ? {} : { onRevise })}
      />
    </aside>
  );
}

/**
 * The body of the filing, without its frame: what the card prints, and what a record's
 * `замечания` row opens (`FilingBody` in the record).
 */
export function FilingContent({
  comment,
  earlierAttempts = [],
  premiseIntent = null,
  placeNote = null,
  nowMs,
  onClose,
  onRevise,
}: {
  comment: CommentDto;
  earlierAttempts?: readonly ChangeSummaryDto[];
  premiseIntent?: string | null;
  placeNote?: string | null;
  nowMs?: number;
  onClose: () => void;
  onRevise?: (comment: CommentDto, origin: HTMLElement) => void;
}) {
  const line = commentStatusLine(comment);
  // BOOK-218 — the reading appears only when the edit was accepted and written; a lock or our
  // failure is already the state line, and printing it twice is the defect this replaces.
  const outcome = outcomeOf(comment);
  const readingLine = outcome !== null && outcome.kind === 'reading' ? outcomeLine(outcome) : null;
  const quote = anchorCopy(comment);
  const ink = line.tone === 'live' ? 'ink-live' : 'ink-quiet';
  const reading = premiseReading(comment, premiseIntent, line.detail);
  const revise = reviseView(comment, nowMs);
  const openRevise = (origin: HTMLElement): void => {
    if (onRevise !== undefined) {
      onRevise(comment, origin);
      return;
    }
    onClose();
    reviseFiling(comment, origin);
  };

  return (
    <>
      <div className="filing-head">
        <span className="filing-title">{filingNumber(comment)}</span>
        <button type="button" className="filing-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      {readingLine === null ? null : <p className="filing-resolution-head">{readingLine}</p>}
      <p className="filing-meta">
        {comment.author} · {commentStamp(comment.createdAt)} · глава {String(comment.chapter).padStart(2, '0')}
      </p>
      {quote === null ? null : <p className="filing-quote">«{quote}»</p>}
      {placeNote === null ? null : <p className="filing-place-note">{placeNote}</p>}
      <p className="filing-body">{comment.body}</p>
      {line.form === 'sentence' ? (
        <p className="filing-sentence">{line.state}</p>
      ) : (
        <p className={`filing-state ${ink}`}>{line.state}</p>
      )}
      {reading === null ? null : <p className="filing-fact">{reading}</p>}
      {revise === null ? null : <ReviseNote view={revise} className="filing-revise" onRevise={openRevise} />}
      {earlierAttempts.length === 0 ? null : (
        <ol className="filing-attempts">
          {earlierAttempts.map((attempt) => {
            const lines = changeLines(attempt);
            return (
              <li className="filing-attempt" key={attempt.id}>
                {lines.first} · {lines.second}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

/** A premise's derived reading, from the change it was taken into. */
function premiseReading(
  comment: CommentDto,
  premiseIntent: string | null,
  detail: string | null,
): string | null {
  if (premiseIntent === null || comment.premise !== true || comment.status === 'applied') return detail;
  // BOOK-218 — the module's word for the fact, never a second literal of it.
  const intake = `${STATE_WORDS.accepted} в основу: ${premiseIntent}`;
  return failedAttempt(comment) && detail !== null ? `${detail} · ${intake}` : intake;
}
