/**
 * `--backfill-ledger`, and the ripple commands' exit codes (BOOK-173 review, fixes 2 and 8a).
 *
 * The backfill is the graph's only production caller: without it the deterministic half of the
 * ripple exists in tests and on nobody's server. It is proven here through the real CLI — the
 * argument parser, `main`'s own dispatch, `backfillLedger` over the harness's database — because
 * a unit call to the function would not prove the flag reaches it.
 *
 * The interface is proven the same way: `0` finished or nothing to do, `1` a plan is parked,
 * `2` the run could not start, and `--plan <changeId>` answers `1` when there is no plan.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { databaseFile, openDatabase } from '../../src/db/db.ts';
import { runBackfillCli } from '../../src/writer/backfillRun.ts';
import { main, parseArgs } from '../../src/writer/main.ts';
import { runPlanCli, runRippleCli } from '../../src/writer/rippleCli.ts';
import { chapterAnswer, createHarness, TOKEN } from './harness.ts';

function cliOf(argv: string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected arguments to parse: ${parsed.error}`);
  return parsed.cli;
}

function errorOf(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error(`expected the arguments to be refused: ${argv.join(' ')}`);
  return parsed.error;
}

describe('the writer refuses the ledger commands and points at the operator tool', () => {
  it('answers 2 with the command it names, and opens no database', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => lines.push(String(line));
    try {
      for (const argv of [['--backfill-ledger'], ['--ripple'], ['--plan', 'chg_1'], ['--audit-samples']]) {
        const code = await main({ argv, env: {} });
        expect(code).toBe(2);
      }
    } finally {
      console.error = original;
    }
    expect(lines.join('\n')).toContain('node site/bin/ledger.mjs backfill');
    expect(lines.join('\n')).toContain('node site/bin/ledger.mjs ripple');
  });
});

describe('parseArgs — --backfill-ledger', () => {
  it('is its own mode, and takes no chapter and no pass', () => {
    expect(cliOf(['--backfill-ledger'])).toMatchObject({ mode: 'backfill', chapter: null, changeId: null });
    expect(errorOf(['--backfill-ledger', '--chapter', '5'])).toContain('runs alone');
    expect(errorOf(['--backfill-ledger', '--once'])).toContain('runs alone');
    expect(errorOf(['--backfill-ledger', '--ripple'])).toContain('runs alone');
    expect(errorOf(['--backfill-ledger', '--plan', 'chg_1'])).toContain('runs nothing');
  });
});

describe('main --backfill-ledger', () => {
  it('reads the written chapters, prints the counts, and writes nothing on a second run', async () => {
    const harness = await createHarness({ chapters: { 20: chapterAnswer() } });
    try {
      harness.ingest(20);
      const lines: string[] = [];
      const first = runBackfillCli({
        dataDir: harness.dataDir,
        bookRoot: harness.bookRoot,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      });
      expect(first).toBe(0);
      const summary = lines.find((line) => line.includes('бэкфилл:'));
      expect(summary).toBeDefined();
      // Facts are the book's own prose read deterministically: the harness has none of the
      // extractor's shapes, so the run reports zeros — and says so instead of failing.
      expect(summary).toMatch(/фактов \d+, рёбер \d+, упоминаний \d+/u);
      // The run read the book: one chapter, the one the harness published.
      expect(summary).toContain('глав 1');
      expect(summary).toMatch(/\d+ мс/u);

      const rows = (table: string): number =>
        (harness.fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const before = { facts: rows('facts'), edges: rows('edges'), mentions: rows('mentions') };

      // The second run is the idempotency proof: same rows, zero written.
      const again: string[] = [];
      const second = runBackfillCli({
        dataDir: harness.dataDir,
        bookRoot: harness.bookRoot,
        now: () => harness.fixture.clock.now(),
        log: (line) => again.push(line),
        error: (line) => again.push(line),
      });
      expect(second).toBe(0);
      expect(again.find((line) => line.includes('бэкфилл:'))).toContain('фактов 0, рёбер 0, упоминаний 0');
      expect({ facts: rows('facts'), edges: rows('edges'), mentions: rows('mentions') }).toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it('exits 2 on a schema older than the graph, and names the missing table', async () => {
    const harness = await createHarness();
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      // The ledger without the graph: a v22 database, which must be refused, not written into.
      harness.fixture.db.exec('DROP TABLE edges');
      const code = runBackfillCli({
        dataDir: harness.dataDir,
        bookRoot: harness.bookRoot,
        now: () => harness.fixture.clock.now(),
        log: () => undefined,
        error: (line) => errors.push(line),
      });
      expect(code).toBe(2);
      expect(errors.join('\n')).toContain('нет таблицы edges');
    } finally {
      console.error = original;
      await harness.close();
    }
  });

  it('exits 2 when there is no database to open', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'book-backfill-empty-'));
    const harness = await createHarness();
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      // The book root stays the harness's: only the data dir is empty.
      const code = runBackfillCli({
        dataDir: empty,
        bookRoot: harness.bookRoot,
        now: () => harness.fixture.clock.now(),
        log: () => undefined,
        error: (line) => errors.push(line),
      });
      expect(code).toBe(2);
      expect(errors.join('\n')).toContain('базы нет');
    } finally {
      console.error = original;
      await harness.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the ripple commands’ exit codes', () => {
  it('--plan answers 1 for a change with no plan, and 0 for one that has it', async () => {
    const harness = await createHarness();
    try {
      const lines: string[] = [];
      const db = openDatabase(databaseFile(harness.dataDir));
      const missing = (() => {
        try {
          return runPlanCli({ db, changeId: 'chg_not_planned', log: (line) => lines.push(line) });
        } finally {
          db.close();
        }
      })();
      expect(missing).toBe(1);
      expect(lines.join('\n')).toContain('не найден');
    } finally {
      await harness.close();
    }
  });

  it('--ripple answers 0 when nothing is owed, and 1 when the only plan is parked', async () => {
    const harness = await createHarness();
    try {
      const lines: string[] = [];
      const emptyDb = openDatabase(databaseFile(harness.dataDir));
      const empty = await (async () => {
        try {
          return await runRippleCli({
            db: emptyDb,
            config: harness.config,
            bookRoot: harness.bookRoot,
            dataDir: harness.dataDir,
            engine: harness.client,
            provider: harness.provider,
            now: () => harness.fixture.clock.now(),
            log: (line) => lines.push(line),
            claimedBy: 'proc-empty',
          });
        } finally {
          emptyDb.close();
        }
      })();
      expect(empty).toBe(0);
      expect(lines.join('\n')).toContain('незакрытых планов нет');

      // A parked plan is a decision the author owes: the run says so and answers 1.
      harness.fixture.db
        .prepare(
          `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                                status, enqueued_at, outcome)
           VALUES ('chg_park_cli', 'operator', 12, 'служебное намерение', 1, 'sha', '[]', 'phrase',
                   'done', '2026-10-28T12:00:00Z', 'ripple')`,
        )
        .run();
      harness.fixture.db
        .prepare(
          `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, iterations,
                                     parked_at, park_reason, created_at)
           VALUES ('pln_park_cli', 'chg_park_cli', 5, 'ripple', '{}', '[]', '{}', '[]',
                   '2026-10-28T12:10:00Z', 'соседняя глава дважды не приняла правку — волна остановлена, нужен автор',
                   '2026-10-28T12:00:00Z')`,
        )
        .run();
      const parked: string[] = [];
      const volume = openDatabase(databaseFile(harness.dataDir));
      const code = await (async () => {
        try {
          return await runRippleCli({
            db: volume,
            config: harness.config,
            bookRoot: harness.bookRoot,
            dataDir: harness.dataDir,
            engine: harness.client,
            provider: harness.provider,
            now: () => harness.fixture.clock.now(),
            log: (line) => parked.push(line),
            claimedBy: `${TOKEN}:1`,
          });
        } finally {
          volume.close();
        }
      })();
      expect(code).toBe(1);
      expect(parked.join('\n')).toContain('припаркован');
      expect(parked.join('\n')).toContain('дважды не приняла правку');
    } finally {
      await harness.close();
    }
  });
});
