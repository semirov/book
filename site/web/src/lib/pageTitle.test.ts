import { IMPRINT_AUTHOR } from '@book/shared';
import { describe, expect, it } from 'vitest';

import shell from '../../index.html?raw';
import { applyDocumentTitle, documentTitle, FALLBACK_TITLE, SHELL_TITLE } from './pageTitle.ts';

/** The value of `<meta|title …>` in the static shell, with whitespace flattened. */
function shellValue(pattern: RegExp): string {
  const value = pattern.exec(shell)?.[1];
  if (value === undefined) throw new Error(`the static shell has no ${pattern}`);
  return value.replace(/\s+/gu, ' ').trim();
}

const shellTitle = shellValue(/<title>([\s\S]*?)<\/title>/u);
const shellOgTitle = shellValue(/<meta property="og:title" content="([\s\S]*?)" \/>/u);
const shellDescription = shellValue(/<meta\s+name="description"\s+content="([\s\S]*?)"\s+\/>/u);
const shellOgDescription = shellValue(/<meta property="og:description" content="([\s\S]*?)" \/>/u);

describe('documentTitle', () => {
  it('names the book exactly as the first sheet does, and its author', () => {
    expect(documentTitle('Бланк')).toBe(`Бланк — ${IMPRINT_AUTHOR}`);
  });

  it('ships the same string in the static shell as the one fallback constant', () => {
    // `web/index.html` cannot import: the shell's copy and this constant are compared in
    // `server/test/staticShell.test.ts`; here the fallback is what `documentTitle` would write.
    expect(SHELL_TITLE).toBe(documentTitle('Бланк'));
  });

  it('falls back to the cover word while the sheet has no title line', () => {
    expect(documentTitle(null)).toBe(`Книга — ${IMPRINT_AUTHOR}`);
    expect(documentTitle('   ')).toBe(`Книга — ${IMPRINT_AUTHOR}`);
    expect(FALLBACK_TITLE).toBe('Книга');
  });
});

describe('applyDocumentTitle', () => {
  const painted = { title: `Бланк — ${IMPRINT_AUTHOR}` };

  it('leaves the title alone until the state has arrived', () => {
    const target = { ...painted };
    applyDocumentTitle(undefined, target);
    expect(target.title).toBe(painted.title);
  });

  it('writes the fallback only when the sheet really has no title line', () => {
    const target = { ...painted };
    applyDocumentTitle(null, target);
    expect(target.title).toBe(`Книга — ${IMPRINT_AUTHOR}`);
  });

  it('follows a load: shell → untouched → fallback → live title', () => {
    const target = { ...painted };
    applyDocumentTitle(undefined, target);
    expect(target.title).toBe(`Бланк — ${IMPRINT_AUTHOR}`);
    applyDocumentTitle(null, target);
    expect(target.title).toBe(`Книга — ${IMPRINT_AUTHOR}`);
    applyDocumentTitle('Бланк', target);
    expect(target.title).toBe(`Бланк — ${IMPRINT_AUTHOR}`);
  });
});

describe('the static shell (index.html)', () => {
  // The shell is what a reader without JavaScript and every social card sees; it names the
  // printed book, and the tab format is the one `documentTitle` writes. Whether the words
  // are the manuscript's is checked against `manuscript/00-front.md` in `server/test`.
  it('names the printed book in the tab and the social title', () => {
    expect(shellTitle).toBe(documentTitle('Бланк'));
    expect(shellOgTitle).toBe(shellTitle);
  });

  it('never ships the retired placeholder', () => {
    // Matched as a pattern on purpose: this file carries no copy of the retired string.
    expect(shell).not.toMatch(/Без\s+названия/u);
  });

  it('tells the same story in both description tags', () => {
    expect(shellOgDescription).toBe(shellDescription);
  });
});

describe('the static shell <noscript>', () => {
  it('gives the title and the author, then the JavaScript notice', () => {
    const body = shell.slice(shell.indexOf('<noscript>'), shell.indexOf('</noscript>'));
    expect(body).toContain(`<h1 class="title">Бланк</h1>`);
    expect(body).toContain(`<p class="author">${IMPRINT_AUTHOR}</p>`);
    expect(body).toContain('для чтения нужен браузер с JavaScript');
  });
});
