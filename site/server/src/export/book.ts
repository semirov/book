/**
 * BOOK-187 AC11 — the book exported **from the rows**, on demand.
 *
 * Two formats, one projection: `chapters`, `blocks` and `front_matter` are the only inputs
 * (ADR-043 G2 — «the volume is the book»), so an export is a rendering, never a copy of a
 * source. Nothing here reads a file, and nothing here writes one: `write.ts` owns the single
 * `--out` path and `cli.ts` owns the arguments, so the renderer stays a pure function of rows,
 * the imprint and the cover.
 *
 * **Markdown** is plain and deterministic on purpose: `# title`, the annotation, then
 * `## chapter title` and its paragraphs, one blank line between blocks, LF only, no timestamp —
 * two exports of one state are byte-identical, which is what makes a diff of two exports mean
 * something. **FB2** is the shipped serializer (`fb2/serialize.ts`) and the shipped edition
 * (`fb2/edition.ts`), so the file a reader downloads from `/book.fb2` and the file this CLI
 * writes are the same document, one `document-info/date` apart (the CLI writes none: an export
 * is not a response).
 *
 * What is exported: every chapter with at least one paragraph, in slot order — the two basis
 * slots included, because the reader sees their sentences (BOOK-6). A slot with no row or no
 * blocks prints nothing at all: absence is absence, never an empty heading.
 */

import { isChapterNumber, splitParagraphs, type Imprint } from '@book/shared';

import type { Db } from '../db/db.ts';
import { listBlocks, listChapterRows } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { readEdition } from '../fb2/edition.ts';
import { COVER_ID, COVER_TYPE, loadCover, type CoverImage } from '../fb2/cover.ts';
import { paragraphText, renderFb2 } from '../fb2/serialize.ts';

export type ExportFormat = 'md' | 'fb2';

export type ExportChapter = { n: number; title: string | null; paragraphs: string[] };

/** The whole book, as the renderers see it. */
export type BookProjection = { title: string | null; about: string | null; chapters: ExportChapter[] };

/** The book as the volume holds it: the front row and every chapter with paragraphs, in order. */
export function projectBook(db: Db): BookProjection {
  const front = getFrontRow(db);
  const chapters: ExportChapter[] = [];
  for (const row of listChapterRows(db)) {
    // A row outside the book's range is storage, not a chapter (BOOK-155).
    if (!isChapterNumber(row.n)) continue;
    const blocks = listBlocks(db, row.n);
    if (blocks.length === 0) continue;
    chapters.push({ n: row.n, title: row.title, paragraphs: blocks.map((block) => paragraphText(block.text)) });
  }
  return {
    title: front !== undefined && front.title.trim().length > 0 ? front.title : null,
    about: front !== undefined && front.about.trim().length > 0 ? front.about : null,
    chapters,
  };
}

/** `Глава 12` — the heading a chapter without a title line gets, the reader's own fallback. */
function headingOf(chapter: ExportChapter): string {
  return chapter.title !== null && chapter.title.trim().length > 0 ? chapter.title : `Глава ${String(chapter.n)}`;
}

/**
 * The plain markdown renderer: one blank line between blocks, LF, a single trailing newline.
 * Deterministic by construction — no clock, no path, no document order from a map.
 */
export function renderMarkdown(book: BookProjection): string {
  const blocks: string[] = [`# ${book.title ?? 'Книга'}`];
  if (book.about !== null) blocks.push(...splitParagraphs(book.about));
  for (const chapter of book.chapters) {
    blocks.push(`## ${headingOf(chapter)}`);
    blocks.push(...chapter.paragraphs);
  }
  return `${blocks.join('\n\n')}\n`;
}

export type Fb2ExportInput = {
  db: Db;
  imprint: Imprint;
  /** `book-site <version>` in `program-used`. */
  version: string;
  /** `config.publicOrigin` — the file's `src-url`. */
  publicOrigin: string;
  /** The image the file carries; `config.coverPath` in the CLI. */
  coverPath: string;
};

/**
 * The FB2 document: the shipped serializer over the shipped edition, with the cover the image
 * carries. A cover that cannot be embedded throws `CoverError` — a book without its cover is not
 * the file to hand a reader, and a silent fallback would be a lie in the catalogue.
 */
export function renderFb2Document(input: Fb2ExportInput, book: BookProjection = projectBook(input.db)): string {
  const edition = readEdition(input.db, input.imprint.author);
  const cover: CoverImage = loadCover(input.coverPath);
  const parts = renderFb2({
    title: book.title,
    about: book.about,
    author: input.imprint.author,
    year: input.imprint.year,
    version: input.version,
    srcUrl: `${input.publicOrigin}/`,
    revision: edition.revision,
    cover: { id: COVER_ID, contentType: COVER_TYPE, base64: cover.base64 },
    chapters: book.chapters.map((chapter) => ({
      n: chapter.n,
      title: chapter.title,
      paragraphs: chapter.paragraphs,
    })),
  });
  // No `document-info/date`: an export is a state, not a response, so two runs are identical.
  return `${parts.head}\n${parts.tail}`;
}

/** The body for one format. `fb2` needs the imprint and the cover; `md` needs neither. */
export function exportBook(format: ExportFormat, input: Fb2ExportInput): string {
  return format === 'md' ? renderMarkdown(projectBook(input.db)) : renderFb2Document(input);
}
