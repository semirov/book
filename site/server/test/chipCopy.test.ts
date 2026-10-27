import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { copyProblems, FORBIDDEN } from '../../scripts/chips.mjs';

/**
 * BOOK-70 — the chip-copy guard (the editor's truth table).
 *
 * `scripts/arch.mjs` prints `copyProblems` and exits 1 on a non-empty list; the same call is made
 * here. The real tree must be clean, and the failure path is proven on a seeded source tree:
 * a guard that only passes on a clean repository could be scanning nothing.
 */
const ROOT = join(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');

function seeded(files: Record<string, string>): Array<{ file: string; line: number; message: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'book-chips-copy-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, source, 'utf8');
    }
    return copyProblems(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('BOOK-70 — the chip copy', () => {
  it('reports nothing on this repository', () => {
    expect(copyProblems(WEB_SRC)).toEqual([]);
  });

  it('retires twelve patterns, each with the reason it may not come back', () => {
    expect(FORBIDDEN.map((entry) => entry.phrase)).toEqual([
      'книга начинается',
      'записи нет',
      'тишина с',
      '0 замечаний',
      '0 правок',
      'дальше держится',
      'состояние:',
      'волна 0',
      'волна 1',
      'не открылось',
      "'не написана'",
      'не написана',
    ]);
    for (const entry of FORBIDDEN) expect(entry.why.length).toBeGreaterThan(10);
  });

  it('fails every retired phrase in a sheet, with its line', () => {
    const problems = seeded({
      'a.tsx': [
        "const one = 'книга начинается';",
        "const two = 'записи нет';",
        "const three = 'тишина с 09:00';",
        "const four = '0 замечаний';",
        "const five = '0 правок';",
        "const six = 'дальше держится';",
        "const seven = 'состояние: внесено';",
        "const eight = 'волна 0';",
        "const nine = 'волна 1';",
        "const ten = 'не открылось';",
        "const eleven = 'не написана';",
        '<span className="ch-meta">не написана</span>',
        '',
      ].join('\n'),
    });
    expect(problems.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(problems.map((problem) => problem.message)).toEqual(
      FORBIDDEN.map((entry) => expect.stringContaining(`«${entry.phrase}» is retired (BOOK-70): ${entry.why}`)),
    );
  });

  it('catches the bare text node as well as the quoted literal, and spares «ещё не написана»', () => {
    // A JSX text node carries no quotes, so a guard built only from literals would read
    // `<span>не написана</span>` as fine (BOOK-70 review).
    const bare = seeded({ 'Chapter.tsx': '<span className="ch-meta">не написана</span>\n' });
    expect(bare).toHaveLength(1);
    expect(bare[0]?.message).toContain('«не написана» is retired');
    expect(bare[0]?.line).toBe(1);

    const quoted = seeded({ 'Chapter.tsx': "const label = 'не написана';\n" });
    expect(quoted).toHaveLength(1);
    // The quoted entry reports it, and the bare entry does not double-report the same literal.
    expect(quoted[0]?.message).toContain("«'не написана'» is retired");

    const legal = seeded({ 'Chronicle.tsx': "const title = chapter.written ? chapter.title : 'ещё не написана';\n" });
    expect(legal).toEqual([]);
  });

  it('keeps the legit «ещё не написана» of the chronicle, and ignores a number that ends in zero', () => {
    const problems = seeded({
      'Chronicle.tsx': [
        "const line = chapter.written ? chapter.title : 'ещё не написана';",
        "const limits = '10 замечаний в час, одна правка в сутки';",
        '',
      ].join('\n'),
    });
    expect(problems).toEqual([]);
  });

  it('reads the code, not the commentary: a retired phrase in a comment is not printed copy', () => {
    const problems = seeded({
      'a.tsx': [
        '/** The chip used to say «книга начинается» and «записи нет» — BOOK-70 removed both. */',
        '// The old branch printed `0 правок`.',
        "export const chip = 'глав ещё нет';",
        '',
      ].join('\n'),
    });
    expect(problems).toEqual([]);
  });

  it('skips the tests, which may quote what the code may not print', () => {
    const problems = seeded({
      'a.test.tsx': "expect(html).toContain('записи нет');\n",
      'b.dom.test.ts': "const old = 'волна 1';\n",
      'c.ts': '// a comment\nconst ok = 1;\n',
    });
    expect(problems).toEqual([]);
  });
});
