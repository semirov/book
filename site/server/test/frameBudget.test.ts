/**
 * BOOK-107 — the budget `checkServer` spends, decided by an injected clock.
 *
 * The CLI asks the running site two questions inside one 25 s deadline, so a hung request cannot
 * stretch a deploy's health check: each request is clamped to `CHAPTER_TIMEOUT_MS`, and the second
 * gets only what the first left. These cases pin the arithmetic instead of measuring a real timer
 * (the frame-check contract itself lives in `frameCheck.test.ts`).
 */

import { describe, expect, it, vi } from 'vitest';

import { CHAPTER_TIMEOUT_MS, TOTAL_TIMEOUT_MS, checkServer } from '../../scripts/lib/frame.mjs';

/**
 * The `AbortSignal.timeout` budgets a stubbed run hands out, in call order. The spy calls through,
 * so the signal the stub receives is still a real `AbortSignal`, not a stand-in.
 */
function spyOnTimeout(): { budgets: () => number[]; restore: () => void } {
  const spy = vi.spyOn(AbortSignal, 'timeout');
  return { budgets: () => spy.mock.calls.map(([ms]) => ms), restore: () => spy.mockRestore() };
}

describe('checkServer — one deadline, two requests (BOOK-107)', () => {

  it('bounds both chapters by one deadline: a spent budget makes the second chapter `timeout` with no request', async () => {
    // The clock is injected and the stub spends the whole budget on the first request, so the
    // second chapter's decision is the `remaining <= 0` arithmetic, not where a real timer lands.
    const timeout = spyOnTimeout();
    try {
      let clock = 0;
      let calls = 0;
      const signals: Array<AbortSignal | undefined> = [];
      const expiring = (_url: string, init: { signal?: AbortSignal }): Promise<Response> => {
        calls += 1;
        signals.push(init.signal);
        clock = 60;
        return Promise.reject(
          Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
        );
      };
      const checks = await checkServer({
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: expiring,
        budgetMs: 60,
        now: () => clock,
      });
      expect(checks.map((check) => check.parts[0]?.actual)).toEqual(['timeout', 'timeout']);
      // Both parts read `timeout` either way; `calls` is what says the second request was not made.
      expect(calls).toBe(1);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      // The one request went out with the whole budget still ahead of it.
      expect(timeout.budgets()).toEqual([60]);
      // The claim in deploy.sh: the whole check fits its 30 s allowance with room for node's start.
      expect(TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
    } finally {
      timeout.restore();
    }
  });

  it('gives the second chapter only what is left of the budget', async () => {
    // A budget wide enough for two bounded requests: the first spends 30 ms of it, so the second
    // is bounded by the 30 ms remaining, not by `CHAPTER_TIMEOUT_MS`.
    const timeout = spyOnTimeout();
    try {
      let clock = 0;
      let calls = 0;
      const expiring = (): Promise<Response> => {
        calls += 1;
        clock = calls === 1 ? 30 : 60;
        return Promise.reject(
          Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
        );
      };
      const checks = await checkServer({
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: expiring,
        budgetMs: 60,
        now: () => clock,
      });
      expect(checks.map((check) => check.parts[0]?.actual)).toEqual(['timeout', 'timeout']);
      expect(calls).toBe(2);
      expect(timeout.budgets()).toEqual([60, 30]);
    } finally {
      timeout.restore();
    }
  });

  it('makes no request at all when the deadline has already passed', async () => {
    let calls = 0;
    const neverCalled = (): Promise<Response> => {
      calls += 1;
      // If the deadline check regresses, fail here with a readable reason instead of a hang.
      return Promise.reject(new Error('a request was made with an expired deadline'));
    };
    const checks = await checkServer({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: neverCalled,
      budgetMs: 0,
      now: () => 1_000,
    });
    expect(checks.map((check) => check.parts[0]?.actual)).toEqual(['timeout', 'timeout']);
    expect(calls).toBe(0);
  });

  it('clamps each request to `CHAPTER_TIMEOUT_MS` under the CLI budget', async () => {
    // What the CLI actually runs: no `budgetMs`, so 25 s is left and every request is clamped to
    // the per-request bound. A regression to `AbortSignal.timeout(remaining)` would read 25 000.
    const timeout = spyOnTimeout();
    try {
      let calls = 0;
      const signals: Array<AbortSignal | undefined> = [];
      const expiring = (_url: string, init: { signal?: AbortSignal }): Promise<Response> => {
        calls += 1;
        signals.push(init.signal);
        return Promise.reject(
          Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
        );
      };
      const checks = await checkServer({
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: expiring,
        budgetMs: TOTAL_TIMEOUT_MS,
        now: () => 0,
      });
      expect(checks.map((check) => check.parts[0]?.actual)).toEqual(['timeout', 'timeout']);
      // The clock never moves, so chapter 2 still has the whole 25 s and is attempted too.
      expect(calls).toBe(2);
      expect(signals).toHaveLength(2);
      expect(timeout.budgets()).toEqual([CHAPTER_TIMEOUT_MS, CHAPTER_TIMEOUT_MS]);
    } finally {
      timeout.restore();
    }
  });
});
