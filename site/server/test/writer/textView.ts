/**
 * The narrow chapter view the prompts read, built from a manuscript in a test book.
 *
 * Production gets this shape from `POST /internal/text` (rows). A prompt test controls its book
 * as files, so the test's own adapter reads them with the engine's file reader — the one the
 * one-shot import uses — and hands the prompt exactly what the engine would have answered.
 */

import { chapterBodyOf, readChapter } from '../../src/engine/text.ts';
import type { ChapterTextLookup } from '../../src/writer/prompt.ts';

/** The rows `POST /internal/text` would return for a book on disk. */
export function textOf(root: string): ChapterTextLookup {
  return (n) => {
    const chapter = readChapter(root, n);
    return {
      n,
      title: chapter.title,
      exists: chapter.exists,
      basis: chapter.basis,
      chars: chapter.chars,
      text: chapterBodyOf(chapter.blocks),
    };
  };
}
