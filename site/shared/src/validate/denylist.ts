/**
 * Legal denylist matching (ARCHITECTURE.md §13.4, F005, ADR-022).
 *
 * The rule is mechanical on purpose: a denylisted real person, protected character or
 * mechanically detectable illegal-content pattern is an error. There is **no allowlist**:
 * names are legitimate output of the writer (§6E.5), so an unknown invented name is not a
 * finding here — it is an F019 provenance *warning*.
 *
 * Matching is stem-based (see `stemRu`) so one entry covers its case forms, and a
 * multi-word entry is indexed word by word: «Лев Толстой» catches either part.
 */

import { CAPITALIZED_WORD, foldRu, stemRu } from './text.ts';

export type DenylistIndex = {
  stems: Set<string>;
  entries: Array<{ entry: string; stem: string }>;
};

export type DenylistHit = {
  word: string;
  offset: number;
};

export function buildDenylistIndex(names: Iterable<string>): DenylistIndex {
  const stems = new Set<string>();
  const entries: Array<{ entry: string; stem: string }> = [];
  for (const value of names) {
    for (const name of value.split(/[^\p{L}\p{N}-]+/u)) {
      const trimmed = name.trim();
      if (trimmed.length === 0) continue;
      const stem = stemRu(trimmed);
      stems.add(stem);
      entries.push({ entry: foldRu(trimmed), stem });
    }
  }
  return { stems, entries };
}

/**
 * A token belongs to the index when its stem is known, or when it extends a known stem
 * of at least four letters («Толстой» → «Толстого» survives unknown endings).
 */
export function matchesDenylist(token: string, index: DenylistIndex): boolean {
  const stem = stemRu(token);
  if (index.stems.has(stem)) return true;
  const folded = foldRu(token);
  for (const entry of index.entries) {
    if (entry.stem.length >= 4 && (stem.startsWith(entry.stem) || folded.startsWith(entry.entry))) {
      return true;
    }
  }
  return false;
}

/**
 * Every capitalised token that belongs to the index — anywhere, including the start of a
 * sentence: a denylisted real person is a name in every position.
 */
export function findDenylisted(text: string, index: DenylistIndex): DenylistHit[] {
  const hits: DenylistHit[] = [];
  const pattern = new RegExp(CAPITALIZED_WORD.source, 'gu');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const word = match[0];
    if (matchesDenylist(word, index)) hits.push({ word, offset: match.index });
  }
  return hits;
}

export type CompiledPatterns = {
  regexes: RegExp[];
  /** Sources that are not valid regular expressions — a broken gate, reported by F005. */
  problems: string[];
};

/** `patterns` are regex sources; invalid ones are reported instead of silently dropped. */
export function compilePatterns(patterns: readonly string[]): CompiledPatterns {
  const regexes: RegExp[] = [];
  const problems: string[] = [];
  patterns.forEach((source, index) => {
    try {
      regexes.push(new RegExp(source, 'giu'));
    } catch {
      problems.push(`pattern #${index + 1} is not a valid regular expression`);
    }
  });
  return { regexes, problems };
}

/** Every match of every compiled pattern, with the offset of the match itself. */
export function findPatternHits(text: string, regexes: readonly RegExp[]): Array<{ text: string; offset: number }> {
  const hits: Array<{ text: string; offset: number }> = [];
  for (const source of regexes) {
    const pattern = new RegExp(source.source, source.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      hits.push({ text: match[0], offset: match.index });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return hits;
}
