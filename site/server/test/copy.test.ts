import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The copy guard, source half (BOOK-15, BOOK-19).
 *
 * The rendered half is `web/src/components/copyGuard.test.tsx`: it renders every surface that
 * can print a reader-facing line and greps the markup. This half greps the **copy modules**
 * those surfaces render from, so a new string cannot slip in between render tests. The banned
 * words: «шов», «противоречие исправлено», «битый», «retcon», and the name of any gate role
 * the reader was never told about — the retrospection is оформляется, never masked.
 *
 * BOOK-76: the physics pass is named to the reader, so «консультант» is no longer banned —
 * and, to keep that one reversal from spreading, the name is allowed in exactly two source
 * files (plus the owner's own opening block) and required in those two.
 */

const ROOT = join(import.meta.dirname, '../..');
const BANNED = ['шов', 'противоречие исправлено', 'битый', 'retcon', 'редактор', 'аудитор'];

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
  'web/src/lib/history.ts',
  'web/src/lib/format.ts',
  // BOOK-75: the full hall's plate and its state line.
  'web/src/lib/capacity.ts',
  'server/src/history/summary.ts',
  // BOOK-76: the change record's one line about the physics pass.
  'web/src/lib/science.ts',
  // BOOK-72/BOOK-69: the versioned terms a reader accepts, and what stays with them. BOOK-58:
  // the copy now lives in `shared`, because the server hashes the same text the page prints.
  'shared/src/terms.ts',
  'web/src/lib/terms.ts',
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

/**
 * BOOK-76 — the physics pass is named to the reader, and the **stem** «консультант» may live
 * in exactly two source files: the card's copy module and `/rules`. A third file is allowed
 * but not required: `components/HowTheBookIsMade.tsx` is the owner's opening block, and his
 * sentence is his to insert. The stem, not the phrase, is matched, so «консультант проверил»
 * on a new surface would fail too — the allowed set is path-based, not wording-based.
 */
const SCIENCE_ROLE_STEM = 'консультант';
const SCIENCE_ROLE_ALLOWED = new Set([
  'web/src/lib/science.ts',
  'web/src/components/LegalPage.tsx',
  'web/src/components/HowTheBookIsMade.tsx',
]);
const SCIENCE_ROLE_REQUIRED = ['web/src/lib/science.ts', 'web/src/components/LegalPage.tsx'];

describe('the physics pass is named where a reader looks, and nowhere else (BOOK-76)', () => {
  it('carries the role stem in the card copy and /rules only', () => {
    const carriers: string[] = [];
    for (const file of webSources(join(ROOT, 'web/src'))) {
      if (readFileSync(file, 'utf8').toLowerCase().includes(SCIENCE_ROLE_STEM)) {
        carriers.push(relative(ROOT, file).split(sep).join('/'));
      }
    }
    for (const carrier of carriers) {
      expect(SCIENCE_ROLE_ALLOWED.has(carrier), `the physics pass is named in ${carrier}`).toBe(true);
    }
    for (const required of SCIENCE_ROLE_REQUIRED) expect(carriers, required).toContain(required);
  });
});

/**
 * BOOK-207 — the deleted carets door, pass screen and strip leave no word in the reader's
 * sources: no «каретки», no `#проход-` fragment, and no bare noun «проход» (the engine's own
 * logs outside `web/src` may still say it). Comments are blanked first: a comment may quote
 * the removed string, a component may not print it.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

describe('the deleted carets door leaves no word in the reader’s sources (BOOK-207)', () => {
  it('has no «каретки», no «#проход-» and no bare «проход»', () => {
    const files = webSources(join(ROOT, 'web/src'));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source, `${file}: каретки`).not.toMatch(/каретки/iu);
      expect(source, `${file}: #проход-`).not.toContain('#проход-');
      // The noun, not «проходит»: a word boundary on Cyrillic, both sides.
      expect(source, `${file}: проход`).not.toMatch(/(?<![а-яё])проход(?![а-яё])/iu);
    }
  });
});
