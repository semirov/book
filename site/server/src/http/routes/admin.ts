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
 * The book still has no write API (§13.1): the panel can release, cancel and pause through the
 * engine and — BOOK-113 — clear or exempt one identity's *budget state*, which is operational
 * data about a reader, not the manuscript. No route here edits a paragraph.
 *
 * Both budget routes take one identity in any of the three forms an operator has at hand
 * (`identity/resolve.ts` documents them): the internal id `idt_…`, the display name (trimmed,
 * case-insensitive), or the 12-hex public alias. Unknown → 404, more than one match → 409 with
 * the candidates; the route never guesses.
 *
 * The loopback-only rule is the CLI's (`bin/admin.mjs` refuses a non-local target), because a
 * deployed process binds `192.168.1.76` and a route that trusts `remoteAddress` would have to
 * know the deployment's own address list. Caddy still hides `/api/admin/*` from the public.
 */

import type { AdminHealthDto } from '@book/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readEngineHealth } from '../../engineState/reader.ts';
import { resolveIdentity } from '../../identity/resolve.ts';
import { readIntegrity } from '../../integrity/service.ts';
import { resetIdentityBudget } from '../../rate/reset.ts';
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

/** The identity a body names, or the line the operator must fix. */
function identityOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as { identity?: unknown }).identity;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}

/**
 * One resolver for both routes: 404 for no match, 409 with the candidates for more than one.
 * A `reply` is sent before `null`, so the caller only has to return it.
 */
function resolved(
  deps: RouteDeps,
  reply: FastifyReply,
  query: string,
): { id: string; displayName: string; editExempt: number } | null {
  const match = resolveIdentity(deps.db, query);
  if (match.ok === true) return match.identity;
  if (match.code === 'AMBIGUOUS') {
    void reply.code(409).send({
      code: 'AMBIGUOUS',
      message: 'имя совпадает у нескольких читателей — уточните по id или alias',
      candidates: match.candidates,
    });
    return null;
  }
  void reply.code(404).send({ code: 'NOT_FOUND', message: 'читатель не найден' });
  return null;
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

  /**
   * BOOK-113 — clear one identity's budget rows: `edit:id:`, `cmt:id:` and every
   * `edit:ip:` reachable through that identity's own comments. One transaction; the answer
   * carries counts only, never a key or a hash.
   */
  app.post('/api/admin/budget/reset', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const query = identityOf(request.body);
    if (query === null) {
      return reply.code(400).send({ code: 'INVALID', message: 'нужно поле identity: id, имя или alias' });
    }
    const identity = resolved(deps, reply, query);
    if (identity === null) return reply;
    const removed = resetIdentityBudget(deps.db, identity.id);
    return reply.header('cache-control', 'no-store').send({
      identity: { id: identity.id, displayName: identity.displayName },
      removed,
    });
  });

  /**
   * BOOK-113 — turn the daily edit exemption on or off for one identity. The previous and the
   * current value are both returned, so a no-op toggle is visible as such (`1 → 1`).
   */
  app.post('/api/admin/budget/exempt', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const query = identityOf(request.body);
    const exempt = (request.body as { exempt?: unknown } | null)?.exempt;
    if (query === null || typeof exempt !== 'boolean') {
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'нужны поля identity (id, имя или alias) и exempt (true|false)' });
    }
    const identity = resolved(deps, reply, query);
    if (identity === null) return reply;
    const previous = identity.editExempt === 0 ? 0 : 1;
    const current = exempt ? 1 : 0;
    deps.db.prepare('UPDATE identities SET edit_exempt = ? WHERE id = ?').run(current, identity.id);
    return reply.header('cache-control', 'no-store').send({
      identity: { id: identity.id, displayName: identity.displayName },
      previous,
      current,
    });
  });
}
