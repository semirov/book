/**
 * BOOK-187 review — the two CLIs that read the volume must not write it.
 *
 * `bin/export.mjs` renders the book on demand: an export of a volume is a read, and a typo'd
 * `--data-dir` must fail instead of leaving an empty `book.db` behind (the reason it no longer
 * goes through boot's `openDatabase`, which sets WAL and creates the file). `bin/validate.mjs
 * --from-db` is the deploy's text gate: it reads rows with the project's own driver
 * (`better-sqlite3`, the server's dependency), because `node:sqlite` is still experimental and a
 * Node without that module must not be how the gate fails.
 *
 * The source lines are the contract here — the same way `arch.mjs` gates a rule the type system
 * cannot see — and the process case runs the real CLI against a temp dir when a build exists.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';

const exec = promisify(execFile);

function sourceOf(name: string): string {
  return readFileSync(join(SITE_ROOT, 'bin', name), 'utf8');
}

describe('bin/export.mjs — a read, never a create', () => {
  it('opens the volume readonly + fileMustExist, and never through openDatabase', () => {
    const text = sourceOf('export.mjs');
    expect(text).toContain('new Database(file, { readonly: true, fileMustExist: true })');
    expect(text).not.toContain('openDatabase(');
  });

  it.skipIf(!existsSync(join(SITE_ROOT, 'server', 'dist', 'export', 'cli.js')))(
    'leaves no database behind when the data dir holds none',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'book-export-ro-'));
      try {
        const failure = await exec(
          'node',
          ['bin/export.mjs', '--format', 'md', '--out', join(root, 'book.md'), '--data-dir', join(root, 'empty')],
          { cwd: SITE_ROOT },
        ).catch((error: unknown) => error as { code?: number; stderr?: string });
        expect((failure as { code?: number }).code).toBe(1);
        expect((failure as { stderr?: string }).stderr ?? '').toContain('Cannot open database');
        expect(existsSync(join(root, 'book.md'))).toBe(false);
        expect(existsSync(join(root, 'empty', 'book.db'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('bin/validate.mjs --from-db — the project’s driver, not the experimental one', () => {
  it('loads better-sqlite3 readonly and never node:sqlite', () => {
    const text = sourceOf('validate.mjs');
    expect(text).toContain("import('better-sqlite3')");
    expect(text).toContain('readonly: true, fileMustExist: true');
    expect(text).not.toContain("import('node:sqlite')");
    expect(text).not.toContain('DatabaseSync');
  });

  it('runs --from-db on a real volume with no experimental warning on stderr', async () => {
    // `validateModes.test.ts` proves the rules; this proves the *driver*: no `ExperimentalWarning`
    // line on stderr, which is what `node:sqlite` printed on every run.
    const root = mkdtempSync(join(tmpdir(), 'book-validate-ro-'));
    try {
      const result = await exec('node', ['bin/validate.mjs', '--from-db', root, '--strict'], { cwd: SITE_ROOT }).catch(
        (error: unknown) => error as { code?: number; stdout?: string; stderr?: string },
      );
      const stderr = (result as { stderr?: string }).stderr ?? '';
      expect(stderr).not.toContain('ExperimentalWarning');
      // A directory with no book.db is a named failure of the mode (exit 2), not a crash.
      expect((result as { code?: number }).code).toBe(2);
      expect(`${(result as { stdout?: string }).stdout ?? ''}${stderr}`).toContain('no database at');
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
