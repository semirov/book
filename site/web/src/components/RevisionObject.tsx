import type { ChangeDto, CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getChange } from '../api.ts';
import { reachCopy } from '../lib/changeStatus.ts';
import { commentStamp } from '../lib/commentView.ts';
import { filingInk, filingNumber } from '../lib/filings.ts';
import { focusHash, waveCopy, waveOf } from '../lib/focus.ts';
import { filingMarginalia, revisionOf } from '../lib/marginalia.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';

/**
 * BOOK-90 — the revision object: one component, one skin, two placements.
 *
 * At ≥1024 it is a 188 px box in the channel, opened in the slot of its trigger (the note it
 * replaces, or the accepted tick); at <1024 it is `.chain`'s record sheet at the bottom, no
 * scrim. Never a floating popover, never a third design.
 *
 * The facts come from the record itself: the head is the numeral and the state word, the meta
 * line is who and when (plus the applied revision), «было» is the anchor quote, «стало» the
 * sentence that stands there now — resolved on the paragraph's own text, never invented. A
 * filing that has not landed has no «было/стало»: it shows its quote and its next line, and
 * the table is written only for a revision that exists.
 *
 * The change is fetched once per id and cached; a wave below 2 is not printed (BOOK-59), and
 * a change that cannot be reached prints no invented wave.
 */

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The opened record's change, fetched once per id for the life of the page. */
const changes = new Map<string, ChangeDto | null>();

async function loadChange(id: string): Promise<ChangeDto | null> {
  const known = changes.get(id);
  if (known !== undefined) return known;
  try {
    const change = await getChange(id);
    changes.set(id, change);
    return change;
  } catch {
    return null; // not cached: a later open may reach the card again
  }
}

export function RevisionObject({
  comment,
  text,
  onClose,
}: {
  comment: CommentDto;
  /** The paragraph's current text: «стало» is resolved on it, not on a cached copy. */
  text: string;
  onClose: () => void;
}) {
  const node = useRef<HTMLElement>(null);
  const [change, setChange] = useState<ChangeDto | null>(null);
  const marginalia = filingMarginalia(comment);
  const ink = filingInk(comment);
  const revision = revisionOf(comment, text);
  // BOOK-90: the state is the vocabulary's, not a second reading of `status`.
  const landed = marginalia.state === 'landed';

  // Before paint: focus is in the object and the margin has been re-measured around it.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [comment.id]);

  useEffect(() => {
    node.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (comment.changeId === null) return;
    let alive = true;
    void loadChange(comment.changeId).then((loaded) => {
      if (alive) setChange(loaded);
    });
    return () => {
      alive = false;
    };
  }, [comment.changeId]);

  // «волна N» only when it is news (N ≥ 2); the reach comes from the change's own applied
  // revisions through `reachCopy` — the same words the card uses, not a second derivation.
  const wave = change === null ? '' : waveCopy(waveOf(change));
  const reach =
    change !== null && change.status === 'done'
      ? reachCopy({ chapter: change.chapter, chapters: change.appliedRevs.map((row) => row.chapter) })
      : '';
  const trace = [wave, reach].filter((part) => part.length > 0).join(' · ');

  return (
    // A `<p>` may hold phrasing content only: the object is a span that CSS lays out as a
    // block (the note's own rule). The skin, the order of lines and the dialog role are the
    // spec's; the element is what keeps the document valid where the object opens.
    <span
      className="revision ym-hide-content"
      role="dialog"
      aria-modal="false"
      aria-label={`запись ${filingNumber(comment)}`}
      data-margin-item="object"
      data-number={filingNumber(comment)}
      tabIndex={-1}
      ref={node}
    >
      <span className="revision-head">
        <span className="revision-title">
          {filingNumber(comment)} ·{' '}
          <span className={`revision-word ink-word-${ink.tone}`}>{marginalia.word}</span>
        </span>
        <button type="button" className="revision-close" aria-label="закрыть запись" onClick={onClose}>
          ✕
        </button>
      </span>
      <span className="revision-meta">
        {comment.author} · {commentStamp(comment.createdAt)}
        {comment.applied === null ? '' : ` · ревизия ${comment.applied.rev}`}
      </span>
      {landed ? null : <span className="revision-meta">{marginalia.consequence}</span>}
      {trace.length === 0 ? null : <span className="revision-meta">{trace}</span>}
      {revision.before === null ? null : landed ? (
        <span className="revision-facts">
          <span className="revision-row">
            <span className="revision-label">было</span>
            <span className="revision-value revision-before">«{revision.before}»</span>
          </span>
          {revision.status !== 'changed' || revision.after === null ? null : (
            <span className="revision-row">
              <span className="revision-label">стало</span>
              <span className="revision-value revision-after">«{revision.after}»</span>
            </span>
          )}
        </span>
      ) : (
        <span className="revision-quote">«{revision.before}»</span>
      )}
      {landed && revision.status === 'unresolved' ? (
        <span className="revision-changed">текст изменился после правки</span>
      ) : null}
      {comment.body.length === 0 ? null : <span className="revision-body">{comment.body}</span>}
      {comment.changeId === null ? null : (
        <a className="revision-door" href={focusHash(comment.changeId)}>
          прицел →
        </a>
      )}
    </span>
  );
}
