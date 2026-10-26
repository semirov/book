import { describe, expect, it } from 'vitest';

import { staticPage, staticPageHref } from './route.ts';

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
