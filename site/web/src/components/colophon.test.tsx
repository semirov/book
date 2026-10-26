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
    expect(html).toContain('издание');
  });

  it('keeps the counts and the two static pages at the foot of the book', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html).toContain('книга · 0 / 67');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/rules"');
  });
});
