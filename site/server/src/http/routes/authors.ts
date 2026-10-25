/**
 * The end matter's authors list (§6C.5). Public and cacheable: the list is measured, not
 * live, so a reader reloading the page must see the same numbers (rule 6).
 */

import type { FastifyInstance } from 'fastify';

import { readAuthors } from '../../authors/contributions.ts';
import type { RouteDeps } from '../deps.ts';

export function registerAuthorsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/authors', async (_request, reply) => {
    return reply
      .header('cache-control', 'public, max-age=30')
      .send(readAuthors(deps.db, deps.imprint.author));
  });
}
