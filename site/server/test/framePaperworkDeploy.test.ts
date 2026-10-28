/**
 * The deploy gate's own frame check, in test form (BOOK-137, BOOK-187).
 *
 * Split from `framePaperwork.test.ts` (the 500-line gate): that file runs the whole paperwork
 * scenario against a fixture, this one runs the check `deploy.sh` runs. BOOK-187 moved the check
 * off the repository and onto the volume: `checkFrame` opens `<dataDir>/book.db` read-only and
 * answers one object per leg — the letters, both rows, and each chapter's span.
 */

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { checkFrame } from '../../scripts/lib/frame.mjs';
import { bootComments, type Harness } from './comments/helpers.ts';

/** The two chapter files the scenario writes: the frame at the edge of the prose in each. */
const CH01 = ['Начало', '', `${FRAME_FIRST_SENTENCE} Я постоял и вышел.`].join('\n');
const CH42 = ['Финал', '', 'Свет был включён до меня, и это было странно.', '', FRAME_LAST_SENTENCE].join('\n');

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('the deploy gate’s own frame check', () => {
  it('passes on the volume the scenario wrote, after every filing', async () => {
    // `npm run frame:check` in test form: a boot against a temp data dir is what makes the volume.
    // Three legs answer: the letters of both rows, the row count, and each chapter's span.
    harness = await bootComments({ chapters: { 'ch01.md': CH01, 'ch42.md': CH42 } });
    const result = checkFrame({ dataDir: harness.fixture.dataDir }) as {
      absent: boolean;
      checks: Array<{ parts: unknown[] }>;
    };
    expect(result.absent).toBe(false);
    expect(result.checks).toHaveLength(5);
    for (const check of result.checks) expect(check.parts).toEqual([]);
  });
});
