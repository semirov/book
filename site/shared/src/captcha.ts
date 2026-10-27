/**
 * A CAPTCHA as a fact of the deployment, not a script tag (ARCHITECTURE.md invariant 27, ADR-028).
 *
 * BOOK-64 (2026-10-27): the write gate is an authenticated identity plus the comment and edit
 * rate limits, so no widget runs and the browser loads no challenge origin. The table keeps
 * the server-side `verifyUrl` per provider — the verifier stays in the build for the day a
 * challenge returns as its own decision — and the browser origin lists, which the CSP reads,
 * are empty for Turnstile because nothing on the page may reach `challenges.cloudflare.com`.
 */

export type CaptchaProvider = 'turnstile' | 'hcaptcha' | 'none';

export type CaptchaSurface = {
  /** The browser's script origin(s) — `script-src`. Empty when no widget ships. */
  scriptOrigins: readonly string[];
  /** The challenge iframe(s) — `frame-src`. */
  frameOrigins: readonly string[];
  /** Where the browser widget posts its result — `connect-src`. */
  connectOrigins: readonly string[];
  /** Server-side siteverify endpoint. */
  verifyUrl: string;
};

/**
 * `none` has no surface and no verifier: the gate is the identity plus the rate limits, and
 * the submit path never consults a challenge. Turnstile keeps its verify URL but no browser
 * origin (BOOK-64); hCaptcha is untouched by that item.
 */
export const CAPTCHA_SURFACES: Record<CaptchaProvider, CaptchaSurface> = {
  turnstile: {
    scriptOrigins: [],
    frameOrigins: [],
    connectOrigins: [],
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

/**
 * The published test credentials every vendor ships for its own documentation. They are
 * public: a Turnstile sitekey `1x0000…AA` accepts any challenge, and the matching secret
 * answers `success: true` for any token. A deployment carrying one of these does not have a
 * CAPTCHA — it has a formality — so the boot refuses them (audit B1, §12.8).
 *
 * Values are vendor documentation, not this deployment's keys; nothing here is a secret.
 */
export const PUBLISHED_CAPTCHA_TEST_KEYS: readonly string[] = [
  // Turnstile test sitekeys: always passes, always blocks, forces the interactive challenge.
  '1x00000000000000000000aa',
  '2x00000000000000000000ab',
  '3x00000000000000000000ff',
  '2x00000000000000000000bb',
  '3x00000000000000000000aa',
  // Turnstile test secrets: always passes, always fails, token already spent.
  '1x0000000000000000000000000000000aa',
  '2x0000000000000000000000000000000aa',
  '3x0000000000000000000000000000000aa',
  // hCaptcha's documented test pair.
  '10000000-ffff-ffff-ffff-000000000001',
  '0x0000000000000000000000000000000000000000',
];

/** True for a published vendor test credential, compared after normalisation. */
export function isPublishedCaptchaTestKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return PUBLISHED_CAPTCHA_TEST_KEYS.includes(normalized);
}
