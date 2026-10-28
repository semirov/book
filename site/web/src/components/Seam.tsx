import { FRAME_WARNING, type CatalogEntry, type ComposerInfo, type CommentDto, type FrameMark, type ViewerDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { getComment } from '../api.ts';
import { track } from '../lib/analytics.ts';
import { commentStamp } from '../lib/commentView.ts';
import { draftSummary, emptyDraft, seamDrafts, type SeamDraft } from '../lib/draft.ts';
import { filingInk, filingName, filingNumber, filingQuote, stripFilings, type SentenceFilings } from '../lib/filings.ts';
import { filingMarginalia } from '../lib/marginalia.ts';
import { attachOutsideClose } from '../lib/outsideClose.ts';
import { PREMISE_EXISTS, PREMISE_HINT } from '../lib/premise.ts';
import type { SeamAnchor } from '../lib/seam.ts';
import { useOpenFiling } from '../lib/useFiling.ts';
import { useOpenRevision } from '../lib/useRevision.ts';
import type { ComposerError } from '../lib/composer.ts';
import { InterventionForm } from './InterventionForm.tsx';

/**
 * BOOK-DOC-34 §2.2–§2.3 — the strip laid into the seam, and the form that grows in it.
 *
 * One 44 px row carries the two facts and the one action: whose word this is and «вмешаться».
 *
 * BOOK-137: the freeze is the canon **sentence**, not its chapter — a `touched` seam says
 * «рамка книги · не меняется», keeps the link to the rules, prints the warning line before the
 * reader types, and still offers the form: the filing is taken and filed as paperwork, the
 * letters never change. An empty chapter takes a premise instead of a note. The receipt after a
 * 201 stays until the reader closes the strip (on touch: only ✕, `Esc` or another explicit act):
 * no timer, no toast.
 *
 * BOOK-33: closing is `✕`, `Esc`, or — on a fine pointer only — a click outside the strip,
 * and it returns focus to the element the tap came from, so a keyboard reader is never
 * dropped at the top of the page.
 *
 * BOOK-111 (owner, 2026-10-27): on a touch surface a thumb anywhere else changes nothing —
 * a scroll is not a tap, and the strip is closed by its own ✕, a successful submit or `Esc`.
 * A panel the reader opens collapses the form (the strip stays, and stays the anchor): two
 * half-written surfaces never coexist.
 *
 * Opening announces itself once through a polite live region, never on every keystroke.
 */

/**
 * BOOK-137 — the frame's one label, printed as the strip's provenance word for a `touched`
 * selection. One literal in one place: the accessible name and the visible text read it.
 */
const FRAME_LABEL = 'рамка книги · не меняется';

export type SeamProps = {
  entry: CatalogEntry;
  draftKey: string;
  anchor: SeamAnchor | null;
  /** BOOK-137 — how the selection sits against the canon sentence (`@book/shared`). */
  frame: FrameMark;
  filings: SentenceFilings | null;
  /** The paragraph's index, kept so a re-anchor can find its new place by position. */
  blockIndex?: number | null;
  /** The premise the chapter already holds, if any: the action opens that card instead. */
  existingPremise?: CommentDto | null;
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** BOOK-111: the posted DTO itself — the feed shows the row without a reload. */
  onPosted: (comment: CommentDto) => void;
  onClose: () => void;
  /**
   * BOOK-111 (owner, 2026-10-27): a verdict on the floating panel belongs to the surface that
   * opened it — the paragraph (its own close, focus back on the trigger) or the premise row's
   * chapter. The strip only asks for it when the panel is what the outside click landed out of.
   */
  onClosePanel?: () => void;
  onReanchor?: (draft: SeamDraft) => void;
  onProvenance: (origin: HTMLElement) => void;
  onOpenFiling: (comment: CommentDto, origin: HTMLElement) => void;
  /** The premise explanation line; the first empty row carries it instead while closed. */
  premiseHint?: boolean;
};

export function Seam({
  entry,
  draftKey,
  anchor,
  frame,
  filings,
  blockIndex = null,
  existingPremise = null,
  composer,
  viewer,
  onPosted,
  onClose,
  onClosePanel,
  onReanchor,
  onProvenance,
  onOpenFiling,
  premiseHint = true,
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
  /** BOOK-111: the page's one panel — a card or a revision object collapses this form. */
  const panel = useOpenFiling();
  const revision = useOpenRevision();
  /**
   * BOOK-111 (owner, 2026-10-27) — «Два поповера, нужно чтобы был один или поменялся контекст
   * в существующем». A panel opened **from this strip** is not a second box beside it: the
   * strip collapses to one line and the floating panel is the only full frame. `fromSeam` is
   * the caller's answer (the tap landed inside `.seam`), so the store never guesses about DOM.
   */
  const prov = panel !== null && panel.fromSeam ? panel : null;
  /**
   * BOOK-158 — a strip opened by «исправить» is a revision of the filing this chapter's row
   * already holds. «У главы уже есть замысел» would be the wrong thing to say above a form
   * that corrects exactly that filing, and «открыть замысел» would be the wrong way out of it.
   */
  const revising = draft.revisesId !== null;
  const premiseNote = premise && existingPremise !== null && !open && !revising ? PREMISE_EXISTS : null;
  /**
   * BOOK-111 (owner, 2026-10-27) — a refusal must not die with the form: a panel opened from
   * the refusal's own door rebuilds the form when it closes, so the strip keeps the refusal
   * here and the rebuilt form prints it again (BOOK-63: a refusal spends nothing).
   */
  const [refusal, setRefusal] = useState<ComposerError | null>(null);
  /** BOOK-137: the selection is the canon sentence itself — the one edge that is not text. */
  const frameTouched = frame === 'touched';

  const update = (next: SeamDraft): void => {
    setDraftState(next);
    seamDrafts.keep(draftKey, next);
  };

  // Esc closes; a click outside the strip (and outside the panels) closes on a fine pointer;
  // a tap on a touch surface does not — a scroll or a thumb graze must not eat the form.
  // Closing returns focus to the trigger, which the caller keeps in `origin`. While the strip
  // is collapsed under a panel, the panel is the overlay the outside click lands out of, so
  // that click closes the panel (and the strip comes back with its rows).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.prov-panel, .filing-panel') !== null) return;
      onClose();
    };
    const detach = attachOutsideClose({
      isInside: (target) => target.closest('.seam, .prov-panel, .filing-panel') !== null,
      onOutside: prov === null ? onClose : (onClosePanel ?? onClose),
    });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      detach();
    };
  }, [onClose, onClosePanel, prov]);

  /**
   * BOOK-111 (owner, 2026-10-27) — the door the panel came from. It is a *new* node when the
   * strip rebuilds its rows out of the collapsed line, so the key is written on the door (not
   * the node kept) and focus is handed back here, after the rows exist again.
   */
  const door = useRef<string | null>(null);

  useEffect(() => {
    if (prov !== null) {
      door.current = prov.origin?.getAttribute('data-door') ?? null;
      return;
    }
    const key = door.current;
    door.current = null;
    if (key === null) return;
    const target = node.current?.querySelector<HTMLElement>(`[data-door="${key}"]`);
    // The door may be gone with the body it lived in (a refusal that was cleared, a form the
    // reader closed): the strip still has an action, and focus never lands on `<body>`.
    target?.focus();
    if (target === null || target === undefined) {
      node.current?.querySelector<HTMLElement>('.seam-cta, .seam-prov, .seam-filing')?.focus();
    }
  }, [prov]);

  /**
   * BOOK-111 — one overlay at a time. A filing card or a revision object the reader opens
   * collapses this form; the strip stays, so the panel still has the row it came from behind
   * it.
   *
   * BOOK-111 (owner, 2026-10-27): a panel opened **from** this strip is not a second surface —
   * the strip collapses to its one line instead, and the form is not discarded by it. The
   * draft stays exactly as it was left and the form comes back with it when the panel closes,
   * carrying the refusal it was showing (BOOK-63: a refusal spends nothing — its own duplicate
   * door is this case, and `refusal` above is what the rebuilt form prints again).
   */
  useEffect(() => {
    if (panel === null && revision === null) return;
    if (panel !== null && panel.fromSeam) return;
    setOpen(false);
  }, [panel, revision]);

  const summary = receipt === null ? draftSummary(draft) : null;
  const rows = filings === null ? { shown: [] as CommentDto[], more: 0 } : stripFilings(filings);
  const word = premise ? '«главы ещё нет»' : `«${anchor.word ?? anchor.quote}»`;

  const openFiling = (comment: CommentDto, origin: HTMLElement): void => onOpenFiling(comment, origin);

  /**
   * BOOK-111: a refusal that names the existing filing opens it. The row is the durable one —
   * the page holds a stale copy or none at all — so it is read by id, and the tap that opened
   * the panel returns to the button that asked (the form's own action).
   */
  const openDuplicate = async (id: string, origin: HTMLElement): Promise<void> => {
    try {
      const comment = await getComment(id);
      if (comment !== null) openFiling(comment, origin);
    } catch {
      /* the refusal line stays: the reader still knows it was sent, even if the read failed */
    }
  };

  /**
   * BOOK-111 (owner, 2026-10-27) — the strip under a panel is a **state of the same place**,
   * not a second box: one line, no ✕, no action. The floating panel is the only full frame on
   * screen, and closing it hands these rows back exactly as they were (`open` and `receipt`
   * are untouched by the collapse, so the form and the receipt return with the draft).
   */
  if (prov !== null) {
    const label =
      prov.kind === 'provenance'
        ? 'откуда это слово'
        : prov.comment === null
          ? 'замечание'
          : `${filingName(prov.comment)} ${filingNumber(prov.comment)}`;
    return (
      <div
        className="seam ym-hide-content"
        role="group"
        aria-label={`место вмешательства · глава ${String(entry.n).padStart(2, '0')}`}
        data-state="prov"
        data-open="false"
        data-frozen={frameTouched ? 'true' : undefined}
        data-premise={premise ? 'true' : undefined}
        data-base-rev={draft.baseRev ?? ''}
        data-block={draft.blockId ?? ''}
        ref={node}
      >
        <span className="seam-announce" role="status" aria-live="polite" />
        <span className="seam-prov-line">
          <span className="seam-prov-word">{word}</span>
          <span className="seam-prov-trail">
            {` · глава ${String(entry.n).padStart(2, '0')} · ${label}`}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="seam ym-hide-content"
      role="group"
      aria-label={`место вмешательства · глава ${String(entry.n).padStart(2, '0')}`}
      data-state={open ? 'form' : receipt === null ? 'strip' : 'receipt'}
      data-open={open ? 'true' : 'false'}
      data-frozen={frameTouched ? 'true' : undefined}
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
            data-door="prov"
            onClick={(event) => onProvenance(event.currentTarget)}
            // The accessible name is the visible label, so the two can never disagree.
            aria-label={frameTouched ? FRAME_LABEL : 'откуда это слово'}
          >
            {frameTouched ? FRAME_LABEL : 'откуда это слово'}
          </button>
        )}
        {summary === null ? null : <span className="seam-draft ym-hide-content">{summary}</span>}

        {frameTouched ? (
          <a className="seam-frozen" href="/rules#рамка">
            рамка книги →
          </a>
        ) : null}

        {premise && existingPremise !== null && !revising ? (
          <button
            type="button"
            className="seam-cta"
            data-door="cta"
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

      {premiseNote === null ? null : <p className="seam-note">{premiseNote}</p>}
      {/*
        BOOK-137 — the one warning line, read from `@book/shared` and printed in the strip
        **before** the reader types: trying is allowed, and lying about the outcome is not.
      */}
      {frameTouched ? <p className="seam-note seam-frame">{FRAME_WARNING}</p> : null}
      {premise && premiseHint ? <p className="seam-note">{PREMISE_HINT}</p> : null}

      {rows.shown.map((comment) => (
        // BOOK-70, amended by BOOK-111 (owner, 2026-10-27): the row prints the numeral, the
        // state word, the reader and the moment. The word is visible — a filing that exists
        // must say it waits — and still travels in the button's label for a screen reader.
        <button
          type="button"
          className="seam-filing"
          key={comment.id}
          data-door={`filing-${comment.id}`}
          data-status={comment.status}
          aria-label={`замечание ${filingNumber(comment)} · ${filingInk(comment).word} · «${filingQuote(comment)}»`}
          onClick={(event) => openFiling(comment, event.currentTarget)}
        >
          <span className={`seam-filing-line ink-${comment.status === 'new' ? 'quiet' : 'live'}`}>
            <span className="seam-filing-n">{filingNumber(comment)}</span>
            <span className="seam-filing-word">{filingInk(comment).word}</span>
            <span>{comment.author}</span>
            <span className="seam-filing-stamp">{commentStamp(comment.createdAt)}</span>
          </span>
          <span className="seam-filing-quote">«{filingQuote(comment)}»</span>
        </button>
      ))}
      {rows.more === 0 ? null : (
        <button
          type="button"
          className="seam-more"
          data-door="more"
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
        // BOOK-59: no «ваши правки →» — that list wakes with the first applied change, and a
        // note never makes one; the receipt itself is the fact.
        <p className="seam-receipt ym-hide-content" role="status">
          {receipt}
        </p>
      )}

      <div className="seam-grow">
        <div className="seam-grow-inner">
          {open ? (
            <InterventionForm
              entry={entry}
              draft={draft}
              composer={composer}
              viewer={viewer}
              onChange={update}
              onReanchor={onReanchor}
              initialError={refusal}
              onRefused={setRefusal}
              onOpenDuplicate={(id, origin) => void openDuplicate(id, origin)}
              onPosted={(comment) => {
                seamDrafts.drop(draftKey);
                // A landed filing clears the refusal it may have answered (BOOK-63).
                setRefusal(null);
                setOpen(false);
                // BOOK-90: «зарегистрировано» is the deed word; the state is the deck's own
                // word for the posted row, so the receipt cannot drift from the feed.
                const marginalia = filingMarginalia(comment);
                // A held filing says what holds it (BOOK-111 §5): word, then the check line.
                const held = comment.status === 'quarantined' ? ` · ${marginalia.consequence}` : '';
                setReceipt(`${filingNumber(comment)} зарегистрировано · ${marginalia.word}${held}`);
                // BOOK-63: the receipt is the fact the reader came for; the id stays out.
                track('receipt_seen', {});
                onPosted(comment);
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
