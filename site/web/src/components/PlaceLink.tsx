import type { CommentDto } from '@book/shared';
import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { getComment } from '../api.ts';
import {
  isCommentIdPlace,
  isCommentPlace,
  landAt,
  placeHref,
  placeNote,
  resolvePlaceTarget,
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
 */
export type PlaceLinkProps = {
  place: Place;
  /** The quote, the intent, «глава N» — the visible text, and the accessible name. */
  children: ReactNode;
  /** A change with no filing: the landing moves the page, the page opens its own card. */
  onOpenChange?: (changeId: string) => void;
  className?: string;
};

export function PlaceLink({ place, children, onOpenChange, className }: PlaceLinkProps) {
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

  /** A filing the page does not hold yet: one read, then the same landing. */
  const openById = async (commentId: string): Promise<void> => {
    let comment: CommentDto | null = null;
    try {
      comment = await getComment(commentId);
    } catch {
      comment = null;
    }
    const target = comment === null ? null : resolvePlaceTarget(comment);
    if (comment === null || target === null) {
      // The fragment is still a truthful place: let the browser make its own, measured jump.
      window.location.hash = placeHref(place);
      return;
    }
    openAt(comment, target);
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
    if (isCommentIdPlace(place)) {
      event.preventDefault();
      void openById(place.commentId);
      return;
    }
    if (isCommentPlace(place)) {
      // Nothing to land on this page: the fragment already names the chapter, and the browser's
      // own `scroll-margin-top` jump keeps the promise without help.
      const target = resolvePlaceTarget(place);
      if (target === null) return;
      event.preventDefault();
      openAt(place, target);
      return;
    }
    const chapter = resolvePlaceTarget(place);
    if (chapter === null) return;
    event.preventDefault();
    landAt(chapter.element);
    if (place.changeId !== undefined) onOpenChange?.(place.changeId);
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
