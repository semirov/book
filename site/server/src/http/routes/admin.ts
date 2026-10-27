/**
 * The admin surface (ARCHITECTURE.md §17, §13.4 point 5): one token-guarded JSON panel.
 *
 * `/api/admin/*` answers 404 at Caddy, so this route is reachable only from inside the
 * host. It is guarded anyway, because a route that relies on the proxy for its only check is
 * one misconfigured Caddyfile away from being public:
 *
 * - no configured token → the route does not exist (404), so a forgotten secret closes the
 *   surface instead of opening it;
 * - a wrong token → 401, with no hint about the right one;
 * - the comparison is constant-time over equal-length buffers, so a wrong token does not
 *   leak its prefix through timing.
 *
 * There is no admin *write* endpoint by design (§13.1): the panel can release, cancel and
 * pause through the engine, never edit a paragraph.
 */

import type { AdminHealthDto } from '@book/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readEngineHealth } from '../../engineState/reader.ts';
import { readIntegrity } from '../../integrity/service.ts';
import { tokenMatches } from '../../util/secret.ts';
import type { RouteDeps } from '../deps.ts';

/** The constant-time compare now lives in `util/secret.ts`; re-exported for its old callers. */
export { tokenMatches };

function presented(request: FastifyRequest): string {
  const header = request.headers['x-admin-token'];
  if (typeof header === 'string') return header.trim();
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

function guard(deps: RouteDeps, request: FastifyRequest, reply: FastifyReply): boolean {
  if (deps.adminToken.length === 0) {
    void reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
    return false;
  }
  if (!tokenMatches(deps.adminToken, presented(request))) {
    void reply.code(401).send({ code: 'UNAUTHORIZED', message: 'admin token required' });
    return false;
  }
  return true;
}

export function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /**
   * The operator's health (audit m4): the counts, the version, the cover and the lane
   * holder are not for the public probe. Same guard as the integrity panel, same absence
   * rule — no configured token means the route does not exist.
   */
  app.get('/api/admin/health', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const chapters = deps.db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    const comments = deps.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number };
    const front = deps.db.prepare('SELECT COUNT(*) AS n FROM front_matter').get() as { n: number };
    const engine = readEngineHealth(deps.db, deps.now().getTime());
    const body: AdminHealthDto = {
      uptimeMs: deps.now().getTime() - deps.startedAt,
      version: deps.version,
      lane: { holder: engine.laneId },
      front: { present: front.n > 0 },
      db: { chapters: chapters.n, comments: comments.n },
      engine: { status: engine.status, heartbeatAt: engine.heartbeatAt },
    };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.get('/api/admin/integrity', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const report = readIntegrity(deps.db, {
      bookRoot: deps.config.bookRoot,
      denylistPath: deps.config.denylistPath,
      imprint: deps.imprint,
      nowMs: deps.now().getTime(),
    });
    return reply.header('cache-control', 'no-store').send(report);
  });
}
