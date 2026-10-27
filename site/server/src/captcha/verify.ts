/**
 * Server-side CAPTCHA verification (ARCHITECTURE.md §12.8; ADR-028).
 *
 * Fail-closed, always: no provider, no secret, a timeout, a 5xx or a malformed answer all
 * mean **commenting is closed**, never opened without a challenge. A rejected token is a
 * different fact from an unavailable verifier, because the composer behaves differently:
 * re-arm the widget (`CAPTCHA_FAILED`) or close with an honest banner
 * (`CAPTCHA_UNAVAILABLE`).
 *
 * Nothing from the challenge is stored: not the token, not its age, not the score. The
 * score, when present, is reduced to a coarse band for abuse review only.
 */

import { CAPTCHA_SURFACES, type CaptchaProvider } from '@book/shared';

import type { Config } from '../config.ts';

export type CaptchaVerdict =
  | { ok: true; band: 'ok' | 'low' }
  | { ok: false; code: 'CAPTCHA_FAILED' | 'CAPTCHA_UNAVAILABLE'; message: string; detail: string };

export type CaptchaVerifier = (token: string | undefined, context?: { ip?: string }) => Promise<CaptchaVerdict>;

export type CaptchaSource = Pick<Config, 'captchaProvider' | 'captchaSecret' | 'captchaTimeoutMs'> & {
  /** Test seam: point the verifier at a stub endpoint. */
  captchaVerifyUrl?: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CLOSED_MESSAGE = 'приём замечаний приостановлен · проверка недоступна';
const FAILED_MESSAGE = 'проверка не пройдена — попробуйте ещё раз';

export function createCaptchaVerifier(
  config: CaptchaSource,
  fetchImpl: FetchLike = fetch,
  provider: CaptchaProvider = config.captchaProvider,
): CaptchaVerifier {
  return async (token, context = {}) => {
    if (provider === 'none' || config.captchaSecret.length === 0) {
      return unavailable('no captcha provider is configured');
    }
    if (token === undefined || token.trim().length === 0) {
      return { ok: false, code: 'CAPTCHA_FAILED', message: FAILED_MESSAGE, detail: 'empty token' };
    }

    const surface = CAPTCHA_SURFACES[provider];
    const url = config.captchaVerifyUrl ?? surface.verifyUrl;
    const form = new URLSearchParams({ secret: config.captchaSecret, response: token });
    if (context.ip !== undefined && context.ip.length > 0) form.set('remoteip', context.ip);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.timeout(config.captchaTimeoutMs),
      });
    } catch (error) {
      return unavailable(error instanceof Error ? error.name : 'verifier unreachable');
    }

    if (!response.ok) return unavailable(`verifier answered ${response.status}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return unavailable('verifier returned a non-JSON body');
    }
    if (payload === null || typeof payload !== 'object' || typeof (payload as { success?: unknown }).success !== 'boolean') {
      return unavailable('verifier returned an unexpected body');
    }
    if ((payload as { success: boolean }).success !== true) {
      return { ok: false, code: 'CAPTCHA_FAILED', message: FAILED_MESSAGE, detail: 'siteverify refused the token' };
    }

    const score = (payload as { score?: unknown }).score;
    const band = typeof score === 'number' && score < 0.5 ? 'low' : 'ok';
    return { ok: true, band };
  };
}

function unavailable(detail: string): CaptchaVerdict {
  return { ok: false, code: 'CAPTCHA_UNAVAILABLE', message: CLOSED_MESSAGE, detail };
}
