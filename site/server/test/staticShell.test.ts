/**
 * The static shell against the first sheet.
 *
 * `web/index.html` is served before the bundle boots, so its title, its `<noscript>` and its
 * social card are a copy of the manuscript by necessity. This test reads both files and makes
 * that copy honest: a retitled sheet or a rewritten annotation fails here instead of shipping
 * a shell that still names the old book (BOOK-21).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
