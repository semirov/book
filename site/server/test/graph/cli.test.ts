/**
 * `bin/graph.mjs`'s command layer (BOOK-185): a chapter list is a chapter list, a missing data
 * directory is a usage error, and the commands leave a database the operator can read.
 *
 * The database is built here, the way the volume itself is built: the CLI reads a chapter's blocks
 * from rows and never a file, and the measurement run covers the real volume. The model is a
 * fake provider passed as the seam (`GraphDefaults.model`) — no network, no key, no money — so a
 * `--dry-run` and a `--pending` can be tested for what they do to the database rather than for
 * whether a key happens to be on the machine.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { parseChapters, runGraph, type ModelSeam } from '../../src/graph/cli.ts';
import { seedChapter } from '../ledger/helpers.ts';
import { ANSWER_CH1, LONG_TAIL, PIPELINE, answerText, fakeProvider } from './extractFixture.ts';

let dataDir: string | null = null;

afterEach(() => {
  if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

const io = (): { log: (line: string) => void; error: (line: string) => void; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (line) => out.push(line), error: (line) => err.push(line), out, err };
};

/** The fake model, injected where `bin/graph.mjs` would pass the real one. */
function seam(...replies: unknown[]): ModelSeam {
  return { pipeline: PIPELINE, provider: fakeProvider(...replies.map(answerText)) };
}

/** Chapter 2 consumes chapter 1's paper: a use, quoted from its own text. */
const ANSWER_CH2_USE = {
  facts: [],
  uses: [{ kind: 'document' as const, value: '65/11877/арх', quote: '65/11877/арх' }],
  edges: [],
  threads: [],
};

function prepare(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'book-graph-cli-'));
  dataDir = dir;
  const db = openDatabase(databaseFile(dir));
  migrate(db);
  seedChapter(db, { chapter: 1, texts: ['Номер 65/11877/арх.', 'Очередь стояла.'] });
  seedChapter(db, { chapter: 2, texts: ['Акт 65/11877/арх лежал в кармане.'] });
  return { db, dir };
}

function count(dir: string, table: string): number {
  const db = openDatabase(databaseFile(dir));
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('parseChapters', () => {
  it('reads ranges and single chapters in order', () => {
    expect(parseChapters('1-3,20')).toEqual([1, 2, 3, 20]);
    expect(parseChapters('20')).toEqual([20]);
    expect(parseChapters('3-1')).toBeNull();
    expect(parseChapters('0-2')).toBeNull();
    expect(parseChapters('1-68')).toBeNull();
    expect(parseChapters('первая')).toBeNull();
    expect(parseChapters('')).toBeNull();
  });
});

describe('runGraph', () => {
  it('extracts, reports and samples one database, in that order', async () => {
    const { db, dir } = prepare();
    db.close();
    const model = seam(ANSWER_CH1, ANSWER_CH2_USE);

    const extract = io();
    expect(
      await runGraph(['extract', '--data-dir', dir, '--chapters', '1,2', '--no-recall'], extract, {
        model,
      }),
    ).toBe(0);
    expect(extract.err).toEqual([]);
    const text = extract.out.join('\n');
    expect(text).toContain('recall: off');
    expect(text).toContain('ch01 rev 1 · facts 1 · uses 0 · edges 0 · threads 0 · rejects 0');
    expect(text).toContain('ch02 rev 1 · facts 0 · uses 1 · edges 0 · threads 0 · rejects 0');
    expect(text).toContain('model');
    expect(text).toContain('total: 2 chapters');
    expect(model.provider).toBeDefined();

    const report = io();
    expect(runGraph(['report', '--data-dir', dir, '--json'], report, {})).toBe(0);
    const parsed = JSON.parse(report.out.join('\n')) as {
      totals: {
        facts: number;
        threads: { total: number };
        runs: { total: number; ok: number; tokens: { in: number; out: number }; usd: number };
      };
      chapters: Array<{ chapter: number; gap: number; runs: { last: { run: string; model: string; promptSha: string } } }>;
    };
    expect(parsed.totals.facts).toBe(1);
    expect(parsed.totals.threads.total).toBe(0);
    // The ledger is what says how a chapter was produced and what it cost.
    expect(parsed.totals.runs).toMatchObject({ total: 2, ok: 2, tokens: { in: 2000, out: 400 } });
    expect(parsed.totals.runs.usd).toBeGreaterThan(0);
    expect(parsed.chapters.map((row) => row.chapter)).toEqual([1, 2]);
    expect(parsed.chapters[0]?.runs.last).toMatchObject({ model: 'deepseek-flash' });
    expect(parsed.chapters[0]?.runs.last.run).toMatch(/^run_/u);
    expect(parsed.chapters[0]?.runs.last.promptSha).toHaveLength(64);

    const samples = io();
    expect(runGraph(['samples', '--data-dir', dir, '--limit', '1'], samples, {})).toBe(0);
    const [sample] = JSON.parse(samples.out.join('\n')) as Array<Record<string, unknown>>;
    expect(sample).toMatchObject({
      chapter: 1,
      kind: 'document',
      key: 'document:65-11877-арх',
      witness: 'Номер 65/11877/арх',
      model: 'deepseek-flash',
    });
    expect(String(sample?.run)).toMatch(/^run_/u);
    expect(String(sample?.promptSha)).toHaveLength(64);
    expect(sample?.promptSha).toBe(parsed.chapters[0]?.runs.last.promptSha);
  });

  it('prints the report as a table when --json is absent', async () => {
    const { db, dir } = prepare();
    db.close();
    await runGraph(['extract', '--data-dir', dir, '--chapter', '1', '--no-recall'], io(), {
      model: seam(ANSWER_CH1),
    });
    const report = io();
    expect(runGraph(['report', '--data-dir', dir], report, {})).toBe(0);
    expect(report.out[0]).toContain('facts');
    expect(report.out.join('\n')).toContain('ledger_gap 0');
    expect(report.out.join('\n')).toContain('runs 1 — ok 1, refused 0, error 0');
  });

  it('a dry run asks the model, prints one JSON object per chapter and writes nothing', async () => {
    const { db, dir } = prepare();
    db.close();
    const fake = fakeProvider(answerText(ANSWER_CH1));
    const out = io();
    const code = await runGraph(
      ['extract', '--data-dir', dir, '--chapter', '1', '--dry-run', '--json', '--no-recall'],
      out,
      {
        model: { pipeline: PIPELINE, provider: fake },
      },
    );
    expect(code).toBe(0);
    const rows = out.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chapter: 1,
      rev: 1,
      run: null,
      mode: 'dry',
      ok: true,
      error: null,
      facts: 1,
      uses: 0,
      rejects: 0,
      tokens: { in: 1000, out: 200, cached: 0 },
      model: 'deepseek-flash',
    });
    expect(String(rows[0]?.promptSha)).toHaveLength(64);
    expect(Number(rows[0]?.usd)).toBeGreaterThan(0);
    // A dry run is a real question: it must have reached the transport.
    expect(fake.calls).toHaveLength(1);
    // …and nothing it answered landed in the database.
    expect(count(dir, 'extraction_runs')).toBe(0);
    expect(count(dir, 'facts')).toBe(0);
    expect(count(dir, 'mentions')).toBe(0);
  });

  it('asks the recall as a second question and reports both runs and what it added', async () => {
    const { db, dir } = prepare();
    db.close();
    const addition = {
      facts: [{ kind: 'term' as const, value: 'очередь', term: 'очередь', quote: 'Очередь стояла' }],
      uses: [],
      edges: [],
      threads: [],
    };
    const fake = fakeProvider(answerText(ANSWER_CH1), answerText(addition));
    const out = io();
    const code = await runGraph(['extract', '--data-dir', dir, '--chapter', '1', '--json'], out, {
      model: { pipeline: PIPELINE, provider: fake },
    });
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(out.err.join('\n')).toContain('recall: on');

    const row = JSON.parse(out.out[0] ?? '{}') as {
      runs: { extract: string; recall: string };
      tokensByPass: { extract: { in: number; out: number }; recall: { in: number; out: number } };
      tokens: { in: number; out: number };
      recallAdded: { facts: number; edges: number; threads: number };
      recall: { ok: boolean; error: string | null; rejects: number };
    };
    expect(row.runs.extract).toMatch(/^run_/u);
    expect(row.runs.recall).toMatch(/^run_/u);
    expect(row.runs.extract).not.toBe(row.runs.recall);
    expect(row.recallAdded).toEqual({ facts: 1, edges: 0, threads: 0 });
    expect(row.tokensByPass).toMatchObject({
      extract: { in: 1000, out: 200 },
      recall: { in: 1000, out: 200 },
    });
    expect(row.tokens).toMatchObject({ in: 2000, out: 400 });
    expect(row.recall).toMatchObject({ ok: true, error: null, rejects: 0 });
    expect(count(dir, 'extraction_runs')).toBe(2);
    expect(count(dir, 'facts')).toBe(2);

    // The table report says what the second pass bought, and what each pass cost.
    const report = io();
    expect(runGraph(['report', '--data-dir', dir], report, {})).toBe(0);
    const text = report.out.join('\n');
    expect(text).toContain('ch01 recall: +1 facts, +0 edges, +0 threads');
    expect(text).toContain('recall added 1 facts, 0 edges, 0 threads');
    expect(text).toContain('extract tokens 1000/200, recall tokens 1000/200 (in/out)');
  });

  it('prints a refusal, exits 1 and keeps the old rows off the graph', async () => {
    const { db, dir } = prepare();
    // Chapter 3 is long enough to count as written, and the model answers it with nothing.
    seedChapter(db, { chapter: 3, texts: [LONG_TAIL] });
    db.close();
    const out = io();
    const code = await runGraph(['extract', '--data-dir', dir, '--chapter', '3', '--no-recall'], out, {
      model: seam({ facts: [], uses: [], edges: [], threads: [] }),
    });
    expect(code).toBe(1);
    expect(out.out.join('\n')).toContain('refused:EMPTY_EXTRACTION');
    expect(out.err.join('\n')).toContain('1 of 1 chapters refused');
    expect(count(dir, 'extraction_runs')).toBe(1);
    expect(count(dir, 'facts')).toBe(0);
  });

  it('a forced re-ask is a second run row, and the report counts both', async () => {
    const { db, dir } = prepare();
    db.close();
    const narrowed = {
      facts: [{ kind: 'document' as const, value: '65/11877/арх', term: 'бумага', quote: 'Номер 65/11877/арх' }],
      uses: [],
      edges: [],
      threads: [],
    };
    const model = seam(ANSWER_CH1, narrowed);
    const first = io();
    expect(
      await runGraph(['extract', '--data-dir', dir, '--chapter', '1', '--no-recall'], first, {
        model,
      }),
    ).toBe(0);
    const forced = io();
    expect(
      await runGraph(
        ['extract', '--data-dir', dir, '--chapter', '1', '--force', '--json', '--no-recall'],
        forced,
        { model },
      ),
    ).toBe(0);
    const row = JSON.parse(forced.out.join('\n')) as { run: string; mode: string };
    expect(row.mode).toBe('model');

    const report = io();
    runGraph(['report', '--data-dir', dir, '--json'], report, {});
    const parsed = JSON.parse(report.out.join('\n')) as {
      chapters: Array<{ chapter: number; runs: { total: number; last: { run: string } } }>;
      totals: { runs: { total: number; ok: number } };
    };
    expect(parsed.totals.runs).toMatchObject({ total: 2, ok: 2 });
    // The report names the newest answer — the one a reuse would reply with.
    expect(parsed.chapters[0]?.runs.last.run).toBe(row.run);
    expect(parsed.chapters[0]?.runs.total).toBe(2);
  });

  it('--pending selects only chapters whose current text has no completed run', async () => {
    const { db, dir } = prepare();
    db.close();
    const model = seam(ANSWER_CH1, ANSWER_CH2_USE);
    expect(
      await runGraph(['extract', '--data-dir', dir, '--chapter', '1', '--no-recall'], io(), {
        model,
      }),
    ).toBe(0);

    const out = io();
    expect(
      await runGraph(['extract', '--data-dir', dir, '--pending', '--json', '--no-recall'], out, {
        model,
      }),
    ).toBe(0);
    const rows = out.out.map((line) => JSON.parse(line) as { chapter: number });
    expect(rows.map((row) => row.chapter)).toEqual([2]);

    // Now every written chapter is answered: a second --pending asks nothing and says so.
    const again = io();
    expect(
      await runGraph(['extract', '--data-dir', dir, '--pending', '--no-recall'], again, {
        model,
      }),
    ).toBe(0);
    expect(again.out.join('\n')).toContain('nothing to extract');
    expect(model.provider).toBeDefined();
  });

  it('refuses without a model key, naming the code and nothing else', async () => {
    const { db, dir } = prepare();
    db.close();
    const savedFile = process.env.DEEPSEEK_API_KEY_FILE;
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY_FILE;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const out = io();
      expect(await runGraph(['extract', '--data-dir', dir, '--chapter', '1'], out, {})).toBe(1);
      const message = out.err.join('\n');
      expect(message).toContain('KEY_MISSING');
      expect(message).not.toContain('DEEPSEEK_API_KEY_FILE=');
      expect(count(dir, 'extraction_runs')).toBe(0);
    } finally {
      if (savedFile === undefined) delete process.env.DEEPSEEK_API_KEY_FILE;
      else process.env.DEEPSEEK_API_KEY_FILE = savedFile;
      if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedKey;
    }
  });

  it('answers 2 for an unknown command, a bad flag, a missing --data-dir and no selector', async () => {
    const unknown = io();
    expect(runGraph(['nope'], unknown, {})).toBe(2);
    expect(unknown.err[0]).toContain('usage');

    const badFlag = io();
    expect(runGraph(['report', '--data-dir', '/tmp/x', '--wat'], badFlag, {})).toBe(2);

    const noDir = io();
    expect(runGraph(['samples'], noDir, {})).toBe(2);
    expect(noDir.err[0]).toContain('--data-dir is required');

    const badChapters = io();
    expect(await runGraph(['extract', '--data-dir', '/tmp/x', '--chapters', 'first'], badChapters, {})).toBe(2);

    const noSelector = io();
    expect(await runGraph(['extract', '--data-dir', '/tmp/x'], noSelector, {})).toBe(2);
    expect(noSelector.err[0]).toContain('--chapter');

    const twoSelectors = io();
    expect(
      await runGraph(['extract', '--data-dir', '/tmp/x', '--all', '--pending'], twoSelectors, {}),
    ).toBe(2);

    const badLimit = io();
    expect(runGraph(['samples', '--data-dir', '/tmp/x', '--limit', '0'], badLimit, {})).toBe(2);
  });

  it('answers 1 when the data directory holds no chapter to extract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-graph-empty-'));
    dataDir = dir;
    const db = openDatabase(databaseFile(dir));
    migrate(db);
    db.close();
    const result = io();
    expect(
      await runGraph(['extract', '--data-dir', dir, '--chapter', '1'], result, {
        model: seam(ANSWER_CH1),
      }),
    ).toBe(1);
    expect(result.err.join('\n')).toContain('no chapter row for 1');
  });

  it('refuses a chapter whose text is not in the volume with NO_CHAPTER_TEXT, and asks no model', async () => {
    // ADR-043, BOOK-DOC-76: the text is a row. A chapter row without blocks has nothing to ask
    // about, and the tool imports nothing — the one-shot import is the operator's door.
    const dir = mkdtempSync(join(tmpdir(), 'book-graph-notext-'));
    dataDir = dir;
    const db = openDatabase(databaseFile(dir));
    migrate(db);
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
       VALUES (3, 1, NULL, 'sha-empty', 0, 0, 0, ?, ?)`,
    ).run('2026-10-29T09:00:00Z', '2026-10-29T09:00:00Z');
    db.close();

    const fake = fakeProvider(answerText(ANSWER_CH1));
    const result = io();
    const code = await runGraph(['extract', '--data-dir', dir, '--chapter', '3'], result, {
      model: { pipeline: PIPELINE, provider: fake },
    });
    expect(code).toBe(1);
    expect(result.err.join('\n')).toContain('NO_CHAPTER_TEXT');
    expect(result.err.join('\n')).toContain('no blocks');
    expect(fake.calls).toHaveLength(0);
    // Nothing was imported behind the operator's back: the chapter still has no blocks.
    expect(count(dir, 'blocks')).toBe(0);
  });
});

describe('--max-output', () => {
  it('reaches both passes and is printed in the JSON run object', async () => {
    const { db, dir } = prepare();
    db.close();
    const fake = fakeProvider(answerText(ANSWER_CH1), answerText(ANSWER_CH1));
    const out = io();
    const code = await runGraph(
      ['extract', '--data-dir', dir, '--chapter', '1', '--max-output', '65536', '--json'],
      out,
      { model: { pipeline: PIPELINE, provider: fake } },
    );
    expect(code).toBe(0);
    const [row] = out.out.map((line) => JSON.parse(line) as { maxOutput: number; ok: boolean });
    expect(row).toMatchObject({ ok: true, maxOutput: 65536 });
    // Both passes ask with the flag: a recall cut at the pin loses the chapter just as a cut
    // extract does, and ch03's recall burned 31639 output tokens against a 32768 pin.
    expect(fake.calls[0]?.maxTokens).toBe(65536);
    expect(fake.calls[1]?.maxTokens).toBe(65536);
  });

  it('reports the pin cap when the flag is absent, and asks both passes with it', async () => {
    const { db, dir } = prepare();
    db.close();
    const fake = fakeProvider(answerText(ANSWER_CH1));
    const out = io();
    expect(
      await runGraph(['extract', '--data-dir', dir, '--chapter', '1', '--json'], out, {
        model: { pipeline: PIPELINE, provider: fake },
      }),
    ).toBe(0);
    const [row] = out.out.map((line) => JSON.parse(line) as { maxOutput: number });
    expect(row?.maxOutput).toBe(PIPELINE.maxOutputTokens);
    expect(fake.calls[0]?.maxTokens).toBe(PIPELINE.maxOutputTokens);
    expect(fake.calls[1]?.maxTokens).toBe(PIPELINE.maxOutputTokens);
  });

  it('exits 2 for a value that is not an integer in 1024..131072, and asks nothing', async () => {
    for (const value of ['abc', '0', '200000', '1023', '65.5']) {
      const { db, dir } = prepare();
      db.close();
      const fake = fakeProvider(answerText(ANSWER_CH1));
      const out = io();
      const code = await runGraph(
        ['extract', '--data-dir', dir, '--chapter', '1', '--max-output', value],
        out,
        { model: { pipeline: PIPELINE, provider: fake } },
      );
      expect(code, value).toBe(2);
      expect(out.out).toEqual([]);
      expect(fake.calls).toEqual([]);
      expect(count(dir, 'extraction_runs')).toBe(0);
    }
  });

  it('exits 2 when the flag carries no value at all', async () => {
    const out = io();
    expect(await runGraph(['extract', '--data-dir', '/tmp/x', '--chapter', '1', '--max-output'], out, {})).toBe(2);
    expect(out.err.join('\n')).toContain('--max-output');
  });
});
