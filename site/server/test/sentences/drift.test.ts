/**
 * `SEGMENT_DRIFT` (ADR-044 §3.1, §5 step 5): a read-time split may only **check** stored
 * boundaries. The tests pin the two promises the check makes — it reports, and it changes nothing:
 * the stored rows stay as they are and a second read of the same block adds no second log line.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { driftKey, readBlockSentences } from '../../src/sentences/drift.ts';
import { insertImportedSentences, listLiveSentences } from '../../src/sentences/store.ts';
import { seedChapter } from '../ledger/helpers.ts';

const TEXT = 'Первое предложение. Второе предложение! Третье? Четвёртое осталось без знака';
const AT = '2026-10-28T10:00:00Z';

function blockFixture(text = TEXT): { db: ReturnType<typeof openDatabase>; blockId: string } {
  const db = openDatabase(':memory:');
  migrate(db);
  const [block] = seedChapter(db, { chapter: 12, texts: [text], at: AT });
  if (block === undefined) throw new Error('seed wrote no block');
  insertImportedSentences(db, { blockId: block.id, text: block.text, at: AT });
  return { db, blockId: block.id };
}

function metaKeys(db: ReturnType<typeof openDatabase>): string[] {
  return (db.prepare(`SELECT k FROM meta WHERE k LIKE 'sentences.drift:%'`).all() as Array<{ k: string }>).map(
    (row) => row.k,
  );
}

describe('readBlockSentences — SEGMENT_DRIFT is a check, never a rewrite', () => {
  it('reports a clean block and writes no key', () => {
    const { db, blockId } = blockFixture();
    const result = readBlockSentences(db, blockId, AT);
    expect(result.drift).toBe(false);
    expect(result.sentences.map((sentence) => sentence.idx)).toEqual([0, 1, 2, 3]);
    expect(metaKeys(db)).toEqual([]);
    db.close();
  });

  it('reports a corrupted span once per block and leaves every row where it was', () => {
    const { db, blockId } = blockFixture();
    const stored = listLiveSentences(db, blockId);
    const first = stored[0];
    if (first === undefined) throw new Error('no sentence');
    db.prepare('UPDATE sentences SET start = start + 1 WHERE id = ?').run(first.id);
    const corrupted = stored.map((sentence) => ({ ...sentence, start: sentence.id === first.id ? sentence.start + 1 : sentence.start }));

    const result = readBlockSentences(db, blockId, AT);
    expect(result.drift).toBe(true);
    // The check answers with the stored rows: the caller keeps rendering what the table says.
    expect(result.sentences.map((sentence) => sentence.start)).toEqual(corrupted.map((sentence) => sentence.start));

    const keys = metaKeys(db);
    expect(keys).toEqual([driftKey(blockId)]);
    const logged = JSON.parse(
      (db.prepare('SELECT v FROM meta WHERE k = ?').get(driftKey(blockId)) as { v: string }).v,
    ) as { at: string; stored: Array<{ start: number }>; current: Array<{ start: number }> };
    expect(logged.at).toBe(AT);
    expect(logged.stored[0]?.start).toBe(first.start + 1);
    expect(logged.current[0]?.start).toBe(first.start);

    // A second read of the same block adds no second line — one key per block version.
    expect(readBlockSentences(db, blockId, '2026-10-28T11:00:00Z').drift).toBe(true);
    expect(metaKeys(db)).toEqual([driftKey(blockId)]);
    expect(
      (db.prepare('SELECT v FROM meta WHERE k = ?').get(driftKey(blockId)) as { v: string }).v,
    ).toContain(AT);

    // Nothing was repaired behind the caller's back: the row, its count and its hash are untouched.
    expect(db.prepare('SELECT start FROM sentences WHERE id = ?').get(first.id)).toEqual({ start: first.start + 1 });
    expect(listLiveSentences(db, blockId)).toHaveLength(stored.length);
    expect(db.prepare('SELECT text FROM blocks WHERE id = ?').get(blockId)).toEqual({ text: TEXT });
    db.close();
  });

  it('reports a row cut by another segmenter version, even when the offsets agree', () => {
    const { db, blockId } = blockFixture();
    db.prepare('UPDATE sentences SET seg_version = 0').run();
    expect(readBlockSentences(db, blockId, AT).drift).toBe(true);
    expect(metaKeys(db)).toEqual([driftKey(blockId)]);
    db.close();
  });

  it('reports a missing block as unchecked rather than clean or drifted', () => {
    const { db } = blockFixture();
    const result = readBlockSentences(db, 'ch12#nosuchblock', AT);
    expect(result).toEqual({ sentences: [], drift: false });
    expect(metaKeys(db)).toEqual([]);
    db.close();
  });
});
