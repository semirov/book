/**
 * CAPTCHA as a fact of the deployment, not a script tag (ARCHITECTURE.md §12.8, ADR-028).
 *
 * The provider decides exactly which origins the application-owned CSP may name and which
 * siteverify endpoint the server calls. One table, two consumers: the CSP builder and the
 * verifier. A deployment that names a provider it did not configure is a build failure
 * (`F028`), not a runtime surprise.
 */

export type CaptchaProvider = 'turnstile' | 'hcaptcha' | 'none';

export type CaptchaSurface = {
  /** The browser's script origin(s) — `script-src`. */
  scriptOrigins: readonly string[];
  /** The challenge iframe(s) — `frame-src`. */
  frameOrigins: readonly string[];
  /** Where the browser widget posts its result — `connect-src`. */
  connectOrigins: readonly string[];
  /** Server-side siteverify endpoint. */
  verifyUrl: string;
};

/** `none` has no surface at all: commenting is closed, never opened without a challenge. */
export const CAPTCHA_SURFACES: Record<CaptchaProvider, CaptchaSurface> = {
  turnstile: {
    scriptOrigins: ['https://challenges.cloudflare.com'],
    frameOrigins: ['https://challenges.cloudflare.com'],
    connectOrigins: ['https://challenges.cloudflare.com'],
    verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
  hcaptcha: {
    scriptOrigins: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
    frameOrigins: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
    connectOrigins: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
    verifyUrl: 'https://api.hcaptcha.com/siteverify',
  },
  none: { scriptOrigins: [], frameOrigins: [], connectOrigins: [], verifyUrl: '' },
};

/** Metrika is the second — and last — third-party surface, only when an id is configured. */
export const METRIKA_ORIGIN = 'https://mc.yandex.ru';
