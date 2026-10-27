/**
 * BOOK-60 — `GET /book.fb2` (BOOK-DOC-41 §2, §5); BOOK-133 embeds the cover, BOOK-138 shares
 * the build with `/api/front`.
 *
 * The file is one edition of the manuscript: `document-info/version` is the low 52 bits of the
 * edition hash and `document-info/date` is the moment this response's bytes were built, in
 * `config.tz`. Two exports of one state share the version and differ only in the date.
 *
 * One build per edition *and cover*, and it is not this route's own: the parts live in
 * `fb2/exportCache.ts`, which `/api/front` reads too — so a repeat costs one concat, a `304`
 * costs the two hash reads and the cover's `stat`, and the size the page prints is this
 * answer's `content-length`, not a second build. The edition hash and the body are read inside
 * one `db.transaction`, so the number and the paragraphs come from one snapshot; the cover is
 * resolved in the same call and cached by the file's size and mtime, so a repeat costs one
 * `stat` and no decode. The memo is keyed by both hashes — a cover swap is a different
 * representation, not a stale copy of the old one — because the cover is not part of the
 * edition hash.
 *
 * `HEAD` answers headers only and never builds. The ETag carries both untruncated hashes, which
 * is why the revalidation exemption in `http/cache.ts` is safe: the tag names the paragraphs and
 * the image, so a `304` can only ever name bytes the client already holds. The answer is
 * `no-store` all the same (BOOK-138) — the edition changes with every chapter, so a stored copy
 * is a stale copy by construction; the tag stays, and an explicit `If-None-Match` still gets a
 * truthful `304`. A cover that cannot be embedded fails the export with `503` and a code —
 * never a coverless file and never a placeholder.
 *
 * The name a reader saves is the book's own: «Бланк.fb2», in both the ASCII fallback and the
 * UTF-8 form (RFC 6266) — BOOK-138. The edition number is not in the name: it is in the file
 * (`document-info/version`) and on the ETag, where it names something the reader cannot mistype.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CoverError } from '../../fb2/cover.ts';
import { readEdition } from '../../fb2/edition.ts';
import type { ExportCache, HeldExport } from '../../fb2/exportCache.ts';
import { createExportCache, exportSourceOf } from '../../fb2/exportCache.ts';
import { dateElement, exportMoment } from '../../fb2/serialize.ts';
import type { RouteDeps } from '../deps.ts';

export const FB2_PATH = '/book.fb2';
/** The de-facto FB2 type: `+xml` still tells a reader it is XML. */
const CONTENT_TYPE = 'application/x-fictionbook+xml; charset=utf-8';
/** BOOK-138: the book's name, and the only source of the saved filename. */
const FILE_NAME = 'Бланк';
/**
 * Both forms of the name (RFC 6266): `filename` is the ASCII fallback every client reads,
 * `filename*` carries «Бланк» as percent-encoded UTF-8. Built from `FILE_NAME`, never pasted as
 * escapes, so a rename cannot leave one form behind.
 */
const CONTENT_DISPOSITION = `attachment; filename="blank.fb2"; filename*=UTF-8''${encodeURIComponent(FILE_NAME)}.fb2`;

/** BOOK-133: the edition and the image, both untruncated — a cover swap must move the tag. */
function etagOf(hash: string, coverSha256: string): string {
  return `"fb2-${hash}-${coverSha256}"`;
}

/** `If-None-Match` is a list, and a weak tag names the same representation on this surface. */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').some((tag) => {
    const candidate = tag.trim();
    return candidate === etag || candidate === `W/${etag}`;
  });
}

/**
 * BOOK-138: the cache is a parameter with a fresh default, so a caller that registers
 * one route (a test of the export alone) still gets a working memo without constructing one.
 */
export function registerExportRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  cache: ExportCache = createExportCache(exportSourceOf(deps), deps.config.coverPath),
): void {
  /**
   * A cover that cannot be embedded is a `503` about the export, not about the reader's
   * request: no attachment headers and no partial XML, because a truncated file would be
   * offered for download as if it were the book. The path is in the log line and in the
   * message; the code is what a client branches on.
   */
  const coverFailure = (request: FastifyRequest, reply: FastifyReply, error: CoverError): FastifyReply => {
    request.log.error({ coverPath: deps.config.coverPath }, 'book.fb2: the cover cannot be embedded');
    return reply.code(503).header('cache-control', 'no-store').send({ code: error.code, message: error.message });
  };

  type Answer =
    | { kind: 'not-modified'; etag: string }
    | { kind: 'cover-error'; error: CoverError }
    | { kind: 'body'; etag: string; entry: HeldExport };

  // `exposeHeadRoute: false`: the generated HEAD would run the handler and build the file.
  app.get(FB2_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    const answer = deps.db.transaction((): Answer => {
      // One snapshot: the number and the paragraphs below name the same state.
      const edition = readEdition(deps.db, deps.imprint.author);
      // The cover is resolved with the edition, but the parts are built only for a body: a
      // `304` names bytes the client already holds and builds none of them.
      const resolved = cache.resolve(edition);
      if (resolved.kind === 'cover-error') return { kind: 'cover-error', error: resolved.error };
      const etag = etagOf(edition.hash, resolved.cover.sha256);
      if (ifNoneMatch(request.headers['if-none-match'], etag)) {
        return { kind: 'not-modified', etag };
      }
      return { kind: 'body', etag, entry: resolved.entry() };
    })();

    if (answer.kind === 'cover-error') return coverFailure(request, reply, answer.error);

    if (answer.kind === 'not-modified') {
      // The export moment is a property of a body; a `304` produced none, so it carries none.
      return reply.code(304).header('etag', answer.etag).header('cache-control', 'no-store').send();
    }

    const moment = exportMoment(deps.now(), deps.config.tz);
    return reply
      .code(200)
      .header('content-type', CONTENT_TYPE)
      .header('content-disposition', CONTENT_DISPOSITION)
      .header('etag', answer.etag)
      .header('cache-control', 'no-store')
      .header('x-export-date', moment.text)
      .send(answer.entry.parts.head + dateElement(moment) + answer.entry.parts.tail);
  });

  app.head(FB2_PATH, async (request, reply) => {
    // Two indexed reads, one `stat` and no build: a HEAD names the file a GET would send, and
    // claims no export moment of its own (no bytes were built). It revalidates like the GET,
    // because the ETag names the edition and the cover: a reader that holds it is told so
    // without a file being built.
    type HeadAnswer = { kind: 'cover-error'; error: CoverError } | { kind: 'etag'; etag: string };

    const answer = deps.db.transaction((): HeadAnswer => {
      const edition = readEdition(deps.db, deps.imprint.author);
      // A HEAD may `stat` the cover (it needs its hash for the tag), but never re-encodes one,
      // and never asks the cache for the parts.
      const resolved = cache.resolve(edition);
      if (resolved.kind === 'cover-error') return { kind: 'cover-error', error: resolved.error };
      return { kind: 'etag', etag: etagOf(edition.hash, resolved.cover.sha256) };
    })();

    if (answer.kind === 'cover-error') return coverFailure(request, reply, answer.error);

    if (ifNoneMatch(request.headers['if-none-match'], answer.etag)) {
      return reply.code(304).header('etag', answer.etag).header('cache-control', 'no-store').send();
    }
    return reply
      .code(200)
      .header('content-type', CONTENT_TYPE)
      .header('content-disposition', CONTENT_DISPOSITION)
      .header('etag', answer.etag)
      .header('cache-control', 'no-store')
      .send();
  });
}
