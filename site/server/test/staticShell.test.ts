/**
 * The static shell before the bundle boots.
 *
 * `web/index.html` is served before any JavaScript runs, so its `<title>`, `<noscript>` and
 * social tags are a **code fallback**, not a copy of the book: the book's title and annotation
 * are `front_matter` rows now (ADR-043 / BOOK-DOC-76) and `manuscript/` is not read at runtime.
 * What this file pins:
 *   · the shell carries a real, non-empty `<title>`, and it is exactly `SHELL_TITLE`;
 *   · the running app overwrites the tab from `/api/front` (`usePageTitle` → `document.title`),
 *     so a rename in the rows reaches the tab without a release;
 *   · the retired name «Тоска» stays out of every title surface.
 *
 * The rows' own words are checked on deploy: `node bin/validate.mjs --from-db "$DATA_DIR"` runs
 * F021 (the first sheet: title line, annotation band, blocks) over `front_matter`. A test with
 * no volume cannot compare the shell with the book, and neither should it: the shell stops being
 * the book's copy the moment the app reads it from the rows.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { IMPRINT_AUTHOR } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { applyDocumentTitle, documentTitle, SHELL_TITLE } from '../../web/src/lib/pageTitle.ts';

const SITE = join(import.meta.dirname, '..', '..');
const shell = readFileSync(join(SITE, 'web', 'index.html'), 'utf8');

/** The value of `<title>` / a `<meta>` in the static shell, with whitespace flattened. */
function shellValue(pattern: RegExp): string {
  const value = pattern.exec(shell)?.[1];
  if (value === undefined) throw new Error(`the static shell has no ${pattern}`);
  return value.replace(/\s+/gu, ' ').trim();
}

const shellTitle = shellValue(/<title>([\s\S]*?)<\/title>/u);
const shellOgTitle = shellValue(/<meta property="og:title" content="([\s\S]*?)" \/>/u);
const shellDescription = shellValue(/<meta\s+name="description"\s+content="([\s\S]*?)"\s+\/>/u);
const shellOgDescription = shellValue(/<meta property="og:description" content="([\s\S]*?)" \/>/u);
const shellNoScriptTitle = shellValue(/<noscript>[\s\S]*?<h1 class="title">([\s\S]*?)<\/h1>/u);
const shellNoScriptAuthor = shellValue(/<noscript>[\s\S]*?<p class="author">([\s\S]*?)<\/p>/u);

describe('the static shell carries a fallback title', () => {
  it('has a non-empty <title> that is exactly the code fallback', () => {
    expect(shellTitle.length).toBeGreaterThan(0);
    expect(shellTitle).toBe(SHELL_TITLE);
    expect(shellOgTitle).toBe(shellTitle);
  });

  it('carries the same fallback in the <noscript> block, with the author beside it', () => {
    // The `<noscript>` block prints the book's name alone; the tab carries the author in the
    // same string, so the two are compared through it instead of through a second literal.
    expect(shellNoScriptTitle).toBe(SHELL_TITLE.split(` — `)[0]);
    expect(shellNoScriptAuthor).toBe(IMPRINT_AUTHOR);
  });

  it('gives both description tags the same non-empty text', () => {
    // The words are the owner's annotation, which now lives in `front_matter` and is checked
    // there (F021, the deploy gate named above). What the shell must still do is say something.
    expect(shellDescription.length).toBeGreaterThan(0);
    expect(shellOgDescription).toBe(shellDescription);
  });
});

describe('the running app names the book from /api/front', () => {
  it('writes document.title from the front title and leaves the shell title until it arrives', () => {
    // The tab writer itself: `undefined` = the state has not arrived (the shell's title stands,
    // so a phone never flashes the fallback over the book), a string = the live front title.
    const target = { title: SHELL_TITLE };
    applyDocumentTitle(undefined, target);
    expect(target.title).toBe(SHELL_TITLE);

    applyDocumentTitle('Другое имя', target);
    expect(target.title).toBe(documentTitle('Другое имя'));
    expect(target.title).toBe(`Другое имя — ${IMPRINT_AUTHOR}`);
    expect(target.title).not.toBe(SHELL_TITLE);
  });

  it('feeds that hook the front DTO the app reads from /api/front', () => {
    // The wiring is two lines, and both are read as text: the request names `/api/front`, and
    // the app hands its `title` to `usePageTitle`, which writes `document.title`.
    const api = readFileSync(join(SITE, 'web', 'src', 'api.ts'), 'utf8');
    expect(api).toContain("readJson<FrontDto>('/api/front')");
    const app = readFileSync(join(SITE, 'web', 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('usePageTitle(data === null ? undefined : data.front.title)');
  });
});

/**
 * The book's name (BOOK-40). «Тоска» survives as the book's *tone* — the style guides, the
 * concept, the legal page — but it must not come back as the book's *name*. The title is typed
 * by hand into the shell, the web sources and the README; since BOOK-187 it is no longer typed
 * into a first sheet in git (the rows hold it), so the pin walks the surfaces that remain.
 */
const BOOK_ROOT = join(SITE, '..');
const LIVE_TITLE = 'Бланк';
const RETIRED_TITLE = 'Тоска';
/** Paths where «тоска» is the tone and stays as written: this rename must not "fix" them. */
const TONE_FILES = ['site/web/src/components/LegalPage.tsx', 'site/web/src/lib/deed.ts'];

/** Every file whose text can hold the book's name, as repo-relative POSIX paths. */
function titleSurface(): string[] {
  const files = ['README.md', 'site/web/index.html'];
  const roots: Array<[string, RegExp]> = [['site/web/src', /\.tsx?$/u]];
  const walk = (dir: string, ext: RegExp): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, ext);
      else if (ext.test(entry.name)) files.push(relative(BOOK_ROOT, path).split(sep).join('/'));
    }
  };
  for (const [dir, ext] of roots) walk(join(BOOK_ROOT, dir), ext);
  return files;
}

describe('the book is named «Бланк» (BOOK-40)', () => {
  it('says so in the tab, the social card and the <noscript> block', () => {
    expect(shellTitle).toBe(`${LIVE_TITLE} — ${IMPRINT_AUTHOR}`);
    expect(shellOgTitle).toBe(shellTitle);
    expect(shellNoScriptTitle).toBe(LIVE_TITLE);
  });

  it('types the retired «Тоска» nowhere in a title position', () => {
    const scanned = titleSurface();
    // The walk itself is pinned: an empty or narrowed scan would pass for the wrong reason.
    for (const file of ['README.md', 'site/web/index.html', 'site/web/src/lib/pageTitle.ts']) {
      expect(scanned).toContain(file);
    }
    const offenders = scanned
      .filter((file) => !TONE_FILES.includes(file))
      .filter((file) => readFileSync(join(BOOK_ROOT, file), 'utf8').includes(RETIRED_TITLE));
    expect(offenders).toEqual([]);
  });

  it('keeps «тоска» where it is the tone, not the name', () => {
    for (const file of TONE_FILES) {
      expect(readFileSync(join(BOOK_ROOT, file), 'utf8').toLowerCase()).toContain('тоска');
    }
  });
});
