/**
 * BOOK-168 — **a place is a door**, and this file is the one arithmetic behind it.
 *
 * The owner's two dead quotes (`Discussion`, 2026-10-28): «Я посмотрел на часы: девять сорок
 * две.» and «— Заявителем лично.». A row that quotes the book and cannot take the reader to
 * the paragraph it quotes is a receipt, not a place. So every row that names a place — the
 * register's quote, the reader's own decisions, the chronicle's «глава N» — is a link, and
 * every one of them lands the same way:
 *
 *   1. the target's **top** goes to the reading line — the sticky head's measured lower edge
 *      plus `BREATHING_PX`, the very number `scroll-margin-top` receives (`headerOffset.ts`),
 *      never a literal copied from a screenshot;
 *   2. the footer grip is a floor as well as a ceiling: a landing may not leave the target's
 *      top under the band the page fixes over the bottom edge, and the end of the book is a
 *      clamp, not a different algorithm (`landingScroll`);
 *   3. the card is placed on the target's **post-scroll** rect, computed analytically from the
 *      scroll that was asked for — a browser reports the rect it will have after the smooth
 *      scroll, and the panel must not blink while the page travels.
 *
 * The place itself is three shapes, and the anchor is the only thing that decides between the
 * block and the chapter:
 *
 *   - a filing (`CommentDto`) — `#ch-N-bI` when its anchor resolves to a block index, that
 *     block's `[data-block-id]` when only the id is known, else the chapter `#ch-N`;
 *   - a filing read by id (`{ commentId, chapter }`) — the same, once the record is fetched;
 *   - a change with no filing on this page (`{ chapter, changeId }`) — the chapter, and the
 *     change card opens through the page's own path.
 *
 * **The one case that cannot be resolved** is an anchor that no longer holds: the paragraph
 * was rewritten, the quote is gone (`anchor.resolved === false`), or the block is simply not
 * in the DOM. Then the chapter head is the honest place and the card says so in one line
 * («место изменилось после правки»). A wrong paragraph is never invented.
 */

import type { CommentDto } from '@book/shared';

import { reducedMotion } from '../dom.ts';
import { gripHeight, offsetTopOfPage } from './headerOffset.ts';
import type { AnchorRect } from './popover.ts';

/** A filing the page already holds: its own anchor is the place. */
export type CommentPlace = CommentDto;
/** A filing only the server holds: the chapter is known, the anchor arrives with the read. */
export type CommentIdPlace = { commentId: string; chapter: number };
/** A change with no filing on this page; `changeId` is the card that opens after the landing. */
export type ChapterPlace = { chapter: number; changeId?: string };

export type Place = CommentPlace | CommentIdPlace | ChapterPlace;

/**
 * The one line a card owes the reader when the landing fell back to the chapter because the
 * paragraph it was filed on is gone. Never a guess at «the neighbouring paragraph».
 */
export const PLACE_NOTE = 'место изменилось после правки';

/** A `CommentDto` is the only shape that carries an anchor. */
export function isCommentPlace(place: Place): place is CommentPlace {
  return 'anchor' in place;
}

/** A filing read by id — the record's row, the reader's own decisions. */
export function isCommentIdPlace(place: Place): place is CommentIdPlace {
  return !isCommentPlace(place) && 'commentId' in place;
}

/**
 * The block the filing can stand on, or `null` when the chapter is the honest place:
 * a premise is the chapter's own row (BOOK-7), and an anchor that no longer resolves is a
 * block that is gone (`CommentAnchor.resolved`). The applied receipt names the chapter and
 * the revision the text entered — the filing's own anchor still names the paragraph.
 */
export function placeBlockIndex(place: Place): number | null {
  if (!isCommentPlace(place) || place.premise || !place.anchor.resolved) return null;
  return place.anchor.blockIndex;
}

/** The block id of a live anchor; a stale one has no block to point at. */
export function placeBlockId(place: Place): string | null {
  if (!isCommentPlace(place) || place.premise || !place.anchor.resolved) return null;
  return place.anchor.blockId;
}

/**
 * The URL a reader can copy. It is a real fragment, not `#`: a block whose index is known
 * points at its own paragraph (`#ch-3-b12`), everything else at the chapter's mouth — the
 * same element the landing uses when the anchor cannot be resolved.
 */
export function placeHref(place: Place): string {
  const chapter = `#ch-${String(place.chapter)}`;
  const index = placeBlockIndex(place);
  return index === null ? chapter : `${chapter}-b${String(index)}`;
}

/** The paragraph's own element id (`ProseParagraph` writes it beside `data-block-id`). */
export function blockElementId(chapter: number, blockIndex: number): string {
  return `ch-${String(chapter)}-b${String(blockIndex)}`;
}

/** The card's honesty line, or `null` when the place is where it says it is. */
export function placeNote(place: Place, chapterOnly: boolean): string | null {
  if (!chapterOnly || !isCommentPlace(place) || place.premise) return null;
  return PLACE_NOTE;
}

/** What the landing is measured against: document coordinates, then the viewport's floor. */
export type LandingInput = {
  /** The target's top in document coordinates. */
  docTop: number;
  /** The reading line: the head's measured lower edge plus the breathing space. */
  readingLine: number;
  /** The lowest a target's top may sit on screen (`innerHeight - gripHeight()`). */
  gripFloor: number;
  /** The page's last scroll position; `null` when the document has no layout to measure. */
  maxScroll: number | null;
};

/**
 * The one scroll arithmetic of a landing, in document pixels.
 *
 * `docTop - readingLine` is the jump itself. Two clamps stand beside it and neither is a
 * literal: the grip's floor (a viewport shorter than the head plus the band would otherwise
 * land the target under it — the target is pulled up to the floor instead) and the end of the
 * book (`maxScroll`), where the page cannot travel further and the last content sits where
 * the `.margin-tail` reserves the band's room.
 */
export function landingScroll(input: LandingInput): number {
  const wanted = Math.max(input.docTop - input.readingLine, input.docTop - input.gripFloor);
  const top = input.maxScroll === null ? wanted : Math.min(wanted, input.maxScroll);
  return Math.max(0, top);
}

/** The document's scrollable height — 0 in a document that has no layout (jsdom). */
function documentScrollHeight(doc: Document): number {
  return Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
}

/** The last scroll position of the page, or `null` when there is nothing to measure. */
function maxScrollOf(doc: Document, win: Window): number | null {
  const height = documentScrollHeight(doc);
  return height > 0 ? Math.max(0, height - win.innerHeight) : null;
}

export type PlaceTarget = {
  /** The element the landing holds: a block, or the chapter's mouth. */
  element: HTMLElement;
  /** Only the chapter resolved — the anchor is stale or its block is not in the DOM. */
  chapterOnly: boolean;
};

/**
 * The element a place stands on: the block by its id (`#ch-N-bI`), the block by its
 * `data-block-id` when the index is unknown, else the chapter. `null` when the chapter itself
 * is not on this page — the caller then leaves the browser's own fragment jump alone.
 */
export function resolvePlaceTarget(place: Place, doc: Document = document): PlaceTarget | null {
  if (isCommentPlace(place)) {
    const index = placeBlockIndex(place);
    const blockId = placeBlockId(place);
    const block =
      index !== null
        ? doc.getElementById(blockElementId(place.chapter, index))
        : blockId === null
          ? null
          : doc.querySelector<HTMLElement>(`[data-block-id="${escapeAttribute(blockId)}"]`);
    if (block !== null) return { element: block, chapterOnly: false };
  }
  const chapter = doc.getElementById(`ch-${String(place.chapter)}`);
  if (chapter === null) return null;
  // A premise's home *is* the chapter's mouth, so its landing says nothing about a lost block.
  return { element: chapter, chapterOnly: isCommentPlace(place) };
}

/** `CSS.escape`, with an attribute-safe fallback for an environment that has none. */
function escapeAttribute(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/gu, '\\$&');
}

/**
 * Land one element and report the rect the card is placed on. The rect is computed, not read
 * again: a smooth scroll is still travelling when the panel opens, and a second measurement
 * would place the box over the paragraph's old position.
 */
export function landAt(element: HTMLElement, win: Window = window, doc: Document = document): AnchorRect {
  const before = element.getBoundingClientRect();
  const docTop = before.top + win.scrollY;
  const top = landingScroll({
    docTop,
    readingLine: offsetTopOfPage(doc),
    gripFloor: win.innerHeight - gripHeight(doc),
    maxScroll: maxScrollOf(doc, win),
  });
  win.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  return { top: docTop - top, left: before.left, width: before.width, height: before.height };
}
