import { describe, expect, it } from 'vitest';

import { isReadLimited, READ_WINDOW_MS, readLimitKey } from '../src/http/readLimit.ts';

/**
 * The read budget (audit M6): which URLs take a slot, and what a slot is keyed by. The
 * integration path (a 429 with `retry-after`) is in `api.test.ts`.
 */
describe('the read API budget', () => {
  it('limits the history projections, the state poll, the change list and the reader’s own record', () => {
    for (const url of [
      '/api/history',
      '/api/history/timeline?limit=5',
      '/api/history/at/now',
      '/api/history/contributors',
      '/api/state',
      '/api/changes?limit=6',
      '/api/me/decisions',
    ]) {
      expect(isReadLimited(url), url).toBe(true);
    }
    // A longer word that merely starts with a limited prefix is another route.
    for (const url of [
      '/api/chapters',
      '/api/comments',
      '/api/front',
      '/api/authors/me',
      '/healthz',
      '/api/historyz',
      '/api/states',
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
