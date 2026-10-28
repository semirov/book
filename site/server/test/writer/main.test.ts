/**
 * The CLI's arguments (`docs/writer-lane.md` §5): an unknown, duplicated or incomplete flag is a
 * refusal with exit 2, never a quietly ignored flag that runs something else.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, parseArgs, readPassState } from '../../src/writer/main.ts';
import { chapterAnswer, createHarness } from './harness.ts';

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
    expect(cliOf([])).toEqual({ mode: 'run', once: true, loop: false, dryRun: false, chapter: null, changeId: null });
    expect(cliOf(['--once'])).toMatchObject({ mode: 'run', once: true, loop: false });
  });

  it('takes a chapter by value and by inline form', () => {
    expect(cliOf(['--chapter', '20']).chapter).toBe(20);
    expect(cliOf(['--chapter=20']).chapter).toBe(20);
    expect(cliOf(['--dry-run', '--chapter', '1'])).toMatchObject({ dryRun: true, chapter: 1 });
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
      expect(existsSync(join(harness.bookRoot, 'manuscript', 'ch20.md'))).toBe(true);
      expect(lines.some((line) => line.includes('queued'))).toBe(true);
      const state = JSON.parse(readFileSync(join(harness.dataDir, 'writer', 'state.json'), 'utf8')) as {
        date: string;
        passes: number;
      };
      expect(state.passes).toBe(1);
      expect(state.date).toBe(new Date(harness.fixture.clock.now()).toISOString().slice(0, 10));
    } finally {
      await harness.close();
    }
  });

  it('exits 0 and calls nothing once the day’s passes are spent', async () => {
    const harness = await createHarness({ env: { WRITER_MAX_PASSES_PER_DAY: '1' } });
    try {
      const today = new Date(harness.fixture.clock.now()).toISOString().slice(0, 10);
      const statePath = join(harness.dataDir, 'writer', 'state.json');
      mkdirSync(join(harness.dataDir, 'writer'), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify({ date: today, passes: 1 })}\n`, 'utf8');
      expect(readPassState(harness.dataDir, today).passes).toBe(1);

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
      // A counter for another day is a fresh day.
      writeFileSync(statePath, `${JSON.stringify({ date: '2026-01-01', passes: 9 })}\n`, 'utf8');
      expect(readPassState(harness.dataDir, today).passes).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

describe('main — --revert and --dry-run', () => {
  it('reverts a landed chapter and exits 0', async () => {
    const harness = await createHarness();
    try {
      harness.premised(65, 'замысел главы 65: читатель просит начать с документа');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const first = await main({
        argv: ['--once', '--chapter', '20'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: () => undefined,
      });
      expect(first).toBe(0);
      const target = join(harness.bookRoot, 'manuscript', 'ch20.md');
      expect(existsSync(target)).toBe(true);

      const lines: string[] = [];
      const code = await main({
        argv: ['--revert', '--chapter', '20'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(existsSync(target)).toBe(false);
      expect(lines.join('\n')).toContain('удалён');
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
