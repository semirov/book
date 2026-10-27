import { describe, expect, it } from 'vitest';

import { SHOW_AFTER_MS, SLOW_AFTER_MS, pendingStage } from './pending.ts';

/**
 * BOOK-DOC-43 §4 — the two thresholds a wait is judged by (BOOK-66).
 *
 * The numbers are pinned here because they are the whole design: below 150 ms a placeholder
 * flashes and reads as a glitch, and past 2 000 ms the reader stops believing the page and
 * earns one sentence instead. Both edges are asserted, not the middle.
 */
describe('a wait has three stages, and two edges', () => {
  it('shows nothing for the first 150 ms and one sentence from 2 000 ms', () => {
    expect(SHOW_AFTER_MS).toBe(150);
    expect(SLOW_AFTER_MS).toBe(2_000);
  });

  it('turns the form on exactly at the threshold, never one millisecond earlier', () => {
    expect(pendingStage(0)).toBe('quiet');
    expect(pendingStage(149)).toBe('quiet');
    expect(pendingStage(150)).toBe('skeleton');
    expect(pendingStage(1_999)).toBe('skeleton');
    expect(pendingStage(2_000)).toBe('slow');
    // A clock that has not started yet (or a negative delta) is still quiet, not a form.
    expect(pendingStage(-1)).toBe('quiet');
    expect(pendingStage(10_000)).toBe('slow');
  });
});
