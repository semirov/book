/**
 * BOOK-187 — the arch rule that keeps the file path out of the engine and the writer.
 *
 * The rule is behavioural: `textHomeProblems(root)` is the same call `scripts/arch.mjs` makes and
 * exits 1 on, so a synthetic module proves the refusal path, and a run over the real repository
 * proves the tree is clean today. The file readers in `engine/text.ts` stay for the one-shot
 * import; the way a second source of truth reappears is one innocent import, and this is the gate
 * that names it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOOT_FILE, BOOT_REFUSED, GUARDED_ROOTS, MANUSCRIPT_READERS, textHomeProblems } from '../../scripts/lib/textHome.mjs';

const SITE = resolve(import.meta.dirname, '../..');

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'book-text-home-'));
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source, 'utf8');
  }
  return root;
}

describe('the text-home rule (BOOK-187, ADR-043 §3 row 4)', () => {
  it('guards both trees and names the five file readers', () => {
    expect(GUARDED_ROOTS).toEqual(['server/src/engine', 'server/src/writer']);
    expect(MANUSCRIPT_READERS).toEqual(['readChapter', 'readFront', 'isWritten', 'writtenChapters', 'chapterPath']);
  });

  it('fires on a synthetic import in the engine and in the writer', () => {
    const root = tree({
      'server/src/engine/probe.ts': `import { readChapter } from './text.ts';\nexport const read = readChapter;\n`,
      'server/src/writer/probe.ts': `import { chapterPath, isWritten } from '../engine/text.ts';\nexport const p = chapterPath;\n`,
    });
    try {
      const problems = textHomeProblems(root);
      expect(problems).toEqual([
        {
          file: join('server/src/engine', 'probe.ts'),
          message:
            "imports readChapter from ./text.ts — the engine and the writer read the book's text from rows (ADR-043 §3 row 4, BOOK-187)",
        },
        {
          file: join('server/src/writer', 'probe.ts'),
          message:
            "imports chapterPath from ../engine/text.ts — the engine and the writer read the book's text from rows (ADR-043 §3 row 4, BOOK-187)",
        },
        {
          file: join('server/src/writer', 'probe.ts'),
          message:
            "imports isWritten from ../engine/text.ts — the engine and the writer read the book's text from rows (ADR-043 §3 row 4, BOOK-187)",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fires on a scanner import outside the one-shot import, and on a boot that attaches a reader', () => {
    const root = tree({
      // A second module reading a manuscript directory: only `ingest/reconcile.ts` may.
      'server/src/integrity/probe.ts': `import { scanManuscript } from '../ingest/scanManuscript.ts';\nexport const s = scanManuscript;\n`,
      // The boot reaching the import or the watcher: a restart serves rows.
      [BOOT_FILE]: `import { reconcile } from './ingest/reconcile.ts';\nimport { ManuscriptWatcher } from './ingest/watcher.ts';\nexport const r = [reconcile, ManuscriptWatcher];\n`,
    });
    try {
      const problems = textHomeProblems(root);
      expect(problems.map((problem) => problem.file)).toEqual([
        join('server/src/integrity', 'probe.ts'),
        BOOT_FILE,
        BOOT_FILE,
      ]);
      expect(problems[0]?.message).toContain('only ingest/reconcile.ts');
      expect(problems[1]?.message).toContain('./ingest/reconcile.ts');
      expect(problems[2]?.message).toContain('./ingest/watcher.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares the import directory and the two specifiers a boot may not reach', () => {
    expect(BOOT_FILE).toBe('server/src/index.ts');
    expect(BOOT_REFUSED).toEqual(['./ingest/reconcile.ts', './ingest/watcher.ts']);
  });

  it('accepts the row readers, another module and a file reader outside the guarded trees', () => {
    const root = tree({
      'server/src/engine/probe.ts': `import { readChapterRows, isWrittenIn } from './text.ts';\nexport const r = readChapterRows;\nexport const w = isWrittenIn;\n`,
      // The one-shot import may scan; the boot may import neither the import nor the watcher.
      'server/src/ingest/reconcile.ts': `import { scanManuscript } from './scanManuscript.ts';\nexport const s = scanManuscript;\n`,
      [BOOT_FILE]: `import { listCatalog } from './db/repo/chapters.ts';\nexport const c = listCatalog;\n`,
      'server/src/ingest/probe.ts': `import { readChapter, chapterPath } from '../engine/text.ts';\nexport const r = readChapter;\nexport const p = chapterPath;\n`,
      'server/src/writer/probe.ts': `import { isWrittenView } from '../engine/text.ts';\nexport const v = isWrittenView;\n`,
    });
    try {
      expect(textHomeProblems(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is clean on this repository: no engine or writer module reads a manuscript', () => {
    expect(textHomeProblems(SITE)).toEqual([]);
  });
});
