import { describe, expect, it } from 'vitest';

import { wingSteps, wingsOf } from '../../src/engineState/wings.ts';

/**
 * Both wings as public data (§11.7, BOOK-DOC-4). The consequence is visible in both
 * directions at once, and each wing is proved from the steps it recorded: a wing that never
 * opened reaches nothing, and a wing that stopped says why it stopped — never a guess.
 */

const DOWN_STEP = (chapter: number, wave: number, outcome: string | null, seams: number[]) => ({
  pass: 'cascade',
  lane: 'backward' as const,
  chapter,
  wave,
  outcome,
  seams_out: seams.length === 0 ? null : JSON.stringify(seams.map((boundary) => ({ boundary, reason: 'r' }))),
});

const UP_STEP = (chapter: number, wave: number, outcome: string | null, seams: number[]) => ({
  ...DOWN_STEP(chapter, wave, outcome, seams),
  lane: 'forward' as const,
});

const ORIGIN = { pass: 'change', lane: null, chapter: 10, wave: 0, outcome: 'rewritten', seams_out: null };

describe('the two wings of a ripple', () => {
  it('runs down toward chapter 1 and up toward the last chapter, each with its own wave', () => {
    const steps = wingSteps([
      ORIGIN,
      DOWN_STEP(9, 1, 'rewritten', [9]),
      DOWN_STEP(8, 2, 'rewritten', []),
      UP_STEP(11, 1, 'rewritten', [12]),
    ]);
    const wings = wingsOf(steps, 10, 'closed');

    expect(wings.down).toEqual({ frontier: 8, wave: 2, state: 'settled', reached: [9, 8] });
    expect(wings.up).toEqual({ frontier: 11, wave: 1, state: 'settled', reached: [11] });
  });

  it('draws no wing that never opened: front 10, wave 0, nothing reached', () => {
    const wings = wingsOf(wingSteps([ORIGIN, DOWN_STEP(9, 1, 'rewritten', [])]), 10, 'open');
    expect(wings.down).toEqual({ frontier: 9, wave: 1, state: 'settled', reached: [9] });
    expect(wings.up).toEqual({ frontier: 10, wave: 0, state: 'waiting', reached: [] });
  });

  it('marks the wing whose step is in flight as moving, from the step itself', () => {
    const wings = wingsOf(wingSteps([ORIGIN, DOWN_STEP(9, 1, null, [])]), 10, 'open');
    expect(wings.down.state).toBe('moving');
    expect(wings.up.state).toBe('waiting');
  });

  it('says a wing stopped when the cascade escalated with its seam still open', () => {
    const steps = wingSteps([ORIGIN, DOWN_STEP(9, 1, 'rewritten', [9]), UP_STEP(11, 1, 'escalated', [11])]);
    const wings = wingsOf(steps, 10, 'escalated');
    expect(wings.up.state).toBe('stopped');
    const openSeam = wingsOf(wingSteps([ORIGIN, DOWN_STEP(9, 1, 'rewritten', [9])]), 10, 'escalated');
    expect(openSeam.down.state).toBe('stopped');
  });

  it('keeps the origin as the frontier while a wing has not moved, and orders reached nearest first', () => {
    const steps = wingSteps([
      ORIGIN,
      DOWN_STEP(9, 1, 'rewritten', [9]),
      DOWN_STEP(8, 2, 'rewritten', [8]),
      UP_STEP(11, 1, 'rewritten', []),
      UP_STEP(12, 2, 'rewritten', []),
    ]);
    const wings = wingsOf(steps, 10, 'open');
    expect(wings.down.reached).toEqual([9, 8]);
    expect(wings.up.reached).toEqual([11, 12]);
  });
});
