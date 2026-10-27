import { IMPRINT_AUTHOR, IMPRINT_COPYRIGHT, type StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Colophon } from './Colophon.tsx';

const state = {
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0 },
} as unknown as StateSnapshot;

/** The theme is read from the document at first paint; the test renders without a browser. */
function stubDocument(): void {
  vi.stubGlobal('document', {
    documentElement: { getAttribute: () => 'night', setAttribute: () => undefined },
    querySelector: () => null,
  });
}

describe('the colophon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints the imprint copyright, which the cover no longer carries', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html).toContain(IMPRINT_COPYRIGHT);
    // BOOK-59: no «издание · сегодня» — the imprint has no edition date, and today's date is
    // not one. A clock that ticks while the reader reads dates nothing either.
    expect(html).not.toContain('издание');
    expect(html).not.toMatch(/\d{2}:\d{2}:\d{2}/u);
  });

  it('keeps the counts and the two static pages at the foot of the book', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    // A number carries its noun: «12 глав из 67», never «12 / 67».
    const written = {
      ...state,
      chapters: { ...state.chapters, count: 12 },
    } as unknown as StateSnapshot;
    expect(renderToStaticMarkup(<Colophon state={written} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />)).toContain(
      'книга · 12 глав из 67',
    );
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/rules"');
  });

  it('states the empty book as a sentence, never as a count of nothing (BOOK-70)', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html).toContain('книга · глав ещё нет');
    expect(html).not.toContain('0 глав');
    expect(html).not.toContain('из 67');
    // The owner's copy is untouched.
    expect(html).toContain('печатается по ходу письма');
  });
});
