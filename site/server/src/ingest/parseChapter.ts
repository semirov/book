/**
 * File → blocks (ARCHITECTURE.md §6.3).
 *
 * A chapter is plain prose: paragraphs separated by blank lines, no markdown. Block ids
 * are content-derived and position-independent (`ch08#9c1f0a3b`) so a comment keeps
 * pointing at its paragraph when the ones above it are rewritten.
 */

import { chapterLabel } from '@book/shared';

import { sha1Hex, sha256Hex } from '../util/hash.ts';

export type ParsedBlock = {
  id: string;
  i: number;
  text: string;
  hash: string;
};

export type ParsedChapter = {
  n: number;
  /** Normalized full text (CRLF → LF, trailing spaces stripped). */
  text: string;
  sha256: string;
  chars: number;
  blocks: ParsedBlock[];
};

/** Whitespace is not identity: a re-wrapped paragraph is the same paragraph. */
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** CRLF → LF, trailing whitespace on a line removed. */
export function normalizeChapterText(raw: string): string {
  return raw
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n');
}

export function splitChapterBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/** `ch08#9c1f0a3b`, with `-2`, `-3` for identical paragraphs inside one chapter. */
export function blockId(n: number, normalizedText: string, duplicate: number): string {
  const hash = sha1Hex(normalizedText).slice(0, 8);
  const suffix = duplicate > 0 ? `-${duplicate + 1}` : '';
  return `ch${chapterLabel(n)}#${hash}${suffix}`;
}

export function parseChapter(n: number, raw: string): ParsedChapter {
  const text = normalizeChapterText(raw);
  const texts = splitChapterBlocks(text);
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
    text,
    sha256: sha256Hex(text),
    chars: blocks.reduce((sum, block) => sum + block.text.length, 0),
    blocks,
  };
}
