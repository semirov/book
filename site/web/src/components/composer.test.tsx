import type { CatalogEntry, ComposerInfo, ViewerDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Composer } from './Composer.tsx';

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

describe('the composer (BOOK-DOC-5 §4 — no invented chapter names)', () => {
  const html = renderToStaticMarkup(
    <Composer
      viewer={viewer}
      composer={composer}
      chapters={[chapter(1, null), chapter(2, 'Ночная смена')]}
      onPosted={() => undefined}
    />,
  );

  it('names a chapter by its held title, and by its number alone when there is none', () => {
    expect(html).toContain('<option value="1">1.</option>');
    expect(html).toContain('>2. Ночная смена</option>');
  });

  it('never invents «Глава N»', () => {
    expect(html).not.toContain('Глава');
  });

  it('takes both caps from the frame: maxlength, the counter, and the edit hint', () => {
    expect(html).toMatch(/maxlength="1200"/iu);
    expect(html).toContain('0 / 1200');
    // The visible hint states the intervention bound before the field is even shown.
    expect(html).toContain('до 10000 знаков');
  });
});
