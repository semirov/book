/**
 * Tier 0 (BOOK-DOC-80 §"Tier 0 style invariants"): every countable invariant, and the clean patch.
 *
 * The cases are the design's five bullets, one test each, plus the pair the design insists on —
 * a clean patch is `ok`, and a move is a **note**, never a finding. Nothing here calls a model or
 * reads a book: the checks are pure, and the lexicon is handed in.
 */

import { describe, expect, it } from 'vitest';

import {
  BANNED_LEXICON,
  NGRAM_TOKENS,
  SENTENCE_MAX_CHARS,
  checkTier0,
  loadLexicon,
  tier0Detail,
} from '../../../src/writer/verify/tier0.ts';

const CHAPTER = 12;
const LEXICON = ['запрещённая фраза'];

/** A chapter of five plain sentences, so a span and its two neighbours fit inside it. */
function chapter(sentences: string[]): string {
  return `Глава двенадцатая\n\n${sentences.join(' ')}`;
}

const BASE = [
  'Первый час шёл снег.',
  'Потом стало тихо.',
  'Петров вышел на лёд.',
  'Дальше была только дорога.',
  'Он шёл всю ночь.',
  'Утром пришла смена.',
];

function check(before: string, after: string, extra: Partial<Parameters<typeof checkTier0>[0]> = {}) {
  return checkTier0({ before, after, chapter: CHAPTER, text: after, lexicon: LEXICON, ...extra });
}

describe('tier 0 — a clean patch is ok', () => {
  it('accepts a span that only changes words, with no finding and no note', () => {
    const before = chapter(BASE);
    const after = before.replace('Потом стало тихо.', 'Потом стало глухо.');
    const result = check(before, after);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe('tier 0 — the six-word repeat', () => {
  it('flags a 6-gram the patch brought into the span', () => {
    const before = chapter(BASE);
    const after = before.replace(
      'Петров вышел на лёд.',
      `На лёд снова вышел старый сторож. ${NGRAM_TOKENS > 0 ? 'На лёд снова вышел старый сторож.' : ''}`,
    );
    const result = check(before, after);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('TIER0_REPEAT');
    expect(result.findings[0]?.quote).toContain('на лёд снова вышел старый');
  });

  it('does not flag a repeat that lives only in the untouched neighbours', () => {
    // The neighbours say the same six words twice; the patch never touches them.
    const before = chapter([
      'Старый сторож вышел на лёд.',
      'Старый сторож вышел на лёд.',
      'Петров вышел на лёд.',
    ]);
    const after = before.replace('Петров вышел на лёд.', 'Петров вышел на берег.');
    expect(check(before, after).findings).toEqual([]);
  });
});

describe('tier 0 — a number class introduced or removed without changing its kind', () => {
  it('flags a second date when the chapter already had one', () => {
    const before = chapter(['Срок — 14.05.', 'Потом стало тихо.', 'Петров вышел на лёд.']);
    const after = before.replace('Петров вышел на лёд.', 'Петров вышел на лёд 15.06.');
    const result = check(before, after);
    expect(result.findings.map((finding) => finding.code)).toEqual(['TIER0_NUMBER']);
    expect(result.findings[0]?.detail).toContain('1 → 2');
  });

  it('stays quiet when the kind itself changed: a date became a plain number', () => {
    const before = chapter(['Срок — 14.05.', 'Потом стало тихо.', 'Петров вышел на лёд.']);
    const after = before.replace('14.05.', 'сорок два вагона, 5');
    expect(check(before, after).findings).toEqual([]);
  });
});

describe('tier 0 — the banned lexicon', () => {
  it('flags a word from the list the patch brought in', () => {
    const before = chapter(BASE);
    const after = before.replace('Потом стало тихо.', 'Потом стало тихо: запрещённая фраза.');
    const result = check(before, after);
    expect(result.findings.map((finding) => finding.code)).toEqual(['TIER0_LEXICON']);
    expect(result.findings[0]?.quote).toBe('запрещённая фраза');
  });

  it('does not flag a hit the chapter already carried', () => {
    const before = chapter([...BASE, 'Это запрещённая фраза, и она была здесь раньше.']);
    const after = before.replace('Потом стало тихо.', 'Потом стало глухо.');
    expect(check(before, after).findings).toEqual([]);
  });
});

describe('tier 0 — a new sentence out of bounds', () => {
  it('flags a new sentence longer than the design’s bound', () => {
    const before = chapter(BASE);
    // Distinct words, so the length is what this test is about and not the repeat rule.
    const long = `${Array.from({ length: Math.ceil(SENTENCE_MAX_CHARS / 6) + 4 }, (_, index) => `слово${String(index + 7)}`).join(' ')} конец.`;
    const after = before.replace('Потом стало тихо.', long.trim());
    const result = check(before, after);
    expect(result.findings.map((finding) => finding.code)).toEqual(['TIER0_SENTENCE_LONG']);
  });

  it('flags a new sentence shorter than three words', () => {
    const before = chapter(BASE);
    const after = before.replace('Потом стало тихо.', 'Потом. Стало тихо совсем.');
    const result = check(before, after);
    expect(result.findings.map((finding) => finding.code)).toEqual(['TIER0_SENTENCE_SHORT']);
  });
});

describe('tier 0 — a move is a note, not a finding', () => {
  it('notes a sentence that kept its words and lost its place, and stays ok', () => {
    const before = chapter(BASE);
    const after = chapter([BASE[0] ?? '', BASE[1] ?? '', BASE[3] ?? '', BASE[2] ?? '', BASE[4] ?? '', BASE[5] ?? '']);
    const result = check(before, after);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.notes.map((note) => note.code)).toEqual(['TIER0_SENTENCE_MOVED']);
  });

  it('notes a re-attached id whose text hash did not move', () => {
    const before = chapter(BASE);
    const after = before.replace('Потом стало тихо.', 'Потом стало глухо.');
    const result = check(before, after, { reattached: [{ sentenceId: 'snt_a', textHashMoved: false }] });
    expect(result.ok).toBe(true);
    expect(result.notes[0]?.detail).toContain('snt_a');
  });
});

describe('tier 0 — the one lexicon', () => {
  it('falls back to the module list when the voice file has no «не говорим так» section', () => {
    // The book's real root: the section does not exist yet, so the fallback is what is read.
    const lexicon = loadLexicon(new URL('../../../../..', import.meta.url).pathname);
    expect(lexicon).toEqual([...BANNED_LEXICON]);
  });

  it('names every finding in the park detail, and bounds it', () => {
    const before = chapter(BASE);
    const after = before.replace('Потом стало тихо.', 'Потом. Стало совсем тихо и пусто.');
    const detail = tier0Detail(check(before, after));
    expect(detail).toContain('TIER0_SENTENCE_SHORT');
    expect(detail.length).toBeLessThanOrEqual(300);
  });
});
