import type { HealthDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { readEngineHealth } from '../../engineState/reader.ts';
import type { RouteDeps } from '../deps.ts';

type ValueRow = { v: string };
type MaxRow = { at: string | null };

/**
 * `GET /healthz` — a liveness probe, and nothing an operator can be told by a stranger
 * (audit m4). The watcher and the engine's status stay: a reader's page uses them to say
 * whether the book is being written. Counts, the version, the cover's presence and the lane
 * holder moved to `/api/admin/health`, behind the admin token.
 *
 * BOOK-109 adds the *identity* of the answering process — its commit, the two roots it reads
 * and when it started. They answer "is this the host I just deployed", which is the question
 * the owner's stale phone could not be answered with; they still say nothing about the text,
 * the queue or the pen. `deploy.sh` reads `"ok":true`, so `ok` stays the first key.
 *
 * No freshness header here: the app's one policy (`http/cache.ts`) marks `/healthz` `no-store`
 * above the route, so a failed probe (the error handler's 500) cannot be stored either.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const lastScan = deps.db.prepare('SELECT v FROM meta WHERE k = ?').get('last_scan_at') as ValueRow | undefined;
    const lastEvent = deps.db.prepare('SELECT MAX(updated_at) AS at FROM chapters').get() as MaxRow;

    // Deliberately does not touch StateService: a health poll must not bump state.version.
    const engine = readEngineHealth(deps.db, Date.now());
    const body: HealthDto = {
      ok: true,
      commit: deps.commit,
      bookRoot: deps.config.bookRoot,
      dataDir: deps.config.dataDir,
      startedAt: new Date(deps.startedAt).toISOString(),
      watcher: {
        lastTickAt: deps.watcher?.lastTickAt ?? lastScan?.v ?? null,
        lastEventAt: deps.watcher?.lastEventAt ?? lastEvent.at ?? null,
        missing: deps.watcher?.missing ?? false,
      },
      engine: { status: engine.status },
    };
    return reply.send(body);
  });
}
