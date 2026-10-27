import { describe, expect, it } from 'vitest';

import { BUILD, composeBuildStamp } from './buildStamp.ts';

/**
 * BOOK-109 — the colophon's build line. The shape is pinned, not the value: a build knows its
 * own commit, and a test must not have to guess it. What is asserted is the sentence a reader
 * sees, and that a build without a stamp still prints a placeholder instead of a bare «сборка».
 */
describe('buildStamp', () => {
  it('composes «сборка <commit> · <stamp>» from what the build baked in', () => {
    // The colophon's default path: no argument, the bundle's own values.
    expect(composeBuildStamp()).toMatch(/^сборка \S+ · \d{2}\.\d{2} \d{2}:\d{2}$/u);
  });

  it('reads the values the bundler replaced, not an empty pair (the define is live)', () => {
    // `vitest.config.ts` fixes these two; an empty `BUILD` would mean the define was missed
    // and the fallback below — not the build — produced the line.
    expect(BUILD).toEqual({ commit: 'test', stamp: '01.01 00:00' });
    expect(composeBuildStamp()).toBe('сборка test · 01.01 00:00');
  });

  it('prints the placeholders rather than an empty pair when no build stamped the pair', () => {
    expect(composeBuildStamp({ commit: '', stamp: '' })).toBe('сборка dev · 00.00 00:00');
  });

  it('prints the passed build, so the colophon can be pinned without a build', () => {
    expect(composeBuildStamp({ commit: '5558449', stamp: '27.10 20:52' })).toBe('сборка 5558449 · 27.10 20:52');
  });
});
