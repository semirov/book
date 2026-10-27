import type { BookCostDto } from '@book/shared';
import { useEffect, useState } from 'react';

import { getCost } from './api.ts';

/**
 * The footer's outlay (BOOK-114): the spend as it stood when the page last read the book.
 *
 * It is fetched on mount and again whenever the book state version moves — a step row that
 * landed is a different total, and the version is the one fact every surface already watches.
 * A failed request keeps the last value (`null` until the first success): a hiccup must not
 * replace a measured total with a zero, and the next version reads it again. The endpoint is
 * memoised by book state, so a repeated view costs no scan.
 */
export function useBookCost(stateVersion: number | null): BookCostDto | null {
  const [cost, setCost] = useState<BookCostDto | null>(null);

  useEffect(() => {
    // Nothing has been read yet, so there is no book state to ask about — and no request.
    if (stateVersion === null) return;
    let live = true;
    void getCost()
      .then((next) => {
        if (live) setCost(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [stateVersion]);

  return cost;
}
