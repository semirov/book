/**
 * `book-engine`: the writing engine's own process (ARCHITECTURE.md §4.2, §20 M3).
 *
 * Same image as the site, a second entrypoint (`server/dist/engine.js`), no public port: the
 * internal API listens on the compose network / loopback only. Boot order is deliberate —
 * migrate, recover (reap what the previous process left), then serve. Nothing is "resumed"
 * blindly: `reconcile` takes a write that landed without a report, re-issues a job whose
 * session vanished, and leaves every fact it changed in `events`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadConfig } from './config.ts';
import { databaseFile, openDatabase } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { buildControl } from './engine/control.ts';
import { createEngine } from './engine/service.ts';
import { systemClock, type EngineAlert } from './engine/types.ts';

function resolveToken(config: ReturnType<typeof loadConfig>): string {
  if (config.engineToken) return config.engineToken;
  if (existsSync(config.engineTokenFile)) return readFileSync(config.engineTokenFile, 'utf8').trim();
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`engine token file is missing: ${config.engineTokenFile}`);
  }
  // Local development only: mint a token next to the database, mode 0600. A deployed engine
  // always gets its token from a mounted secret.
  mkdirSync(dirname(config.engineTokenFile), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(config.engineTokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(databaseFile(config.dataDir));
  const migration = migrate(db);
  const token = resolveToken(config);

  const engine = createEngine({
    db,
    config,
    bookRoot: config.bookRoot,
    clock: systemClock,
    alert: (alert: EngineAlert) => {
      // The alert is already a row (meta + events); this line is for the operator's terminal.
      console.warn(JSON.stringify({ level: 'warn', alert }));
    },
  });

  const app = await buildControl({ engine, token, version: process.env.npm_package_version ?? '0.0.0' });
  const recovery = engine.reconcile();
  app.log.info({ migration, dataDir: config.dataDir, recovery }, 'engine recovered, lane checked');

  const timer = setInterval(() => {
    try {
      engine.reap();
      engine.heartbeat();
    } catch (error) {
      app.log.error({ err: error }, 'reaper failed');
    }
  }, config.reaperMs);
  timer.unref?.();

  await app.listen({ host: config.engineHost, port: config.enginePort });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'engine shutting down');
    clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
