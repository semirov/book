import type { CommentDto } from '@book/shared';

import { scrollToChapter } from '../dom.ts';
import { seamDrafts } from './draft.ts';
import { reviseAnchor, reviseDraft } from './revise.ts';
import { seamKey } from './seam.ts';
import { openSeam } from './useSeam.ts';

/**
 * BOOK-158 — «исправить», the one act behind the door on a refused filing.
 *
 * It is the page's act, not a row's: the strip is page state (`useSeam`), the draft store is
 * page state (`seamDrafts`), and the refused row may stand in the register, in the chapter's
 * premise row or in a card. One function is what all three call, so the strip cannot open on a
 * different place, a different key or a different draft from one surface to another.
 *
 * The draft is written **before** the strip opens: a draft in the store is what makes the form
 * open with the reader's text already in it (`Seam` reads `seamDrafts.read(draftKey)`), so one
 * tap is one tap — no «нажмите ещё раз, чтобы загрузить черновик».
 *
 * A block filing needs its paragraph on the page. When the chapter is not there yet the page
 * scrolls to it and the text loads; the filing is not re-anchored and no second filing is
 * invented — the strip appears when the paragraph does.
 */
export function reviseFiling(comment: CommentDto, origin: HTMLElement | null = null): void {
  // Only a refused filing has a way back (the server answers `NOT_REVISABLE` for anything else).
  if (comment.status !== 'rejected') return;
  const draft = reviseDraft(comment);
  const key = `ch${String(comment.chapter)}:premise`;

  if (draft.blockId === null) {
    seamDrafts.keep(key, draft);
    openSeam({ chapter: comment.chapter, blockId: null, key, anchor: null, origin });
    return;
  }

  const anchor = reviseAnchor(comment);
  if (anchor === null) return;
  const blockKey = seamKey(comment.chapter, draft.blockId, anchor.sentence, anchor.baseRev);
  seamDrafts.keep(blockKey, draft);
  openSeam({ chapter: comment.chapter, blockId: draft.blockId, key: blockKey, anchor, origin });

  if (typeof document === 'undefined') return;
  const shown = [...document.querySelectorAll<HTMLElement>('[data-block-id]')].some(
    (element) => element.dataset.blockId === draft.blockId,
  );
  if (!shown) scrollToChapter(comment.chapter);
}
