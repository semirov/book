/**
 * F005 — the finite cast.
 *
 * The rule is mechanical on purpose: a name that is not in the allowlist is an error.
 * Matching is stem-based (see `stemRu`) so one dossier name covers its case forms, and
 * prefix matching lets a stem entry like «Мельников» cover «Мельникова / Мельниковых».
 */

import { CAPITALIZED_WORD, foldRu, isSentenceStart, stemRu } from './text.ts';

export type NameHit = {
  word: string;
  offset: number;
  /** True when the word opens a sentence — reported only if it looks like a name (§ doc below). */
  sentenceStart: boolean;
};

export type CastIndex = {
  stems: Set<string>;
  /** Folded entries with their stems, for prefix matching of long stems. */
  entries: Array<{ entry: string; stem: string }>;
};

export function buildCastIndex(names: Iterable<string>): CastIndex {
  const stems = new Set<string>();
  const entries: Array<{ entry: string; stem: string }> = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    const stem = stemRu(trimmed);
    stems.add(stem);
    entries.push({ entry: foldRu(trimmed), stem });
  }
  return { stems, entries };
}

/**
 * A token is allowed when its stem is known, or when it extends a known stem of at
 * least four letters («Мельников» → «Мельниковых» survives unknown endings).
 */
export function isAllowedName(token: string, index: CastIndex): boolean {
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
 * Every capitalized word in a paragraph that is not allowlisted.
 *
 * Sentence-initial capitalisation is ordinary Russian, so those words are skipped —
 * unless the next word is capitalised too («Пришла Зоя Прокопьевна»), which is the
 * shape of a name and the case worth reporting.
 */
export function findUnknownNames(block: string, index: CastIndex): NameHit[] {
  const hits: NameHit[] = [];
  const pattern = new RegExp(CAPITALIZED_WORD.source, 'gu');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const word = match[0];
    if (isAllowedName(word, index)) continue;
    const sentenceStart = isSentenceStart(block, match.index);
    if (sentenceStart) {
      const rest = block.slice(match.index + word.length);
      const next = /^\s+([А-ЯЁ][а-яё]+)/u.exec(rest);
      if (!next || isAllowedName(next[1] ?? '', index)) continue;
    }
    hits.push({ word, offset: match.index, sentenceStart });
  }
  return hits;
}

/** `bible/dossiers.md` → the seven living names, split into their parts. */
export function castFromDossiers(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*Имя:\s*([^.\n]+)/u.exec(line);
    if (!match) continue;
    for (const part of (match[1] ?? '').split(/\s+/u)) {
      const cleaned = part.trim().replace(/[,;:]/gu, '');
      if (cleaned.length >= 2) names.add(cleaned);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
}
