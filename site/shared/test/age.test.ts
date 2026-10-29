import { describe, expect, it } from 'vitest';

import { AGE_COOKIE, AGE_MAX_AGE_SECONDS, ageDateOf, ageDayIn, ageDayOf } from '../src/age.ts';

/**
 * The age gate's one reading of its cookie (BOOK-225). The route that writes it and the route
 * that refuses prose without it both ask these functions, so the cases below are the contract:
 * a day, within a year, not ahead of the clock, and nothing else is an answer.
 */

const NOW = new Date('2026-10-29T12:00:00Z');

describe('the age cookie’s value', () => {
  it('is the site’s own day', () => {
    expect(ageDateOf(NOW)).toBe('2026-10-29');
    // The bound and the cookie's `Max-Age` are one number, said once.
    expect(AGE_MAX_AGE_SECONDS).toBe(365 * 24 * 60 * 60);
  });

  it('reads a day written today, and one written a year ago minus a moment', () => {
    expect(ageDayOf('2026-10-29', NOW)).toBe('2026-10-29');
    expect(ageDayOf('2025-10-30', NOW)).toBe('2025-10-30');
  });

  it('reads every kind of “not answered” as the same answer', () => {
    expect(ageDayOf(undefined, NOW)).toBeNull();
    expect(ageDayOf('', NOW)).toBeNull();
    expect(ageDayOf('not-a-date', NOW)).toBeNull();
    // A day that does not exist, and a day written in a shape the cookie never carries.
    expect(ageDayOf('2026-02-30', NOW)).toBeNull();
    expect(ageDayOf('29.10.2026', NOW)).toBeNull();
    expect(ageDayOf('2026-1-9', NOW)).toBeNull();
    // Spent: a day exactly a year back, and any older one.
    expect(ageDayOf('2025-10-29', NOW)).toBeNull();
    expect(ageDayOf('2000-01-01', NOW)).toBeNull();
    // Ahead of the site's clock: the site writes its own day, so a later one was not written here.
    expect(ageDayOf('2026-10-30', NOW)).toBeNull();
  });
});

describe('the age cookie in a header', () => {
  it('finds its own name among others, and reads `document.cookie` the same way', () => {
    expect(ageDayIn(`${AGE_COOKIE}=2026-10-29`, NOW)).toBe('2026-10-29');
    expect(ageDayIn(`book.theme=night; ${AGE_COOKIE}=2026-10-29; _ym_uid=1`, NOW)).toBe('2026-10-29');
    expect(ageDayIn(`${AGE_COOKIE}="2026-10-29"`, NOW)).toBeNull();
  });

  it('is not fooled by a prefix or by a value that is not a day', () => {
    expect(ageDayIn(undefined, NOW)).toBeNull();
    expect(ageDayIn('', NOW)).toBeNull();
    expect(ageDayIn('book_age_old=2026-10-29', NOW)).toBeNull();
    expect(ageDayIn(`${AGE_COOKIE}=2026-10-29; ${AGE_COOKIE}=2000-01-01`, NOW)).toBe('2026-10-29');
    expect(ageDayIn(`${AGE_COOKIE}=%E0%A4%A`, NOW)).toBeNull();
    expect(ageDayIn(`${AGE_COOKIE}=%32%30%32%36-10-29`, NOW)).toBe('2026-10-29');
  });
});
