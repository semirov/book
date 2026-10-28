/**
 * The colophon's fixtures, shared by `colophon.test.tsx` and `colophonBudget.test.tsx` (the two
 * files together would cross the 500-line architecture gate). One empty book, and the document
 * stand-in the theme reader needs at first paint — a test renders without a browser.
 */

import type { StateSnapshot } from '@book/shared';
import { vi } from 'vitest';

export const state = {
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0 },
} as unknown as StateSnapshot;

/** The theme is read from the document at first paint; the test renders without a browser. */
export function stubDocument(): void {
  vi.stubGlobal('document', {
    documentElement: { getAttribute: () => 'night', setAttribute: () => undefined },
    querySelector: () => null,
  });
}
