import { OPENING_CHAPTER, TOTAL_CHAPTERS, type HealthDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { frameSha } from '../../db/repo/frame.ts';
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
 * BOOK-187 (ADR-043 §5) adds three facts about the volume: the schema version it was migrated to,
 * the two hashes of the frame rows it holds, and whether this image's prompt bundle differs from
 * the one the volume recorded (`prompt_drift`, a rollback's fingerprint). All three are `meta` /
 * `book_frame` reads: no file is touched, so a probe stays as cheap as it was.
 *
 * No freshness header here: the app's one policy (`http/cache.ts`) marks `/healthz` `no-store`
 * above the route, so a failed probe (the error handler's 500) cannot be stored either.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/healthz', async (_request, reply) => {
    const lastScan = deps.db.prepare('SELECT v FROM meta WHERE k = ?').get('last_scan_at') as ValueRow | undefined;
    const lastEvent = deps.db.prepare('SELECT MAX(updated_at) AS at FROM chapters').get() as MaxRow;
    const schema = deps.db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as ValueRow | undefined;
    const drift = deps.db.prepare('SELECT v FROM meta WHERE k = ?').get('prompt_drift') as ValueRow | undefined;

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
      // The volume's own identity: which shape it was migrated to, and the frame it holds.
      schema_version: schema === undefined ? 0 : Number.parseInt(schema.v, 10),
      frame: {
        first: frameSha(deps.db, OPENING_CHAPTER, 'first'),
        last: frameSha(deps.db, TOTAL_CHAPTERS, 'last'),
      },
      prompt_drift: drift?.v ?? null,
    };
    return reply.send(body);
  });
}
