/**
 * BOOK-60 — `GET /book.fb2` (BOOK-DOC-41 §2, §5).
 *
 * The file is one edition of the manuscript: `document-info/version` is the low 52 bits of the
 * edition hash and `document-info/date` is the moment this response's bytes were built, in
 * `config.tz`. Two exports of one state share the version and differ only in the date.
 *
 * One build per edition. The edition hash and the body are read inside one `db.transaction`, so
 * the number and the paragraphs come from one snapshot; a memo in this closure keeps the
 * serialized body around the date placeholder, so a repeat costs one concat and a `304` costs
 * the two hash reads, a string compare and one read-budget slot — no block, no serializer.
 *
 * `HEAD` answers headers only and never builds. The ETag is the untruncated hash, which is why
 * the revalidation exemption in `http/cache.ts` is safe: the tag names the paragraphs, so a
 * `304` can only ever name the paragraphs the client already holds.
 */

import type { FastifyInstance } from 'fastify';

import { listBlocks, listChapterRows } from '../../db/repo/chapters.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { readEdition } from '../../fb2/edition.ts';
import {
  dateElement,
  exportMoment,
  paragraphText,
  renderFb2,
  type Fb2Input,
  type Fb2Parts,
} from '../../fb2/serialize.ts';
import type { RouteDeps } from '../deps.ts';

export const FB2_PATH = '/book.fb2';
/** The de-facto FB2 type: `+xml` still tells a reader it is XML. */
const CONTENT_TYPE = 'application/x-fictionbook+xml; charset=utf-8';

function etagOf(hash: string): string {
  return `"fb2-${hash}"`;
}

/** `If-None-Match` is a list, and a weak tag names the same representation on this surface. */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((tag) => {
    const candidate = tag.trim();
    return candidate === etag || candidate === `W/${etag}`;
  });
}

/** The serializer's whole input: nothing here comes from the seam, the history or the SPA. */
function inputOf(deps: RouteDeps, revision: number): Fb2Input {
  const front = getFrontRow(deps.db);
  return {
    title: front !== undefined && front.title.length > 0 ? front.title : null,
    about: front !== undefined && front.about.length > 0 ? front.about : null,
    author: deps.imprint.author,
    year: deps.imprint.year,
    version: deps.version,
    srcUrl: `${deps.config.publicOrigin}/`,
    revision,
    chapters: listChapterRows(deps.db).map((row) => ({
      n: row.n,
      title: row.title,
      // An absent row and a row with no blocks both render as `<empty-line/>` (§3).
      paragraphs: listBlocks(deps.db, row.n).map((block) => paragraphText(block.text)),
    })),
  };
}

export function registerExportRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /** The last built edition: the body around the date, never the date itself. */
  let memo: { hash: string; head: string; tail: string } | null = null;
  const render = deps.fb2?.render ?? renderFb2;

  type Answer =
    | { kind: 'not-modified'; etag: string }
    | { kind: 'body'; etag: string; revision: number; parts: Fb2Parts };

  // `exposeHeadRoute: false`: the generated HEAD would run the handler and build the file.
  app.get(FB2_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    const answer = deps.db.transaction((): Answer => {
      // One snapshot: the number and the paragraphs below name the same state.
      const edition = readEdition(deps.db, deps.imprint.author);
      const etag = etagOf(edition.hash);
      if (ifNoneMatch(request.headers['if-none-match'], etag)) {
        return { kind: 'not-modified', etag };
      }
      const held = memo !== null && memo.hash === edition.hash ? memo : null;
      const parts = held ?? render(inputOf(deps, edition.revision));
      if (held === null) memo = { hash: edition.hash, head: parts.head, tail: parts.tail };
      return { kind: 'body', etag, revision: edition.revision, parts };
    })();

    if (answer.kind === 'not-modified') {
      // The export moment is a property of a body; a `304` produced none, so it carries none.
      return reply.code(304).header('etag', answer.etag).header('cache-control', 'no-cache').send();
    }

    const moment = exportMoment(deps.now(), deps.config.tz);
    return reply
      .code(200)
      .header('content-type', CONTENT_TYPE)
      .header('content-disposition', `attachment; filename="blank-${answer.revision}.fb2"`)
      .header('etag', answer.etag)
      .header('cache-control', 'no-cache')
      .header('x-export-date', moment.text)
      .send(answer.parts.head + dateElement(moment) + answer.parts.tail);
  });

  app.head(FB2_PATH, async (request, reply) => {
    // Two indexed reads and no build: a HEAD names the file a GET would send, and claims no
    // export moment of its own (no bytes were built). It revalidates like the GET, because the
    // ETag is the edition: a reader that holds it is told so without a file being built.
    const edition = deps.db.transaction(() => readEdition(deps.db, deps.imprint.author))();
    const etag = etagOf(edition.hash);
    if (ifNoneMatch(request.headers['if-none-match'], etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', 'no-cache').send();
    }
    return reply
      .code(200)
      .header('content-type', CONTENT_TYPE)
      .header('content-disposition', `attachment; filename="blank-${edition.revision}.fb2"`)
      .header('etag', etag)
      .header('cache-control', 'no-cache')
      .send();
  });
}
