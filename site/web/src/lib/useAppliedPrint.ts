/**
 * BOOK-DOC-84 §4/D2, BOOK-220 §11.2 — the write's print plans, planned once per applied record.
 *
 * The clock is `appliedAt` (never `landed.at`): every changed block inside 1.5 viewports is
 * planned in document order, with no block cap, and the page prints them one at a time
 * (BOOK-220 §11.2 B3). A *created* chapter is the reveal's whole-chapter print on the same
 * clock, never place by place — and it has no prose on the page yet, so the slot fetches it.
 *
 * Off-screen blocks are set, not planned. A record older than the print window, a truncated patch
 * or an unreadable pre-image gives no plan — the prose is refetched, never guessed. The boxes are
 * read once here, never per animation frame.
 */

import { useEffect, useState } from 'react';

import { appliedPrintPlans, printWindowOpen, type AppliedRecord, type PrintPlan } from './appliedPrint.ts';

export function useAppliedPrint(input: {
  applied: AppliedRecord | null;
  /** The chapter this article stands for. */
  n: number;
  /** The article's own element: the viewport test asks it where each block is. */
  article: React.RefObject<HTMLElement | null>;
  /** The chapter's prose is on the page. */
  loaded: boolean;
  /** Fetch the prose; `clock` is the print's own start when the write names this chapter. */
  load: (clock?: number) => void;
}): readonly PrintPlan[] {
  const [prints, setPrints] = useState<readonly PrintPlan[]>([]);

  useEffect(() => {
    const { applied, n, article, loaded, load } = input;
    if (applied === null || applied.n !== n) return;
    // A created chapter has no prose on this page yet: the slot fetches it, and the prose prints
    // as a whole on the write's own clock (`appliedAt`), never place by place.
    if (!loaded) {
      if (printWindowOpen(applied, Date.now())) load(applied.appliedAt);
      return;
    }
    if (applied.rev === 1) {
      // A create is one print of a whole chapter — the reveal's job — not an edit in place.
      setPrints([]);
      return;
    }
    const node = article.current;
    const height = typeof window === 'undefined' ? 800 : window.innerHeight || 800;
    const visible = (blockId: string | null): boolean => {
      if (node === null || blockId === null) return true;
      const element = node.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
      if (element === null) return true;
      const rect = element.getBoundingClientRect();
      return rect.bottom > -1.5 * height && rect.top < 2.5 * height;
    };
    setPrints(appliedPrintPlans(applied, { nowMs: Date.now(), visible }));
  }, [input.applied, input.n, input.article, input.loaded, input.load]);

  return prints;
}
