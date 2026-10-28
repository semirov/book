/**
 * Sentence storage and its content hash (ADR-044 §2.1, §2.5).
 *
 * The store is the only place a row is written outside the applier, so these tests pin the three
 * things a later stage will rely on: a block is segmented once, «live» means `erased_at IS NULL`,
 * and an interval belongs to a sentence only when one sentence contains it whole.
 */

import { SEGMENTER_VERSION, splitSentences } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { normaliseSentence, sentenceHash } from '../../src/sentences/hash.ts';
import {
  blockHasSentences,
  findLiveSentence,
  insertImportedSentences,
  listLiveSentences,
  resolveSentenceCovering,
  touchSentence,
} from '../../src/sentences/store.ts';
import { seedChapter } from '../ledger/helpers.ts';

const TEXT = 'Знак 😀 стоит здесь. Мимо прошёл человек. Внутри третьего слова.';
const AT = '2026-10-28T10:00:00Z';

function fixture(): { db: Db; blockId: string } {
  const db = openDatabase(':memory:');
  migrate(db);
  const [block] = seedChapter(db, { chapter: 12, texts: [TEXT], at: AT });
  if (block === undefined) throw new Error('seed wrote no block');
  return { db, blockId: block.id };
}

describe('sentenceHash', () => {
  it('is blake2b-128 of the normalised sentence, as 32 hex characters', () => {
    expect(sentenceHash('Он пришёл.')).toMatch(/^[0-9a-f]{32}$/u);
    // NFC, collapsed whitespace and trimmed edges are the same value.
    expect(sentenceHash('  Он   пришёл.\n')).toBe(sentenceHash('Он пришёл.'));
    // A composed and a decomposed «й» are one word, not two.
    expect(sentenceHash('й')).toBe(sentenceHash('и\u0306'));
    // Case and punctuation are kept: they are different sentences.
    expect(sentenceHash('Он пришёл.')).not.toBe(sentenceHash('Он пришёл?'));
    expect(sentenceHash('Он пришёл.')).not.toBe(sentenceHash('он пришёл.'));
    expect(normaliseSentence('  а   б\nв ')).toBe('а б в');
  });
});

describe('the sentence store', () => {
  it('segments a block once and returns the rows it wrote', () => {
    const { db, blockId } = fixture();
    const first = insertImportedSentences(db, { blockId, text: TEXT, at: AT });
    expect(first.inserted).toBe(splitSentences(TEXT).length);
    expect(first.rows.map((row) => row.idx)).toEqual([0, 1, 2]);
    expect(first.rows.every((row) => row.seg_version === SEGMENTER_VERSION)).toBe(true);
    expect(first.rows.every((row) => row.erased_at === null)).toBe(true);

    // A second import is a no-op: the same ids, nothing appended.
    const again = insertImportedSentences(db, { blockId, text: TEXT, at: AT });
    expect(again.inserted).toBe(0);
    expect(again.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
    expect(blockHasSentences(db, blockId)).toBe(true);
    db.close();
  });

  it('reports «live» as erased_at IS NULL and keeps a closed row out of every live read', () => {
    const { db, blockId } = fixture();
    const rows = insertImportedSentences(db, { blockId, text: TEXT, at: AT }).rows;
    const closed = rows[1];
    if (closed === undefined) throw new Error('no second sentence');
    db.prepare('UPDATE sentences SET erased_at = ? WHERE id = ?').run(AT, closed.id);

    expect(listLiveSentences(db, blockId).map((row) => row.id)).toEqual([rows[0]?.id, rows[2]?.id]);
    expect(findLiveSentence(db, closed.id)).toBeNull();
    expect(findLiveSentence(db, rows[0]?.id ?? '')).toMatchObject({ id: rows[0]?.id, idx: 0 });
    db.close();
  });

  it('writes one touch per sentence per operation', () => {
    const { db, blockId } = fixture();
    const row = insertImportedSentences(db, { blockId, text: TEXT, at: AT }).rows[0];
    if (row === undefined) throw new Error('no sentence');
    touchSentence(db, { sentenceId: row.id, changeId: 'chg_one', kind: 'text', at: AT });
    touchSentence(db, { sentenceId: row.id, changeId: null, kind: 'moved', at: AT });
    expect(db.prepare('SELECT sentence_id, change_id, kind, at FROM sentence_touches ORDER BY id').all()).toEqual([
      { sentence_id: row.id, change_id: 'chg_one', kind: 'text', at: AT },
      { sentence_id: row.id, change_id: null, kind: 'moved', at: AT },
    ]);
    // The kind vocabulary is the schema's, not a convention.
    expect(() =>
      db
        .prepare('INSERT INTO sentence_touches (sentence_id, change_id, kind, at) VALUES (?, NULL, ?, ?)')
        .run(row.id, 'born', AT),
    ).not.toThrow();
    expect(() =>
      db
        .prepare('INSERT INTO sentence_touches (sentence_id, change_id, kind, at) VALUES (?, NULL, ?, ?)')
        .run(row.id, 'renamed', AT),
    ).toThrow(/CHECK/u);
    db.close();
  });

  it('places an interval only in the one sentence that contains it whole', () => {
    const { db, blockId } = fixture();
    const rows = insertImportedSentences(db, { blockId, text: TEXT, at: AT }).rows;
    const second = rows[1];
    const third = rows[2];
    if (second === undefined || third === undefined) throw new Error('fixture needs three sentences');

    // Exactly sentence 2, and a word inside it.
    expect(resolveSentenceCovering(db, { blockId, start: second.start, end: second.end })?.id).toBe(second.id);
    expect(resolveSentenceCovering(db, { blockId, start: second.start, end: second.start + 4 })?.id).toBe(second.id);
    // Straddling the boundary between 2 and 3 belongs to neither.
    expect(resolveSentenceCovering(db, { blockId, start: third.start - 2, end: third.start + 2 })).toBeNull();
    // An impossible interval is a caller's bug, answered with null rather than a neighbour.
    expect(resolveSentenceCovering(db, { blockId, start: 5, end: 4 })).toBeNull();
    expect(resolveSentenceCovering(db, { blockId, start: 1.5, end: 4 })).toBeNull();
    expect(resolveSentenceCovering(db, { blockId: 'ch12#nope', start: 0, end: 1 })).toBeNull();
    db.close();
  });
});
