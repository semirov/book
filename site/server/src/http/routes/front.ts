import type { FrontDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { listCatalog } from '../../db/repo/chapters.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { RouteDeps } from '../deps.ts';

/**
 * `GET /api/front` — the live title + annotation + TOC + imprint in one call (§9). The
 * TOC is a projection of the 67 catalog rows, never stored; `about` is null when the
 * annotation is malformed, and page 2 then renders nothing (§11.8). `aboutSha256` is the
 * hash of the published page 2 — the basis an owner edit replaces and a pass may not (BOOK-7).
 */
export function registerFrontRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/front', async (request, reply) => {
    const front = getFrontRow(deps.db);
    // N is part of the representation, so it is part of the validator: a cached 200 may not
    // pin a byline that has since changed. `measuredAt` may drift between two readings of
    // the same count; that token is older, so the client's monotonic guard only becomes
    // more permissive — it can never make page 1 wrong.
    const authors = deps.authorsCount();
    const etag = `"front-${front?.rev ?? 0}-a${authors.count}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'public, max-age=5, stale-while-revalidate=30');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();

    const about = front !== undefined && front.about.length > 0 ? front.about : null;
    const body: FrontDto = {
      title: front !== undefined && front.title.length > 0 ? front.title : null,
      about,
      aboutSha256: about === null ? null : front?.about_sha256 || sha256Hex(about),
      rev: front?.rev ?? 0,
      toc: listCatalog(deps.db).map((entry) => ({
        part: entry.part,
        n: entry.n,
        title: entry.title,
        written: entry.written,
        rev: entry.rev,
      })),
      imprint: { author: deps.imprint.author, copyright: deps.imprint.copyright },
      authors,
    };
    return reply.send(body);
  });
}
