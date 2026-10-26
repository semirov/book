import { IMPRINT_AUTHOR } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { documentTitle, UNTITLED } from './pageTitle.ts';

describe('documentTitle', () => {
  it('names the book exactly as the first sheet does, and its author', () => {
    expect(documentTitle('Без названия')).toBe(
      `Без названия — ${IMPRINT_AUTHOR}`,
    );
  });

  it('falls back to the untitled name — the string index.html already carries', () => {
    expect(documentTitle(null)).toBe(`Без названия — ${IMPRINT_AUTHOR}`);
    expect(documentTitle('   ')).toBe(`Без названия — ${IMPRINT_AUTHOR}`);
    expect(UNTITLED).toBe('Без названия');
  });
});
