import type { FastifyInstance } from 'fastify';

import { listCatalog } from '../../db/repo/chapters.ts';
import type { RouteDeps } from '../deps.ts';

export function registerStateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/state', async (request, reply) => {
    const state = deps.state.snapshot();
    const etag = `"state-${state.version}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'public, max-age=2, stale-while-revalidate=10');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(state);
  });

  app.get('/api/chapters', async (_request, reply) => {
    // All 67 slots, always: the опись is rendered from this without a request per slot.
    return reply.header('cache-control', 'public, max-age=2').send(listCatalog(deps.db));
  });
}
