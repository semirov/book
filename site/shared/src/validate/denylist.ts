/**
 * Legal denylist matching (ARCHITECTURE.md §13.4, F005, ADR-022).
 *
 * The rule is mechanical on purpose: a denylisted real person, protected character or
 * mechanically detectable illegal-content pattern is an error. There is **no allowlist**:
 * names are legitimate output of the writer (§6E.5), so an unknown invented name is not a
 * finding here.
 *
 * Two matchers, because a name and an organisation are not the same claim:
 *
 * - **A person or a protected character matches only as a complete name.** The text is cut
 *   into written names — runs of capitalised words joined by spaces or a hyphen — and an
 *   entry matches when one whole run is that entry: every token, in order, under the same
 *   stem policy (`stemRu`), so «Лев Толстой» covers its case forms. A word that merely
 *   starts with an entry, one token of a multi-word entry («Толстой» alone) and a name that
 *   is only the start of a longer written name («Александра» against «Александр Лукашенко»)
 *   are **not** hits: a part of a name is not the name.
 * - **An organisation matches token by token** (unchanged): «Запрещённая организация»
 *   catches either part, because an organisation is rarely written the same way twice.
 *
 * Patterns keep their regex behaviour and are reported by `compilePatterns`/`findPatternHits`.
 */

import { CAPITALIZED_WORD, foldRu, stemRu } from './text.ts';

export type DenylistIndex = {
  stems: Set<string>;
  entries: Array<{ entry: string; stem: string }>;
};

/** Persons and characters: one record per entry, as the tokens a complete name supplies. */
export type NameIndex = {
  entries: Array<{ entry: string; stems: string[] }>;
};

export type DenylistHit = {
  word: string;
  offset: number;
  /** Length of the matched span in the text, so an excerpt can be cut exactly. */
  length: number;
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

/** Complete names: an entry keeps its token list, an empty entry is dropped. */
export function buildNameIndex(names: Iterable<string>): NameIndex {
  const entries: Array<{ entry: string; stems: string[] }> = [];
  for (const value of names) {
    const tokens = value
      .split(/[^\p{L}\p{N}-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    entries.push({ entry: tokens.join(' '), stems: tokens.map((token) => stemRu(token)) });
  }
  return { entries };
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
 * sentence. Used for organisations, where one written part is the organisation.
 */
export function findDenylisted(text: string, index: DenylistIndex): DenylistHit[] {
  const hits: DenylistHit[] = [];
  const pattern = new RegExp(CAPITALIZED_WORD.source, 'gu');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const word = match[0];
    if (matchesDenylist(word, index)) hits.push({ word, offset: match.index, length: word.length });
  }
  return hits;
}

type NameWord = { text: string; start: number; end: number };
type WrittenName = { words: NameWord[] };

/**
 * Cut the text into written names: a run of capitalised words separated only by spaces or
 * hyphens («Александр Лукашенко», «Ростов-на-Дону»). Punctuation, a lowercase word or a
 * line boundary ends the run, so two names in one sentence stay two names.
 */
function writtenNames(text: string): WrittenName[] {
  const runs: WrittenName[] = [];
  const pattern = new RegExp(CAPITALIZED_WORD.source, 'gu');
  let current: WrittenName | null = null;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const word: NameWord = { text: match[0], start: match.index, end: match.index + match[0].length };
    if (current !== null && /^[-\s]+$/u.test(text.slice(lastEnd, word.start))) {
      current.words.push(word);
    } else {
      if (current !== null) runs.push(current);
      current = { words: [word] };
    }
    lastEnd = word.end;
  }
  if (current !== null) runs.push(current);
  return runs;
}

/** The window is the entry: every word, in order, under the same stem policy. */
function sameTokens(words: readonly NameWord[], stems: readonly string[]): boolean {
  return words.every((word, index) => stemRu(word.text) === stems[index]);
}

/** The hit covers the written window, so an excerpt can be cut from the text as written. */
function windowHit(window: readonly NameWord[]): DenylistHit {
  const first = window[0] as NameWord;
  const last = window[window.length - 1] as NameWord;
  return { word: window.map((word) => word.text).join(' '), offset: first.start, length: last.end - first.start };
}

/**
 * Every complete denylisted person/character name in the text.
 *
 * A run of capitalised words may open with something that is not part of the name
 * («Вчера Александр Лукашенко приехал») and may continue with a patronymic
 * («Александр Лукашенко Викторович»), so an entry matches a **window** of the run: the same
 * number of words, in order, and the run may go on after them. What stays quiet is a window
 * that cannot be filled: a first name alone against a multi-word entry, and a word that only
 * starts with the entry («Александровка»).
 */
export function findDenylistedNames(text: string, index: NameIndex): DenylistHit[] {
  const hits: DenylistHit[] = [];
  for (const run of writtenNames(text)) {
    for (const entry of index.entries) {
      const size = entry.stems.length;
      for (let start = 0; start + size <= run.words.length; start += 1) {
        const window = run.words.slice(start, start + size);
        if (!sameTokens(window, entry.stems)) continue;
        hits.push(windowHit(window));
        break;
      }
    }
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
