import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The copy guard, source half (BOOK-15, BOOK-19).
 *
 * The rendered half is `web/src/components/copyGuard.test.tsx`: it renders every surface that
 * can print a reader-facing line and greps the markup. This half greps the **copy modules**
 * those surfaces render from, so a new string cannot slip in between render tests. The banned
 * words: «шов», «противоречие исправлено», «битый», «retcon», and the name of any gate role —
 * the gates are invisible to readers (invariant 18), and the retrospection is оформляется,
 * never masked.
 */

const ROOT = join(import.meta.dirname, '../..');
const BANNED = ['шов', 'противоречие исправлено', 'битый', 'retcon', 'редактор', 'консультант', 'аудитор'];

const COPY_MODULES = [
  // BOOK-16: the labels a reader sees for the four kinds, and the draft's own line.
  'shared/src/intervention.ts',
  'web/src/lib/composer.ts',
  'web/src/lib/commentView.ts',
  // BOOK-DOC-34: the seam's own copy — the strip, the form, the panels, the empty slot.
  'web/src/lib/seam.ts',
  'web/src/lib/provenance.ts',
  'web/src/lib/filings.ts',
  'web/src/lib/premise.ts',
  'web/src/lib/draft.ts',
  'web/src/lib/kindChoices.ts',
  'web/src/lib/changeStatus.ts',
  // BOOK-90: the margin's vocabulary and its second-line deck.
  'web/src/lib/marginalia.ts',
  'web/src/lib/cascade.ts',
  'web/src/lib/deed.ts',
  'web/src/lib/focus.ts',
  'web/src/lib/history.ts',
  'web/src/lib/format.ts',
  'server/src/history/summary.ts',
];

describe('the copy modules a reader sees', () => {
  it('never carry a banned word', () => {
    for (const module of COPY_MODULES) {
      const source = readFileSync(join(ROOT, module), 'utf8').toLowerCase();
      for (const word of BANNED) expect(source, module).not.toContain(word);
    }
  });
});

/**
 * BOOK-59 — one wave. The bound is a single wave in code, so no reader-facing string may
 * promise five, count waves against a bound, or print a denominator. This half greps every
 * non-test source file under `web/src`, because a branch that no render test reaches can
 * still carry the old promise to the one reader who opens it.
 */
const WAVE_PROMISES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: '«5 волн»', pattern: /5 волн/u },
  { name: '«из 5»', pattern: /из 5\b/u },
  { name: '«волна N / N»', pattern: /волн[аеыу]?\s+\d+\s*\/\s*\d+/u },
];

function webSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/u.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/u.test(entry.name)) continue;
    out.push(join(entry.parentPath ?? dir, entry.name));
  }
  return out;
}

describe('the wave promise of the copy (BOOK-59)', () => {
  it('is one wave: no file under web/src promises five, or a wave out of a bound', () => {
    const files = webSources(join(ROOT, 'web/src'));
    // A guard against an empty walk: 50 files is the floor of this tree, not a count of copy.
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const promise of WAVE_PROMISES) {
        expect(promise.pattern.test(source), `${promise.name} — ${file.replace(`${ROOT}/`, '')}`).toBe(false);
      }
    }
  });
});
