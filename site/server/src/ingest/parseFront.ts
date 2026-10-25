/**
 * `manuscript/00-front.md` → the live title and the live annotation (§6C.2).
 *
 * One file, one lease, one `front` step: page 1 and page 2 are rewritten together so a
 * cover can never promise a book the annotation no longer describes. The parser is the
 * validator's parser (`parseFrontMatter`), because a second reader of the first sheet
 * would eventually disagree with F021 about what a valid first sheet is.
 */

import { normalizeBookText, parseFrontMatter } from '@book/shared';

import { sha256Hex } from '../util/hash.ts';

export type ParsedFront = {
  /** Line 1 when it is valid, else null (the cover falls back to the site's own label). */
  title: string | null;
  /** «о чём эта книга» when it is valid, else null — page 2 then renders nothing (§11.8). */
  about: string | null;
  blocks: string[];
  chars: number;
  /** F021 problems; a malformed first sheet is an error for the commit, not a crash. */
  problems: string[];
  /** Normalized full text — what the snapshot and the hash are taken over. */
  text: string;
  sha256: string;
};

export function parseFront(raw: string): ParsedFront {
  const text = normalizeBookText(raw);
  const parsed = parseFrontMatter(text);
  return {
    title: parsed.title,
    about: parsed.about,
    blocks: parsed.blocks,
    chars: parsed.chars,
    problems: parsed.problems,
    text,
    sha256: sha256Hex(text),
  };
}
