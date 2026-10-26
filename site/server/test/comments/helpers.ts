import type { FastifyInstance } from 'fastify';

import type { CaptchaVerdict, CaptchaVerifier } from '../../src/captcha/verify.ts';
import type { OAuthFetch } from '../../src/identity/yandex.ts';
import { buildApp } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import type { Db } from '../../src/db/db.ts';
import { upsertIdentity, type IdentityRow } from '../../src/db/repo/identities.ts';
import { SessionStore, SESSION_COOKIE } from '../../src/identity/session.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { RateLimiter } from '../../src/rate/limiter.ts';
import { createIpHasher } from '../../src/util/ipHash.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';

/**
 * The M5 acceptance harness: a real database, a real app, a real session — and **stubbed
 * CAPTCHA and IdP**, because no production credential exists in a test (and should not).
 */

export const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
export const ORIGIN = 'https://book.test';

export type Clock = { ms: number; now: () => Date; advance: (ms: number) => void };

export function makeClock(start = T0): Clock {
  const clock: Clock = {
    ms: start,
    now: () => new Date(clock.ms),
    advance: (ms: number) => {
      clock.ms += ms;
    },
  };
  return clock;
}

export type CaptchaMode = 'ok' | 'fail' | 'unavailable';

export type CaptchaStub = {
  verifier: CaptchaVerifier;
  calls: Array<{ token: string | undefined; ip: string | undefined }>;
  mode: CaptchaMode;
};

export function captchaStub(mode: CaptchaMode = 'ok'): CaptchaStub {
  const stub: CaptchaStub = {
    mode,
    calls: [],
    verifier: async (token, context = {}): Promise<CaptchaVerdict> => {
      stub.calls.push({ token, ip: context.ip });
      if (stub.mode === 'unavailable') {
        return { ok: false, code: 'CAPTCHA_UNAVAILABLE', message: 'приём замечаний приостановлен · проверка недоступна', detail: 'test' };
      }
      if (stub.mode === 'fail' || token === undefined || token.length === 0) {
        return { ok: false, code: 'CAPTCHA_FAILED', message: 'проверка не пройдена — попробуйте ещё раз', detail: 'test' };
      }
      return { ok: true, band: 'ok' };
    },
  };
  return stub;
}

export type Harness = {
  fixture: Fixture;
  app: FastifyInstance;
  db: Db;
  config: Config;
  clock: Clock;
  captcha: CaptchaStub;
  limiter: RateLimiter;
  sessions: SessionStore;
  identity: IdentityRow;
  cookie: string;
  authCookie: () => string;
  sessionCookieHeader: string;
  headers: (overrides?: Record<string, string>) => Record<string, string>;
  emitted: Array<{ type: string; data: unknown }>;
  close: () => Promise<void>;
};

export async function bootComments(options: {
  chapters?: Record<string, string>;
  captchaMode?: CaptchaMode;
  /** A verifier with its own timing (concurrency tests release both calls at once). */
  captcha?: CaptchaVerifier;
  /** Captures the JSON log lines so a test can assert what is *not* logged. */
  logStream?: { write(line: string): void };
  now?: Clock;
  publicOrigin?: string;
  /** `false` shapes a deployment where the owner has not registered the OAuth app yet. */
  yandexConfigured?: boolean;
  oauthFetch?: OAuthFetch;
} = {}): Promise<Harness> {
  const fixture = createFixture(
    options.chapters ?? {
      'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.', 'Тестовый абзац номер два. Это служебный текст.']),
    },
  );
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

  const clock = options.now ?? makeClock();
  const config = loadConfig({
    BOOK_ROOT: fixture.root,
    DATA_DIR: fixture.dataDir,
    WEB_DIST: fixture.dataDir,
    PUBLIC_ORIGIN: options.publicOrigin ?? ORIGIN,
    // A provider is configured so the verifier is a real decision; it is still stubbed.
    CAPTCHA_PROVIDER: 'turnstile',
    CAPTCHA_SECRET: 'test-captcha-secret',
    CAPTCHA_SITE_KEY: 'test-site-key',
    YANDEX_CLIENT_ID: options.yandexConfigured === false ? '' : 'test-client',
    YANDEX_CLIENT_SECRET: options.yandexConfigured === false ? '' : 'test-secret',
    YANDEX_REDIRECT_URI: `${options.publicOrigin ?? ORIGIN}/auth/yandex/callback`,
    YANDEX_AUTHORIZE_URL: 'https://idp.test/authorize',
    YANDEX_TOKEN_URL: 'https://idp.test/token',
    YANDEX_INFO_URL: 'https://idp.test/info',
  });

  const captcha = captchaStub(options.captchaMode ?? 'ok');
  const verifier = options.captcha ?? captcha.verifier;
  const limiter = new RateLimiter(fixture.db, () => clock.ms);
  const ipHash = createIpHasher('test-ip-salt');
  const sessions = new SessionStore({
    db: fixture.db,
    ttlMs: config.sessionTtlMs,
    secure: true,
    now: clock.now,
    ipHash,
  });
  const identity = upsertIdentity(fixture.db, {
    yandexSub: 'yandex-1001',
    displayName: 'Аня',
    at: clock.now().toISOString(),
  });
  const session = sessions.issue(identity.id, { ipKey: '127.0.0.1' });
  const emitted: Array<{ type: string; data: unknown }> = [];
  // Request logging is off in tests unless one is asserting on the log lines themselves.
  const logStream = options.logStream;

  const app = await buildApp({
    config,
    db: fixture.db,
    state: new StateService(fixture.db, clock.now),
    version: 'test',
    logger: logStream === undefined ? false : true,
    ...(logStream === undefined ? {} : { logStream }),
    captcha: verifier,
    limiter,
    sessions,
    sessionSecret: 'test-session-secret',
    ipHash,
    now: clock.now,
    emit: (type, data) => emitted.push({ type, data }),
    oauthFetch:
      options.oauthFetch ??
      (async () => {
        throw new Error('oauth fetch is not stubbed in this harness');
      }),
  });
  await app.ready();

  const cookieHeader = (): string => `${SESSION_COOKIE}=${session.cookie}`;

  return {
    fixture,
    app,
    db: fixture.db,
    config,
    clock,
    captcha,
    limiter,
    sessions,
    identity,
    cookie: session.cookie,
    authCookie: cookieHeader,
    sessionCookieHeader: cookieHeader(),
    headers: (overrides = {}) => ({
      origin: options.publicOrigin ?? ORIGIN,
      'content-type': 'application/json',
      cookie: cookieHeader(),
      ...overrides,
    }),
    emitted,
    close: async () => {
      await app.close();
      fixture.close();
    },
  };
}

export type CommentBody = {
  chapter: number;
  body: string;
  captchaToken?: string;
  blockId?: string;
  quote?: string;
  baseRev?: number;
  proposedText?: string;
  idempotencyKey?: string;
};

export function commentBody(overrides: Partial<CommentBody> = {}): CommentBody {
  return {
    chapter: 8,
    body: 'Тут «слово» и «словосочетание» рядом — второй раз за главу.',
    captchaToken: 'valid-token',
    ...overrides,
  };
}
