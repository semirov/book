/**
 * An out-of-order extraction (BOOK-185 defect 6): chapter 3 was answered first, then chapter 2.
 *
 * A live row is the book's belief about **when** a fact was established, and a later chapter's row
 * is not an earlier run's to re-chapter. The write is the first place that can see both, so it is
 * where the answer is refused: binding chapter 2's item to chapter 3's row would make its mention
 * a `use` of a fact that did not exist yet, and updating the row in place would rewrite a later
 * chapter's fact from an earlier run. Nothing is written.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractChapter, type ExtractOutcome, type Provider } from '../../src/graph/extract.ts';
import { ledgerFixture, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';
import { AT, CH1, CH2, CH3, PIPELINE, answerText, fakeProvider } from './extractFixture.ts';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function seed(): LedgerFixture {
  const seeded = ledgerFixture();
  for (const [chapter, lines] of Object.entries({ 1: CH1, 2: CH2, 3: CH3 })) {
    seedChapter(seeded.db, { chapter: Number(chapter), texts: lines });
  }
  return seeded;
}

async function run(chapter: number, answer: unknown, provider?: Provider): Promise<ExtractOutcome> {
  return extractChapter({
    db: fixture.db,
    chapter,
    provider: provider ?? fakeProvider(answerText(answer)),
    pipeline: PIPELINE,
    at: AT,
    noRecall: true,
  });
}

function rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return fixture.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function count(table: string): number {
  return (fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** The paper both chapters name: chapter 3 established it first in this test. */
const SAME_PAPER = {
  facts: [{ kind: 'document', value: '77/1/арх', term: 'акт 77/1/арх', quote: 'акт 77/1/арх' }],
  uses: [],
  edges: [],
  threads: [],
};

const NOTHING = { facts: [], uses: [], edges: [], threads: [] };

describe('an out-of-order run never re-chapters a later chapter\'s fact', () => {
  it('refuses the chapter 2 answer and leaves the chapter 3 row byte-identical', async () => {
    fixture = seed();
    const third = await run(3, SAME_PAPER);
    expect(third).toMatchObject({ ok: true, reused: false, chapter: 3 });
    const before = rows('SELECT * FROM facts ORDER BY id');
    const mentionsBefore = count('mentions');

    const refused = await run(2, SAME_PAPER);
    expect(refused).toMatchObject({ ok: false, code: 'FACT_NOT_ESTABLISHED', chapter: 2 });
    // The row the earlier run wrote is not re-chaptered, restamped or re-dated.
    expect(rows('SELECT * FROM facts ORDER BY id')).toEqual(before);
    expect(before[0]).toMatchObject({ chapter: 3, key: 'document:77-1-арх', valid_from_chapter: 3 });
    // No mention of chapter 2 was written: a `use` of a later fact would be the same lie.
    expect(count('mentions')).toBe(mentionsBefore);
    expect(rows(`SELECT status, error FROM extraction_runs WHERE chapter = 2`)).toEqual([
      { status: 'refused', error: 'FACT_NOT_ESTABLISHED' },
    ]);
  });

  it('asks only the recall of a stored answer, and records no second extract run when it is refused', async () => {
    fixture = seed();
    const stored = await run(2, SAME_PAPER);
    expect(stored).toMatchObject({ ok: true, reused: false });
    const storedRun = stored.ok && !stored.reused ? stored.run : null;
    // The graph says chapter 3 established the paper first: the stored chapter 2 answer now names
    // a row of a later chapter, and the write refuses it after the first answer was reused.
    fixture.db
      .prepare(`UPDATE facts SET chapter = 3, valid_from_chapter = 3 WHERE key = 'document:77-1-арх'`)
      .run();
    const before = rows('SELECT * FROM facts ORDER BY id');
    const calls = fakeProvider(answerText(NOTHING));

    const refused = await extractChapter({
      db: fixture.db,
      chapter: 2,
      provider: calls,
      pipeline: PIPELINE,
      at: AT,
    });
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]?.system).toContain('THE RECALL PASS');
    expect(refused).toMatchObject({ ok: false, code: 'FACT_NOT_ESTABLISHED', run: null });
    if (refused.ok) throw new Error('expected a refusal');
    // The stored answer keeps its own run: the refused attempt asked only the recall.
    expect(refused.passes.extract.run).toBe(storedRun);
    expect(rows('SELECT * FROM facts ORDER BY id')).toEqual(before);
    expect(rows(`SELECT pass, status FROM extraction_runs WHERE chapter = 2 ORDER BY rowid`)).toEqual([
      { pass: 'extract', status: 'ok' },
    ]);
  });
});
