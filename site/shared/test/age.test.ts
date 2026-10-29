import { describe, expect, it } from 'vitest';

import { AGE_COOKIE, AGE_MAX_AGE_SECONDS, ageDateOf, ageDayIn, ageDayOf } from '../src/age.ts';
import { AGE_WORDS } from '../src/stateWords.ts';

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

/**
 * BOOK-225 — the words of the rating, pinned where they now live (BOOK-218's `stateWords.ts`).
 *
 * They are the owner's copy, so they are asserted literally: a rename or a reword is a decision,
 * not an edit. The register is the gate's own — the rating is `18+`, every mark is lowercase, and
 * the two sentences (`rulesBody`, `gateLine`) open as sentences do — and the banned stems never
 * reach it. `server/test/copy.test.ts` keeps the guarded copy modules free of those stems; this
 * module is not on that list because it says «редактор» exactly where the reader is told who
 * reads the text (BOOK-76), so the ban is pinned here instead.
 */
const APPROVED_AGE_WORDS = {
  label: '18+',
  colophon: '18+ · насилие, кровь и взрослые темы',
  rulesHeading: 'кому это читать',
  rulesBody: 'Книге 18+. Внутри — насилие, кровь и взрослые темы: это жанр, и текст не смягчается.',
  gateLine: 'В книге есть насилие, кровь и взрослые темы.',
  forward: 'мне есть 18 — читать',
  leave: 'мне нет 18 — уйти',
  refusal: 'книга 18+ — сначала подтвердите, что вам есть 18',
} as const;

/** The stems the book never says (BOOK-15/BOOK-19/BOOK-76); «редактор» is the one told elsewhere. */
const BANNED_STEMS = ['шов', 'противоречие исправлено', 'битый', 'retcon', 'аудитор'] as const;

describe('the rating and the gate’s words (BOOK-225)', () => {
  it('are the approved strings, all eight, literally', () => {
    expect(AGE_WORDS).toEqual(APPROVED_AGE_WORDS);
    expect(Object.keys(AGE_WORDS)).toHaveLength(8);
  });

  it('keep the register: two sentences, six marks, and the rating as `18+`', () => {
    const sentences = new Set(['rulesBody', 'gateLine']);
    for (const [field, text] of Object.entries(AGE_WORDS)) {
      for (const stem of BANNED_STEMS) expect(text.toLowerCase(), `${field}: ${stem}`).not.toContain(stem);
      if (sentences.has(field)) {
        // A sentence: a capital, and a full stop — `В книге есть насилие…`, `Книге 18+…`.
        expect(text, field).toMatch(/^[А-ЯЁ][\s\S]*\.$/u);
        continue;
      }
      // A mark: the rating itself (`18+`) or lowercase, and never a sentence.
      expect(text, field).toMatch(/^(?:18\+|[а-яё])/u);
      expect(text, field).not.toMatch(/\.$/u);
    }
    // Exactly the two sentences open with a capital; nothing else does.
    const capitalised = Object.entries(AGE_WORDS)
      .filter(([, text]) => /^[А-ЯЁ]/u.test(text))
      .map(([field]) => field);
    expect(capitalised).toEqual(['rulesBody', 'gateLine']);
  });
});
