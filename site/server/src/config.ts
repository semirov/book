/**
 * Config (ARCHITECTURE.md §21.2). Parsed once at boot, fail-fast, never a secret value in
 * an error message: every secret is resolved from `${NAME}_FILE` (a `0600` mount) or from
 * the plain variable, and the checks below refuse a shape that would degrade silently.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { CASCADE_MAX_WAVE, isPublishedCaptchaTestKey } from '@book/shared';

/** `site/` — works from `server/src` (tsx) and from `server/dist` (node). */
export const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const schema = z.object({
  bookRoot: z.string().default(resolve(SITE_ROOT, '..')),
  dataDir: z.string().default(resolve(SITE_ROOT, '.data')),
  /**
   * The built SPA. `@fastify/static` requires an absolute root, so a relative value (the
   * compose file's `./web/dist`) is resolved against `site/` — an absolute value is kept
   * as it is. The default is already absolute.
   */
  webDist: z
    .string()
    .default(resolve(SITE_ROOT, 'web', 'dist'))
    .transform((value) => resolve(SITE_ROOT, value)),
  /** The read-only imprint config (§6C.6); F020 and the boot both validate it. */
  imprintPath: z.string().default(resolve(SITE_ROOT, 'config', 'imprint.json')),
  /** The hand-curated legal denylist (§13.4, F005); read, never refreshed from the book. */
  denylistPath: z.string().default(resolve(SITE_ROOT, 'config', 'legal.denylist.json')),
  /** The admin surface (`/api/admin/*`) is token-guarded; empty means it does not exist. */
  adminTokenFile: z.string().default(resolve(SITE_ROOT, '.data', 'admin.token')),
  adminToken: z.string().default(''),
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  /** The engine's internal API (no public port, §4.2); loopback only by default. */
  engineHost: z.string().default('127.0.0.1'),
  enginePort: z.coerce.number().int().min(1).max(65535).default(8081),
  publicOrigin: z.string().default('https://book.semirov.dev'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Display timezone for chapter meta and the ledger (§DESIGN 4.3). */
  tz: z.string().default('Europe/Moscow'),
  // Reserved budgets — read by M3 (the engine); defined now so the config is complete.
  maxWs: z.coerce.number().int().min(1).default(100),
  /** Soft per-IP socket cap; the oldest connection of that IP is closed on overflow (§10.1). */
  wsPerIp: z.coerce.number().int().min(1).default(4),
  /** Protocol ping interval; two missed pongs terminate a socket (§10.1). */
  wsHeartbeatMs: z.coerce.number().int().min(1_000).default(30_000),
  /**
   * `X-Forwarded-For` is believed only from these peers (§14). Caddy is one host, so the
   * proxy is a single address, never a whole subnet: a /24 would let every machine on the
   * LAN name its own address to the per-IP limits (audit m1).
   */
  trustedProxies: z.string().default('127.0.0.1,::1,192.168.1.44/32'),
  /** Per-IP budget for the read API (`/api/history`, `/api/state`, `/api/changes`). */
  readPerMinute: z.coerce.number().int().min(1).default(60),
  commentsPerHour: z.coerce.number().int().min(1).default(10),
  /** Anti-farming limit on the identity, the same number as the SPEC's per-IP limit (§14). */
  commentsPerHourIdentity: z.coerce.number().int().min(1).default(10),
  /**
   * §14 + SPEC «Load & network»: one reader edit per day, per identity **and** per network.
   * The same number feeds both keys (`edit:id:` and `edit:ip:`), so a household behind one
   * address spends one edit a day in total (BOOK-DOC-4 rule 5, accepted trade-off).
   */
  editSubmissionsPerDay: z.coerce.number().int().min(1).default(1),
  queueSoftCap: z.coerce.number().int().min(1).default(15),
  /** The file exchange with triage (§12.2, §12.6): batches and `decisions.jsonl`. */
  feedbackDir: z.string().default(resolve(SITE_ROOT, 'data', 'feedback')),
  // ── identity (ADR-021) ── placeholders until the owner registers the OAuth app ──
  yandexClientId: z.string().default(''),
  yandexClientSecret: z.string().default(''),
  /** Defaults to `${publicOrigin}/auth/yandex/callback` when empty. */
  yandexRedirectUri: z.string().default(''),
  yandexAuthorizeUrl: z.string().default('https://oauth.yandex.ru/authorize'),
  yandexTokenUrl: z.string().default('https://oauth.yandex.ru/token'),
  yandexInfoUrl: z.string().default('https://login.yandex.ru/info?format=json'),
  oauthStartPerHour: z.coerce.number().int().min(1).default(10),
  oauthStateTtlMs: z.coerce.number().int().min(10_000).default(600_000),
  sessionTtlMs: z.coerce.number().int().min(60_000).default(30 * 24 * 60 * 60 * 1000),
  /** Signs the OAuth `state`; empty means an ephemeral per-boot secret (tests, local dev). */
  sessionSecret: z.string().default(''),
  /** Salt for the persisted IP hash; empty means an ephemeral per-boot salt. */
  ipSalt: z.string().default(''),
  // ── CAPTCHA (§12.8) ──
  captchaProvider: z.enum(['turnstile', 'hcaptcha', 'none']).default('none'),
  captchaSiteKey: z.string().default(''),
  captchaSecret: z.string().default(''),
  /**
   * Prod-only opt-in for a vendor's published test sitekey (audit B1 follow-up). `0` keeps the
   * boot refusal; `1` lets a live deployment start with such a key, warns once, and leaves the
   * comment path closed (the real secret fails siteverify). A published test *secret* stays
   * fatal in every environment. Values are strings like every other enum in this schema, so a
   * typo (`true`) fails the parse instead of silently enabling the opt-in.
   */
  captchaAllowTestSiteKey: z.enum(['0', '1']).default('0'),
  captchaTimeoutMs: z.coerce.number().int().min(500).max(10_000).default(3_000),
  /** Empty = no script, no third-party origin in the CSP (§15.6). */
  metrikaId: z.string().default(''),
  /**
   * Cascade bounds (§6A.6, frozen per cascade at open). The wave bound is the *public
   * promise* of BOOK-DOC-4 rule 3 (`CASCADE_MAX_WAVE`), not a knob: `superRefine` below lets
   * an env restate it and refuses any other value. One wave is one step per wing, the upward
   * wing starts a wave behind, so a ripple bounded by W waves is 1 + W down + (W−1) up = 2W
   * steps over 2W chapters, reaching −W / +(W−1) from the origin; the front and ending proofs
   * add at most two more steps. The shipped chapter and step bounds sit above that on
   * purpose: a bound that bound first would make the wave bound dead config (audit R3).
   */
  budgetMaxWave: z.coerce.number().int().min(1).default(CASCADE_MAX_WAVE),
  budgetMaxChapters: z.coerce.number().int().min(1).default(12),
  budgetMaxSteps: z.coerce.number().int().min(1).default(13),
  /**
   * The wall is the operative bound for a full ripple: 11–13 model runs can exceed 30 minutes
   * on a slow model, and that stop is an honest escalation (`escalated:budget` with the time
   * reason), not a failed promise — the NFR hard bound stays 30 min (BOOK-DOC-4 rule 3).
   */
  budgetMaxWallMs: z.coerce.number().int().min(1).default(1_800_000),
  budgetMaxTokens: z.coerce.number().int().min(1).default(1_500_000),
  budgetDailyTokens: z.coerce.number().int().min(1).default(24_000_000),
  maxRewritesPerChapter: z.coerce.number().int().min(1).default(1),
  upwardLagWaves: z.coerce.number().int().min(0).default(1),
  /** A repair may replace at most this share of its chapter (§6A.6 MAX_DELTA_RATIO). */
  maxDeltaRatio: z.coerce.number().min(0).max(1).default(0.35),
  /** Writer revisions per step before the text is published with its finding (§6B.4). */
  gateCycles: z.coerce.number().int().min(1).default(3),
  gateTtlMs: z.coerce.number().int().min(1).default(300_000),
  leaseTtlMs: z.coerce.number().int().min(1).default(120_000),
  /** A lane whose holder stopped beating is reclaimed after this long (§6A.3). */
  laneTtlMs: z.coerce.number().int().min(1).default(90_000),
  reaperMs: z.coerce.number().int().min(100).default(15_000),
  maxConcurrentSteps: z.coerce.number().int().min(1).max(5).default(2),
  maxConcurrentProcesses: z.coerce.number().int().min(1).max(10).default(6),
  /** The engine's internal API is loopback/compose only; the token is read from a file. */
  engineTokenFile: z.string().default(resolve(SITE_ROOT, '.data', 'engine.token')),
  /** Test/CLI convenience only: an inline token never belongs in a deployed environment. */
  engineToken: z.string().default(''),
  watchPollMs: z.coerce.number().int().min(50).default(700),
  /** Collapses a truncate-then-write burst into one revision (§6.2). */
  watchCoalesceMs: z.coerce.number().int().min(0).default(1_500),
  /** How long an empty write waits for its follow-up before the old revision is kept (§6.2). */
  emptyWriteGraceMs: z.coerce.number().int().min(0).default(5_000),
  /**
   * The owner's writing switch (§6A.9, BOOK-6): while it is `off` the engine hands out no
   * writer assignment at all, so an empty book cannot start a pass by itself. `on` is the
   * owner saying «пиши».
   */
  drafting: z.enum(['on', 'off']).default('off'),
}).superRefine((config, ctx) => {
  // BOOK-DOC-4 rule 3 is a public promise, so the wave bound is authoritative in code, not in
  // an env file: an old deployment that still says 3 must fail the boot, never tell the client
  // 3 while /rules promises 5. The message names the variable and the constant.
  if (config.budgetMaxWave !== CASCADE_MAX_WAVE) {
    ctx.addIssue({
      code: 'custom',
      path: ['budgetMaxWave'],
      message:
        `BUDGET_MAX_WAVE must equal CASCADE_MAX_WAVE (${String(CASCADE_MAX_WAVE)}): ` +
        'the wave bound is the public promise of BOOK-DOC-4 rule 3, not a knob',
    });
  }
  // The chapter and step bounds must not bind before the wave bound, or a five-wave ripple is
  // unreachable and the wave bound is dead config (audit R3). A ripple bounded by W waves is
  // 1 + W down + (W−1) up = 2W steps over 2W chapters, and the front and ending proofs add at
  // most two more steps.
  if (config.budgetMaxSteps < 2 * config.budgetMaxWave + 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['budgetMaxSteps'],
      message:
        `BUDGET_MAX_STEPS must be at least 2 × BUDGET_MAX_WAVE + 2 (${String(2 * config.budgetMaxWave + 2)}) ` +
        'so the chapter/step bound cannot bind before the wave bound',
    });
  }
  if (config.budgetMaxChapters < 2 * config.budgetMaxWave) {
    ctx.addIssue({
      code: 'custom',
      path: ['budgetMaxChapters'],
      message:
        `BUDGET_MAX_CHAPTERS must be at least 2 × BUDGET_MAX_WAVE (${String(2 * config.budgetMaxWave)}) ` +
        'so the chapter bound cannot bind before the wave bound',
    });
  }
});

export type Config = z.infer<typeof schema>;

/**
 * Secrets that accept a file mount (§21.2). `ADMIN_TOKEN`/`ENGINE_TOKEN` are absent on
 * purpose: their `*_FILE` contract is already implemented next to them (`readAdminToken`,
 * the engine mints its token on a local first boot), and a missing optional panel token
 * must keep disabling the panel instead of failing the whole boot.
 */
type MountedSecret =
  | 'SESSION_SECRET'
  | 'IP_SALT'
  | 'YANDEX_CLIENT_ID'
  | 'YANDEX_CLIENT_SECRET'
  | 'CAPTCHA_SECRET';

/**
 * A mounted file wins over the plain variable: deployment keeps `0600` files, tests and
 * local development keep the variable. A declared file that is missing, unreadable or
 * empty is a boot failure — never a silent "no session secret, no CAPTCHA secret". The
 * message carries the variable name only.
 */
function readMountedSecret(env: NodeJS.ProcessEnv, name: MountedSecret): string | undefined {
  const file = env[`${name}_FILE`];
  if (file === undefined || file.trim().length === 0) return env[name];
  let value: string;
  try {
    value = readFileSync(file.trim(), 'utf8').trim();
  } catch {
    throw new Error(`invalid configuration: cannot read ${name}_FILE`);
  }
  if (value.length === 0) throw new Error(`invalid configuration: ${name}_FILE is empty`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    bookRoot: env.BOOK_ROOT,
    dataDir: env.DATA_DIR,
    webDist: env.WEB_DIST,
    imprintPath: env.IMPRINT_PATH,
    denylistPath: env.DENYLIST_PATH,
    adminTokenFile: env.ADMIN_TOKEN_FILE,
    adminToken: env.ADMIN_TOKEN,
    host: env.HOST,
    port: env.PORT,
    engineHost: env.ENGINE_HOST ?? env.HOST,
    enginePort: env.ENGINE_PORT ?? (env.PORT === undefined ? undefined : env.PORT),
    publicOrigin: env.PUBLIC_ORIGIN,
    logLevel: env.LOG_LEVEL,
    tz: env.BOOK_TZ,
    maxWs: env.MAX_WS,
    wsPerIp: env.WS_PER_IP,
    wsHeartbeatMs: env.WS_HEARTBEAT_MS,
    trustedProxies: env.TRUSTED_PROXIES,
    readPerMinute: env.READ_PER_MINUTE,
    commentsPerHour: env.COMMENTS_PER_HOUR_IP ?? env.COMMENTS_PER_HOUR,
    commentsPerHourIdentity: env.COMMENTS_PER_HOUR_IDENTITY,
    editSubmissionsPerDay: env.EDIT_SUBMISSIONS_PER_DAY,
    queueSoftCap: env.QUEUE_SOFT_CAP,
    feedbackDir: env.FEEDBACK_DIR ?? (env.EXCHANGE_DIR === undefined ? undefined : resolve(env.EXCHANGE_DIR, 'feedback')),
    yandexClientId: readMountedSecret(env, 'YANDEX_CLIENT_ID'),
    yandexClientSecret: readMountedSecret(env, 'YANDEX_CLIENT_SECRET'),
    yandexRedirectUri: env.YANDEX_REDIRECT_URI ?? env.OAUTH_REDIRECT_URI,
    yandexAuthorizeUrl: env.YANDEX_AUTHORIZE_URL,
    yandexTokenUrl: env.YANDEX_TOKEN_URL,
    yandexInfoUrl: env.YANDEX_INFO_URL,
    oauthStartPerHour: env.OAUTH_START_PER_HOUR,
    oauthStateTtlMs: env.OAUTH_STATE_TTL_MS,
    sessionTtlMs: env.SESSION_TTL_MS,
    sessionSecret: readMountedSecret(env, 'SESSION_SECRET'),
    ipSalt: readMountedSecret(env, 'IP_SALT'),
    captchaProvider: env.CAPTCHA_PROVIDER,
    captchaSiteKey: env.CAPTCHA_SITE_KEY,
    captchaSecret: readMountedSecret(env, 'CAPTCHA_SECRET'),
    captchaAllowTestSiteKey: env.CAPTCHA_ALLOW_TEST_SITE_KEY,
    captchaTimeoutMs: env.CAPTCHA_TIMEOUT_MS,
    metrikaId: env.METRIKA_ID,
    budgetMaxWave: env.BUDGET_MAX_WAVE,
    budgetMaxChapters: env.BUDGET_MAX_CHAPTERS,
    budgetMaxSteps: env.BUDGET_MAX_STEPS,
    budgetMaxWallMs: env.BUDGET_MAX_WALL_MS,
    budgetMaxTokens: env.BUDGET_MAX_TOKENS,
    budgetDailyTokens: env.BUDGET_DAILY_TOKENS,
    maxRewritesPerChapter: env.BUDGET_MAX_REWRITES_PER_CHAPTER,
    upwardLagWaves: env.BUDGET_UPWARD_LAG_WAVES,
    maxDeltaRatio: env.BUDGET_MAX_DELTA_RATIO,
    gateCycles: env.GATE_CYCLES,
    gateTtlMs: env.GATE_TTL_MS,
    leaseTtlMs: env.LEASE_TTL_MS,
    laneTtlMs: env.LANE_TTL_MS,
    reaperMs: env.ENGINE_REAPER_MS,
    maxConcurrentSteps: env.ENGINE_MAX_CONCURRENT_STEPS,
    maxConcurrentProcesses: env.ENGINE_MAX_CONCURRENT_PROCESSES,
    engineTokenFile: env.ENGINE_TOKEN_FILE,
    engineToken: env.ENGINE_TOKEN,
    watchPollMs: env.WATCH_POLL_MS,
    watchCoalesceMs: env.WATCH_COALESCE_MS,
    emptyWriteGraceMs: env.EMPTY_WRITE_GRACE_MS,
    drafting: env.DRAFTING,
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`invalid configuration: ${details}`);
  }
  const config = parsed.data;
  // Fail closed, loudly: an unprotected write path into the model is worse than an hour
  // without comments (§12.8). `none` is a test/local shape only and never a prod default.
  if (config.captchaProvider === 'none' && env.NODE_ENV === 'production') {
    throw new Error('invalid configuration: CAPTCHA_PROVIDER=none is refused in production (§12.8)');
  }
  if (config.captchaProvider !== 'none' && config.captchaSecret.length === 0) {
    throw new Error(`invalid configuration: CAPTCHA_SECRET is required for provider ${config.captchaProvider}`);
  }
  // A configured provider with no public key renders a dead widget: the composer would be
  // visible, the challenge unrenderable, and every post would fail with CAPTCHA_FAILED.
  if (config.captchaProvider !== 'none' && config.captchaSiteKey.trim().length === 0) {
    throw new Error(`invalid configuration: CAPTCHA_SITE_KEY is required for provider ${config.captchaProvider}`);
  }
  // B1 (audit): a vendor's published test credential makes the challenge decorative — with a
  // published test sitekey the widget accepts any visitor, and with a published test secret
  // siteverify answers `success: true` for any token. The messages name the variable and never
  // the value; the check runs on any non-empty key, whatever the provider.
  //
  // A published *secret* is fatal in every environment: it alone opens the comment path, so no
  // opt-in may lift it (§12.8, README «Secrets»). A published *sitekey* only renders a
  // decorative widget — siteverify still rejects the token against a real secret — so outside
  // production a local sandbox may use it with a warning, and in production it needs the
  // explicit, loud opt-in `CAPTCHA_ALLOW_TEST_SITE_KEY=1`; comments stay closed either way
  // until a real Turnstile pair is set.
  if (isPublishedCaptchaTestKey(config.captchaSecret)) {
    throw new Error('invalid configuration: CAPTCHA_SECRET is a published test key');
  }
  if (isPublishedCaptchaTestKey(config.captchaSiteKey)) {
    if (env.NODE_ENV !== 'production') {
      console.warn('CAPTCHA_SITE_KEY is a published test key — accepted outside production only');
    } else if (config.captchaAllowTestSiteKey !== '1') {
      throw new Error(
        'invalid configuration: CAPTCHA_SITE_KEY is a published test key and is refused in production; ' +
          'set a real key or CAPTCHA_ALLOW_TEST_SITE_KEY=1',
      );
    } else {
      console.warn(
        'CAPTCHA_SITE_KEY is a published test key — allowed in production only because ' +
          'CAPTCHA_ALLOW_TEST_SITE_KEY=1; comments stay closed until a real Turnstile sitekey ' +
          'and secret pair is set',
      );
    }
  }
  if (env.NODE_ENV === 'production') {
    // Deployment invariants (§14, §17): a per-boot secret logs every reader out on restart
    // and makes the persisted IP hash useless; an http origin drops the cookie's `Secure`.
    if (config.sessionSecret.length === 0) {
      throw new Error('invalid configuration: SESSION_SECRET is required in production');
    }
    if (config.ipSalt.length === 0) {
      throw new Error('invalid configuration: IP_SALT is required in production');
    }
    if (!config.publicOrigin.startsWith('https://')) {
      throw new Error('invalid configuration: PUBLIC_ORIGIN must be https:// in production');
    }
  }
  return config;
}

/** The OAuth callback URL: configured explicitly, or derived from the public origin. */
export function yandexRedirectUri(config: Config): string {
  if (config.yandexRedirectUri.length > 0) return config.yandexRedirectUri;
  return `${config.publicOrigin.replace(/\/+$/u, '')}/auth/yandex/callback`;
}

/** Yandex is configured only when both credentials exist (a placeholder is `''`). */
export function yandexConfigured(config: Config): boolean {
  return config.yandexClientId.length > 0 && config.yandexClientSecret.length > 0;
}
