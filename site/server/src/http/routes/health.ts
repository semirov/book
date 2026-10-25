import type { HealthDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { readEngineHealth } from '../../engineState/reader.ts';
import type { RouteDeps } from '../deps.ts';

type CountRow = { n: number };
type MaxRow = { at: string | null };
type ValueRow = { v: string };

export function registerHealthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const chapters = deps.db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as CountRow;
    const comments = deps.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as CountRow;
    const front = deps.db.prepare('SELECT COUNT(*) AS n FROM front_matter').get() as CountRow;
    const lastScan = deps.db.prepare('SELECT v FROM meta WHERE k = ?').get('last_scan_at') as ValueRow | undefined;
    const lastEvent = deps.db.prepare('SELECT MAX(updated_at) AS at FROM chapters').get() as MaxRow;

    // Deliberately does not touch StateService: a health poll must not bump state.version.
    const engine = readEngineHealth(deps.db, Date.now());
    const body: HealthDto = {
      ok: true,
      uptimeMs: Date.now() - deps.startedAt,
      version: deps.version,
      watcher: {
        lastTickAt: deps.watcher?.lastTickAt ?? lastScan?.v ?? null,
        lastEventAt: deps.watcher?.lastEventAt ?? lastEvent.at ?? null,
        missing: deps.watcher?.missing ?? false,
      },
      engine: { status: engine.status, heartbeatAt: engine.heartbeatAt },
      lane: { holder: engine.laneId },
      front: { present: front.n > 0 },
      db: { chapters: chapters.n, comments: comments.n },
    };
    return reply.header('cache-control', 'no-store').send(body);
  });
}
