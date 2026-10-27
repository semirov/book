import { describe, expect, it } from 'vitest';

import { createCaptchaVerifier } from '../src/captcha/verify.ts';

type Call = { url: string; body: string };

function stubFetch(answer: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe('CAPTCHA verification (§12.8)', () => {
  it('verifies a Turnstile token server-side and sends no PII beyond the address', async () => {
    const stub = stubFetch(() => Response.json({ success: true, score: 0.9 }));
    const verify = createCaptchaVerifier(
      { captchaProvider: 'turnstile', captchaSecret: 'sekret', captchaTimeoutMs: 3_000 },
      stub.fetch,
    );
    const verdict = await verify('token-1', { ip: '203.0.113.7' });
    expect(verdict).toEqual({ ok: true, band: 'ok' });
    expect(stub.calls[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const form = new URLSearchParams(stub.calls[0]?.body ?? '');
    expect(form.get('secret')).toBe('sekret');
    expect(form.get('response')).toBe('token-1');
    expect(form.get('remoteip')).toBe('203.0.113.7');
  });

  it('switches to hCaptcha as a real second vendor', async () => {
    const stub = stubFetch(() => Response.json({ success: true }));
    const verify = createCaptchaVerifier(
      { captchaProvider: 'hcaptcha', captchaSecret: 'sekret', captchaTimeoutMs: 3_000 },
      stub.fetch,
    );
    expect(await verify('token-2')).toEqual({ ok: true, band: 'ok' });
    expect(stub.calls[0]?.url).toBe('https://api.hcaptcha.com/siteverify');
  });

  it('reports a refused token as CAPTCHA_FAILED, not as an outage', async () => {
    const stub = stubFetch(() => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }));
    const verify = createCaptchaVerifier(
      { captchaProvider: 'turnstile', captchaSecret: 'sekret', captchaTimeoutMs: 3_000 },
      stub.fetch,
    );
    const verdict = await verify('bad');
    expect(verdict).toMatchObject({ ok: false, code: 'CAPTCHA_FAILED' });
    if (verdict.ok) return;
    expect(verdict.message).toContain('проверка');
  });

  it('closes commenting when the verifier is unreachable, slow, 5xx or malformed', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => {
        throw new Error('timeout');
      },
      () => new Response('nope', { status: 503 }),
      () => new Response('<html>not json</html>', { status: 200 }),
      () => Response.json({ unexpected: true }),
    ];
    for (const answer of answers) {
      const stub = stubFetch(answer);
      const verify = createCaptchaVerifier(
        { captchaProvider: 'turnstile', captchaSecret: 'sekret', captchaTimeoutMs: 3_000 },
        stub.fetch,
      );
      const verdict = await verify('token');
      expect(verdict).toMatchObject({ ok: false, code: 'CAPTCHA_UNAVAILABLE' });
      if (!verdict.ok) expect(verdict.message).toContain('приостановлен');
    }
  });

  it('fails closed with no provider or no secret, without calling anyone', async () => {
    const stub = stubFetch(() => Response.json({ success: true }));
    const none = createCaptchaVerifier(
      { captchaProvider: 'none', captchaSecret: '', captchaTimeoutMs: 3_000 },
      stub.fetch,
    );
    expect(await none('token')).toMatchObject({ ok: false, code: 'CAPTCHA_UNAVAILABLE' });

    const noSecret = createCaptchaVerifier(
      { captchaProvider: 'turnstile', captchaSecret: '', captchaTimeoutMs: 3_000 },
      stub.fetch,
    );
    expect(await noSecret('token')).toMatchObject({ ok: false, code: 'CAPTCHA_UNAVAILABLE' });
    expect(stub.calls).toHaveLength(0);
  });

  it('does not call the provider for an empty token', async () => {
    const stub = stubFetch(() => Response.json({ success: true }));
    const verify = createCaptchaVerifier(
      { captchaProvider: 'turnstile', captchaSecret: 'sekret', captchaTimeoutMs: 3_000 },
      stub.fetch,
    );
    expect(await verify('  ')).toMatchObject({ ok: false, code: 'CAPTCHA_FAILED' });
    expect(stub.calls).toHaveLength(0);
  });
});
