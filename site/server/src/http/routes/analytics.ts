import type { FastifyInstance } from 'fastify';

import type { RouteDeps } from '../deps.ts';

/**
 * BOOK-63 — the counter id is configuration, served to the SPA instead of baked into the
 * bundle. One source (`METRIKA_ID`) feeds both the CSP (`http/csp.ts`) and this answer, so a
 * deployment cannot open the header for a counter the client does not load, or load one the
 * header would block.
 *
 * The id is not a secret — it is printed in every script URL — but it is not hardcoded: an
 * empty setting answers `null`, and the page then loads nothing at all.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/analytics', (_request, reply) => {
    const counter = deps.config.metrikaId.trim();
    return reply
      .header('cache-control', 'public, max-age=60')
      .send({ counter: counter.length > 0 ? counter : null });
  });
}
