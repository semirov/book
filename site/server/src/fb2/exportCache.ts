/**
 * BOOK-60 / BOOK-138 — one edition's export bytes *and its cover*, built once for both surfaces.
 *
 * `/book.fb2` sends the file, and `/api/front` states how big the file is. The two numbers must
 * name the same bytes, and a page load must not pay a second build of the whole book to learn a
 * length — so this module holds one answer's parts (the body split around the date element) and
 * both route registrations ask the same instance for them. `head`/`tail` are what the memo can
 * hold: the date is the response's own moment, so it is inserted per answer, never stored.
 *
 * BOOK-133/BOOK-138: the cover is part of the representation but **not** part of the edition
 * hash (the hash covers the manuscript's stored file hashes only), so the memo's key is the
 * edition hash *and* the cover's sha256. Keying by the hash alone would serve the previous
 * `<binary>` after a cover swap — and then `/api/front` would print the old file's size for the
 * new file. The cover itself is resolved by the file's size and mtime, so a repeat costs one
 * `stat` and no decode.
 *
 * The memo also keeps the byte length of `head` + `tail`, measured once at build: the answer's
 * size is that number plus its own date element, so a poll of `/api/front` never concatenates
 * or re-encodes 1.5 MB to learn a length.
 *
 * The memo is memory only. It is replaced when the key moves and is never written to disk: a
 * restart rebuilds from the manuscript and the image, which are the only sources there are.
 */

import { statSync } from 'node:fs';

import type { Imprint } from '@book/shared';

import type { Db } from '../db/db.ts';
import { listBlocks, listChapterRows } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { COVER_ID, COVER_TYPE, CoverError, loadCover, type CoverImage } from './cover.ts';
import type { Edition } from './edition.ts';
import { paragraphText, renderFb2, type Fb2Input, type Fb2Parts, type Fb2Renderer } from './serialize.ts';

/** What a build reads: the snapshot, the imprint, the build's version and the serializer. */
export type ExportSource = {
  db: Db;
  imprint: Imprint;
  version: string;
  /** `config.publicOrigin` — the file's `src-url`. */
  publicOrigin: string;
  /** `deps.fb2?.render` in tests (a counting wrapper), `renderFb2` in production. */
  render: Fb2Renderer;
};

/**
 * The one place the serializer seam is resolved, so the page and the file cannot be built by
 * two different renderers — the size `/api/front` prints would then describe a file nobody
 * receives.
 */
export function exportSourceOf(deps: {
  db: Db;
  imprint: Imprint;
  version: string;
  config: { publicOrigin: string };
  fb2?: { render: Fb2Renderer };
}): ExportSource {
  return {
    db: deps.db,
    imprint: deps.imprint,
    version: deps.version,
    publicOrigin: deps.config.publicOrigin,
    render: deps.fb2?.render ?? renderFb2,
  };
}

/** The serializer's whole input: nothing here comes from the seam, the history or the SPA. */
function inputOf(source: ExportSource, revision: number, cover: CoverImage): Fb2Input {
  const front = getFrontRow(source.db);
  return {
    title: front !== undefined && front.title.length > 0 ? front.title : null,
    about: front !== undefined && front.about.length > 0 ? front.about : null,
    author: source.imprint.author,
    year: source.imprint.year,
    version: source.version,
    srcUrl: `${source.publicOrigin}/`,
    revision,
    // BOOK-133: the image travels as data; this module owns reading it, never the renderer.
    cover: { id: COVER_ID, contentType: COVER_TYPE, base64: cover.base64 },
    chapters: listChapterRows(source.db).map((row) => ({
      n: row.n,
      title: row.title,
      // An absent row and a row with no blocks both render as `<empty-line/>` (§3).
      paragraphs: listBlocks(source.db, row.n).map((block) => paragraphText(block.text)),
    })),
  };
}

/**
 * Build one edition's parts. The cache runs it inside its caller's transaction: the edition hash
 * and the paragraphs must come from one snapshot, or a memo would hold bytes for a state nobody
 * named. The cover is the one the memo's key names, so head and tail describe the same image.
 */
function buildParts(source: ExportSource, revision: number, cover: CoverImage): Fb2Parts {
  return source.render(inputOf(source, revision, cover));
}

/** One edition *and cover*, as both surfaces hold it. */
export type HeldExport = {
  /** The file split around the date element. */
  parts: Fb2Parts;
  /** The image the file carries — the one whose sha256 is in the key. */
  cover: CoverImage;
  /** `Buffer.byteLength(head) + Buffer.byteLength(tail)`, measured once at build. */
  bytes: number;
};

/**
 * What a request gets from the cache: the cover (so the route can name the representation) and
 * a lazily built entry, or the reason the cover cannot be embedded at all.
 */
export type ExportResolution =
  | { kind: 'cover-error'; error: CoverError }
  | {
      kind: 'export';
      cover: CoverImage;
      /**
       * The entry for this edition and this cover: the memo's when the key is the held one, a
       * build otherwise. Nothing is built until it is called, so a `304` and a `HEAD` pay a
       * `stat` and no file — which is the whole point of keeping the split.
       */
      entry: () => HeldExport;
    };

/** One edition's parts, held until the edition or its cover moves. */
export type ExportCache = {
  /**
   * Resolve the answer for `edition`. Call it inside the caller's `db.transaction`: the hash and
   * the paragraphs must come from one snapshot.
   */
  resolve: (edition: Edition) => ExportResolution;
};

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

export function createExportCache(source: ExportSource, coverPath: string): ExportCache {
  /** The last built edition *and cover*: the body around the date, never the date itself. */
  let memo: { key: string; entry: HeldExport } | null = null;
  /** The decoded image, read once per file version; kept apart from the built parts. */
  let coverMemo: { key: string; cover: CoverImage } | null = null;

  const cover = (): CoverImage => {
    const key = statKeyOf(coverPath);
    if (key !== null && coverMemo !== null && coverMemo.key === key) return coverMemo.cover;
    const loaded = loadCover(coverPath);
    if (key !== null) coverMemo = { key, cover: loaded };
    return loaded;
  };

  return {
    resolve(edition) {
      let image: CoverImage;
      try {
        image = cover();
      } catch (error) {
        // A cover that cannot be embedded is a typed failure: `/book.fb2` answers `503` with
        // its code, `/api/front` prints no size. Anything else is a bug and keeps its handler.
        if (!(error instanceof CoverError)) throw error;
        return { kind: 'cover-error', error };
      }
      const key = `${edition.hash}:${image.sha256}`;
      return {
        kind: 'export',
        cover: image,
        entry: () => {
          if (memo !== null && memo.key === key) return memo.entry;
          const parts = buildParts(source, edition.revision, image);
          const entry: HeldExport = {
            parts,
            cover: image,
            bytes: Buffer.byteLength(parts.head, 'utf8') + Buffer.byteLength(parts.tail, 'utf8'),
          };
          memo = { key, entry };
          return entry;
        },
      };
    },
  };
}
