import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, yandexConfigured, yandexRedirectUri } from '../src/config.ts';
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
    expect(config.bookRoot.endsWith('book')).toBe(true);
    expect(config.imprintPath.endsWith('config/imprint.json')).toBe(true);
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
