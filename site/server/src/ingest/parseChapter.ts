/**
 * File → title + blocks (ARCHITECTURE.md §6.3, §6C.3).
 *
 * Line 1 of a chapter is its title, not prose: it is not a block, is not printed by the
 * reveal, is not counted in `chars` and is not quoted by comments. The remainder splits
 * into blocks on blank lines. Block ids are content-derived and position-independent
 * (`ch08#9c1f0a3b`) so a comment keeps pointing at its paragraph when the ones above it
 * are rewritten.
 */

import {
  chapterLabel,
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

export function parseChapter(n: number, raw: string): ParsedChapter {
  const title = parseTitleLine(raw);
  const text = normalizeBookText(raw);
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
    sha256: sha256Hex(text),
    chars: blocks.reduce((sum, block) => sum + block.text.length, 0),
    blocks,
  };
}
