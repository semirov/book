import type { CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePanel } from '../lib/cssom.ts';
import { anchorCopy, commentStamp, commentStatusLine } from '../lib/commentView.ts';
import { filingNumber, filingWord } from '../lib/filings.ts';
import { placePopover, samePlacement, type AnchorRect, type PopoverPlacement } from '../lib/popover.ts';
import { receiptLine } from '../lib/terms.ts';

const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-DOC-34 §2.7 — one filing, opened from its mark or from its row in the strip.
 *
 * Two lines that must never merge: the decision in the reader's words and the application as
 * a fact. The body is shown whole (this is where a long comment lives; the strip clamps, the
 * panel does not). Same placement and keyboard contract as the provenance panel.
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

  return (
    <aside
      className={`filing-panel${placement === null ? '' : ' filing-panel-anchored'}`}
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
      <p className={`filing-state ink-${line.tone}`}>{line.state}</p>
      <p className="filing-fact">
        {comment.applied === null
          ? 'применения пока нет'
          : `${receiptLine(String(comment.applied.chapter).padStart(2, '0'))} · ревизия ${comment.applied.rev}`}
        {line.detail === null ? '' : ` · ${line.detail}`}
      </p>
      <p className="filing-word">состояние: {filingWord(comment)}</p>
    </aside>
  );
}
