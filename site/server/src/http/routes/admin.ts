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

import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readIntegrity } from '../../integrity/service.ts';
import type { RouteDeps } from '../deps.ts';

/** Constant-time compare that also hides the length (a length oracle is a prefix oracle). */
export function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length === 0) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  if (left.length !== right.length) {
    // Still compare something of the same length, so the work does not depend on the guess.
    const padded = Buffer.alloc(left.length);
    right.copy(padded, 0, 0, Math.min(right.length, left.length));
    timingSafeEqual(left, padded);
    return false;
  }
  return timingSafeEqual(left, right);
}

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
