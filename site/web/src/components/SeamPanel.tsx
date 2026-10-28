import type { ChangeSummaryDto, CommentDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { changeLines } from '../lib/changeStatus.ts';
import { anchorCopy, commentStamp, commentStatusLine } from '../lib/commentView.ts';
import { filingNumber } from '../lib/filings.ts';
import { failedAttempt } from '../lib/marginalia.ts';
import type { AnchorRect } from '../lib/popover.ts';
import { reviseView } from '../lib/revise.ts';
import { reviseFiling } from '../lib/useRevise.ts';
import { ReviseNote } from './ReviseNote.tsx';

/** What the shell owns, whatever it is showing. */
export type FilingContext = {
  /**
   * The surface's own root class (`filing-panel ym-hide-content`). It is handed in, not spelled
   * here: the masking guard (BOOK-77) reads the literal where the surface lives, and the shell
   * adds nothing to it but the placement modifier.
   */
  rootClass: string;
  /** The anchor the card is placed against. */
  anchor: AnchorRect | null;
  comment: CommentDto;
  /**
   * BOOK-158: the page's revise clock (`useReviseTick`). The card's cooldown line counts down
   * from this value; a caller that does not know it falls back to its own render time.
   */
  nowMs?: number;
  /** The one close on screen — and, with `Escape`, the card's only way out. */
  onClose: () => void;
  /** BOOK-137: the attempts before the latest one, oldest first; no numbers and no links. */
  earlierAttempts?: readonly ChangeSummaryDto[];
  /** BOOK-137: the premise's derived reading — its change's intent, or null. */
  premiseIntent?: string | null;
  /**
   * BOOK-158 — «исправить» on the card. The surface that raised the card knows how to put it
   * away and open the strip (the chapter's row keeps its own state); without one, the card
   * closes itself and hands the page to the one shared act (`reviseFiling`).
   */
  onRevise?: (comment: CommentDto, origin: HTMLElement) => void;
  /**
   * BOOK-168 — one quiet line under the quote when the landing fell back to the chapter: the
   * filing's paragraph is gone, and the card says so instead of inventing a neighbour.
   */
  placeNote?: string | null;
};

/**
 * BOOK-DOC-34 §2.7 — **one** filing card, **one** ✕.
 *
 * BOOK-128 comment #3815 removed the provenance from this shell: a word's record is marginalia
 * now (`ProvenanceBlock`), not a context of a floating box, so the card has one body and no
 * way to turn into anything else. What the card still owns is the page's one floating frame:
 * measured against the anchor, clamped to the visual viewport, and closed by its own ✕ or by
 * `Escape` — never by a second surface it invented.
 */
export function SeamPanel(props: FilingContext) {
  const { onClose, rootClass } = props;
  const panel = useRef<HTMLElement>(null);

  // §7: focus moves into the card on open. The caller returns focus to the trigger when the
  // card closes, which is the only moment the strip gets its rows back.
  //
  // BOOK-168 (owner, 2026-10-28) — **the focus never moves the page**: the card is a block in
  // the flow now (BOOK-128 #3852), and `preventScroll` still keeps the door's landing where the
  // reader put it.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  // One `Escape` for the one box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      className={rootClass}
      role="dialog"
      aria-modal="false"
      aria-label={`замечание ${filingNumber(props.comment)}`}
      data-context="filing"
      ref={panel}
      tabIndex={-1}
    >
      <FilingBody {...props} />
    </aside>
  );
}

/**
 * BOOK-136 — the card's fact line, from the two things it can say: the deck's detail (a
 * receipt, a refusal, an attempt that came back empty) and, for a premise that still waits,
 * the derived reading of what was accepted into the basis. A failed attempt is never swallowed
 * by the derived reading: the reader gets the human sentence first, then the reading.
 */
function premiseReading(
  comment: CommentDto,
  premiseIntent: string | null,
  detail: string | null,
): string | null {
  if (premiseIntent === null || comment.premise !== true || comment.status === 'applied') return detail;
  const intake = `принято в основу: ${premiseIntent}`;
  return failedAttempt(comment) && detail !== null ? `${detail} · ${intake}` : intake;
}

/**
 * §2.7 — one filing, whole.
 *
 * Two lines that must never merge: the decision in the reader's words and the application as a
 * fact. The body is shown whole (this is where a long comment lives; the strip clamps, the
 * card does not).
 *
 * BOOK-70: the state is printed once, in the form its own text asks for. A state that fits a
 * chip (≤ 24 characters, no clause in it) is a `.filing-state` — one line, 12 px, one of the two
 * inks. A clause or a receipt — an applied filing names the chapter and the right that moved
 * with it — is a `.filing-sentence`: 14 px, the book's voice, and it may wrap, because a clause
 * cut to one line at 320 px either overflows the panel or lies about its length.
 */
function FilingBody({
  comment,
  onClose,
  earlierAttempts = [],
  premiseIntent = null,
  placeNote = null,
  nowMs,
  onRevise,
}: FilingContext) {
  const line = commentStatusLine(comment);
  const quote = anchorCopy(comment);
  /** A chip has two inks: `--live` for work in flight, `--ink-3` for everything settled. */
  const ink = line.tone === 'live' ? 'ink-live' : 'ink-quiet';
  /**
   * BOOK-137 — a premise's derived reading: the intent of the change it was taken into, in
   * the change's own words. While the premise waits, that sentence says what was accepted
   * into the basis; a landed premise keeps its receipt («вошло в первую редакцию…»), which is
   * a fact about the book and not a restatement of the reader.
   */
  const reading = premiseReading(comment, premiseIntent, line.detail);
  /**
   * BOOK-158 — a refused filing's card is the second place the reader looks after the row: the
   * hint, the door and the reason the door is shut. The refusal's own sentence is already the
   * card's fact line, so only the hint and the action are printed here.
   */
  const revise = reviseView(comment, nowMs);
  const openRevise = (origin: HTMLElement): void => {
    if (onRevise !== undefined) {
      onRevise(comment, origin);
      return;
    }
    // The card gives the strip the page; the reader is done reading this box.
    onClose();
    reviseFiling(comment, origin);
  };

  return (
    <>
      <div className="filing-head">
        <span className="filing-title">замечание {filingNumber(comment)}</span>
        <button type="button" className="filing-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      <p className="filing-meta">
        {comment.author} · {commentStamp(comment.createdAt)} · глава {String(comment.chapter).padStart(2, '0')}
      </p>
      {quote === null ? null : <p className="filing-quote">«{quote}»</p>}
      {/* BOOK-168 — the landing fell back to the chapter: the card states it once, under the
          quote it kept, and never points at a paragraph that is no longer the one filed on. */}
      {placeNote === null ? null : <p className="filing-place-note">{placeNote}</p>}
      <p className="filing-body">{comment.body}</p>
      {line.form === 'sentence' ? (
        <p className="filing-sentence">{line.state}</p>
      ) : (
        <p className={`filing-state ${ink}`}>{line.state}</p>
      )}
      {/*
        BOOK-90: the receipt of a landed change and the reader's reason are the detail — the
        fact the three-word state cannot carry. It was printed as the state itself (BOOK-58/
        BOOK-70); the word now stands alone and this line keeps the fact whole.
      */}
      {reading === null ? null : <p className="filing-fact">{reading}</p>}
      {revise === null ? null : (
        <ReviseNote view={revise} className="filing-revise" onRevise={openRevise} />
      )}
      {/*
        BOOK-137 — the attempts before the latest one, inside the entry they belong to and
        without a number or a link of their own: the entry's quiet line above the card carries
        the one number and the one `прицел` of the latest attempt.
      */}
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
