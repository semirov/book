import { describe, expect, it } from 'vitest';

import { isAuthorsCount, newestAuthorsCount } from './authorsCount.ts';

describe('the live byline count (BOOK-DOC-4)', () => {
  it('takes a newer measurement', () => {
    const current = { count: 1, measuredAt: '2026-10-25T12:00:00.000Z' };
    const next = { count: 2, measuredAt: '2026-10-25T12:00:01.000Z' };
    expect(newestAuthorsCount(current, next)).toEqual(next);
  });

  it('never regresses on an out-of-order frame', () => {
    const current = { count: 3, measuredAt: '2026-10-25T12:00:05.000Z' };
    // A reconnect's older hello crosses a live update: the number on page 1 must not drop.
    const stale = { count: 1, measuredAt: '2026-10-25T12:00:01.000Z' };
    expect(newestAuthorsCount(current, stale)).toBe(current);
  });

  it('keeps the number when the marker is the same — the same measurement is not a correction', () => {
    const current = { count: 2, measuredAt: '2026-10-25T12:00:05.000Z' };
    expect(newestAuthorsCount(current, { count: 0, measuredAt: '2026-10-25T12:00:05.000Z' })).toBe(current);
  });

  it('shows 0 on an empty book and accepts the first real count', () => {
    expect(newestAuthorsCount(undefined, { count: 0, measuredAt: '2026-10-25T12:00:00.000Z' })).toEqual({
      count: 0,
      measuredAt: '2026-10-25T12:00:00.000Z',
    });
    expect(newestAuthorsCount({ count: 0, measuredAt: '' }, { count: 4, measuredAt: '2026-10-25T12:00:01.000Z' })).toEqual({
      count: 4,
      measuredAt: '2026-10-25T12:00:01.000Z',
    });
  });

  it('ignores a payload that is not a measurement', () => {
    const current = { count: 2, measuredAt: '2026-10-25T12:00:05.000Z' };
    expect(newestAuthorsCount(current, null)).toBe(current);
    expect(newestAuthorsCount(current, { count: -1, measuredAt: '2026-10-25T13:00:00.000Z' })).toBe(current);
    expect(newestAuthorsCount(current, { count: 1.5, measuredAt: '2026-10-25T13:00:00.000Z' })).toBe(current);
    expect(newestAuthorsCount(current, { count: 1 })).toBe(current);
  });

  it('recognises a valid frame', () => {
    expect(isAuthorsCount({ count: 0, measuredAt: '2026-10-25T12:00:00Z' })).toBe(true);
    expect(isAuthorsCount({ count: '0', measuredAt: '2026-10-25T12:00:00Z' })).toBe(false);
    expect(isAuthorsCount('0')).toBe(false);
  });
});
