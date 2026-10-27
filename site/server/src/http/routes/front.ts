import type { AuthorsCountDto, FrontDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { bookStateKey } from '../../db/bookKey.ts';
import { listCatalog } from '../../db/repo/chapters.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { readEdition } from '../../fb2/edition.ts';
import { createExportCache, exportSourceOf, type ExportCache } from '../../fb2/exportCache.ts';
import { dateElement, exportMoment } from '../../fb2/serialize.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { RouteDeps } from '../deps.ts';

/**
 * N is part of the representation, so it is part of the validator (§10, BOOK-DOC-4). BOOK-60:
 * the edition number is too — the tag names the same state `/book.fb2` writes as `version`, so
 * a page and a downloaded file can never disagree about which edition they are.
 */
function frontEtag(frontRev: number, count: number, revision: number): string {
  return `"front-${frontRev}-a${count}-e${revision}"`;
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
 *
 * BOOK-138: `exportBytes` is the size of the file `/book.fb2` answers with for this edition. It
 * is measured from the **same parts** the export sends — the shared cache holds them, so the
 * page and the download never build two different books — and the date element is inserted the
 * way the export inserts it, with the same clock and zone. The test pins the invariant: the
 * number here equals that answer's `content-length` for one edition and one `now`.
 *
 * BOOK-133: a cover that cannot be embedded is not page 1's failure. The export answers `503`
 * and names the code; this route sends the payload without `exportBytes`, and the link prints
 * the verb alone — a page is a statement about the manuscript, not about an image.
 */
export function registerFrontRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  /** BOOK-138: the export's own memo, shared with `registerExportRoutes`; a fresh one by default. */
  cache: ExportCache = createExportCache(exportSourceOf(deps), deps.config.coverPath),
): void {
  let memo: { key: string; authors: AuthorsCountDto } | null = null;

  app.get('/api/front', async (_request, reply) => {
    const front = getFrontRow(deps.db);
    const rev = front?.rev ?? 0;
    const key = bookStateKey(deps.db, rev);
    // BOOK-60/BOOK-138: the edition and the export's bytes come from one snapshot, and the
    // byte length is the whole answer — the parts' measured length, this moment's date element,
    // UTF-8. The parts are already measured, so a poll never concatenates the file.
    const { revision, exportBytes } = deps.db.transaction(() => {
      const edition = readEdition(deps.db, deps.imprint.author);
      const moment = exportMoment(deps.now(), deps.config.tz);
      const resolved = cache.resolve(edition);
      if (resolved.kind === 'cover-error') {
        // BOOK-133: never a 500/503 here — the link prints the verb alone and `/book.fb2`
        // names the fault with its code.
        return { revision: edition.revision, exportBytes: null };
      }
      return {
        revision: edition.revision,
        exportBytes: resolved.entry().bytes + Buffer.byteLength(dateElement(moment), 'utf8'),
      };
    })();

    // A representation is being built: measure once per book state, and keep it.
    const remembered = memo !== null && memo.key === key ? memo.authors : null;
    const authors = remembered ?? deps.authorsCount();
    if (remembered === null) memo = { key, authors };
    reply.header('etag', frontEtag(rev, authors.count, revision));

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
      revision,
      // BOOK-133: absent when the cover cannot be embedded — a size the page cannot measure is
      // not invented, and the link then prints the verb alone.
      ...(exportBytes === null ? {} : { exportBytes }),
      // BOOK-126: already validated at boot (`donateUrlOf`), so the page prints it or nothing.
      donateUrl: deps.config.donateUrl,
    };
    return reply.send(body);
  });
}
