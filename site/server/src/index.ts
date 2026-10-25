/**
 * Boot: config → db → migrate → full rescan → hub → watcher → http (§4.3).
 *
 * The site still writes nothing to the repository: the watcher reads files and the hub
 * fans out facts. Intent (leases, changes, cascades) arrives with the engine in M3; reader
 * identity and comments arrive here in M5, with the decisions tailer closing the loop from
 * `feedback.mjs` back to the readers' sockets.
 */

import { readFileSync } from 'node:fs';

import type { ViewerDto } from '@book/shared';

import { buildApp } from './app.ts';
import { loadConfig, SITE_ROOT } from './config.ts';
import { databaseFile, openDatabase } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { listCatalog } from './db/repo/chapters.ts';
import { EngineBridge } from './engineState/bridge.ts';
import { startErosionJob } from './history/erosion.ts';
import { DecisionsTailer } from './feedback/decisions.ts';
import { SessionStore, SESSION_COOKIE } from './identity/session.ts';
import { reconcile, rememberScan } from './ingest/reconcile.ts';
import { StateService } from './ingest/stateService.ts';
import { ManuscriptWatcher } from './ingest/watcher.ts';
import { loadImprint } from './imprint.ts';
import { RateLimiter } from './rate/limiter.ts';
import { parseCookies } from './util/cookies.ts';
import { createIpHasher, ephemeralSecret } from './util/ipHash.ts';
import { WsHub } from './ws/hub.ts';

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

  const now = (): Date => new Date();
  // Deployment secrets arrive as `0600` files resolved by `loadConfig` (§21.2); an ephemeral
  // value keeps local development working and only weakens restart-durable rate windows.
  const sessionSecret = config.sessionSecret.length > 0 ? config.sessionSecret : ephemeralSecret();
  const ipHash = createIpHasher(config.ipSalt.length > 0 ? config.ipSalt : ephemeralSecret());
  const sessions = new SessionStore({
    db,
    ttlMs: config.sessionTtlMs,
    secure: config.publicOrigin.startsWith('https'),
    now,
    ipHash,
  });
  const limiter = new RateLimiter(db, () => now().getTime());

  const state = new StateService(db);
  const imprint = loadImprint(config.imprintPath);
  const hub = new WsHub({
    db,
    state,
    config,
    imprint,
    resolveViewer: (request): ViewerDto => {
      const session = sessions.read(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      return session === null
        ? { signedIn: false, displayName: null }
        : { signedIn: true, displayName: session.identity.display_name };
    },
  });

  const watcher = new ManuscriptWatcher({
    db,
    state,
    bookRoot: config.bookRoot,
    dataDir: config.dataDir,
    pollMs: config.watchPollMs,
    coalesceMs: config.watchCoalesceMs,
    emptyGraceMs: config.emptyWriteGraceMs,
    emit: (event) => hub.publish(event.type, event.data),
  });

  // The engine writes facts into the same database; the bridge narrates them to readers.
  const bridge = new EngineBridge({
    db,
    emit: (type, data) => hub.publish(type, data),
    snapshot: () => state.snapshot(),
  });

  // Triage decisions are files; the site turns each new line into reader-visible events.
  const decisions = new DecisionsTailer({
    db,
    dir: config.feedbackDir,
    emit: (type, data) => hub.publish(type, data),
    now,
  });
  decisions.prime();
  // §6F.4: the nightly erosion series; the first measurement runs at boot.
  const stopErosion = startErosionJob(db, { now: () => now().getTime() });
  const decisionTimer = setInterval(() => {
    try {
      decisions.poll();
    } catch (error) {
      console.error('feedback decisions: poll failed', error instanceof Error ? error.message : error);
    }
  }, 1_000);
  decisionTimer.unref?.();

  const app = await buildApp({
    config,
    db,
    state,
    imprint,
    wsHub: hub,
    watcherStatus: watcher.status,
    version: serverVersion(),
    sessions,
    limiter,
    sessionSecret,
    ipHash,
    now,
  });

  await watcher.start();
  bridge.start();
  await app.listen({ host: config.host, port: config.port });

  const catalog = listCatalog(db);
  app.log.info(
    {
      site: SITE_ROOT,
      bookRoot: config.bookRoot,
      dataDir: config.dataDir,
      feedbackDir: config.feedbackDir,
      migration,
      oauth: config.yandexClientId.length > 0 ? 'configured' : 'unconfigured',
      captcha: config.captchaProvider,
      written: catalog.filter((entry) => entry.written).map((entry) => entry.n),
      front: report.front,
      frontProblems: report.frontProblems,
      ignored: report.ignored,
      readErrors: report.readErrors,
      watcher: watcher.status,
    },
    'manuscript scanned, watcher attached',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(decisionTimer);
    stopErosion();
    bridge.stop();
    await watcher.stop();
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
