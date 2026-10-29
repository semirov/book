import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CASCADE_MAX_WAVE } from '@book/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { gateAnnouncement, loadConfig, SITE_ROOT, yandexConfigured, yandexRedirectUri } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { cleanupSecretFiles, production, secretFile } from './configFixture.ts';
import { createFixture } from './helpers.ts';

afterAll(cleanupSecretFiles);

describe('loadConfig', () => {
  it('fills the defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.tz).toBe('Europe/Moscow');
    expect(config.maxWs).toBe(100);
    expect(config.leaseTtlMs).toBe(120_000);
    // BOOK-34: the step wall is the only bound on a step's growth; 45 min, well above the TTL.
    expect(config.stepWallMs).toBe(2_700_000);
    // audit m1: the proxy is one host, not a /24 that lets the LAN forge its address.
    expect(config.trustedProxies).toBe('127.0.0.1,::1,192.168.1.44/32');
    expect(config.readPerMinute).toBe(60);
    // BOOK-59: one wave, and the chapter/step bounds above what one wave costs.
    expect(config.budgetMaxWave).toBe(CASCADE_MAX_WAVE);
    expect(config.budgetMaxChapters).toBe(12);
    expect(config.budgetMaxSteps).toBe(13);
    // A wave is a round of both wings: the shipped lag keeps the far wing in that round.
    expect(config.upwardLagWaves).toBe(0);
    // The folder's *name* is not the invariant: a worktree is a book root too — it is the
    // repository holding this `site/`. What it must hold is the canon, not a text tree: BOOK-187
    // made the rows the home of the text and `manuscript/` is not read at runtime.
    expect(config.bookRoot).toBe(resolve(SITE_ROOT, '..'));
    const canon = ['style/VOICE.md', 'concept/CONCEPT.md', 'concept/CLIMAX.md', 'process/ROLE_PROMPTS.md'];
    for (const file of canon) expect(existsSync(join(config.bookRoot, file)), file).toBe(true);
    expect(existsSync(join(SITE_ROOT, 'config', 'pipeline.json'))).toBe(true);
    expect(config.imprintPath.endsWith('config/imprint.json')).toBe(true);
    // ADR-038 §1 and BOOK-117: the pipeline pin and the two money caps, read at boot from one place.
    expect(config.pipelinePath.endsWith('config/pipeline.json')).toBe(true);
    expect(config.pipeline.model).toBe('deepseek/deepseek-v4-pro');
    expect(config.pipeline.pricing.input).toBe(0.66);
    expect([config.budgetDayUsd, config.budgetBookUsd]).toEqual([10, 1_000]);
  });

  it('reads the money caps from the environment and refuses a value that is not a price (BOOK-117)', () => {
    const config = loadConfig({ BOOK_BUDGET_DAY_USD: '2.5', BOOK_BUDGET_BOOK_USD: '400' });
    expect(config.budgetDayUsd).toBe(2.5);
    expect(config.budgetBookUsd).toBe(400);
    // A cap is a bound: zero, a negative, a word, a comma decimal and an exponent all fail the
    // boot and name the variable — never a silent fallback to the default.
    for (const bad of ['0', '-1', 'ten', '1,5', '1e3']) {
      expect(() => loadConfig({ BOOK_BUDGET_DAY_USD: bad }), bad).toThrow(/invalid configuration: BOOK_BUDGET_DAY_USD must be a positive decimal/u);
    }
    expect(() => loadConfig({ BOOK_BUDGET_BOOK_USD: 'lots' })).toThrow(
      /invalid configuration: BOOK_BUDGET_BOOK_USD must be a positive decimal/u,
    );
  });

  it('fails the boot with the pipeline’s own message when the pin cannot be loaded (ADR-038)', () => {
    expect(() => loadConfig({ PIPELINE_PATH: '/nonexistent/pipeline.json' })).toThrow(
      /^pipeline: cannot read the file at \/nonexistent\/pipeline\.json$/u,
    );
  });

  it('lets a ripple of its full width finish inside the chapter and step bounds (BOOK-DOC-4 rule 3)', () => {
    // A ripple bounded by W waves is 2W steps over 2W chapters (both wings per wave), and the
    // front and ending proofs add at most two more steps. A chapter or step bound under that
    // would bind first and leave the wave bound dead config (audit R3).
    const config = loadConfig({});
    const waves = config.budgetMaxWave;
    expect(config.budgetMaxSteps).toBeGreaterThanOrEqual(2 * waves + 2);
    expect(config.budgetMaxChapters).toBeGreaterThanOrEqual(2 * waves);
    expect(config.budgetMaxWave).toBe(CASCADE_MAX_WAVE);
  });

  it('refuses an env whose wave bound disagrees with the public promise (BOOK-DOC-4 rule 3)', () => {
    // A deployment copied from the old example says 5: booting it would tell the client 5
    // while /rules promises one wave, which is exactly the silent divergence the rule forbids.
    let message = '';
    try {
      loadConfig({ BUDGET_MAX_WAVE: '3', BUDGET_MAX_CHAPTERS: '5', BUDGET_MAX_STEPS: '8' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/BUDGET_MAX_WAVE must equal CASCADE_MAX_WAVE \(1\)/u);
    expect(message).toMatch(/public promise/u);
  });

  it('refuses an upward lag that fills the whole wave bound (BOOK-59)', () => {
    // With one wave, a lag of one would keep the upward wing out of every wave any ripple has,
    // so the page's «вперёд и назад» would be false. The old shipped lag of one now fails.
    expect(() => loadConfig({ BUDGET_UPWARD_LAG_WAVES: '1' })).toThrow(
      /BUDGET_UPWARD_LAG_WAVES must be below BUDGET_MAX_WAVE \(1\)/u,
    );
    expect(loadConfig({ BUDGET_UPWARD_LAG_WAVES: '0' }).upwardLagWaves).toBe(0);
  });

  it('accepts a restated wave bound and the shipped chapter/step bounds', () => {
    // Restating the constant is a no-op, not a divergence: it still boots.
    const config = loadConfig({ BUDGET_MAX_WAVE: String(CASCADE_MAX_WAVE) });
    expect(config.budgetMaxWave).toBe(CASCADE_MAX_WAVE);
    expect(loadConfig({}).budgetMaxChapters).toBeGreaterThanOrEqual(2 * CASCADE_MAX_WAVE);
  });

  it('refuses chapter or step bounds that would bind before the wave bound', () => {
    expect(() => loadConfig({ BUDGET_MAX_CHAPTERS: '1' })).toThrow(
      /BUDGET_MAX_CHAPTERS must be at least 2 × BUDGET_MAX_WAVE \(2\)/u,
    );
    expect(() => loadConfig({ BUDGET_MAX_STEPS: '3' })).toThrow(
      /BUDGET_MAX_STEPS must be at least 2 × BUDGET_MAX_WAVE \+ 2 \(4\)/u,
    );
  });

  it('refuses a step wall below the lease TTL (BOOK-34)', () => {
    // The engine beats a step's lease itself; a wall below the TTL would stop the step
    // before its lease is even stale, so the wall may not sit under the TTL (equality is fine).
    expect(() => loadConfig({ STEP_WALL_MS: '60000', LEASE_TTL_MS: '120000' })).toThrow(
      /STEP_WALL_MS must be at least LEASE_TTL_MS \(120000\)/u,
    );
    expect(loadConfig({ STEP_WALL_MS: '120000', LEASE_TTL_MS: '120000' }).stepWallMs).toBe(120_000);
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

  it('refuses a half-configured challenge: a sitekey without a secret, or the reverse', () => {
    // BOOK-64: a lone sitekey renders a widget nothing can verify; a lone secret configures a
    // verifier no reader can reach. Both fail loudly, whatever the provider says.
    expect(() => loadConfig({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SECRET: 'secret' })).toThrow(
      /CAPTCHA_SITE_KEY is missing/u,
    );
    expect(() =>
      loadConfig({ CAPTCHA_PROVIDER: 'hcaptcha', CAPTCHA_SECRET: 'secret', CAPTCHA_SITE_KEY: '   ' }),
    ).toThrow(/CAPTCHA_SITE_KEY is missing/u);
    // `none` needs no key, and a stray key with it is still half a captcha.
    expect(loadConfig({ CAPTCHA_PROVIDER: 'none' }).captchaSiteKey).toBe('');
    expect(() => loadConfig({ CAPTCHA_PROVIDER: 'none', CAPTCHA_SITE_KEY: 'key' })).toThrow(
      /CAPTCHA_SECRET is missing/u,
    );
  });

  it('refuses a provider with no secret, and boots production with the `none` default (BOOK-64)', () => {
    expect(() => loadConfig({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: 'key' })).toThrow(
      /CAPTCHA_SECRET is missing/u,
    );
    // The owner's decision (2026-10-27): the gate is identity plus the rate limits, so
    // production may run without a challenge at all — and says which gate is in force.
    const config = loadConfig({
      ...production,
      CAPTCHA_PROVIDER: 'none',
      CAPTCHA_SITE_KEY: '',
      CAPTCHA_SECRET_FILE: '',
    });
    expect(config.captchaProvider).toBe('none');
    expect(gateAnnouncement(config)).toBe('gate: identity + rate limits (no captcha)');
    expect(gateAnnouncement(config)?.split('\n')).toHaveLength(1);
    expect(gateAnnouncement(loadConfig(production))).toBeNull();
    // The boot prints it: index.ts is the only place a real boot can say it.
    const boot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(boot).toContain('gateAnnouncement(config)');
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
        loadConfig({ ...production, CAPTCHA_SECRET_FILE: secretFile(secret) });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/CAPTCHA_SECRET is a published test key/u);
      expect(message).not.toContain(secret);
    }

    // Both halves published: the secret is the fatal one, whatever the sitekey — and the
    // sitekey opt-in does not lift it (requirement: a published secret is fatal everywhere).
    const publishedSitekey = '1x00000000000000000000AA';
    const publishedSecret = '1x0000000000000000000000000000000AA';
    const publishedPair = {
      ...production,
      CAPTCHA_SITE_KEY: publishedSitekey,
      CAPTCHA_SECRET_FILE: secretFile(publishedSecret),
      CAPTCHA_ALLOW_TEST_SITE_KEY: '1',
    };
    let both = '';
    try {
      loadConfig(publishedPair);
    } catch (error) {
      both = error instanceof Error ? error.message : String(error);
    }
    expect(both).toMatch(/CAPTCHA_SECRET is a published test key/u);
    expect(both).not.toContain(publishedSitekey);
    expect(both).not.toContain(publishedSecret);

    // A normal key pair boots; the published test pair is the only thing refused.
    const config = loadConfig({
      ...production,
      CAPTCHA_SECRET_FILE: secretFile('0x4f3a-real-secret'),
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
        CAPTCHA_SECRET_FILE: secretFile(secret),
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
        CAPTCHA_SECRET_FILE: secretFile(secret),
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
    // No file and no value: the ephemeral per-boot secret is the production failure.
    expect(() => loadConfig({ ...production, SESSION_SECRET_FILE: undefined })).toThrow(
      /SESSION_SECRET is required in production/u,
    );
    expect(() => loadConfig({ ...production, SESSION_SECRET_FILE: undefined, SESSION_SECRET: '' })).toThrow(
      /SESSION_SECRET is required in production/u,
    );
  });

  it('refuses an empty IP salt in production', () => {
    expect(() => loadConfig({ ...production, IP_SALT_FILE: undefined })).toThrow(
      /IP_SALT is required in production/u,
    );
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
