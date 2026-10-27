import type { AuthorsCountDto, FrontDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../../db/db.ts';
import { listCatalog } from '../../db/repo/chapters.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { RouteDeps } from '../deps.ts';

/** The response's own freshness bound — the same five seconds page 1 is allowed to be old. */
const FRONT_CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=30';

/**
 * What the byline count depends on, cheaply: the front revision, every chapter `rev`, the
 * last paragraph version written, and **which** readers are hidden (`POST /api/authors/hide`
 * moves the count without touching the text).
 *
 * The count itself is a whole-book aggregate (`authors/count.ts`): the last version of every
 * paragraph joined to `identities`. A conditional request must not pay for it, so the ETag is
 * compared against a remembered count that this key invalidates. Every part is a small
 * indexed read — a 67-row `chapters` sum, the `block_versions_hseq` index and the reader list
 * — never a scan of the block history.
 */
function bylineKey(db: Db, frontRev: number): string {
  const chapters = db.prepare('SELECT COALESCE(SUM(rev), 0) AS revs FROM chapters').get() as { revs: number };
  // The set, not a count: two readers swapping the flag keep the same sum but not the same byline.
  const hidden = db
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(id), '') AS ids
         FROM (SELECT id FROM identities WHERE hide_from_authors = 1 ORDER BY id)`,
    )
    .get() as { ids: string };
  // Paragraph versions are append-only: the newest one is the last write of prose.
  const lastBlock = db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM block_versions').get() as { hseq: number };
  return `${frontRev}|${chapters.revs}|${lastBlock.hseq}|${hidden.ids}`;
}

/** N is part of the representation, so it is part of the validator (§10, BOOK-DOC-4). */
function frontEtag(frontRev: number, count: number): string {
  return `"front-${frontRev}-a${count}"`;
}

/**
 * `GET /api/front` — the live title + annotation + TOC + imprint in one call (§9). The
 * TOC is a projection of the 67 catalog rows, never stored; `about` is null when the
 * annotation is malformed, and page 2 then renders nothing (§11.8). `aboutSha256` is the
 * hash of the published page 2 — the basis an owner edit replaces and a pass may not (BOOK-7).
 *
 * The byline (`authors`) is measured **after** the conditional request has been answered
 * from the remembered count, so a `304` costs four cheap indexed reads and no aggregate (BOOK-24).
 * A `200` still carries the count, and its ETag still carries the count: a cached page may
 * not pin a byline that has since changed. `measuredAt` may be older than the response by
 * up to one book state — the count cannot be different, so the client's monotonic guard sees
 * the same number, never a correction.
 */
export function registerFrontRoutes(app: FastifyInstance, deps: RouteDeps): void {
  let memo: { key: string; authors: AuthorsCountDto } | null = null;

  app.get('/api/front', async (request, reply) => {
    const front = getFrontRow(deps.db);
    const rev = front?.rev ?? 0;
    const key = bylineKey(deps.db, rev);

    // 1) The conditional request, answered without measuring anything.
    const remembered = memo !== null && memo.key === key ? memo.authors : null;
    if (remembered !== null) {
      const etag = frontEtag(rev, remembered.count);
      reply.header('etag', etag).header('cache-control', FRONT_CACHE_CONTROL);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    }

    // 2) A representation is being built: measure once per book state, and keep it.
    const authors = remembered ?? deps.authorsCount();
    if (remembered === null) memo = { key, authors };
    const etag = frontEtag(rev, authors.count);
    reply.header('etag', etag).header('cache-control', FRONT_CACHE_CONTROL);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();

    const about = front !== undefined && front.about.length > 0 ? front.about : null;
    const body: FrontDto = {
      title: front !== undefined && front.title.length > 0 ? front.title : null,
      about,
      aboutSha256: about === null ? null : front?.about_sha256 || sha256Hex(about),
      rev,
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
