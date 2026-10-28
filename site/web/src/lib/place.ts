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
 * **The one case that cannot be resolved** is an anchor the log itself says no longer holds
 * (`anchor.resolved === false`): the paragraph was rewritten and the quote is gone. Then the
 * chapter head is the honest place and the card says so in one line («место изменилось после
 * правки»). A wrong paragraph is never invented.
 *
 * A block that is merely **absent from the page** is a different fact: the chapter may simply
 * not have been read yet, so `resolvePlaceAfterLoad` waits for it (one read, then a bounded
 * number of frames) before it gives up, and the card stays silent — an unloaded paragraph is
 * not a lost one. When even the chapter is not on this page, the door has one act left that is
 * still true: the change card (`onOpenChange`).
 */

import type { CommentDto } from '@book/shared';

import { reducedMotion } from '../dom.ts';
import { gripHeight, offsetTopOfPage } from './headerOffset.ts';
import type { AnchorRect } from './popover.ts';

/** A filing the page already holds: its own anchor is the place. */
export type CommentPlace = CommentDto;
/**
 * A filing only the server holds: the chapter is known, the anchor arrives with the read.
 * `changeId` is the card to fall back to when the page cannot show the paragraph at all
 * (the chronicle's record row carries it for exactly that reason).
 */
export type CommentIdPlace = { commentId: string; chapter: number; changeId?: string };
/** A change with no filing on this page; `changeId` is the card that opens after the landing. */
export type ChapterPlace = { chapter: number; changeId?: string };

export type Place = CommentPlace | CommentIdPlace | ChapterPlace;

/**
 * The one line a card owes the reader when the landing fell back to the chapter because the
 * paragraph it was filed on is gone (`anchor.resolved === false`). Never a guess at «the
 * neighbouring paragraph», and never printed for a paragraph the page has simply not read.
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
 * The change card a place hands over to when the page cannot show it: the filing's own change,
 * or the record row's — `null` when there is no card at all (a copy of the fragment is then the
 * only act left).
 */
export function placeChangeId(place: Place): string | null {
  return place.changeId ?? null;
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
  // Only the log's own verdict is a stale place. A paragraph that is not in the DOM yet is an
  // unread chapter, not a lost anchor — the landing waits for it (`resolvePlaceAfterLoad`), and
  // a note printed there would tell the reader their text changed when nothing said so.
  return place.anchor.resolved ? null : PLACE_NOTE;
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
 * is not on this page — the door then has nothing to move and falls back to its change card.
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

/**
 * The page's own chapter read (`App`'s `loadChapter`), handed to a door so the door can ask for
 * the chapter it is about instead of landing on a slot whose prose has not arrived.
 */
export type ChapterLoader = (chapter: number) => void | Promise<void>;

/**
 * How many frames a landing gives the page to commit prose it has just asked for (≈0.5 s at
 * 60 Hz). A count, not a clock: the wait is the same on a slow machine and a fast one, and the
 * caller can measure it by counting callbacks.
 */
export const PLACE_RETRY_FRAMES = 30;

/** One frame of the page: the animation frame the commit lands in, or a task where there is none. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        resolve();
      });
      return;
    }
    setTimeout(resolve, 0);
  });
}

export type PlaceResolveInput = {
  place: Place;
  /** The page's chapter read; absent on a surface that cannot load anything (a static render). */
  load?: ChapterLoader;
  doc?: Document;
  /** How many frames the paragraph is waited for; `PLACE_RETRY_FRAMES` by default. */
  frames?: number;
  /** One frame; injected so the wait is provable without a browser clock. */
  wait?: () => Promise<void>;
};

/**
 * Resolve a place **after** the page has had its chance to hold it.
 *
 * A door on the register, the end matter or the chronicle can name a paragraph whose chapter was
 * never read: the block is not in the DOM, and landing on the chapter's mouth as if the anchor
 * were lost would print a false «место изменилось после правки». So the door asks the page for
 * the chapter (once), then re-resolves the block for a bounded number of frames — the prose is
 * committed by the chapter's own read, and the door cannot await a request it did not make.
 *
 * The wait is only for a **live anchor that has not arrived**: a chapter-level place, a premise
 * (the chapter's own row) and a stale anchor (`anchor.resolved === false`) have nothing to wait
 * for, and resolve at once — the last one so the card's honesty line is printed immediately.
 */
export async function resolvePlaceAfterLoad(input: PlaceResolveInput): Promise<PlaceTarget | null> {
  const doc = input.doc ?? document;
  const wait = input.wait ?? nextFrame;
  const frames = Math.max(1, input.frames ?? PLACE_RETRY_FRAMES);
  const target = resolvePlaceTarget(input.place, doc);
  if (target !== null && !target.chapterOnly) return target;
  if (!isCommentPlace(input.place) || input.place.premise || !input.place.anchor.resolved) return target;
  await input.load?.(input.place.chapter);
  for (let frame = 0; frame < frames; frame += 1) {
    const again = resolvePlaceTarget(input.place, doc);
    if (again !== null && !again.chapterOnly) return again;
    if (frame < frames - 1) await wait();
  }
  return resolvePlaceTarget(input.place, doc);
}

/** A paragraph fragment (`#ch-N-bI`) as the address bar carries it. */
export type BlockFragment = { chapter: number; blockIndex: number | null };

export type LandFragmentInput = {
  fragment: BlockFragment;
  doc?: Document;
  win?: Window;
  frames?: number;
  wait?: () => Promise<void>;
};

/**
 * Land a fragment with the site's own measurement (`landAt`), waiting for prose that is still
 * being read: a `#ch-3-b12` opened on a fresh load names a paragraph whose chapter has not been
 * fetched yet. The paragraph is waited for; when it never comes the chapter's mouth is the
 * honest place, exactly as it is for a stale anchor. Returns whether anything was landed at
 * all — a fragment whose chapter is not on this page moves nothing and claims nothing.
 */
export async function landFragment(input: LandFragmentInput): Promise<boolean> {
  const doc = input.doc ?? document;
  const win = input.win ?? window;
  const wait = input.wait ?? nextFrame;
  const frames = Math.max(1, input.frames ?? PLACE_RETRY_FRAMES);
  const blockId = input.fragment.blockIndex === null ? null : blockElementId(input.fragment.chapter, input.fragment.blockIndex);
  for (let frame = 0; frame < frames; frame += 1) {
    const block = blockId === null ? null : doc.getElementById(blockId);
    if (block !== null) {
      landAt(block, win, doc);
      return true;
    }
    if (blockId === null) break;
    if (frame < frames - 1) await wait();
  }
  const chapter = doc.getElementById(`ch-${String(input.fragment.chapter)}`);
  if (chapter === null) return false;
  landAt(chapter, win, doc);
  return true;
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
