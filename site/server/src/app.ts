import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';

import type { AuthorsCountDto, BookCostDto, Imprint, ServerEventType } from '@book/shared';
import { REQUEST_BODY_MAX_BYTES } from '@book/shared';
import { createAuthorsCount } from './authors/count.ts';
import { readBuildCommit } from './build.ts';
import { createCaptchaVerifier, type CaptchaVerifier } from './captcha/verify.ts';
import type { Config } from './config.ts';
import { readBookCost } from './cost/book.ts';
import type { Db } from './db/db.ts';
import { createExportCache, exportSourceOf } from './fb2/exportCache.ts';
import type { Fb2Renderer } from './fb2/serialize.ts';
import type { RouteDeps } from './http/deps.ts';
import { registerCachePolicy } from './http/cache.ts';
import { buildCsp, createShellHashes } from './http/csp.ts';
import { isAllowedUpgradeOrigin } from './http/origin.ts';
import { registerReadLimit } from './http/readLimit.ts';
import { answerAssetMiss, firstNotFoundPass, servedRoot } from './http/releases.ts';
import { registerAdminRoutes } from './http/routes/admin.ts';
import { registerAnalyticsRoutes } from './http/routes/analytics.ts';
import { registerAuthRoutes } from './http/routes/auth.ts';
import { registerAuthorsRoutes } from './http/routes/authors.ts';
import { registerChangeRoutes } from './http/routes/changes.ts';
import { registerChapterRoutes } from './http/routes/chapters.ts';
import { registerCommentRoutes } from './http/routes/comments.ts';
import { registerCostRoutes } from './http/routes/cost.ts';
import { registerExportRoutes } from './http/routes/export.ts';
import { registerFrontRoutes } from './http/routes/front.ts';
import { registerHealthRoutes } from './http/routes/health.ts';
import { registerHistoryRoutes } from './http/routes/history.ts';
import { registerMeRoutes } from './http/routes/me.ts';
import { registerStateRoutes } from './http/routes/state.ts';
import { SessionStore } from './identity/session.ts';
import type { OAuthFetch } from './identity/yandex.ts';
import type { StateService } from './ingest/stateService.ts';
import type { WatcherStatus } from './ingest/watcher.ts';
import { loadImprint } from './imprint.ts';
import { readAdminToken } from './integrity/config.ts';
import { RateLimiter } from './rate/limiter.ts';
import { createIpHasher, ephemeralSecret } from './util/ipHash.ts';
import type { WsHub } from './ws/hub.ts';

export type AppOptions = {
  config: Config;
  db: Db;
  state: StateService;
  /** Injected in tests; the app loads `config.imprintPath` when it is absent. */
  imprint?: Imprint;
  /** Present in the running site; absent in tests that only exercise REST. */
  wsHub?: WsHub;
  /** Live watcher counters for `/healthz`; absent until the watcher starts. */
  watcherStatus?: WatcherStatus;
  startedAt?: number;
  version?: string;
  /** BOOK-109: the build this process is; the default reads `build-info.json` at boot. */
  commit?: string;
  logger?: boolean;
  /** Test seam: receives the JSON log lines, so a test can assert what is *not* logged. */
  logStream?: { write(line: string): void };
  /** §12.8 test seam: a stub verifier instead of a network call (unused when `none`). */
  captcha?: CaptchaVerifier;
  limiter?: RateLimiter;
  sessions?: SessionStore;
  /** §14 test seam and deployment secret (a file-mount value in production). */
  sessionSecret?: string;
  ipHash?: (ipKey: string) => string;
  now?: () => Date;
  /** §10: the broadcast seam; defaults to the hub when one is attached. */
  emit?: (type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown) => void;
  /** Test seam for the Yandex token/profile calls. */
  oauthFetch?: OAuthFetch;
  /** Overrides `ADMIN_TOKEN`/`ADMIN_TOKEN_FILE`; tests pass a literal token. */
  adminToken?: string;
  /** Shared with the WS hub in production so the byline markers are comparable. */
  authorsCount?: () => AuthorsCountDto;
  /** Test seam for the book's outlay: counts the scans a `/api/cost` page pays for. */
  bookCost?: () => BookCostDto;
  /** BOOK-60: serializer seam for `/book.fb2`; counts the builds a request pays for. */
  fb2?: { render: Fb2Renderer };
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            ...(options.logStream === undefined ? {} : { stream: options.logStream }),
          },
    // The default request log writes `request.url` — an OAuth callback carries `code` and
    // `state` in its query, i.e. a one-use credential and the CSRF nonce. The hook below
    // logs the path only: no query, no headers, no cookies.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: REQUEST_BODY_MAX_BYTES,
  });

  const now = options.now ?? (() => new Date());
  const sessionSecret = options.sessionSecret ?? (options.config.sessionSecret || ephemeralSecret());
  const ipHash = options.ipHash ?? createIpHasher(options.config.ipSalt || ephemeralSecret());
  const limiter = options.limiter ?? new RateLimiter(options.db, () => now().getTime());
  const captcha = options.captcha ?? createCaptchaVerifier(options.config);
  const sessions =
    options.sessions ??
    new SessionStore({
      db: options.db,
      ttlMs: options.config.sessionTtlMs,
      secure: options.config.publicOrigin.startsWith('https'),
      now,
      ipHash,
    });
  const emit = options.emit ?? (options.wsHub === undefined ? undefined : (type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown) => options.wsHub?.publish(type, data));
  const authorsCount = options.authorsCount ?? createAuthorsCount(options.db, now);
  const bookCost = options.bookCost ?? ((): BookCostDto => readBookCost(options.db));

  const deps: RouteDeps = {
    db: options.db,
    state: options.state,
    config: options.config,
    startedAt: options.startedAt ?? Date.now(),
    version: options.version ?? '0.0.0',
    commit: options.commit ?? readBuildCommit(),
    webDist: options.config.webDist,
    imprint: options.imprint ?? loadImprint(options.config.imprintPath),
    watcher: options.watcherStatus,
    limiter,
    captcha,
    sessions,
    sessionSecret,
    ipHash,
    now,
    adminToken: options.adminToken ?? readAdminToken(options.config.adminToken, options.config.adminTokenFile),
    authorsCount,
    bookCost,
    ...(emit === undefined ? {} : { emit }),
    ...(options.oauthFetch === undefined ? {} : { oauthFetch: options.oauthFetch }),
    ...(options.fb2 === undefined ? {} : { fb2: options.fb2 }),
  };

  // The WS plugin must be registered before the routes it intercepts (§README).
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 4_096, perMessageDeflate: false },
  });
  app.get('/ws', { websocket: true }, (socket, request) => {
    // The upgrade carries an `Origin`; a page on another site may not hold a socket here.
    if (!isAllowedUpgradeOrigin(request.headers.origin, options.config.publicOrigin)) {
      try {
        socket.close(1008, 'ORIGIN');
      } catch {
        /* the socket never opened */
      }
      return;
    }
    options.wsHub?.attach(socket, request);
  });

  // The application owns the CSP (§12.8, §15.3): computed for the response, sent on every
  // one, including static assets. BOOK-119: an HTML response carries the hash of the one inline
  // script of the shell *being sent*; everything else carries the base header, no hash.
  const served = servedRoot(options.config.webDist);
  const shellHashes = createShellHashes({ warn: (message) => app.log.warn(message) });
  app.addHook('onSend', async (_request, reply, payload) => {
    const contentType = String(reply.getHeader('content-type') ?? '');
    const hashes = contentType.startsWith('text/html') ? shellHashes.hashesFor(served) : [];
    reply.header('content-security-policy', buildCsp(options.config, hashes));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  // One line per request, and only fields that cannot carry a credential (§14, §17).
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        path: request.url.split('?')[0],
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  // Before the routes, and before the read budget: freshness is a property of the surface
  // (BOOK-109). The policy drops conditional headers and marks `/api/`, `/healthz` and HTML
  // `no-store`, so no handler below can hand a client a licence to reuse what it already holds.
  registerCachePolicy(app);

  // Before the routes: the read budget is a property of the surface, not of a handler.
  registerReadLimit(app, deps);

  registerStateRoutes(app, deps);
  registerAnalyticsRoutes(app, deps);
  // BOOK-138: one export memo for both surfaces — `/api/front` measures the bytes `/book.fb2`
  // sends, so the page must not build a second copy of the book to learn a length.
  const exportCache = createExportCache(exportSourceOf(deps), deps.config.coverPath);
  registerFrontRoutes(app, deps, exportCache);
  registerExportRoutes(app, deps, exportCache);
  registerCostRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerChangeRoutes(app, deps);
  registerCommentRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerHealthRoutes(app, deps);
  registerHistoryRoutes(app, deps);
  registerAuthorsRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerAdminRoutes(app, deps);

  app.addHook('onClose', async () => {
    options.wsHub?.close();
  });

  const indexFile = join(served, 'index.html');
  if (existsSync(indexFile)) {
    // The 404 handler is set *before* the static route on purpose: a route snapshots the
    // not-found context when it registers, so a handler set afterwards would never see the
    // plugin's `callNotFound` (Fastify's default 404 would answer instead).
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/healthz') {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
      }
      // BOOK-119: a missing bundle is where the white screen came from. Under `/assets/` the
      // answer is a retained release's copy or 404 JSON — the shell would parse as JavaScript,
      // throw, and leave the page blank. Every other unknown path stays the shell.
      if ((request.url.split('?')[0] ?? '').startsWith('/assets/')) {
        return answerAssetMiss(request, reply, options.config.webDist);
      }
      // One page: every unknown path is the shell, the SPA scrolls to its own anchor. Its
      // freshness is the app's policy (`http/cache.ts`), not this handler's. Two cases cannot
      // be answered with a file: a re-entry (the flag) and a root whose shell is gone — the
      // first BOOK-119 publish moves a flat `dist/index.html` into the legacy release, so for
      // the seconds before the restart the old process has no shell to send.
      if (!firstNotFoundPass(request) || !existsSync(indexFile)) {
        return reply.code(503).header('cache-control', 'no-store').send({
          code: 'UI_NOT_BUILT',
          message: 'the served shell is missing — the release is being swapped',
        });
      }
      return reply.sendFile('index.html');
    });
    // One registration, one root: `current` when a release exists, the flat `dist` otherwise
    // (Docker without a publish, fixtures, dev). The plugin keeps the root path as a string and
    // resolves per request, so the symlink is read at request time, not at boot.
    await app.register(fastifyStatic, { root: served, wildcard: true });
    // The two static documents are routed explicitly (audit M5): an operator reading a log
    // sees them as pages, not as "an unknown path that happened to get the shell".
    for (const page of ['/privacy', '/rules']) {
      app.get(page, (_request, reply) => reply.sendFile('index.html'));
    }
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url === '/' ||
        request.url === '/privacy' ||
        request.url === '/rules' ||
        request.url.startsWith('/api/') ||
        request.url === '/healthz'
      ) {
        // A missing build is a fact about *this* host just now: never a stored answer, or a
        // proxy would keep telling readers the site is down after the deploy fixed it.
        return reply.code(503).header('cache-control', 'no-store').send({
          code: 'UI_NOT_BUILT',
          message: 'web/dist is missing — run `npm run build` (or use the Vite dev server on :5173)',
        });
      }
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    // A body past the transport bound is a too-long text, not a transport detail: the reader
    // gets the same public code the sanitizer uses, never a Fastify identifier (§9, §12.4).
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ code: 'TOO_LONG', message: 'замечание или правка слишком длинные — сократите текст' });
    }
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      // Internals stay in the log: the reader gets a code, never a stack trace.
      return reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
    }
    const code = error.validation ? 'INVALID' : error.code ?? 'ERROR';
    return reply.code(status).send({ code, message: error.message });
  });

  return app;
}
