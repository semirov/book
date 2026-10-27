import { describe, expect, it } from 'vitest';

import { isReadLimited, READ_WINDOW_MS, readLimitKey } from '../src/http/readLimit.ts';

/**
 * The read budget (audit M6): which URLs take a slot, and what a slot is keyed by. The
 * integration path (a 429 with `retry-after`) is in `api.test.ts` — and for the title page's
 * own budget, in `frontRoute.test.ts`.
 */
describe('the read API budget', () => {
  it('limits the history projections, the state poll, the title page, the cost line, the change list, the end matter and the reader’s own record', () => {
    for (const url of [
      '/api/history',
      '/api/history/timeline?limit=5',
      '/api/history/at/now',
      '/api/history/contributors',
      '/api/state',
      '/api/front',
      '/api/front?poll=1',
      // BOOK-114: the footer's whole-book aggregate is budgeted like the title page's.
      '/api/cost',
      '/api/cost?x=1',
      '/api/changes?limit=6',
      '/api/me/decisions',
      '/api/authors',
      '/api/authors?fresh=1',
      // The reader's own trace pays the same whole-book measurement: it is budgeted too.
      '/api/authors/me',
    ]) {
      expect(isReadLimited(url), url).toBe(true);
    }
    // A longer word that merely starts with a limited prefix is another route.
    for (const url of [
      '/api/chapters',
      '/api/comments',
      '/api/authorship',
      '/healthz',
      '/api/historyz',
      '/api/states',
      '/api/fronts',
      '/api/costs',
      '/api/memory',
    ]) {
      expect(isReadLimited(url), url).toBe(false);
    }
  });

  it('keys a slot by the hashed network, never by the address', () => {
    const key = readLimitKey((value) => `hash(${value})`, '203.0.113.0/24');
    expect(key).toBe('read:ip:hash(203.0.113.0/24)');
    expect(key.startsWith('read:ip:')).toBe(true);
    expect(READ_WINDOW_MS).toBe(60_000);
  });
});
