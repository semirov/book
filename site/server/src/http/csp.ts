/**
 * The application-owned CSP (ARCHITECTURE.md invariants 27–28, §15.3, §17; F028).
 *
 * The header is computed once, from the deployment's own configuration: a challenge
 * provider's browser origins (none ship today — BOOK-64 dropped the widget), and Metrika's
 * single origin only when a counter id is configured. Nothing is pasted, nothing is widened
 * "just in case", and `unsafe-inline` is never emitted — an inline `<script>` cannot run,
 * which is why the theme bootstrap lives in `/theme.js` rather than in `index.html`.
 *
 * The same holds for styles (BOOK-30): `style-src 'self'` stands alone, with no
 * `style-src-attr` and no `'unsafe-inline'`. That is hardening, not a workaround: React's
 * `style` prop already goes through CSSOM, and only a literal `style="…"` attribute (for
 * example from `dangerouslySetInnerHTML`) would be dropped. The SPA therefore keeps every
 * colour in a class and every DOM-known value in a CSSOM write (`web/src/lib/cssom.ts`).
 *
 * Nothing on the page needs a third-party byte: the reading path is third-party-free, and
 * the composer no longer loads a challenge script or iframe (BOOK-64).
 */

import { CAPTCHA_SURFACES, METRIKA_ORIGIN } from '@book/shared';

import type { Config } from '../config.ts';

export type CspSource = Pick<Config, 'captchaProvider' | 'metrikaId' | 'publicOrigin'>;

/** `https://book.semirov.dev` → `wss://book.semirov.dev`. */
export function socketOrigin(publicOrigin: string): string {
  try {
    const url = new URL(publicOrigin);
    const protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return `${protocol}//${url.host}`;
  } catch {
    return 'wss://book.semirov.dev';
  }
}

export function buildCsp(config: CspSource): string {
  const surface = CAPTCHA_SURFACES[config.captchaProvider];
  const metrika = config.metrikaId.trim().length > 0 ? [METRIKA_ORIGIN] : [];
  const scripts = unique(['\'self\'', ...surface.scriptOrigins, ...metrika]);
  const frames = unique(surface.frameOrigins.length === 0 ? ['\'none\''] : [...surface.frameOrigins]);
  const connects = unique(['\'self\'', ...surface.connectOrigins, socketOrigin(config.publicOrigin), ...metrika]);
  const images = unique(['\'self\'', 'data:', ...metrika]);

  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self'",
    `img-src ${images.join(' ')}`,
    "font-src 'self'",
    `connect-src ${connects.join(' ')}`,
    `frame-src ${frames.join(' ')}`,
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ].join('; ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
