/**
 * File → title + blocks (ARCHITECTURE.md §6.3, §6C.3).
 *
 * Line 1 of a chapter is its title, not prose: it is not a block, is not printed by the
 * reveal, is not counted in `chars` and is not quoted by comments. The remainder splits
 * into blocks on blank lines. Block ids are content-derived and position-independent
 * (`ch08#9c1f0a3b`) so a comment keeps pointing at its paragraph when the ones above it
 * are rewritten.
 *
 * One exception, decided before the title line: a file that is exactly its basis sentence
 * (ch01/ch67) is one paragraph with no title and no `chars` — the frozen frame is prose to
 * read, not written prose (§BOOK-6).
 */

import {
  chapterLabel,
  isBasisOnly,
  normalizeBookText,
  parseTitleLine,
  splitParagraphs,
} from '@book/shared';

import { sha1Hex, sha256Hex } from '../util/hash.ts';

export type ParsedBlock = {
  id: string;
  i: number;
  text: string;
  hash: string;
};

export type ParsedChapter = {
  n: number;
  /** Line 1, or null when it is absent/malformed — F022 blocks the commit, never the reader. */
  title: string | null;
  titleProblems: string[];
  /** Normalized full text (CRLF → LF, trailing spaces stripped), title line included. */
  text: string;
  /** Everything after the title line. */
  body: string;
  sha256: string;
  /** Prose only: the title line and separators are excluded (§6D.1). */
  chars: number;
  blocks: ParsedBlock[];
  /**
   * The file is exactly its basis sentence (ch01/ch67): the frozen frame is prose, not a
   * title, and it is not written prose — one block, no title, no `chars` (§BOOK-6).
   */
  basis: boolean;
};

/** Whitespace is not identity: a re-wrapped paragraph is the same paragraph. */
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** CRLF → LF, trailing whitespace on a line removed. */
export function normalizeChapterText(raw: string): string {
  return normalizeBookText(raw);
}

export function splitChapterBlocks(text: string): string[] {
  return splitParagraphs(text);
}

/** `ch08#9c1f0a3b`, with `-2`, `-3` for identical paragraphs inside one chapter. */
export function blockId(n: number, normalizedText: string, duplicate: number): string {
  const hash = sha1Hex(normalizedText).slice(0, 8);
  const suffix = duplicate > 0 ? `-${duplicate + 1}` : '';
  return `ch${chapterLabel(n)}#${hash}${suffix}`;
}

/**
 * A file that is exactly its basis sentence (ch01/ch67, BOOK-6). The frozen frame is the
 * chapter's one paragraph, not its title line — and it adds no `chars`, because the basis
 * sentence is not written prose and must not count towards the book. Its text is owned by
 * `FRAME_FIRST_SENTENCE`/`FRAME_LAST_SENTENCE` and checked by F029, never drafted here.
 */
function parseBasis(n: number, text: string, sha256: string): ParsedChapter {
  const sentence = text.trim();
  const normalized = normalizeForHash(sentence);
  return {
    n,
    title: null,
    titleProblems: [],
    text,
    body: text,
    sha256,
    basis: true,
    chars: 0,
    blocks: [
      {
        id: blockId(n, normalized, 0),
        i: 0,
        text: sentence,
        hash: sha1Hex(normalized).slice(0, 8),
      },
    ],
  };
}

export function parseChapter(n: number, raw: string): ParsedChapter {
  const text = normalizeBookText(raw);
  // A basis-only slot is decided before the title line: the frame sentence is prose here,
  // and reading it as a title is what made the slot look empty (§BOOK-6).
  if (isBasisOnly(n, raw)) {
    // Whitespace is not identity: the basis projection is identical for a re-saved file, so
    // a trailing newline does not re-project it or bump `updated_at`.
    return parseBasis(n, text, sha256Hex(text.trim()));
  }

  const sha256 = sha256Hex(text);
  const title = parseTitleLine(raw);
  const texts = splitParagraphs(title.body);
  const seen = new Map<string, number>();
  const blocks: ParsedBlock[] = texts.map((blockText, index) => {
    const normalized = normalizeForHash(blockText);
    const duplicate = seen.get(normalized) ?? 0;
    seen.set(normalized, duplicate + 1);
    return {
      id: blockId(n, normalized, duplicate),
      i: index,
      text: blockText,
      hash: sha1Hex(normalized).slice(0, 8),
    };
  });

  return {
    n,
    title: title.title,
    titleProblems: title.problems,
    text,
    body: title.body,
    sha256,
    basis: false,
    chars: blocks.reduce((sum, block) => sum + block.text.length, 0),
    blocks,
  };
}
