import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';

import type { Imprint, ServerEventType } from '@book/shared';
import { createCaptchaVerifier, type CaptchaVerifier } from './captcha/verify.ts';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import type { RouteDeps } from './http/deps.ts';
import { buildCsp } from './http/csp.ts';
import { isAllowedUpgradeOrigin } from './http/origin.ts';
import { registerReadLimit } from './http/readLimit.ts';
import { registerAdminRoutes } from './http/routes/admin.ts';
import { registerAuthRoutes } from './http/routes/auth.ts';
import { registerAuthorsRoutes } from './http/routes/authors.ts';
import { registerChangeRoutes } from './http/routes/changes.ts';
import { registerChapterRoutes } from './http/routes/chapters.ts';
import { registerCommentRoutes } from './http/routes/comments.ts';
import { registerFrontRoutes } from './http/routes/front.ts';
import { registerHealthRoutes } from './http/routes/health.ts';
import { registerHistoryRoutes } from './http/routes/history.ts';
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
  logger?: boolean;
  /** Test seam: receives the JSON log lines, so a test can assert what is *not* logged. */
  logStream?: { write(line: string): void };
  /** §12.8 test seam: a stub verifier instead of a network call. */
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
    bodyLimit: 64 * 1024,
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

  const deps: RouteDeps = {
    db: options.db,
    state: options.state,
    config: options.config,
    startedAt: options.startedAt ?? Date.now(),
    version: options.version ?? '0.0.0',
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
    ...(emit === undefined ? {} : { emit }),
    ...(options.oauthFetch === undefined ? {} : { oauthFetch: options.oauthFetch }),
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

  // The application owns the CSP (§12.8, §15.3): computed once, sent on every response,
  // including static assets. Caddy must not add a second header.
  const csp = buildCsp(options.config);
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('content-security-policy', csp);
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

  // Before the routes: the read budget is a property of the surface, not of a handler.
  registerReadLimit(app, deps);

  registerStateRoutes(app, deps);
  registerFrontRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerChangeRoutes(app, deps);
  registerCommentRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerHealthRoutes(app, deps);
  registerHistoryRoutes(app, deps);
  registerAuthorsRoutes(app, deps);
  registerAdminRoutes(app, deps);

  app.addHook('onClose', async () => {
    options.wsHub?.close();
  });

  const indexFile = join(options.config.webDist, 'index.html');
  if (existsSync(indexFile)) {
    await app.register(fastifyStatic, { root: options.config.webDist, wildcard: true });
    // The two static documents are routed explicitly (audit M5): an operator reading a log
    // sees them as pages, not as "an unknown path that happened to get the shell".
    for (const page of ['/privacy', '/rules']) {
      app.get(page, (_request, reply) => reply.sendFile('index.html'));
    }
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/healthz') {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
      }
      // One page: every unknown path is the shell, the SPA scrolls to its own anchor.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url === '/' ||
        request.url === '/privacy' ||
        request.url === '/rules' ||
        request.url.startsWith('/api/') ||
        request.url === '/healthz'
      ) {
        return reply.code(503).send({
          code: 'UI_NOT_BUILT',
          message: 'web/dist is missing — run `npm run build` (or use the Vite dev server on :5173)',
        });
      }
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
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
