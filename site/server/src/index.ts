/**
 * Boot: config → db → schema read/dump/migrate → hub → http (§4.3, ADR-043 §5).
 *
 * **No path here reads a manuscript directory** (BOOK-187 AC2): the book's text, its front
 * matter and its frame are rows, so a restart has nothing to rescan. The one module that may
 * read an existing file tree is `ingest/reconcile.ts` — a one-shot import an operator runs
 * deliberately, never a boot step.
 *
 * The site writes nothing to the repository: the hub fans out facts, the tailers read rows and
 * the feedback inbox. Intent (leases, changes, cascades) arrives with the engine in M3; reader
 * identity and comments arrive here in M5, with the decisions tailer closing the loop from
 * `feedback.mjs` back to the readers' sockets.
 */

import { readFileSync } from 'node:fs';


import { buildApp } from './app.ts';
import { createAuthorsCount } from './authors/count.ts';
import { readBuildCommit } from './build.ts';
import { loadConfig, SITE_ROOT, gateAnnouncement } from './config.ts';
import { bootDatabase, bootFailureLine } from './db/boot.ts';
import { SCHEMA_VERSION } from './db/schema.ts';
import { listCatalog } from './db/repo/chapters.ts';
import { EngineBridge } from './engineState/bridge.ts';
import { startErosionJob } from './history/erosion.ts';
import { DecisionsTailer } from './feedback/decisions.ts';
import { poll as pollTriage } from './feedback/triageApplier.ts';
import { budgetCapsOf } from './budget.ts';
import { SessionStore, SESSION_COOKIE } from './identity/session.ts';
import { StateService } from './ingest/stateService.ts';
import { StageTailer } from './stages/tailer.ts';
import { loadImprint } from './imprint.ts';
import { RateLimiter } from './rate/limiter.ts';
import { parseCookies } from './util/cookies.ts';
import { createIpHasher, ephemeralSecret } from './util/ipHash.ts';
import { sendPassEvent } from './push/passEvent.ts';
import { drainPush } from './push/sender.ts';
import { createWebPushTransport } from './push/transport.ts';
import { readVapid } from './push/vapid.ts';
import { WsHub, type ViewerContext } from './ws/hub.ts';

/** BOOK-189: how long the site waits between drains, measured from the end of the previous one. */
const PUSH_TICK_MS = 2_000;

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
  // BOOK-64: one line, before anything else runs, naming the gate in force. A challenge
  // deployment stays quiet here and logs its provider with the scan below.
  const gate = gateAnnouncement(config);
  if (gate !== null) console.log(gate);
  // BOOK-187 / ADR-043 §5: schema read → verified dump → migrate → stamps → prompt drift. A
  // refusal (a newer schema on the volume, a dump that cannot be verified) throws `BootRefusal`,
  // and the supervisor — not this process — owns the restart.
  const db = await bootDatabase({ dataDir: config.dataDir });

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

  const state = new StateService(db, undefined, budgetCapsOf(config), {
    queueSoftCap: config.queueSoftCap,
    maxPasses: config.writerMaxPasses,
  });
  const imprint = loadImprint(config.imprintPath);
  // One byline reader for the socket and the HTTP app, so page 1, a live `authors:update` and a
  // reconnect all carry comparable markers (BOOK-DOC-4).
  const authorsCount = createAuthorsCount(db, now);
  const hub = new WsHub({
    db,
    state,
    config,
    imprint,
    authorsCount,
    // BOOK-DOC-84 §2.2: the internal identity rides beside the public DTO, for `live.filings`.
    liveOptions: { queueSoftCap: config.queueSoftCap, maxPasses: config.writerMaxPasses },
    resolveViewer: (request): ViewerContext => {
      const session = sessions.read(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      return session === null
        ? { viewer: { signedIn: false, displayName: null }, identityId: null }
        : { viewer: { signedIn: true, displayName: session.identity.display_name }, identityId: session.identity.id };
    },
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
    // BOOK-189: a filing refused at triage never becomes a change, so the engine's close hook can
    // never speak for it. Its author hears the answer here, once — and push never throws, so a
    // broken push table cannot stop the tailer.
    notify: (commentId, reason) => {
      sendPassEvent(db, { kind: 'commentDecision', commentId, reason }, now().getTime());
    },
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
    // BOOK-206 (ADR-045 §3): the same one-second interval places what the container read — a
    // filing with a stored verdict and no disposition, at most two a tick. No second timer.
    try {
      pollTriage({
        db,
        emit: (type, data) => hub.publish(type, data),
        notify: (commentId, reason) => {
          sendPassEvent(db, { kind: 'commentDecision', commentId, reason }, now().getTime());
        },
        now,
      });
    } catch (error) {
      console.error('triage applier: poll failed', error instanceof Error ? error.message : error);
    }
  }, 1_000);
  decisionTimer.unref?.();

  // BOOK-109: the build this process is, read once — it is what `/healthz` answers with when
  // the owner asks which host served a page, and the one line the boot log adds about identity.
  const commit = readBuildCommit();
  // BOOK-189: the VAPID key is read exactly once, here. Absent is «push is off» — a normal
  // deployment — while an unreadable one is a stable code in the log and nothing else: no path,
  // no key bytes, no file content.
  const vapid = readVapid(config.vapidFile);
  const app = await buildApp({
    config,
    db,
    state,
    imprint,
    commit,
    wsHub: hub,
    version: serverVersion(),
    sessions,
    limiter,
    sessionSecret,
    ipHash,
    now,
    authorsCount,
    vapid: vapid.keys,
    // BOOK-137: a reset restarts the ids the bridge's cursors point past; re-priming after the
    // wipe keeps the live chronicle narrating from the book's first new fact.
    onBookReset: () => bridge.prime(),
  });
  if (vapid.problem !== null) app.log.warn({ problem: vapid.problem }, 'web push is off: the VAPID key is unreadable');

  bridge.start();

  // docs/writer-lane.md §3: a stage written by the engine or the writer reaches live sockets
  // through the tailer; a socket that missed one reads the GET route. The cursor is seeded at
  // boot, so a restart does not replay yesterday's stages as news.
  const stages = new StageTailer({
    db,
    emit: (type, data) => hub.publish(type, data),
    onError: (message, error) => app.log.error({ err: error }, message),
  });
  stages.start();

  // BOOK-189: the site process is the only one with a network, so it is the one that drains the
  // push outbox. No key, no timer: a deployment without VAPID does not even look at the queue.
  //
  // The tick is **self-rescheduling** — the next one is armed only after this one settles, with
  // `setTimeout`, never `setInterval`: a push service slower than the interval would otherwise let
  // two drains select the same row and tell the reader twice. `drainPush` claims each row as well,
  // because a restarted site or a second process can overlap a tick whatever this timer does.
  // The handle is unref'd (a pending drain must not keep the process alive) and cleared on shutdown.
  const pushTransport = vapid.keys === null ? null : createWebPushTransport(vapid.keys, config.publicOrigin);
  let pushTimer: NodeJS.Timeout | null = null;
  let pushStopped = false;
  if (pushTransport !== null) {
    const transport = pushTransport;
    const tickPush = async (): Promise<void> => {
      try {
        await drainPush(db, { transport, nowMs: Date.now(), log: (line) => app.log.info(line) });
      } catch (error) {
        app.log.error({ err: error }, 'push: drain failed');
      }
      if (pushStopped) return;
      pushTimer = setTimeout(() => void tickPush(), PUSH_TICK_MS);
      pushTimer.unref();
    };
    pushTimer = setTimeout(() => void tickPush(), PUSH_TICK_MS);
    pushTimer.unref();
  }

  await app.listen({ host: config.host, port: config.port });

  const catalog = listCatalog(db);
  app.log.info(
    {
      site: SITE_ROOT,
      build: commit,
      bookRoot: config.bookRoot,
      dataDir: config.dataDir,
      feedbackDir: config.feedbackDir,
      schema: SCHEMA_VERSION,
      oauth: config.yandexClientId.length > 0 ? 'configured' : 'unconfigured',
      captcha: config.captchaProvider,
      written: catalog.filter((entry) => entry.written).map((entry) => entry.n),
      chapters: catalog.filter((entry) => entry.written || entry.basis).length,
    },
    'serving the volume: the book is rows',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(decisionTimer);
    pushStopped = true;
    if (pushTimer !== null) clearTimeout(pushTimer);
    stopErosion();
    bridge.stop();
    stages.stop();
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
