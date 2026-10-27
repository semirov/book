import type { AuthorsCountDto, FrontDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../../db/db.ts';
import { listCatalog } from '../../db/repo/chapters.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { RouteDeps } from '../deps.ts';

/**
 * What the byline count depends on, cheaply: the front revision, every chapter `rev`, the
 * last paragraph version written, and **which** readers are hidden (`POST /api/authors/hide`
 * moves the count without touching the text).
 *
 * The count itself is a whole-book aggregate (`authors/count.ts`): the last version of every
 * paragraph joined to `identities`. A repeated request must not pay for it, so the answer is
 * remembered under this key and invalidated by it. Every part is a small indexed read — a
 * 67-row `chapters` sum, the `block_versions_hseq` index and the reader list — never a scan
 * of the block history.
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
 * The byline (`authors`) is measured **once per book state**: the remembered count is reused
 * for every later request with the same key, so a poll costs four cheap indexed reads and no
 * aggregate (BOOK-24). Every answer is a `200` with the full body — a `304` would let a client
 * keep a byline (and a title page) that has since moved, which is the defect BOOK-109 removed
 * from the whole surface. The ETag stays and still carries the count: it is the validator a
 * proxy log or a client compares, not a licence to reuse. `measuredAt` may be older than the
 * response by up to one book state — the count cannot be different, so the client's monotonic
 * guard sees the same number, never a correction.
 */
export function registerFrontRoutes(app: FastifyInstance, deps: RouteDeps): void {
  let memo: { key: string; authors: AuthorsCountDto } | null = null;

  app.get('/api/front', async (_request, reply) => {
    const front = getFrontRow(deps.db);
    const rev = front?.rev ?? 0;
    const key = bylineKey(deps.db, rev);

    // A representation is being built: measure once per book state, and keep it.
    const remembered = memo !== null && memo.key === key ? memo.authors : null;
    const authors = remembered ?? deps.authorsCount();
    if (remembered === null) memo = { key, authors };
    reply.header('etag', frontEtag(rev, authors.count));

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
