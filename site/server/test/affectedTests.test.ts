/**
 * BOOK-198: the PR test selection. What is claimed here is that a diff maps to a test set
 * deterministically — `classify` is pure over the path list — and that the CLI answers from real
 * git rather than from a guess (`--changed`'s base ref is exactly what we stopped trusting).
 *
 * The doc/manuscript case gets the core set, never nothing: an empty selection would turn every
 * docs PR into a green run that tested nothing at all.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classify, expand } from '../../scripts/affected-tests.mjs';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = resolve(SITE, 'scripts', 'affected-tests.mjs');

/** The core patterns the brief names, the ones a change in any package shares. */
const CORE_PATTERNS = [
  'server/test/engine/**/*.test.ts',
  'server/test/db/**/*.test.ts',
  'server/test/ledger/**/*.test.ts',
];

type Cli = { status: number; stdout: string; stderr: string };

function run(...args: string[]): Cli {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: SITE, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe('classify', () => {
  it('runs everything when gate infrastructure changed', () => {
    for (const path of [
      'site/vitest.config.ts',
      'site/package.json',
      'site/package-lock.json',
      'site/tsconfig.tests.json',
      'site/test/globalSetup.ts',
      '.github/workflows/gate.yml',
      'site/scripts/affected-tests.mjs',
      'site/scripts/gate-verdict.mjs',
    ]) {
      expect(classify([path]), path).toEqual({ mode: 'full', files: [] });
    }
  });

  it('is not fooled by a path that only looks like infrastructure', () => {
    // `site/server/package.json` is a workspace manifest, not the gate's own.
    expect(classify(['site/server/package.json']).mode).toBe('affected');
    expect(classify(['site/vitest.config.ts.bak']).mode).toBe('affected');
  });

  it('selects the server tests and the core set for a server change', () => {
    const selection = classify(['site/server/src/ledger/apply.ts']);
    expect(selection.mode).toBe('affected');
    expect(selection.files).toContain('server/test/**/*.test.ts');
    for (const pattern of CORE_PATTERNS) expect(selection.files).toContain(pattern);
    expect(selection.files).not.toContain('web/src/**/*.test.{ts,tsx}');
  });

  it('selects the web tests and the core set for a web change', () => {
    const selection = classify(['site/web/src/components/Reader.tsx']);
    expect(selection.mode).toBe('affected');
    expect(selection.files).toContain('web/src/**/*.test.{ts,tsx}');
    for (const pattern of CORE_PATTERNS) expect(selection.files).toContain(pattern);
    expect(selection.files).not.toContain('server/test/**/*.test.ts');
  });

  it('runs everything for a shared change: server and web import `@book/shared`', () => {
    // Not "shared tests only": a shared edit is felt in every package that imports it.
    expect(classify(['site/shared/src/x.ts'])).toEqual({ mode: 'full', files: [] });
    expect(classify(['site/shared/test/book.test.ts']).mode).toBe('full');
  });

  it('gives a docs-only change the core set, never an empty list', () => {
    const selection = classify(['manuscript/ch01.md', 'CONTRIBUTING.md', 'notes/plan.md']);
    expect(selection.mode).toBe('affected');
    expect(selection.files.length).toBeGreaterThan(0);
    for (const pattern of CORE_PATTERNS) expect(selection.files).toContain(pattern);
    expect(selection.files).not.toContain('server/test/**/*.test.ts');
    expect(selection.files).not.toContain('web/src/**/*.test.{ts,tsx}');
  });

  it('treats a deletion as a change in its package', () => {
    // `--diff-filter=ACMRD` keeps deleted paths; a removed server module still re-tests the server.
    expect(classify(['site/server/src/gone.ts']).files).toContain('server/test/**/*.test.ts');
  });

  it('normalises sloppy paths and ignores empties', () => {
    expect(classify(['./site/web/src/a.ts', 'site\\web\\src\\b.ts', ''])).toEqual(
      classify(['site/web/src/a.ts', 'site/web/src/b.ts']),
    );
  });
});

describe('expand', () => {
  it('turns the core patterns into files that exist', () => {
    const files = expand(CORE_PATTERNS);
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('server/test/engine/gates.test.ts');
    expect(files).toContain('server/test/db/multiWriter.test.ts');
    expect(files).toContain('server/test/ledger/applier.test.ts');
    // Helpers and fixtures are not test files, and vitest should not be handed them.
    expect(files.some((file) => /helpers?\.ts$/u.test(file))).toBe(false);
  });

  it('expands the frame set and the brace pattern', () => {
    const files = expand(['server/test/*frame*.test.ts', 'server/test/*Frame*.test.ts', 'web/src/**/*Frame*.test.{ts,tsx}']);
    expect(files).toContain('server/test/frameCheck.test.ts');
    expect(files).toContain('server/test/landFrame.test.ts');
    expect(files).toContain('web/src/appHistoryFrame.dom.test.tsx');
    expect(files).toContain('web/src/components/chapterArticleFrame.dom.test.tsx');
    expect(files.every((file) => file.endsWith('.test.ts') || file.endsWith('.test.tsx'))).toBe(true);
  });
});

describe('the CLI', () => {
  it('answers --json from the real diff (HEAD against itself: nothing changed)', () => {
    const result = run('--base=HEAD', '--json');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed).sort()).toEqual(['files', 'mode']);
    // No diff means no package was touched: the core set is the selection, and it is not empty.
    expect(parsed.mode).toBe('affected');
    expect(parsed.files).toContain('server/test/engine/**/*.test.ts');
  });

  it('fails towards the whole suite when the base ref does not exist', () => {
    const result = run('--base=refs/heads/does-not-exist-book-198', '--json');
    // A shallow clone or a missing base must not select "nothing": the suite runs whole.
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode: 'full', files: [] });
    expect(result.stderr).toContain('cannot diff against');
  });

  it('refuses an unknown argument instead of running something else', () => {
    const result = run('--bse=main');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument');
  });
});
