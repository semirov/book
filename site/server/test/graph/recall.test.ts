/**
 * The recall pass (BOOK-185, BOOK-DOC-77 §4): a second reader, one merge, two run rows.
 *
 * The provider is a list of scripted answers — no network, no key, no money. What the tests prove
 * is the contract: the recall only adds, a key the first pass asserted becomes a mention (not a
 * second fact, and not an `FACT_NOT_ESTABLISHED` when the recall writes it as a `use`), an edge
 * and a thread event merge without doubling, and a recall that fails loses nothing of the first
 * answer. The merge's own corner cases are arithmetic and live in `recallMerge.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractChapter,
  type ExtractOutcome,
  type Provider,
  type RecallInfo,
} from '../../src/graph/extract.ts';
import { ModelError } from '../../src/graph/model.ts';
import { NOTHING_ADDED } from '../../src/graph/recall.ts';
import { idOf } from '../../src/graph/text.ts';
import { ledgerFixture, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';
import {
  ANSWER_CH1,
  ANSWER_CH2,
  AT,
  AT_LATER,
  CH1,
  CH2,
  PIPELINE,
  answerText,
  fakeProvider,
} from './extractFixture.ts';

/**
 * What the second reader answers for chapter 2: a duplicate of pass 1's paper (with a longer
 * quote, so it is its own span), a new name, a `use` of pass 1's date, an edge and a move of the
 * thread pass 1 opened.
 */
const RECALL_CH2 = {
  facts: [
    { kind: 'document', value: '77/1/арх', term: 'акт', quote: 'акт 77/1/арх.' },
    { ref: 'r1', kind: 'name', value: 'Сорокин', term: 'Сорокин', quote: 'ведёт Сорокин' },
  ],
  uses: [{ kind: 'date', value: '14.09.2065', quote: 'Акт датирован 14.09.2065' }],
  edges: [
    {
      from: 'r1',
      to: { key: 'document:77-1-арх' },
      kind: 'document',
      quote: 'Дело 65/11877/арх ведёт Сорокин',
    },
  ],
  threads: [
    {
      label: 'дело 65/11877/арх',
      direction: 'forward',
      events: [{ kind: 'complicated', fact: 'r1' }],
    },
  ],
};

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function seed(): LedgerFixture {
  const seeded = ledgerFixture();
  seedChapter(seeded.db, { chapter: 1, texts: CH1 });
  seedChapter(seeded.db, { chapter: 2, texts: CH2 });
  return seeded;
}

function rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return fixture.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function count(table: string): number {
  return (fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function ask(
  chapter: number,
  provider: Provider,
  over: { force?: boolean; dryRun?: boolean; at?: string; noRecall?: boolean } = {},
): Promise<ExtractOutcome> {
  return extractChapter({
    db: fixture.db,
    chapter,
    provider,
    pipeline: PIPELINE,
    at: over.at ?? AT,
    ...(over.force === undefined ? {} : { force: over.force }),
    ...(over.dryRun === undefined ? {} : { dryRun: over.dryRun }),
    ...(over.noRecall === undefined ? {} : { noRecall: over.noRecall }),
  });
}

/** Chapter 1 is answered by the cheap path: the recall tests are about chapter 2. */
async function seedChapterOne(): Promise<void> {
  const outcome = await ask(1, fakeProvider(answerText(ANSWER_CH1)), { noRecall: true });
  if (!outcome.ok) throw new Error('chapter 1 should have been written');
}

function recallOf(outcome: ExtractOutcome): RecallInfo {
  return outcome.passes.recall;
}

describe('the recall adds to the first answer', () => {
  it('merges a new fact, a duplicate mention, a converted use, an edge and a thread move', async () => {
    fixture = seed();
    await seedChapterOne();
    const calls = fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2));
    const outcome = await ask(2, calls);
    expect(outcome).toMatchObject({ ok: true, reused: false, chapter: 2 });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    expect(calls.calls).toHaveLength(2);

    // Two facts of this chapter plus the recall's name; the duplicate paper is a mention, and the
    // recall's `use` of the pass-1 date is a mention too — neither is a second fact.
    expect(outcome.counts).toMatchObject({ facts: 3, uses: 1, mentions: 6, edges: 2, threads: 1 });
    expect(outcome.rejects).toEqual([]);

    const recall = recallOf(outcome);
    expect(recall).toMatchObject({
      skipped: false,
      ok: true,
      code: null,
      added: { facts: 1, edges: 1, threads: 0 },
    });

    expect(rows('SELECT key FROM facts ORDER BY key').map((row) => row.key)).toEqual([
      'date:2065-09-14',
      'document:65-11877-арх',
      'document:77-1-арх',
      'name:сорокин',
    ]);

    // The duplicate paper keeps the first pass's fact id and gets a second mention of its own.
    const paper = idOf('fct', 'document:77-1-арх');
    const mentions = rows(
      `SELECT fact_id, witness FROM mentions WHERE chapter = 2 AND fact_id = ? ORDER BY start, end`,
      paper,
    );
    expect(mentions.map((row) => row.witness)).toEqual(['акт 77/1/арх', 'акт 77/1/арх.']);

    // The converted use is a mention of the date the first pass asserted, not a rejection.
    const dateMentions = rows(
      `SELECT witness FROM mentions WHERE chapter = 2 AND fact_id = ? ORDER BY start`,
      idOf('fct', 'date:2065-09-14'),
    );
    expect(dateMentions.map((row) => row.witness)).toEqual(['Акт датирован 14.09.2065', '14.09.2065']);
  });

  it('stamps each row with the pass that first produced it', async () => {
    fixture = seed();
    await seedChapterOne();
    const outcome = await ask(2, fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2)));
    if (!outcome.ok || outcome.reused) throw new Error('expected a written run');

    const stamp = (raw: unknown): { run: string; pass: string } => JSON.parse(String(raw)) as { run: string; pass: string };
    const name = rows(`SELECT extracted_by FROM facts WHERE key = 'name:сорокин'`)[0] ?? {};
    const date = rows(`SELECT extracted_by FROM facts WHERE key = 'date:2065-09-14'`)[0] ?? {};
    expect(stamp(name.extracted_by).pass).toBe('recall');
    expect(stamp(date.extracted_by).pass).toBe('extract');

    // The edge the recall added names the recall run; the first pass's edge never does.
    const paper = idOf('fct', 'document:77-1-арх');
    const nameId = idOf('fct', 'name:сорокин');
    const edges = rows('SELECT from_fact, to_fact, extracted_by FROM fact_dependency');
    const recallEdge = edges.find((edge) => edge.from_fact === nameId);
    const firstEdge = edges.find((edge) => edge.from_fact === paper);
    expect(stamp(recallEdge?.extracted_by).pass).toBe('recall');
    expect(stamp(firstEdge?.extracted_by).pass).toBe('extract');

    // The thread was opened by the first pass and only moved by the recall: it keeps its stamp.
    const thread = rows('SELECT extracted_by FROM threads')[0] ?? {};
    expect(stamp(thread.extracted_by).pass).toBe('extract');
    expect(rows('SELECT kind FROM thread_events ORDER BY id').map((row) => row.kind)).toEqual([
      'opened',
      'advanced',
      'complicated',
    ]);
  });

  it('writes a second run row, with its own pass, tokens, counts and raw answer', async () => {
    fixture = seed();
    await seedChapterOne();
    const outcome = await ask(2, fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2)));
    if (!outcome.ok || outcome.reused) throw new Error('expected a written run');

    const runs = rows(
      `SELECT id, pass, status, response, facts, uses, edges, threads, tokens_in, prompt_sha
         FROM extraction_runs WHERE chapter = 2 ORDER BY at, rowid`,
    );
    expect(runs.map((run) => run.pass)).toEqual(['extract', 'recall']);
    expect(runs[1]).toMatchObject({
      id: outcome.passes.recall.skipped ? null : outcome.passes.recall.run,
      status: 'ok',
      response: answerText(RECALL_CH2),
      // The recall's counts are what it added, not what the validator accepted.
      facts: 1,
      uses: 0,
      edges: 1,
      threads: 0,
      tokens_in: 1000,
    });
    expect(runs[0]?.prompt_sha).not.toBe(runs[1]?.prompt_sha);
  });
});

describe('reuse with the recall on', () => {
  it('answers a completed pair without asking either question again', async () => {
    fixture = seed();
    await seedChapterOne();
    const first = await ask(2, fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2)));
    if (!first.ok || first.reused) throw new Error('expected a written run');
    const silent = fakeProvider(answerText(ANSWER_CH2));

    const again = await ask(2, silent);
    expect(silent.calls).toHaveLength(0);
    expect(again).toMatchObject({ ok: true, reused: true, run: first.run });
    if (!again.ok || !again.reused) throw new Error('expected a reuse');
    expect(again.passes.recall).toMatchObject({ skipped: false, ok: true, added: { facts: 1, edges: 1 } });
    expect(again.passes.recall.skipped ? null : again.passes.recall.run).toBe(
      first.passes.recall.skipped ? null : first.passes.recall.run,
    );
  });

  it('asks only the recall when the extract run is already stored', async () => {
    fixture = seed();
    await seedChapterOne();
    const single = await ask(2, fakeProvider(answerText(ANSWER_CH2)), { noRecall: true });
    if (!single.ok || single.reused) throw new Error('expected a written run');

    // One reply: the recall question. A second reply would prove the extract was re-asked.
    const calls = fakeProvider(answerText(RECALL_CH2));
    const again = await ask(2, calls);
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]?.system).toContain('THE RECALL PASS');
    expect(again).toMatchObject({ ok: true, reused: false });
    if (!again.ok || again.reused || again.dryRun) throw new Error('expected a written run');
    // The stored answer keeps its own run row: only the recall was asked, so only it is recorded.
    expect(again.run).toBe(single.run);
    expect(again.passes.extract.run).toBe(single.run);
    expect(again.passes.recall).toMatchObject({ skipped: false, ok: true, added: { facts: 1, edges: 1 } });
    expect(rows('SELECT pass FROM extraction_runs WHERE chapter = 2 ORDER BY at, rowid').map((row) => row.pass)).toEqual([
      'extract',
      'recall',
    ]);
    expect(count('facts')).toBe(4);
  });

  it('re-asks the extract when its stored answer cannot be read', async () => {
    fixture = seed();
    await seedChapterOne();
    const single = await ask(2, fakeProvider(answerText(ANSWER_CH2)), { noRecall: true });
    if (!single.ok || single.reused) throw new Error('expected a written run');
    // A hand-edited row is not an answer: the question is asked again rather than trusted.
    fixture.db.prepare(`UPDATE extraction_runs SET response = 'не JSON' WHERE id = ?`).run(single.run);

    const calls = fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2));
    const again = await ask(2, calls);
    expect(calls.calls).toHaveLength(2);
    expect(again).toMatchObject({ ok: true, reused: false });
    if (again.ok && !again.reused) expect(again.run).not.toBe(single.run);
  });

  it('reuses the extract run alone when --no-recall asks for the cheap path', async () => {
    fixture = seed();
    await seedChapterOne();
    await ask(2, fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2)));
    const silent = fakeProvider(answerText(ANSWER_CH2));
    const again = await ask(2, silent, { noRecall: true });
    expect(silent.calls).toHaveLength(0);
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(recallOf(again)).toEqual({ skipped: true });
  });

  it('--force re-asks both passes', async () => {
    fixture = seed();
    await seedChapterOne();
    const first = await ask(2, fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2)));
    if (!first.ok || first.reused) throw new Error('expected a written run');

    const calls = fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2));
    const forced = await ask(2, calls, { force: true, at: AT_LATER });
    expect(calls.calls).toHaveLength(2);
    expect(forced).toMatchObject({ ok: true, reused: false });
    expect(forced.run).not.toBe(first.run);
    expect(rows("SELECT pass FROM extraction_runs WHERE chapter = 2 ORDER BY at, rowid").map((row) => row.pass)).toEqual([
      'extract',
      'recall',
      'extract',
      'recall',
    ]);
  });
});

describe('--no-recall is one question', () => {
  it('asks the model once and writes one run row', async () => {
    fixture = seed();
    await seedChapterOne();
    const calls = fakeProvider(answerText(ANSWER_CH2));
    const outcome = await ask(2, calls, { noRecall: true });
    expect(calls.calls).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: true, reused: false });
    expect(recallOf(outcome)).toEqual({ skipped: true });
    expect(rows('SELECT pass FROM extraction_runs WHERE chapter = 2').map((row) => row.pass)).toEqual(['extract']);
    expect(count('facts')).toBe(3);
  });
});

describe('a recall that fails loses nothing', () => {
  it('keeps the first pass and records a refused recall run when the repair fails too', async () => {
    fixture = seed();
    await seedChapterOne();
    const calls = fakeProvider(answerText(ANSWER_CH2), 'не JSON', 'тоже не JSON');
    const outcome = await ask(2, calls);
    expect(calls.calls).toHaveLength(3);
    expect(outcome).toMatchObject({ ok: true, reused: false });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    expect(outcome.counts).toMatchObject({ facts: 2, uses: 1, edges: 1, threads: 1 });
    expect(recallOf(outcome)).toMatchObject({ skipped: false, ok: false, code: 'SCHEMA_INVALID' });
    expect(outcome.passes.recall.skipped ? [] : outcome.passes.recall.added).toEqual(NOTHING_ADDED);

    const recallRun =
      rows(
        `SELECT pass, status, error, response, facts FROM extraction_runs
          WHERE chapter = 2 AND pass = 'recall'`,
      )[0] ?? {};
    expect(recallRun).toEqual({ pass: 'recall', status: 'refused', error: 'SCHEMA_INVALID', response: 'тоже не JSON', facts: 0 });
    expect(count('facts')).toBe(3); // chapter 1's paper and chapter 2's two
  });

  it('records a transport failure as an error run and keeps the first pass', async () => {
    fixture = seed();
    await seedChapterOne();
    const base = fakeProvider(answerText(ANSWER_CH2));
    let calls = 0;
    const provider: Provider = async (request) => {
      calls += 1;
      if (calls === 1) return base(request);
      throw new ModelError('MODEL_TIMEOUT', 2);
    };
    const outcome = await ask(2, provider);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    expect(outcome.counts).toMatchObject({ facts: 2, uses: 1 });
    expect(recallOf(outcome)).toMatchObject({ skipped: false, ok: false, code: 'MODEL_TIMEOUT' });
    const run =
      rows(`SELECT status, error FROM extraction_runs WHERE chapter = 2 AND pass = 'recall'`)[0] ?? {};
    expect(run).toEqual({ status: 'error', error: 'MODEL_TIMEOUT' });
  });
});

describe('a dry run with the recall', () => {
  it('reports the merged answer and writes no run row at all', async () => {
    fixture = seed();
    await seedChapterOne();
    const before = count('extraction_runs');
    const outcome = await ask(2, fakeProvider(answerText(ANSWER_CH2), answerText(RECALL_CH2)), { dryRun: true });
    if (!outcome.ok || outcome.reused || !outcome.dryRun) throw new Error('expected a dry run');
    expect(outcome.accepted.facts).toHaveLength(5);
    expect(recallOf(outcome)).toMatchObject({ skipped: false, ok: true, added: { facts: 1, edges: 1 } });
    expect(count('extraction_runs')).toBe(before);
    expect(count('facts')).toBe(1); // chapter 1's paper only
  });
});
