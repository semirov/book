import type { CommentDto } from '@book/shared';
import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { getComment } from '../api.ts';
import {
  beginLanding,
  isCommentIdPlace,
  isCommentPlace,
  isCurrent,
  landAt,
  placeChangeId,
  placeHref,
  placeNote,
  resolvePlaceAfterLoad,
  type ChapterLoader,
  type Place,
  type PlaceTarget,
} from '../lib/place.ts';
import { hideFiling, showFiling, useOpenFiling } from '../lib/useFiling.ts';
import { FilingPanel } from './FilingPanel.tsx';

/**
 * BOOK-168 — **a filing row is a door to the paragraph it speaks about**.
 *
 * The owner's two dead quotes in `Discussion` («Я посмотрел на часы: девять сорок две.»,
 * «— Заявителем лично.») were text: they named a place and could not take anyone there. This
 * is the one control that replaces them, and every surface that quotes the book uses it — the
 * register, the reader's own decisions, the chronicle's place cell.
 *
 * It renders a **real link**: `href` is the fragment of the place (`place.ts`), the visible
 * text is its accessible name, and a middle-click or ⌘-click keeps the browser's own act. A
 * plain tap `preventDefault`s and lands instead, because the landing is the measured one:
 * the target's top at the reading line, the footer grip respected, the card opened on the
 * post-scroll rect (`lib/place.ts`).
 *
 * The card is the page's one panel (`useFiling`), drawn by the link that opened it — `owner` is
 * this link, not the paragraph: a chapter the reader has not loaded has no paragraph to draw
 * a card from, and two doors to one filing must never raise two boxes. It lives in a portal on
 * `document.body`, so a door inside a `<p>` (a quote) or a grid cell (the chronicle's place)
 * still leaves a valid document and gets the one fixed placement every panel has.
 *
 * Closing returns focus to the link itself: the page's strip was never touched, so the door is
 * the only thing to hand back to the reader.
 *
 * A block that is **not in the DOM** is not a lost anchor: the chapter may not have been read
 * yet, so the door first brings the chapter to the reading line — which is what starts its own
 * read — and then waits for the paragraph before it settles for the chapter's mouth and — with
 * `anchor.resolved === false` alone — the one honesty line. The landing itself is an instant
 * jump, and the card opens after it, on the rect that jump lands on. A place the page cannot show
 * at all (the chronicle holds records, not chapters) falls back to the change card, because a door
 * that silently sets a fragment to nothing is not a door.
 */
export type PlaceLinkProps = {
  place: Place;
  /** The quote, the intent, «глава N» — the visible text, and the accessible name. */
  children: ReactNode;
  /** A change with no filing: the landing moves the page, the page opens its own card. */
  onOpenChange?: (changeId: string) => void;
  className?: string;
  /**
   * The page's own chapter read: a door asks for the chapter it names before it lands, so a
   * paragraph that arrives with the read is landed on instead of the chapter's mouth. Absent
   * where nothing can be loaded, and the wait is then the frames alone.
   */
  onLoadChapter?: ChapterLoader;
};

export function PlaceLink({ place, children, onOpenChange, className, onLoadChapter }: PlaceLinkProps) {
  /** One owner per link: only the door that was opened draws the card. */
  const owner = `place:${useId()}`;
  const filing = useOpenFiling();
  const open = filing !== null && filing.owner === owner && filing.comment !== null ? filing : null;
  const link = useRef<HTMLAnchorElement>(null);

  const closePanel = (): void => {
    const origin = open?.origin ?? link.current;
    hideFiling();
    origin?.focus();
  };

  /** Land on the target and hand its post-scroll rect to the card. */
  const openAt = (comment: CommentDto, target: PlaceTarget): void => {
    showFiling({
      kind: 'filing',
      owner,
      comment,
      origin: link.current,
      rect: landAt(target.element),
      fromSeam: false,
      note: placeNote(comment, target.chapterOnly),
    });
  };

  /**
   * The page cannot show this place: the change card is the one act still true. Without a card
   * to open, the copied fragment is left to the browser's own jump — a real href, so the link
   * keeps its promise off this page too.
   */
  const handOver = (at: Place): void => {
    const changeId = placeChangeId(at);
    if (changeId !== null && onOpenChange !== undefined) {
      onOpenChange(changeId);
      return;
    }
    window.location.hash = placeHref(at);
  };

  /**
   * Land the place once the page has had its chance to hold it, or hand over to the card.
   *
   * `token` is the landing generation this click took (owner, 2026-10-28): while the door waits
   * for a chapter to be read, a second click — or a hash — starts a newer landing, and this one
   * must then move nothing and open nothing. One scroll, one card.
   */
  const settle = async (
    at: Place,
    comment: CommentDto | null,
    fallback: Place = at,
    token: number = beginLanding(),
  ): Promise<void> => {
    const target = await resolvePlaceAfterLoad({
      place: at,
      load: onLoadChapter === undefined ? undefined : () => onLoadChapter(at.chapter),
    });
    // A newer landing owns the page now: this one drops its remaining acts.
    if (!isCurrent(token)) return;
    if (target === null) {
      handOver(fallback);
      return;
    }
    if (comment !== null) {
      openAt(comment, target);
      return;
    }
    landAt(target.element);
    const changeId = placeChangeId(at);
    if (changeId !== null) onOpenChange?.(changeId);
  };

  /** A filing the page does not hold yet: one read, then the same landing. */
  const openById = async (at: Place & { commentId: string }): Promise<void> => {
    const token = beginLanding();
    let comment: CommentDto | null = null;
    try {
      comment = await getComment(at.commentId);
    } catch {
      comment = null;
    }
    // The read took a turn: a newer landing may have started meanwhile.
    if (!isCurrent(token)) return;
    if (comment === null) {
      handOver(at);
      return;
    }
    // The filing's own anchor is what the landing resolves; the row's change is what a page
    // that cannot show it opens.
    await settle(comment, comment, at, token);
  };

  const activate = (event: MouseEvent<HTMLAnchorElement>): void => {
    // A modified click is the browser's own act: a new tab, a copy, a download of the URL.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    // The landing is measured and asynchronous: the browser's own jump would move the page
    // twice, so the door always takes the click and keeps its own href for a copy.
    event.preventDefault();
    if (isCommentIdPlace(place)) {
      void openById(place);
      return;
    }
    if (isCommentPlace(place)) {
      void settle(place, place);
      return;
    }
    void settle(place, null);
  };

  return (
    <>
      <a
        ref={link}
        className={className === undefined ? 'place-link' : `place-link ${className}`}
        href={placeHref(place)}
        onClick={activate}
      >
        {children}
      </a>
      {open === null || open.comment === null
        ? null
        : createPortal(
            <FilingPanel
              comment={open.comment}
              anchor={open.rect}
              placeNote={open.note ?? null}
              onClose={closePanel}
            />,
            document.body,
          )}
    </>
  );
}
