import type { CatalogEntry, ComposerInfo, CommentDto, ViewerDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { commentStamp } from '../lib/commentView.ts';
import { draftSummary, emptyDraft, seamDrafts, type SeamDraft } from '../lib/draft.ts';
import { filingNumber, filingQuote, filingWord, stripFilings, type SentenceFilings } from '../lib/filings.ts';
import { PREMISE_HINT } from '../lib/premise.ts';
import type { SeamAnchor } from '../lib/seam.ts';
import { InterventionForm } from './InterventionForm.tsx';

/**
 * BOOK-DOC-34 §2.2–§2.3 — the strip laid into the seam, and the form that grows in it.
 *
 * One 44 px row carries the two facts and the one action: whose word this is and «вмешаться».
 * A frozen chapter has no form ever — its strip says «закреплено» and links to the rules. An
 * empty chapter takes a premise instead of a note. The receipt after a 201 stays until the
 * reader taps elsewhere: no timer, no toast.
 *
 * BOOK-33: closing is `✕`, `Esc` or a pointer outside the strip — and it returns focus to the
 * element the tap came from, so a keyboard reader is never dropped at the top of the page.
 * Opening announces itself once through a polite live region, never on every keystroke.
 */

export type SeamProps = {
  entry: CatalogEntry;
  draftKey: string;
  anchor: SeamAnchor | null;
  frozen: boolean;
  filings: SentenceFilings | null;
  /** The paragraph's index, kept so a re-anchor can find its new place by position. */
  blockIndex?: number | null;
  /** The premise the chapter already holds, if any: the action opens that card instead. */
  existingPremise?: CommentDto | null;
  composer: ComposerInfo;
  viewer: ViewerDto;
  onPosted: (chapter: number) => void;
  onClose: () => void;
  onReanchor?: (draft: SeamDraft) => void;
  onProvenance: (origin: HTMLElement) => void;
  onOpenFiling: (comment: CommentDto, origin: HTMLElement) => void;
};

export function Seam({
  entry,
  draftKey,
  anchor,
  frozen,
  filings,
  blockIndex = null,
  existingPremise = null,
  composer,
  viewer,
  onPosted,
  onClose,
  onReanchor,
  onProvenance,
  onOpenFiling,
}: SeamProps) {
  const premise = anchor === null;
  const [draft, setDraftState] = useState<SeamDraft>(
    () =>
      seamDrafts.read(draftKey) ??
      emptyDraft({
        chapter: entry.n,
        blockId: anchor?.blockId ?? null,
        sentence: anchor?.quote ?? '',
        baseRev: anchor?.baseRev ?? null,
        blockIndex,
      }),
  );
  const [open, setOpen] = useState(() => seamDrafts.read(draftKey) !== null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const node = useRef<HTMLDivElement>(null);
  const refusal = premise && existingPremise !== null && !open ? 'у главы уже есть замысел' : null;

  const update = (next: SeamDraft): void => {
    setDraftState(next);
    seamDrafts.keep(draftKey, next);
  };

  // Esc closes; a pointer outside the strip (and outside the panels) closes. Both return focus
  // to the trigger, which the caller keeps in `origin`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.prov-panel, .filing-panel') !== null) return;
      onClose();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      if (target.closest('.seam, .prov-panel, .filing-panel') !== null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const summary = receipt === null ? draftSummary(draft) : null;
  const rows = filings === null ? { shown: [] as CommentDto[], more: 0 } : stripFilings(filings);
  const word = premise ? '«главы ещё нет»' : `«${anchor.word ?? anchor.quote}»`;

  const openFiling = (comment: CommentDto, origin: HTMLElement): void => onOpenFiling(comment, origin);

  return (
    <div
      className="seam"
      role="group"
      aria-label={`место вмешательства · глава ${String(entry.n).padStart(2, '0')}`}
      data-state={open ? 'form' : receipt === null ? 'strip' : 'receipt'}
      data-open={open ? 'true' : 'false'}
      data-frozen={frozen ? 'true' : undefined}
      data-premise={premise ? 'true' : undefined}
      data-base-rev={draft.baseRev ?? ''}
      data-block={draft.blockId ?? ''}
      ref={node}
    >
      <span className="seam-announce" role="status" aria-live="polite">
        {open ? 'форма открыта' : ''}
      </span>

      <div className="seam-row">
        <span className="seam-word">{word}</span>
        {premise ? (
          <span className="seam-prov">замысел</span>
        ) : (
          <button
            type="button"
            className="seam-prov"
            onClick={(event) => onProvenance(event.currentTarget)}
            aria-label="откуда это слово"
          >
            {frozen ? 'автор · закреплено' : 'откуда это слово'}
          </button>
        )}
        {summary === null ? null : <span className="seam-draft">{summary}</span>}

        {frozen ? (
          <a className="seam-frozen" href="/rules#рамка">
            рамка книги →
          </a>
        ) : premise && existingPremise !== null ? (
          <button
            type="button"
            className="seam-cta"
            onClick={(event) => openFiling(existingPremise, event.currentTarget)}
          >
            открыть замысел
          </button>
        ) : viewer.signedIn ? (
          <button type="button" className="seam-cta" onClick={() => setOpen((current) => !current)}>
            {open ? 'свернуть' : premise ? 'заложить замысел' : summary === null ? 'вмешаться' : 'продолжить'}
          </button>
        ) : (
          <a className="seam-cta" href="/auth/yandex/start">
            войти через Яндекс
          </a>
        )}

        <button type="button" className="seam-close" aria-label="закрыть место вмешательства" onClick={onClose}>
          ✕
        </button>
      </div>

      {refusal === null ? null : <p className="seam-note">{refusal}</p>}
      {premise && !frozen ? <p className="seam-note">{PREMISE_HINT}</p> : null}

      {rows.shown.map((comment) => (
        <button
          type="button"
          className="seam-filing"
          key={comment.id}
          data-status={comment.status}
          onClick={(event) => openFiling(comment, event.currentTarget)}
        >
          <span className={`seam-filing-line ink-${comment.status === 'new' ? 'quiet' : 'live'}`}>
            <span className="seam-filing-n">{filingNumber(comment)}</span>
            <span>{comment.author}</span>
            <span className="seam-filing-stamp">{commentStamp(comment.createdAt)}</span>
            <span>{filingWord(comment)}</span>
          </span>
          <span className="seam-filing-quote">«{filingQuote(comment)}»</span>
        </button>
      ))}
      {rows.more === 0 ? null : (
        <button
          type="button"
          className="seam-more"
          onClick={(event) => {
            // The door opens the first filing the strip did not show (BOOK-33).
            const hidden = filings?.all[rows.shown.length];
            if (hidden !== undefined) openFiling(hidden, event.currentTarget);
          }}
        >
          ещё {rows.more} →
        </button>
      )}

      {receipt === null ? null : (
        <p className="seam-receipt" role="status">
          {receipt} ·{' '}
          <a className="seam-link" href="#авторы">
            ваши правки →
          </a>
        </p>
      )}

      <div className="seam-grow">
        <div className="seam-grow-inner">
          {open && !frozen ? (
            <InterventionForm
              entry={entry}
              draft={draft}
              composer={composer}
              viewer={viewer}
              onChange={update}
              onReanchor={onReanchor}
              onPosted={(id) => {
                seamDrafts.drop(draftKey);
                setOpen(false);
                setReceipt(`${filingNumber({ id })} зарегистрировано · ждёт рассмотрения`);
                onPosted(entry.n);
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
