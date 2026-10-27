/**
 * Config (ARCHITECTURE.md §21.2, invariant 30). Parsed once at boot, fail-fast, never a secret
 * value in an error message. Every secret is resolved from `${NAME}_FILE` (a `0600` mount).
 * The plain variable is a local-development convenience only: in production a secret supplied
 * as a plain value is a boot failure, because `node --env-file` puts it in the environment and
 * `docker inspect` / `/proc/1/environ` then show it. There is no opt-out — a deployment keeps
 * paths in the environment and values in files. Outside production (development, tests) the
 * plain variable is still accepted, so a local run needs no files.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { CASCADE_MAX_WAVE, isPublishedCaptchaTestKey } from '@book/shared';

import { budgetCapsFromEnv } from './budget.ts';
import { assertDataDirIsolation, productionDataDirs } from './dataDirGuard.ts';
import { donateUrlOf } from './donate.ts';
import { loadPipeline, type Pipeline } from './pipeline.ts';

/** `site/` — works from `server/src` (tsx) and from `server/dist` (node). */
export const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const schema = z.object({
  bookRoot: z.string().default(resolve(SITE_ROOT, '..')),
  dataDir: z.string().default(resolve(SITE_ROOT, '.data')),
  /** The built SPA: `@fastify/static` needs an absolute root; a relative value resolves against `site/`. */
  webDist: z
    .string()
    .default(resolve(SITE_ROOT, 'web', 'dist'))
    .transform((value) => resolve(SITE_ROOT, value)),
  /** The read-only imprint config (§6C.6); F020 and the boot both validate it. */
  imprintPath: z.string().default(resolve(SITE_ROOT, 'config', 'imprint.json')),
  /** BOOK-133: the cover the FB2 embeds; the path exists in the image — a miss fails the export, not the boot. */
  coverPath: z.string().default(resolve(SITE_ROOT, 'web', 'public', 'cover', 'cover.png')),
  /** The hand-curated legal denylist (§13.4, F005); read, never refreshed from the book. */
  denylistPath: z.string().default(resolve(SITE_ROOT, 'config', 'legal.denylist.json')),
  /** ADR-038: the one file that names the pipeline's model (BOOK-62); a bad one stops the boot. */
  pipelinePath: z.string().default(resolve(SITE_ROOT, 'config', 'pipeline.json')),
  /**
   * BOOK-117: the money caps, in USD. They are environment, not data (`BOOK_BUDGET_DAY_USD`,
   * `BOOK_BUDGET_BOOK_USD`), parsed by `budgetCapsFromEnv` before this schema so a bad value
   * names its own variable.
   */
  budgetDayUsd: z.number().positive(),
  budgetBookUsd: z.number().positive(),
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
  /**
   * Per-network socket cap: 20 readers share one address (§10.1). Over this cap — or over the
   * 100 seats — the **newcomer** is refused with `1013 CAPACITY`; an open seat is never taken
   * from a reader (BOOK-75; CGNAT households, BOOK-DOC-33 M-major).
   *
   * Why 20: a household or a shared connection is phones, laptops and tabs — the previous cap
   * of 4 was smaller than one family, and behind CGNAT two families share one address.
   * 20 × 5 networks is the whole 100-seat hall, so one address can hold at most a fifth of it
   * (at 4 it took 25 addresses to fill it): that is what limits a script. A carrier NAT
   * fronting hundreds of subscribers still queues past 20, and that is acceptable exactly
   * because nobody is evicted to seat them — they wait, and the plate says so.
   */
  wsPerIp: z.coerce.number().int().min(1).default(20),
  /** Protocol ping interval; two missed pongs terminate a socket (§10.1). */
  wsHeartbeatMs: z.coerce.number().int().min(1_000).default(30_000),
  /**
   * `X-Forwarded-For` is believed only from these peers (§14). Caddy is one host, so the
   * proxy is a single address, never a whole subnet: a /24 would let every machine on the
   * LAN name its own address to the per-IP limits (audit m1).
   */
  trustedProxies: z.string().default('127.0.0.1,::1,192.168.1.44/32'),
  /** Per-IP budget for the read API; which prefixes take it lives in `http/readLimit.ts`. */
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
  /**
   * §12.8 (BOOK-64): the write gate is an authenticated identity plus the comment and edit
   * rate limits (rate/policy.ts). `none` is the shipped production shape; a captcha may
   * return as a separate decision, and then it needs both halves configured.
   */
  captchaProvider: z.enum(['turnstile', 'hcaptcha', 'none']).default('none'),
  captchaSiteKey: z.string().default(''),
  captchaSecret: z.string().default(''),
  /**
   * Opt-in for a vendor's published test sitekey, kept for the day a challenge returns.
   * `0` keeps the boot refusal; `1` lets a deployment start with such a key, warns once, and
   * leaves the comment path closed (the real secret fails siteverify). A published test
   * *secret* stays fatal in every environment. Values are strings like every other enum in
   * this schema, so a typo (`true`) fails the parse instead of silently enabling the opt-in.
   */
  captchaAllowTestSiteKey: z.enum(['0', '1']).default('0'),
  captchaTimeoutMs: z.coerce.number().int().min(500).max(10_000).default(3_000),
  /**
   * BOOK-126: the one outbound link of the gift row. Public by nature — it is printed on the
   * page — so it is a plain value, not a `_FILE` mount. `donateUrlOf` (`donate.ts`) validates
   * it: empty or refused is `null`, and the row then does not render at all.
   */
  donateUrl: z
    .string()
    .default('')
    .transform((value) => donateUrlOf(value)),
  /** Empty = no script, no third-party origin in the CSP (§15.6). */
  metrikaId: z.string().default(''),
  /**
   * Cascade bounds (§6A.6, frozen per cascade at open). The wave bound is the *public
   * promise* of BOOK-DOC-4 rule 3 (`CASCADE_MAX_WAVE`), not a knob: `superRefine` below lets
   * an env restate it and refuses any other value. A wave is a round of both wings, so a
   * ripple bounded by W waves is 2W steps over 2W chapters, reaching −W / +W from the origin;
   * the front and ending proofs add at most two more steps. The shipped chapter and step
   * bounds sit above that on purpose: a bound that bound first would make the wave bound dead
   * config (audit R3).
   */
  budgetMaxWave: z.coerce.number().int().min(1).default(CASCADE_MAX_WAVE),
  budgetMaxChapters: z.coerce.number().int().min(1).default(12),
  budgetMaxSteps: z.coerce.number().int().min(1).default(13),
  /**
   * The wall stays the operative bound even for one wave: a ripple is at most a few model runs,
   * but a slow one can still outlast the NFR hard bound, and that stop is an honest escalation
   * (`escalated:budget` with the time reason), not a failed promise (BOOK-DOC-4 rule 3).
   */
  budgetMaxWallMs: z.coerce.number().int().min(1).default(1_800_000),
  budgetMaxTokens: z.coerce.number().int().min(1).default(1_500_000),
  budgetDailyTokens: z.coerce.number().int().min(1).default(24_000_000),
  maxRewritesPerChapter: z.coerce.number().int().min(1).default(1),
  /**
   * BOOK-59: a wave is what both wings do together, so the shipped lag is 0 — the upward wing
   * steps in the same wave as the downward one. A lag above zero would keep the far wing out
   * of the only wave a ripple has, and `superRefine` below refuses such a value.
   */
  upwardLagWaves: z.coerce.number().int().min(0).default(0),
  /** A repair may replace at most this share of its chapter (§6A.6 MAX_DELTA_RATIO). */
  maxDeltaRatio: z.coerce.number().min(0).max(1).default(0.35),
  /** Writer revisions per step before the text is published with its finding (§6B.4). */
  gateCycles: z.coerce.number().int().min(1).default(3),
  /** How long a gate may read before its dispatch is dead: a real editor read took 4–7 min, and
   *  the old five minutes killed a normal pass. The beat extends a live one; the wall still bounds. */
  gateTtlMs: z.coerce.number().int().min(1).default(1_200_000),
  leaseTtlMs: z.coerce.number().int().min(1).default(120_000),
  /**
   * BOOK-34 — the step wall: how long one step may stay open, measured from `steps.at`,
   * the column that is the step's opening (there is no `opened_at` on `steps`).
   * The engine beats a step's own lease (a real 20 000–30 000-character pass plus both gates
   * outlives `leaseTtlMs`), so this wall is the only bound on a step's growth: past it the
   * reaper escalates the step and releases its lease. 45 min covers a slow model with room.
   */
  stepWallMs: z.coerce.number().int().min(1).default(2_700_000),
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
  // an env file: an old deployment that still says 5 must fail the boot, never tell the client
  // 5 while /rules promises one. The message names the variable and the constant.
  if (config.budgetMaxWave !== CASCADE_MAX_WAVE) {
    ctx.addIssue({
      code: 'custom',
      path: ['budgetMaxWave'],
      message:
        `BUDGET_MAX_WAVE must equal CASCADE_MAX_WAVE (${String(CASCADE_MAX_WAVE)}): ` +
        'the wave bound is the public promise of BOOK-DOC-4 rule 3, not a knob',
    });
  }
  // BOOK-59: the upward wing has to fit inside the wave bound, or the ripple can only move in
  // one direction and /rules («вперёд и назад») would be false. A lag of L waves needs L + 1
  // waves for the far wing to step at all.
  if (config.upwardLagWaves >= config.budgetMaxWave) {
    ctx.addIssue({
      code: 'custom',
      path: ['upwardLagWaves'],
      message:
        `BUDGET_UPWARD_LAG_WAVES must be below BUDGET_MAX_WAVE (${String(config.budgetMaxWave)}): ` +
        'a lag that fills the whole bound would keep the upward wing out of every wave',
    });
  }
  // The chapter and step bounds must not bind before the wave bound, or a full-width ripple is
  // unreachable and the wave bound is dead config (audit R3). A ripple bounded by W waves is
  // 2W steps over 2W chapters (both wings per wave), and the front and ending proofs add at
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
  // BOOK-34: the step wall is a wall, not a hint. A wall below the lease TTL would escalate
  // every step on the first tick while its lease is still fresh; equality is allowed (a wall
  // exactly at the TTL), but the wall may never sit under the bound the engine beats by itself.
  if (config.stepWallMs < config.leaseTtlMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['stepWallMs'],
      message:
        `STEP_WALL_MS must be at least LEASE_TTL_MS (${String(config.leaseTtlMs)}): ` +
        'a step wall below the lease TTL would stop steps the engine is still beating',
    });
  }
});

export type Config = z.infer<typeof schema> & {
  pipeline: Pipeline; // ADR-038: the model the pipeline runs on, read from `pipelinePath` at boot.
};

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
 * Resolves a mounted secret. The file wins over the plain variable in every environment.
 * In production the file is the only accepted source: a plain value is refused (invariant 30
 * — `--env-file` and `docker inspect` both expose it), and there is no opt-out. A blank value
 * is no secret at all, so the required checks below report it with their own message.
 * Outside production the plain variable is accepted, so tests and local development need no
 * files. A declared file that is missing, unreadable or empty is a boot failure everywhere —
 * never a silent "no session secret, no CAPTCHA secret". The messages carry the variable name
 * only, never a value or a path.
 */
function readMountedSecret(
  env: NodeJS.ProcessEnv,
  name: MountedSecret,
  production: boolean,
): string | undefined {
  const file = env[`${name}_FILE`];
  if (file === undefined || file.trim().length === 0) {
    const plain = env[name];
    if (!production) return plain;
    // A blank value is no secret at all: the required checks below report it more plainly.
    if ((plain ?? '').trim().length === 0) return undefined;
    throw new Error(
      `invalid configuration: ${name} must come from ${name}_FILE in production, ` +
        'never from a plain value (invariant 30)',
    );
  }
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
  // Case- and space-insensitive on purpose: `Production` must not slip past the invariants
  // below and let a deployed boot run the development shape.
  const production = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  // BOOK-117: the two money caps are environment, read once and validated on their own, so
  // a bad value names the variable (`BOOK_BUDGET_DAY_USD must be a positive decimal`).
  const caps = budgetCapsFromEnv(env);
  const parsed = schema.safeParse({
    bookRoot: env.BOOK_ROOT,
    dataDir: env.DATA_DIR,
    webDist: env.WEB_DIST,
    imprintPath: env.IMPRINT_PATH,
    coverPath: env.COVER_PATH,
    denylistPath: env.DENYLIST_PATH,
    pipelinePath: env.PIPELINE_PATH,
    budgetDayUsd: caps.dayUsd,
    budgetBookUsd: caps.bookUsd,
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
    yandexClientId: readMountedSecret(env, 'YANDEX_CLIENT_ID', production),
    yandexClientSecret: readMountedSecret(env, 'YANDEX_CLIENT_SECRET', production),
    yandexRedirectUri: env.YANDEX_REDIRECT_URI ?? env.OAUTH_REDIRECT_URI,
    yandexAuthorizeUrl: env.YANDEX_AUTHORIZE_URL,
    yandexTokenUrl: env.YANDEX_TOKEN_URL,
    yandexInfoUrl: env.YANDEX_INFO_URL,
    oauthStartPerHour: env.OAUTH_START_PER_HOUR,
    oauthStateTtlMs: env.OAUTH_STATE_TTL_MS,
    sessionTtlMs: env.SESSION_TTL_MS,
    sessionSecret: readMountedSecret(env, 'SESSION_SECRET', production),
    ipSalt: readMountedSecret(env, 'IP_SALT', production),
    captchaProvider: env.CAPTCHA_PROVIDER,
    captchaSiteKey: env.CAPTCHA_SITE_KEY,
    captchaSecret: readMountedSecret(env, 'CAPTCHA_SECRET', production),
    captchaAllowTestSiteKey: env.CAPTCHA_ALLOW_TEST_SITE_KEY,
    captchaTimeoutMs: env.CAPTCHA_TIMEOUT_MS,
    donateUrl: env.DONATE_URL,
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
    stepWallMs: env.STEP_WALL_MS,
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
  // BOOK-126: no link at all is a deployment that does not ask for gifts. A *set* link that
  // fails the allowlist is an operator mistake and must be visible, but the boot keeps going —
  // a typo must not keep the book offline, and a dead link would be worse than no row. The
  // reason is named; the rejected value is not echoed.
  if (config.donateUrl === null && (env.DONATE_URL ?? '').trim().length > 0) {
    console.warn(
      'DONATE_URL was set but is not an https://t.tb.ru link (no port, no credentials) — ' +
        'the «поддержать книгу» row is off',
    );
  }
  // ADR-038: read once, so no code path can default it; nothing in this file is a secret.
  const pipeline = loadPipeline(config.pipelinePath);
  // BOOK-107: the wall around the data dirs, both directions. A boot that is not production
  // must never point at the prod data dir, and a production boot must never keep its data in
  // the checkout. The guard runs on the parsed paths (DATA_DIR is not resolved by the schema,
  // so it resolves it) and uses the same `production` flag every invariant below keys on.
  assertDataDirIsolation(
    {
      dataDir: config.dataDir,
      adminTokenFile: config.adminTokenFile,
      engineTokenFile: config.engineTokenFile,
      feedbackDir: config.feedbackDir,
    },
    production,
    { prodDirs: productionDataDirs(env), repoRoot: resolve(SITE_ROOT, '..') },
  );
  // §12.8 (BOOK-64): the gate is an authenticated identity plus the comment and edit rate
  // limits, so a deployment may boot with no challenge at all. What still fails loudly is a
  // *half-configured* captcha: a sitekey without a secret renders a widget nothing can
  // verify, and a secret without a sitekey configures a verifier no reader can reach.
  const hasSiteKey = config.captchaSiteKey.trim().length > 0;
  const hasSecret = config.captchaSecret.length > 0;
  if (hasSiteKey !== hasSecret) {
    throw new Error(
      'invalid configuration: CAPTCHA_SITE_KEY and CAPTCHA_SECRET must be configured together ' +
        `(${hasSiteKey ? 'CAPTCHA_SECRET is missing' : 'CAPTCHA_SITE_KEY is missing'})`,
    );
  }
  if (config.captchaProvider !== 'none' && !hasSecret) {
    throw new Error(`invalid configuration: CAPTCHA_SECRET is required for provider ${config.captchaProvider}`);
  }
  // B1 (audit): a vendor's published test credential makes the challenge decorative — with a
  // published test sitekey the widget accepts any visitor, and with a published test secret
  // siteverify answers `success: true` for any token. The messages name the variable and never
  // the value; the check runs on any non-empty key, whatever the provider. With no provider
  // there is no challenge to protect, and the keys above are inert.
  //
  // A published *secret* is fatal in every environment: it alone opens the comment path, so no
  // opt-in may lift it (§12.8, README «Secrets»). A published *sitekey* only renders a
  // decorative widget — siteverify still rejects the token against a real secret — so outside
  // production a local sandbox may use it with a warning, and in production it needs the
  // explicit, loud opt-in `CAPTCHA_ALLOW_TEST_SITE_KEY=1`; comments stay closed either way
  // until a real Turnstile pair is set.
  if (config.captchaProvider !== 'none') {
    if (isPublishedCaptchaTestKey(config.captchaSecret)) {
      throw new Error('invalid configuration: CAPTCHA_SECRET is a published test key');
    }
    if (isPublishedCaptchaTestKey(config.captchaSiteKey)) {
      if (!production) {
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
  }
  if (production) {
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
  return { ...config, pipeline };
}

/**
 * The one boot line for the gate in force when no challenge runs (§12.8, BOOK-64): the
 * authenticated identity plus the comment and edit rate limits. The operator never has to
 * infer the gate from the absence of a script.
 */
export const IDENTITY_GATE_LINE = 'gate: identity + rate limits (no captcha)';

/** `null` when a challenge provider is configured: then its own boot facts apply. */
export function gateAnnouncement(config: Pick<Config, 'captchaProvider'>): string | null {
  return config.captchaProvider === 'none' ? IDENTITY_GATE_LINE : null;
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
