import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runIndex } from '../../src/index/cli.ts';
import { artifactPath, readIndex } from '../../src/index/store.ts';

type Captured = { code: number; out: string[]; err: string[] };

function run(args: string[], input: { bookRoot: string; dataDir: string }): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const code = runIndex(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, input);
  return { code, out, err };
}

function fixture(): { bookRoot: string; dataDir: string; close: () => void } {
  const bookRoot = mkdtempSync(join(tmpdir(), 'book-index-cli-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'book-index-cli-data-'));
  mkdirSync(join(bookRoot, 'manuscript'), { recursive: true });
  writeFileSync(
    join(bookRoot, 'manuscript', 'ch12.md'),
    'Глава двенадцатая\n\nПриказ № 4 выдан утром.\n',
    'utf8',
  );
  return {
    bookRoot,
    dataDir,
    close: () => {
      rmSync(bookRoot, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('bin/index.mjs (BOOK-18 observability)', () => {
  it('rebuilds on demand and then shows what it found, with the data directory named', () => {
    const book = fixture();
    try {
      const rebuilt = run(['rebuild'], book);
      expect(rebuilt.code).toBe(0);
      const shown = JSON.parse(rebuilt.out.join('\n')) as Record<string, unknown>;
      expect(shown).toMatchObject({ dataDir: book.dataDir, artifact: artifactPath(book.dataDir), written: 1, documents: 1 });
      expect(typeof shown.manuscriptHash).toBe('string');
      expect(existsSync(artifactPath(book.dataDir))).toBe(true);

      const shownAgain = run(['show'], book);
      expect(shownAgain.code).toBe(0);
      expect(shownAgain.out.join('\n')).toContain(book.dataDir);
    } finally {
      book.close();
    }
  });

  it('makes a mis-set DATA_DIR visible instead of silently yielding no slice', () => {
    const book = fixture();
    try {
      const shown = run(['show'], book);
      expect(shown.code).toBe(1);
      expect(shown.err.join('\n')).toContain(artifactPath(book.dataDir));
      expect(shown.err.join('\n')).toContain('DATA_DIR=');
      expect(readIndex(book.dataDir)).toBeNull();
    } finally {
      book.close();
    }
  });

  it('reports a failed rebuild and an unknown command with their own exit codes', () => {
    const book = fixture();
    try {
      const blocked = join(book.bookRoot, 'not-a-directory');
      writeFileSync(blocked, 'occupied', 'utf8');
      expect(run(['rebuild'], { bookRoot: book.bookRoot, dataDir: blocked }).code).toBe(1);
      const unknown = run(['dance'], book);
      expect(unknown.code).toBe(2);
      expect(unknown.err.join('\n')).toContain('usage: index.mjs');
    } finally {
      book.close();
    }
  });
});
