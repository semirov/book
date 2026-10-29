import type { CommentDto } from '@book/shared';

import { getChapter } from '../api.ts';
import { sentenceAt as anchoredSentenceAt } from './marginalia.ts';
import { beginLanding, isCurrent, landAt, resolvePlaceAfterLoad, type ChapterLoader } from './place.ts';
import { openRecord } from './record.ts';
import { anchorFor, type SeamAnchor } from './seam.ts';

/**
 * A filing's own sentence, as the record needs it.
 *
 * A landed change rewrites its own sentence, so the stored quote is the **before** and the
 * place the anchor was filed at is what names the sentence standing there now (BOOK-90's
 * `sentenceAt`). A filing whose anchor the log says no longer resolves has no sentence: the
 * caller keeps its card (the named exception), never an invented paragraph.
 */
export function filingSentence(
  text: string,
  anchor: CommentDto['anchor'],
  blockId: string,
  baseRev: number,
): SeamAnchor | null {
  // A stale anchor is the log's own verdict that this sentence is gone: never recover it by
  // quote (the text under the block id may now be somebody else's).
  if (!anchor.resolved) return null;
  const at = anchoredSentenceAt(text, anchor);
  const offset = at ?? uniqueOffset(text, anchor.quote);
  if (offset === null) return null;
  return anchorFor({ text, blockId, baseRev, offset });
}

/** The quote's one place in the text; a repeated wording with no context names nothing. */
function uniqueOffset(text: string, quote: string | null): number | null {
  if (quote === null || quote.length === 0) return null;
  const at = text.indexOf(quote);
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return null;
  return at;
}

export type FilingLanding = {
  /** The record was opened at the filing's sentence. */
  opened: boolean;
  /** What the landing resolved to; the caller's card is placed against it. */
  element: HTMLElement | null;
};

/**
 * Land on a filing's sentence and open the record there with the filing's body.
 *
 * The one route for every door that is **not** already standing in the paragraph: a place link
 * on the register, the end matter or a discussion row. A paragraph door computes its range
 * locally and calls `openRecord` directly; this is the same record, reached after a landing.
 */
export async function openFilingRecord(input: {
  comment: CommentDto;
  origin: HTMLElement | null;
  load?: ChapterLoader;
  doc?: Document;
  win?: Window;
}): Promise<FilingLanding> {
  const doc = input.doc ?? document;
  const win = input.win ?? window;
  const token = beginLanding();
  const target = await resolvePlaceAfterLoad({
    place: input.comment,
    ...(input.load === undefined ? {} : { load: input.load }),
    doc,
    win,
  });
  if (target === null) return { opened: false, element: null };
  if (!isCurrent(token)) return { opened: false, element: target.element };
  const opened = await openFilingAt({
    comment: input.comment,
    element: target.element,
    origin: input.origin,
    token,
    doc,
    win,
  });
  return { opened, element: target.element };
}

/**
 * Open the record on a filing whose landing is already measured (a place door resolves first).
 * `false` means the filing has no sentence: the caller draws the one card.
 */
export async function openFilingAt(input: {
  comment: CommentDto;
  element: HTMLElement;
  origin: HTMLElement | null;
  /** The landing this belongs to: a newer one cancels the record this one would open. */
  token?: number;
  doc?: Document;
  win?: Window;
}): Promise<boolean> {
  const doc = input.doc ?? document;
  const win = input.win ?? window;
  if (input.comment.premise || input.comment.anchor.blockId === null) return false;
  let chapter;
  try {
    chapter = await getChapter(input.comment.chapter);
  } catch {
    chapter = null;
  }
  if (chapter === null) return false;
  if (input.token !== undefined && !isCurrent(input.token)) return false;
  const blocks = chapter.blocks ?? [];
  const block =
    blocks.find((item) => item.id === input.comment.anchor.blockId) ??
    (input.comment.anchor.blockIndex === null ? undefined : blocks[input.comment.anchor.blockIndex]);
  const anchor =
    block === undefined ? null : filingSentence(block.text, input.comment.anchor, block.id, chapter.rev ?? 0);
  if (block === undefined || anchor === null) return false;
  landAt(input.element, win, doc);
  openRecord({
    chapter: input.comment.chapter,
    blockId: block.id,
    start: anchor.sentence.start,
    end: anchor.sentence.end,
    word: null,
    anchor,
    origin: input.origin,
    surface: 'text',
    filing: input.comment,
  });
  return true;
}
