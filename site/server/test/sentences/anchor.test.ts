/**
 * Where a quote sits among stored sentences (ADR-044 §2.1, §5 step 3).
 *
 * Every case here is a case the migration meets on the real book: a quote inside one sentence, a
 * sentence that repeats (so the affixes are the only evidence), and a quote the reader's composer
 * clamped across a boundary — which must keep the block anchor rather than borrow a sentence.
 * Offsets are code points, so the fixture carries a surrogate pair before the quote: a UTF-16
 * implementation would be off by one and the slice assertions would fail.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { resolveQuoteSentence } from '../../src/sentences/anchor.ts';
import { insertImportedSentences, listLiveSentences } from '../../src/sentences/store.ts';
import { seedChapter } from '../ledger/helpers.ts';

const AT = '2026-10-28T10:00:00Z';

function fixture(text: string): { db: ReturnType<typeof openDatabase>; blockId: string; sentenceAt: (idx: number) => { id: string; start: number; end: number } } {
  const db = openDatabase(':memory:');
  migrate(db);
  const [block] = seedChapter(db, { chapter: 12, texts: [text], at: AT });
  if (block === undefined) throw new Error('seed wrote no block');
  insertImportedSentences(db, { blockId: block.id, text: block.text, at: AT });
  const sentences = listLiveSentences(db, block.id);
  return {
    db,
    blockId: block.id,
    sentenceAt: (idx) => {
      const found = sentences.find((sentence) => sentence.idx === idx);
      if (found === undefined) throw new Error(`no sentence ${String(idx)}`);
      return { id: found.id, start: found.start, end: found.end };
    },
  };
}

describe('resolveQuoteSentence', () => {
  const TEXT = 'Знак 😀 стоит здесь. Мимо прошёл человек. Внутри третьего слова. Последнее предложение.';

  it('finds a word inside the third sentence and returns its offsets in code points', () => {
    const { db, blockId, sentenceAt } = fixture(TEXT);
    const third = sentenceAt(2);
    const placement = resolveQuoteSentence(db, { blockId, quote: 'третьего' });
    expect(placement).toEqual({ sentenceId: third.id, selStart: 7, selEnd: 15 });
    // The offsets are code points into the block's text — the unit the schema stores.
    const characters = Array.from(TEXT);
    expect(
      characters.slice(third.start + 7, third.start + 15).join(''),
    ).toBe('третьего');
    db.close();
  });

  it('uses prefix and suffix to tell two occurrences apart, and refuses without them', () => {
    const repeated = 'Он сказал одно и то же. Она сказала одно и то же. Потом все ушли.';
    const { db, blockId, sentenceAt } = fixture(repeated);
    const first = resolveQuoteSentence(db, { blockId, quote: 'одно и то же', prefix: 'Он сказал ' });
    expect(first?.sentenceId).toBe(sentenceAt(0).id);
    expect(first?.selStart).toBe(10);
    const second = resolveQuoteSentence(db, { blockId, quote: 'одно и то же', prefix: 'Она сказала ' });
    expect(second?.sentenceId).toBe(sentenceAt(1).id);
    // The suffix alone is evidence too: the first occurrence is followed by «. Она», the second
    // by «. Потом».
    expect(resolveQuoteSentence(db, { blockId, quote: 'одно и то же', suffix: '. Потом' })?.sentenceId).toBe(
      sentenceAt(1).id,
    );
    expect(resolveQuoteSentence(db, { blockId, quote: 'одно и то же', suffix: '. Так' })).toBeNull();
    // No affix evidence means no answer: two sentences could both be the one the reader meant.
    expect(resolveQuoteSentence(db, { blockId, quote: 'одно и то же' })).toBeNull();
    // An empty affix is no evidence at all: it narrows nothing.
    expect(resolveQuoteSentence(db, { blockId, quote: 'одно и то же', prefix: '' })).toBeNull();
    // An affix that matches nothing is drift, not a licence to pick the first occurrence.
    expect(resolveQuoteSentence(db, { blockId, quote: 'одно и то же', prefix: 'Тогда ' })).toBeNull();
    db.close();
  });

  it('returns null for a quote that straddles a boundary, and for an absent one', () => {
    const { db, blockId } = fixture(TEXT);
    expect(resolveQuoteSentence(db, { blockId, quote: 'здесь. Мимо' })).toBeNull();
    expect(resolveQuoteSentence(db, { blockId, quote: 'нет таких слов' })).toBeNull();
    expect(resolveQuoteSentence(db, { blockId, quote: '' })).toBeNull();
    expect(resolveQuoteSentence(db, { blockId, quote: null })).toBeNull();
    db.close();
  });
});
