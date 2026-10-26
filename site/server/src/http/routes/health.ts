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
 */
export function registerHealthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const lastScan = deps.db.prepare('SELECT v FROM meta WHERE k = ?').get('last_scan_at') as ValueRow | undefined;
    const lastEvent = deps.db.prepare('SELECT MAX(updated_at) AS at FROM chapters').get() as MaxRow;

    // Deliberately does not touch StateService: a health poll must not bump state.version.
    const engine = readEngineHealth(deps.db, Date.now());
    const body: HealthDto = {
      ok: true,
      watcher: {
        lastTickAt: deps.watcher?.lastTickAt ?? lastScan?.v ?? null,
        lastEventAt: deps.watcher?.lastEventAt ?? lastEvent.at ?? null,
        missing: deps.watcher?.missing ?? false,
      },
      engine: { status: engine.status },
    };
    return reply.header('cache-control', 'no-store').send(body);
  });
}
