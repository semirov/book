import type { FastifyInstance } from 'fastify';

import { listCatalog } from '../../db/repo/chapters.ts';
import type { RouteDeps } from '../deps.ts';

/**
 * `GET /api/state` and `GET /api/chapters` — the SPA's poll and the опись.
 *
 * The ETag stays: it names the representation (`state-<version>`), and a client may compare it
 * with the one it remembers. It never produces a `304` — a poll must be answered with the body,
 * because the state is a statement about a book being written and a reuse of the last copy is
 * exactly the stale frame this pass removes (BOOK-109). The freshness policy is the app's
 * (`http/cache.ts`): `no-store` for both, set above the route.
 */
export function registerStateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/state', async (_request, reply) => {
    const state = deps.state.snapshot();
    return reply.header('etag', `"state-${state.version}"`).send(state);
  });

  app.get('/api/chapters', async (_request, reply) => {
    // Every slot, always: the опись is rendered from this without a request per slot.
    return reply.send(listCatalog(deps.db));
  });
}
