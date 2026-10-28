/**
 * BOOK-145 — a step the engine takes away is a normal event, never a park.
 *
 * A step wall, a released lease, a step the engine closed itself: the lane says so in one line,
 * asks for the next assignment at once (`status: 'gone'`, exit 0) and never escalates a step
 * that is not its own — a second park there would tell the reader a false story.
 */

import { describe, expect, it } from 'vitest';

import { chapterAnswer, createHarness } from './harness.ts';

const CHAPTER = 40;

describe('a dead step', () => {
  it('answers `gone` when the lease is released under the pass, without a second park', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = null;
      // The engine closes the step while the pass is between calls: the next beat is refused
      // with LEASE_RELEASED, which is the shape of a step wall in the log.
      harness.hooks.beforeCall = (name) => {
        if (name !== 'beat') return;
        harness.hooks.beforeCall = undefined;
        const lease = harness.fixture.db
          .prepare('SELECT id FROM leases WHERE released_at IS NULL ORDER BY acquired_at DESC LIMIT 1')
          .get() as { id: string } | undefined;
        if (lease !== undefined) harness.fixture.engine.escalate(lease.id, 'тест: шаг снят движком');
      };
      harness.script.push(chapterAnswer());
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('gone');
      expect(harness.logs.some((line) => line.includes('шаг снят движком LEASE_RELEASED'))).toBe(true);
      // No park sentence reached the record: the pass never claimed a failure.
      expect(result.reason).toBe('шаг снят движком — беру следующее задание');
    } finally {
      await harness.close();
    }
  });
});
