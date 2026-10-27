import { describe, expect, it } from 'vitest';

import { TOTAL_CHAPTERS } from '@book/shared';

import { chapterFromHash, staticPage, staticPageHref } from './route.ts';

/** The two static documents (audit M5) are chosen from the path before the app boots. */
describe('static pages', () => {
  it('routes /privacy and /rules, with or without a trailing slash', () => {
    expect(staticPage('/privacy')).toBe('privacy');
    expect(staticPage('/privacy/')).toBe('privacy');
    expect(staticPage('/Privacy')).toBe('privacy');
    expect(staticPage('/privacy.html')).toBe('privacy');
    expect(staticPage('/rules')).toBe('rules');
    expect(staticPage('/rules//')).toBe('rules');
  });

  it('leaves every other path to the book', () => {
    for (const path of ['/', '/ch-8', '/privacyx', '/api/privacy', '/']) {
      expect(staticPage(path), path).toBeNull();
    }
  });

  it('builds the same-origin link the composer and the colophon carry', () => {
    expect(staticPageHref('privacy')).toBe('/privacy');
    expect(staticPageHref('rules')).toBe('/rules');
  });
});

describe('the chapter deep link (BOOK-63)', () => {
  it('reads `#ch-12` as chapter 12', () => {
    expect(chapterFromHash('#ch-12', TOTAL_CHAPTERS)).toBe(12);
    expect(chapterFromHash('#ch-1', TOTAL_CHAPTERS)).toBe(1);
    expect(chapterFromHash(`#ch-${TOTAL_CHAPTERS}`, TOTAL_CHAPTERS)).toBe(TOTAL_CHAPTERS);
  });

  it('refuses anything that is not a chapter of this book', () => {
    for (const hash of ['', '#', '#ch-', '#ch-0', `#ch-${TOTAL_CHAPTERS + 1}`, '#ch-8x', '#ch08', '#правка-cmt_1', '#ch-999']) {
      expect(chapterFromHash(hash, TOTAL_CHAPTERS), hash).toBeNull();
    }
  });
});
