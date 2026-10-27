/**
 * BOOK-60 — `GET /book.fb2` (BOOK-DOC-41 §2, §5); BOOK-133 embeds the cover.
 *
 * The file is one edition of the manuscript: `document-info/version` is the low 52 bits of the
 * edition hash and `document-info/date` is the moment this response's bytes were built, in
 * `config.tz`. Two exports of one state share the version and differ only in the date.
 *
 * One build per edition *and cover*. The edition hash and the body are read inside one
 * `db.transaction`, so the number and the paragraphs come from one snapshot; the cover is read
 * before it (no file I/O inside the transaction) and cached by the file's size and mtime, so a
 * repeat costs one `stat` and no decode. The serializer memo is keyed by both hashes — a cover
 * swap is a different representation, not a stale copy of the old one.
 *
 * `HEAD` answers headers only and never builds. The ETag carries both untruncated hashes, which
 * is why the revalidation exemption in `http/cache.ts` is safe: the tag names the paragraphs and
 * the image, so a `304` can only ever name bytes the client already holds. A cover that cannot
 * be embedded fails the export with `503` and a code — never a coverless file and never a
 * placeholder.
 */

import { statSync } from 'node:fs';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { listBlocks, listChapterRows } from '../../db/repo/chapters.ts';
import { getFrontRow } from '../../db/repo/front.ts';
import { COVER_ID, COVER_TYPE, CoverError, loadCover, type CoverImage } from '../../fb2/cover.ts';
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

/** The serializer's whole input: nothing here comes from the seam, the history or the SPA. */
function inputOf(deps: RouteDeps, revision: number, cover: CoverImage): Fb2Input {
  const front = getFrontRow(deps.db);
  return {
    title: front !== undefined && front.title.length > 0 ? front.title : null,
    about: front !== undefined && front.about.length > 0 ? front.about : null,
    author: deps.imprint.author,
    year: deps.imprint.year,
    version: deps.version,
    srcUrl: `${deps.config.publicOrigin}/`,
    revision,
    cover: { id: COVER_ID, contentType: COVER_TYPE, base64: cover.base64 },
    chapters: listChapterRows(deps.db).map((row) => ({
      n: row.n,
      title: row.title,
      // An absent row and a row with no blocks both render as `<empty-line/>` (§3).
      paragraphs: listBlocks(deps.db, row.n).map((block) => paragraphText(block.text)),
    })),
  };
}

/** Size plus mtime is the change key: one `stat` per request, a read only on a real change. */
function statKeyOf(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${String(stats.size)}:${String(stats.mtimeMs)}`;
  } catch {
    // The read below owns the failure: it names missing and unreadable differently.
    return null;
  }
}

export function registerExportRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /** The last built edition *and cover*: the body around the date, never the date itself. */
  let memo: { key: string; head: string; tail: string } | null = null;
  let coverMemo: { key: string; cover: CoverImage } | null = null;
  const render = deps.fb2?.render ?? renderFb2;

  /** The decoded cover, read once per file version; a failure is a `CoverError`. */
  const readCover = (): CoverImage => {
    const key = statKeyOf(deps.config.coverPath);
    if (key !== null && coverMemo !== null && coverMemo.key === key) return coverMemo.cover;
    const cover = loadCover(deps.config.coverPath);
    if (key !== null) coverMemo = { key, cover };
    return cover;
  };

  /**
   * A cover that cannot be embedded is a `503` about the export, not about the reader's
   * request: no attachment headers and no partial XML, because a truncated file would be
   * offered for download as if it were the book. The path is in the log line and in the
   * message; the code is what a client branches on. An unexpected error keeps its own handler.
   */
  const coverFailure = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    if (!(error instanceof CoverError)) throw error;
    request.log.error({ coverPath: deps.config.coverPath }, 'book.fb2: the cover cannot be embedded');
    return reply.code(503).header('cache-control', 'no-store').send({ code: error.code, message: error.message });
  };

  type Answer =
    | { kind: 'not-modified'; etag: string }
    | { kind: 'body'; etag: string; revision: number; parts: Fb2Parts };

  // `exposeHeadRoute: false`: the generated HEAD would run the handler and build the file.
  app.get(FB2_PATH, { exposeHeadRoute: false }, async (request, reply) => {
    let cover: CoverImage;
    try {
      // Before the transaction: the snapshot covers the database, not the filesystem.
      cover = readCover();
    } catch (error) {
      return coverFailure(request, reply, error);
    }

    const answer = deps.db.transaction((): Answer => {
      // One snapshot: the number and the paragraphs below name the same state.
      const edition = readEdition(deps.db, deps.imprint.author);
      const etag = etagOf(edition.hash, cover.sha256);
      if (ifNoneMatch(request.headers['if-none-match'], etag)) {
        return { kind: 'not-modified', etag };
      }
      const key = `${edition.hash}:${cover.sha256}`;
      const held = memo !== null && memo.key === key ? memo : null;
      const parts = held ?? render(inputOf(deps, edition.revision, cover));
      if (held === null) memo = { key, head: parts.head, tail: parts.tail };
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
    // ETag names the edition and the cover: a reader that holds it is told so without a file
    // being built.
    let cover: CoverImage;
    try {
      // A HEAD may `stat` the cover (it needs its hash for the tag), but never re-encodes one.
      cover = readCover();
    } catch (error) {
      return coverFailure(request, reply, error);
    }

    const edition = deps.db.transaction(() => readEdition(deps.db, deps.imprint.author))();
    const etag = etagOf(edition.hash, cover.sha256);
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
