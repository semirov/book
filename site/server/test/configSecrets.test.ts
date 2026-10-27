/**
 * ARCHITECTURE.md invariant 30: a secret comes from its `*_FILE` mount, never from an
 * environment value. Production refuses a plain value at boot; development and tests keep
 * accepting it (there is no opt-out), and a declared file that is missing or empty is fatal
 * everywhere. Every message names the variable and never the value or the path.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig, yandexConfigured } from '../src/config.ts';
import { absentSecretFile, cleanupSecretFiles, production, secretFile } from './configFixture.ts';

afterAll(cleanupSecretFiles);

// The five secrets invariant 30 covers, and the config field each one lands in.
const secrets = [
  { name: 'SESSION_SECRET', key: 'sessionSecret' },
  { name: 'IP_SALT', key: 'ipSalt' },
  { name: 'YANDEX_CLIENT_ID', key: 'yandexClientId' },
  { name: 'YANDEX_CLIENT_SECRET', key: 'yandexClientSecret' },
  { name: 'CAPTCHA_SECRET', key: 'captchaSecret' },
] as const;

describe('loadConfig — production takes a secret only from its file (invariant 30)', () => {
  it('refuses every plain value in production, naming the variable only', () => {
    for (const { name } of secrets) {
      const value = `plain-${name.toLowerCase()}-value`;
      let message = '';
      try {
        // `production` mounts the file; a deployment that supplies only the plain variable
        // must not boot, however valid the value looks.
        loadConfig({ ...production, [`${name}_FILE`]: undefined, [name]: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(new RegExp(`${name} must come from ${name}_FILE in production`, 'u'));
      expect(message).toMatch(/invariant 30/u);
      // A refusal is about the shape, never about the secret.
      expect(message).not.toContain(value);
    }
  });

  it('boots in production when every secret arrives from its file', () => {
    const env: NodeJS.ProcessEnv = { ...production };
    const mounted = new Map<string, string>();
    for (const { name } of secrets) {
      const value = `mounted-${name.toLowerCase()}-value`;
      mounted.set(name, value);
      env[`${name}_FILE`] = secretFile(value);
    }
    const config = loadConfig(env);
    for (const { name, key } of secrets) {
      expect(config[key]).toBe(mounted.get(name));
    }
  });

  it('ignores a stale plain value when the file is mounted (the compose shape)', () => {
    // compose passes both: `.env` still carries a value while the mount wins. The boot reads
    // the file; the leftover value is inert, not a refusal.
    const config = loadConfig({
      ...production,
      SESSION_SECRET: 'stale-plain-value',
      SESSION_SECRET_FILE: secretFile('from-the-file'),
    });
    expect(config.sessionSecret).toBe('from-the-file');
  });

  it('reads a blank production value as no secret at all, not as a plain value', () => {
    // `SESSION_SECRET=` (or spaces) is absent, so the required check speaks — a blank value
    // is not a refusal about the shape and must never become a whitespace secret.
    for (const blank of ['', '   ']) {
      expect(() => loadConfig({ ...production, SESSION_SECRET_FILE: undefined, SESSION_SECRET: blank })).toThrow(
        /SESSION_SECRET is required in production/u,
      );
    }
  });

  it('keeps the optional secrets optional: absent means sign-in off, not a boot failure', () => {
    // `SESSION_SECRET`/`IP_SALT` are required in production; the OAuth pair is not. A site
    // without sign-in must boot and stay readable (ADR-021: 503 OAUTH_UNCONFIGURED).
    const off = loadConfig({ ...production });
    expect(off.yandexClientId).toBe('');
    expect(off.yandexClientSecret).toBe('');
    expect(yandexConfigured(off)).toBe(false);

    // Half a pair is still off, not a refusal: the operator may add the secret first.
    const halfId = loadConfig({ ...production, YANDEX_CLIENT_ID_FILE: secretFile('client-id') });
    expect(halfId.yandexClientId).toBe('client-id');
    expect(yandexConfigured(halfId)).toBe(false);

    // Both files: sign-in is on, and the values come from the files.
    const on = loadConfig({
      ...production,
      YANDEX_CLIENT_ID_FILE: secretFile('client-id-2'),
      YANDEX_CLIENT_SECRET_FILE: secretFile('client-secret-2'),
    });
    expect(yandexConfigured(on)).toBe(true);

    // The CAPTCHA secret is optional the same way: BOOK-64 ships no challenge, and a
    // half-configured one (a sitekey alone) is refused by the pairing rule, not the file rule.
    expect(() =>
      loadConfig({ ...production, CAPTCHA_SECRET_FILE: undefined, CAPTCHA_SECRET: undefined }),
    ).toThrow(/CAPTCHA_SECRET is missing/u);
    expect(
      loadConfig({
        ...production,
        CAPTCHA_PROVIDER: 'none',
        CAPTCHA_SITE_KEY: undefined,
        CAPTCHA_SECRET_FILE: undefined,
      }).captchaProvider,
    ).toBe('none');
  });

  it('reads a blank *_FILE path as no file, never as a value', () => {
    // The compose template ships `YANDEX_CLIENT_ID_FILE: ""`: a blank path must fall through
    // to the plain variable instead of reaching the filesystem or becoming a secret.
    const off = loadConfig({ ...production, YANDEX_CLIENT_ID_FILE: '   ' });
    expect(off.yandexClientId).toBe('');
    expect(yandexConfigured(off)).toBe(false);

    // With a plain value behind the blank path, production still refuses the value.
    expect(() =>
      loadConfig({ ...production, YANDEX_CLIENT_ID_FILE: '  ', YANDEX_CLIENT_ID: 'plain-id' }),
    ).toThrow(/YANDEX_CLIENT_ID must come from YANDEX_CLIENT_ID_FILE in production/u);

    // A required secret behind a blank path keeps its own, clearer message.
    expect(() => loadConfig({ ...production, SESSION_SECRET_FILE: '\t' })).toThrow(
      /SESSION_SECRET is required in production/u,
    );

    // Outside production a blank path is simply not a file: the plain value is used.
    expect(loadConfig({ IP_SALT_FILE: '\t', IP_SALT: 'inline-salt' }).ipSalt).toBe('inline-salt');
  });

  it('reads NODE_ENV case- and space-insensitively, so `Production` cannot slip past', () => {
    for (const NODE_ENV of ['Production', 'PRODUCTION', ' production ']) {
      expect(() =>
        loadConfig({ ...production, NODE_ENV, SESSION_SECRET_FILE: undefined, SESSION_SECRET: 'plain' }),
      ).toThrow(/SESSION_SECRET must come from SESSION_SECRET_FILE in production/u);
      // The CAPTCHA file rule reads NODE_ENV the same way: a plain secret is refused.
      expect(() => loadConfig({ ...production, NODE_ENV, CAPTCHA_SECRET_FILE: undefined, CAPTCHA_SECRET: 'plain' })).toThrow(
        /CAPTCHA_SECRET must come from CAPTCHA_SECRET_FILE in production/u,
      );
    }
    // Anything that is not production keeps the development shape.
    expect(loadConfig({ NODE_ENV: 'development', IP_SALT: 'dev-salt' }).ipSalt).toBe('dev-salt');
  });

  it('still accepts plain values in development and in tests', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      const config = loadConfig({
        NODE_ENV,
        SESSION_SECRET: 'plain-session',
        IP_SALT: 'plain-salt',
        YANDEX_CLIENT_ID: 'plain-client-id',
        YANDEX_CLIENT_SECRET: 'plain-client-secret',
        CAPTCHA_PROVIDER: 'turnstile',
        CAPTCHA_SITE_KEY: 'plain-site-key',
        CAPTCHA_SECRET: 'plain-captcha-secret',
      });
      expect(config.sessionSecret).toBe('plain-session');
      expect(config.ipSalt).toBe('plain-salt');
      expect(config.yandexClientId).toBe('plain-client-id');
      expect(config.yandexClientSecret).toBe('plain-client-secret');
      expect(config.captchaSecret).toBe('plain-captcha-secret');
    }
  });

  it('keeps a declared file that is missing or empty fatal in every environment', () => {
    for (const { name } of secrets) {
      const absent = absentSecretFile(name);
      for (const NODE_ENV of [undefined, 'development', 'production']) {
        let unreadable = '';
        try {
          loadConfig({ ...production, NODE_ENV, [`${name}_FILE`]: absent });
        } catch (error) {
          unreadable = error instanceof Error ? error.message : String(error);
        }
        expect(unreadable).toMatch(new RegExp(`cannot read ${name}_FILE`, 'u'));
        // A path is not a secret, but the message stays a name: no value, no path.
        expect(unreadable).not.toContain(absent);

        let empty = '';
        try {
          loadConfig({ ...production, NODE_ENV, [`${name}_FILE`]: secretFile('   ') });
        } catch (error) {
          empty = error instanceof Error ? error.message : String(error);
        }
        expect(empty).toMatch(new RegExp(`${name}_FILE is empty`, 'u'));
      }
    }
  });
});
