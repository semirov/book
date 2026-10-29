/**
 * ARCHITECTURE.md invariant 30: a secret comes from its `*_FILE` mount, never from an
 * environment value. Production refuses a plain value at boot; development and tests keep
 * accepting it (there is no opt-out), and a declared file that is missing or empty is fatal
 * everywhere. BOOK-205: the two sign-in files are the exception — compose always declares those
 * mounts, so an absent one means "sign-in off" with one warning, never a failed boot.
 * Every message names the variable and never the value or the path.
 */

import { chmodSync } from 'node:fs';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadConfig, yandexConfigured } from '../src/config.ts';
import { absentSecretFile, cleanupSecretFiles, production, secretDirectory, secretFile } from './configFixture.ts';

afterAll(cleanupSecretFiles);

// The five secrets invariant 30 covers, and the config field each one lands in.
const secrets = [
  { name: 'SESSION_SECRET', key: 'sessionSecret' },
  { name: 'IP_SALT', key: 'ipSalt' },
  { name: 'YANDEX_CLIENT_ID', key: 'yandexClientId' },
  { name: 'YANDEX_CLIENT_SECRET', key: 'yandexClientSecret' },
  { name: 'CAPTCHA_SECRET', key: 'captchaSecret' },
] as const;

// BOOK-205: the three whose absence is a boot failure. The sign-in pair is optional (ADR-021) and
// has its own cases below.
const requiredSecrets = secrets.filter((secret) => !secret.name.startsWith('YANDEX_'));

/** `console.warn` collected around a boot, so "one warning, name only" is a real assertion. */
function boot(run: () => ReturnType<typeof loadConfig>): { config: ReturnType<typeof loadConfig>; warnings: string[] } {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return { config: run(), warnings: spy.mock.calls.map((call) => call.join(' ')) };
  } finally {
    spy.mockRestore();
  }
}

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

  it('keeps a declared required file that is missing or empty fatal in every environment', () => {
    for (const { name } of requiredSecrets) {
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

  it('reads a declared *missing* sign-in mount as sign-in off, with one warning that names the variable', () => {
    // BOOK-205: compose cannot make a mount conditional, so the site always declares these two and a
    // host without them mounts nothing usable. That is the shipped prod shape that answered 503 with
    // a boot that never said why — the warning is the whole point.
    const absent = absentSecretFile('YANDEX_CLIENT_ID');
    const { config, warnings } = boot(() => loadConfig({ ...production, YANDEX_CLIENT_ID_FILE: absent }));
    expect(config.yandexClientId).toBe('');
    expect(config.yandexClientSecret).toBe('');
    expect(yandexConfigured(config)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/YANDEX_CLIENT_ID_FILE/u);
    expect(warnings[0]).toMatch(/sign-in is off/u);
    // The warning is a name and a consequence: no value, no path, no errno.
    expect(warnings[0]).not.toContain(absent);
  });

  it('reads a *directory* at a declared sign-in mount as sign-in off (Docker mounts one when the host file is absent)', () => {
    const dir = secretDirectory('YANDEX_CLIENT_ID');
    const { config, warnings } = boot(() => loadConfig({ ...production, YANDEX_CLIENT_ID_FILE: dir }));
    expect(config.yandexClientId).toBe('');
    expect(yandexConfigured(config)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/YANDEX_CLIENT_ID_FILE/u);
    expect(warnings[0]).not.toContain(dir);

    // The secret half is the same rule, and an empty file is the same "nothing there".
    const both = boot(() =>
      loadConfig({
        ...production,
        YANDEX_CLIENT_ID_FILE: secretFile('client-id'),
        YANDEX_CLIENT_SECRET_FILE: secretFile('   '),
      }),
    );
    expect(both.config.yandexClientId).toBe('client-id');
    expect(both.config.yandexClientSecret).toBe('');
    expect(yandexConfigured(both.config)).toBe(false);
    expect(both.warnings).toHaveLength(1);
    expect(both.warnings[0]).toMatch(/YANDEX_CLIENT_SECRET_FILE/u);
    expect(both.warnings[0]).toMatch(/sign-in is off/u);
  });

  it('reads an *unreadable* sign-in file as sign-in off (a permissions accident must not keep the book down)', () => {
    // A declared mount whose file the container's uid cannot open is the same "no credential" as an
    // absent one; only a required name may fail a boot over it. Root reads everything, so the shape
    // cannot be made under it.
    if (process.getuid?.() === 0) return;
    const path = secretFile('client-id-under-a-lock');
    chmodSync(path, 0o000);
    const { config, warnings } = boot(() => loadConfig({ ...production, YANDEX_CLIENT_ID_FILE: path }));
    expect(config.yandexClientId).toBe('');
    expect(yandexConfigured(config)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/YANDEX_CLIENT_ID_FILE/u);
  });

  it('prints one warning per missing file: the shipped no-OAuth shape says two', () => {
    // ADR-021's prod shape: both mounts are there, both are empty directories. One line per name, so
    // the operator reading the boot log sees exactly which file is missing and what it costs.
    const { config, warnings } = boot(() =>
      loadConfig({
        ...production,
        YANDEX_CLIENT_ID_FILE: secretDirectory('YANDEX_CLIENT_ID'),
        YANDEX_CLIENT_SECRET_FILE: secretDirectory('YANDEX_CLIENT_SECRET'),
      }),
    );
    expect(config.yandexClientId).toBe('');
    expect(config.yandexClientSecret).toBe('');
    expect(yandexConfigured(config)).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/YANDEX_CLIENT_ID_FILE/u);
    expect(warnings.join('\n')).toMatch(/YANDEX_CLIENT_SECRET_FILE/u);
    expect(warnings.every((line) => /sign-in is off/u.test(line))).toBe(true);
  });

  it('keeps a REQUIRED name pointing at a directory fatal (the isFile() branch)', () => {
    // The new "a directory is not a file" check must not soften a required secret: Docker would mount
    // an empty directory for an absent session secret too, and the boot still has to refuse.
    for (const name of ['SESSION_SECRET', 'IP_SALT', 'CAPTCHA_SECRET']) {
      for (const NODE_ENV of [undefined, 'production']) {
        expect(() => loadConfig({ ...production, NODE_ENV, [`${name}_FILE`]: secretDirectory(name) })).toThrow(
          new RegExp(`cannot read ${name}_FILE`, 'u'),
        );
      }
    }
  });

  it('keeps the optional rule inside production: a plain sign-in value is still refused, not warned away', () => {
    // Invariant 30 has no optional half: whatever the deployment shape, a value in the environment
    // is a boot failure for all five names, sign-in included.
    for (const name of ['YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET']) {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() =>
          loadConfig({ ...production, [`${name}_FILE`]: undefined, [name]: 'plain-value' }),
        ).toThrow(new RegExp(`${name} must come from ${name}_FILE in production`, 'u'));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  });
});
