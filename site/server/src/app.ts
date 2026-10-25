import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import type { RouteDeps } from './http/deps.ts';
import { registerChapterRoutes } from './http/routes/chapters.ts';
import { registerHealthRoutes } from './http/routes/health.ts';
import { registerStateRoutes } from './http/routes/state.ts';
import type { StateService } from './ingest/stateService.ts';

export type AppOptions = {
  config: Config;
  db: Db;
  state: StateService;
  startedAt?: number;
  version?: string;
  logger?: boolean;
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  const deps: RouteDeps = {
    db: options.db,
    state: options.state,
    startedAt: options.startedAt ?? Date.now(),
    version: options.version ?? '0.0.0',
    webDist: options.config.webDist,
  };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  registerStateRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerHealthRoutes(app, deps);

  const indexFile = join(options.config.webDist, 'index.html');
  if (existsSync(indexFile)) {
    await app.register(fastifyStatic, { root: options.config.webDist, wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/healthz') {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
      }
      // One page: every unknown path is the shell, the SPA scrolls to its own anchor.
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url === '/' || request.url.startsWith('/api/') || request.url === '/healthz') {
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
