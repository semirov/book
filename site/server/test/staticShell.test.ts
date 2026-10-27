/**
 * The static shell against the first sheet.
 *
 * `web/index.html` is served before the bundle boots, so its title, its `<noscript>` and its
 * social card are a copy of the manuscript by necessity. This test reads both files and makes
 * that copy honest: a retitled sheet or a rewritten annotation fails here instead of shipping
 * a shell that still names the old book (BOOK-21).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { IMPRINT_AUTHOR } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { parseFront } from '../src/ingest/parseFront.ts';

const SITE = join(import.meta.dirname, '..', '..');
const shell = readFileSync(join(SITE, 'web', 'index.html'), 'utf8');
const sheet = parseFront(readFileSync(join(SITE, '..', 'manuscript', '00-front.md'), 'utf8'));
const bookTitle = sheet.title ?? '';

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

/** The annotation's first sentence — the part the shell quotes as its description. */
const opening = sheet.about?.match(/^[\s\S]*?\.(?=\s|$)/u)?.[0] ?? '';

describe('the static shell names the first sheet', () => {
  it('reads a valid first sheet', () => {
    expect(sheet.problems).toEqual([]);
    expect(bookTitle.length).toBeGreaterThan(0);
  });

  it('carries the manuscript title and the imprint in the tab', () => {
    expect(shellTitle).toBe(`${bookTitle} — ${IMPRINT_AUTHOR}`);
    expect(shellOgTitle).toBe(shellTitle);
  });

  it('carries the same title in the <noscript> block, with the author beside it', () => {
    expect(shellNoScriptTitle).toBe(bookTitle);
    expect(shellNoScriptAuthor).toBe(IMPRINT_AUTHOR);
  });
});

describe('the static shell quotes the annotation', () => {
  it('takes both descriptions from the manuscript opening, not a paraphrase', () => {
    expect(opening.length).toBeGreaterThan(0);
    expect(shellDescription).toBe(opening);
    expect(shellOgDescription).toBe(shellDescription);
  });
});

/**
 * The book's name (BOOK-40). «Тоска» survives as the book's *tone* — the style guides, the
 * concept, the legal page — but it must not come back as the book's *name*. The title is
 * typed by hand into four surfaces (first sheet, static shell, web sources, README), so the
 * pin walks them and refuses the retired word anywhere but the tone files.
 */
const BOOK_ROOT = join(SITE, '..');
const LIVE_TITLE = 'Бланк';
const RETIRED_TITLE = 'Тоска';
/** Paths where «тоска» is the tone and stays as written: this rename must not "fix" them. */
const TONE_FILES = ['site/web/src/components/LegalPage.tsx', 'site/web/src/lib/deed.ts'];

/** Every file whose text can hold the book's name, as repo-relative POSIX paths. */
function titleSurface(): string[] {
  const files = ['README.md', 'site/web/index.html'];
  const roots: Array<[string, RegExp]> = [
    ['manuscript', /\.md$/u],
    ['site/web/src', /\.tsx?$/u],
  ];
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
    for (const file of ['README.md', 'site/web/index.html', 'manuscript/00-front.md', 'site/web/src/lib/pageTitle.ts']) {
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
