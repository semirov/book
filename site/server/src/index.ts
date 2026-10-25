/**
 * Boot: config → db → migrate → full rescan → http (§4.3). No watcher, no sockets, no
 * writes to the repository — M0 serves what the files say.
 */

import { readFileSync } from 'node:fs';

import { buildApp } from './app.ts';
import { loadConfig, SITE_ROOT } from './config.ts';
import { databaseFile, openDatabase } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { listCatalog } from './db/repo/chapters.ts';
import { reconcile, rememberScan } from './ingest/reconcile.ts';
import { StateService } from './ingest/stateService.ts';

function serverVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return manifest.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(databaseFile(config.dataDir));
  const migration = migrate(db);
  const report = reconcile(db, { bookRoot: config.bookRoot, dataDir: config.dataDir });
  rememberScan(db, report);

  const state = new StateService(db);
  const app = await buildApp({ config, db, state, version: serverVersion() });

  const catalog = listCatalog(db);
  app.log.info(
    {
      site: SITE_ROOT,
      bookRoot: config.bookRoot,
      dataDir: config.dataDir,
      migration,
      written: catalog.filter((entry) => entry.written).map((entry) => entry.n),
      ignored: report.ignored,
      readErrors: report.readErrors,
    },
    'manuscript scanned',
  );

  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
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
