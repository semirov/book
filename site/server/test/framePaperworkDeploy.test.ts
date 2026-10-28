/**
 * The deploy gate's own frame check, in test form (BOOK-137).
 *
 * Split from `framePaperwork.test.ts` (the 500-line gate): that file runs the whole paperwork
 * scenario against a fixture, this one runs the check `deploy.sh` runs — on the real manuscript,
 * where the only thing that matters is that all three parts answer `ok`.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkManuscript } from '../../scripts/lib/frame.mjs';

describe('the deploy gate’s own frame check', () => {
  it('passes on the real repository', () => {
    // `npm run frame:check` in test form: the same module `deploy.sh` runs reads the real
    // manuscript and answers one object per source — ch01's line, ch01's heading, the finale's.
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
    const checks = checkManuscript({ repoRoot }) as Array<{ label: string; ok: boolean; parts: unknown[] }>;
    expect(checks).toHaveLength(3);
    for (const check of checks) {
      expect(check.parts, check.label).toEqual([]);
      expect(check.ok, check.label).toBe(true);
    }
  });
});
