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
import { bootDatabase, bootFailureLine } from './db/boot.ts';
import { SCHEMA_VERSION } from './db/schema.ts';
import { buildControl } from './engine/control.ts';
import { createEngine } from './engine/service.ts';
import { systemClock, type EngineAlert } from './engine/types.ts';
import { chapterVocabulary } from './feedback/vocabulary.ts';

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
  // BOOK-187 / ADR-043 §5: the same boot the site runs — schema read, verified dump, migrate,
  // stamps, prompt drift. The lane never writes a schema the site has not accepted.
  const db = await bootDatabase({ dataDir: config.dataDir });
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

  const app = await buildControl({
    engine,
    db,
    token,
    version: process.env.npm_package_version ?? '0.0.0',
    vocabulary: (chapter) => chapterVocabulary(db, chapter),
  });
  const recovery = engine.reconcile();
  app.log.info(
    { schema: SCHEMA_VERSION, dataDir: config.dataDir, pipeline: config.pipeline.model, recovery },
    'engine recovered, lane checked',
  );

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
  // One line, naming the refusal code and the numbers (ADR-043 §5): the supervisor reads it.
  console.error(bootFailureLine(error) ?? (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
