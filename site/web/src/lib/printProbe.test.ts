import { describe, expect, it } from 'vitest';

import { printProbeOn } from './printProbe.ts';

/**
 * BOOK-220 — the probe is a flag, not a global: a reader's URL never asks for the plan, and a
 * page opened without a search at all answers `false` rather than throwing.
 */
describe('the print probe flag', () => {
  it('is on only for the harness’s own `probe=print`', () => {
    expect(printProbeOn('?probe=print')).toBe(true);
    expect(printProbeOn('?x=1&probe=print')).toBe(true);
    expect(printProbeOn('?probe=1')).toBe(false);
    expect(printProbeOn('?probe=')).toBe(false);
    expect(printProbeOn('')).toBe(false);
    expect(printProbeOn()).toBe(false);
  });
});
