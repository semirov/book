import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { buildCsp, socketOrigin } from '../src/http/csp.ts';

/**
 * F028 / `T-captcha` (§12.8, §15.3): the header names exactly the configured providers, no
 * `unsafe-inline` ever, and a deployment without a Metrika id has no Yandex origin.
 */

const base = { publicOrigin: 'https://book.semirov.dev', metrikaId: '' };

describe('the generated CSP', () => {
  it('names exactly the Turnstile origins', () => {
    const csp = buildCsp({ ...base, captchaProvider: 'turnstile' });
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain('connect-src');
    expect(csp).toContain('wss://book.semirov.dev');
    expect(csp).not.toContain('hcaptcha');
    expect(csp).not.toContain('mc.yandex.ru');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
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
