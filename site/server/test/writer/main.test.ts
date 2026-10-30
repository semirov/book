/**
 * The CLI's arguments (`docs/writer-lane.md` §5): an unknown, duplicated or incomplete flag is a
 * refusal with exit 2, never a quietly ignored flag that runs something else.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EngineRefusalError, type EngineClient } from '../../src/writer/client.ts';
import { main, PARK_LIMIT, parseArgs, proseDelayMs } from '../../src/writer/main.ts';
import { chapterAnswer, createHarness, type Harness } from './harness.ts';

/** The row `writer_state` holds, as the test reads it — the counter that was `state.json`. */
const counterRow = (harness: Harness): { day: string; passes: number; last_pass_at: string | null } | undefined =>
  harness.fixture.db.prepare('SELECT day, passes, last_pass_at FROM writer_state WHERE id = 1').get() as
    | { day: string; passes: number; last_pass_at: string | null }
    | undefined;

/** The fixture's day, as the writer names it. */
const todayOf = (harness: Harness): string => new Date(harness.fixture.clock.now()).toISOString().slice(0, 10);

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

describe('parseArgs', () => {
  it('runs once by default', () => {
    expect(cliOf([])).toEqual({ mode: 'run', once: true, loop: false, dryRun: false, chapter: null, changeId: null, audit: null });
    expect(cliOf(['--once'])).toMatchObject({ mode: 'run', once: true, loop: false });
  });

  it('takes a chapter by value and by inline form', () => {
    expect(cliOf(['--chapter', '20']).chapter).toBe(20);
    expect(cliOf(['--chapter=20']).chapter).toBe(20);
    expect(cliOf(['--dry-run', '--chapter', '1'])).toMatchObject({ dryRun: true, chapter: 1 });
  });

  it('takes the sample audit with an optional count, and runs nothing else beside it', () => {
    // BOOK-DOC-80: `--audit-samples` alone takes the default (3), and `=N` names a count.
    expect(cliOf(['--audit-samples'])).toMatchObject({ mode: 'audit', audit: null });
    expect(cliOf(['--audit-samples=5'])).toMatchObject({ mode: 'audit', audit: 5 });
    expect(cliOf(['--audit-samples', '7'])).toMatchObject({ mode: 'audit', audit: 7 });
    expect(errorOf(['--audit-samples=0'])).toContain('positive integer');
    expect(errorOf(['--audit-samples', '--chapter', '9'])).toContain('runs alone');
  });

  it('knows the revert and the loop', () => {
    expect(cliOf(['--revert', '--chapter', '9'])).toMatchObject({ mode: 'revert', chapter: 9 });
    expect(cliOf(['--loop'])).toMatchObject({ mode: 'run', loop: true, once: false });
    expect(cliOf(['--help']).mode).toBe('help');
  });

  it('refuses what it cannot run', () => {
    expect(errorOf(['--chapter', '43'])).toContain('between 1 and 42');
    expect(errorOf(['--chapter', '0'])).toContain('between 1 and 42');
    expect(errorOf(['--chapter', 'nine'])).toContain('between 1 and 42');
    expect(errorOf(['--chapter'])).toContain('needs a value');
    expect(errorOf(['--revert'])).toContain('--revert needs --chapter');
    expect(errorOf(['--once', '--loop'])).toContain('two different shapes');
    expect(errorOf(['--loop', '--revert', '--chapter', '5'])).toContain('cannot revert');
    expect(errorOf(['--chapter', '5', '--chapter', '6'])).toContain('duplicate');
    expect(errorOf(['--nope'])).toContain('unknown flag');
    expect(errorOf(['extra'])).toContain('unexpected argument');
    expect(errorOf(['--once=yes'])).toContain('takes no value');
  });
});

describe('main', () => {
  it('exits 2 on an invalid flag, before loading any config', async () => {
    const lines: string[] = [];
    const code = await main({ argv: ['--nope'], env: {}, log: (line) => lines.push(line) });
    expect(code).toBe(2);
    expect(lines).toHaveLength(0);
  });

  it('exits 2 when the key is missing, and never prints a value', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      const code = await main({
        argv: ['--once'],
        env: { NODE_ENV: 'test', DEEPSEEK_API_KEY_FILE: '/nonexistent/key', DATA_DIR: '/tmp' },
        log: () => undefined,
      });
      expect(code).toBe(2);
      expect(errors.join('\n')).toContain('DEEPSEEK_API_KEY_FILE');
    } finally {
      console.error = original;
    }
  });

  it('prints the help and exits 0', async () => {
    const lines: string[] = [];
    const code = await main({ argv: ['--help'], env: {}, log: (line) => lines.push(line) });
    expect(code).toBe(0);
  });

  it('runs one pass, exits 0, and counts the pass for the day', async () => {
    const harness = await createHarness();
    try {
      // BOOK-166: the book is written only on a filing — the CLI asks for a chapter a reader filed.
      harness.premised(65, 'замысел главы 65: читатель просит начать с документа');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const lines: string[] = [];
      const code = await main({
        argv: ['--once', '--chapter', '20'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(harness.fixture.readChapter(20)).not.toBeNull();
      expect(existsSync(join(harness.bookRoot, 'manuscript'))).toBe(false);
      expect(lines.some((line) => line.includes('queued'))).toBe(true);
      // BOOK-187 AC5: the counter is the row, and the writer wrote no file at all.
      const state = counterRow(harness);
      expect(state?.passes).toBe(1);
      expect(state?.day).toBe(todayOf(harness));
      expect(state?.last_pass_at).not.toBeNull();
      expect(existsSync(join(harness.dataDir, 'writer'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('reads one triage pulse before the pass, so a manual run is not blind (BOOK-206 --once)', async () => {
    const harness = await createHarness();
    try {
      harness.premised(65, 'замысел главы 65: читатель просит начать с документа');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      // The engine is the real client, with a recorder in front: the pulse is visible as its own
      // `nextTriage` call, and the pass still runs afterwards.
      const calls: string[] = [];
      const engine = new Proxy(harness.client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]): unknown => {
            calls.push(String(property));
            return (value as (...rest: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as EngineClient;
      const lines: string[] = [];
      const code = await main({
        argv: ['--once', '--chapter', '20'],
        env: harness.env,
        provider: harness.provider,
        engine,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      // One pulse: the first empty `next` ends it without a second ask.
      expect(calls.filter((name) => name === 'nextTriage')).toHaveLength(1);
      expect(lines.some((line) => line.includes('триаж: прочитано 0'))).toBe(true);
      // And the pass the operator asked for still ran, after the pulse.
      expect(harness.fixture.readChapter(20)).not.toBeNull();
      expect(calls.lastIndexOf('nextTriage')).toBeLessThan(calls.indexOf('land'));
    } finally {
      await harness.close();
    }
  });

  it('exits 0 and calls nothing once the day’s passes are spent', async () => {
    const harness = await createHarness({ env: { WRITER_MAX_PASSES_PER_DAY: '1' } });
    try {
      const today = todayOf(harness);
      harness.fixture.db
        .prepare(
          `INSERT INTO writer_state (id, day, passes, last_pass_at, pause_until, updated_at)
           VALUES (1, ?, 1, NULL, NULL, ?)`,
        )
        .run(today, `${today}T09:00:00Z`);
      expect((await harness.client.writerState(today)).passes).toBe(1);

      // BOOK-166: the book is written only on a filing — the CLI asks for a chapter a reader filed.
      harness.premised(65, 'замысел главы 65: читатель просит начать с документа');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const lines: string[] = [];
      const code = await main({
        argv: ['--once'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('проходов на сегодня уже 1 из 1');
      expect(harness.calls).toHaveLength(0);
      // A row for another day is a fresh day: the read is the caller's clock, never a reset job.
      harness.fixture.db.prepare(`UPDATE writer_state SET day = '2026-01-01', passes = 9 WHERE id = 1`).run();
      expect((await harness.client.writerState(today)).passes).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('runs the pass when the counter cannot be read, and says so in one line', async () => {
    const harness = await createHarness();
    try {
      harness.premised(40, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      // An engine that cannot answer the counter must not stop the lane: the money budget is the
      // engine's own, and a read that fails only means this process counts the day from zero.
      const engine = new Proxy(harness.client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function' || property !== 'writerState' && property !== 'recordPass') return value;
          return (): never => {
            throw new EngineRefusalError('ENGINE_UNREACHABLE', 'the engine is unreachable', 0);
          };
        },
      }) as EngineClient;
      const lines: string[] = [];
      const code = await main({
        argv: ['--once', '--chapter', '40'],
        env: harness.env,
        provider: harness.provider,
        engine,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines.some((line) => line.includes('счётчик дня не прочитан'))).toBe(true);
      expect(lines.some((line) => line.includes('не записан в счётчик дня'))).toBe(true);
      expect(harness.fixture.readChapter(40)).not.toBeNull();
    } finally {
      await harness.close();
    }
  });
});

describe('main — --revert and --dry-run', () => {
  it('reverts a landed chapter and exits 0', async () => {
    const base = chapterAnswer('Глава двадцать', 'исходный');
    const harness = await createHarness({ chapters: { 20: base } });
    try {
      // A change over a chapter that already exists: the pass publishes revision 2, the revert
      // brings revision 1 back as revision 3 (BOOK-187).
      // Whole-chapter scope: the pass rewrites, so the revert has a second revision to undo.
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: 20,
        intent: 'в главе 20 появляется документ',
        scopeHint: 'chapter',
      });
      harness.script.push(chapterAnswer('Глава двадцать', 'новый'), 'HOLDS', 'HOLDS');
      const first = await main({
        argv: ['--once'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: () => undefined,
      });
      expect(first).toBe(0);
      expect(harness.fixture.readChapter(20)).toContain('новый');

      const lines: string[] = [];
      const code = await main({
        argv: ['--revert', '--chapter', '20'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(harness.fixture.readChapter(20)).toBe(base);
      expect(lines.join('\n')).toContain('новая ревизия 3 (было 2)');
      expect(existsSync(join(harness.bookRoot, 'manuscript'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('keeps the lane’s state in rows: writer_state and pass_transcripts, and no writer/ file', async () => {
    const harness = await createHarness({ chapters: { 30: chapterAnswer('Глава тридцать', 'исходный') } });
    try {
      harness.fixture.engine.enqueue({
        kind: 'operator',
        chapter: 30,
        intent: 'в главе 30 появляется документ',
        scopeHint: 'chapter',
      });
      harness.script.push(chapterAnswer('Глава тридцать', 'новый'), 'HOLDS', 'HOLDS');
      const code = await main({
        argv: ['--once'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: () => undefined,
      });
      expect(code).toBe(0);
      // The counter is a row (`writer_state`), written through the engine.
      expect(harness.fixture.db.prepare('SELECT passes FROM writer_state WHERE id = 1').get()).toEqual({ passes: 1 });
      // The receipt is rows (`pass_transcripts`), redacted at write.
      const rows = harness.fixture.db
        .prepare('SELECT role, content_redacted FROM pass_transcripts')
        .all() as Array<{ role: string; content_redacted: string }>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.content_redacted).not.toContain('Глава тридцать');
      // BOOK-187: the old homes — state.json, pre/ and transcripts/ — are gone, not moved.
      expect(existsSync(join(harness.dataDir, 'writer'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('builds the dry-run plan without an engine or a model and exits 0', async () => {
    const harness = await createHarness();
    try {
      const lines: string[] = [];
      const code = await main({
        argv: ['--dry-run', '--chapter', '5'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('"dryRun": true');
      expect(lines.join('\n')).toContain('модель не звана');
      expect(harness.calls).toHaveLength(0);
      expect(existsSync(join(harness.dataDir, 'writer', 'transcripts'))).toBe(false);
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });

      // Without --chapter it prints what it would do and stops there.
      const bare: string[] = [];
      const bareCode = await main({
        argv: ['--dry-run'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => bare.push(line),
      });
      expect(bareCode).toBe(0);
      expect(bare.join('\n')).toContain('без --chapter проход не строится');
    } finally {
      await harness.close();
    }
  });
});

/**
 * BOOK-DOC-84 §7 IFACE / D4 — the loop's pacing and its brake, as a process test.
 *
 * The old shape slept `WRITER_PAUSE_MS` (15 min) after **every** pass, so a chain of filings
 * read as a stalled book. Now a waiting filing is taken on `WRITER_BREATH_MS`, and the lane stops
 * itself (exit 1) after three consecutive parks instead of spinning.
 */
describe('main — the loop’s breath and its brake', () => {
  it('takes the next filing on the breath, never the 15-minute pause, and exits 1 after five parks', async () => {
    // A one-millisecond breath and the shipped pause: if the loop ever waits the pause, this
    // test times out instead of passing slowly. The engine's poll stays the shipped 100 ms floor.
    const harness = await createHarness({
      // §10.8: the brake is five parks, and a parked pass counts toward the day — so the day's
      // own bound is lifted here, or the day (4 passes) would stop the lane before five parks.
      env: { WRITER_BREATH_MS: '1', WRITER_PAUSE_MS: '900000', TRIAGE_POLL_MS: '100', WRITER_MAX_PASSES_PER_DAY: '10' },
    });
    try {
      for (const chapter of [40, 41, 42, 43, 44]) harness.premised(chapter, `в главе ${String(chapter)} появляется документ о допуске`);
      // Five refused answers, one per filing (§10.8's brake): each park closes its step and
      // leaves the next filing waiting, so the loop must walk all five on the breath and stop.
      for (let index = 0; index < 5; index += 1) harness.script.push('Извините, я не могу написать эту главу.', 'Извините, я не могу.');

      const lines: string[] = [];
      const started = Date.now();
      const code = await main({
        argv: ['--loop'],
        env: harness.env,
        provider: harness.provider,
        engine: harness.client,
        // The loop's own clock: a frozen one would never reach `proseDueAt` (the pacing is time).
        now: () => Date.now(),
        log: (line) => lines.push(line),
      });
      const elapsed = Date.now() - started;

      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('писатель остановлен после 5 отказов');
      // Three passes, not one pass and a 15-minute sleep: the whole run is a few seconds.
      expect(elapsed).toBeLessThan(15_000);
      const steps = harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number };
      expect(steps.n).toBe(5);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('sleeps the idle poll when nothing waits, and the breath when a filing does', () => {
    const config = { breathMs: 3_000, pauseMs: 900_000 };
    expect(proseDelayMs('closed', true, config)).toBe(3_000);
    expect(proseDelayMs('closed', false, config)).toBe(900_000);
    expect(proseDelayMs('refused', true, config)).toBe(3_000);
    expect(proseDelayMs('gone', true, config)).toBe(3_000);
    expect(proseDelayMs('parked', true, config)).toBe(3_000);
    expect(proseDelayMs('idle', true, config)).toBe(900_000);
    expect(PARK_LIMIT).toBe(5);
  });

  it('keeps the shipped breath at three seconds and the pause as the idle poll', async () => {
    const harness = await createHarness();
    try {
      expect(harness.config.breathMs).toBe(3_000);
      expect(harness.config.pauseMs).toBe(900_000);
    } finally {
      await harness.close();
    }
  });
});
