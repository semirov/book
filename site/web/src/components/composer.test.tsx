import type { CatalogEntry, ComposerInfo, ViewerDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Composer } from './Composer.tsx';
import { Discussion } from './Discussion.tsx';

const composer: ComposerInfo = {
  captcha: { provider: 'turnstile', siteKey: '0x4AAAA-test-key' },
  minChars: 3,
  maxChars: 1_200,
  editMaxChars: 10_000,
};

const viewer: ViewerDto = { signedIn: true, displayName: 'читатель' };

function chapter(n: number, title: string | null): CatalogEntry {
  return {
    n,
    part: 1,
    title,
    rev: 1,
    chars: 900,
    blocks: 2,
    written: true,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: 'forward',
  };
}

/** A slot with no prose; `basis` marks the frozen ch01/ch67 frame (BOOK-6). */
function empty(n: number, basis = false): CatalogEntry {
  return {
    n,
    part: 1,
    title: null,
    rev: 0,
    chars: 0,
    blocks: basis ? 1 : 0,
    written: false,
    basis,
    writtenAt: null,
    updatedAt: null,
    direction: 'forward',
  };
}

/** The real empty book: 67 slots, ch01/ch67 hold only their frozen sentences. */
function allSlots(): CatalogEntry[] {
  return Array.from({ length: 67 }, (_, index) => {
    const n = index + 1;
    return empty(n, n === 1 || n === 67);
  });
}

describe('the composer (BOOK-DOC-5 §4 — no invented chapter names)', () => {
  const html = renderToStaticMarkup(
    <Composer
      viewer={viewer}
      composer={composer}
      chapters={[chapter(2, null), chapter(3, 'Ночная смена')]}
      onPosted={() => undefined}
    />,
  );

  it('names a chapter by its held title, and by its number alone when there is none', () => {
    expect(html).toContain('<option value="2">2.</option>');
    expect(html).toContain('>3. Ночная смена</option>');
  });

  it('never invents «Глава N»', () => {
    expect(html).not.toContain('Глава');
  });

  it('offers the four kinds only with an intervention, and pre-selects nothing (BOOK-16)', () => {
    // The fieldset belongs to the intervention block; before the reader opts in, no kind is
    // on screen and no radio exists — so nothing can be sent silently.
    expect(html).not.toContain('name="intervention-kind"');
    expect(html).not.toContain('checked=""');
  });

  it('takes both caps from the frame: maxlength, the counter, and the edit hint', () => {
    expect(html).toMatch(/maxlength="1200"/iu);
    expect(html).toContain('0 / 1200');
    // The visible hint states the intervention bound before the field is even shown.
    // BOOK-16: the bound in prose is grouped with the site's non-breaking space; the live
    // counter («0 / 10000») stays a meter, not prose.
    expect(html).toContain('до 10\u00a0000 знаков');
  });
});

describe('BOOK-7 — an empty chapter takes a premise, and the composer offers it', () => {
  it('offers ch02 on an empty book, and never a basis slot', () => {
    const emptyBook = renderToStaticMarkup(
      <Composer viewer={viewer} composer={composer} chapters={allSlots()} onPosted={() => undefined} />,
    );
    expect(emptyBook).toContain('>2. — замысел</option>');
    expect(emptyBook).toContain('>66. — замысел</option>');
    expect(emptyBook).not.toContain('<option value="1"');
    expect(emptyBook).not.toContain('<option value="67"');
  });

  it('explains that the empty chapter is a premise, not a note on text', () => {
    const emptyBook = renderToStaticMarkup(
      <Composer viewer={viewer} composer={composer} chapters={allSlots()} onPosted={() => undefined} />,
    );
    expect(emptyBook).toContain('главы ещё нет — это замысел главы, а не замечание к тексту');
    expect(emptyBook).toContain('замысел главы 2');
    expect(emptyBook).toContain('оставить замысел');
  });

  it('keeps the composer open while nothing is written', () => {
    const html = renderToStaticMarkup(
      <Discussion depth={0} chapterCount={0} chapters={allSlots()} viewer={viewer} composer={composer} />,
    );
    expect(html).toContain('Глав ещё нет: замечание к пустой главе станет её замыслом.');
    expect(html).toContain('замысел главы 2');
    expect(html).not.toContain('Замечания откроются вместе с первой главой');
  });
});
