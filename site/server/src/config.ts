/**
 * Config (ARCHITECTURE.md §21.2). Parsed once at boot, fail-fast, no secret values here:
 * files named in the environment are read by the components that need them (M1+).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** `site/` — works from `server/src` (tsx) and from `server/dist` (node). */
export const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const schema = z.object({
  bookRoot: z.string().default(resolve(SITE_ROOT, '..')),
  dataDir: z.string().default(resolve(SITE_ROOT, '.data')),
  webDist: z.string().default(resolve(SITE_ROOT, 'web', 'dist')),
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  publicOrigin: z.string().default('https://book.semirov.dev'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Display timezone for chapter meta and the ledger (§DESIGN 4.3). */
  tz: z.string().default('Europe/Moscow'),
  // Reserved budgets — read by M3 (the engine); defined now so the config is complete.
  maxWs: z.coerce.number().int().min(1).default(100),
  commentsPerHour: z.coerce.number().int().min(1).default(10),
  queueSoftCap: z.coerce.number().int().min(1).default(25),
  budgetMaxWave: z.coerce.number().int().min(1).default(4),
  budgetMaxChapters: z.coerce.number().int().min(1).default(7),
  budgetMaxSteps: z.coerce.number().int().min(1).default(14),
  budgetMaxWallMs: z.coerce.number().int().min(1).default(900_000),
  leaseTtlMs: z.coerce.number().int().min(1).default(90_000),
  watchPollMs: z.coerce.number().int().min(50).default(700),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    bookRoot: env.BOOK_ROOT,
    dataDir: env.DATA_DIR,
    webDist: env.WEB_DIST,
    host: env.HOST,
    port: env.PORT,
    publicOrigin: env.PUBLIC_ORIGIN,
    logLevel: env.LOG_LEVEL,
    tz: env.BOOK_TZ,
    maxWs: env.MAX_WS,
    commentsPerHour: env.COMMENTS_PER_HOUR,
    queueSoftCap: env.QUEUE_SOFT_CAP,
    budgetMaxWave: env.BUDGET_MAX_WAVE,
    budgetMaxChapters: env.BUDGET_MAX_CHAPTERS,
    budgetMaxSteps: env.BUDGET_MAX_STEPS,
    budgetMaxWallMs: env.BUDGET_MAX_WALL_MS,
    leaseTtlMs: env.LEASE_TTL_MS,
    watchPollMs: env.WATCH_POLL_MS,
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`invalid configuration: ${details}`);
  }
  return parsed.data;
}
