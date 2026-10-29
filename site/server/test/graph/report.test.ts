/**
 * The report and the samples read the run ledger (BOOK-185, BOOK-DOC-77 §5).
 *
 * Two questions a person actually asks of a finished pass: «what produced this chapter's rows»
 * (the model and prompt sha, the runs, the money, the reject codes) and «show me a fact against
 * its prose, and say which run wrote it». Both answers live on the rows, so the fixture seeds rows
 * — a run ledger entry per pass, a fact that names its run, a mention with offsets — and the tests
 * assert what the terminal prints rather than re-running a recogniser.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { buildReport, renderReport } from '../../src/graph/report.ts';
import { buildSamples } from '../../src/graph/samples.ts';
import { graphFixture, seedFact, seedMention, type GraphFixture } from './helpers.ts';

const AT = '2026-10-28T12:00:00Z';

let fixture: GraphFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function seedChapterRow(db: Db, chapter: number): void {
  db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
     VALUES (?, 1, NULL, 'sha', 100, 1, 0, ?, ?)`,
  ).run(chapter, AT, AT);
}

function seedRun(
  db: Db,
  over: {
    id: string;
    chapter: number;
    pass?: 'extract' | 'recall';
    status?: string;
    rejects?: unknown[];
    tokensIn?: number;
    usd?: number;
    counts?: { facts?: number; edges?: number; threads?: number };
  },
): void {
  db.prepare(
    `INSERT INTO extraction_runs
       (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status, response,
        tokens_in, tokens_out, tokens_cached, usd, facts, edges, threads, rejects, error)
     VALUES (?, ?, 1, 'sha-text', ?, 'deepseek-flash', ?, ?, ?, '{}', ?, 10, 2, ?, ?, ?, ?, ?, ?)`,
  ).run(
    over.id,
    over.chapter,
    `sha-prompt-${over.id}`,
    over.pass ?? 'extract',
    AT,
    over.status ?? 'ok',
    over.tokensIn ?? 100,
    over.usd ?? 0.0001,
    over.counts?.facts ?? 0,
    over.counts?.edges ?? 0,
    over.counts?.threads ?? 0,
    JSON.stringify(over.rejects ?? []),
    over.status === undefined || over.status === 'ok' ? null : 'REFUSED_FOR_THE_TEST',
  );
}

describe('the report over the run ledger', () => {
  it('names what extracted a chapter, and counts the runs, the tokens, the money and the rejects', () => {
    fixture = graphFixture();
    const db = fixture.db;
    seedChapterRow(db, 1);
    seedRun(db, {
      id: 'run_old',
      chapter: 1,
      rejects: [{ code: 'QUOTE_NOT_FOUND', path: 'facts[0]', item: {}, quote: '', reason: '' }],
    });
    seedRun(db, { id: 'run_new', chapter: 1, tokensIn: 300, usd: 0.0004 });
    seedRun(db, { id: 'run_refused', chapter: 1, status: 'refused' });

    const report = buildReport(db);
    const chapter = report.chapters[0];
    // The newest completed run is the one a reuse would answer with.
    expect(chapter?.runs.last).toMatchObject({ run: 'run_new', model: 'deepseek-flash' });
    expect(chapter?.runs).toMatchObject({ total: 3, ok: 2, refused: 1, error: 0 });
    expect(chapter?.runs.tokens.in).toBe(500);
    expect(chapter?.runs.usd).toBeCloseTo(0.0006, 9);
    expect(chapter?.runs.rejects).toEqual({ QUOTE_NOT_FOUND: 1 });
    expect(report.totals.runs).toMatchObject({ total: 3, ok: 2, refused: 1 });
    expect(report.totals.runs.tokens).toEqual({ in: 500, out: 30, cached: 6 });
    expect(report.totals.runs.rejects).toEqual({ QUOTE_NOT_FOUND: 1 });

    const text = renderReport(report).join('\n');
    expect(text).toContain('deepseek-flash@sha-prom');
    expect(text).toContain('runs 3 — ok 2, refused 1, error 0');
    expect(text).toContain('rejects QUOTE_NOT_FOUND=1');
    expect(text).toContain('refused 1, error 0 — rejects QUOTE_NOT_FOUND=1');
  });

  it('splits the two passes’ tokens and reads what the recall added', () => {
    fixture = graphFixture();
    const db = fixture.db;
    seedChapterRow(db, 1);
    seedRun(db, { id: 'run_extract', chapter: 1, tokensIn: 1000, usd: 0.0004 });
    seedRun(db, {
      id: 'run_recall',
      chapter: 1,
      pass: 'recall',
      tokensIn: 600,
      usd: 0.0002,
      counts: { facts: 2, edges: 1, threads: 1 },
    });

    const report = buildReport(db);
    const chapter = report.chapters[0];
    expect(chapter?.runs.passes.extract).toMatchObject({ runs: 1, ok: 1, tokens: { in: 1000, out: 10 } });
    expect(chapter?.runs.passes.recall).toMatchObject({ runs: 1, ok: 1, tokens: { in: 600, out: 10 } });
    expect(chapter?.runs.recallAdded).toEqual({ facts: 2, edges: 1, threads: 1 });
    expect(report.totals.runs.passes.recall.tokens.in).toBe(600);
    expect(report.totals.runs.recallAdded).toEqual({ facts: 2, edges: 1, threads: 1 });
    expect(report.totals.runs.tokens.in).toBe(1600);

    const text = renderReport(report).join('\n');
    expect(text).toContain('ch01 recall: +2 facts, +1 edges, +1 threads');
    expect(text).toContain('extract tokens 1000/10, recall tokens 600/10 (in/out)');
    expect(text).toContain('recall added 2 facts, 1 edges, 1 threads');
  });

  it('counts a broken rejects column as UNREADABLE instead of failing the report', () => {
    fixture = graphFixture();
    const db = fixture.db;
    seedChapterRow(db, 1);
    seedRun(db, { id: 'run_ok', chapter: 1 });
    db.prepare(`UPDATE extraction_runs SET rejects = 'not json' WHERE id = 'run_ok'`).run();
    expect(buildReport(db).totals.runs.rejects).toEqual({ UNREADABLE: 1 });
  });
});

describe('the samples and their provenance', () => {
  it('carries the run, the model and the prompt sha that wrote the fact', () => {
    fixture = graphFixture();
    const db = fixture.db;
    seedChapterRow(db, 1);
    seedRun(db, { id: 'run_one', chapter: 1 });
    seedFact(db, { id: 'fct_a', chapter: 1, kind: 'document', key: 'document:65-11877-арх', sentence: 'Номер 65/11877/арх.' });
    db.prepare(
      `UPDATE facts SET extracted_by = ? WHERE id = 'fct_a'`,
    ).run(JSON.stringify({ run: 'run_one', model: 'deepseek-flash', prompt: 'sha-prompt-x', at: AT, pass: 'extract' }));
    seedMention(db, { factId: 'fct_a', chapter: 1, witness: '65/11877/арх', blockId: 'blk_1_1', start: 6 });

    expect(buildSamples(db, 10)).toEqual([
      expect.objectContaining({
        chapter: 1,
        kind: 'document',
        key: 'document:65-11877-арх',
        quote: 'Номер 65/11877/арх.',
        witness: '65/11877/арх',
        run: 'run_one',
        model: 'deepseek-flash',
        promptSha: 'sha-prompt-x',
        pass: 'extract',
      }),
    ]);
  });

  it('leaves the provenance blank for a row no run wrote, and skips a retired fact', () => {
    fixture = graphFixture();
    const db = fixture.db;
    seedChapterRow(db, 1);
    seedFact(db, { id: 'fct_legacy', chapter: 1, kind: 'term' });
    seedMention(db, { factId: 'fct_legacy', chapter: 1, witness: 'statement fct_legacy' });
    seedFact(db, { id: 'fct_gone', chapter: 1, kind: 'term', key: 'term:gone' });
    seedMention(db, { factId: 'fct_gone', chapter: 1, witness: 'sentence fct_gone' });
    db.prepare(`UPDATE facts SET superseded_by_extraction = NULL, invalidated_at = ? WHERE id = 'fct_gone'`).run(AT);

    const samples = buildSamples(db, 10);
    expect(samples.map((sample) => sample.key)).toEqual(['fct_legacy']);
    expect(samples[0]).toMatchObject({ run: '', model: '', promptSha: '', pass: '' });
  });
});
