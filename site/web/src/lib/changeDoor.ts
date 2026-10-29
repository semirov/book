import type { ChangeDto, CommentDto } from '@book/shared';

import { getChange, getChapter, getComment } from '../api.ts';
import { beginLanding, isCurrent, landAt, resolvePlaceAfterLoad, type ChapterLoader } from './place.ts';
import { openChapterChange, openRecord } from './record.ts';
import { sentenceAt as anchoredSentenceAt } from './marginalia.ts';
import { anchorFor } from './seam.ts';

/**
 * The one resolver behind every door to a change.
 *
 * A change used to open a surface of its own (the fixed card, then the full-screen focus view).
 * Now it is a section of the sentence's record, so a door has to do what a place door does and
 * then one thing more: **land** on the sentence the change touched (chapter first, then the
 * paragraph — the measured jump of `place.ts`, never a smooth travel) and **open the record**
 * there with the `правка` section expanded.
 *
 * Where the sentence is: the filing the change was made from (`source.commentId`) carries the
 * anchor. The anchor quote is located in the block's text and the anchor is rebuilt with
 * `anchorFor`, so the record, the mark and a later filing all speak about the same offsets.
 *
 * A change with no anchored sentence — a premise, an author's own change, a filing whose
 * paragraph the log says is gone — has no record to open: the resolver lands on the change's
 * chapter and hands it to the chapter's own row (`openChapterChange`). It never falls back to a
 * full-screen surface.
 */

export type ChangeLanding =
  | { kind: 'sentence'; change: ChangeDto }
  | { kind: 'chapter'; change: ChangeDto }
  | { kind: 'failed' };

export type LandOnChangeInput = {
  changeId: string;
  /** The page's chapter read (`App`'s `loadChapter`, which reads the chapter's filings). */
  load?: ChapterLoader;
  doc?: Document;
  win?: Window;
  frames?: number;
  wait?: () => Promise<void>;
};

export async function landOnChange(input: LandOnChangeInput): Promise<ChangeLanding> {
  const doc = input.doc ?? document;
  const win = input.win ?? window;
  const token = beginLanding();

  let change: ChangeDto | null;
  try {
    change = await getChange(input.changeId);
  } catch {
    change = null;
  }
  // The answer is keyed by id: a different change is not this door's change.
  if (change === null || change.id !== input.changeId) return { kind: 'failed' };

  let filing: CommentDto | null = null;
  if (change.source.commentId !== null) {
    try {
      filing = await getComment(change.source.commentId);
    } catch {
      filing = null;
    }
  }
  if (!isCurrent(token)) return { kind: 'failed' };

  const chapter = filing?.chapter ?? change.chapter;
  const target = await resolvePlaceAfterLoad({
    place: filing ?? { chapter },
    ...(input.load === undefined ? {} : { load: input.load }),
    ...(input.frames === undefined ? {} : { frames: input.frames }),
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    doc,
    win,
  });
  if (!isCurrent(token)) return { kind: 'failed' };
  if (target === null) return { kind: 'failed' };

  // The sentence, when the filing's anchor still names one. `premise` filings have no block.
  if (filing !== null && filing.anchor.resolved && !filing.premise) {
    let block: { id: string; text: string } | null = null;
    let baseRev: number | null = null;
    try {
      const read = await getChapter(chapter);
      const found =
        read?.blocks.find((item) => item.id === filing.anchor.blockId) ?? read?.blocks[filing.anchor.blockIndex ?? -1];
      if (read !== null && found !== undefined) {
        block = { id: found.id, text: found.text };
        baseRev = read.rev;
      }
    } catch {
      block = null;
    }
    if (!isCurrent(token)) return { kind: 'failed' };
    const quote = filing.anchor.quote;
    // A landed change rewrites its own sentence: the stored quote is the **before**, and the
    // place it was filed at is what names the sentence that stands there now (BOOK-90's
    // `sentenceAt`, the same function the revision object reads «стало» through).
    const at = block === null ? null : (anchoredSentenceAt(block.text, filing.anchor) ?? uniqueIndexOf(block.text, quote));
    if (block !== null && at !== null) {
      const anchor = anchorFor({ text: block.text, blockId: block.id, baseRev: baseRev ?? 0, offset: at });
      if (anchor !== null) {
        landAt(target.element, win, doc);
        openRecord({
          chapter,
          blockId: block.id,
          start: anchor.sentence.start,
          end: anchor.sentence.end,
          word: null,
          anchor,
          origin: null,
          surface: 'change',
          changeId: change.id,
          changeQuote: filing.anchor.quote,
        });
        return { kind: 'sentence', change };
      }
    }
  }

  // No sentence the change can stand on: the chapter's own row states what happened, and the
  // chapter's mouth — where that row is — is the honest place (a block target is not).
  landAt(doc.getElementById(`ch-${String(chapter)}`) ?? target.element, win, doc);
  openChapterChange({ chapter, changeId: change.id });
  return { kind: 'chapter', change };
}

/** The quote's one place in the text; a repeated wording with no context names nothing. */
function uniqueIndexOf(text: string, quote: string | null): number | null {
  if (quote === null || quote.length === 0) return null;
  const at = text.indexOf(quote);
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return null;
  return at;
}

/**
 * The page's one opener, registered by `App` (`useChangeDoor` owns the landing and the view
 * switch). Deep surfaces — a premise's «правка →», a thread entry, a revision object — call
 * this instead of drilling a callback through every chapter component; a render with no app
 * (a test, the server) keeps its real `?change=` href and does nothing.
 */
type ChangeOpener = (changeId: string) => void;

let opener: ChangeOpener | null = null;

export function setChangeOpener(next: ChangeOpener | null): void {
  opener = next;
}

export function requestChange(changeId: string): boolean {
  if (opener === null) return false;
  opener(changeId);
  return true;
}

/** A plain click on a change door: a modified one is the browser's own act (copy, new tab). */
export function plainChangeClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}, changeId: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!requestChange(changeId)) return;
  event.preventDefault();
}
