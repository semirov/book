import type { CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePanel } from '../lib/cssom.ts';
import { anchorCopy, commentStamp, commentStatusLine } from '../lib/commentView.ts';
import { filingNumber } from '../lib/filings.ts';
import { placePopover, samePlacement, type AnchorRect, type PopoverPlacement } from '../lib/popover.ts';

const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-DOC-34 §2.7 — one filing, opened from its mark or from its row in the strip.
 *
 * Two lines that must never merge: the decision in the reader's words and the application as
 * a fact. The body is shown whole (this is where a long comment lives; the strip clamps, the
 * panel does not). Same placement and keyboard contract as the provenance panel.
 *
 * BOOK-70: the state is printed once, in the form its own text asks for. A state that fits a
 * chip (≤ 24 characters, no clause in it) is a `.filing-state` — one line, 12 px, one of the
 * two inks. A clause or a receipt — an applied filing names the chapter and the right that
 * moved with it — is a `.filing-sentence`: 14 px, the book's voice, and it may wrap, because
 * a clause cut to one line at 320 px either overflows the panel or lies about its length. The
 * old «состояние: …» line said the same thing a third time in a third voice, and it is gone.
 */
export function FilingPanel({
  comment,
  anchor,
  onClose,
}: {
  comment: CommentDto;
  anchor: AnchorRect | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const line = commentStatusLine(comment);
  const quote = anchorCopy(comment);
  /** A chip has two inks: `--live` for work in flight, `--ink-3` for everything settled. */
  const ink = line.tone === 'live' ? 'ink-live' : 'ink-quiet';

  useMeasuredLayout(() => {
    if (anchor === null) return;
    const node = panel.current;
    if (node === null || typeof window === 'undefined') return;
    const size = { width: Math.min(420, window.innerWidth - 24), height: node.scrollHeight };
    const next = placePopover(anchor, size, { width: window.innerWidth, height: window.innerHeight });
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchor, comment]);

  useMeasuredLayout(() => {
    placePanel(panel.current, placement);
  }, [placement]);

  // §7: focus moves into the panel on open; the caller returns it to the trigger on close.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // BOOK-77 (audit F1): the author, the quote and the whole body are the reader's words, so
  // the panel carries `ym-hide-content` in both of its placements.
  return (
    <aside
      className={`filing-panel ym-hide-content${placement === null ? '' : ' filing-panel-anchored'}`}
      role="dialog"
      aria-modal="false"
      aria-label={`замечание ${filingNumber(comment)}`}
      ref={panel}
      tabIndex={-1}
    >
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
      {line.detail === null ? null : <p className="filing-fact">{line.detail}</p>}
    </aside>
  );
}
