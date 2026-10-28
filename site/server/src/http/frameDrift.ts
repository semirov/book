/**
 * BOOK-109 — `FRAME_DRIFT`: the served frame against the manuscript's, at request time.
 *
 * The frozen frame has one owner (`FRAME_FIRST_SENTENCE` / `FRAME_LAST_SENTENCE`, BOOK-107) and
 * two places that can disagree with it: the file, and the projection the database holds from
 * the last scan. The owner twice read text in ch01/ch42 that no file contained, and neither
 * `/healthz` nor the frame smoke check could say *which* of the two a request had just served.
 * This comparison answers that, per request, for the only two chapters whose text is the frame.
 *
 * It is deliberately cheap: two small files, read synchronously, and nothing for the other
 * chapters. A drift is logged by the route (the same strings, both of them); a file that cannot
 * be read is reported once per process, because a missing mount must not become a log flood.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOTAL_CHAPTERS, chapterLabel, parseChapterTitle, splitParagraphs } from '@book/shared';

/** The served block, as much of it as the comparison needs. */
export type ServedBlock = { text: string };

export type FrameDrift = {
  /** The manuscript file the comparison read. */
  file: string;
  /** The block the request served, whitespace flattened — a log line is one line. */
  served: string;
  /** The paragraph the file holds in the same position, flattened the same way. */
  manuscript: string;
};

/** The file exists but cannot be read (or the mount is gone): not drift, an unanswerable check. */
export type FrameUnreadable = { file: string; unreadable: string };

/** `null` — the two agree, or the chapter carries no frame (the other 65). */
export type FrameCheck = FrameDrift | FrameUnreadable | null;

export type FrameDriftOptions = {
  bookRoot: string;
  /** Test seam; the default reads `manuscript/chNN.md` synchronously. */
  readFile?: (file: string) => string;
};

/** `manuscript/chNN.md` — the file the ingest would have projected this chapter from. */
export function frameFile(bookRoot: string, n: number): string {
  return join(bookRoot, 'manuscript', `ch${chapterLabel(n)}.md`);
}

/** Whitespace is not identity: a re-wrapped paragraph is the same paragraph (the ingest agrees). */
function flatten(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compare ch01's first paragraph and ch42's last one with the file the chapter was read from.
 *
 * The file is parsed with the same two decisions the ingest makes — `parseChapterTitle` (a
 * chapter that opens on its frame is untitled prose) and `splitParagraphs` (blank line, trim,
 * drop empties) — so the comparison is between the projection and its own source, not between
 * two ideas of what a paragraph is.
 */
export function checkFrameDrift(options: FrameDriftOptions, n: number, blocks: readonly ServedBlock[]): FrameCheck {
  // Only the two chapters that carry the frame: the others are guarded by `rev` alone.
  if (n !== 1 && n !== TOTAL_CHAPTERS) return null;

  const file = frameFile(options.bookRoot, n);
  const read = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  let raw: string;
  try {
    raw = read(file);
  } catch (error) {
    return { file, unreadable: reasonOf(error) };
  }

  const paragraphs = splitParagraphs(parseChapterTitle(n, raw).body);
  const first = n === 1;
  const served = flatten(first ? (blocks[0]?.text ?? '') : (blocks[blocks.length - 1]?.text ?? ''));
  const manuscript = flatten(first ? (paragraphs[0] ?? '') : (paragraphs[paragraphs.length - 1] ?? ''));
  // A readable but empty body is drift too: the slot claims the frame and holds nothing.
  if (manuscript.length > 0 && served === manuscript) return null;
  return { file, served, manuscript };
}
