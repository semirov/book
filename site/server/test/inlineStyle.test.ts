import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-30 — the inline-style guard.
 *
 * The page keeps `style-src 'self'` without `style-src-attr`, and no SPA element carries a
 * `style` attribute at all: a reader's ink is a class, and the values only the DOM knows
 * are written through CSSOM (`web/src/lib/cssom.ts`). This is hardening, not a fix for a
 * blocked colour — React applies `style={{…}}` through CSSOM too, and CSP would only drop
 * a literal attribute. The point is that no style value ever reaches the markup, so a
 * template (or a future `dangerouslySetInnerHTML`) has nothing to smuggle one into.
 *
 * The scan matches `style={` — an object literal **and** an object variable — across the
 * whole SPA source, tests excluded, so the allow-list stays empty. It lives under
 * `server/test/` because the arch gate forbids `node:` imports in `web/src/`.
 */

const ROOT = join(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web', 'src');
const SKIP = new Set(['node_modules', 'dist', 'coverage']);
const SOURCE = /\.(ts|tsx)$/u;
const IS_TEST = /\.test\.(ts|tsx)$/u;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (SOURCE.test(name) && !IS_TEST.test(name)) out.push(path);
  }
  return out;
}

describe('no inline style attributes in the SPA (BOOK-30)', () => {
  it('ships no `style={` under web/src source files', () => {
    const files = sources(WEB_SRC);
    // The scan is not vacuous: the surfaces named by BOOK-30 (and the anchored panel) are in it.
    expect(files).toContain(join(WEB_SRC, 'components', 'Discussion.tsx'));
    expect(files).toContain(join(WEB_SRC, 'components', 'Chronicle.tsx'));
    expect(files).toContain(join(WEB_SRC, 'components', 'ChapterArticle.tsx'));
    expect(files).toContain(join(WEB_SRC, 'components', 'ParagraphChain.tsx'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} carries an inline style attribute`).not.toMatch(/style=\{/u);
    }
  });
});
