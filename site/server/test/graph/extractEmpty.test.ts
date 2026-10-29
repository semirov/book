/**
 * `EMPTY_EXTRACTION` (BOOK-185, BOOK-DOC-77 §5): an empty answer to a **written** chapter is a
 * refusal, not a result.
 *
 * The reason lives in the persistence step: an answer is what the chapter now says, so every row
 * of the chapter the answer no longer states is superseded. An empty answer would therefore retire
 * the chapter's whole graph in one call — the failure mode this guard exists for. A chapter under
 * the prose threshold (basis, front matter) may legitimately be empty, and that half is tested too,
 * so the guard cannot become «any empty answer is refused».
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractChapter, type ExtractOutcome, type Provider } from '../../src/graph/extract.ts';
import { ledgerFixture, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';
import {
  ANSWER_CH2,
  AT,
  AT_LATER,
  CH2,
  LONG_TAIL,
  PIPELINE,
  answerText,
  fakeProvider,
} from './extractFixture.ts';

const NOTHING = { facts: [], uses: [], edges: [], threads: [] };

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function seed(texts: Record<number, string[]>): LedgerFixture {
  const seeded = ledgerFixture();
  for (const [chapter, lines] of Object.entries(texts)) {
    seedChapter(seeded.db, { chapter: Number(chapter), texts: lines });
  }
  return seeded;
}

async function run(
  chapter: number,
  answer: unknown,
  over: { force?: boolean; dryRun?: boolean; at?: string; provider?: Provider } = {},
): Promise<ExtractOutcome> {
  return extractChapter({
    db: fixture.db,
    chapter,
    provider: over.provider ?? fakeProvider(answerText(answer)),
    pipeline: PIPELINE,
    at: over.at ?? AT,
    ...(over.force === undefined ? {} : { force: over.force }),
    ...(over.dryRun === undefined ? {} : { dryRun: over.dryRun }),
    // The guard is about the answer, not about the number of calls: the recall is off except in
    // the one test that proves the merged answer is what `EMPTY_EXTRACTION` is judged on.
    noRecall: true,
  });
}

function rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return fixture.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function count(table: string): number {
  return (fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Everything the graph holds, without the run ledger: a refusal must leave this untouched. */
function graphSnapshot(): string {
  return JSON.stringify({
    facts: rows('SELECT * FROM facts ORDER BY id'),
    mentions: rows('SELECT * FROM mentions ORDER BY id'),
    literals: rows('SELECT * FROM literals ORDER BY id'),
    edges: rows('SELECT * FROM fact_dependency ORDER BY id'),
    threads: rows('SELECT * FROM threads ORDER BY id'),
    events: rows('SELECT * FROM thread_events ORDER BY id'),
    chapters: rows('SELECT n, ledger_gap FROM chapters ORDER BY n'),
  });
}

/** A chapter long enough to count as written: the threshold is 1000 prose characters. */
const WRITTEN = [CH2[0] ?? '', CH2[1] ?? '', CH2[2] ?? '', LONG_TAIL];

describe('EMPTY_EXTRACTION', () => {
  it('refuses an empty answer to a written chapter and keeps every old row', async () => {
    fixture = seed({ 4: WRITTEN });
    const first = await run(4, ANSWER_CH2);
    expect(first).toMatchObject({ ok: true, reused: false });
    const before = graphSnapshot();

    const empty = await run(4, NOTHING, { force: true, at: AT_LATER });
    expect(empty).toMatchObject({ ok: false, code: 'EMPTY_EXTRACTION', chapter: 4 });
    if (empty.ok) throw new Error('expected a refusal');
    // Nothing was applied: the chapter still holds what the previous run wrote.
    expect(graphSnapshot()).toBe(before);
    expect(count('facts')).toBe(2);

    // The answer is kept verbatim, with the code an operator can search for.
    const latest =
      rows(
        `SELECT id, status, error, response, facts, tokens_in FROM extraction_runs
          WHERE chapter = 4 ORDER BY at DESC, rowid DESC LIMIT 1`,
      )[0] ?? {};
    expect(latest).toEqual({
      id: String(empty.run),
      status: 'refused',
      error: 'EMPTY_EXTRACTION',
      response: answerText(NOTHING),
      facts: 0,
      tokens_in: 1000,
    });
    // The old run is still in the ledger, untouched: a refusal is another row, not a rewrite.
    expect(count('extraction_runs')).toBe(2);
  });

  it('lets a chapter under the prose threshold be empty', async () => {
    // A basis-length chapter: nothing to find is a legitimate answer, not a refusal.
    fixture = seed({ 3: ['Дело 65/11877/арх лежало в сейфе.'] });
    const outcome = await run(3, NOTHING);
    expect(outcome).toMatchObject({ ok: true, reused: false, chapter: 3 });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    expect(outcome.counts).toMatchObject({ facts: 0, uses: 0, edges: 0, threads: 0 });
    const runRow = rows('SELECT status, error FROM extraction_runs WHERE chapter = 3')[0] ?? {};
    expect(runRow).toEqual({ status: 'ok', error: null });
  });

  it('judges EMPTY_EXTRACTION on the merged answer: a recall that finds something is a result', async () => {
    fixture = seed({ 4: WRITTEN });
    const provider = fakeProvider(answerText(NOTHING), answerText(ANSWER_CH2));
    const outcome = await extractChapter({ db: fixture.db, chapter: 4, provider, pipeline: PIPELINE, at: AT });
    expect(outcome).toMatchObject({ ok: true, reused: false });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    // The first pass said nothing; the second found two facts and a thread, and that is a result.
    expect(outcome.passes.recall).toMatchObject({
      skipped: false,
      ok: true,
      added: { facts: 2, edges: 0, threads: 1 },
    });
    expect(outcome.counts.facts).toBe(2);
    expect(count('facts')).toBe(2);
  });

  it('records the recall run as refused, not ok, when the merged answer is empty', async () => {
    // BOOK-185 defect 8: the second call succeeded, but nothing it answered was persisted. A run
    // row that says `ok` about an answer the graph never took is a lie the audit cannot see.
    fixture = seed({ 4: WRITTEN });
    const outcome = await extractChapter({
      db: fixture.db,
      chapter: 4,
      provider: fakeProvider(answerText(NOTHING), answerText(NOTHING)),
      pipeline: PIPELINE,
      at: AT,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'EMPTY_EXTRACTION', chapter: 4 });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.passes.recall.skipped ? null : outcome.passes.recall.added).toEqual({ facts: 0, edges: 0, threads: 0 });
    expect(rows(`SELECT pass, status, error FROM extraction_runs WHERE chapter = 4 ORDER BY rowid`)).toEqual([
      { pass: 'extract', status: 'refused', error: 'EMPTY_EXTRACTION' },
      { pass: 'recall', status: 'refused', error: 'EMPTY_EXTRACTION' },
    ]);
    expect(count('facts')).toBe(0);
  });

  it('refuses a written chapter in a dry run too, and writes no run row', async () => {
    fixture = seed({ 4: WRITTEN });
    const outcome = await run(4, NOTHING, { dryRun: true });
    expect(outcome).toMatchObject({ ok: false, code: 'EMPTY_EXTRACTION', run: null });
    expect(count('extraction_runs')).toBe(0);
  });
});
