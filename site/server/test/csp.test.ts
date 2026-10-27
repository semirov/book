import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { buildCsp, socketOrigin } from '../src/http/csp.ts';

/**
 * F028 / invariant 27 (§15.3): the header names exactly what the page loads, no
 * `unsafe-inline` ever, and a deployment without a Metrika id has no Yandex origin.
 * BOOK-64: no challenge origin — `challenges.cloudflare.com` is gone from script-src,
 * frame-src and connect-src even when a Turnstile provider is named.
 */

const base = { publicOrigin: 'https://book.semirov.dev', metrikaId: '' };

describe('the generated CSP', () => {
  it('keeps the challenge origin out of every directive, even with Turnstile named (BOOK-64)', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'turnstile' });
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain('connect-src');
    expect(csp).toContain('wss://book.semirov.dev');
    expect(csp).not.toContain('hcaptcha');
    expect(csp).not.toContain('mc.yandex.ru');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('has no challenge origin for any provider (the header the page is served)', () => {
    for (const provider of ['none', 'turnstile', 'hcaptcha'] as const) {
      const csp = buildCsp({ ...base, captchaProvider: provider, metrikaId: '113820311' });
      for (const directive of csp.split('; ')) {
        expect(directive, `${provider} · ${directive}`).not.toContain('challenges.cloudflare.com');
        expect(directive, `${provider} · ${directive}`).not.toContain('turnstile');
      }
    }
  });

  it('names exactly the hCaptcha origins when that provider is configured', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'hcaptcha' });
    expect(csp).toContain('https://hcaptcha.com');
    expect(csp).toContain('https://*.hcaptcha.com');
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(csp).not.toContain('unsafe-inline');
  });

  it('adds Metrika only when a counter id exists', () => {
    const without = buildCsp({ ...base, captchaProvider: 'turnstile' });
    const withCounter = buildCsp({ ...base, captchaProvider: 'turnstile', metrikaId: '12345678' });
    expect(without).not.toContain('mc.yandex.ru');
    expect(withCounter).toContain('https://mc.yandex.ru');
  });

  it('opens the counter in script-src, connect-src and img-src — and nowhere else (BOOK-63)', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'none', metrikaId: '113820311' });
    const directives = new Map(csp.split('; ').map((directive) => [directive.split(' ')[0] ?? '', directive]));
    for (const name of ['script-src', 'connect-src', 'img-src']) {
      expect(directives.get(name), name).toContain('https://mc.yandex.ru');
    }
    // The loader needs no frame, no font and no object from Yandex.
    for (const name of ['frame-src', 'font-src', 'object-src', 'form-action']) {
      expect(directives.get(name), name).not.toContain('mc.yandex.ru');
    }
    for (const directive of csp.split(';')) expect(directive).not.toContain('unsafe-inline');
  });

  it('opens no third-party origin when no provider is configured', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'none' });
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain('cloudflare');
    expect(csp).not.toContain('hcaptcha');
    expect(csp).toContain("object-src 'none'");
  });

  it('keeps inline styles out of the header: no `unsafe-inline`, no `style-src-attr` (BOOK-30)', () => {
    for (const provider of ['none', 'turnstile', 'hcaptcha'] as const) {
      const csp = buildCsp({ ...base, captchaProvider: provider, metrikaId: '12345678' });
      // Every directive is checked: `unsafe-inline` in any of them would re-open styles.
      for (const directive of csp.split(';')) expect(directive).not.toContain('unsafe-inline');
      expect(csp).not.toContain('style-src-attr');
      expect(csp).not.toContain('style-src-elem');
      // The author ink is a class and the DOM-known geometry is a CSSOM write, so the
      // style directive never needs widening beyond the site's own sheet.
      expect(csp).toContain("style-src 'self'");
    }
  });

  it('derives the socket origin from the public origin', () => {
    expect(socketOrigin('https://book.semirov.dev')).toBe('wss://book.semirov.dev');
    expect(socketOrigin('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080');
    expect(socketOrigin('not a url')).toBe('wss://book.semirov.dev');
  });

  it('ships no inline script in the shell: the theme bootstrap is a file', () => {
    const html = readFileSync(join(SITE_ROOT, 'web', 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)];
    expect(inline).toHaveLength(0);
  });
});
