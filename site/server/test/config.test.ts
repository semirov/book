import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig, SITE_ROOT, yandexConfigured, yandexRedirectUri } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { createFixture } from './helpers.ts';

/** A valid production shape, so each refusal below fails for exactly one reason. */
const production = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://book.test',
  SESSION_SECRET: 'session-secret-from-test',
  IP_SALT: 'ip-salt-from-test',
  CAPTCHA_PROVIDER: 'turnstile',
  CAPTCHA_SECRET: 'captcha-secret-from-test',
  CAPTCHA_SITE_KEY: 'captcha-site-key-from-test',
} as const;

describe('loadConfig', () => {
  it('fills the defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.tz).toBe('Europe/Moscow');
    expect(config.maxWs).toBe(100);
    expect(config.leaseTtlMs).toBe(120_000);
    // audit m1: the proxy is one host, not a /24 that lets the LAN forge its address.
    expect(config.trustedProxies).toBe('127.0.0.1,::1,192.168.1.44/32');
    expect(config.readPerMinute).toBe(60);
    expect(config.bookRoot.endsWith('book')).toBe(true);
    expect(config.imprintPath.endsWith('config/imprint.json')).toBe(true);
  });

  it('resolves a relative WEB_DIST against site/ (compose passes ./web/dist)', () => {
    // `@fastify/static` refuses a relative root: the boot is the last place to catch it.
    expect(loadConfig({ WEB_DIST: './web/dist' }).webDist).toBe(`${SITE_ROOT}/web/dist`);
    expect(loadConfig({ WEB_DIST: '/app/web/dist' }).webDist).toBe('/app/web/dist');
    expect(loadConfig({}).webDist).toBe(`${SITE_ROOT}/web/dist`);
  });

  it('reads the environment', () => {
    const config = loadConfig({
      BOOK_ROOT: '/book',
      DATA_DIR: '/data',
      PORT: '9090',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'warn',
      BUDGET_MAX_STEPS: '20',
    });
    expect(config).toMatchObject({
      bookRoot: '/book',
      dataDir: '/data',
      port: 9090,
      host: '0.0.0.0',
      logLevel: 'warn',
      budgetMaxSteps: 20,
    });
  });

  it('fails fast with a readable message', () => {
    expect(() => loadConfig({ PORT: 'не-порт' })).toThrow(/invalid configuration: port/u);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/logLevel/u);
  });

  it('refuses a configured CAPTCHA provider with no public site key (the widget cannot render)', () => {
    expect(() => loadConfig({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SECRET: 'secret' })).toThrow(
      /CAPTCHA_SITE_KEY is required for provider turnstile/u,
    );
    expect(() =>
      loadConfig({ CAPTCHA_PROVIDER: 'hcaptcha', CAPTCHA_SECRET: 'secret', CAPTCHA_SITE_KEY: '   ' }),
    ).toThrow(/CAPTCHA_SITE_KEY is required for provider hcaptcha/u);
    // `none` needs no key: there is no widget to render.
    expect(loadConfig({ CAPTCHA_PROVIDER: 'none' }).captchaSiteKey).toBe('');
  });

  it('refuses a provider with no secret and the `none` default in production', () => {
    expect(() => loadConfig({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: 'key' })).toThrow(
      /CAPTCHA_SECRET is required for provider turnstile/u,
    );
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /CAPTCHA_PROVIDER=none is refused in production/u,
    );
  });

  it('refuses the vendors’ published CAPTCHA test keys in production (audit B1)', () => {
    // A test sitekey accepts every challenge, and the matching secret answers `success:true`
    // for any token: the form would be open to any bot. A production boot must fail closed.
    for (const key of [
      '1x00000000000000000000AA',
      '1x00000000000000000000aa',
      '2x00000000000000000000AB',
      '3x00000000000000000000FF',
      '10000000-ffff-ffff-ffff-000000000001',
    ]) {
      let message = '';
      try {
        loadConfig({ ...production, CAPTCHA_SITE_KEY: key });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/CAPTCHA_SITE_KEY is a published test key/u);
      // The message names the variable, never the value.
      expect(message).not.toContain(key);
    }

    for (const secret of [
      '1x0000000000000000000000000000000AA',
      '2x0000000000000000000000000000000AA',
      '3x0000000000000000000000000000000AA',
      '0x0000000000000000000000000000000000000000',
    ]) {
      let message = '';
      try {
        loadConfig({ ...production, CAPTCHA_SECRET: secret });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/CAPTCHA_SECRET is a published test key/u);
      expect(message).not.toContain(secret);
    }

    // Both halves published: the secret is the fatal one, whatever the sitekey — and the
    // sitekey opt-in does not lift it (requirement: a published secret is fatal everywhere).
    const publishedPair = {
      ...production,
      CAPTCHA_SITE_KEY: '1x00000000000000000000AA',
      CAPTCHA_SECRET: '1x0000000000000000000000000000000AA',
      CAPTCHA_ALLOW_TEST_SITE_KEY: '1',
    };
    let both = '';
    try {
      loadConfig(publishedPair);
    } catch (error) {
      both = error instanceof Error ? error.message : String(error);
    }
    expect(both).toMatch(/CAPTCHA_SECRET is a published test key/u);
    expect(both).not.toContain(publishedPair.CAPTCHA_SITE_KEY);
    expect(both).not.toContain(publishedPair.CAPTCHA_SECRET);

    // A normal key pair boots; the published test pair is the only thing refused.
    const config = loadConfig({
      ...production,
      CAPTCHA_SECRET: '0x4f3a-real-secret',
      CAPTCHA_SITE_KEY: '0x4AAA-site-key',
    });
    expect(config.captchaSiteKey).toBe('0x4AAA-site-key');
  });

  it('refuses a published CAPTCHA sitekey in production unless CAPTCHA_ALLOW_TEST_SITE_KEY=1', () => {
    // The live deployment must not crash-loop by accident, but it must not boot quietly with a
    // decorative widget either: the refusal names the variable and tells the operator the
    // opt-in exists, and never carries the key.
    const sitekey = '1x00000000000000000000AA';
    for (const env of [{}, { CAPTCHA_ALLOW_TEST_SITE_KEY: '0' }]) {
      let message = '';
      try {
        loadConfig({ ...production, CAPTCHA_SITE_KEY: sitekey, ...env });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/CAPTCHA_SITE_KEY is a published test key/u);
      expect(message).toMatch(/CAPTCHA_ALLOW_TEST_SITE_KEY=1/u);
      expect(message).not.toContain(sitekey);
    }
  });

  it('boots in production with a published test sitekey only under CAPTCHA_ALLOW_TEST_SITE_KEY=1', () => {
    const sitekey = '1x00000000000000000000AA';
    const secret = '0x4f3a-real-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = loadConfig({
        ...production,
        CAPTCHA_SITE_KEY: sitekey,
        CAPTCHA_SECRET: secret,
        CAPTCHA_ALLOW_TEST_SITE_KEY: '1',
      });
      expect(config.captchaSiteKey).toBe(sitekey);
      expect(config.captchaAllowTestSiteKey).toBe('1');
      // Exactly one line, and it is loud about the consequence, not about the value.
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0]?.[0] ?? '');
      expect(said).toMatch(/CAPTCHA_SITE_KEY/u);
      expect(said).toMatch(/CAPTCHA_ALLOW_TEST_SITE_KEY=1/u);
      expect(said).toMatch(/comments stay closed/u);
      expect(said).not.toContain(sitekey);
      expect(said).not.toContain(secret);
      expect(said).not.toContain('\n');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses an invalid CAPTCHA_ALLOW_TEST_SITE_KEY value like any other bad config', () => {
    expect(() => loadConfig({ ...production, CAPTCHA_ALLOW_TEST_SITE_KEY: 'true' })).toThrow(
      /captchaAllowTestSiteKey/u,
    );
  });

  it('refuses a published CAPTCHA secret in every environment, naming only the variable', () => {
    // With a published secret siteverify answers `success: true` for any token: the comment
    // path would be open, so no environment and no opt-in may accept it.
    const secret = '1x0000000000000000000000000000000AA';
    for (const env of [
      { NODE_ENV: 'development', CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: '0x4AAA-site-key' },
      { NODE_ENV: 'test', CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: '0x4AAA-site-key' },
      { CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: '0x4AAA-site-key' },
      {
        NODE_ENV: 'development',
        CAPTCHA_PROVIDER: 'turnstile',
        CAPTCHA_SITE_KEY: '0x4AAA-site-key',
        CAPTCHA_ALLOW_TEST_SITE_KEY: '1',
      },
    ]) {
      let message = '';
      try {
        loadConfig({ ...env, CAPTCHA_SECRET: secret });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/CAPTCHA_SECRET is a published test key/u);
      expect(message).not.toContain(secret);
    }
  });

  it('still refuses a published CAPTCHA secret in production under CAPTCHA_ALLOW_TEST_SITE_KEY=1', () => {
    const secret = '1x0000000000000000000000000000000AA';
    let message = '';
    try {
      loadConfig({
        ...production,
        CAPTCHA_SECRET: secret,
        CAPTCHA_ALLOW_TEST_SITE_KEY: '1',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/CAPTCHA_SECRET is a published test key/u);
    expect(message).not.toContain(secret);
  });

  it('only warns about a published CAPTCHA test sitekey outside production', () => {
    // A sandbox sitekey with a real secret boots a local composer; the composer is still closed
    // because siteverify rejects the token against the real secret.
    const sitekey = '1x00000000000000000000AA';
    const secret = '0x4f3a-real-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const env of [{}, { CAPTCHA_ALLOW_TEST_SITE_KEY: '1' }]) {
        warn.mockClear();
        const config = loadConfig({
          ...env,
          CAPTCHA_PROVIDER: 'turnstile',
          CAPTCHA_SITE_KEY: sitekey,
          CAPTCHA_SECRET: secret,
        });
        expect(config.captchaSiteKey).toBe(sitekey);
        expect(warn).toHaveBeenCalledTimes(1);
        const said = String(warn.mock.calls[0]?.[0] ?? '');
        expect(said).toMatch(/CAPTCHA_SITE_KEY is a published test key/u);
        expect(said).not.toContain(sitekey);
        expect(said).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('derives the OAuth redirect from the public origin when it is not configured', () => {
    const config = loadConfig({ PUBLIC_ORIGIN: 'https://book.test/' });
    expect(yandexRedirectUri(config)).toBe('https://book.test/auth/yandex/callback');
    expect(yandexConfigured(config)).toBe(false);
    expect(yandexConfigured(loadConfig({ YANDEX_CLIENT_ID: 'id', YANDEX_CLIENT_SECRET: 'secret' }))).toBe(true);
  });
});

describe('loadConfig — mounted secret files (§21.2)', () => {
  const withDir = (run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'book-secrets-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const writeSecret = (dir: string, name: string, value: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    return path;
  };

  it('prefers the mounted file over the plain variable', () => {
    withDir((dir) => {
      const config = loadConfig({
        SESSION_SECRET_FILE: writeSecret(dir, 'session_secret', 'from-the-file'),
        SESSION_SECRET: 'from-the-variable',
      });
      expect(config.sessionSecret).toBe('from-the-file');
      // The trailing newline of a mounted file is not part of the value.
      expect(config.sessionSecret.endsWith('\n')).toBe(false);
    });
  });

  it('falls back to the plain variable when no file is named', () => {
    const config = loadConfig({ IP_SALT: 'inline-salt' });
    expect(config.ipSalt).toBe('inline-salt');
  });

  it('fails on a named file that cannot be read, naming the variable only', () => {
    withDir((dir) => {
      const missing = join(dir, 'absent');
      let message = '';
      try {
        loadConfig({ YANDEX_CLIENT_SECRET_FILE: missing });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/invalid configuration: cannot read YANDEX_CLIENT_SECRET_FILE/u);
      // A path is not a secret, but the message stays a name: no value, no path.
      expect(message).not.toContain(missing);
    });
  });

  it('refuses an empty mounted file instead of booting with no secret', () => {
    withDir((dir) => {
      expect(() =>
        loadConfig({
          CAPTCHA_PROVIDER: 'turnstile',
          CAPTCHA_SITE_KEY: 'key',
          CAPTCHA_SECRET_FILE: writeSecret(dir, 'empty_captcha_secret', '  '),
        }),
      ).toThrow(/CAPTCHA_SECRET_FILE is empty/u);
    });
  });
});

describe('loadConfig — production invariants (§14, §21.2)', () => {
  it('accepts a complete production shape', () => {
    const config = loadConfig({ ...production });
    expect(config.publicOrigin).toBe('https://book.test');
    expect(config.captchaProvider).toBe('turnstile');
  });

  it('refuses an empty session secret in production', () => {
    expect(() => loadConfig({ ...production, SESSION_SECRET: '' })).toThrow(
      /SESSION_SECRET is required in production/u,
    );
  });

  it('refuses an empty IP salt in production', () => {
    expect(() => loadConfig({ ...production, IP_SALT: '' })).toThrow(/IP_SALT is required in production/u);
  });

  it('refuses a non-https public origin in production: the cookie would lose Secure', () => {
    expect(() => loadConfig({ ...production, PUBLIC_ORIGIN: 'http://book.test' })).toThrow(
      /PUBLIC_ORIGIN must be https:\/\//u,
    );
  });

  it('keeps the ephemeral fallbacks outside production', () => {
    const config = loadConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:8080' });
    expect(config.sessionSecret).toBe('');
    expect(config.ipSalt).toBe('');
  });
});

describe('migrate', () => {
  it('is idempotent and reports the version it found', () => {
    const fixture = createFixture();
    try {
      const second = migrate(fixture.db);
      expect(second.from).toBe(SCHEMA_VERSION);
      expect(second.to).toBe(SCHEMA_VERSION);
      const lane = fixture.db.prepare('SELECT COUNT(*) AS n FROM lane').get() as { n: number };
      expect(lane.n).toBe(1);
    } finally {
      fixture.close();
    }
  });
});
