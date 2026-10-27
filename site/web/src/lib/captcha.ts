import type { CaptchaProvider } from '@book/shared';

/**
 * BOOK-DOC-34 §2.3 — the CAPTCHA is a form field, not a badge.
 *
 * The provider's script is loaded on the **first focus of the textarea**, never on page load:
 * the reading path stays third-party-free. If the provider cannot be reached, the form closes
 * with the truth and the strip still opens (§12.8 — unchanged by the seam).
 */

export type CaptchaApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string | number;
  reset?: (widgetId: string | number) => void;
  remove?: (widgetId: string | number) => void;
};

const SCRIPT_URLS: Record<Exclude<CaptchaProvider, 'none'>, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
};

const scriptPromises = new Map<string, Promise<void>>();

export function loadCaptchaScript(provider: CaptchaProvider): Promise<void> {
  if (provider === 'none') return Promise.resolve();
  const src = SCRIPT_URLS[provider];
  const cached = scriptPromises.get(src);
  if (cached !== undefined) return cached;
  const promise = new Promise<void>((resolve, reject) => {
    const element = document.createElement('script');
    element.src = src;
    element.async = true;
    element.defer = true;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error('captcha script failed'));
    document.head.appendChild(element);
  });
  scriptPromises.set(src, promise);
  return promise;
}

export function captchaApi(provider: CaptchaProvider): CaptchaApi | null {
  if (provider === 'none') return null;
  const scope = window as unknown as { turnstile?: CaptchaApi; hcaptcha?: CaptchaApi };
  return provider === 'turnstile' ? (scope.turnstile ?? null) : (scope.hcaptcha ?? null);
}
