/**
 * BOOK-187 — `bin/validate.mjs` in its three modes, run as the deploy and the hook run it.
 *
 * What each mode is for, and what is proven here:
 *   * `--from-db <dataDir>` — the deploy gate. The rows are projected into a **temporary** tree,
 *     the shared rules run over it exactly as over a manuscript, and the tree is deleted. A
 *     finding names the chapter's own file name; a temp directory never survives the run.
 *   * `--staged` — the pre-commit hook. There is no prose in git any more, so the only rule left
 *     is that none comes back: a staged `manuscript/` path fails and is named.
 *   * no flag — image mode: the imprint, the denylist and the planning files, with the text rules
 *     named as skipped because the book is not there.
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const exec = promisify(execFile);

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

/** A child `node` must not inherit vitest's coverage collector (see `commitGate.test.ts`). */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  return env;
}

async function validate(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('node', ['bin/validate.mjs', ...args], { cwd: SITE_ROOT, env: childEnv() });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** A chapter inside the band (F007: 10 000–30 000 characters), so a clean book is clean. */
function fullProse(body: string): string {
  const filler =
    'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги.';
  let text = `Тестовая глава\n\n${body}`;
  while (text.length < 11_000) text += `\n\n${filler}`;
  return `${text}\n`;
}

/** The temp directories `--from-db` projects into, so a leak is visible. */
function projections(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('book-validate-'));
}

/** A volume with a book in it: rows only, no manuscript. */
function volume(chapters: Record<string, string>): { fixture: Fixture; close: () => void } {
  const fixture = createFixture({ '00-front.md': `Без названия\n\n${ABOUT}\n`, ...chapters });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  // The volume is what it is: `book.db` and its WAL, no manuscript beside it.
  return { fixture, close: () => fixture.close() };
}

describe('--from-db: the text as stored, projected to a temp tree', () => {
  it('runs the rules over the rows and names the chapter file a finding is in', async () => {
    const book = volume({ 'ch09.md': longProse(['Вчера Владимир Путин приехал в город.']) });
    const before = projections();
    try {
      const result = await validate([`--from-db=${book.fixture.dataDir}`]);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/F005 error ch09\.md/u);
      expect(result.out).toMatch(/denylisted person: «Владимир Путин»/u);
      expect(result.out).toMatch(/text \(DB\): 1 chapters/u);
      // The projection is never a home: the temp tree is gone and the volume gained nothing —
      // no `manuscript/`, no derivative of the render.
      expect(projections()).toEqual(before);
      const volume = readdirSync(book.fixture.dataDir).sort();
      expect(volume).not.toContain('manuscript');
      expect(volume).not.toContain('index');
      expect(volume).toContain('book.db');
    } finally {
      book.close();
    }
  });

  it('passes a clean book, and `--strict` too', async () => {
    const book = volume({ 'ch09.md': fullProse('Тестовый абзац поднял Тестов Тестович, сторож с ночной смены.') });
    try {
      const plain = await validate([`--from-db=${book.fixture.dataDir}`]);
      expect(plain.code, plain.out).toBe(0);
      expect(plain.out).toMatch(/0 errors · 0 warnings/u);
      expect((await validate([`--from-db=${book.fixture.dataDir}`, '--strict'])).code).toBe(0);
    } finally {
      book.close();
    }
  });

  it('keeps `--json` machine-readable, with the mode named', async () => {
    const book = volume({ 'ch09.md': longProse(['Вчера Владимир Путин приехал в город.']) });
    try {
      const result = await validate([`--from-db=${book.fixture.dataDir}`, '--json']);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.out) as { mode: string; errors: number; findings: Array<{ rule: string }> };
      expect(parsed.mode).toBe('db');
      expect(parsed.errors).toBeGreaterThan(0);
      expect(parsed.findings.map((finding) => finding.rule)).toContain('F005');
    } finally {
      book.close();
    }
  });

  it('reports a volume that is not there instead of validating an empty book', async () => {
    const missing = join(tmpdir(), 'book-validate-nowhere');
    const result = await validate([`--from-db=${missing}`]);
    expect(result.code).toBe(2);
    expect(result.out).toContain(join(missing, 'book.db'));
    expect(result.out).not.toMatch(/0 errors/u);
  });
});

describe('--staged: no manuscript path may be committed', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'book-staged-'));
    execFileSync('git', ['init', '--quiet', dir]);
    return dir;
  }

  it('passes a commit that stages no book file', async () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'site'), { recursive: true });
      writeFileSync(join(dir, 'site', 'index.ts'), 'export const one = 1;\n', 'utf8');
      execFileSync('git', ['-C', dir, 'add', 'site/index.ts']);
      const result = await validate(['--staged', `--root=${dir}`]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('1 staged file(s), no manuscript path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a staged manuscript file and names the path', async () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, 'manuscript'), { recursive: true });
      writeFileSync(join(dir, 'manuscript', 'ch02.md'), 'Вторая глава\n\nАбзац.\n', 'utf8');
      execFileSync('git', ['-C', dir, 'add', 'manuscript/ch02.md']);
      const result = await validate(['--staged', `--root=${dir}`]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('manuscript/ch02.md');
      expect(result.out).toContain("the book's text lives in the database");
      expect(result.out).toContain('1 manuscript path(s) staged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('image mode: the files the image owns, and the rules it must name as skipped', () => {
  it('checks the imprint and the denylist and says which rules need the database', async () => {
    const result = await validate([]);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('text: not checked here — the book lives in the database');
    for (const rule of ['F001', 'F002', 'F007', 'F009', 'F021', 'F022', 'F029']) expect(result.out).toContain(rule);
  });

  it('still fails a drifting imprint (F020) with no book at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-imprint-'));
    try {
      const imprint = join(dir, 'imprint.json');
      writeFileSync(imprint, JSON.stringify({ author: 'somebody else', copyright: '', publisher: null, year: 'auto' }), 'utf8');
      const result = await validate([`--imprint=${imprint}`, '--json']);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.out) as { mode: string; skipped: string[]; findings: Array<{ rule: string }> };
      expect(parsed.mode).toBe('image');
      expect(parsed.skipped).toContain('F021');
      // Two imprint problems (the author and the copyright), both F020, both in image mode.
      expect([...new Set(parsed.findings.map((finding) => finding.rule))]).toEqual(['F020']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('`bin/validate.mjs` usage', () => {
  it('refuses an unknown argument and two gates at once', async () => {
    expect((await validate(['--png'])).code).toBe(2);
    expect((await validate(['--staged', '--from-db=/data'])).code).toBe(2);
  });

  it('shows every mode in its own help', async () => {
    const result = await validate(['--help']);
    expect(result.code).toBe(0);
    for (const flag of ['--from-db', '--staged', '--root']) expect(result.out).toContain(flag);
  });
});
